import { ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { WSOL_MINT } from './constants.mjs';
import { collectCoinCreatorFeeIx, collectCreatorFeeIx, createAtaIdempotentIx } from './ix.mjs';
import { distributeCreatorFeesIx } from './sharing.mjs';
import { canSign, signerFor } from './keys.mjs';

/** Hard cap on a Solana transaction, including signatures. */
const MAX_TX_BYTES = 1232;

/**
 * Break a wallet into independently schedulable pieces of work.
 *
 * The unit of packing is deliberately the instruction group, not the wallet.
 * A wallet that is a shareholder in a dozen sharing configs has a dozen
 * distribution cranks, which cannot all fit in one transaction — treating the
 * wallet as atomic makes it permanently unclaimable. Splitting it lets the
 * work flow across as many transactions as it needs.
 *
 * `blocked` items are dropped: preflight marks anything the chain rejects, and
 * carrying it into a batch would take the batch's other work down with it.
 */
export function workItems(row, payer, quoteMint = WSOL_MINT) {
  const items = [];

  const direct = [];
  if (row.pumpLamports > 0) direct.push(collectCreatorFeeIx(row.publicKey));
  if (row.pumpswapLamports > 0) {
    direct.push(createAtaIdempotentIx(payer, row.publicKey, quoteMint));
    direct.push(collectCoinCreatorFeeIx(row.publicKey, quoteMint));
  }
  if (direct.length > 0 && !row.directBlocked && !row.directUnverified) {
    items.push({
      row,
      kind: 'claim',
      label: row.label,
      instructions: direct,
      lamports: (row.pumpLamports ?? 0) + (row.pumpswapLamports ?? 0),
      // A direct claim is the only thing here that needs the wallet's key.
      // The wallet is carried, not the derived Keypair: deriving is ~280x the
      // cost of reading a public key, so it waits until this item is actually
      // going into a signed transaction.
      signerWallet: canSign(row) ? row : null,
      needsSigner: true,
      signerKey: row.publicKey,
    });
  }

  for (const d of row.distributions ?? []) {
    // Unverified means the check never landed, so batching it would gamble
    // the whole transaction on work nothing has confirmed.
    if (d.distributable <= 0 || d.blocked || d.unverified) continue;
    items.push({
      row,
      kind: 'distribute',
      label: `${row.label}:${d.mint.toBase58().slice(0, 6)}`,
      instructions: [distributeCreatorFeesIx(d.config)],
      lamports: d.distributable,
      mint: d.mint,
      // distribute_creator_fees is permissionless — no signature at all.
      signerWallet: null,
      needsSigner: false,
      signerKey: null,
    });
  }

  return items;
}

/** Every instruction a row would contribute, flattened. */
export const instructionsForWallet = (row, payer, quoteMint = WSOL_MINT) =>
  workItems(row, payer, quoteMint).flatMap((i) => i.instructions);

/** What this row actually moves on-chain: direct claims plus any crank. */
export const movedLamports = (row) =>
  (row.directBlocked || row.directUnverified
    ? 0
    : (row.pumpLamports ?? 0) + (row.pumpswapLamports ?? 0)) +
  (row.distributions ?? []).reduce(
    (n, d) => n + (d.blocked || d.unverified ? 0 : (d.distributable ?? 0)),
    0,
  );

/** A row is worth acting on if it can be claimed or distributed. */
export const isActionable = (row) =>
  (row.pumpLamports ?? 0) > 0 ||
  (row.pumpswapLamports ?? 0) > 0 ||
  (row.distributions ?? []).some((d) => d.distributable > 0);

function compile(payer, blockhash, instructions) {
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(),
  );
}

/**
 * Greedily pack work items into as few transactions as will physically hold
 * them.
 *
 * This is where the "en masse" actually happens. Packing is measured, not
 * guessed: each candidate batch is compiled and its real serialised length
 * checked against the 1232-byte cap, because every extra signer costs 64 bytes
 * of signature plus 32 of pubkey, and a distribution carries one account per
 * shareholder.
 */
