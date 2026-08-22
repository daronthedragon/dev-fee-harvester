import { TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { WSOL_MINT } from './constants.mjs';
import { PROGRAM_ERRORS } from './errors.mjs';
import { isActionable, workItems } from './claim.mjs';

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
 */
export async function preflight(connection, rows, payer, options = {}) {
  const { concurrency = 6, quoteMint = WSOL_MINT, onProgress } = options;
  const { blockhash } = await connection.getLatestBlockhash();

  // Clone so marking something blocked never mutates the caller's rows.
  const out = rows.map((r) => ({
    ...r,
    distributions: (r.distributions ?? []).map((d) => ({ ...d })),
    directBlocked: null,
  }));

  const jobs = [];
  for (const row of out) {
    for (const item of workItems(row, payer, quoteMint)) jobs.push({ row, item });
  }

  let done = 0;
  const queue = [...jobs];
  const worker = async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const reason = await checkItem(connection, job.item, payer, blockhash);
      if (reason) {
        if (job.item.kind === 'claim') job.row.directBlocked = reason;
        else {
          const d = job.row.distributions.find((x) => x.mint.equals(job.item.mint));
          if (d) d.blocked = reason;
        }
      }
      onProgress?.(++done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  return out.map((row) => summarise(row));
}

async function checkItem(connection, item, payer, blockhash) {
  try {
    const tx = new VersionedTransaction(
      new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: item.instructions })
        .compileToV0Message(),
    );
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    return sim.value.err ? explainError(sim.value.err) : null;
  } catch (err) {
    return err.message;
  }
}

/** Roll per-item verdicts back up into one status for the row. */
function summarise(row) {
  if (!isActionable(row)) {
    return { ...row, status: 'empty', reason: 'nothing to claim', verifiedLamports: 0, sharingLamports: row.sharingLamports ?? 0 };
  }

  const directAttempted = (row.pumpLamports ?? 0) > 0 || (row.pumpswapLamports ?? 0) > 0;
  const directOk = directAttempted && !row.directBlocked;
  const dists = row.distributions ?? [];
  const okDists = dists.filter((d) => d.distributable > 0 && !d.blocked);
  const badDists = dists.filter((d) => d.distributable > 0 && d.blocked);

  const verified =
    (directOk ? (row.pumpLamports ?? 0) + (row.pumpswapLamports ?? 0) : 0) +
    okDists.reduce((n, d) => n + d.distributable, 0);

  // A row still counts as ready if any part of it works; only report it
  // blocked when nothing at all can proceed.
  const anyOk = directOk || okDists.length > 0;
  const reasons = [row.directBlocked, ...badDists.map((d) => d.blocked)].filter(Boolean);

  // Recompute the user's share from the distributions that survived.
  const sharingLamports = okDists.reduce((n, d) => n + (d.userShare ?? 0), 0);

  return {
    ...row,
    status: anyOk ? 'ready' : 'blocked',
    reason: reasons.length > 0 ? [...new Set(reasons)].join(' · ') : null,
    partial: anyOk && reasons.length > 0,
    verifiedLamports: verified,
    sharingLamports,
    totalLamports: (directOk ? (row.pumpLamports ?? 0) + (row.pumpswapLamports ?? 0) : 0) + sharingLamports,
  };
}
