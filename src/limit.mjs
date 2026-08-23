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
export const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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
      start.then(resolve, reject).finally(() => { active--; pump(); });
    }
  };

  const run = (fn) => new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); pump(); });
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
