import { TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { WSOL_MINT } from './constants.mjs';
import { PROGRAM_ERRORS } from './errors.mjs';
import { isActionable, workItems } from './claim.mjs';
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
 * Simulate each unit of work on its own before batching.
 *
 * This exists because a meaningful share of real creators have migrated their
 * fees to a sharing config, and for those the plain claim reverts (6050).
 * Without this pass a single bad item takes down every other item sharing its
 * transaction — so we find out per item, cheaply, first.
 *
 * Per *item* rather than per wallet: a wallet holding a dozen distributions
 * cannot simulate them in one transaction, and judging the wallet as a whole
 * would wrongly condemn work that is perfectly valid on its own.
 *
 * "The chain rejected this" and "we could not ask the chain" are tracked
 * separately. Collapsing them means one rate-limited request marks claimable
 * money as permanently blocked, which is the same silent-loss failure this
 * pass exists to prevent.
 */
export async function preflight(connection, rows, payer, options = {}) {
  const { concurrency = 6, quoteMint = WSOL_MINT, onProgress, limiter } = options;
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
    for (const item of workItems(row, payer, quoteMint)) jobs.push({ row, item });
  }

  let done = 0;
  await Promise.all(jobs.map(({ row, item }) => gate(async () => {
    const { rejected, unverified } = await checkItem(connection, item, payer, blockhash);
    if (item.kind === 'claim') {
      row.directBlocked = rejected;
      row.directUnverified = unverified;
    } else {
      const d = row.distributions.find((x) => x.mint.equals(item.mint));
      if (d) { d.blocked = rejected; d.unverified = unverified; }
    }
    onProgress?.(++done, jobs.length);
  })));

  return out.map((row) => summarise(row));
}

async function checkItem(connection, item, payer, blockhash) {
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: item.instructions })
      .compileToV0Message(),
  );
  try {
    const sim = await withRetry(
      () => connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true }),
      { attempts: 4, baseDelayMs: 400 },
    );
    return { rejected: sim.value.err ? explainError(sim.value.err) : null, unverified: null };
  } catch (err) {
    // The request never landed. That says nothing about whether the claim
    // would work, so it must not be recorded as a rejection.
    return { rejected: null, unverified: `could not verify — ${err.message}` };
  }
}

/** Roll per-item verdicts back up into one status for the row. */
function summarise(row) {
  if (!isActionable(row)) {
    return { ...row, status: 'empty', reason: 'nothing to claim', verifiedLamports: 0, sharingLamports: row.sharingLamports ?? 0 };
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
  const unverified = [row.directUnverified, ...unsureDists.map((d) => d.unverified)].filter(Boolean);
  const reasons = [...new Set([...rejections, ...unverified])];

  // Recompute the user's share from the distributions that survived.
  const sharingLamports = okDists.reduce((n, d) => n + (d.userShare ?? 0), 0);

  // Nothing verified and nothing rejected means the checks themselves failed.
  const status = anyOk ? 'ready' : (rejections.length > 0 ? 'blocked' : 'unchecked');

  return {
    ...row,
    status,
    reason: reasons.length > 0 ? reasons.join(' · ') : null,
    partial: anyOk && reasons.length > 0,
    unverified: unverified.length > 0,
    verifiedLamports: verified,
    sharingLamports,
    totalLamports: (directOk ? (row.pumpLamports ?? 0) + (row.pumpswapLamports ?? 0) : 0) + sharingLamports,
  };
}
