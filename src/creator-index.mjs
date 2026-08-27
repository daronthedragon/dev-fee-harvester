/**
 * Which addresses are coin creators anywhere on the chain.
 *
 * The scan's cost was three account lookups per wallet, whether or not the
 * wallet had ever launched a coin. For a list of a million addresses that is
 * thirty thousand requests spent almost entirely on wallets that were never
 * going to have fees — the answer for nearly all of them is no, and it was
 * being bought one wallet at a time.
 *
 * The chain will answer the question in bulk instead. Every coin names its
 * creator: `BondingCurve.creator` while it is on the curve, `Pool.coin_creator`
 * after it migrates. Reading those two fields — and nothing else of those
 * accounts — gives the complete set of addresses that could possibly have
 * creator fees. A wallet outside that set can be skipped without asking the
 * chain about it at all.
 *
 * The set is far too large to keep (13.7M coins, 3.47M distinct creators as of
 * writing), so it is streamed into a Bloom filter: 16MB, fixed, no matter how
 * much the chain grows. The filter only ever errs towards doing an unnecessary lookup, never
 * towards skipping a wallet that has money in it.
 *
 * Costs, measured rather than estimated — see README.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { PublicKey } from '@solana/web3.js';
import { PUMP_PROGRAM, PUMPSWAP_PROGRAM } from './constants.mjs';
import { createBloom, deserializeBloom } from './bloom.mjs';
import { encodeBase58 } from './base58.mjs';
import { streamProgramAccounts } from './rpc-stream.mjs';
import { createAdaptiveLimiter } from './limit.mjs';

/**
 * Account discriminators, base58-encoded for the memcmp filter, with the byte
 * offset of the creator field in each account.
 *
 * Both offsets come from the programs' own IDLs; `npm run verify:onchain`
 * re-derives them. Guessing here would be quiet and expensive: a wrong offset
 * yields 32 bytes of something else, the filter fills with addresses nobody
 * holds, and every wallet is skipped as "not a creator".
 */
export const CREATOR_SOURCES = [
  {
    name: 'bonding curves',
    program: PUMP_PROGRAM,
    discriminator: '4y6pru6YvC7', // sha256("account:BondingCurve")[0..8]
    creatorOffset: 49,
  },
  {
    name: 'pools',
    program: PUMPSWAP_PROGRAM,
    discriminator: 'hQrXeCntzbV', // sha256("account:Pool")[0..8]
    creatorOffset: 211,
  },
];

const MAGIC = 'DFHCIDX1';
const HEADER_BYTES = 64;

/** An address with no coins of its own is 32 zero bytes, and means "none". */
const isZero = (buf) => {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
};

/**
 * Split the read by the first byte of the creator field.
 *
 * One request for eight million accounts is a single point of failure that
 * takes four minutes to reach, and a stream that dies at 200s has nothing to
 * show for it. Two hundred and fifty-six requests of about a second each run
 * concurrently and retry individually. They also read less: a memcmp at the
 * creator offset cannot match an account too short to have one, so the
 * millions of pre-fee-sharing curves — which have no creator and contribute
 * nothing — are never sent at all.
 *
 * The shards partition on a byte of the field, so their union is every account
 * that has that field. Nothing falls between them.
 *
 * This is the default, and the single stream is the fallback, because the
 * single stream was not actually reading the whole program. The public
 * endpoint cuts a large response off when its data allowance runs out, and
 * nothing about that looks like a failure — it looks like a program with fewer
 * accounts than it has. Measured against the same chain minutes apart:
 *
 *     one request   9,299,870 accounts   ~1,583,727 creators   236s
 *     256 shards   13,741,332 accounts   ~3,468,078 creators   796s
 *
 * The fast one was fast because it stopped early, and it silently left out
 * more than half the creators — every one of them a wallet the scan would
 * then never go looking for. Sharding is slower here and correct.
 * `--index-shards 0` restores the single read.
 */
const SHARD_BYTES = Array.from({ length: 256 }, (_, b) => encodeBase58(Buffer.from([b])));

/**
 * Read every coin on the chain and keep only who created it.
 *
 * `onProgress(source, seen)` is called as accounts arrive. Returns the index,
 * which is a Bloom filter plus the slot it was taken at and per-source counts.
 *
 * `shards: 0` reads each program in one request instead, which is slower and
 * all-or-nothing, but asks nothing of the endpoint beyond a plain scan.
 */
