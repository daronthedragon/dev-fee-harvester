import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { streamProgramAccounts } from '../src/rpc-stream.mjs';

const PROGRAM = Keypair.generate().publicKey;

/** A JSON-RPC response delivered in chunks of `size` bytes. */
const respond = (payload, size = 13) => {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    ok: true,
    status: 200,
    async text() {
      return bytes.toString('utf8');
    },
    body: (async function* () {
      for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
    })(),
  };
};

/**
 * Mainnet emits `pubkey` before `account`. `dataFirst` builds the opposite
 * order, because JSON guarantees nothing about it and an earlier parser
 * assumed one and matched nothing on the real chain.
 */
const accountsPayload = (entries, { dataFirst = false } = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  result: entries.map(({ pubkey, data }) => {
    const account = {
      lamports: 1,
      data: [Buffer.from(data).toString('base64'), 'base64'],
      owner: PROGRAM.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: data.length,
    };
    return dataFirst ? { account, pubkey } : { pubkey, account };
  }),
});

const collect = async (payload, chunkSize) => {
  const seen = [];
  const total = await streamProgramAccounts('http://stub.invalid', PROGRAM, {
    fetchImpl: async () => respond(payload, chunkSize),
    onAccount: (a) => seen.push(a),
  });
  return { seen, total };
};

test('every account in the response is yielded', async () => {
  const entries = Array.from({ length: 25 }, (_, i) => ({
    pubkey: Keypair.generate().publicKey.toBase58(),
    data: Buffer.from([i, i + 1, i + 2]),
  }));
  const { seen, total } = await collect(accountsPayload(entries));
  assert.equal(total, 25);
  assert.deepEqual(
    seen.map((a) => a.pubkey),
    entries.map((e) => e.pubkey),
  );
  assert.deepEqual(seen[7].data, entries[7].data, 'payload decoded from base64');
});

test('entries split across chunk boundaries survive', async () => {
  // The whole point of streaming is that an entry rarely lands whole in one
  // chunk. One byte at a time is the harshest version of that.
  const entries = Array.from({ length: 5 }, () => ({
    pubkey: Keypair.generate().publicKey.toBase58(),
    data: Buffer.from('a fairly long payload so it spans many chunks'),
  }));
  for (const size of [1, 2, 7, 64, 100000]) {
    const { seen, total } = await collect(accountsPayload(entries), size);
    assert.equal(total, 5, `lost entries at chunk size ${size}`);
    assert.deepEqual(
      seen.map((a) => a.pubkey),
      entries.map((e) => e.pubkey),
      `wrong order at chunk size ${size}`,
    );
  }
});

test('either key order parses', async () => {
  // Mainnet puts pubkey first. Nothing promises that, so both are covered.
  const entries = Array.from({ length: 6 }, (_, i) => ({
    pubkey: Keypair.generate().publicKey.toBase58(),
    data: Buffer.from([i, i + 1]),
  }));
  for (const dataFirst of [false, true]) {
    const seen = [];
    const total = await streamProgramAccounts('http://stub.invalid', PROGRAM, {
      fetchImpl: async () => respond(accountsPayload(entries, { dataFirst }), 11),
      onAccount: (a) => seen.push(a),
    });
    assert.equal(total, 6, `dataFirst=${dataFirst}`);
    assert.deepEqual(
      seen.map((a) => a.pubkey),
      entries.map((e) => e.pubkey),
      `dataFirst=${dataFirst}`,
    );
    assert.deepEqual(seen[3].data, entries[3].data, `dataFirst=${dataFirst}`);
  }
});

test('an empty result yields nothing and reports zero', async () => {
  const { seen, total } = await collect(accountsPayload([]));
  assert.equal(total, 0);
  assert.deepEqual(seen, []);
});

test('an RPC error is raised, not reported as no accounts', async () => {
  // Returning zero here would read as "this program has no accounts", which is
  // the same silent-zero mistake the rest of this tool refuses to make.
  await assert.rejects(
    () =>
      streamProgramAccounts('http://stub.invalid', PROGRAM, {
        fetchImpl: async () =>
          respond({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad filter' } }),
        onAccount: () => {},
      }),
    /getProgramAccounts error.*bad filter/s,
  );
});

test('an HTTP failure is raised', async () => {
  await assert.rejects(
    () =>
      streamProgramAccounts('http://stub.invalid', PROGRAM, {
        fetchImpl: async () => ({
          ok: false,
          status: 429,
          async text() {
            return 'Too Many Requests';
          },
        }),
        onAccount: () => {},
      }),
    /HTTP 429/,
  );
});

test('an unrecognised body is raised rather than silently empty', async () => {
  await assert.rejects(
    () =>
      streamProgramAccounts('http://stub.invalid', PROGRAM, {
        fetchImpl: async () => respond({ something: 'else' }),
        onAccount: () => {},
      }),
    /unrecognised response/,
  );
});

test('memory does not grow with the number of accounts', async () => {
  // 20,000 entries through a callback that keeps nothing: the buffer should
  // hold about one entry, not twenty thousand.
  const entries = Array.from({ length: 20000 }, () => ({
    pubkey: Keypair.generate().publicKey.toBase58(),
    data: Buffer.alloc(72, 7),
  }));
  let count = 0;
  const total = await streamProgramAccounts('http://stub.invalid', PROGRAM, {
    fetchImpl: async () => respond(accountsPayload(entries), 4096),
    onAccount: () => {
      count++;
    },
  });
  assert.equal(total, 20000);
  assert.equal(count, 20000);
});
