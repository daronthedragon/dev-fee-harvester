import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { packBatches, workItems } from '../src/claim.mjs';
import { signerFor } from '../src/keys.mjs';

/**
 * The whole point of this tool is that many wallets co-sign one transaction.
 * If any signature slot were left unfilled or signed by the wrong key the
 * cluster would reject the batch, so verify the signatures for real rather
 * than trusting that sign() did the right thing.
 */
const BLOCKHASH = '11111111111111111111111111111111';

// Wrap a raw 32-byte Ed25519 public key in the SPKI DER header so node:crypto
// will take it. Cheaper than pulling in a signature library for two asserts.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const verifySig = (message, signature, publicKey) =>
  cryptoVerify(
    null,
    message,
    createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey.toBytes())]),
      format: 'der',
      type: 'spki',
    }),
    signature,
  );

const rowFor = (kp) => ({
  publicKey: kp.publicKey,
  label: kp.publicKey.toBase58().slice(0, 4),
  secretKey: kp.secretKey,
  pumpLamports: 1e8,
  pumpswapLamports: 0,
  totalLamports: 1e8,
  status: 'ready',
});

test('every wallet in a batch produces a cryptographically valid signature', () => {
  const wallets = Array.from({ length: 6 }, () => Keypair.generate());
  const rows = wallets.map(rowFor);
  const payer = wallets[0];

  const batches = packBatches(
    rows.flatMap((r) => workItems(r, payer.publicKey)),
    payer.publicKey,
    { blockhash: BLOCKHASH, maxPerTx: 8 },
  );
  assert.equal(batches.length, 1, 'six wallets should fit in a single transaction');

  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: batches[0].instructions,
    }).compileToV0Message(),
  );

  const signers = new Map(rows.map((r) => [r.publicKey.toBase58(), signerFor(r)]));
  signers.set(payer.publicKey.toBase58(), payer);
  tx.sign([...signers.values()]);

  const required = tx.message.header.numRequiredSignatures;
  assert.equal(required, 6, 'payer doubles as a claimant, so six distinct signers');
  assert.equal(tx.signatures.length, required);

  const messageBytes = tx.message.serialize();
  tx.signatures.forEach((sig, i) => {
    const signer = tx.message.staticAccountKeys[i];
    assert.notEqual(Buffer.from(sig).toString('hex'), '0'.repeat(128), `slot ${i} left unsigned`);
    assert.ok(
      verifySig(messageBytes, sig, signer),
      `signature ${i} does not verify against ${signer.toBase58()}`,
    );
  });
});

test('the fee payer is not double-counted when it is also a claimant', () => {
  const wallets = Array.from({ length: 3 }, () => Keypair.generate());
  const rows = wallets.map(rowFor);
  const batches = packBatches(
    rows.flatMap((r) => workItems(r, wallets[0].publicKey)),
    wallets[0].publicKey,
    { blockhash: BLOCKHASH, maxPerTx: 8 },
  );
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: wallets[0].publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: batches[0].instructions,
    }).compileToV0Message(),
  );
  assert.equal(
    tx.message.header.numRequiredSignatures,
    3,
    'three wallets, three signatures, not four',
  );
});
