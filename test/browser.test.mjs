import { after, describe, it as nodeIt } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright-core';
import { directWallet, emptyWallet, shareWallet } from './helpers/fixtures.mjs';
import { serveDashboard } from './helpers/serve.mjs';

/**
 * Browser tests for the dashboard, run against every engine available.
 *
 * jsdom covers structure and event wiring but has no layout engine and no CSS,
 * so it cannot see what this file is for: whether the page overflows, whether
 * the toolbar wraps, whether the palettes actually apply, whether a keyboard
 * alone can work the disclosure. One of those — the toolbar wrapping — was
 * originally spotted by eye while recording a demo, which is not a way to find
 * layout bugs.
 *
 * Chromium runs on whatever branded browser is already installed, so the
 * common case downloads nothing. Firefox and WebKit have no system equivalent
 * Playwright can drive, so they run only where their builds have been fetched
 * with `npx playwright-core install firefox webkit`. Any engine that is
 * missing skips instead of failing, which keeps `npm test` green anywhere.
 */
async function launchChromium() {
  const explicit = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (explicit) {
    try {
      return await chromium.launch({ executablePath: explicit });
    } catch (err) {
      throw new Error(`PLAYWRIGHT_EXECUTABLE_PATH is set but would not launch: ${err.message}`);
    }
  }
  for (const channel of [process.env.PLAYWRIGHT_CHANNEL, 'msedge', 'chrome'].filter(Boolean)) {
    try { return await chromium.launch({ channel }); } catch { /* try the next */ }
  }
  return chromium.launch();
}

const ENGINES = [
  { name: 'chromium', launch: launchChromium },
  { name: 'firefox', launch: () => firefox.launch() },
  { name: 'webkit', launch: () => webkit.launch() },
];

const only = process.env.BROWSER_ENGINES?.split(',').map((s) => s.trim()).filter(Boolean);

const engines = await Promise.all(ENGINES.map(async (engine) => {
  if (process.env.NO_BROWSER_TESTS) return { ...engine, browser: null, reason: 'disabled by NO_BROWSER_TESTS' };
  if (only && !only.includes(engine.name)) return { ...engine, browser: null, reason: `not in BROWSER_ENGINES=${only.join(',')}` };
  try {
    return { ...engine, browser: await engine.launch(), reason: null };
  } catch (err) {
    return {
      ...engine,
      browser: null,
      reason: `${engine.name} unavailable — run "npx playwright-core install ${engine.name}" (${err.message.split('\n')[0].slice(0, 80)})`,
    };
  }
}));

after(async () => { await Promise.all(engines.map((e) => e.browser?.close())); });

const px = (v) => Number.parseFloat(v);

