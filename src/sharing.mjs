import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  DISCRIMINATORS,
  PUMP_FEES_PROGRAM,
  PUMP_PROGRAM,
  SHARING_CONFIG_DISCRIMINATOR,
  SHARING_CONFIG_SIZE,
  SYSTEM_ACCOUNT_RENT_LAMPORTS,
  SYSTEM_PROGRAM,
} from './constants.mjs';
import { bondingCurve, eventAuthority, pumpCreatorVault } from './pda.mjs';
import { encodeBase58 } from './base58.mjs';
import { createLimiter, delay, withRetry } from './limit.mjs';
import { streamProgramAccounts } from './rpc-stream.mjs';

/**
 * Fee sharing.
 *
 * When a creator splits fees with a team, pump.fun does something that trips
 * up every naive claimer: it sets `bonding_curve.creator` to the *sharing
 * config PDA* rather than to a wallet. Fees then accrue in a creator vault
 * derived from that PDA, and `collect_creator_fee` refuses to touch it
 * (error 6050). The money is only released by `distribute_creator_fees`,
 * which splits the vault across the config's shareholders by basis points.
 *
 * Two consequences worth knowing:
 *   1. Those fees are invisible to a per-wallet vault scan, because the vault
 *      does not belong to any wallet you hold.
 *   2. `distribute_creator_fees` takes no signer. Anyone may crank it, and the
 *      funds can only ever go to the shareholders the config already names.
 */

/** Shareholder entries are a pubkey plus a u16 of basis points. */
const SHAREHOLDER_SIZE = 34;
const SHAREHOLDERS_OFFSET = 80;
const MINT_OFFSET = 11;

/** How many shareholder slots can physically fit in the fixed-size account. */
export const SHAREHOLDER_SLOTS = Math.floor(
  (SHARING_CONFIG_SIZE - SHAREHOLDERS_OFFSET) / SHAREHOLDER_SIZE,
);

/** True when this account really is a SharingConfig owned by pump_fees. */
export function isSharingConfig(info) {
  return (
    Boolean(info) &&
    info.owner.equals(PUMP_FEES_PROGRAM) &&
    info.data.length >= SHAREHOLDERS_OFFSET + 4 &&
    info.data.subarray(0, 8).equals(Buffer.from(SHARING_CONFIG_DISCRIMINATOR))
  );
}

export function decodeSharingConfig(address, data) {
  const count = data.readUInt32LE(SHAREHOLDERS_OFFSET - 4);
  const shareholders = [];
  for (let i = 0; i < count; i++) {
    const o = SHAREHOLDERS_OFFSET + i * SHAREHOLDER_SIZE;
    if (o + SHAREHOLDER_SIZE > data.length) break;
    shareholders.push({
      address: new PublicKey(data.subarray(o, o + 32)),
      bps: data.readUInt16LE(o + 32),
    });
  }
  return {
    address: new PublicKey(address),
    mint: new PublicKey(data.subarray(MINT_OFFSET, MINT_OFFSET + 32)),
    admin: new PublicKey(data.subarray(43, 75)),
    adminRevoked: data[75] === 1,
    active: data[10] === 1,
    shareholders,
  };
}

/**
 * `distribute_creator_fees` — releases a migrated vault to its shareholders.
 * IDL account order, then every shareholder as a remaining account in exactly
 * the stored order (error 6054 if that order is disturbed).
 */
