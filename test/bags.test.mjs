import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Keypair, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js';
import { decodeBase58, encodeBase58 } from '../src/base58.mjs';
import { BagsApiError, BagsClient, claimBags, positionMint, scanBags } from '../src/bags.mjs';

/* ---------------------------------------------------------------- base58 -- */

test('base58 round-trips a real public key', () => {
  const pk = Keypair.generate().publicKey;
  assert.equal(encodeBase58(pk.toBytes()), pk.toBase58());
  assert.deepEqual(Buffer.from(decodeBase58(pk.toBase58())), Buffer.from(pk.toBytes()));
});

test('base58 preserves leading zero bytes', () => {
  // Leading zeros encode as '1' characters; dropping them corrupts an address.
  const bytes = Uint8Array.from([0, 0, 5, 9, 200]);
  const encoded = encodeBase58(bytes);
  assert.ok(encoded.startsWith('11'), `expected two leading ones, got ${encoded}`);
  assert.deepEqual(Buffer.from(decodeBase58(encoded)), Buffer.from(bytes));
});

test('base58 round-trips a payload the size of a transaction', () => {
  const bytes = Uint8Array.from({ length: 1100 }, (_, i) => (i * 7) % 256);
  assert.deepEqual(Buffer.from(decodeBase58(encodeBase58(bytes))), Buffer.from(bytes));
});

test('base58 rejects characters outside the alphabet', () => {
  assert.throws(() => decodeBase58('abc0def'), /invalid base58/);  // 0 is not in the alphabet
});

/* ------------------------------------------------------------- stub setup -- */

const WALLET = Keypair.generate();
const MINT = Keypair.generate().publicKey;

/** A response in Bags' envelope shape. */
const ok = (response) => ({
  ok: true, status: 200, text: async () => JSON.stringify({ success: true, response }),
});
const fail = (error, status = 400) => ({
  ok: false, status, text: async () => JSON.stringify({ success: false, error }),
});

function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  return { impl, calls };
}

const clientWith = (handler) => {
  const { impl, calls } = recordingFetch(handler);
  return { client: new BagsClient({ apiKey: 'test-key', fetchImpl: impl }), calls };
};

