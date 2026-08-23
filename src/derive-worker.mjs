import { parentPort, workerData } from 'node:worker_threads';
import { PublicKey } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  PUMPSWAP_PROGRAM,
  PUMP_PROGRAM,
  SEED_PUMPSWAP_CREATOR_VAULT,
  SEED_PUMP_CREATOR_VAULT,
  TOKEN_PROGRAM,
} from './constants.mjs';

/**
 * Derives the three lookup addresses per wallet.
 *
 * This runs in a worker because the cost is entirely `isOnCurve`, an ed25519
 * point check implemented in pure JavaScript that dominates any large scan.
 * It is pure CPU over independent inputs, so it parallelises exactly.
 *
 * Wallets arrive as one packed buffer of 32-byte keys and results go back as
 * one packed buffer of three addresses each, to keep the per-wallet messaging
 * overhead from eating the gain.
 */
const quoteMint = new PublicKey(Uint8Array.from(workerData.quoteMint));
const quoteMintBuf = quoteMint.toBuffer();

function derive(walletBytes) {
  const wallet = new PublicKey(walletBytes);
  const walletBuf = wallet.toBuffer();

  const [vault] = PublicKey.findProgramAddressSync(
    [SEED_PUMP_CREATOR_VAULT, walletBuf],
    PUMP_PROGRAM,
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [SEED_PUMPSWAP_CREATOR_VAULT, walletBuf],
    PUMPSWAP_PROGRAM,
  );
  const [ata] = PublicKey.findProgramAddressSync(
    [vaultAuthority.toBuffer(), TOKEN_PROGRAM.toBuffer(), quoteMintBuf],
    ASSOCIATED_TOKEN_PROGRAM,
  );

  return [vault, ata];
}

parentPort.on('message', ({ id, keys }) => {
  const input = Buffer.from(keys);
  const n = input.length / 32;
  const out = Buffer.allocUnsafe(n * 64);
  for (let i = 0; i < n; i++) {
    const [vault, ata] = derive(input.subarray(i * 32, i * 32 + 32));
    vault.toBuffer().copy(out, i * 64);
    ata.toBuffer().copy(out, i * 64 + 32);
  }
  const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  parentPort.postMessage({ id, result: buf }, [buf]);
});
