import { TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { WSOL_MINT } from './constants.mjs';
import { PROGRAM_ERRORS } from './errors.mjs';
import { isActionable, packBatches, workItems } from './claim.mjs';
import { createLimiter, withRetry } from './limit.mjs';

/** Turn a raw simulation error into something a human can act on. */
export function explainError(err) {
  if (!err) return null;
  const custom = err?.InstructionError?.[1]?.Custom;
  if (typeof custom === 'number') {
    const known = PROGRAM_ERRORS[custom];
    if (known) return `${known.name}${known.msg ? ` — ${known.msg}` : ''}`;
    return `program error ${custom}`;
  }
  // Transaction-level failures arrive as bare strings and are usually about
  // the fee payer rather than the claim itself, so say so.
  if (err === 'InvalidAccountForFee' || err?.InvalidAccountForFee !== undefined) {
    return 'InvalidAccountForFee — the fee payer holds no SOL (fees sit in the vault, not the wallet); pass --payer';
  }
  if (typeof err === 'string') return err;
  return JSON.stringify(err);
}

/**
 * Find the work the chain will reject, before it takes anything else down.
 *
 * This exists because a meaningful share of real creators have migrated their
 * fees to a sharing config, and for those the plain claim reverts (6050).
 * A single bad item fails every other item sharing its transaction, so the bad
 * ones have to be found first.
 *
 * The obvious way is to simulate every item on its own, and that is what this
 * did: one request per item, whether or not anything was wrong. It is the
 * wrong shape, because almost everything is fine and each of those requests
 * buys a "yes".
 *
 * So it asks the question in bulk. Items are packed into exactly the
 * transactions that would be sent, and each is simulated once. A batch that
 * simulates clean clears every item in it at once. A batch that fails says
 * which instruction failed — Solana returns `InstructionError: [index, err]`
 * — so the offender is identified directly, dropped, and the rest re-checked.
 * Nothing after a failing instruction runs, which is exactly why the rest must
 * be asked again rather than assumed guilty.
 *
 * The cost stops tracking how much work there is and starts tracking how much
 * of it is broken: one request per transaction, plus about two per bad item.
 *
 * A transaction-level failure — `InvalidAccountForFee` and friends — names no
 * instruction, because it is about the transaction rather than anything in it.
 * There is nothing to attribute, so that batch falls back to halving until
 * each item has been asked about on its own.
 *
 * "The chain rejected this" and "we could not ask the chain" are tracked
 * separately throughout. Collapsing them means one rate-limited request marks
 * claimable money as permanently blocked, which is the same silent-loss
 * failure this pass exists to prevent.
 */
export async function preflight(connection, rows, payer, options = {}) {
  const {
    concurrency = 6,
    quoteMint = WSOL_MINT,
    onProgress,
    limiter,
    maxPerTx = 8,
    onRequest,
  } = options;
  const { blockhash } = await connection.getLatestBlockhash();
  const gate = limiter ?? createLimiter({ concurrency });

  // Clone so marking something blocked never mutates the caller's rows.
  const out = rows.map((r) => ({
    ...r,
    distributions: (r.distributions ?? []).map((d) => ({ ...d })),
    directBlocked: null,
    directUnverified: null,
  }));

  const jobs = [];
  for (const row of out) {
    for (const item of workItems(row, payer, quoteMint)) jobs.push(item);
  }

  const record = (item, rejected, unverified) => {
    const row = item.row;
    if (item.kind === 'claim') {
      row.directBlocked = rejected;
      row.directUnverified = unverified;
    } else {
      const d = row.distributions.find((x) => x.mint.equals(item.mint));
      if (d) {
        d.blocked = rejected;
        d.unverified = unverified;
      }
    }
  };

  let settled = 0;
  const settle = (items, rejected, unverified) => {
    for (const item of items) record(item, rejected, unverified);
    settled += items.length;
    onProgress?.(settled, jobs.length);
  };

  const batches = packBatches(jobs, payer, { blockhash, maxPerTx });
  await Promise.all(
    batches.map((batch) =>
      // An oversized batch could never be sent, so there is nothing to ask the
      // chain about it.
      batch.oversized
        ? settle(batch.items, 'transaction is too large to send even on its own', null)
        : resolveBatch(connection, batch.items, payer, blockhash, gate, settle, onRequest),
    ),
  );

  return out.map((row) => summarise(row));
}

/**
 * Simulate one batch, and keep asking until every item in it has a verdict.
 */
async function resolveBatch(connection, items, payer, blockhash, gate, settle, onRequest) {
  if (items.length === 0) return;

  const { err, failed, unverified } = await gate(() =>
    simulate(connection, items, payer, blockhash, onRequest),
  );

  if (items.length === 1) {
    return settle(items, unverified ? null : explainError(err), unverified ?? null);
  }
  if (!unverified && !err) return settle(items, null, null);

  // A request that never landed says nothing about any particular item, and
  // batching must not make one item's bad luck condemn the others. Split, so
  // an unverifiable item is isolated to itself. Costs nothing when the
  // endpoint is healthy, and no more than asking item by item when it is not.
  if (unverified) return halve(connection, items, payer, blockhash, gate, settle, onRequest);

  if (failed !== null && failed < items.length) {
    // The chain named the instruction. Condemn only its owner, then ask about
    // the rest — they never ran, so nothing is known about them yet.
    settle([items[failed]], explainError(err), null);
    return resolveBatch(
      connection,
      items.filter((_, i) => i !== failed),
      payer,
      blockhash,
      gate,
      settle,
      onRequest,
    );
  }

  // Nothing to attribute it to. Halve and ask again.
  return halve(connection, items, payer, blockhash, gate, settle, onRequest);
}

async function halve(connection, items, payer, blockhash, gate, settle, onRequest) {
  const mid = Math.ceil(items.length / 2);
  await Promise.all([
    resolveBatch(connection, items.slice(0, mid), payer, blockhash, gate, settle, onRequest),
    resolveBatch(connection, items.slice(mid), payer, blockhash, gate, settle, onRequest),
  ]);
}

/**
 * Simulate the given items as one transaction.
 *
 * Returns the raw error plus which *item* it belongs to. Solana counts the
 * instruction, and an item can be several instructions — a PumpSwap claim
 * carries its own ATA creation — so the index has to be mapped back through
 * the item boundaries rather than used directly.
 */
async function simulate(connection, items, payer, blockhash, onRequest) {
  const instructions = items.flatMap((i) => i.instructions);
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(),
  );

  try {
    const sim = await withRetry(
      () => {
        onRequest?.();
        return connection.simulateTransaction(tx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
        });
      },
      { attempts: 4, baseDelayMs: 400 },
    );
    const err = sim.value.err ?? null;
    return { err, failed: err ? itemOf(items, err) : null, unverified: null };
  } catch (err) {
    // The request never landed. That says nothing about whether the claim
    // would work, so it must not be recorded as a rejection.
    return { err: null, failed: null, unverified: `could not verify — ${err.message}` };
  }
}