export function packBatches(items, payer, { blockhash, computeUnitPrice = 0, maxPerTx = 8 } = {}) {
  const budgetIxs =
    computeUnitPrice > 0
      ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPrice })]
      : [];

  const batches = [];
  let current = { items: [], instructions: [...budgetIxs] };

  const flush = () => {
    if (current.items.length > 0) batches.push(finalise(current));
    current = { items: [], instructions: [...budgetIxs] };
  };

  for (const item of items) {
    const candidate = [...current.instructions, ...item.instructions];
    const candidateItems = [...current.items, item];

    let fits;
    try {
      fits =
        compile(payer, blockhash, candidate).serialize().length <= MAX_TX_BYTES &&
        candidateItems.length <= maxPerTx;
    } catch {
      fits = false; // compile threw (too many accounts) => treat as not fitting
    }

    if (fits) {
      current = { items: candidateItems, instructions: candidate };
      continue;
    }

    if (current.items.length === 0) {
      // One item too big for an empty transaction can never be sent.
      batches.push({
        ...finalise({ items: [item], instructions: [...budgetIxs, ...item.instructions] }),
        oversized: true,
      });
      continue;
    }

    flush();
    current = { items: [item], instructions: [...budgetIxs, ...item.instructions] };
  }

  flush();
  return batches;
}

function finalise(batch) {
  const rows = [];
  const seen = new Set();
  for (const item of batch.items) {
    const key = item.row.publicKey.toBase58();
    if (!seen.has(key)) {
      seen.add(key);
      rows.push(item.row);
    }
  }
  return { ...batch, rows, lamports: batch.items.reduce((n, i) => n + i.lamports, 0) };
}

/** Errors that mean the transaction never made it onto the chain. */
function isExpiry(err) {
  const m = String(err?.message ?? err);
  return (
    /blockhash not found/i.test(m) ||
    /block height exceeded/i.test(m) ||
    err?.name === 'TransactionExpiredBlockheightExceededError'
  );
}

/**
 * Ask the chain what actually happened to a signature.
 *
 * Returns `landed` when the transaction is on the chain, `failed` when it is
 * on the chain and reverted, and `absent` when it is not there at all.
 */
async function outcomeOf(connection, signature) {
  if (typeof connection.getSignatureStatus !== 'function') return { state: 'absent' };
  try {
    const { value } = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    if (!value) return { state: 'absent' };
    if (value.err) return { state: 'failed', err: value.err };
    return { state: 'landed' };
  } catch {
    // The lookup itself failing tells us nothing about the transaction, and
    // guessing here is how a landed claim gets reported as lost.
    return { state: 'unknown' };
  }
}

/**
 * Send one batch, and keep sending it until it lands or is genuinely dead.
 *
 * Two things make this more than a retry loop.
 *
 * Every attempt takes a *fresh* blockhash. Signing a whole run against a
 * single blockhash caps the run at that blockhash's lifetime — about 150
 * slots, a minute or so — after which every remaining transaction is rejected
 * no matter how many wallets are left to claim. Refetching per attempt is what
 * lets a claim run be as long as the wallet list.
 *
 * And a confirmation that times out is never reported as a failure until the
 * chain has been asked. Expiry while waiting means we stopped watching, not
 * that the money stayed put; a transaction can confirm after the client has
 * given up. Retrying without checking is how a claim gets sent twice, and
 * reporting without checking is how a successful claim is recorded as lost.
 */
async function sendBatch(connection, batch, payerWallet, { attempts = 3, onAttempt } = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = compile(payerWallet.publicKey, blockhash, batch.instructions);

    // Deduplicate signers: the payer may also be one of the harvested wallets.
    // Derive signing keys only for the wallets in this one transaction.
    const signers = new Map();
    if (canSign(payerWallet)) signers.set(payerWallet.publicKey.toBase58(), signerFor(payerWallet));
    for (const item of batch.items) {
      if (item.signerWallet) signers.set(item.signerKey.toBase58(), signerFor(item.signerWallet));
    }
    if (signers.size > 0) tx.sign([...signers.values()]);

    let signature;
    try {
      signature = await connection.sendTransaction(tx, { maxRetries: 5 });
    } catch (err) {
      lastErr = err;
      // Nothing was accepted, so there is no signature to double-spend with.
      if (isExpiry(err) && attempt < attempts) {
        onAttempt?.({ attempt, reason: 'blockhash expired before the send was accepted' });
        continue;
      }
      throw err;
    }

    try {
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      return { signature, attempts: attempt };
    } catch (err) {
      const outcome = await outcomeOf(connection, signature);
      if (outcome.state === 'landed') return { signature, attempts: attempt };
      if (outcome.state === 'failed') {
        throw Object.assign(new Error(`transaction reverted: ${JSON.stringify(outcome.err)}`), {
          signature,
        });
      }
      if (outcome.state === 'unknown') {
        // Neither confirmed nor disproved. Resending could claim twice, so
        // stop and hand back the signature to be checked by hand.
        throw Object.assign(
          new Error(`could not determine the outcome; check signature ${signature}`),
          { signature, indeterminate: true },
        );
      }
      // Absent, with the blockhash expired: this one can never land, so
      // sending again cannot duplicate it.
      lastErr = Object.assign(err, { signature });
      if (attempt < attempts) {
        onAttempt?.({ attempt, signature, reason: 'not confirmed in time, and never landed' });
        continue;
      }
      throw lastErr;
    }
  }

  throw lastErr;
}

