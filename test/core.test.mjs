import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

import {
  DISCRIMINATORS, PUMPSWAP_PROGRAM, PUMP_PROGRAM,
  SEED_PUMPSWAP_CREATOR_VAULT, SEED_PUMP_CREATOR_VAULT, SYSTEM_ACCOUNT_RENT_LAMPORTS,
} from '../src/constants.mjs';
import { eventAuthority, pumpCreatorVault, pumpswapCreatorVaultAuthority } from '../src/pda.mjs';
import { collectCoinCreatorFeeIx, collectCreatorFeeIx } from '../src/ix.mjs';
import { claimAll, instructionsForWallet, packBatches, workItems } from '../src/claim.mjs';
import { canSign, parseEntry, signerFor } from '../src/keys.mjs';
import { explainError } from '../src/preflight.mjs';

// A creator whose vault we resolved against mainnet while building this.
const KNOWN_CREATOR = new PublicKey('3z4vj1nAujLnciPgZaGz4VYecZa6gbYUg3Yr9MoyuiMG');
const KNOWN_VAULT = 'HVhMskNi1hbwepA3D8e2QzSTRLgaCKrByS7bq17GcV72';

test('pump creator vault PDA matches the address observed on mainnet', () => {
  assert.equal(pumpCreatorVault(KNOWN_CREATOR).toBase58(), KNOWN_VAULT);
});

test('the two programs use differently spelled vault seeds', () => {
  assert.equal(SEED_PUMP_CREATOR_VAULT.toString(), 'creator-vault');
  assert.equal(SEED_PUMPSWAP_CREATOR_VAULT.toString(), 'creator_vault');
  // Same creator, different venue, therefore different vault.
  assert.notEqual(
    pumpCreatorVault(KNOWN_CREATOR).toBase58(),
    pumpswapCreatorVaultAuthority(KNOWN_CREATOR).toBase58(),
  );
});

test('discriminators equal sha256("global:<name>")[0..8]', () => {
  const d = (n) => Uint8Array.from(createHash('sha256').update(`global:${n}`).digest().subarray(0, 8));
  assert.deepEqual(DISCRIMINATORS.collect_creator_fee, d('collect_creator_fee'));
  assert.deepEqual(DISCRIMINATORS.collect_coin_creator_fee, d('collect_coin_creator_fee'));
});

test('event authority uses the __event_authority seed per program', () => {
  const expected = (p) => PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], p)[0].toBase58();
  assert.equal(eventAuthority(PUMP_PROGRAM).toBase58(), expected(PUMP_PROGRAM));
  assert.equal(eventAuthority(PUMPSWAP_PROGRAM).toBase58(), expected(PUMPSWAP_PROGRAM));
});

test('collect_creator_fee has the IDL account order, and the creator signs', () => {
  const ix = collectCreatorFeeIx(KNOWN_CREATOR);
  assert.equal(ix.programId.toBase58(), PUMP_PROGRAM.toBase58());
  assert.equal(ix.keys.length, 5);
  assert.equal(ix.keys[0].pubkey.toBase58(), KNOWN_CREATOR.toBase58());
  assert.ok(ix.keys[0].isSigner && ix.keys[0].isWritable);
  assert.equal(ix.keys[1].pubkey.toBase58(), KNOWN_VAULT);
  assert.ok(ix.keys[1].isWritable, 'the vault is drained, so it must be writable');
});

test('collect_coin_creator_fee puts the signer third, per the IDL', () => {
  const ix = collectCoinCreatorFeeIx(KNOWN_CREATOR);
  assert.equal(ix.keys.length, 8);
  assert.equal(ix.keys[2].pubkey.toBase58(), KNOWN_CREATOR.toBase58());
  assert.ok(ix.keys[2].isSigner);
  assert.ok(ix.keys[4].isWritable && ix.keys[5].isWritable, 'both token accounts move funds');
});

test('a wallet with no fees produces no instructions', () => {
  const row = { publicKey: KNOWN_CREATOR, pumpLamports: 0, pumpswapLamports: 0 };
  assert.equal(instructionsForWallet(row, KNOWN_CREATOR).length, 0);
});

test('a PumpSwap claim prepends an idempotent ATA create', () => {
  const row = { publicKey: KNOWN_CREATOR, pumpLamports: 0, pumpswapLamports: 5000 };
  const ixs = instructionsForWallet(row, KNOWN_CREATOR);
  assert.equal(ixs.length, 2);
  assert.deepEqual([...ixs[0].data], [1], 'ATA instruction 1 == CreateIdempotent');
});

const rowFor = (kp, lamports = 1e8) => ({
  publicKey: kp.publicKey, label: kp.publicKey.toBase58().slice(0, 4), secretKey: kp.secretKey,
  pumpLamports: lamports, pumpswapLamports: 0, totalLamports: lamports, status: 'ready',
});

