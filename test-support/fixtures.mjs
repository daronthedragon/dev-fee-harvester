import { delay } from '../src/limit.mjs';

/**
 * Wallet payloads in the shape `/api/scan` returns, shared by the jsdom and
 * the browser suites so the two cannot drift apart.
 */

/** A wallet with a claimable balance of its own. */
export const directWallet = (over = {}) => ({
  label: 'dev-04', address: '3z4vj1nAujLnciPgZaGz4VYecZa6gbYUg3Yr9MoyuiMG',
  pump: 1_049_487_000, pumpswap: 0, sharing: 0, total: 1_049_487_000,
  status: 'ready', reason: null, partial: false, watchOnly: true,
  sharingError: null, distributions: [], ...over,
});

/**
 * A wallet that holds shares in other creators' configs. Its own total is
 * zero — the money lives in vaults it does not own.
 */
export const shareWallet = (count = 14, over = {}) => ({
  label: 'dev-share', address: '5bQMLqKtmiGzLba11rwD6eLutqdWD7L3WC8Rt1V5dw4J',
  pump: 0, pumpswap: 0, sharing: 3_726_735_000, total: 3_726_735_000,
  status: 'ready', reason: null, partial: false, watchOnly: true, sharingError: null,
  distributions: Array.from({ length: count }, (_, i) => ({
    mint: `Mint${String(i).padStart(40, 'x')}`, kind: 'share',
    distributable: 100_000_000, userShare: 50_000_000, shareholders: 2,
    blocked: null, unverified: null,
  })),
  ...over,
});

export const emptyWallet = (over = {}) => ({
  label: 'cold-01', address: 'SysvarC1ock11111111111111111111111111111111',
  pump: 0, pumpswap: 0, sharing: 0, total: 0,
  status: 'empty', reason: 'nothing to claim', partial: false, watchOnly: true,
  sharingError: null, distributions: [], ...over,
});

export const TEST_TOKEN = 'test-token';

/** Poll until `fn` returns something truthy, or give up with a useful message. */
export async function waitFor(fn, what = 'condition', tries = 300) {
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}
