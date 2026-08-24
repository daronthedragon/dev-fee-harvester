import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { delay } from '../src/limit.mjs';

/**
 * DOM tests for the dashboard.
 *
 * The page is loaded and run exactly as the server serves it — the same file,
 * with the same placeholders substituted — so these exercise the real markup
 * and the real script rather than a copy of its logic. Only `fetch` is
 * stubbed, standing in for the local API.
 *
 * This suite exists because two bugs reached the published README before it
 * did: "hide empty" hid sharing rows whose own balance is zero, and the
 * README described an expand/collapse that had never been built.
 */
const HTML = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');

const TOKEN = 'test-token';

/** A wallet with a claimable balance of its own. */
const directWallet = (over = {}) => ({
  label: 'dev-04',
  address: '3z4vj1nAujLnciPgZaGz4VYecZa6gbYUg3Yr9MoyuiMG',
  pump: 1_049_487_000,
  pumpswap: 0,
  sharing: 0,
  total: 1_049_487_000,
  status: 'ready',
  reason: null,
  partial: false,
  watchOnly: true,
  sharingError: null,
  distributions: [],
  ...over,
});

/**
 * A wallet that holds shares in other creators' configs. Its own total is
 * zero — the money lives in vaults it does not own.
 */
const shareWallet = (count = 14, over = {}) => ({
  label: 'dev-share',
  address: '5bQMLqKtmiGzLba11rwD6eLutqdWD7L3WC8Rt1V5dw4J',
  pump: 0,
  pumpswap: 0,
  sharing: 3_726_735_000,
  total: 3_726_735_000,
  status: 'ready',
  reason: null,
  partial: false,
  watchOnly: true,
  sharingError: null,
  distributions: Array.from({ length: count }, (_, i) => ({
    mint: `Mint${String(i).padStart(40, 'x')}`,
    kind: 'share',
    distributable: 100_000_000,
    userShare: 50_000_000,
    shareholders: 2,
    blocked: null,
    unverified: null,
  })),
  ...over,
});

const emptyWallet = (over = {}) => ({
  label: 'cold-01',
  address: 'SysvarC1ock11111111111111111111111111111111',
  pump: 0,
  pumpswap: 0,
  sharing: 0,
  total: 0,
  status: 'empty',
  reason: 'nothing to claim',
  partial: false,
  watchOnly: true,
  sharingError: null,
  distributions: [],
  ...over,
});

const waitFor = async (fn, what = 'condition', tries = 200) => {
  for (let i = 0; i < tries; i++) {
    const value = fn();
    if (value) return value;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** Load the real page with a stubbed API behind it. */
async function mount({ wallets = [], allowExecute = false, claimResult } = {}) {
  const calls = [];
  const html = HTML.replace('__TOKEN__', TOKEN).replace('__ALLOW_EXECUTE__', String(allowExecute));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1:4600/',
    beforeParse(window) {
      window.confirm = () => true;
      window.fetch = async (path, opts = {}) => {
        calls.push({ path, opts, body: opts.body ? JSON.parse(opts.body) : null });
        const body = path.includes('/api/scan')
          ? { payer: 'PayerPubkey', allowExecute, wallets }
          : (claimResult ?? { executed: false, results: [] });
        return { ok: true, statusText: 'OK', json: async () => body };
      };
    },
  });

  const { document } = dom.window;
  if (wallets.length > 0)
    await waitFor(() => document.querySelectorAll('#rows tr').length > 0, 'rows');
  return { dom, window: dom.window, document, calls };
}

const $ = (doc, sel) => doc.querySelector(sel);
const rowsOf = (doc) => [...doc.querySelectorAll('#rows tr')];
const walletRows = (doc) => rowsOf(doc).filter((r) => !r.classList.contains('sub'));
const subRows = (doc) => rowsOf(doc).filter((r) => r.classList.contains('sub'));
const totalText = (doc) =>
  `${$(doc, '#selTotal').textContent} / ${$(doc, '#selCount').textContent}`;

/* ------------------------------------------------------------ rendering -- */

test('a wallet is rendered per scanned row', async () => {
  const { document } = await mount({ wallets: [directWallet(), shareWallet(2)] });
  assert.equal(walletRows(document).length, 2);
  assert.match(document.body.textContent, /dev-04/);
  assert.match(document.body.textContent, /dev-share/);
});

test('the meta line reports the payer and the claimable total', async () => {
  const { document } = await mount({ wallets: [directWallet()] });
  const meta = $(document, '#meta').textContent;
  assert.match(meta, /1 wallets/);
  assert.match(meta, /PayerPub/);
  assert.match(meta, /1\.049487 SOL claimable/);
});

test('"hide empty" hides a wallet with nothing to do', async () => {
  const { document } = await mount({ wallets: [directWallet(), emptyWallet()] });
  assert.equal(walletRows(document).length, 1);
  assert.doesNotMatch(document.body.textContent, /cold-01/);
});

