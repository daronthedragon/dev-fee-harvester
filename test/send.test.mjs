import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { claimAll } from '../src/claim.mjs';

/**
 * A chain that expires blockhashes the way the real one does.
 *
 * A blockhash is valid for 150 slots — roughly a minute. Confirming a
 * transaction costs slots, so a long run of transactions signed against a
 * single blockhash will start being rejected partway through. That is the
 * behaviour modelled here: `slotsPerSend` stands in for the wall-clock cost of
 * sending and confirming one batch.
 */
function fakeChain({ slotsPerSend = 40, lifetime = 150 } = {}) {
  const state = { height: 1000, issued: new Map(), sent: [], rejected: 0, hashes: 0 };
  return {
    state,
    async getLatestBlockhash() {
      // A blockhash is 32 bytes base58, and the compiler decodes it, so a
      // stand-in has to be the real shape rather than a readable label.
      const blockhash = Keypair.generate().publicKey.toBase58();
      state.hashes++;
      const lastValidBlockHeight = state.height + lifetime;
      state.issued.set(blockhash, lastValidBlockHeight);
      return { blockhash, lastValidBlockHeight };
    },
    async sendTransaction(tx) {
      const hash = tx.message.recentBlockhash;
      state.height += slotsPerSend;
      if (state.height > (state.issued.get(hash) ?? -1)) {
        state.rejected++;
        const err = new Error('failed to send transaction: Blockhash not found');
        err.name = 'SendTransactionError';
        throw err;
      }
      const signature = `sig-${state.sent.length + 1}`;
      state.sent.push({ signature, hash });
      return signature;
    },
    async confirmTransaction() {
      return { value: { err: null } };
    },
  };
}

/** Enough distinct funded wallets to need `count` transactions at 1 per tx. */
function rows(count) {
  return Array.from({ length: count }, (_, i) => {
    const kp = Keypair.generate();
    return {
      publicKey: kp.publicKey,
      secretKey: kp.secretKey,
      label: `w${i}`,
      pumpLamports: 1e8,
      pumpswapLamports: 0,
      totalLamports: 1e8,
      status: 'ready',
    };
  });
}

test('a long claim run does not die when the first blockhash expires', async () => {
  const chain = fakeChain({ slotsPerSend: 40 });
  const payerKp = Keypair.generate();
  const payer = { publicKey: payerKp.publicKey, label: 'payer', secretKey: payerKp.secretKey };

  const results = await claimAll(chain, rows(12), payer, { dryRun: false, maxPerTx: 1 });

  const failed = results.filter((r) => !r.ok);
  assert.equal(
    failed.length,
    0,
    `every batch should land; ${failed.length} of ${results.length} were rejected as stale`,
  );
  assert.equal(chain.state.sent.length, 12);
});

test('every sent transaction is reported with its signature', async () => {
  const chain = fakeChain({ slotsPerSend: 40 });
  const payerKp = Keypair.generate();
  const payer = { publicKey: payerKp.publicKey, label: 'payer', secretKey: payerKp.secretKey };

  const results = await claimAll(chain, rows(8), payer, { dryRun: false, maxPerTx: 1 });
  for (const r of results) {
    assert.ok(r.signature, `batch ${r.label} landed but reported no signature`);
  }
});

/**
 * A chain where confirmation always times out, and the caller decides what
 * really happened to the signature afterwards.
 */
function flakyConfirm(outcome) {
  const state = { sends: 0, statusChecks: 0, signatures: [] };
  return {
    state,
    async getLatestBlockhash() {
      return {
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 1000,
      };
    },
    async sendTransaction() {
      const signature = `sig-${++state.sends}`;
      state.signatures.push(signature);
      return signature;
    },
    async confirmTransaction() {
      const err = new Error('Transaction was not confirmed in 30.00 seconds');
      err.name = 'TransactionExpiredBlockheightExceededError';
      throw err;
    },
    async getSignatureStatus(signature) {
      state.statusChecks++;
      return { value: outcome(signature, state) };
    },
  };
}

const onePayer = () => {
  const kp = Keypair.generate();
  return { publicKey: kp.publicKey, label: 'payer', secretKey: kp.secretKey };
};

test('a claim that landed after the wait gave up is reported as a success', async () => {
  // The client stopped watching; the chain did not stop working. Reporting
  // this as a failure tells someone their fees are unclaimed when they are in
  // their wallet.
  const chain = flakyConfirm(() => ({ err: null }));
  const results = await claimAll(chain, rows(1), onePayer(), { dryRun: false, maxPerTx: 1 });

  assert.equal(results[0].ok, true);
  assert.equal(results[0].signature, 'sig-1');
  assert.equal(chain.state.sends, 1, 'a transaction that landed must never be sent again');
});

test('a claim that never landed is retried, not abandoned', async () => {
  // Absent from the chain with the blockhash expired means it can never land,
  // so resending cannot double-claim. Succeed on the third look.
  const chain = flakyConfirm((sig) => (sig === 'sig-3' ? { err: null } : null));
  const results = await claimAll(chain, rows(1), onePayer(), { dryRun: false, maxPerTx: 1 });

  assert.equal(results[0].ok, true);
  assert.equal(results[0].signature, 'sig-3');
  assert.equal(results[0].attempts, 3);
});

test('a reverted transaction is reported with its signature, and not resent', async () => {
  const chain = flakyConfirm(() => ({ err: { InstructionError: [0, { Custom: 6050 }] } }));
  const results = await claimAll(chain, rows(1), onePayer(), { dryRun: false, maxPerTx: 1 });

  assert.equal(results[0].ok, false);
  assert.match(results[0].err, /reverted/);
  assert.equal(results[0].signature, 'sig-1');
  assert.equal(chain.state.sends, 1, 'a transaction that reverted on chain must not be resent');
});

test('an unreadable status stops rather than risking a double claim', async () => {
  // Not confirmed, and the chain could not be asked. Sending again might claim
  // twice, so the run reports the signature and leaves it to a human.
  const chain = flakyConfirm(() => {
    throw new Error('429 Too Many Requests');
  });
  const results = await claimAll(chain, rows(1), onePayer(), { dryRun: false, maxPerTx: 1 });

  assert.equal(results[0].ok, false);
  assert.equal(results[0].indeterminate, true);
  assert.match(results[0].err, /sig-1/, 'the signature has to be in the message to be checkable');
  assert.equal(chain.state.sends, 1, 'an unknown outcome must never be resent');
});

test('retries are reported as they happen, not just in the final result', async () => {
  const chain = flakyConfirm((sig) => (sig === 'sig-2' ? { err: null } : null));
  const events = [];
  await claimAll(chain, rows(1), onePayer(), {
    dryRun: false,
    maxPerTx: 1,
    onEvent: (e) => events.push(e),
  });

  const retries = events.filter((e) => e.type === 'retry');
  assert.equal(retries.length, 1);
  assert.match(retries[0].reason, /never landed/);
});

test('a dry run never asks for a signing key or sends anything', async () => {
  let sent = 0;
  const chain = {
    async getLatestBlockhash() {
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 };
    },
    async sendTransaction() {
      sent++;
      return 'nope';
    },
    async simulateTransaction() {
      return { value: { err: null, logs: [] } };
    },
  };
  const watchOnly = { publicKey: Keypair.generate().publicKey, label: 'watch', secretKey: null };
  const row = { ...rows(1)[0], secretKey: null };
  const results = await claimAll(chain, [row], watchOnly, { dryRun: true, maxPerTx: 1 });

  assert.equal(sent, 0);
  assert.equal(results[0].simulated, true);
  assert.equal(results[0].ok, true);
});
