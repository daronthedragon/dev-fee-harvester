/**
 * Build the static demo of the dashboard published to GitHub Pages.
 *   node scripts/build-demo.mjs
 *
 * The real dashboard is a local server that holds signing keys and talks to an
 * RPC. Neither of those can exist on a static page, so the demo is the same
 * `web/index.html` — byte for byte, no forked copy to drift — with `fetch`
 * intercepted in front of it and answered from a fixed sample.
 *
 * Building it from the real page is the point. A hand-written mockup would go
 * stale the first time the dashboard changed and nobody would notice; this one
 * breaks the build instead, because it asserts the placeholders it replaces are
 * actually there.
 *
 * It is labelled as a demo on the page itself. It reaches no chain, holds no
 * keys, and sends nothing.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'site');

const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
for (const placeholder of ['__TOKEN__', '__ALLOW_EXECUTE__']) {
  if (!html.includes(placeholder)) {
    throw new Error(
      `web/index.html no longer contains ${placeholder} — the demo shim was written ` +
        'against a page that has changed. Update scripts/build-demo.mjs to match.',
    );
  }
}

/**
 * Sample wallets. The interesting rows are the ones that are easy to get wrong
 * and therefore worth showing: a wallet blocked by error 6050, a sharing config
 * that pays a team rather than a person, and a watch-only wallet that can be
 * seen but not claimed.
 */
const WALLETS = [
  {
    label: 'dev-01',
    address: '7Yb3kQhFwXG2mCdLpRnVaJ4tZuE9sNqKxMvB6hTgWcRd',
    pump: 64488314,
    pumpswap: 0,
    total: 64488314,
    status: 'ready',
    reason: null,
    partial: false,
    watchOnly: false,
    sharing: 0,
    sharingError: null,
    distributions: [],
  },
  {
    label: 'dev-02',
    address: '3Fq8wLzNcYtR5vXhJ2bDgKmA7pSeU4nQiW9rTaHyMoVx',
    pump: 0,
    pumpswap: 1204773901,
    total: 1204773901,
    status: 'ready',
    reason: null,
    partial: false,
    watchOnly: false,
    sharing: 0,
    sharingError: null,
    distributions: [],
  },
  {
    label: 'dev-03 (team)',
    address: '9Rt2mHxKvB4nCsQaL7dYzXpE6wJfU3gTiN5oPrVbSyMc',
    pump: 0,
    pumpswap: 0,
    total: 0,
    status: 'ready',
    reason: null,
    partial: false,
    watchOnly: false,
    sharing: 2668638438,
    sharingError: null,
    distributions: [
      {
        mint: 'DzKpLmN4vQ8rXtY2bWcHgJ5aE7sU9nRfT3oViBxMqPdA',
        kind: 'distribute',
        distributable: 2668638438,
        userShare: 1334319219,
        shareholders: 2,
        blocked: null,
        unverified: null,
      },
    ],
  },
  {
    label: 'dev-04',
    address: '5Nv7cRqJ2mXtB8hLpZ4wKdSaY6eG3uT9iOfWnVbMyQxr',
    pump: 12750000,
    pumpswap: 0,
    total: 12750000,
    status: 'blocked',
    reason: 'creator fees are shared (6050) — claim through the sharing config',
    partial: false,
    watchOnly: false,
    sharing: 0,
    sharingError: null,
    distributions: [],
  },
  {
    label: 'cold-01',
    address: '2Wm9pKtY6bLxN3vRcQ8dHfJ5aZ7sE4uGiT1oXnVyBrMq',
    pump: 890880,
    pumpswap: 0,
    total: 0,
    status: 'empty',
    reason: 'nothing to claim',
    partial: false,
    watchOnly: true,
    sharing: 0,
    sharingError: null,
    distributions: [],
  },
];

const BANNER = `
    <div class="demo-banner">
      <strong>Demo.</strong> Sample data, no chain access, nothing is sent. The real
      dashboard runs locally against your own wallets and RPC —
      <a href="https://github.com/daronthedragon/dev-fee-harvester">see the README</a>.
    </div>`;

const BANNER_CSS = `
      .demo-banner {
        margin: 0 0 18px;
        padding: 10px 14px;
        border: 1px solid #3d3a1f;
        border-left: 3px solid #d4b106;
        border-radius: 6px;
        background: #241f0d;
        color: #d9d4c0;
        font-size: 13px;
        line-height: 1.5;
      }
      .demo-banner a {
        color: #d4b106;
      }`;

/**
 * Stand in for the local server. Claims are grouped the way the real packer
 * groups them — up to eight actions to a transaction — so the result table
 * shows what a real dry run shows.
 */
const SHIM = `
    <script>
      // Static demo: there is no server behind this page, so the two calls the
      // dashboard makes are answered here instead. Everything else on the page
      // is the real dashboard, unmodified.
      const DEMO_WALLETS = ${JSON.stringify(WALLETS, null, 2).replace(/\n/g, '\n      ')};
      const DEMO_PAYER = '7Yb3kQhFwXG2mCdLpRnVaJ4tZuE9sNqKxMvB6hTgWcRd';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      window.fetch = async (path, opts = {}) => {
        const reply = (status, body) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });

        if (path === '/api/scan') {
          await sleep(700);
          return reply(200, {
            payer: DEMO_PAYER,
            allowExecute: false,
            wallets: DEMO_WALLETS,
          });
        }

        if (path === '/api/claim') {
          await sleep(500);
          const wanted = new Set(JSON.parse(opts.body || '{}').addresses || []);
          const chosen = DEMO_WALLETS.filter((w) => wanted.has(w.address));
          if (chosen.length === 0) {
            return reply(400, { error: 'no known wallets in selection — rescan first' });
          }
          const results = [];
          for (let i = 0; i < chosen.length; i += 8) {
            const batch = chosen.slice(i, i + 8);
            results.push({
              label: 'tx ' + (results.length + 1),
              ok: true,
              lamports: batch.reduce(
                (n, w) =>
                  n +
                  w.total +
                  (w.distributions || []).reduce((m, d) => m + d.distributable, 0),
                0,
              ),
              wallets: batch.map((w) => w.label),
              signature: null,
              indeterminate: false,
              err: null,
            });
          }
          return reply(200, { executed: false, results });
        }

        return reply(404, { error: 'not found' });
      };
    </script>`;

let page = html.replace('__TOKEN__', 'demo').replace('__ALLOW_EXECUTE__', 'false');

// The shim must be installed before the dashboard's own script runs.
const scriptAt = page.indexOf('    <script>');
if (scriptAt === -1) throw new Error('no <script> block found in web/index.html');
page = page.slice(0, scriptAt) + SHIM.trimStart() + '\n' + page.slice(scriptAt);

// Banner, above whatever the page opens with.
const bodyAt = page.indexOf('<body>') + '<body>'.length;
page = page.slice(0, bodyAt) + BANNER + page.slice(bodyAt);
page = page.replace('</style>', BANNER_CSS + '\n    </style>');

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), page);
// Pages runs Jekyll otherwise, which drops files it does not like.
writeFileSync(join(out, '.nojekyll'), '');
console.log(`wrote site/index.html (${(page.length / 1024).toFixed(1)} KB)`);
