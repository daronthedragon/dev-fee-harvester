import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { preflight } from '../src/preflight.mjs';
import { packBatches, workItems } from '../src/claim.mjs';

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

test('a clean run costs one request per transaction, not one per wallet', async () => {
  // The whole point of the rewrite. Twenty-four wallets pack into three
  // transactions of eight, and three questions settle all of them.
  let calls = 0;
  const chain = chainWith(async () => {
    calls++;
    return { value: { err: null } };
  });
  const rows = Array.from({ length: 24 }, (_, i) => row(`w${i}`, 1e8));
  const out = await preflight(chain, rows, payer);

  // One request per transaction that would be sent. How many that is comes
  // from the packer measuring real serialised sizes, so it is asked rather
  // than assumed.
  const expected = packBatches(
    rows.flatMap((r) => workItems(r, payer)),
    payer,
    { blockhash: BLOCKHASH },
  ).length;
  assert.ok(expected < 24, `the packer should batch these, it made ${expected} transactions`);
  assert.equal(calls, expected, `expected ${expected} simulations for 24 wallets, made ${calls}`);
  assert.equal(out.length, 24);
  assert.ok(
    out.every((r) => r.status === 'ready'),
    'every wallet cleared',
  );
});

test('the chain names the failing instruction, and only its owner is blocked', async () => {
  // Solana returns InstructionError: [index, err]. Nothing after that index
  // runs, so the survivors have to be asked again rather than assumed guilty.
  const rows = Array.from({ length: 8 }, (_, i) => row(`w${i}`, 1e8));
  const bad = rows[3].publicKey.toBase58();

  let calls = 0;
  const chain = chainWith(async (tx) => {
    calls++;
    const keys = tx.message.compiledInstructions.map((ix) =>
      tx.message.staticAccountKeys[ix.programIdIndex].toBase58(),
    );
    // Find which instruction belongs to the bad wallet by account presence.
    const idx = tx.message.compiledInstructions.findIndex((ix) =>
      ix.accountKeyIndexes.some((k) => tx.message.staticAccountKeys[k].toBase58() === bad),
    );
    void keys;
    if (idx === -1) return { value: { err: null } };
    return { value: { err: { InstructionError: [idx, { Custom: 6050 }] } } };
  });

  const out = await preflight(chain, rows, payer);
  const blocked = out.filter((r) => r.status === 'blocked');
  const ready = out.filter((r) => r.status === 'ready');

  assert.equal(blocked.length, 1, `expected exactly one blocked row, got ${blocked.length}`);
  assert.equal(blocked[0].label, 'w3');
  assert.match(blocked[0].reason, /sharing config/i);
  assert.equal(ready.length, 7, 'the other seven were re-checked and cleared');
  // One per transaction, plus one re-check of the survivors after the bad
  // item was named. Not one per wallet.
  const batches = packBatches(
    rows.flatMap((r) => workItems(r, payer)),
    payer,
    { blockhash: BLOCKHASH },
  ).length;
  assert.equal(calls, batches + 1, `expected ${batches + 1} simulations, made ${calls}`);
  assert.ok(calls < rows.length, `${calls} simulations for ${rows.length} wallets is not a saving`);
});

test('a failure that names no instruction is narrowed down by halving', async () => {
  // InvalidAccountForFee is about the transaction, not anything in it, so
  // there is nothing to attribute and each item has to be asked on its own.
  const rows = Array.from({ length: 4 }, (_, i) => row(`w${i}`, 1e8));
  const bad = rows[2].publicKey.toBase58();
  const chain = chainWith(async (tx) => {
    const involved = tx.message.staticAccountKeys.some((k) => k.toBase58() === bad);
    return { value: { err: involved ? 'InvalidAccountForFee' : null } };
  });

  const out = await preflight(chain, rows, payer);
  assert.deepEqual(
    out.map((r) => r.status),
    ['ready', 'ready', 'blocked', 'ready'],
  );
  assert.match(out[2].reason, /InvalidAccountForFee/);
});
