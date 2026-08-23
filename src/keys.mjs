import { Keypair, PublicKey } from '@solana/web3.js';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import { decodeBase58 } from './base58.mjs';

/**
 * Wallet loading.
 *
 * Nothing in here ever returns, logs, or serialises a secret key. A loaded
 * wallet exposes `publicKey`, `label`, and — only when we hold the key — the
 * raw `secretKey` bytes. Watch-only entries are scannable but cannot sign, and
 * the claim path refuses them explicitly rather than failing inside a
 * signature.
 *
 * Two things here exist purely to make very large wallet sets viable:
 *
 *   1. Keypairs are never derived up front. A Solana 64-byte secret key is
 *      seed(32) || pubkey(32), so the public key is a slice rather than an
 *      ed25519 derivation — measured at ~280x cheaper. Signing keys are built
 *      on demand by `signerFor`, and only for the handful of wallets that
 *      actually end up in a transaction.
 *   2. `streamWallets` yields wallets in batches instead of returning one
 *      enormous array, so a JSONL file of any length is processed in constant
 *      memory.
 */

const shortLabel = (pk) => `${pk.slice(0, 4)}..${pk.slice(-4)}`;

/** Public key straight out of the secret key's tail — no curve maths. */
function publicKeyFromSecret(secretKey) {
  if (secretKey.length !== 64) throw new Error(`expected a 64-byte secret key, got ${secretKey.length}`);
  return new PublicKey(secretKey.slice(32, 64));
}

function toSecretBytes(secret) {
  if (secret instanceof Uint8Array) return secret;
  if (Array.isArray(secret)) return Uint8Array.from(secret);
  if (typeof secret === 'string') return decodeBase58(secret.trim());
  throw new Error('unrecognised secret key format');
}

const signingWallet = (secretKey, label) => {
  const publicKey = publicKeyFromSecret(secretKey);
  return { publicKey, label: label ?? shortLabel(publicKey.toBase58()), secretKey, watchOnly: false };
};

const watchWallet = (publicKey, label) => ({
  publicKey, label: label ?? shortLabel(publicKey.toBase58()), secretKey: null, watchOnly: true,
});

/** Normalise one entry from a wallets file into a wallet record. */
export function parseEntry(entry, index) {
  if (typeof entry === 'string' && !entry.includes(' ')) {
    const trimmed = entry.trim();
    // A bare 32-byte value is a public key; 64 bytes is a secret.
    try {
      const bytes = decodeBase58(trimmed);
      if (bytes.length === 32) return watchWallet(new PublicKey(trimmed));
      if (bytes.length === 64) return signingWallet(bytes);
    } catch { /* fall through to the explicit error below */ }
    throw new Error(`wallets[${index}] is not a 32-byte public key or a 64-byte secret key`);
  }

  if (Array.isArray(entry)) return signingWallet(toSecretBytes(entry));

  if (entry && typeof entry === 'object') {
    const secret = entry.secret ?? entry.secretKey ?? entry.privateKey;
    if (secret) return signingWallet(toSecretBytes(secret), entry.label);
    const pub = entry.pubkey ?? entry.publicKey ?? entry.address;
    if (pub) return watchWallet(new PublicKey(pub), entry.label);
  }

  throw new Error(`wallets[${index}] is not a key, keypair array, or {label, secret} object`);
}

/** Can this wallet sign, i.e. do we hold its key? */
export const canSign = (wallet) => wallet?.secretKey != null;

// Derived keys are cached so a wallet appearing in several batches is only
// ever derived once, and so a spread copy of a row still resolves to the same
// signer.
const signerCache = new Map();

/** The Keypair for a wallet, derived on first use. Throws if watch-only. */
export function signerFor(wallet) {
  if (!canSign(wallet)) throw new Error(`wallet ${wallet?.label ?? '?'} is watch-only and cannot sign`);
  const key = wallet.publicKey.toBase58();
  let kp = signerCache.get(key);
  if (!kp) {
    kp = Keypair.fromSecretKey(wallet.secretKey);
    signerCache.set(key, kp);
  }
  return kp;
}

async function* streamEntries(target) {
  const info = await stat(target).catch(() => null);
  if (!info) throw new Error(`no such wallets file or directory: ${target}`);

  if (info.isDirectory()) {
    const files = (await readdir(target)).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      const raw = JSON.parse(await readFile(path.join(target, f), 'utf8'));
      yield { entry: raw, label: path.basename(f, '.json') };
    }
    return;
  }

  // JSONL streams line by line, which is the only format that stays in
  // constant memory — JSON.parse of a giant array has to materialise it all.
  if (/\.(jsonl|ndjson)$/i.test(target)) {
    const rl = readline.createInterface({ input: createReadStream(target, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      const text = line.trim();
      if (text.length > 0) yield { entry: JSON.parse(text) };
    }
    return;
  }

  const raw = JSON.parse(await readFile(target, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.wallets;
  if (!Array.isArray(list)) throw new Error('wallets file must be a JSON array, JSONL, or an object with a "wallets" array');
  for (const entry of list) yield { entry };
}

/**
 * Yield wallets in batches.
 *
 * Deduplication defaults to OFF here on purpose. Holding a Set of every
 * address seen was measured at ~1.1KB per wallet — five times the cost of the
 * wallet records themselves, and the single thing that stopped this being
 * constant-memory. Duplicates are instead removed later, from the far smaller
 * set of wallets that actually turned out to hold fees, which is both exact
 * and free. Pass dedupe:true only when materialising a modest list.
 */
export async function* streamWallets(target, { batchSize = 1000, dedupe = false } = {}) {
  const seen = dedupe ? new Set() : null;
  let batch = [];
  let index = 0;

  for await (const { entry, label } of streamEntries(target)) {
    const wallet = parseEntry(entry, index++);
    if (label) wallet.label = label;
    if (seen) {
      const key = wallet.publicKey.toBase58();
      if (seen.has(key)) continue;
      seen.add(key);
    }
    batch.push(wallet);
    if (batch.length >= batchSize) { yield batch; batch = []; }
  }
  if (batch.length > 0) yield batch;
}

/** Collect every wallet into one array. Fine for modest sets. */
export async function loadWallets(target, options = {}) {
  const all = [];
  for await (const batch of streamWallets(target, { dedupe: true, ...options })) all.push(...batch);
  return all;
}
