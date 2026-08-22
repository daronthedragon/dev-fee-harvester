import { Keypair, PublicKey } from '@solana/web3.js';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Wallet loading.
 *
 * Nothing in here ever returns, logs, or serialises a secret key. A loaded
 * wallet exposes `publicKey`, `label`, and — only when we hold the key — a
 * `keypair`. Watch-only entries are scannable but cannot sign, and the claim
 * path refuses them explicitly rather than failing deep inside a signature.
 */

const b58 = (() => {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  return {
    decode(s) {
      let n = 0n;
      for (const ch of s) {
        const i = A.indexOf(ch);
        if (i < 0) throw new Error('invalid base58 character');
        n = n * 58n + BigInt(i);
      }
      const bytes = [];
      while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
      for (const ch of s) { if (ch === '1') bytes.unshift(0); else break; }
      return Uint8Array.from(bytes);
    },
  };
})();

function fromSecret(secret) {
  if (Array.isArray(secret)) return Keypair.fromSecretKey(Uint8Array.from(secret));
  if (typeof secret === 'string') {
    const bytes = b58.decode(secret.trim());
    if (bytes.length !== 64) throw new Error(`expected a 64-byte secret key, got ${bytes.length}`);
    return Keypair.fromSecretKey(bytes);
  }
  throw new Error('unrecognised secret key format');
}

const shortLabel = (pk) => `${pk.slice(0, 4)}..${pk.slice(-4)}`;

/** Normalise one entry from a wallets file into a wallet record. */
export function parseEntry(entry, index) {
  // Watch-only: a bare public key string (32 bytes once decoded).
  if (typeof entry === 'string' && !entry.includes(' ')) {
    try {
      const bytes = b58.decode(entry.trim());
      if (bytes.length === 32) {
        const pk = new PublicKey(entry.trim());
        return { publicKey: pk, label: shortLabel(pk.toBase58()), keypair: null, watchOnly: true };
      }
    } catch { /* fall through to secret-key handling */ }
    const kp = fromSecret(entry);
    return { publicKey: kp.publicKey, label: shortLabel(kp.publicKey.toBase58()), keypair: kp, watchOnly: false };
  }

  if (Array.isArray(entry)) {
    const kp = fromSecret(entry);
    return { publicKey: kp.publicKey, label: shortLabel(kp.publicKey.toBase58()), keypair: kp, watchOnly: false };
  }

  if (entry && typeof entry === 'object') {
    if (entry.secret ?? entry.secretKey ?? entry.privateKey) {
      const kp = fromSecret(entry.secret ?? entry.secretKey ?? entry.privateKey);
      return {
        publicKey: kp.publicKey,
        label: entry.label ?? shortLabel(kp.publicKey.toBase58()),
        keypair: kp,
        watchOnly: false,
      };
    }
    if (entry.pubkey ?? entry.publicKey ?? entry.address) {
      const pk = new PublicKey(entry.pubkey ?? entry.publicKey ?? entry.address);
      return { publicKey: pk, label: entry.label ?? shortLabel(pk.toBase58()), keypair: null, watchOnly: true };
    }
  }

  throw new Error(`wallets[${index}] is not a key, keypair array, or {label, secret} object`);
}

/**
 * Load wallets from either a JSON file (array of entries) or a directory of
 * Solana CLI keypair files.
 */
export async function loadWallets(target) {
  const info = await stat(target).catch(() => null);
  if (!info) throw new Error(`no such wallets file or directory: ${target}`);

  const wallets = [];
  if (info.isDirectory()) {
    const files = (await readdir(target)).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      const raw = JSON.parse(await readFile(path.join(target, f), 'utf8'));
      const w = parseEntry(raw, f);
      wallets.push({ ...w, label: path.basename(f, '.json') });
    }
  } else {
    const raw = JSON.parse(await readFile(target, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.wallets;
    if (!Array.isArray(list)) throw new Error('wallets file must be a JSON array, or an object with a "wallets" array');
    list.forEach((e, i) => wallets.push(parseEntry(e, i)));
  }

  // Duplicate keys would double-count claimable totals and waste a signature.
  const seen = new Map();
  return wallets.filter((w) => {
    const k = w.publicKey.toBase58();
    if (seen.has(k)) return false;
    seen.set(k, true);
    return true;
  });
}
