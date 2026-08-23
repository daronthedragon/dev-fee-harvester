import test from 'node:test';
import assert from 'node:assert/strict';
import { clearProgress, progress, setProgressMode } from '../src/format.mjs';

/**
 * Capture stderr around a call. Safe to intercept here: the test reporter
 * writes to stdout, so nothing of its own is swallowed.
 */
function captureStderr(fn) {
  const original = process.stderr.write;
  let buffer = '';
  process.stderr.write = (chunk) => { buffer += chunk; return true; };
  try { fn(); } finally { process.stderr.write = original; }
  return buffer;
}

const withTTY = (isTTY, fn) => {
  const original = process.stderr.isTTY;
  process.stderr.isTTY = isTTY;
  try { return fn(); } finally { process.stderr.isTTY = original; }
};

test.afterEach(() => setProgressMode('auto'));

test('auto stays silent when stderr is not a terminal', () => {
  // Carriage-return redraws piped into a file are just noise.
  setProgressMode('auto');
  const out = withTTY(false, () => captureStderr(() => progress('scanned 1,000 wallets')));
  assert.equal(out, '');
});

test('auto writes when stderr is a terminal', () => {
  setProgressMode('auto');
  const out = withTTY(true, () => captureStderr(() => progress('scanned 1,000 wallets')));
  assert.match(out, /scanned 1,000 wallets/);
  assert.ok(out.startsWith('\r'), 'the line is redrawn in place');
});

test('always writes even when stderr is not a terminal', () => {
  setProgressMode('always');
  const out = withTTY(false, () => captureStderr(() => progress('scanned 2,000 wallets')));
  assert.match(out, /scanned 2,000 wallets/);
});

test('never stays silent even on a terminal', () => {
  setProgressMode('never');
  const out = withTTY(true, () => captureStderr(() => progress('scanned 3,000 wallets')));
  assert.equal(out, '');
});

test('clearProgress follows the same mode', () => {
  setProgressMode('never');
  assert.equal(withTTY(true, () => captureStderr(() => clearProgress())), '');
  setProgressMode('always');
  assert.notEqual(withTTY(false, () => captureStderr(() => clearProgress())), '');
});

test('an unknown mode is rejected rather than silently ignored', () => {
  assert.throws(() => setProgressMode('sometimes'), /must be auto, always or never/);
});
