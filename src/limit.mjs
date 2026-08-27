/**
 * Concurrency and retry primitives.
 *
 * Scanning a very large wallet set is entirely bound by RPC round trips, so
 * the difference between "sequential chunks" and "a bounded pool" is the
 * difference between hours and minutes. The pool is bounded rather than
 * unbounded because firing everything at once is what earns a 429.
 */

/**
 * Sleep. Written with a block body on purpose: an arrow here returns the
 * timer id into the promise executor, which reads as a value nobody consumes.
 */
export const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A promise pool: at most `concurrency` tasks in flight, optional pacing. */
export function createLimiter({ concurrency = 8, minDelayMs = 0 } = {}) {
  let active = 0;
  let lastStart = 0;
  const waiting = [];

  const pump = () => {
    while (active < concurrency && waiting.length > 0) {
      const { fn, resolve, reject } = waiting.shift();
      active++;
      const gap = minDelayMs > 0 ? Math.max(0, lastStart + minDelayMs - Date.now()) : 0;
      lastStart = Date.now() + gap;
      const start = gap > 0 ? delay(gap).then(fn) : (async () => fn())();
      start.then(resolve, reject).finally(() => {
        active--;
        pump();
      });
    }
  };

  const run = (fn) =>
    new Promise((resolve, reject) => {
      waiting.push({ fn, resolve, reject });
      pump();
    });
  run.active = () => active;
  run.pending = () => waiting.length;
  return run;
}

const isRateLimit = (err) => /429|too many requests|rate/i.test(err?.message ?? '');

/**
 * Retry with exponential backoff.
 *
 * Never returns a fallback value on exhaustion — it throws. A swallowed RPC
 * failure reads as "this wallet has no fees", which is the one wrong answer
 * that costs the user money.
 */
export async function withRetry(fn, { attempts = 5, baseDelayMs = 250, onRetry } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i === attempts - 1) break;
      // Rate limits deserve a longer sit-down than a transient network blip.
      const wait = baseDelayMs * 2 ** i * (isRateLimit(err) ? 2 : 1);
      onRetry?.(i + 1, err, wait);
      await delay(wait);
    }
  }
  throw lastError;
}

/**
 * Consume an async iterable of work in bounded-memory windows.
 *
 * Nothing accumulates: each batch is handed to `handler` and released before
 * the next is pulled, which is what allows an arbitrarily long wallet stream
 * to be processed in constant memory.
 */
export async function forEachBatch(iterable, handler) {
  let index = 0;
  for await (const batch of iterable) {
    await handler(batch, index++);
  }
}

/**
 * A limiter that finds the endpoint's capacity instead of being told it.
 *
 * `--concurrency 8` is a guess about someone else's rate limit. Guess low and
 * a read that could take twenty seconds takes four minutes; guess high and it
 * fails outright, which is what a 256-shard index build did against the public
 * RPC at every fixed value tried — the quota is per-method and a sustained
 * burst exhausts it whatever the parallelism.
 *
 * So it adapts, the way TCP does: additive increase, multiplicative decrease.
 * Every rate limit halves the width and lengthens the gap between requests;
 * a clean run of them widens it back one at a time. It settles just under
 * whatever the endpoint will actually give, and re-settles if that changes.
 *
 * Retries live inside it deliberately. A limiter that only sees successes
 * cannot know it is being throttled — the retry would absorb the signal and
 * the width would never come down.
 */
export function createAdaptiveLimiter({
  start = 8,
  min = 1,
  max = 32,
  attempts = 8,
  baseDelayMs = 500,
  maxPaceMs = 4000,
  onChange,
} = {}) {
  let width = Math.min(max, Math.max(min, start));
  let pace = 0;
  let active = 0;
  let ok = 0;
  const queue = [];

  // `active` is claimed here, synchronously, as the slot is handed out. Doing
  // it in the caller after its await would leave this loop looking at a stale
  // zero and dispatch the entire queue at once, limiting nothing.
  const pump = () => {
    while (active < width && queue.length > 0) {
      active++;
      queue.shift()();
    }
  };

  const slot = () =>
    new Promise((resolve) => {
      queue.push(resolve);
      pump();
    });

  const narrow = () => {
    const was = width;
    width = Math.max(min, Math.floor(width / 2));
    pace = Math.min(maxPaceMs, pace * 2 + 100);
    ok = 0;
    if (was !== width) onChange?.({ width, pace, reason: 'rate limit' });
  };

  const widen = () => {
    // One clean pass at the current width before asking for more, so a single
    // lucky request does not undo a backoff.
    if (++ok < width * 2) return;
    ok = 0;
    const was = width;
    width = Math.min(max, width + 1);
    pace = Math.max(0, Math.floor(pace * 0.8));
    if (was !== width) onChange?.({ width, pace, reason: 'clear' });
  };

  return {
    get width() {
      return width;
    },
    get pace() {
      return pace;
    },

    async run(fn, { onRetry } = {}) {
      let lastError;
      for (let i = 0; i < attempts; i++) {
        await slot();
        try {
          if (pace > 0) await delay(pace);
          const result = await fn();
          widen();
          return result;
        } catch (err) {
          lastError = err;
          if (isRateLimit(err)) narrow();
          if (i === attempts - 1) break;
          const wait = baseDelayMs * 2 ** i * (isRateLimit(err) ? 2 : 1);
          onRetry?.(i + 1, err, wait);
          await delay(wait);
        } finally {
          active--;
          pump();
        }
      }
      throw lastError;
    },
  };
}

/**
 * Fail a call that never comes back.
 *
 * A retry loop cannot help with a request that neither resolves nor rejects,
 * and that is not hypothetical: a 100,000-wallet scan against the public RPC
 * sat on the same request count for twenty-five minutes with no error and no
 * progress. A stalled socket has to become an error before anything else can
 * deal with it.
 *
 * The underlying request is not cancelled — there is nothing to cancel it
 * with — so this bounds the wait, not the work.
 */
export function withTimeout(promise, ms, label = 'request') {
  if (!(ms > 0)) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