export async function buildCreatorIndex(rpcEndpoint, options = {}) {
  const {
    onProgress,
    fetchImpl,
    slot = 0,
    bloom = createBloom(),
    sources = CREATOR_SOURCES,
    shards = 256,
    concurrency = 8,
    onRetry,
    onPace,
  } = options;

  // The width is a starting guess, not a setting: it moves to whatever the
  // endpoint turns out to allow.
  const limiter = createAdaptiveLimiter({ start: concurrency, onChange: onPace });
  const counts = {};

  for (const source of sources) {
    let seen = 0;
    const read = (extraFilters) =>
      limiter.run(
        () =>
          streamProgramAccounts(rpcEndpoint, source.program, {
            commitment: 'confirmed',
            ...(fetchImpl ? { fetchImpl } : {}),
            filters: [
              { memcmp: { offset: 0, bytes: source.discriminator, encoding: 'base58' } },
              ...extraFilters,
            ],
            dataSlice: { offset: source.creatorOffset, length: 32 },
            onAccount: ({ data }) => {
              seen++;
              // A sliced read that comes back short means the account is not
              // the shape the offset assumed — a legacy layout with no creator
              // on it. It has no fees for anyone, so it is counted and left out.
              if (data.length !== 32 || isZero(data)) return;
              bloom.add(data);
              if (onProgress && seen % 100000 === 0) onProgress(source.name, seen);
            },
          }),
        { onRetry },
      );

    if (shards > 0) {
      await Promise.all(
        SHARD_BYTES.map((bytes) =>
          read([{ memcmp: { offset: source.creatorOffset, bytes, encoding: 'base58' } }]),
        ),
      );
    } else {
      await read([]);
    }

    counts[source.name] = seen;
    onProgress?.(source.name, seen);
  }

  return makeIndex(bloom, slot, counts);
}

function makeIndex(bloom, slot, counts) {
  return {
    slot,
    counts,
    bloom,
    get added() {
      return bloom.added;
    },
    falsePositiveRate: () => bloom.falsePositiveRate(),

    /**
     * False when the address is certainly not a creator, true when it probably
     * is. Accepts a PublicKey or raw bytes.
     */
    mightBeCreator(key) {
      return bloom.has(key instanceof PublicKey ? key.toBuffer() : key);
    },

    serialize() {
      const header = Buffer.alloc(HEADER_BYTES);
      header.write(MAGIC, 0, 'ascii');
      header.writeBigUInt64LE(BigInt(slot), 8);
      const names = Object.keys(counts);
      for (let i = 0; i < names.length && i < 4; i++) {
        header.writeBigUInt64LE(BigInt(counts[names[i]]), 16 + i * 8);
      }
      return Buffer.concat([header, bloom.serialize()]);
    },
  };
}

/**
 * Where a built index is kept between runs. Building it costs a full read of
 * both programs, so it is worth writing down; using it costs nothing.
 */
export function defaultIndexPath() {
  return join(homedir(), '.dev-fee-harvester', 'creators.idx');
}

/**
 * Roughly a day of slots at ~400ms each. An index older than this is rebuilt:
 * coins launched since it was taken are not in it, and a wallet that only
 * created one of those would be skipped — the one failure this must not have.
 */
export const DEFAULT_MAX_AGE_SLOTS = 216_000;

/**
 * Load the index from `path`, or build it and save it there.
 *
 * `currentSlot` decides staleness. `onEvent` reports what was decided —
 * loaded, stale, building — so the caller can explain a four-minute pause
 * rather than appearing to hang.
 */
export async function openCreatorIndex({
  rpcEndpoint,
  path = defaultIndexPath(),
  currentSlot = 0,
  maxAgeSlots = DEFAULT_MAX_AGE_SLOTS,
  rebuild = false,
  onEvent,
  onProgress,
  fetchImpl,
}) {
  if (!rebuild && existsSync(path)) {
    let index = null;
    try {
      index = deserializeCreatorIndex(readFileSync(path));
    } catch (e) {
      // A corrupt cache is not a reason to fail — it is a reason to rebuild.
      onEvent?.({ type: 'unreadable', path, message: e.message });
    }
    if (index) {
      const age = Math.max(0, currentSlot - index.slot);
      if (age <= maxAgeSlots) {
        onEvent?.({ type: 'loaded', path, index, ageSlots: age });
        return index;
      }
      onEvent?.({ type: 'stale', path, ageSlots: age });
    }
  }

  onEvent?.({ type: 'building', path });
  const index = await buildCreatorIndex(rpcEndpoint, { slot: currentSlot, onProgress, fetchImpl });

  // An index with nobody in it is not an empty answer, it is a broken one: as
  // a filter it rules out every wallet, and the scan then reports no fees
  // anywhere. There are millions of coins on the chain, so zero creators means
  // the read failed in a way that did not raise. Refuse it rather than cache
  // it and skip every wallet for a day.
  if (index.added === 0) {
    throw new Error(
      `creator index came back empty (${JSON.stringify(index.counts)} accounts read) — ` +
        'refusing to use it, because an empty index silently skips every wallet',
    );
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, index.serialize());
  onEvent?.({ type: 'built', path, index });
  return index;
}

/** Rebuild an index written by `serialize()`. */
export function deserializeCreatorIndex(buf) {
  if (buf.length < HEADER_BYTES || buf.toString('ascii', 0, 8) !== MAGIC) {
    throw new Error('not a creator index file');
  }
  const slot = Number(buf.readBigUInt64LE(8));
  const counts = {
    'bonding curves': Number(buf.readBigUInt64LE(16)),
    pools: Number(buf.readBigUInt64LE(24)),
  };
  return makeIndex(deserializeBloom(buf.subarray(HEADER_BYTES)), slot, counts);
}