test('"hide empty" keeps a wallet whose only value is a crank', async () => {
  // Regression: a sharing row's own total is zero, so filtering on total
  // hid exactly the rows worth the most.
  const { document } = await mount({ wallets: [shareWallet(3, { total: 0, sharing: 0 })] });
  assert.equal(walletRows(document).length, 1, 'the crank row survives the filter');
  assert.match(document.body.textContent, /dev-share/);
});

test('unticking "hide empty" reveals the empty wallets', async () => {
  const { document } = await mount({ wallets: [directWallet(), emptyWallet()] });
  const box = $(document, '#hideEmpty');
  box.checked = false;
  box.dispatchEvent(new document.defaultView.Event('change'));
  assert.equal(walletRows(document).length, 2);
});

/* ------------------------------------------------------------ disclosure -- */

test('shares are collapsed behind a summary by default', async () => {
  const { document } = await mount({ wallets: [shareWallet(14)] });
  const subs = subRows(document);
  assert.equal(subs.length, 1, 'only the summary row, not fourteen share rows');
  const disc = $(document, '.disc');
  assert.match(disc.textContent, /14 shares/);
  assert.match(disc.textContent, /1\.400000/, 'summarises what the whole set releases');
  assert.equal(disc.getAttribute('aria-expanded'), 'false');
});

test('clicking the summary expands every share', async () => {
  const { document } = await mount({ wallets: [shareWallet(14)] });
  $(document, '.disc').click();
  assert.equal(subRows(document).length, 15, 'summary plus fourteen shares');
  assert.equal($(document, '.disc').getAttribute('aria-expanded'), 'true');
});

test('clicking again collapses it', async () => {
  const { document } = await mount({ wallets: [shareWallet(14)] });
  $(document, '.disc').click();
  $(document, '.disc').click();
  assert.equal(subRows(document).length, 1);
  assert.equal($(document, '.disc').getAttribute('aria-expanded'), 'false');
});

test('an expanded share shows what it releases and what you receive', async () => {
  const { document } = await mount({ wallets: [shareWallet(1)] });
  $(document, '.disc').click();
  const detail = subRows(document)[1].textContent;
  assert.match(detail, /crank/);
  assert.match(detail, /0\.100000/, 'the amount the crank releases');
  assert.match(detail, /you receive 0\.050000 SOL/, 'and this wallet’s cut of it');
});

test('a blocked share shows the reason instead of an amount', async () => {
  const wallets = [shareWallet(1)];
  wallets[0].distributions[0].blocked = 'SharingConfigNotActive';
  const { document } = await mount({ wallets });
  $(document, '.disc').click();
  assert.match(subRows(document)[1].textContent, /SharingConfigNotActive/);
});

test('a share whose check never ran is distinguished from a rejected one', async () => {
  const wallets = [shareWallet(1)];
  wallets[0].distributions[0].unverified = 'could not verify — 429 Too Many Requests';
  const { document } = await mount({ wallets });
  $(document, '.disc').click();
  assert.match(subRows(document)[1].textContent, /could not verify/);
});

test('two wallets expand independently', async () => {
  const other = shareWallet(3, {
    label: 'dev-two',
    address: 'AnotherAddress1111111111111111111111111111',
  });
  const { document } = await mount({ wallets: [shareWallet(14), other] });
  const discs = [...document.querySelectorAll('.disc')];
  assert.equal(discs.length, 2);
  discs[1].click();
  assert.equal(subRows(document).length, 2 + 3, 'only the second wallet opened');
});

/* -------------------------------------------------------------- selection -- */

test('claimable wallets are pre-selected and totalled', async () => {
  const { document } = await mount({ wallets: [directWallet(), shareWallet(2)] });
  assert.equal(totalText(document), '4.776222 / 2');
});

test('select none clears the selection', async () => {
  const { document } = await mount({ wallets: [directWallet()] });
  $(document, '#none').click();
  assert.equal(totalText(document), '0.000000 / 0');
});

test('select all re-selects every claimable wallet', async () => {
  const { document } = await mount({ wallets: [directWallet(), shareWallet(2)] });
  $(document, '#none').click();
  $(document, '#all').click();
  assert.equal(totalText(document), '4.776222 / 2');
});

test('an empty wallet is never selected by "select claimable"', async () => {
  const { document } = await mount({ wallets: [directWallet(), emptyWallet()] });
  $(document, '#ready').click();
  assert.equal(totalText(document), '1.049487 / 1');
});

test('a blocked wallet cannot be ticked', async () => {
  const blocked = directWallet({ status: 'blocked', reason: 'UnableToDistribute…' });
  const { document } = await mount({ wallets: [blocked] });
  const box = walletRows(document)[0].querySelector('input');
  assert.ok(box.disabled, 'its checkbox is disabled');
  assert.equal(totalText(document), '0.000000 / 0');
});