for (const engine of engines) {
  describe(`dashboard in ${engine.name}`, () => {
    // Skipping per test rather than per block: a skipped describe reports zero
    // tests, which reads as "nothing to run here" instead of "this coverage
    // did not happen".
    const skip = engine.browser ? false : engine.reason;
    const it = (name, fn) => nodeIt(name, { skip }, fn);

    /** Open the dashboard in a real page, with the API stubbed. */
    async function open(options = {}, { width = 1280, height = 900, colorScheme = 'dark' } = {}) {
      const site = await serveDashboard(options);
      const context = await engine.browser.newContext({ viewport: { width, height }, colorScheme });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(site.url, { waitUntil: 'domcontentloaded' });
      if ((options.wallets ?? []).length > 0) await page.waitForSelector('#rows tr');
      return { page, site, errors, close: async () => { await context.close(); await site.close(); } };
    }

    /* ------------------------------------------------------------ layout -- */

    it('does not scroll sideways at a desktop width', async () => {
      const t = await open({ wallets: [directWallet(), shareWallet(14)] });
      try {
        const overflow = await t.page.evaluate(() =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 1, `page overflows horizontally by ${overflow}px`);
      } finally { await t.close(); }
    });

    it('scrolls a wide table inside its own box, not the page', async () => {
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

    it('keeps the toolbar on one row at full width', async () => {
      // Regression: "Claim for real" used to drop onto its own line.
      const t = await open({ wallets: [directWallet()] }, { width: 1280 });
      try {
        const [first, last] = await Promise.all([
          t.page.locator('#rescan').boundingBox(),
          t.page.locator('#exec').boundingBox(),
        ]);
        assert.ok(Math.abs(first.y - last.y) < 2,
          `toolbar wrapped: #rescan y=${first.y}, #exec y=${last.y}`);
      } finally { await t.close(); }
    });

    it('grows the table when shares are expanded', async () => {
      const t = await open({ wallets: [shareWallet(14)] });
      try {
        const before = (await t.page.locator('table').boundingBox()).height;
        await t.page.click('.disc');
        await t.page.waitForFunction(() => document.querySelectorAll('tr.sub').length === 15);
        const after = (await t.page.locator('table').boundingBox()).height;
        assert.ok(after > before + 100, `expected real growth, got ${before} -> ${after}`);
      } finally { await t.close(); }
    });

    /* ---------------------------------------------------------- keyboard -- */

    it('lets the keyboard alone work the disclosure', async () => {
      const t = await open({ wallets: [shareWallet(4)] });
      try {
        await t.page.locator('.disc').focus();
        assert.equal(await t.page.evaluate(() => document.activeElement.className), 'disc');
        await t.page.keyboard.press('Enter');
        await t.page.waitForFunction(() => document.querySelectorAll('tr.sub').length === 5);
        assert.equal(await t.page.getAttribute('.disc', 'aria-expanded'), 'true');
      } finally { await t.close(); }
    });

    it('will not submit a claim from the disabled button', async () => {
      const t = await open({ wallets: [directWallet()], allowExecute: false });
      try {
        await t.page.locator('#exec').click({ force: true, timeout: 2000 }).catch(() => {});
        await t.page.waitForTimeout(200);
        assert.equal(t.site.calls.filter((c) => c.path === '/api/claim').length, 0);
      } finally { await t.close(); }
    });

    /* ------------------------------------------------------------- theme -- */

    it('applies the dark palette under a dark colour scheme', async () => {
      const t = await open({ wallets: [directWallet()] }, { colorScheme: 'dark' });
      try {
        assert.equal(await t.page.evaluate(() => getComputedStyle(document.body).backgroundColor),
          'rgb(14, 17, 22)');
      } finally { await t.close(); }
    });

    it('applies the light palette under a light colour scheme', async () => {
      const t = await open({ wallets: [directWallet()] }, { colorScheme: 'light' });
      try {
        assert.equal(await t.page.evaluate(() => getComputedStyle(document.body).backgroundColor),
          'rgb(246, 248, 250)');
      } finally { await t.close(); }
    });

    it('renders a ready status green', async () => {
      const t = await open({ wallets: [directWallet()] });
      try {
        assert.equal(
          await t.page.evaluate(() => getComputedStyle(document.querySelector('.tag.ready')).color),
          'rgb(63, 185, 80)');
      } finally { await t.close(); }
    });

    it('dims a blocked row', async () => {
      const t = await open({ wallets: [directWallet({ status: 'blocked', reason: 'nope' })] });
      try {
        const opacity = await t.page.evaluate(() =>
          getComputedStyle(document.querySelector('tr.blocked')).opacity);
        assert.ok(px(opacity) < 1, `expected dimming, got opacity ${opacity}`);
      } finally { await t.close(); }
    });

    it('highlights a selected row', async () => {
      // The highlight is a color-mix(), which is exactly the sort of thing that
      // silently does nothing on an engine that has not implemented it.
      const t = await open({ wallets: [directWallet()] });
      try {
        const selected = await t.page.evaluate(() =>
          getComputedStyle(document.querySelector('#rows tr.sel')).backgroundColor);
        await t.page.click('#none');
        const plain = await t.page.evaluate(() =>
          getComputedStyle(document.querySelector('#rows tr')).backgroundColor);
        assert.notEqual(selected, plain, `selection is invisible: both rows are ${selected}`);
      } finally { await t.close(); }
    });

    /* --------------------------------------------------------- behaviour -- */

    it('loads and can be driven without throwing', async () => {
      const t = await open({ wallets: [directWallet(), shareWallet(14), emptyWallet()] });
      try {
        await t.page.click('.disc');
        await t.page.click('#none');
        await t.page.click('#all');
        await t.page.click('#hideEmpty');
        assert.deepEqual(t.errors, [], 'no uncaught page errors');
      } finally { await t.close(); }
    });

    it('posts the selection on Simulate and renders the result', async () => {
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
        assert.equal(claim.token, 'test-token');
        assert.equal(claim.body.execute, false);
        assert.equal(claim.body.addresses.length, 2);
      } finally { await t.close(); }
    });

    it('updates the running total as rows are ticked', async () => {
      const t = await open({ wallets: [directWallet(), shareWallet(2)] });
      try {
        await t.page.click('#none');
        assert.equal(await t.page.textContent('#selTotal'), '0.000000');
        await t.page.locator('#rows tr:not(.sub) input[type=checkbox]').first().click();
        assert.equal(await t.page.textContent('#selTotal'), '1.049487');
        assert.equal(await t.page.textContent('#selCount'), '1');
      } finally { await t.close(); }
    });
  });
}
