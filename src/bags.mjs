import { VersionedTransaction } from '@solana/web3.js';
import { canSign, signerFor } from './keys.mjs';

/**
 * Bags (bags.fm) fee claiming. EXPERIMENTAL.
 *
 * This has never been exercised against the live Bags API — it was written
 * from their published docs, with no API key to check it against. The
 * endpoint paths, the response field names, and the shape of the returned
 * transactions are all unconfirmed. Opt-in behind --bags; see the README.
 *
 * Bags does not expose a single on-chain instruction we can build ourselves —
 * a position may be a Meteora virtual pool, a DAMM v2 position, or a custom
 * fee vault, and their API decides which. So unlike the pump.fun path, here we
 * ask Bags to build the transactions and we sign them locally. The private key
 * never leaves this machine; only public keys go over the wire.
 *
 * Endpoints per https://docs.bags.fm — base and version are overridable because
 * they have already moved once (claim-txs v2 -> v3).
 */
export class BagsClient {
  constructor({ apiKey, baseUrl = 'https://public-api-v2.bags.fm/api/v1', claimVersion = 'v3', fetchImpl = fetch } = {}) {
    if (!apiKey) throw new Error('BAGS_API_KEY is required for the Bags adapter');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.claimVersion = claimVersion;
    this.fetch = fetchImpl;
  }

  async #request(path, init = {}) {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`bags ${path} -> ${res.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { throw new Error(`bags ${path} returned non-JSON: ${text.slice(0, 200)}`); }
  }

  /** All positions with claimable fees for one wallet. */
  async claimablePositions(walletPublicKey) {
    const body = await this.#request(`/token-launch/claimable-positions?wallet=${walletPublicKey.toBase58()}`);
    const list = body?.response ?? body?.data ?? body;
    return Array.isArray(list) ? list : [];
  }

  /** Total claimable lamports for one wallet, summed across positions. */
  async claimableLamports(walletPublicKey) {
    const positions = await this.claimablePositions(walletPublicKey);
    return positions.reduce((n, p) => n + Number(p.totalClaimableLamportsUserShare ?? p.claimableLamports ?? 0), 0);
  }

  /** Ask Bags to build the claim transactions for one wallet + mint. */
  async claimTransactions(walletPublicKey, tokenMint) {
    const body = await this.#request(`/token-launch/claim-txs/${this.claimVersion}`, {
      method: 'POST',
      body: JSON.stringify({ wallet: walletPublicKey.toBase58(), tokenMint: String(tokenMint) }),
    });
    const list = body?.response ?? body?.data ?? body;
    return (Array.isArray(list) ? list : []).map((tx) =>
      VersionedTransaction.deserialize(Buffer.from(typeof tx === 'string' ? tx : tx.transaction, 'base64')));
  }
}

/** Scan many wallets for Bags-claimable fees, bounded concurrency. */
export async function scanBags(client, wallets, { concurrency = 4, onProgress } = {}) {
  const out = new Array(wallets.length);
  const queue = [...wallets.entries()];
  let done = 0;
  async function worker() {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const [i, w] = next;
      try {
        out[i] = { ...w, bagsLamports: await client.claimableLamports(w.publicKey), bagsError: null };
      } catch (err) {
        out[i] = { ...w, bagsLamports: 0, bagsError: err.message };
      }
      onProgress?.(++done, wallets.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, wallets.length) }, worker));
  return out;
}

/** Sign and send whatever Bags handed back for the selected wallets. */
export async function claimBags(connection, client, rows, { dryRun = true, onEvent = () => {} } = {}) {
  const results = [];
  for (const row of rows) {
    if (!canSign(row)) { results.push({ label: row.label, ok: false, err: 'watch-only wallet cannot sign' }); continue; }
    try {
      const positions = await client.claimablePositions(row.publicKey);
      for (const pos of positions) {
        const mint = pos.baseMint ?? pos.tokenMint;
        const txs = await client.claimTransactions(row.publicKey, mint);
        for (const tx of txs) {
          tx.sign([signerFor(row)]);
          if (dryRun) {
            const sim = await connection.simulateTransaction(tx, { replaceRecentBlockhash: true, sigVerify: false });
            results.push({ label: row.label, mint, ok: sim.value.err === null, err: sim.value.err, simulated: true });
          } else {
            const signature = await connection.sendTransaction(tx, { maxRetries: 5 });
            await connection.confirmTransaction(signature, 'confirmed');
            results.push({ label: row.label, mint, ok: true, signature });
          }
          onEvent({ type: 'bags', label: row.label, mint });
        }
      }
    } catch (err) {
      results.push({ label: row.label, ok: false, err: err.message });
    }
  }
  return results;
}
