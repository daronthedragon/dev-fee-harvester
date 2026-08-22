import {
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
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
  if (direct.length > 0 && !row.directBlocked) {
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
    if (d.distributable <= 0 || d.blocked) continue;
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
  (row.directBlocked ? 0 : (row.pumpLamports ?? 0) + (row.pumpswapLamports ?? 0)) +
  (row.distributions ?? []).reduce((n, d) => n + (d.blocked ? 0 : (d.distributable ?? 0)), 0);

/** A row is worth acting on if it can be claimed or distributed. */
export const isActionable = (row) =>
  (row.pumpLamports ?? 0) > 0 ||
  (row.pumpswapLamports ?? 0) > 0 ||
  (row.distributions ?? []).some((d) => d.distributable > 0);

/** Only direct claims need this wallet's signature; distributions do not. */
export const needsSignature = (row) => (row.pumpLamports ?? 0) > 0 || (row.pumpswapLamports ?? 0) > 0;

function compile(payer, blockhash, instructions) {
  return new VersionedTransaction(
    new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions })
      .compileToV0Message(),
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
  const budgetIxs = computeUnitPrice > 0
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
      fits = compile(payer, blockhash, candidate).serialize().length <= MAX_TX_BYTES
        && candidateItems.length <= maxPerTx;
    } catch {
      fits = false; // compile threw (too many accounts) => treat as not fitting
    }

    if (fits) {
      current = { items: candidateItems, instructions: candidate };
      continue;
    }

    if (current.items.length === 0) {
      // One item too big for an empty transaction can never be sent.
      batches.push({ ...finalise({ items: [item], instructions: [...budgetIxs, ...item.instructions] }), oversized: true });
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
    if (!seen.has(key)) { seen.add(key); rows.push(item.row); }
  }
  return { ...batch, rows, lamports: batch.items.reduce((n, i) => n + i.lamports, 0) };
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
    onEvent = () => {},
  } = options;

  if (!canSign(payerWallet)) throw new Error('the fee payer must be a wallet with a signing key');

  const usable = rows.filter((r) => (r.status ?? 'ready') === 'ready');
  const items = usable.flatMap((r) => workItems(r, payerWallet.publicKey, quoteMint));

  // Only direct claims must sign. A sharing-config row is a PDA that can never
  // sign, and does not need to.
  const unsignable = items.filter((i) => i.needsSigner && !i.signerWallet);
  if (unsignable.length > 0) {
    throw new Error(
      `cannot claim for watch-only wallet(s): ${[...new Set(unsignable.map((i) => i.label))].join(', ')}`,
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const batches = packBatches(items, payerWallet.publicKey, { blockhash, computeUnitPrice, maxPerTx });

  onEvent({ type: 'planned', batches: batches.length, wallets: usable.length, items: items.length });

  const results = [];
  for (const [i, batch] of batches.entries()) {
    const label = `batch ${i + 1}/${batches.length} (${batch.items.length} action${batch.items.length === 1 ? '' : 's'})`;
    const { lamports } = batch;
    try {
      const tx = compile(payerWallet.publicKey, blockhash, batch.instructions);
      // Deduplicate signers: the payer may also be one of the harvested wallets.
      // Derive signing keys only for the wallets in this one transaction.
      const signers = new Map([[payerWallet.publicKey.toBase58(), signerFor(payerWallet)]]);
      for (const item of batch.items) {
        if (item.signerWallet) signers.set(item.signerKey.toBase58(), signerFor(item.signerWallet));
      }
      tx.sign([...signers.values()]);

      if (dryRun) {
        const sim = await connection.simulateTransaction(tx, { replaceRecentBlockhash: true, sigVerify: false });
        const ok = sim.value.err === null;
        results.push({ label, ok, lamports, wallets: batch.items.map((i2) => i2.label), err: sim.value.err, logs: sim.value.logs, simulated: true });
        onEvent({ type: 'batch', label, ok, lamports, simulated: true, err: sim.value.err });
      } else {
        const signature = await connection.sendTransaction(tx, { maxRetries: 5 });
        await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        results.push({ label, ok: true, lamports, wallets: batch.items.map((i2) => i2.label), signature });
        onEvent({ type: 'batch', label, ok: true, lamports, signature });
      }
    } catch (err) {
      results.push({ label, ok: false, lamports, wallets: batch.items.map((i2) => i2.label), err: err.message });
      onEvent({ type: 'batch', label, ok: false, lamports, err: err.message });
    }
  }
  return results;
}
