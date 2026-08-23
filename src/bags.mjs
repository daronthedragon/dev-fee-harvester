import { Transaction } from '@solana/web3.js';
import { decodeBase58 } from './base58.mjs';
import { canSign, signerFor } from './keys.mjs';

/**
 * Bags (bags.fm) fee claiming.
 *
 * Bags does not expose a single on-chain instruction we can build ourselves —
 * a position may be a Meteora virtual pool, a DAMM v2 position, or one of two
 * generations of custom fee vault, and their API decides which. So unlike the
 * pump.fun path, here we ask Bags to build the transactions and sign them
 * locally. The private key never leaves this machine; only public keys go over
 * the wire, and what comes back is unsigned.
 *
 * Every detail below — base URL, header, response envelope, request field
 * names, transaction encoding — was read out of the official @bagsfm/bags-sdk
 * package rather than inferred from prose. Three of them are easy to get wrong
 * from the documentation alone, and all three were wrong here before:
 *
 *   - the claim request field is `feeClaimer`, not `wallet`
 *   - transactions come back base58 encoded, not base64
 *   - they are legacy Transactions, not VersionedTransactions
 */

export const BAGS_DEFAULT_BASE_URL = 'https://public-api-v2.bags.fm/api/v1';

export class BagsApiError extends Error {
  constructor(message, { status, path, body } = {}) {
    super(message);
    this.name = 'BagsApiError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export class BagsClient {
  constructor({
    apiKey,
    baseUrl = BAGS_DEFAULT_BASE_URL,
    fetchImpl = fetch,
    timeoutMs = 60000,
  } = {}) {
    if (!apiKey) throw new Error('BAGS_API_KEY is required for the Bags adapter');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Bags wraps every reply as {success, response, error}. A failure can arrive
   * with a 200, so the envelope is authoritative rather than the status code.
   */
  async #request(path, init = {}) {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'x-api-key': this.apiKey,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new BagsApiError(
        `bags ${path} returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`,
        { status: res.status, path },
      );
    }

    if (body && typeof body === 'object' && body.success === false) {
      throw new BagsApiError(body.error ?? `bags ${path} failed`, {
        status: res.status,
        path,
        body,
      });
    }
    if (!res.ok) {
      throw new BagsApiError(body?.error ?? body?.message ?? `bags ${path} -> HTTP ${res.status}`, {
        status: res.status,
        path,
        body,
      });
    }
    return body?.response ?? body;
  }

  /** Every position with claimable fees for one wallet. */
  async claimablePositions(walletPublicKey) {
    const params = new URLSearchParams({ wallet: walletPublicKey.toBase58() });
    const list = await this.#request(`/token-launch/claimable-positions?${params}`);
    return Array.isArray(list) ? list : [];
  }

  /**
   * Total claimable lamports for one wallet.
   *
   * `totalClaimableLamportsUserShare` appears on every position variant and is
   * already this wallet's share, so it must not be scaled by bps again.
   */
  async claimableLamports(walletPublicKey) {
    const positions = await this.claimablePositions(walletPublicKey);
    return positions.reduce((n, p) => n + Number(p.totalClaimableLamportsUserShare ?? 0), 0);
  }

  /** Ask Bags to build the claim transactions for one wallet and mint. */
  async claimTransactions(walletPublicKey, tokenMint) {
    const list = await this.#request('/token-launch/claim-txs/v3', {
      method: 'POST',
      body: JSON.stringify({
        feeClaimer: walletPublicKey.toBase58(),
        tokenMint: typeof tokenMint === 'string' ? tokenMint : tokenMint.toBase58(),
      }),
    });
    return (Array.isArray(list) ? list : []).map((entry) => {
      const encoded = typeof entry === 'string' ? entry : entry?.tx;
      if (!encoded)
        throw new BagsApiError('bags claim-txs entry had no "tx" field', { body: entry });
      return Transaction.from(Buffer.from(decodeBase58(encoded)));
    });
  }
}

/** The mint a position refers to, across every position variant. */
export const positionMint = (position) => position?.baseMint ?? position?.tokenMint ?? null;

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
        out[i] = {
          ...w,
          bagsLamports: await client.claimableLamports(w.publicKey),
          bagsError: null,
        };
      } catch (err) {
        // Recorded, never swallowed: a failed lookup must not read as "no fees".
        out[i] = { ...w, bagsLamports: 0, bagsError: err.message };
      }
      onProgress?.(++done, wallets.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, wallets.length) }, worker));
  return out;
}

/**
 * Sign and send (or simulate) whatever Bags handed back.
 *
 * These are legacy transactions built server-side, so they normally arrive
 * with a fee payer and blockhash already set. Both are filled in only when
 * missing, because overwriting them would invalidate any signature Bags has
 * already applied.
 */
export async function claimBags(
  connection,
  client,
  rows,
  { dryRun = true, onEvent = () => {} } = {},
) {
  const results = [];

  for (const row of rows) {
    if (!canSign(row)) {
      results.push({ label: row.label, ok: false, err: 'watch-only wallet cannot sign' });
      continue;
    }

    let positions;
    try {
      positions = await client.claimablePositions(row.publicKey);
    } catch (err) {
      results.push({ label: row.label, ok: false, err: err.message });
      continue;
    }

    for (const position of positions) {
      const mint = positionMint(position);
      const lamports = Number(position.totalClaimableLamportsUserShare ?? 0);
      if (!mint || lamports <= 0) continue;

      try {
        const txs = await client.claimTransactions(row.publicKey, mint);
        for (const tx of txs) {
          if (!tx.feePayer) tx.feePayer = row.publicKey;
          if (!tx.recentBlockhash) {
            tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
          }
          tx.partialSign(signerFor(row));

          if (dryRun) {
            const sim = await connection.simulateTransaction(tx);
            results.push({
              label: row.label,
              mint,
              lamports,
              simulated: true,
              ok: sim.value.err === null,
              err: sim.value.err,
              logs: sim.value.logs,
            });
          } else {
            const signature = await connection.sendRawTransaction(tx.serialize(), {
              maxRetries: 5,
            });
            await connection.confirmTransaction(signature, 'confirmed');
            results.push({ label: row.label, mint, lamports, ok: true, signature });
          }
          onEvent({ type: 'bags', label: row.label, mint, lamports });
        }
      } catch (err) {
        results.push({ label: row.label, mint, lamports, ok: false, err: err.message });
      }
    }
  }
  return results;
}
