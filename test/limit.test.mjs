import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdaptiveLimiter, delay, withTimeout } from '../src/limit.mjs';

test('the adaptive limiter actually limits', async () => {
  // The first version dispatched the whole queue at once, because the slot
  // counter was incremented by the caller after its await rather than as the
  // slot was handed out. Nothing about the result would have looked wrong —
  // it would just have hammered the endpoint at unbounded width.
  const limiter = createAdaptiveLimiter({ start: 3, max: 3 });
  let inFlight = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 30 }, () =>
      limiter.run(async () => {
        peak = Math.max(peak, ++inFlight);
        await delay(5);
        inFlight--;
      }),
    ),
  );
  assert.equal(peak, 3, `ran ${peak} at once with a width of 3`);
});

test('a rate limit narrows the width, and clean runs widen it again', async () => {
  const changes = [];
  const limiter = createAdaptiveLimiter({
    start: 8,
    baseDelayMs: 1,
    onChange: (c) => changes.push(c.reason),
  });

  let failures = 3;
  const result = await limiter.run(async () => {
    if (failures-- > 0) throw new Error('429 Too Many Requests');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(limiter.width, 1, `three rate limits should halve 8 to 1, got ${limiter.width}`);
  assert.ok(limiter.pace > 0, 'and put a gap between requests');
  assert.deepEqual(changes, ['rate limit', 'rate limit', 'rate limit']);

  for (let i = 0; i < 20; i++) await limiter.run(async () => 'ok');
  assert.ok(limiter.width > 1, `width should recover, still ${limiter.width}`);
  assert.ok(changes.includes('clear'));
});

test('an error that is not a rate limit does not narrow the width', async () => {
  // Otherwise one flaky connection permanently halves the throughput of a
  // build that was never being throttled at all.
  const limiter = createAdaptiveLimiter({ start: 8, attempts: 2, baseDelayMs: 1 });
  await assert.rejects(
    () =>
      limiter.run(async () => {
        throw new Error('ECONNRESET');
      }),
    /ECONNRESET/,
  );
  assert.equal(limiter.width, 8);
});

test('it gives up eventually rather than retrying forever', async () => {
  const limiter = createAdaptiveLimiter({ start: 2, attempts: 3, baseDelayMs: 1 });
  let calls = 0;
  await assert.rejects(
    () =>
      limiter.run(async () => {
        calls++;
        throw new Error('429 rate limited');
      }),
    /429/,
  );
  assert.equal(calls, 3);
});

test('a request that never comes back becomes an error', async () => {
  // A retry loop cannot rescue a call that neither resolves nor rejects.
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 20, 'getMultipleAccounts'),
    /getMultipleAccounts timed out after 20ms/,
  );
});

test('a request that answers in time is untouched', async () => {
  assert.equal(await withTimeout(Promise.resolve('value'), 1000), 'value');
  // And zero means no ceiling, rather than an instant failure.
  assert.equal(await withTimeout(Promise.resolve('value'), 0), 'value');
});