/** A real, serialisable legacy transaction, base58 encoded as Bags sends it. */
function encodedTransaction(feePayer) {
  const tx = new Transaction();
  tx.add(SystemProgram.transfer({
    fromPubkey: feePayer, toPubkey: Keypair.generate().publicKey, lamports: 1000,
  }));
  tx.feePayer = feePayer;
  tx.recentBlockhash = '11111111111111111111111111111111';
  return encodeBase58(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

/* ----------------------------------------------------------------- client -- */

test('an API key is required', () => {
  assert.throws(() => new BagsClient({}), /BAGS_API_KEY is required/);
});

test('claimable positions hits the documented path with the wallet as a query param', async () => {
  const { client, calls } = clientWith(() => ok([]));
  await client.claimablePositions(WALLET.publicKey);

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/v1/token-launch/claimable-positions');
  assert.equal(url.searchParams.get('wallet'), WALLET.publicKey.toBase58());
  assert.equal(calls[0].init.headers['x-api-key'], 'test-key');
});

test('the {success, response} envelope is unwrapped', async () => {
  const positions = [{ baseMint: MINT.toBase58(), totalClaimableLamportsUserShare: 42 }];
  const { client } = clientWith(() => ok(positions));
  assert.deepEqual(await client.claimablePositions(WALLET.publicKey), positions);
});

test('a failure envelope throws with the API message, even on HTTP 200', async () => {
  // Bags can report failure with a 200, so the envelope wins over the status.
  const { client } = clientWith(() => ({
    ok: true, status: 200, text: async () => JSON.stringify({ success: false, error: 'invalid api key' }),
  }));
  await assert.rejects(() => client.claimablePositions(WALLET.publicKey), (err) => {
    assert.ok(err instanceof BagsApiError);
    assert.match(err.message, /invalid api key/);
    return true;
  });
});

test('an HTTP error is surfaced rather than parsed as data', async () => {
  const { client } = clientWith(() => fail('unauthorized', 401));
  await assert.rejects(() => client.claimablePositions(WALLET.publicKey), /unauthorized/);
});

test('a non-JSON body is reported, not swallowed', async () => {
  const { client } = clientWith(() => ({ ok: false, status: 502, text: async () => '<html>bad gateway</html>' }));
  await assert.rejects(() => client.claimablePositions(WALLET.publicKey), /non-JSON \(status 502\)/);
});

test('claimable lamports sum the user share across positions', async () => {
  const { client } = clientWith(() => ok([
    { baseMint: MINT.toBase58(), totalClaimableLamportsUserShare: 1_000_000 },
    { baseMint: MINT.toBase58(), totalClaimableLamportsUserShare: 2_500_000 },
    { baseMint: MINT.toBase58() },
  ]));
  assert.equal(await client.claimableLamports(WALLET.publicKey), 3_500_000);
});

/* ------------------------------------------------------------ claim-txs -- */

test('claim transactions post feeClaimer and tokenMint, not wallet', async () => {
  // The SDK sends `feeClaimer`. Sending `wallet` is silently accepted-looking
  // but claims nothing, which is exactly the bug this test exists to catch.
  const { client, calls } = clientWith(() => ok([{ tx: encodedTransaction(WALLET.publicKey) }]));
  await client.claimTransactions(WALLET.publicKey, MINT);

  const body = JSON.parse(calls[0].init.body);
  assert.equal(new URL(calls[0].url).pathname, '/api/v1/token-launch/claim-txs/v3');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(body.feeClaimer, WALLET.publicKey.toBase58());
  assert.equal(body.tokenMint, MINT.toBase58());
  assert.equal(body.wallet, undefined, 'the field is feeClaimer, not wallet');
});

test('returned transactions decode from base58 into signable legacy transactions', async () => {
  const encoded = encodedTransaction(WALLET.publicKey);
  const { client } = clientWith(() => ok([{ tx: encoded }]));

  const [tx] = await client.claimTransactions(WALLET.publicKey, MINT);
  assert.ok(tx instanceof Transaction, 'Bags returns legacy transactions, not versioned ones');
  assert.equal(tx.instructions.length, 1);
  assert.equal(tx.feePayer.toBase58(), WALLET.publicKey.toBase58());

  // The real proof: it survives a signature and re-serialisation.
  tx.partialSign(WALLET);
  assert.ok(tx.serialize().length > 0);
  assert.equal(tx.signatures[0].publicKey.toBase58(), WALLET.publicKey.toBase58());
});

test('a base64 payload would not decode as base58', async () => {
  // Guards the encoding choice itself: base64 of the same bytes must not be
  // mistaken for a valid transaction.
  const raw = Buffer.from(decodeBase58(encodedTransaction(WALLET.publicKey)));
  const { client } = clientWith(() => ok([{ tx: raw.toString('base64') }]));
  await assert.rejects(() => client.claimTransactions(WALLET.publicKey, MINT));
});

test('a malformed claim entry is reported', async () => {
  const { client } = clientWith(() => ok([{ notTx: 'nope' }]));
  await assert.rejects(() => client.claimTransactions(WALLET.publicKey, MINT), /no "tx" field/);
});

/* --------------------------------------------------------------- helpers -- */

test('positionMint reads the mint from any position variant', () => {
  assert.equal(positionMint({ baseMint: 'A' }), 'A');
  assert.equal(positionMint({ tokenMint: 'B' }), 'B');
  assert.equal(positionMint({}), null);
});

test('a scan failure is recorded on the row instead of reading as zero fees', async () => {
  const { client } = clientWith(() => fail('rate limited', 429));
  const [row] = await scanBags(client, [{ publicKey: WALLET.publicKey, label: 'w' }]);
  assert.equal(row.bagsLamports, 0);
  assert.match(row.bagsError, /rate limited/, 'the failure must be visible, not silent');
});

test('a successful scan attaches the claimable total', async () => {
  const { client } = clientWith(() => ok([{ baseMint: MINT.toBase58(), totalClaimableLamportsUserShare: 7_000_000 }]));
  const [row] = await scanBags(client, [{ publicKey: WALLET.publicKey, label: 'w' }]);
  assert.equal(row.bagsLamports, 7_000_000);
  assert.equal(row.bagsError, null);
});

test('claiming refuses a watch-only wallet', async () => {
  const { client } = clientWith(() => ok([]));
  const results = await claimBags({}, client, [{ publicKey: WALLET.publicKey, label: 'watch', secretKey: null }]);
  assert.equal(results[0].ok, false);
  assert.match(results[0].err, /watch-only/);
});

test('claiming signs and simulates what Bags returned', async () => {
  const encoded = encodedTransaction(WALLET.publicKey);
  const { client } = clientWith((url) => url.includes('claimable-positions')
    ? ok([{ baseMint: MINT.toBase58(), totalClaimableLamportsUserShare: 5_000_000 }])
    : ok([{ tx: encoded }]));

  let simulated = null;
  const connection = {
    async getLatestBlockhash() { return { blockhash: '11111111111111111111111111111111' }; },
    async simulateTransaction(tx) { simulated = tx; return { value: { err: null, logs: ['ok'] } }; },
  };

  const results = await claimBags(connection, client,
    [{ publicKey: WALLET.publicKey, label: 'dev', secretKey: WALLET.secretKey }], { dryRun: true });

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].lamports, 5_000_000);
  assert.ok(simulated, 'the transaction reached simulateTransaction');
  assert.ok(simulated.signatures.some((s) => s.signature !== null), 'it was signed locally before simulating');
});

test('positions with nothing claimable are skipped', async () => {
  const { client } = clientWith((url) => url.includes('claimable-positions')
    ? ok([{ baseMint: MINT.toBase58(), totalClaimableLamportsUserShare: 0 }])
    : ok([]));
  const results = await claimBags({}, client,
    [{ publicKey: WALLET.publicKey, label: 'dev', secretKey: WALLET.secretKey }], { dryRun: true });
  assert.equal(results.length, 0);
});
