import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { scanStream } from '../src/scan.mjs';

const SYS = new PublicKey('11111111111111111111111111111111');
const RENT = 890880;

/** An RPC stub where nothing anywhere holds a balance. */
const emptyChain = {
  async getMultipleAccountsInfo(addresses) {
    return addresses.map(() => null);
  },
};

const batchOf = (n) =>
  (async function* () {
    yield Array.from({ length: n }, (_, i) => ({
      publicKey: Keypair.generate().publicKey,
      label: `w${i}`,
      secretKey: null,
    }));
  })();

test('wallets with nothing at all are dropped', async () => {
  const kept = [];
  for await (const chunk of scanStream(batchOf(5), emptyChain, { workers: 0 })) kept.push(...chunk);
  assert.equal(kept.length, 0);
});

test('a wallet whose only value is a share elsewhere survives the filter', async () => {
  // Regression: the scan dropped empty wallets before the shareholder sweep
  // ran, so --find-shares could never see the wallets it exists to find — a
  // shareholder has no balance of its own by definition.
  const mint = Keypair.generate().publicKey;
  const enrich = async (rows) =>
    rows.map((r, i) =>
      i === 2
        ? {
            ...r,
            distributions: [
              {
                config: { address: Keypair.generate().publicKey, mint, shareholders: [] },
                mint,
                distributable: 2_670_512_000,
                userShare: 2_670_512_000,
                kind: 'share',
              },
            ],
            sharingLamports: 2_670_512_000,
          }
        : { ...r, distributions: [] },
    );

  const kept = [];
  for await (const chunk of scanStream(batchOf(5), emptyChain, { workers: 0, enrich }))
    kept.push(...chunk);

  assert.equal(kept.length, 1, 'the shareholder wallet is kept');
  assert.equal(kept[0].label, 'w2');
  assert.equal(kept[0].distributions[0].distributable, 2_670_512_000);
});

test('enrich runs on every wallet, not only funded ones', async () => {
  let seen = 0;
  const enrich = async (rows) => {
    seen += rows.length;
    return rows;
  };
  for await (const _ of scanStream(batchOf(7), emptyChain, { workers: 0, enrich })) {
    /* drained */
  }
  assert.equal(seen, 7, 'enrichment sees the whole batch, before filtering');
});

test('a funded vault is reported with the rent floor deducted', async () => {
  const chain = {
    async getMultipleAccountsInfo(addresses) {
      // The first address of each wallet triple is its bonding-curve vault.
      return addresses.map((_, i) =>
        i === 0 ? { lamports: RENT + 1_000_000_000, data: Buffer.alloc(0), owner: SYS } : null,
      );
    },
  };
  const kept = [];
  for await (const chunk of scanStream(batchOf(1), chain, { workers: 0 })) kept.push(...chunk);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].pumpLamports, 1_000_000_000, 'rent-exempt minimum is not promised');
});

test('the creator index removes the lookups, not the wallets', async () => {
  // The whole claim of the index is that a wallet it rules out costs nothing.
  // Assert on what reached the RPC, not just on the rows that came back.
  const wallets = Array.from({ length: 10 }, (_, i) => ({
    publicKey: Keypair.generate().publicKey,
    label: `w${i}`,
    secretKey: null,
  }));
  const creators = new Set([wallets[3], wallets[7]].map((w) => w.publicKey.toBase58()));
  const asked = [];
  const chain = {
    async getMultipleAccountsInfo(addresses) {
      asked.push(...addresses);
      return addresses.map(() => null);
    },
  };

  const rows = [];
  for await (const chunk of scanStream(
    (async function* () {
      yield wallets;
    })(),
    chain,
    {
      workers: 0,
      keepEmpty: true,
      creatorIndex: { mightBeCreator: (pk) => creators.has(pk.toBase58()) },
    },
  )) {
    rows.push(...chunk);
  }

  // Three accounts each for the two creators, and nothing for the other eight.
  assert.equal(asked.length, 6);
  for (const w of wallets) {
    const present = asked.some((a) => a.equals(w.publicKey));
    assert.equal(present, creators.has(w.publicKey.toBase58()), `${w.label} lookup`);
  }

  // Every wallet still comes back, in order, so callers see one row each.
  assert.deepEqual(
    rows.map((r) => r.label),
    wallets.map((w) => w.label),
  );
  // And a skipped wallet reports an unread balance rather than a zero one.
  assert.equal(rows[0].walletLamports, null);
  assert.equal(rows[0].notCreator, true);
  assert.equal(rows[3].walletLamports, 0);
  assert.equal(rows[3].notCreator, undefined);
});

test('a batch the index rules out entirely issues no request at all', async () => {
  let calls = 0;
  const chain = {
    async getMultipleAccountsInfo(addresses) {
      calls++;
      return addresses.map(() => null);
    },
  };
  const rows = [];
  for await (const chunk of scanStream(batchOf(200), chain, {
    workers: 0,
    keepEmpty: true,
    creatorIndex: { mightBeCreator: () => false },
  })) {
    rows.push(...chunk);
  }
  assert.equal(calls, 0);
  assert.equal(rows.length, 200);
});