const BLOCKHASH = '11111111111111111111111111111111';
const itemsFor = (rows, payer) => rows.flatMap((r) => workItems(r, payer));

test('packBatches keeps every transaction under the 1232-byte cap', () => {
  const rows = Array.from({ length: 30 }, () => rowFor(Keypair.generate()));
  const payer = rows[0].publicKey;
  const items = itemsFor(rows, payer);
  const batches = packBatches(items, payer, { blockhash: BLOCKHASH, maxPerTx: 64 });
  assert.ok(batches.length > 1, 'thirty wallets cannot fit in one transaction');
  for (const b of batches) {
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: payer, recentBlockhash: BLOCKHASH, instructions: b.instructions,
    }).compileToV0Message());
    assert.ok(tx.serialize().length <= 1232, `batch of ${b.items.length} exceeded the cap`);
  }
  assert.equal(batches.reduce((n, b) => n + b.items.length, 0), items.length, 'no work dropped');
});

test('packBatches honours maxPerTx', () => {
  const rows = Array.from({ length: 9 }, () => rowFor(Keypair.generate()));
  const payer = rows[0].publicKey;
  const batches = packBatches(itemsFor(rows, payer), payer, { blockhash: BLOCKHASH, maxPerTx: 3 });
  assert.ok(batches.every((b) => b.items.length <= 3));
  assert.equal(batches.length, 3);
});

test('wallets load from secret arrays, and watch-only from a bare pubkey', () => {
  const kp = Keypair.generate();
  const signing = parseEntry([...kp.secretKey], 0);
  assert.equal(signing.publicKey.toBase58(), kp.publicKey.toBase58());
  assert.ok(canSign(signing) && !signing.watchOnly);

  const watching = parseEntry(kp.publicKey.toBase58(), 1);
  assert.equal(watching.secretKey, null);
  assert.ok(watching.watchOnly);
});

test('a labelled entry keeps its label', () => {
  const kp = Keypair.generate();
  const w = parseEntry({ label: 'dev-07', secret: [...kp.secretKey] }, 0);
  assert.equal(w.label, 'dev-07');
});

test('error 6050 decodes to the sharing-config explanation', () => {
  const msg = explainError({ InstructionError: [1, { Custom: 6050 }] });
  assert.match(msg, /sharing config/i);
  assert.match(msg, /UnableToDistributeCreatorVaultMigratedToSharingConfig/);
});

test('unknown error codes still produce something readable', () => {
  assert.equal(explainError({ InstructionError: [0, { Custom: 999999 }] }), 'program error 999999');
  assert.equal(explainError(null), null);
});

test('rent floor constant matches what the program actually leaves behind', () => {
  // Observed directly: a swept vault settles at exactly this balance.
  assert.equal(SYSTEM_ACCOUNT_RENT_LAMPORTS, 890880);
});

test('a dry run needs no signing key at all', async () => {
  // Previewing must not require exposing a secret: simulation runs with
  // sigVerify disabled, so an unsigned transaction is a valid question to ask.
  const watchOnly = { publicKey: Keypair.generate().publicKey, label: 'watch', secretKey: null };
  const row = {
    ...watchOnly, pumpLamports: 1e8, pumpswapLamports: 0, totalLamports: 1e8, status: 'ready',
  };
  let simulated = 0;
  const connection = {
    async getLatestBlockhash() { return { blockhash: BLOCKHASH, lastValidBlockHeight: 1 }; },
    async simulateTransaction() { simulated++; return { value: { err: null, logs: [] } }; },
  };

  const results = await claimAll(connection, [row], watchOnly, { dryRun: true });
  assert.equal(simulated, 1, 'the batch reached simulateTransaction');
  assert.equal(results[0].ok, true);
  assert.equal(results[0].simulated, true);
});

test('sending still refuses a watch-only fee payer', async () => {
  const watchOnly = { publicKey: Keypair.generate().publicKey, label: 'watch', secretKey: null };
  const row = { ...watchOnly, pumpLamports: 1e8, pumpswapLamports: 0, totalLamports: 1e8, status: 'ready' };
  await assert.rejects(
    () => claimAll({}, [row], watchOnly, { dryRun: false }),
    /fee payer must be a wallet with a signing key/,
  );
});

test('sending refuses a watch-only claimant even when the payer can sign', async () => {
  const payerKp = Keypair.generate();
  const payer = { publicKey: payerKp.publicKey, label: 'payer', secretKey: payerKp.secretKey };
  const watchRow = {
    publicKey: Keypair.generate().publicKey, label: 'watch', secretKey: null,
    pumpLamports: 1e8, pumpswapLamports: 0, totalLamports: 1e8, status: 'ready',
  };
  await assert.rejects(
    () => claimAll({}, [watchRow], payer, { dryRun: false }),
    /cannot claim for watch-only wallet\(s\): watch/,
  );
});