test('ticking a single row updates the running total', async () => {
  const { document } = await mount({ wallets: [directWallet(), shareWallet(2)] });
  $(document, '#none').click();
  const box = walletRows(document)[0].querySelector('input');
  box.click();
  assert.equal(totalText(document), '1.049487 / 1');
});

/* ------------------------------------------------------------------ claim -- */

test('Simulate posts exactly the selected addresses', async () => {
  const { document, calls } = await mount({ wallets: [directWallet(), shareWallet(2)] });
  $(document, '#none').click();
  walletRows(document)[1].querySelector('input').click();
  $(document, '#dry').click();

  const claim = await waitFor(() => calls.find((c) => c.path.includes('/api/claim')), 'claim call');
  assert.deepEqual(claim.body.addresses, [shareWallet().address]);
  assert.equal(claim.body.execute, false, 'the Simulate button never executes');
});

test('the API token is sent on every request', async () => {
  const { calls } = await mount({ wallets: [directWallet()] });
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => c.opts.headers['x-token'] === TOKEN));
});

test('"Claim for real" stays disabled without --execute', async () => {
  const { document } = await mount({ wallets: [directWallet()], allowExecute: false });
  assert.ok($(document, '#exec').disabled);
  assert.match($(document, '#mode').textContent, /Dry-run mode/);
});

test('"Claim for real" is available when the server allows it', async () => {
  const { document } = await mount({ wallets: [directWallet()], allowExecute: true });
  assert.ok(!$(document, '#exec').disabled);
  assert.equal($(document, '#mode').textContent.trim(), '');
});

test('claim results are listed with their outcome', async () => {
  const claimResult = {
    executed: false,
    results: [
      {
        label: 'batch 1/1 (2 actions)',
        ok: true,
        lamports: 4_776_222_000,
        wallets: ['dev-04'],
        signature: null,
        err: null,
      },
    ],
  };
  const { document } = await mount({ wallets: [directWallet()], claimResult });
  $(document, '#dry').click();
  await waitFor(() => $(document, '#log').textContent.includes('batch 1/1'), 'results');
  const log = $(document, '#log').textContent;
  assert.match(log, /Simulated/);
  assert.match(log, /4\.776222 SOL/);
});

test('a failed batch is shown as failed, with its reason', async () => {
  const claimResult = {
    executed: false,
    results: [
      {
        label: 'batch 1/1',
        ok: false,
        lamports: 0,
        wallets: ['dev-04'],
        signature: null,
        err: '"AccountNotFound"',
      },
    ],
  };
  const { document } = await mount({ wallets: [directWallet()], claimResult });
  $(document, '#dry').click();
  await waitFor(() => $(document, '#log').textContent.includes('failed'), 'failure');
  assert.match($(document, '#log').textContent, /AccountNotFound/);
});

test('a batch with an unknown outcome is not shown as a plain failure', async () => {
  // Not confirmed and not disproved: this transaction may have claimed. Styled
  // like every other failure, someone re-runs and claims twice.
  const claimResult = {
    executed: true,
    results: [
      {
        label: 'batch 1/1',
        ok: false,
        indeterminate: true,
        lamports: 1_049_487_000,
        wallets: ['dev-04'],
        signature: '5xoT9pQnFakeSignatureForTheDomTestOnly11111111111111111111111111',
        err: '"could not determine the outcome"',
      },
    ],
  };
  const { document } = await mount({ wallets: [directWallet()], claimResult, allowExecute: true });
  $(document, '#dry').click();
  await waitFor(() => $(document, '#log').textContent.includes('batch 1/1'), 'results');

  const row = $(document, '#log .row.check');
  assert.ok(row, 'an indeterminate batch needs its own state, not .fail');
  assert.equal($(document, '#log .row.fail'), null, 'it must not also read as a failure');
  assert.match(row.textContent, /may have claimed/i, 'it has to say why it needs a look');
  assert.ok(
    $(document, '#log a[href*="solscan.io/tx/"]'),
    'the signature must be linked — it is the only way to check',
  );
});

/* ---------------------------------------------------------------- warning -- */

test('an incomplete shareholder scan is surfaced, not silently ignored', async () => {
  // A rate-limited sweep reporting zero would read as "no fees owed".
  const wallets = [
    directWallet({ sharingError: 'shareholder slot 3 failed after 6 attempts: 429' }),
  ];
  const { document } = await mount({ wallets });
  const warning = $(document, '.scanfail');
  assert.ok(warning, 'the failure is rendered');
  assert.match(warning.textContent, /may understate/);
});

test('a watch-only wallet is labelled as such', async () => {
  const { document } = await mount({ wallets: [directWallet({ watchOnly: true })] });
  assert.match(walletRows(document)[0].textContent, /watch-only/);
});
