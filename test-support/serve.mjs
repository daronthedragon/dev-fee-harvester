import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { TEST_TOKEN } from './fixtures.mjs';

/**
 * Serve the real dashboard page with a stubbed API behind it.
 *
 * The same file the dashboard serves, with the same placeholders substituted,
 * so a browser loads exactly the markup, CSS and script that ship. Only the
 * API is fake, which keeps the tests hermetic — no RPC, no wallets, no keys.
 */
export async function serveDashboard({ wallets = [], allowExecute = false, claimResult } = {}) {
  const html = (await readFile(new URL('../web/index.html', import.meta.url), 'utf8'))
    .replace('__TOKEN__', TEST_TOKEN)
    .replace('__ALLOW_EXECUTE__', String(allowExecute));

  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    let body = null;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    }
    calls.push({ path: url.pathname, token: req.headers['x-token'], body });

    const payload = url.pathname === '/api/scan'
      ? { payer: 'PayerPubkey', allowExecute, wallets }
      : (claimResult ?? { executed: false, results: [] });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(payload));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/?token=${TEST_TOKEN}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
