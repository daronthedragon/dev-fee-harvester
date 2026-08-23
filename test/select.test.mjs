import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'node:events';
import { multiSelect } from '../src/select.mjs';

/**
 * The picker needs a terminal, so these tests lend it one. Everything else is
 * the real component: its own rendering, its own key handling, its own
 * selection rules.
 */
function withFakeTerminal(run) {
  // Streams are injected rather than swapped on `process`, so the test runner
  // keeps its own stdout and the picker gets a terminal of its own.
  let buffer = '';
  const out = {
    write: (chunk) => {
      buffer += chunk;
      return true;
    },
    columns: 100,
  };
  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = () => input;
  input.resume = () => input;
  input.pause = () => input;

  const press = (name) =>
    new Promise((resolve) => {
      setImmediate(() => {
        input.emit('keypress', '', { name, ctrl: false, meta: false, shift: false });
        setImmediate(resolve);
      });
    });

  return run({ press, out, input, output: () => buffer });
}

const mint = new PublicKey('HssQnt18QzfRznC2FjMDGhRE5XoxYmnVLYYkGYsXpump');

/** A wallet whose own balance is claimable directly. */
const directRow = (label, lamports) => ({
  publicKey: Keypair.generate().publicKey,
  label,
  secretKey: null,
  status: 'ready',
  pumpLamports: lamports,
  pumpswapLamports: 0,
  totalLamports: lamports,
  distributions: [],
});

/**
 * A sharing-config row: it releases real SOL, but none of it is this row's own
 * balance, so `totalLamports` is zero.
 */
const crankRow = (label, distributable) => ({
  publicKey: Keypair.generate().publicKey,
  label,
  secretKey: null,
  status: 'ready',
  pumpLamports: 0,
  pumpswapLamports: 0,
  totalLamports: 0,
  distributions: [
    {
      config: { address: Keypair.generate().publicKey, mint, shareholders: [] },
      mint,
      distributable,
      userShare: 0,
      kind: 'self',
    },
  ],
});

test('a crank row is pre-selected even though its own total is zero', async () => {
  // Regression: selecting on totalLamports unticked the largest amounts on
  // the list, so the default confirm silently skipped them.
  await withFakeTerminal(async ({ press, out, input }) => {
    const rows = [crankRow('dev-main', 2_670_498_000), directRow('dev-04', 1_049_487_000)];
    const pending = multiSelect(rows, { title: 'Select', out, input });
    await press('return');
    const chosen = await pending;
    assert.deepEqual(
      chosen.map((r) => r.label),
      ['dev-main', 'dev-04'],
    );
  });
});

test('"r" reselects crank rows rather than dropping them', async () => {
  await withFakeTerminal(async ({ press, out, input }) => {
    const rows = [crankRow('dev-main', 2_670_498_000), directRow('dev-04', 1_049_487_000)];
    const pending = multiSelect(rows, { title: 'Select', out, input });
    await press('n'); // clear everything
    await press('r'); // "ready only" must bring both back
    await press('return');
    const chosen = await pending;
    assert.deepEqual(
      chosen.map((r) => r.label),
      ['dev-main', 'dev-04'],
    );
  });
});

test('the running total counts what each row moves', async () => {
  await withFakeTerminal(async ({ press, out, input, output }) => {
    const rows = [crankRow('dev-main', 2_670_498_000), directRow('dev-04', 1_049_487_000)];
    const pending = multiSelect(rows, { title: 'Select', out, input });
    await press('return');
    await pending;
    // 2.670498 + 1.049487 = 3.719985 SOL
    assert.match(output(), /3\.719985 SOL/);
    assert.doesNotMatch(output(), /0\.000000 SOL\s*$/m, 'a crank row must not display as zero');
  });
});

test('space toggles only the row under the cursor', async () => {
  await withFakeTerminal(async ({ press, out, input }) => {
    const rows = [directRow('a', 1e8), directRow('b', 2e8), directRow('c', 3e8)];
    const pending = multiSelect(rows, { title: 'Select', out, input });
    await press('n');
    await press('down'); // cursor on 'b'
    await press('space');
    await press('return');
    const chosen = await pending;
    assert.deepEqual(
      chosen.map((r) => r.label),
      ['b'],
    );
  });
});

test('a blocked row is never pre-selected', async () => {
  await withFakeTerminal(async ({ press, out, input }) => {
    const blocked = {
      ...directRow('bad', 5e8),
      status: 'blocked',
      reason: 'SharingConfigNotActive',
    };
    const rows = [blocked, directRow('good', 1e8)];
    const pending = multiSelect(rows, { title: 'Select', out, input });
    await press('return');
    const chosen = await pending;
    assert.deepEqual(
      chosen.map((r) => r.label),
      ['good'],
    );
  });
});

test('cancelling rejects rather than returning an empty selection', async () => {
  // An empty array would read as "the user chose nothing", which is a very
  // different thing from "the user backed out".
  await withFakeTerminal(async ({ press, out, input }) => {
    const pending = multiSelect([directRow('a', 1e8)], { title: 'Select', out, input });
    const settled = assert.rejects(() => pending, /cancelled/);
    await press('q');
    await settled;
  });
});
