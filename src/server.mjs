import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Connection, PublicKey } from '@solana/web3.js';
import { claimAll, isActionable } from './claim.mjs';
import { c, sol } from './format.mjs';
import { canSign, loadWallets } from './keys.mjs';
import { preflight } from './preflight.mjs';
import { scanWallets } from './scan.mjs';
import { attachDistributions } from './sharing.mjs';

/**
 * Local dashboard.
 *
 * This process holds signing keys, so the server binds to 127.0.0.1 only and
 * every API call must carry a token minted at startup. That stops any other
 * page in the browser (or another process on the box) from driving a claim
 * just because the port happens to be open.
 */
export async function startDashboard({ walletsPath, rpc, port = 4600, allowExecute = false, findShares = false }) {
  const token = randomBytes(24).toString('hex');
  const connection = new Connection(rpc, 'confirmed');
  const wallets = await loadWallets(walletsPath);
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');

  let cache = [];

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html.replace('__TOKEN__', token).replace('__ALLOW_EXECUTE__', String(allowExecute)));
    }

    // Everything below is privileged.
    if (url.searchParams.get('token') !== token && req.headers['x-token'] !== token) {
      return json(res, 403, { error: 'bad or missing token' });
    }

    try {
      if (url.pathname === '/api/scan') {
        const scanned = await attachDistributions(connection, await scanWallets(connection, wallets), {
          findShares: findShares || url.searchParams.get('shares') === '1',
        });
        // Same rule as the CLI: richest signer pays; a watch-only set still
        // scans, it just cannot claim.
        const byBalance = (a, b) => (b.walletLamports ?? 0) - (a.walletLamports ?? 0);
        const signers = scanned.filter(canSign).sort(byBalance);
        const payer = signers[0] ?? [...scanned].sort(byBalance)[0];
        if (!payer) return json(res, 400, { error: 'no wallets loaded' });
        const withFees = scanned.filter(isActionable);
        const checked = await preflight(connection, withFees, payer.publicKey);
        const byKey = new Map(checked.map((r) => [r.publicKey.toBase58(), r]));
        cache = scanned.map((r) => byKey.get(r.publicKey.toBase58()) ?? { ...r, status: 'empty', reason: 'nothing to claim' });
        return json(res, 200, {
          payer: payer.publicKey.toBase58(),
          allowExecute,
          wallets: cache.map((r) => ({
            label: r.label,
            address: r.publicKey.toBase58(),
            pump: r.pumpLamports,
            pumpswap: r.pumpswapLamports,
            sharing: r.sharingLamports ?? 0,
            total: r.totalLamports,
            status: r.status ?? 'ready',
            reason: r.reason ?? null,
            partial: Boolean(r.partial),
            watchOnly: r.watchOnly,
            sharingError: r.sharingError ?? null,
            distributions: (r.distributions ?? []).map((d) => ({
              mint: d.mint.toBase58(),
              kind: d.kind,
              distributable: d.distributable,
              userShare: d.userShare,
              shareholders: d.config.shareholders.length,
              blocked: d.blocked ?? null,
            })),
          })),
        });
      }

      if (url.pathname === '/api/claim' && req.method === 'POST') {
        const body = await readBody(req);
        const wanted = new Set(body.addresses ?? []);
        const chosen = cache.filter((r) => wanted.has(r.publicKey.toBase58()));
        if (chosen.length === 0) return json(res, 400, { error: 'no known wallets in selection — rescan first' });

        const execute = Boolean(body.execute) && allowExecute;
        // Dry runs need no key, so fall back to the richest wallet; only a
        // real send requires a signer, and claimAll enforces that itself.
        const byBal = (a, b) => (b.walletLamports ?? 0) - (a.walletLamports ?? 0);
        const payer = cache.filter(canSign).sort(byBal)[0] ?? [...cache].sort(byBal)[0];
        if (!payer) return json(res, 400, { error: 'no wallets loaded' });
        const results = await claimAll(connection, chosen, payer, {
          dryRun: !execute,
          computeUnitPrice: Number(body.priorityFee ?? 0),
          maxPerTx: Number(body.maxPerTx ?? 8),
        });
        return json(res, 200, {
          executed: execute,
          results: results.map((r) => ({
            label: r.label, ok: r.ok, lamports: r.lamports, wallets: r.wallets,
            signature: r.signature ?? null, err: r.err ? String(JSON.stringify(r.err)).slice(0, 300) : null,
          })),
        });
      }
    } catch (err) {
      return json(res, 500, { error: err.message });
    }

    return json(res, 404, { error: 'not found' });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const link = `http://127.0.0.1:${port}/?token=${token}`;
  console.log(`${c.bold('dashboard')} ${c.cyan(link)}`);
  console.log(c.dim(`${wallets.length} wallet(s) loaded · ${execLabel(allowExecute)}`));
  return { server, url: link, token };
}

const execLabel = (allow) =>
  allow ? 'EXECUTE ENABLED — claims will be sent for real' : 'dry-run only (restart with --execute to send)';
