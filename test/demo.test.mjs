import { after, describe, it as nodeIt } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

/**
 * The static demo published to GitHub Pages.
 *
 * It is built from the real dashboard with `fetch` stubbed, which means the
 * two ways it can break are silent: the build stops matching the page it is
 * cut from, or the stub stops matching what the page asks for. Neither shows
 * up as an error — the demo just renders an empty table, and looks like a tool
 * that finds nothing.
 *
 * So this drives it in a browser the way a visitor would: load it from the
 * file system exactly as Pages serves it, scan, select, claim, and check the
 * numbers that come back.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const page = join(root, 'site', 'index.html');

// Built here rather than assumed present: a stale site/ would test the last
// build instead of this one.
execFileSync(process.execPath, [join(root, 'scripts', 'build-demo.mjs')], { cwd: root });

async function launch() {
  const explicit = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (explicit) return chromium.launch({ executablePath: explicit });
  for (const channel of [process.env.PLAYWRIGHT_CHANNEL, 'msedge', 'chrome'].filter(Boolean)) {
    try {
      return await chromium.launch({ channel });
    } catch {
      /* try the next */
    }
  }
  return chromium.launch();
}

let browser = null;
let reason = null;
if (process.env.NO_BROWSER_TESTS) {
  reason = 'disabled by NO_BROWSER_TESTS';
} else {
  try {
    browser = await launch();
  } catch (err) {
    reason = `chromium unavailable (${err.message.split('\n')[0].slice(0, 80)})`;
  }
}

after(async () => {
  await browser?.close();
});

describe('published demo', () => {
  const it = (name, fn) => nodeIt(name, { skip: browser ? false : reason }, fn);

  async function open() {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await context.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(pathToFileURL(page).href, { waitUntil: 'domcontentloaded' });
    // The page scans on load, so rows appear without anyone clicking.
    await p.waitForSelector('#rows tr');
    return { p, errors, close: () => context.close() };
  }

  it('has no unreplaced placeholders left in it', () => {
    const html = readFileSync(page, 'utf8');
    assert.ok(existsSync(join(root, 'site', '.nojekyll')), '.nojekyll must be published too');
    for (const placeholder of ['__TOKEN__', '__ALLOW_EXECUTE__']) {
      assert.equal(html.includes(placeholder), false, `${placeholder} was not substituted`);
    }
  });

  it('says on its face that it is a demo', async () => {
    const t = await open();
    try {
      const banner = await t.p.textContent('.demo-banner');
      assert.match(banner, /Demo/);
      assert.match(banner, /no chain access/i);
    } finally {
      await t.close();
    }
  });

  it('scans and renders every sample wallet', async () => {
    const t = await open();
    try {
      // "Hide empty" is on by default, so the watch-only wallet with nothing
      // to claim starts hidden. Turn it off to see the whole sample.
      await t.p.uncheck('#hideEmpty');
      // Wallet rows carry a checkbox; a share disclosure row is a <tr> too.
      const labels = await t.p.$$eval('#rows tr:has(input[type=checkbox]) td:nth-child(2)', (tds) =>
        tds.map((td) => td.textContent.trim()),
      );
      assert.deepEqual(labels, [
        'dev-01',
        'dev-02',
        'dev-03 (team)',
        'dev-04',
        'cold-01 (watch-only)',
      ]);
      assert.deepEqual(t.errors, []);
    } finally {
      await t.close();
    }
  });

  it('claims the selected wallets and reports what moved', async () => {
    const t = await open();
    try {
      // Pre-selected on scan: every wallet that is ready and has work.
      const selected = await t.p.$$eval('#rows tr.sel', (rows) => rows.length);
      assert.equal(selected, 3, 'the three wallets with work should be pre-ticked');

      await t.p.click('#dry');
      await t.p.waitForSelector('#log .row.ok');
      const log = await t.p.textContent('#log');
      assert.match(log, /Simulated/);
      // 64488314 + 1204773901 + 2668638438 = 3.937900653 SOL, packed into one
      // transaction because three actions fit well inside the eight-per-tx cap.
      assert.match(log, /3\.9379/, `claim total missing from the log: ${log}`);
      assert.deepEqual(t.errors, []);
    } finally {
      await t.close();
    }
  });

  it('is built from the live dashboard, not a copy of it', () => {
    // If someone forks the page instead of building from it, this catches it:
    // the demo must still contain markup that only exists in web/index.html.
    const demo = readFileSync(page, 'utf8');
    const real = readFileSync(join(root, 'web', 'index.html'), 'utf8');
    const marker = real.slice(real.indexOf('<table'), real.indexOf('<table') + 200);
    assert.ok(marker.length > 50, 'no table markup found in web/index.html');
    assert.ok(demo.includes(marker), 'demo page has drifted from web/index.html');
  });
});
