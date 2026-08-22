import { TOKEN_PROGRAM, SYSTEM_ACCOUNT_RENT_LAMPORTS, WSOL_MINT } from './constants.mjs';
import { decodeSharingConfig, isSharingConfig } from './sharing.mjs';
import { createLimiter, withRetry } from './limit.mjs';
import { createDerivePool, deriveForWallet } from './derive.mjs';

/** getMultipleAccounts caps out at 100 addresses per call. */
const RPC_ACCOUNT_CHUNK = 100;

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

/** Three accounts per wallet: bonding-curve vault, PumpSwap vault ATA, self. */
async function addressesFor(wallets, quoteMint, pool) {
  const derived = pool
    ? await pool.derive(wallets)
    : wallets.map((w) => deriveForWallet(w.publicKey, quoteMint));
  const addresses = [];
  for (let i = 0; i < wallets.length; i++) {
    addresses.push(derived[i][0], derived[i][1], wallets[i].publicKey);
  }
  return addresses;
}

function buildRow(wallet, vaultInfo, ataInfo, selfInfo) {
  const pump = pumpClaimable(vaultInfo?.lamports ?? 0);
  const pumpswap = Number(tokenAmount(ataInfo));
  // An address in a wallet list is occasionally not a wallet at all but a
  // sharing config PDA, because that is what a migrated bonding curve names
  // as its creator. Detect it here so the claim path never tries to sign.
  const selfConfig = isSharingConfig(selfInfo) ? decodeSharingConfig(wallet.publicKey, selfInfo.data) : null;
  return {
    ...wallet,
    pumpLamports: selfConfig ? 0 : pump,
    pumpswapLamports: pumpswap,
    totalLamports: (selfConfig ? 0 : pump) + pumpswap,
    walletLamports: selfInfo?.lamports ?? 0,
    selfConfig,
    selfConfigDistributable: selfConfig ? pump : 0,
    needsAta: pumpswap > 0,
  };
}

/** Anything worth carrying forward out of a scan. */
const hasFees = (row) => row.totalLamports > 0 || row.selfConfigDistributable > 0;

/**
 * Scan one batch of wallets, issuing its account lookups concurrently.
 */
async function scanBatch(connection, wallets, { quoteMint, limiter, onRetry, pool }) {
  const addresses = await addressesFor(wallets, quoteMint, pool);
  const chunks = [];
  for (let i = 0; i < addresses.length; i += RPC_ACCOUNT_CHUNK) {
    chunks.push(addresses.slice(i, i + RPC_ACCOUNT_CHUNK));
  }

  const results = await Promise.all(chunks.map((chunk) =>
    limiter(() => withRetry(() => connection.getMultipleAccountsInfo(chunk), { onRetry }))));

  const infos = results.flat();
  return wallets.map((w, i) => buildRow(w, infos[i * 3], infos[i * 3 + 1], infos[i * 3 + 2]));
}

/**
 * Stream a scan over an arbitrarily large wallet source.
 *
 * Two properties make this unbounded rather than merely large:
 *
 *   - Each batch's account lookups go out concurrently through a shared
 *     limiter, so throughput is set by the RPC's tolerance rather than by
 *     round-trip latency multiplied by wallet count.
 *   - Wallets with nothing to claim are dropped as soon as they are read.
 *     Out of a million wallets only the handful holding fees are ever
 *     retained, so peak memory tracks the number of *funded* wallets, not the
 *     size of the list.
 *
 * Yields arrays of rows. Consumers must not accumulate what they do not need.
 */
export async function* scanStream(walletBatches, connection, options = {}) {
  const {
    quoteMint = WSOL_MINT,
    concurrency = 8,
    minDelayMs = 0,
    keepEmpty = false,
    onProgress,
    onRetry,
    onRow,
    workers = 0,
    derivePool,
  } = options;

  const limiter = createLimiter({ concurrency, minDelayMs });
  // Address derivation is the CPU floor of a large scan, so it can be spread
  // across threads. Zero workers keeps everything on the main thread.
  const pool = derivePool ?? (workers > 0 ? createDerivePool({ workers, quoteMint }) : null);
  const ownsPool = !derivePool && pool !== null;
  let scanned = 0;
  let found = 0;
  // Duplicates are removed here rather than in the loader: only funded
  // wallets reach this point, so the set stays tiny and the check stays exact.
  const seen = new Set();

  try {
  for await (const wallets of walletBatches) {
    const rows = await scanBatch(connection, wallets, { quoteMint, limiter, onRetry, pool });
    scanned += wallets.length;
    const kept = [];
    for (const row of rows) {
      // Every row is offered to the caller before filtering, so things that
      // depend on wallets without fees — picking a fee payer, above all — can
      // be decided without retaining the whole set.
      onRow?.(row);
      if (!keepEmpty && !hasFees(row)) continue;
      const key = row.publicKey.toBase58();
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(row);
    }
    found += kept.length;
    onProgress?.(scanned, found);
    if (kept.length > 0) yield kept;
  }
  } finally {
    if (ownsPool) await pool.close();
  }
}

/**
 * Scan an in-memory array of wallets. Convenience wrapper over `scanStream`
 * that keeps every row, including the empty ones.
 */
export async function scanWallets(connection, wallets, options = {}) {
  const { onProgress } = options;
  const batches = (async function* () {
    for (let i = 0; i < wallets.length; i += 500) yield wallets.slice(i, i + 500);
  })();

  const out = [];
  for await (const rows of scanStream(batches, connection, {
    ...options,
    keepEmpty: true,
    onProgress: onProgress ? (scanned) => onProgress(scanned, wallets.length) : undefined,
  })) {
    out.push(...rows);
  }
  return out;
}
