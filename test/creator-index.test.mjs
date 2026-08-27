import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createBloom, deserializeBloom } from '../src/bloom.mjs';
import { decodeBase58 } from '../src/base58.mjs';
import {
  CREATOR_SOURCES,
  buildCreatorIndex,
  deserializeCreatorIndex,
  openCreatorIndex,
} from '../src/creator-index.mjs';
import { PUMPSWAP_PROGRAM, PUMP_PROGRAM } from '../src/constants.mjs';

const keys = (n) => Array.from({ length: n }, () => Keypair.generate().publicKey);

/**
 * A getProgramAccounts response in the shape mainnet actually returns:
 * `pubkey` before `account`, data base64 in a two-element array.
 */
function rpcResponse(creators) {
  const value = creators.map((pk) => ({
    pubkey: Keypair.generate().publicKey.toBase58(),
    account: {
      data: [Buffer.from(pk.toBuffer()).toString('base64'), 'base64'],
      executable: false,
      lamports: 1,
      owner: PUMP_PROGRAM.toBase58(),
      rentEpoch: 0,
      space: 32,
    },
  }));
  return JSON.stringify({ jsonrpc: '2.0', result: value, id: 1 });
}

/**
 * A fetch stub that replies per program with the creators it was given.
 *
 * It honours the shard filter rather than ignoring it. A stub that returned
 * everything to every shard would pass whatever the shard byte was, including
 * a wrong one — the same way an earlier stub agreed with a wrong key order and
 * hid a parser that matched nothing on mainnet.
 */
function stubFetch(byProgram, calls = []) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const program = body.params[0];
    const config = body.params[1];
    calls.push({ program, config });
    let creators = byProgram[program] ?? [];
    const shard = config.filters.find((f) => f.memcmp.offset === config.dataSlice.offset);
    if (shard) {
      const byte = decodeBase58(shard.memcmp.bytes)[0];
      creators = creators.filter((pk) => pk.toBuffer()[0] === byte);
    }
    const text = rpcResponse(creators);
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        yield Buffer.from(text);
      })(),
    };
  };
}

test('a bloom filter never says no to a key it was given', () => {
  const bloom = createBloom({ log2Bits: 16 });
  const present = keys(200);
  for (const pk of present) bloom.add(pk.toBuffer());
  for (const pk of present) {
    assert.equal(bloom.has(pk.toBuffer()), true, `${pk.toBase58()} must not be a false negative`);
  }
});

test('a bloom filter says no to almost everything it was not given', () => {
  const bloom = createBloom({ log2Bits: 20 });
  for (const pk of keys(500)) bloom.add(pk.toBuffer());
  const absent = keys(2000).filter((pk) => bloom.has(pk.toBuffer()));
  // 500 keys in 2^20 bits with k=8 is a vanishingly sparse filter; anything
  // above a handful means the indices are not spreading.
  assert.ok(absent.length <= 2, `${absent.length} false positives out of 2000 is too many`);
});

test('a bloom filter survives a round trip through bytes', () => {
  const bloom = createBloom({ log2Bits: 16 });
  const present = keys(50);
  for (const pk of present) bloom.add(pk.toBuffer());

  const restored = deserializeBloom(bloom.serialize());
  assert.equal(restored.added, 50);
  for (const pk of present) assert.equal(restored.has(pk.toBuffer()), true);
});

test('a file that is not a bloom filter is rejected, not read as an empty one', () => {
  // The dangerous failure is a filter that answers "no" to everything, because
  // that looks exactly like a chain with no creators on it.
  assert.throws(() => deserializeBloom(Buffer.alloc(64)), /not a bloom filter/);
  const truncated = createBloom({ log2Bits: 16 }).serialize().subarray(0, 100);
  assert.throws(() => deserializeBloom(truncated), /bitmap/);
});

test('the index reads the creator field of both curves and pools', async () => {
  const curveCreators = keys(3);
  const poolCreators = keys(2);
  const calls = [];
  const index = await buildCreatorIndex('http://rpc.test', {
    shards: 256,
    fetchImpl: stubFetch(
      {
        [PUMP_PROGRAM.toBase58()]: curveCreators,
        [PUMPSWAP_PROGRAM.toBase58()]: poolCreators,
      },
      calls,
    ),
  });

  for (const pk of [...curveCreators, ...poolCreators]) {
    assert.equal(index.mightBeCreator(pk), true);
  }
  assert.equal(index.counts['bonding curves'], 3);
  assert.equal(index.counts.pools, 2);

  // 256 shards per program, and every one of them asked for 32 bytes at the
  // offset that program's IDL puts the creator at.
  assert.equal(calls.length, 512);
  for (const source of CREATOR_SOURCES) {
    const mine = calls.filter((c) => c.program === source.program.toBase58());
    assert.equal(mine.length, 256);
    for (const call of mine) {
      assert.deepEqual(call.config.dataSlice, { offset: source.creatorOffset, length: 32 });
    }
    // The shards partition the byte range exactly once each, so nothing is
    // read twice and nothing falls between them.
    const bytes = mine
      .map((c) => decodeBase58(c.config.filters[1].memcmp.bytes)[0])
      .sort((a, b) => a - b);
    assert.deepEqual(
      bytes,
      Array.from({ length: 256 }, (_, i) => i),
    );
  }
});