/**
 * Build, sign and send (or simulate) the batches.
 *
 * Failures are isolated per batch: one bad transaction reports and the rest
 * still go out, because a partial harvest beats an aborted one.
 */
export async function claimAll(connection, rows, payerWallet, options = {}) {
  const {
    dryRun = true,
    computeUnitPrice = 0,
    maxPerTx = 8,
    quoteMint = WSOL_MINT,
    sendAttempts = 3,
    onEvent = () => {},
  } = options;

  // A dry run is simulated with sigVerify disabled, so it needs no keys at
  // all: the point of the preview is to find out whether the instructions
  // succeed against real chain state. Demanding a signing key to look would
  // force anyone to expose a secret before they could see what they own.
  // Sending, of course, still requires every real signature.
  if (!dryRun) {
    if (!canSign(payerWallet)) throw new Error('the fee payer must be a wallet with a signing key');

    // Only direct claims must sign. A sharing-config row is a PDA that can
    // never sign, and does not need to.
    const unsignable = rows
      .filter((r) => (r.status ?? 'ready') === 'ready')
      .flatMap((r) => workItems(r, payerWallet.publicKey, quoteMint))
      .filter((i) => i.needsSigner && !i.signerWallet);
    if (unsignable.length > 0) {
      throw new Error(
        `cannot claim for watch-only wallet(s): ${[...new Set(unsignable.map((i) => i.label))].join(', ')}`,
      );
    }
  }

  const usable = rows.filter((r) => (r.status ?? 'ready') === 'ready');
  const items = usable.flatMap((r) => workItems(r, payerWallet.publicKey, quoteMint));
  // Packing only needs a blockhash to measure against; every blockhash is the
  // same 32 bytes, so the one used for sizing need not be the one signed.
  const { blockhash } = await connection.getLatestBlockhash();
  const batches = packBatches(items, payerWallet.publicKey, {
    blockhash,
    computeUnitPrice,
    maxPerTx,
  });

  onEvent({
    type: 'planned',
    batches: batches.length,
    wallets: usable.length,
    items: items.length,
  });

  const results = [];
  for (const [i, batch] of batches.entries()) {
    const label = `batch ${i + 1}/${batches.length} (${batch.items.length} action${batch.items.length === 1 ? '' : 's'})`;
    const { lamports } = batch;
    const wallets = batch.items.map((i2) => i2.label);
    try {
      if (dryRun) {
        const tx = compile(payerWallet.publicKey, blockhash, batch.instructions);
        const sim = await connection.simulateTransaction(tx, {
          replaceRecentBlockhash: true,
          sigVerify: false,
        });
        const ok = sim.value.err === null;
        const result = {
          label,
          ok,
          lamports,
          wallets,
          err: sim.value.err,
          logs: sim.value.logs,
          simulated: true,
        };
        results.push(result);
        onEvent({ type: 'batch', ...result });
      } else {
        const { signature, attempts } = await sendBatch(connection, batch, payerWallet, {
          attempts: sendAttempts,
          onAttempt: ({ attempt, reason }) => onEvent({ type: 'retry', label, attempt, reason }),
        });
        const result = { label, ok: true, lamports, wallets, signature, attempts };
        results.push(result);
        onEvent({ type: 'batch', ...result });
      }
    } catch (err) {
      // The signature is carried on the error precisely so a batch that may
      // have moved money is never reported without a way to look it up.
      const result = {
        label,
        ok: false,
        lamports,
        wallets,
        err: err.message,
        ...(err.signature ? { signature: err.signature } : {}),
        ...(err.indeterminate ? { indeterminate: true } : {}),
      };
      results.push(result);
      onEvent({ type: 'batch', ...result });
    }
  }
  return results;
}
