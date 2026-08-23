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
import { createLimiter, delay } from './limit.mjs';

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
export const SHAREHOLDER_SLOTS = Math.floor((SHARING_CONFIG_SIZE - SHAREHOLDERS_OFFSET) / SHAREHOLDER_SIZE);

/** True when this account really is a SharingConfig owned by pump_fees. */
export function isSharingConfig(info) {
  return Boolean(info)
    && info.owner.equals(PUMP_FEES_PROGRAM)
    && info.data.length >= SHAREHOLDERS_OFFSET + 4
    && info.data.subarray(0, 8).equals(Buffer.from(SHARING_CONFIG_DISCRIMINATOR));
}

export function decodeSharingConfig(address, data) {
  const count = data.readUInt32LE(SHAREHOLDERS_OFFSET - 4);
  const shareholders = [];
  for (let i = 0; i < count; i++) {
    const o = SHAREHOLDERS_OFFSET + i * SHAREHOLDER_SIZE;
    if (o + SHAREHOLDER_SIZE > data.length) break;
    shareholders.push({ address: new PublicKey(data.subarray(o, o + 32)), bps: data.readUInt16LE(o + 32) });
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
  return vaultLamports > SYSTEM_ACCOUNT_RENT_LAMPORTS ? vaultLamports - SYSTEM_ACCOUNT_RENT_LAMPORTS : 0;
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
  const { slots = SHAREHOLDER_SLOTS, concurrency = 6, attempts = 6, baseDelayMs = 500, limiter } = options;
  const discFilter = { memcmp: { offset: 0, bytes: encodeBase58(SHARING_CONFIG_DISCRIMINATOR) } };

  const querySlot = async (i) => {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await connection.getProgramAccounts(PUMP_FEES_PROGRAM, {
          commitment: 'confirmed',
          filters: [discFilter, { memcmp: { offset: SHAREHOLDERS_OFFSET + i * SHAREHOLDER_SIZE, bytes: wallet.toBase58() } }],
        });
      } catch (err) {
        lastError = err;
        await delay(baseDelayMs * 2 ** attempt);
      }
    }
    // Never swallow this. A rate-limited slot that quietly returns nothing
    // reads as "no fees here", which is the one wrong answer that costs money.
    throw new Error(`shareholder slot ${i} failed after ${attempts} attempts: ${lastError?.message ?? 'unknown'}`);
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

/** Attach live vault balances to a set of configs. Module-internal. */
async function withVaultBalances(connection, configs) {
  if (configs.length === 0) return [];
  const vaults = configs.map((cfg) => pumpCreatorVault(cfg.address));
  const infos = [];
  for (let i = 0; i < vaults.length; i += 100) {
    infos.push(...await connection.getMultipleAccountsInfo(vaults.slice(i, i + 100)));
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
export async function attachDistributions(connection, rows, { findShares = false, concurrency = 2, onProgress, limiter } = {}) {
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
          const configs = await findConfigsForShareholder(connection, row.publicKey, { limiter });
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
