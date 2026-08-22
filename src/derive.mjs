import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { PublicKey } from '@solana/web3.js';
import { WSOL_MINT } from './constants.mjs';
import { associatedTokenAddress, pumpCreatorVault, pumpswapCreatorVaultAuthority } from './pda.mjs';

/**
 * Address derivation, optionally spread across worker threads.
 *
 * At scale this is the binding constraint: each wallet needs three program
 * addresses, and finding one costs ~280us, almost all of it inside the pure-JS
 * ed25519 `isOnCurve` check. RPC latency hides behind concurrency; this does
 * not, so it is the thing that decides how long a million-wallet scan takes.
 */

/** Single-threaded derivation — the reference implementation. */
export function deriveForWallet(publicKey, quoteMint = WSOL_MINT) {
  const vaultAuthority = pumpswapCreatorVaultAuthority(publicKey);
  return [pumpCreatorVault(publicKey), associatedTokenAddress(vaultAuthority, quoteMint)];
}

/** How many workers to use by default: leave a core for the event loop. */
export const defaultWorkerCount = () => Math.max(0, Math.min(8, availableParallelism() - 1));

/**
 * A pool of derivation workers. `derive(wallets)` returns, for each wallet,
 * `[creatorVault, pumpswapVaultAta]`.
 */
export function createDerivePool({ workers = defaultWorkerCount(), quoteMint = WSOL_MINT } = {}) {
  if (workers <= 0) {
    return {
      size: 0,
      derive: async (wallets) => wallets.map((w) => deriveForWallet(w.publicKey ?? w, quoteMint)),
      close: async () => {},
    };
  }

  const url = new URL('./derive-worker.mjs', import.meta.url);
  const pool = Array.from({ length: workers }, () => {
    const worker = new Worker(url, { workerData: { quoteMint: [...quoteMint.toBytes()] } });
    worker.unref();
    return { worker, busy: false, handlers: new Map() };
  });

  let nextId = 0;
  for (const slot of pool) {
    slot.worker.on('message', ({ id, result }) => {
      const pending = slot.handlers.get(id);
      slot.handlers.delete(id);
      pending?.resolve(Buffer.from(result));
    });
    // One error listener per worker, for its whole life. Attaching one per
    // message leaks a listener on every success, which Node warns about at 11
    // and which would grow without bound over a long scan.
    slot.worker.on('error', (err) => {
      for (const pending of slot.handlers.values()) pending.reject(err);
      slot.handlers.clear();
    });
  }

  const send = (slot, keys) => new Promise((resolve, reject) => {
    const id = nextId++;
    slot.handlers.set(id, { resolve, reject });
    slot.worker.postMessage({ id, keys }, [keys]);
  });

  let cursor = 0;
  const derive = async (wallets) => {
    // Split the batch evenly and let every worker chew on its slice.
    const per = Math.ceil(wallets.length / pool.length);
    const jobs = [];
    for (let i = 0; i < wallets.length; i += per) {
      const slice = wallets.slice(i, i + per);
      const packed = Buffer.allocUnsafe(slice.length * 32);
      slice.forEach((w, j) => Buffer.from((w.publicKey ?? w).toBytes()).copy(packed, j * 32));
      const slot = pool[cursor++ % pool.length];
      const ab = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength);
      jobs.push(send(slot, ab).then((out) => {
        const results = [];
        for (let k = 0; k < slice.length; k++) {
          results.push([
            new PublicKey(out.subarray(k * 64, k * 64 + 32)),
            new PublicKey(out.subarray(k * 64 + 32, k * 64 + 64)),
          ]);
        }
        return results;
      }));
    }
    return (await Promise.all(jobs)).flat();
  };


  return {
    size: pool.length,
    derive,
    close: async () => { await Promise.all(pool.map((s) => s.worker.terminate())); },
  };
}
