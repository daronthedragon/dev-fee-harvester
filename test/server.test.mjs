import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { startDashboard, toClaimResponse } from '../src/server.mjs';

/**
 * Tests for the dashboard server itself.
 *
 * The DOM and browser suites both run against a stub API, which left the real
 * server — the process that actually holds signing keys — with no coverage at
 * all. A mutation that dropped a field from the claim response passed every
 * one of them.
 *
 * Nothing here touches the network. The privileged routes reject an unproven
 * caller before any RPC happens, which is exactly the property worth testing,
 * and `new Connection(url)` does not dial on construction.
 */

/** A wallets file with a single watch-only address. */
async function walletsFile() {
  const dir = await mkdtemp(join(tmpdir(), 'harvester-server-'));
  const path = join(dir, 'wallets.json');
  await writeFile(
    path,
    JSON.stringify([{ label: 'w0', publicKey: Keypair.generate().publicKey.toBase58() }]),
  );
  return path;
}

/** Start a real server on an ephemeral port, silenced. */
async function boot(options = {}) {
  const { server, url, token } = await startDashboard({
    walletsPath: await walletsFile(),
    rpc: 'http://127.0.0.1:1/never-called',
    port: 0,
    log: () => {},
    ...options,
  });
  const origin = new URL(url).origin;
  const close = () =>
    new Promise((resolve) => {
      server.close(resolve);
    });
  return { server, origin, token, close };
}

test('the privileged routes refuse a caller with no token', async (t) => {
  const { origin, close } = await boot();
  t.after(close);

  for (const path of ['/api/scan', '/api/claim']) {
    const res = await fetch(origin + path, { method: 'POST' });
    assert.equal(res.status, 403, `${path} must not answer an unproven caller`);
  }
});

test('a wrong token is refused, by header and by query alike', async (t) => {
  const { origin, close } = await boot();
  t.after(close);

  const header = await fetch(`${origin}/api/scan`, { headers: { 'x-token': 'not-the-token' } });
  assert.equal(header.status, 403);

  const query = await fetch(`${origin}/api/scan?token=not-the-token`);
  assert.equal(query.status, 403);
});

test('the page is served without a token, and carries the real one', async (t) => {
  // The page has to be reachable for the link to work; the token it embeds is
  // what authorises everything after it.
  const { origin, token, close } = await boot();
  t.after(close);

  const res = await fetch(`${origin}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(token), 'the served page must carry the minted token');
  assert.ok(!html.includes('__TOKEN__'), 'the placeholder must be substituted');
  assert.ok(!html.includes('__ALLOW_EXECUTE__'), 'the execute placeholder must be substituted');
});

test('the token is different on every start', async (t) => {
  const a = await boot();
  const b = await boot();
  t.after(a.close);
  t.after(b.close);
  assert.notEqual(a.token, b.token);
  assert.ok(a.token.length >= 32, 'a guessable token would defeat the point');
});

test('execute stays off unless it was turned on', async (t) => {
  // Sending real transactions is opt-in at startup, and the page is told so
  // by substitution rather than by asking. Default must be off.
  const off = await boot();
  t.after(off.close);
  const html = await fetch(`${off.origin}/`).then((r) => r.text());
  assert.match(html, /const ALLOW_EXECUTE = false;/);

  const on = await boot({ allowExecute: true });
  t.after(on.close);
  const onHtml = await fetch(`${on.origin}/`).then((r) => r.text());
  assert.match(onHtml, /const ALLOW_EXECUTE = true;/);
});

test('the server binds to loopback only', async (t) => {
  // It holds signing keys. Reachable from the network is not an option.
  const { server, close } = await boot();
  t.after(close);
  assert.equal(server.address().address, '127.0.0.1');
});

test('an unknown privileged path is a 404, not a crash', async (t) => {
  const { origin, token, close } = await boot();
  t.after(close);
  const res = await fetch(`${origin}/api/nope`, { headers: { 'x-token': token } });
  assert.equal(res.status, 404);
});

/* ------------------------------------------------------- claim response -- */

test('an indeterminate result keeps its flag on the way to the browser', async () => {
  // The field the dashboard needs to style this as "check" rather than
  // "failed". Dropping it here is invisible to every DOM test, because those
  // stub the API.
  const out = toClaimResponse(
    [
      {
        label: 'batch 1/1',
        ok: false,
        indeterminate: true,
        lamports: 1_049_487_000,
        wallets: ['dev-04'],
        signature: 'sig-1',
        err: 'could not determine the outcome',
      },
    ],
    true,
  );

  assert.equal(out.executed, true);
  assert.equal(out.results[0].indeterminate, true);
  assert.equal(out.results[0].signature, 'sig-1', 'the signature is the only way to check');
});

test('an ordinary result is not marked indeterminate', async () => {
  const out = toClaimResponse([{ label: 'b', ok: true, lamports: 1, wallets: [] }], false);
  assert.equal(out.results[0].indeterminate, false);
  assert.equal(out.results[0].signature, null);
  assert.equal(out.results[0].err, null);
});

test('a long error is truncated rather than streamed into the page', async () => {
  const out = toClaimResponse(
    [{ label: 'b', ok: false, lamports: 0, wallets: [], err: 'x'.repeat(5000) }],
    true,
  );
  assert.ok(out.results[0].err.length <= 300);
});
