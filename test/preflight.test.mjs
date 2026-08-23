import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { preflight } from '../src/preflight.mjs';
import { workItems } from '../src/claim.mjs';

const BLOCKHASH = '11111111111111111111111111111111';
const payer = Keypair.generate().publicKey;

const row = (label, lamports) => ({
  publicKey: Keypair.generate().publicKey,
  label,
  secretKey: null,
  pumpLamports: lamports,
  pumpswapLamports: 0,
  totalLamports: lamports,
  distributions: [],
});

const chainWith = (behaviour) => ({
  async getLatestBlockhash() {
    return { blockhash: BLOCKHASH };
  },
  simulateTransaction: behaviour,
});

test('a clean simulation marks the row ready', async () => {
  const chain = chainWith(async () => ({ value: { err: null } }));
  const [out] = await preflight(chain, [row('a', 1e8)], payer);
  assert.equal(out.status, 'ready');
  assert.equal(out.verifiedLamports, 1e8);
});

test('a chain rejection marks the row blocked with the program reason', async () => {
  const chain = chainWith(async () => ({
    value: { err: { InstructionError: [0, { Custom: 6050 }] } },
  }));
  const [out] = await preflight(chain, [row('a', 1e8)], payer);
  assert.equal(out.status, 'blocked');
  assert.match(out.reason, /sharing config/i);
  assert.equal(out.verifiedLamports, 0);
});

test('an RPC failure is not reported as a rejection', async () => {
  // A rate-limited request says nothing about whether the claim would work.
  // Calling it "blocked" writes off claimable money on a transport hiccup.
  const chain = chainWith(async () => {
    throw new Error('429 Too Many Requests');
  });
  const [out] = await preflight(chain, [row('a', 1e8)], payer);
  assert.equal(out.status, 'unchecked', 'not blocked');
  assert.ok(out.unverified);
  assert.match(out.reason, /could not verify/);
});

test('a transient RPC failure recovers on retry', async () => {
  let calls = 0;
  const chain = chainWith(async () => {
    if (++calls < 3) throw new Error('429 Too Many Requests');
    return { value: { err: null } };
  });
  const [out] = await preflight(chain, [row('a', 1e8)], payer);
  assert.equal(out.status, 'ready');
  assert.equal(calls, 3);
});

test('unverified work is kept out of batches', async () => {
  const chain = chainWith(async () => {
    throw new Error('network down');
  });
  const [out] = await preflight(chain, [row('a', 1e8)], payer);
  assert.equal(workItems(out, payer).length, 0, 'nothing unconfirmed goes into a transaction');
});

test('one failed check does not condemn a row that also has good work', async () => {
  const failing = new PublicKey('HssQnt18QzfRznC2FjMDGhRE5XoxYmnVLYYkGYsXpump');
  const working = new PublicKey('CyKe8fsA3U8povf4U59WLYQRn3RPohCgmSDibkmDWUPE');
  const target = {
    ...row('a', 0),
    distributions: [failing, working].map((m) => ({
      config: { address: Keypair.generate().publicKey, mint: m, shareholders: [] },
      mint: m,
      distributable: 5e8,
      userShare: 5e8,
    })),
  };

  // Keyed on the transaction's own accounts, so the two items running
  // concurrently cannot make the outcome depend on interleaving.
  const chain = chainWith(async (tx) => {
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    if (keys.includes(failing.toBase58())) throw new Error('429 Too Many Requests');
    return { value: { err: null } };
  });

  const [out] = await preflight(chain, [target], payer);
  assert.equal(out.status, 'ready', 'the verified distribution still counts');
  assert.ok(out.partial, 'and the row is flagged as partial');
  assert.equal(out.verifiedLamports, 5e8, 'only the verified half is counted');
  assert.match(out.reason, /could not verify/);
});
