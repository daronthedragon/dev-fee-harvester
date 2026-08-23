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