/** Map an InstructionError's instruction index back to the item that owns it. */
function itemOf(items, err) {
  const index = err?.InstructionError?.[0];
  if (typeof index !== 'number') return null;
  let seen = 0;
  for (let i = 0; i < items.length; i++) {
    seen += items[i].instructions.length;
    if (index < seen) return i;
  }
  return null;
}

/** Roll per-item verdicts back up into one status for the row. */
function summarise(row) {
  if (!isActionable(row)) {
    return {
      ...row,
      status: 'empty',
      reason: 'nothing to claim',
      verifiedLamports: 0,
      sharingLamports: row.sharingLamports ?? 0,
    };
  }

  const directAttempted = (row.pumpLamports ?? 0) > 0 || (row.pumpswapLamports ?? 0) > 0;
  const directOk = directAttempted && !row.directBlocked && !row.directUnverified;
  const dists = row.distributions ?? [];
  const live = dists.filter((d) => d.distributable > 0);
  const okDists = live.filter((d) => !d.blocked && !d.unverified);
  const badDists = live.filter((d) => d.blocked);
  const unsureDists = live.filter((d) => d.unverified);

  const verified =
    (directOk ? (row.pumpLamports ?? 0) + (row.pumpswapLamports ?? 0) : 0) +
    okDists.reduce((n, d) => n + d.distributable, 0);

  const anyOk = directOk || okDists.length > 0;
  const rejections = [row.directBlocked, ...badDists.map((d) => d.blocked)].filter(Boolean);
  const unverified = [row.directUnverified, ...unsureDists.map((d) => d.unverified)].filter(
    Boolean,
  );
  const reasons = [...new Set([...rejections, ...unverified])];

  // Recompute the user's share from the distributions that survived.
  const sharingLamports = okDists.reduce((n, d) => n + (d.userShare ?? 0), 0);

  // Nothing verified and nothing rejected means the checks themselves failed.
  const status = anyOk ? 'ready' : rejections.length > 0 ? 'blocked' : 'unchecked';

  return {
    ...row,
    status,
    reason: reasons.length > 0 ? reasons.join(' · ') : null,
    partial: anyOk && reasons.length > 0,
    unverified: unverified.length > 0,
    verifiedLamports: verified,
    sharingLamports,
    totalLamports:
      (directOk ? (row.pumpLamports ?? 0) + (row.pumpswapLamports ?? 0) : 0) + sharingLamports,
  };
}
