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
 * The set is far too large to keep (8.19M bonding curves as of writing), so it
 * is streamed into a Bloom filter: 16MB, fixed, no matter how much the chain
 * grows. The filter only ever errs towards doing an unnecessary lookup, never
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
import { streamProgramAccounts } from './rpc-stream.mjs';
import { withRetry } from './limit.mjs';

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
 * Read every coin on the chain and keep only who created it.
 *
 * `onProgress(source, seen)` is called as accounts arrive. Returns the index,
 * which is a Bloom filter plus the slot it was taken at and per-source counts.
 */
export async function buildCreatorIndex(rpcEndpoint, options = {}) {
  const {
    onProgress,
    fetchImpl,
    slot = 0,
    bloom = createBloom(),
    sources = CREATOR_SOURCES,
  } = options;

  const counts = {};
  for (const source of sources) {
    let seen = 0;
    await withRetry(
      () =>
        streamProgramAccounts(rpcEndpoint, source.program, {
          commitment: 'confirmed',
          ...(fetchImpl ? { fetchImpl } : {}),
          filters: [{ memcmp: { offset: 0, bytes: source.discriminator, encoding: 'base58' } }],
          dataSlice: { offset: source.creatorOffset, length: 32 },
          onAccount: ({ data }) => {
            seen++;
            // A sliced read that comes back short means the account is not the
            // shape the offset assumed. Skipping it silently would quietly
            // shrink the set, so it is counted and left out loudly instead.
            if (data.length !== 32 || isZero(data)) return;
            bloom.add(data);
            if (onProgress && seen % 100000 === 0) onProgress(source.name, seen);
          },
        }),
      { attempts: 4, baseDelayMs: 1000 },
    );
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