export function distributeCreatorFeesIx(config) {
  const curve = bondingCurve(config.mint);
  const vault = pumpCreatorVault(config.address);
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: config.mint, isSigner: false, isWritable: false },
      { pubkey: curve, isSigner: false, isWritable: false },
      { pubkey: config.address, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: eventAuthority(PUMP_PROGRAM), isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
      // Shareholders receive lamports, so each must be writable.
      ...config.shareholders.map((s) => ({ pubkey: s.address, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from(DISCRIMINATORS.distribute_creator_fees),
  });
}

/** How much is actually releasable from a config's vault right now. */
export function distributableLamports(vaultLamports) {
  return vaultLamports > SYSTEM_ACCOUNT_RENT_LAMPORTS
    ? vaultLamports - SYSTEM_ACCOUNT_RENT_LAMPORTS
    : 0;
}

/** A wallet's cut of a distribution, by basis points. */
export function shareFor(config, wallet, distributable) {
  const holder = config.shareholders.find((s) => s.address.equals(wallet));
  if (!holder) return 0;
  return Math.floor((distributable * holder.bps) / 10_000);
}

/**
 * Case 2: find every sharing config in which this wallet is a shareholder.
 *
 * Shareholders sit at fixed offsets, so this probes each slot with a server
 * side memcmp filter instead of downloading the set (a full scan of these
 * accounts is hundreds of megabytes). One request per slot, run concurrently;
 * each returns almost nothing unless it matches.
 */
export async function findConfigsForShareholder(connection, wallet, options = {}) {
  // These are the heaviest requests the tool makes and public endpoints
  // throttle them hard, so the sweep is deliberately more patient than the
  // account lookups: six attempts backing off from half a second.
  const {
    slots = SHAREHOLDER_SLOTS,
    concurrency = 6,
    attempts = 6,
    baseDelayMs = 500,
    limiter,
  } = options;
  const discFilter = { memcmp: { offset: 0, bytes: encodeBase58(SHARING_CONFIG_DISCRIMINATOR) } };

  const querySlot = async (i) => {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await connection.getProgramAccounts(PUMP_FEES_PROGRAM, {
          commitment: 'confirmed',
          filters: [
            discFilter,
            {
              memcmp: {
                offset: SHAREHOLDERS_OFFSET + i * SHAREHOLDER_SIZE,
                bytes: wallet.toBase58(),
              },
            },
          ],
        });
      } catch (err) {
        lastError = err;
        await delay(baseDelayMs * 2 ** attempt);
      }
    }
    // Never swallow this. A rate-limited slot that quietly returns nothing
    // reads as "no fees here", which is the one wrong answer that costs money.
    throw new Error(
      `shareholder slot ${i} failed after ${attempts} attempts: ${lastError?.message ?? 'unknown'}`,
    );
  };

  // Bounded concurrency: firing all 27 slots at once is what provokes the
  // rate limiting in the first place. A caller-supplied limiter takes over
  // when there is one, so `--rpc-delay` reaches these requests too — they are
  // by far the heaviest thing this tool asks an RPC for.
  const gate = limiter ?? createLimiter({ concurrency });
  const seen = new Map();
  const results = await Promise.all(
    Array.from({ length: slots }, (_, i) => gate(() => querySlot(i))),
  );
  for (const acc of results.flat()) {
    const key = acc.pubkey.toBase58();
    if (!seen.has(key)) seen.set(key, decodeSharingConfig(acc.pubkey, acc.account.data));
  }
  return [...seen.values()];
}

/**
 * Build the shareholder lookup in a fixed number of requests.
 *
 * `findConfigsForShareholder` costs 27 filtered requests per wallet, because a
 * shareholder can sit at any slot in the array. That is fine for a handful of
 * wallets and hopeless for a hundred — 2,700 of the heaviest call this tool
 * makes, against endpoints that already throttle them.
 *
 * This inverts it: read the configs once, keep only the entries naming a
 * wallet we hold, and answer every wallet from that. The cost stops depending
 * on how many wallets you own.
 *
 * Completeness is the whole point, so it is done in two passes rather than
 * one. Pass A slices the vec length plus its first `INLINE_SLOTS` entries,
 * which covers ~99.5% of configs. Pass B fetches, in full, only those whose
 * length says they hold more — so a config with more shareholders than the
 * slice covers is picked up rather than missed. Nothing here assumes the
 * current maximum (10) will hold.
 *
 * Pass A is streamed rather than collected, so memory tracks one entry
 * rather than the size of the whole result.
 */
const INLINE_SLOTS = 2;

/** Read shareholders out of a buffer laid out as the vec is on chain. */
function readShareholders(data, offsetOfLength, available) {
  const count = data.readUInt32LE(offsetOfLength);
  const out = [];
  for (let i = 0; i < Math.min(count, available); i++) {
    const o = offsetOfLength + 4 + i * SHAREHOLDER_SIZE;
    if (o + SHAREHOLDER_SIZE > data.length) break;
    out.push({
      address: new PublicKey(data.subarray(o, o + 32)),
      bps: data.readUInt16LE(o + 32),
    });
  }
  return { count, shareholders: out };
}

