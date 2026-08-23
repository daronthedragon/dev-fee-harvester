import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { directWallet, emptyWallet, shareWallet } from './helpers/fixtures.mjs';
import { serveDashboard } from './helpers/serve.mjs';

/**
 * Browser tests for the dashboard.
 *
 * jsdom covers structure and event wiring but has no layout engine and no CSS,
 * so it cannot see the things this file is for: whether the page overflows,
 * whether the toolbar wraps, whether the theme actually applies, whether a
 * keyboard alone can work the disclosure. One of those — the toolbar wrapping
 * at narrow widths — was found by eye while recording a demo, which is not a
 * way to find layout bugs.
 *
 * The browser is whatever Chromium-based one is already installed; nothing is
 * downloaded. With none available these skip rather than fail, so `npm test`
 * stays green on a machine without one.
 */
async function findBrowser() {
  // An explicit opt-out, for CI that does not want to run a browser at all.
  if (process.env.NO_BROWSER_TESTS) return null;

  const explicit = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (explicit) {
    // Set deliberately, so a failure here is a real error rather than a
    // reason to quietly skip.
    try {
      return await chromium.launch({ executablePath: explicit });
    } catch (err) {
      throw new Error(`PLAYWRIGHT_EXECUTABLE_PATH is set but would not launch: ${err.message}`);
    }
  }
  for (const channel of [process.env.PLAYWRIGHT_CHANNEL, 'msedge', 'chrome', 'chromium'].filter(Boolean)) {
    try { return await chromium.launch({ channel }); } catch { /* try the next one */ }
  }
  try { return await chromium.launch(); } catch { return null; }
}

const browser = await findBrowser();
const skip = browser
  ? false
  : (process.env.NO_BROWSER_TESTS
    ? 'browser tests disabled by NO_BROWSER_TESTS'
    : 'no Chromium-based browser found — install Edge or Chrome, or set PLAYWRIGHT_EXECUTABLE_PATH');

test.after(async () => { await browser?.close(); });

/** Open the dashboard in a real page, with the API stubbed. */
async function open(options = {}, { width = 1280, height = 900, colorScheme = 'dark' } = {}) {
  const site = await serveDashboard(options);
  const context = await browser.newContext({ viewport: { width, height }, colorScheme });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(site.url, { waitUntil: 'domcontentloaded' });
  if ((options.wallets ?? []).length > 0) await page.waitForSelector('#rows tr');
  return {
    page,
    site,
    errors,
    close: async () => { await context.close(); await site.close(); },
  };
}

const px = (v) => Number.parseFloat(v);

/* ---------------------------------------------------------------- layout -- */

test('the page does not scroll sideways at a desktop width', { skip }, async () => {
  const t = await open({ wallets: [directWallet(), shareWallet(14)] });
  try {
    const overflow = await t.page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `page overflows horizontally by ${overflow}px`);
  } finally { await t.close(); }
});

test('a wide table scrolls inside its own box, not the page', { skip }, async () => {
  // The table has a min-width; the wrapper is what is meant to scroll.
  const t = await open({ wallets: [directWallet(), shareWallet(3)] }, { width: 420, height: 900 });
  try {
    const { pageOverflow, wrapScrolls } = await t.page.evaluate(() => {
      const wrap = document.querySelector('.wrap');
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        wrapScrolls: wrap.scrollWidth > wrap.clientWidth,
      };
    });
    assert.ok(pageOverflow <= 1, `page overflows by ${pageOverflow}px at 420 wide`);
    assert.ok(wrapScrolls, 'the table wrapper is the thing that scrolls');
  } finally { await t.close(); }
});

test('the toolbar stays on one row at full width', { skip }, async () => {
  // Regression: at narrower widths "Claim for real" dropped onto its own line,
  // which is how the first dashboard recording came out looking broken.
  const t = await open({ wallets: [directWallet()] }, { width: 1280 });
  try {
    const [first, last] = await Promise.all([
      t.page.locator('#rescan').boundingBox(),
      t.page.locator('#exec').boundingBox(),
    ]);
    assert.ok(Math.abs(first.y - last.y) < 2,
      `toolbar wrapped: #rescan at y=${first.y}, #exec at y=${last.y}`);
  } finally { await t.close(); }
});

test('expanding shares makes the table taller', { skip }, async () => {
  const t = await open({ wallets: [shareWallet(14)] });
  try {
    const before = (await t.page.locator('table').boundingBox()).height;
    await t.page.click('.disc');
    await t.page.waitForFunction(() => document.querySelectorAll('tr.sub').length === 15);
    const after = (await t.page.locator('table').boundingBox()).height;
    assert.ok(after > before + 100, `expected real growth, got ${before} -> ${after}`);
  } finally { await t.close(); }
});

