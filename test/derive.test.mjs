import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { createDerivePool, defaultWorkerCount, deriveForWallet } from '../src/derive.mjs';
import {
  associatedTokenAddress,
  pumpCreatorVault,
  pumpswapCreatorVaultAuthority,
} from '../src/pda.mjs';
import { WSOL_MINT } from '../src/constants.mjs';
import { createLimiter, delay, withRetry, forEachBatch } from '../src/limit.mjs';

test('deriveForWallet returns the creator vault and the PumpSwap vault ATA', () => {
  const pk = Keypair.generate().publicKey;
  const [vault, ata] = deriveForWallet(pk);
  assert.equal(vault.toBase58(), pumpCreatorVault(pk).toBase58());
  assert.equal(
    ata.toBase58(),
    associatedTokenAddress(pumpswapCreatorVaultAuthority(pk), WSOL_MINT).toBase58(),
  );
});

test('a zero-worker pool still derives, on the main thread', async () => {
  const pool = createDerivePool({ workers: 0 });
  assert.equal(pool.size, 0);
  const wallets = Array.from({ length: 5 }, () => ({ publicKey: Keypair.generate().publicKey }));
  const got = await pool.derive(wallets);
  wallets.forEach((w, i) => {
    assert.equal(got[i][0].toBase58(), pumpCreatorVault(w.publicKey).toBase58());
  });
  await pool.close();
});

test('worker-derived addresses are identical to single-threaded ones', async () => {
  // Threads are only worth having if they cannot disagree with the reference.
  const workers = Math.max(1, Math.min(2, defaultWorkerCount()));
  const pool = createDerivePool({ workers });
  const wallets = Array.from({ length: 120 }, () => ({ publicKey: Keypair.generate().publicKey }));
  const pooled = await pool.derive(wallets);
  await pool.close();

  assert.equal(pooled.length, wallets.length, 'every wallet comes back');
  wallets.forEach((w, i) => {
    const [vault, ata] = deriveForWallet(w.publicKey);
    assert.equal(pooled[i][0].toBase58(), vault.toBase58(), `vault mismatch at ${i}`);
    assert.equal(pooled[i][1].toBase58(), ata.toBase58(), `ata mismatch at ${i}`);
  });
});

test('a pool split across workers preserves input order', async () => {
  // Results are reassembled from several workers, so ordering is a real risk:
  // a shuffled result would attach one wallet's balance to another wallet.
  const pool = createDerivePool({ workers: 3 });
  const wallets = Array.from({ length: 97 }, () => ({ publicKey: Keypair.generate().publicKey }));
  const pooled = await pool.derive(wallets);
  await pool.close();
  wallets.forEach((w, i) => {
    assert.equal(
      pooled[i][0].toBase58(),
      pumpCreatorVault(w.publicKey).toBase58(),
      `out of order at ${i}`,
    );
  });
});

test('the limiter never exceeds its concurrency', async () => {
  const limit = createLimiter({ concurrency: 3 });
  let inFlight = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 40 }, () =>
      limit(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await delay(5);
        inFlight--;
      }),
    ),
  );
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
});

test('withRetry retries then succeeds', async () => {
  let calls = 0;
  const value = await withRetry(
    async () => {
      if (++calls < 3) throw new Error('429 Too Many Requests');
      return 'ok';
    },
    { attempts: 5, baseDelayMs: 1 },
  );
  assert.equal(value, 'ok');
  assert.equal(calls, 3);
});

test('withRetry throws rather than returning a silent empty result', async () => {
  // A swallowed RPC failure reads as "no fees here", which is the one wrong
  // answer that costs money.
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new Error('boom');
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    /boom/,
  );
  assert.equal(calls, 3);
});

test('forEachBatch walks an async iterable in order', async () => {
  const seen = [];
  await forEachBatch(
    (async function* () {
      yield [1, 2];
      yield [3];
    })(),
    (batch, i) => {
      seen.push([i, batch]);
    },
  );
  assert.deepEqual(seen, [
    [0, [1, 2]],
    [1, [3]],
  ]);
});
