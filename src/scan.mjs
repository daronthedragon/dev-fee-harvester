import { TOKEN_PROGRAM, SYSTEM_ACCOUNT_RENT_LAMPORTS, WSOL_MINT } from './constants.mjs';
import { associatedTokenAddress, pumpCreatorVault, pumpswapCreatorVaultAuthority } from './pda.mjs';
import { decodeSharingConfig, isSharingConfig } from './sharing.mjs';

/** SPL token account: mint(32) owner(32) amount(u64 LE @64). */
function tokenAmount(info) {
  if (!info || info.data.length < 72) return 0n;
  if (!info.owner.equals(TOKEN_PROGRAM)) return 0n;
  return info.data.readBigUInt64LE(64);
}

/**
 * The bonding-curve vault is a plain system account, so it must retain the
 * rent-exempt minimum. Only the excess is actually claimable — reporting the
 * raw balance would promise ~0.00089 SOL per wallet that never arrives.
 */
function pumpClaimable(lamports) {
  return lamports > SYSTEM_ACCOUNT_RENT_LAMPORTS ? lamports - SYSTEM_ACCOUNT_RENT_LAMPORTS : 0;
}

/**
 * Read claimable pump.fun + PumpSwap fees for every wallet.
 *
 * Batched through getMultipleAccountsInfo (100 per call, the RPC cap) so a
 * 500-wallet scan is ~10 round trips rather than 1000.
 */
export async function scanWallets(connection, wallets, { quoteMint = WSOL_MINT, onProgress } = {}) {
  // Three accounts per wallet: the bonding-curve vault, the PumpSwap vault
  // ATA, and the wallet itself — the last because fees accrue in the vaults,
  // not the wallet, so a creator sitting on 3 SOL of fees can still have an
  // empty wallet and be unable to pay a transaction fee.
  const addresses = [];
  for (const w of wallets) {
    const vaultAuthority = pumpswapCreatorVaultAuthority(w.publicKey);
    addresses.push(
      pumpCreatorVault(w.publicKey),
      associatedTokenAddress(vaultAuthority, quoteMint),
      w.publicKey,
    );
  }

  const infos = new Array(addresses.length).fill(null);
  const CHUNK = 100;
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const slice = addresses.slice(i, i + CHUNK);
    const got = await connection.getMultipleAccountsInfo(slice);
    got.forEach((info, j) => { infos[i + j] = info; });
    onProgress?.(Math.min(i + CHUNK, addresses.length), addresses.length);
  }

  return wallets.map((w, i) => {
    const vaultInfo = infos[i * 3];
    const ataInfo = infos[i * 3 + 1];
    const selfInfo = infos[i * 3 + 2];
    const pump = pumpClaimable(vaultInfo?.lamports ?? 0);
    const pumpswap = Number(tokenAmount(ataInfo));
    // An address in a wallet list is occasionally not a wallet at all but a
    // sharing config PDA, because that is what a migrated bonding curve names
    // as its creator. Detect it here so the claim path never tries to sign.
    const selfConfig = isSharingConfig(selfInfo)
      ? decodeSharingConfig(w.publicKey, selfInfo.data)
      : null;
    return {
      ...w,
      pumpLamports: selfConfig ? 0 : pump,
      pumpswapLamports: pumpswap,
      totalLamports: (selfConfig ? 0 : pump) + pumpswap,
      walletLamports: selfInfo?.lamports ?? 0,
      selfConfig,
      selfConfigDistributable: selfConfig ? pump : 0,
      needsAta: pumpswap > 0,
    };
  });
}