/* -------------------------------------------------------------- keyboard -- */

test('the disclosure is reachable and operable by keyboard alone', { skip }, async () => {
  const t = await open({ wallets: [shareWallet(4)] });
  try {
    await t.page.locator('.disc').focus();
    assert.equal(await t.page.evaluate(() => document.activeElement.className), 'disc');
    await t.page.keyboard.press('Enter');
    await t.page.waitForFunction(() => document.querySelectorAll('tr.sub').length === 5);
    assert.equal(await t.page.getAttribute('.disc', 'aria-expanded'), 'true');
  } finally { await t.close(); }
});

test('a disabled claim button cannot be clicked into action', { skip }, async () => {
  const t = await open({ wallets: [directWallet()], allowExecute: false });
  try {
    await t.page.locator('#exec').click({ force: true, timeout: 2000 }).catch(() => {});
    await t.page.waitForTimeout(200);
    assert.equal(t.site.calls.filter((c) => c.path === '/api/claim').length, 0,
      'no claim was submitted');
  } finally { await t.close(); }
});

/* ----------------------------------------------------------------- theme -- */

test('the dark palette applies under a dark colour scheme', { skip }, async () => {
  const t = await open({ wallets: [directWallet()] }, { colorScheme: 'dark' });
  try {
    const bg = await t.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(bg, 'rgb(14, 17, 22)');
  } finally { await t.close(); }
});

test('the light palette applies under a light colour scheme', { skip }, async () => {
  const t = await open({ wallets: [directWallet()] }, { colorScheme: 'light' });
  try {
    const bg = await t.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(bg, 'rgb(246, 248, 250)', 'the light media query is honoured');
  } finally { await t.close(); }
});

test('a ready status is actually rendered green', { skip }, async () => {
  const t = await open({ wallets: [directWallet()] });
  try {
    const colour = await t.page.evaluate(() => getComputedStyle(document.querySelector('.tag.ready')).color);
    assert.equal(colour, 'rgb(63, 185, 80)');
  } finally { await t.close(); }
});

test('a blocked row is visibly dimmed', { skip }, async () => {
  const t = await open({ wallets: [directWallet({ status: 'blocked', reason: 'nope' })] });
  try {
    const opacity = await t.page.evaluate(() =>
      getComputedStyle(document.querySelector('tr.blocked')).opacity);
    assert.ok(px(opacity) < 1, `expected dimming, got opacity ${opacity}`);
  } finally { await t.close(); }
});

/* -------------------------------------------------------------- behaviour -- */

test('the page loads without throwing', { skip }, async () => {
  const t = await open({ wallets: [directWallet(), shareWallet(14), emptyWallet()] });
  try {
    await t.page.click('.disc');
    await t.page.click('#none');
    await t.page.click('#all');
    await t.page.click('#hideEmpty');
    assert.deepEqual(t.errors, [], 'no uncaught page errors');
  } finally { await t.close(); }
});

test('Simulate posts the selection and renders the result', { skip }, async () => {
  const claimResult = {
    executed: false,
    results: [{
      label: 'batch 1/1 (2 actions)', ok: true, lamports: 4_776_222_000,
      wallets: ['dev-04'], signature: null, err: null,
    }],
  };
  const t = await open({ wallets: [directWallet(), shareWallet(2)], claimResult });
  try {
    await t.page.click('#dry');
    await t.page.waitForSelector('#log .row.ok');
    const log = await t.page.textContent('#log');
    assert.match(log, /Simulated/);
    assert.match(log, /4\.776222 SOL/);

    const claim = t.site.calls.find((c) => c.path === '/api/claim');
    assert.equal(claim.token, 'test-token', 'the API token travels with the request');
    assert.equal(claim.body.execute, false);
    assert.equal(claim.body.addresses.length, 2);
  } finally { await t.close(); }
});

test('the running total updates as rows are ticked', { skip }, async () => {
  const t = await open({ wallets: [directWallet(), shareWallet(2)] });
  try {
    await t.page.click('#none');
    assert.equal(await t.page.textContent('#selTotal'), '0.000000');
    await t.page.locator('#rows tr:not(.sub) input[type=checkbox]').first().click();
    assert.equal(await t.page.textContent('#selTotal'), '1.049487');
    assert.equal(await t.page.textContent('#selCount'), '1');
  } finally { await t.close(); }
});