test('the default is one request per program, not a sharded read', async () => {
  const creators = keys(6);
  const calls = [];
  const index = await buildCreatorIndex('http://rpc.test', {
    sources: [CREATOR_SOURCES[0]],
    fetchImpl: stubFetch({ [PUMP_PROGRAM.toBase58()]: creators }, calls),
  });
  assert.equal(calls.length, 1, 'the default is a single unfiltered read');
  assert.equal(calls[0].config.filters.length, 1, 'no shard filter on it');
  for (const pk of creators) assert.equal(index.mightBeCreator(pk), true);
});

test('coins with no creator set do not enter the index', async () => {
  // Pre-fee-sharing curves carry an all-zero creator. Adding it would put the
  // default pubkey in the filter, which is nobody's wallet.
  const zero = new PublicKey(new Uint8Array(32));
  const real = keys(1)[0];
  const index = await buildCreatorIndex('http://rpc.test', {
    fetchImpl: stubFetch({ [PUMP_PROGRAM.toBase58()]: [zero, real, zero] }),
  });
  assert.equal(index.counts['bonding curves'], 3, 'all three were seen');
  assert.equal(index.added, 1, 'only the one with a creator was kept');
  assert.equal(index.mightBeCreator(real), true);
});

test('an index survives a round trip through a file', async () => {
  const creators = keys(4);
  const index = await buildCreatorIndex('http://rpc.test', {
    slot: 123456,
    fetchImpl: stubFetch({ [PUMP_PROGRAM.toBase58()]: creators }),
  });
  const restored = deserializeCreatorIndex(index.serialize());
  assert.equal(restored.slot, 123456);
  assert.equal(restored.counts['bonding curves'], 4);
  for (const pk of creators) assert.equal(restored.mightBeCreator(pk), true);
});

test('a cached index is reused, and a stale one is rebuilt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dfh-idx-'));
  const path = join(dir, 'creators.idx');
  const first = keys(2);
  const second = keys(2);
  const events = [];

  const built = await openCreatorIndex({
    rpcEndpoint: 'http://rpc.test',
    path,
    currentSlot: 1000,
    fetchImpl: stubFetch({ [PUMP_PROGRAM.toBase58()]: first }),
    onEvent: (e) => events.push(e.type),
  });
  assert.equal(built.mightBeCreator(first[0]), true);

  // Fresh: loaded from disk without touching the RPC at all.
  const reused = await openCreatorIndex({
    rpcEndpoint: 'http://rpc.test',
    path,
    currentSlot: 1100,
    fetchImpl: () => assert.fail('a fresh cached index must not hit the RPC'),
    onEvent: (e) => events.push(e.type),
  });
  assert.equal(reused.mightBeCreator(first[0]), true);

  // Stale: rebuilt, and the new content is what is returned.
  const rebuilt = await openCreatorIndex({
    rpcEndpoint: 'http://rpc.test',
    path,
    currentSlot: 1000 + 216_001,
    fetchImpl: stubFetch({ [PUMP_PROGRAM.toBase58()]: second }),
    onEvent: (e) => events.push(e.type),
  });
  assert.equal(rebuilt.mightBeCreator(second[0]), true);
  assert.equal(rebuilt.mightBeCreator(first[0]), false);

  assert.deepEqual(events, ['building', 'built', 'loaded', 'stale', 'building', 'built']);
});

test('a corrupt cache is rebuilt rather than trusted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dfh-idx-'));
  const path = join(dir, 'creators.idx');
  writeFileSync(path, Buffer.from('this is not an index'));
  const creators = keys(2);
  const events = [];

  const index = await openCreatorIndex({
    rpcEndpoint: 'http://rpc.test',
    path,
    currentSlot: 10,
    fetchImpl: stubFetch({ [PUMP_PROGRAM.toBase58()]: creators }),
    onEvent: (e) => events.push(e.type),
  });
  assert.equal(index.mightBeCreator(creators[0]), true);
  assert.deepEqual(events, ['unreadable', 'building', 'built']);
  // And the bad file was replaced, not left to fail again next run.
  assert.doesNotThrow(() => deserializeCreatorIndex(readFileSync(path)));
});