export async function buildShareholderIndex(connection, wallets, options = {}) {
  const { onProgress, limiter, fetchImpl } = options;
  const wanted = new Set(wallets.map((w) => (w.publicKey ?? w).toBase58()));
  const index = new Map();
  if (wanted.size === 0) return index;

  const run = (fn) => (limiter ? limiter(fn) : fn());
  const discFilter = {
    memcmp: { offset: 0, bytes: encodeBase58(SHARING_CONFIG_DISCRIMINATOR) },
  };

  onProgress?.({ phase: 'scan-configs' });
  const hits = new Set();
  const overflow = [];

  // Streamed, not collected: every config on the chain passes through here and
  // only the few that matter are kept.
  const scanned = await run(() =>
    withRetry(
      () =>
        streamProgramAccounts(connection.rpcEndpoint, PUMP_FEES_PROGRAM, {
          commitment: 'confirmed',
          ...(fetchImpl ? { fetchImpl } : {}),
          filters: [discFilter],
          dataSlice: {
            offset: SHAREHOLDERS_OFFSET - 4,
            length: 4 + INLINE_SLOTS * SHAREHOLDER_SIZE,
          },
          onAccount: ({ pubkey, data }) => {
            const { count, shareholders } = readShareholders(data, 0, INLINE_SLOTS);
            if (count > INLINE_SLOTS) overflow.push(new PublicKey(pubkey));
            if (shareholders.some((sh) => wanted.has(sh.address.toBase58()))) hits.add(pubkey);
          },
        }),
      { attempts: 4, baseDelayMs: 1000 },
    ),
  );
  onProgress?.({ phase: 'scanned', configs: scanned, overflow: overflow.length });

  // Pass B: the tail whose shareholders the slice could not reach.
  const overflowConfigs = await fetchConfigs(connection, overflow, run);
  for (const cfg of overflowConfigs) {
    if (cfg.shareholders.some((sh) => wanted.has(sh.address.toBase58())))
      hits.add(cfg.address.toBase58());
  }
  onProgress?.({ phase: 'tail-checked', matched: hits.size });

  // Full records for the matches, which is where mint and status live.
  const matched = await fetchConfigs(
    connection,
    [...hits].map((k) => new PublicKey(k)),
    run,
  );
  for (const cfg of matched) {
    for (const sh of cfg.shareholders) {
      const key = sh.address.toBase58();
      if (!wanted.has(key)) continue;
      const list = index.get(key) ?? [];
      list.push(cfg);
      index.set(key, list);
    }
  }
  onProgress?.({ phase: 'done', wallets: index.size });
  return index;
}

/** Fetch and decode full config accounts, 100 at a time. */
async function fetchConfigs(connection, addresses, run) {
  const out = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const slice = addresses.slice(i, i + 100);
    const infos = await run(() =>
      withRetry(() => connection.getMultipleAccountsInfo(slice), {
        attempts: 4,
        baseDelayMs: 500,
      }),
    );
    infos.forEach((info, j) => {
      if (isSharingConfig(info)) out.push(decodeSharingConfig(slice[j], info.data));
    });
  }
  return out;
}

/** Attach live vault balances to a set of configs. Module-internal. */
async function withVaultBalances(connection, configs) {
  if (configs.length === 0) return [];
  const vaults = configs.map((cfg) => pumpCreatorVault(cfg.address));
  const infos = [];
  for (let i = 0; i < vaults.length; i += 100) {
    infos.push(...(await connection.getMultipleAccountsInfo(vaults.slice(i, i + 100))));
  }
  return configs.map((cfg, i) => ({
    ...cfg,
    vault: vaults[i],
    vaultLamports: infos[i]?.lamports ?? 0,
    distributable: distributableLamports(infos[i]?.lamports ?? 0),
  }));
}

/**
 * Work out which distributions each row can trigger.
 *
 * Two separate cases, and they mean different things to the user:
 *
 *   Self  — the row's own address is a sharing config. Cranking it releases
 *           the vault to that config's shareholders. The user only profits if
 *           one of those shareholders is a wallet they hold.
 *   Share — the row's wallet is named as a shareholder somewhere else. This is
 *           the interesting one: those fees are invisible to a plain vault
 *           scan, because the vault belongs to a PDA rather than the wallet.
 *
 * Shareholder discovery costs one filtered request per shareholder slot, so it
 * stays behind a flag rather than being paid for on every scan.
 */
export async function attachDistributions(
  connection,
  rows,
  { findShares = false, concurrency = 2, onProgress, limiter, shareIndex } = {},
) {
  const out = rows.map((r) => ({ ...r, distributions: [], sharingLamports: 0 }));

  // Two wallets can be shareholders of one config. Emitting the crank twice in
  // a single transaction would make the second instruction fail on an empty
  // vault, so each config is cranked by exactly one row.
  const claimedConfigs = new Set();

  for (const row of out) {
    if (row.selfConfig && row.selfConfigDistributable > 0) {
      claimedConfigs.add(row.selfConfig.address.toBase58());
      row.distributions.push({
        config: row.selfConfig,
        mint: row.selfConfig.mint,
        distributable: row.selfConfigDistributable,
        userShare: shareFor(row.selfConfig, row.publicKey, row.selfConfigDistributable),
        kind: 'self',
      });
    }
  }

  if (findShares) {
    let done = 0;
    const queue = [...out.entries()];
    const worker = async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        const [, row] = next;
        try {
          // A prebuilt index answers every wallet from one read of the
          // configs; without one, fall back to probing each slot per wallet.
          const configs = shareIndex
            ? (shareIndex.get(row.publicKey.toBase58()) ?? [])
            : await findConfigsForShareholder(connection, row.publicKey, { limiter });
          const withBalances = await withVaultBalances(connection, configs);
          for (const cfg of withBalances) {
            if (cfg.distributable <= 0) continue;
            const key = cfg.address.toBase58();
            const duplicate = claimedConfigs.has(key);
            claimedConfigs.add(key);
            const userShare = shareFor(cfg, row.publicKey, cfg.distributable);
            row.sharingLamports += userShare;
            row.distributions.push({
              config: cfg,
              mint: cfg.mint,
              // A duplicate still counts toward the user's share, but must not
              // emit a second crank for the same vault.
              distributable: duplicate ? 0 : cfg.distributable,
              userShare,
              kind: 'share',
            });
          }
          row.totalLamports += row.sharingLamports;
        } catch (err) {
          row.sharingError = err.message;
        }
        onProgress?.(++done, out.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, out.length) }, worker));
  }

  return out;
}

/**
 * Every address that holds a share in anyone's sharing config, as a filter.
 *
 * Finding fees held for you in someone else's config means reading every
 * config on the chain — a flat 24 seconds however many wallets you own. Cheap
 * per wallet, but not cheap enough to do on every scan, so it sat behind a
 * flag and people who never passed it never learned the money was there.
 *
 * This is the question asked once and published: is this address a shareholder
 * anywhere at all? For almost everyone the answer is no for every wallet they
 * own, and the whole 24-second read can be skipped without asking the chain.
 * For anyone it says yes to, the full scan runs exactly as before.
 *
 * One-sided, like the creator filter, and in the same direction: a false
 * positive costs a scan that finds nothing, a false negative would hide money.
 *
 * Complete in two passes for the same reason the lookup is: the slice reaches
 * the first `INLINE_SLOTS` shareholders, and the configs holding more are
 * fetched in full afterwards rather than left half-read.
 */
export async function buildShareholderBloom(rpcEndpoint, options = {}) {
  const { bloom, connection, onProgress, fetchImpl, limiter } = options;
  const run = (fn) => (limiter ? limiter(fn) : fn());
  const overflow = [];
  let configs = 0;

  const scanned = await withRetry(
    () =>
      streamProgramAccounts(rpcEndpoint, PUMP_FEES_PROGRAM, {
        commitment: 'confirmed',
        ...(fetchImpl ? { fetchImpl } : {}),
        filters: [{ memcmp: { offset: 0, bytes: encodeBase58(SHARING_CONFIG_DISCRIMINATOR) } }],
        dataSlice: { offset: SHAREHOLDERS_OFFSET - 4, length: 4 + INLINE_SLOTS * SHAREHOLDER_SIZE },
        onAccount: ({ pubkey, data }) => {
          configs++;
          const { count, shareholders } = readShareholders(data, 0, INLINE_SLOTS);
          if (count > INLINE_SLOTS) overflow.push(new PublicKey(pubkey));
          for (const sh of shareholders) bloom.add(sh.address.toBuffer());
          if (onProgress && configs % 100000 === 0)
            onProgress({ configs, overflow: overflow.length });
        },
      }),
    { attempts: 4, baseDelayMs: 1000 },
  );

  // The tail the slice could not reach. Skipping it would drop shareholders
  // sitting past the second slot, which is the one failure this must not have.
  const tail = await fetchConfigs({ ...connection, rpcEndpoint }, overflow, run);
  for (const cfg of tail) for (const sh of cfg.shareholders) bloom.add(sh.address.toBuffer());

  onProgress?.({ configs: scanned, overflow: overflow.length, done: true });
  return { configs: scanned, overflow: overflow.length };
}
