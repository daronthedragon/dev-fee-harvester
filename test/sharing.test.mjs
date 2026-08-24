import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

import {
  PUMP_FEES_PROGRAM,
  PUMP_PROGRAM,
  SHARING_CONFIG_DISCRIMINATOR,
  SHARING_CONFIG_SIZE,
} from '../src/constants.mjs';
import {
  SHAREHOLDER_SLOTS,
  decodeSharingConfig,
  distributeCreatorFeesIx,
  distributableLamports,
  buildShareholderIndex,
  findConfigsForShareholder,
  isSharingConfig,
  shareFor,
} from '../src/sharing.mjs';
import { createLimiter, delay } from '../src/limit.mjs';
import { bondingCurve, pumpCreatorVault, sharingConfig } from '../src/pda.mjs';
import { packBatches, workItems } from '../src/claim.mjs';

/** Build a SharingConfig account body matching the on-chain layout. */
function buildConfig(mint, shareholders, { active = true, admin = PublicKey.default } = {}) {
  const data = Buffer.alloc(SHARING_CONFIG_SIZE);
  Buffer.from(SHARING_CONFIG_DISCRIMINATOR).copy(data, 0);
  data[8] = 255; // bump
  data[9] = 1; // version
  data[10] = active ? 1 : 0; // status
  mint.toBuffer().copy(data, 11);
  admin.toBuffer().copy(data, 43);
  data[75] = 0; // admin_revoked
  data.writeUInt32LE(shareholders.length, 76);
  shareholders.forEach((s, i) => {
    const o = 80 + i * 34;
    s.address.toBuffer().copy(data, o);
    data.writeUInt16LE(s.bps, o + 32);
  });
  return data;
}

const MINT = new PublicKey('HssQnt18QzfRznC2FjMDGhRE5XoxYmnVLYYkGYsXpump');

test('a sharing config decodes to its mint, status and shareholders', () => {
  const a = Keypair.generate().publicKey;
  const b = Keypair.generate().publicKey;
  const address = Keypair.generate().publicKey;
  const cfg = decodeSharingConfig(
    address,
    buildConfig(MINT, [
      { address: a, bps: 7000 },
      { address: b, bps: 3000 },
    ]),
  );

  assert.equal(cfg.mint.toBase58(), MINT.toBase58());
  assert.ok(cfg.active);
  assert.equal(cfg.shareholders.length, 2);
  assert.equal(cfg.shareholders[0].bps, 7000);
  assert.equal(cfg.shareholders[1].address.toBase58(), b.toBase58());
});

test('isSharingConfig demands both the pump_fees owner and the discriminator', () => {
  const data = buildConfig(MINT, []);
  assert.ok(isSharingConfig({ owner: PUMP_FEES_PROGRAM, data }));
  assert.ok(!isSharingConfig({ owner: PUMP_PROGRAM, data }), 'wrong owner must be rejected');
  const wrongDisc = Buffer.from(data);
  wrongDisc[0] ^= 0xff;
  assert.ok(!isSharingConfig({ owner: PUMP_FEES_PROGRAM, data: wrongDisc }));
  assert.ok(!isSharingConfig(null));
});

test('shares are split by basis points', () => {
  const me = Keypair.generate().publicKey;
  const them = Keypair.generate().publicKey;
  const cfg = decodeSharingConfig(
    Keypair.generate().publicKey,
    buildConfig(MINT, [
      { address: me, bps: 3400 },
      { address: them, bps: 6600 },
    ]),
  );

  assert.equal(shareFor(cfg, me, 1_000_000), 340_000);
  assert.equal(shareFor(cfg, them, 1_000_000), 660_000);
  assert.equal(
    shareFor(cfg, Keypair.generate().publicKey, 1_000_000),
    0,
    'a non-shareholder gets nothing',
  );
});

test('the vault keeps its rent-exempt floor', () => {
  assert.equal(distributableLamports(2_000_000), 2_000_000 - 890_880);
  assert.equal(distributableLamports(890_880), 0);
  assert.equal(distributableLamports(0), 0);
});

test('distribute_creator_fees matches the IDL account order and appends shareholders', () => {
  const a = Keypair.generate().publicKey;
  const b = Keypair.generate().publicKey;
  const address = sharingConfig(MINT);
  const cfg = decodeSharingConfig(
    address,
    buildConfig(MINT, [
      { address: a, bps: 5000 },
      { address: b, bps: 5000 },
    ]),
  );
  const ix = distributeCreatorFeesIx(cfg);

  assert.equal(
    ix.programId.toBase58(),
    PUMP_PROGRAM.toBase58(),
    'the crank lives on pump.fun, not pump_fees',
  );
  assert.equal(ix.keys.length, 7 + 2);
  assert.equal(ix.keys[0].pubkey.toBase58(), MINT.toBase58());
  assert.equal(ix.keys[1].pubkey.toBase58(), bondingCurve(MINT).toBase58());
  assert.equal(ix.keys[2].pubkey.toBase58(), address.toBase58());
  // The vault is derived from the config PDA, not from any wallet.
  assert.equal(ix.keys[3].pubkey.toBase58(), pumpCreatorVault(address).toBase58());
  assert.ok(ix.keys[3].isWritable, 'the vault is drained');
  assert.ok(
    ix.keys.every((k) => !k.isSigner),
    'distribution is permissionless',
  );
  // Shareholders come last, in stored order, all writable (error 6054).
  assert.equal(ix.keys[7].pubkey.toBase58(), a.toBase58());
  assert.equal(ix.keys[8].pubkey.toBase58(), b.toBase58());
  assert.ok(ix.keys[7].isWritable && ix.keys[8].isWritable);
});

test('shareholder slots are bounded by the fixed account size', () => {
  assert.equal(SHAREHOLDER_SLOTS, Math.floor((SHARING_CONFIG_SIZE - 80) / 34));
  assert.equal(SHAREHOLDER_SLOTS, 27);
});

const cfgFor = (mint, holder) =>
  decodeSharingConfig(sharingConfig(mint), buildConfig(mint, [{ address: holder, bps: 10000 }]));

test('each distribution is its own work item, needing no signature', () => {
  const kp = Keypair.generate();
  const mints = [MINT, new PublicKey('CyKe8fsA3U8povf4U59WLYQRn3RPohCgmSDibkmDWUPE')];
  const row = {
    publicKey: kp.publicKey,
    label: 'dev',
    secretKey: null,
    pumpLamports: 0,
    pumpswapLamports: 0,
    totalLamports: 0,
    distributions: mints.map((m) => ({
      config: cfgFor(m, kp.publicKey),
      mint: m,
      distributable: 5e8,
      userShare: 5e8,
    })),
  };
  const items = workItems(row, kp.publicKey);
  assert.equal(items.length, 2, 'one item per distribution');
  assert.ok(
    items.every((i) => i.kind === 'distribute' && i.signerWallet === null && !i.needsSigner),
  );
});

test('blocked distributions are excluded from the work list', () => {
  const kp = Keypair.generate();
  const row = {
    publicKey: kp.publicKey,
    label: 'dev',
    secretKey: null,
    pumpLamports: 0,
    pumpswapLamports: 0,
    totalLamports: 0,
    distributions: [
      {
        config: cfgFor(MINT, kp.publicKey),
        mint: MINT,
        distributable: 5e8,
        userShare: 5e8,
        blocked: 'SharingConfigNotActive',
      },
    ],
  };
  assert.equal(workItems(row, kp.publicKey).length, 0);
});

test('a wallet with many distributions spreads across transactions', () => {
  // Regression: treating the wallet as one atomic unit overflowed the 1232
  // byte limit and made every one of its distributions unclaimable.
  const kp = Keypair.generate();
  const mints = Array.from({ length: 13 }, () => Keypair.generate().publicKey);
  const row = {
    publicKey: kp.publicKey,
    label: 'dev',
    secretKey: null,
    pumpLamports: 0,
    pumpswapLamports: 0,
    totalLamports: 0,
    distributions: mints.map((m) => ({
      config: cfgFor(m, kp.publicKey),
      mint: m,
      distributable: 1e8,
      userShare: 1e8,
    })),
  };
  const payer = Keypair.generate().publicKey;
  const items = workItems(row, payer);
  assert.equal(items.length, 13);

  const blockhash = '11111111111111111111111111111111';
  const batches = packBatches(items, payer, { blockhash, maxPerTx: 8 });
  assert.ok(batches.length > 1, 'thirteen cranks cannot share one transaction');
  for (const b of batches) {
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions: b.instructions,
      }).compileToV0Message(),
    );
    assert.ok(tx.serialize().length <= 1232);
    assert.ok(!b.oversized, 'no single crank should be too large to send');
  }
  assert.equal(
    batches.reduce((n, b) => n + b.items.length, 0),
    13,
    'no distribution dropped',
  );
});

test('the shareholder sweep queries every slot through the supplied limiter', async () => {
  // --rpc-delay must reach these requests: 27 filtered getProgramAccounts per
  // wallet is the heaviest thing this tool asks an RPC for, and firing them
  // unpaced is what earns a 429.
  const offsets = [];
  let inFlight = 0;
  let peak = 0;
  const connection = {
    async getProgramAccounts(_program, { filters }) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      offsets.push(filters[1].memcmp.offset);
      await delay(3);
      inFlight--;
      return [];
    },
  };

  const limiter = createLimiter({ concurrency: 2 });
  const wallet = Keypair.generate().publicKey;
  const found = await findConfigsForShareholder(connection, wallet, { limiter });

  assert.deepEqual(found, [], 'no configs matched the stub');
  assert.equal(offsets.length, SHAREHOLDER_SLOTS, 'every shareholder slot is probed');
  assert.ok(peak <= 2, `limiter breached: peak concurrency ${peak}`);
  // Slots are the fixed strides the shareholder array occupies.
  assert.deepEqual(
    [...offsets].sort((a, b) => a - b),
    Array.from({ length: SHAREHOLDER_SLOTS }, (_, i) => 80 + i * 34),
  );
});

test('a slot that keeps failing throws instead of reporting no fees', async () => {
  const connection = {
    async getProgramAccounts() {
      throw new Error('429 Too Many Requests');
    },
  };
  await assert.rejects(
    () =>
      findConfigsForShareholder(connection, Keypair.generate().publicKey, {
        limiter: createLimiter({ concurrency: 4 }),
        attempts: 2,
      }),
    /shareholder slot \d+ failed after 2 attempts/,
  );
});

/* ------------------------------------------------- the shareholder index -- */

/**
 * A stand-in for the chain that honours dataSlice, because the index depends
 * on it: pass A reads a window of each config, and a stub that ignored the
 * slice would hide whether the overflow pass is doing anything.
 */
function chainWith(configs) {
  const byAddress = new Map(configs.map((c) => [c.address.toBase58(), c.data]));
  const calls = { getProgramAccounts: 0, getMultipleAccountsInfo: 0 };

  // A real JSON-RPC body, delivered in small chunks, so the streaming parser
  // is what gets exercised — including entries split across chunk boundaries.
  const fetchImpl = async (_url, init) => {
    calls.getProgramAccounts++;
    const { dataSlice } = JSON.parse(init.body).params[1];
    // pubkey before account, as mainnet actually emits it.
    const value = configs.map((c) => ({
      pubkey: c.address.toBase58(),
      account: {
        lamports: 1,
        data: [
          (dataSlice
            ? c.data.subarray(dataSlice.offset, dataSlice.offset + dataSlice.length)
            : c.data
          ).toString('base64'),
          'base64',
        ],
        owner: PUMP_FEES_PROGRAM.toBase58(),
        executable: false,
        rentEpoch: 0,
        space: c.data.length,
      },
    }));
    const text = JSON.stringify({ jsonrpc: '2.0', result: value, id: 1 });
    const bytes = Buffer.from(text, 'utf8');
    return {
      ok: true,
      status: 200,
      async text() {
        return text;
      },
      body: (async function* () {
        for (let i = 0; i < bytes.length; i += 17) yield bytes.subarray(i, i + 17);
      })(),
    };
  };

  return {
    calls,
    fetchImpl,
    rpcEndpoint: 'http://stub.invalid',
    async getMultipleAccountsInfo(addresses) {
      calls.getMultipleAccountsInfo++;
      return addresses.map((a) => {
        const data = byAddress.get(a.toBase58());
        return data ? { data, owner: PUMP_FEES_PROGRAM } : null;
      });
    },
  };
}

const configWith = (shareholders) => {
  const mint = Keypair.generate().publicKey;
  return { address: sharingConfig(mint), mint, data: buildConfig(mint, shareholders) };
};

test('the index finds a wallet sitting in the first slot', async () => {
  const me = Keypair.generate().publicKey;
  const chain = chainWith([
    configWith([{ address: me, bps: 10000 }]),
    configWith([{ address: Keypair.generate().publicKey, bps: 10000 }]),
  ]);
  const index = await buildShareholderIndex(chain, [me], { fetchImpl: chain.fetchImpl });
  assert.equal(index.get(me.toBase58())?.length, 1);
});

test('the index finds a wallet past the inlined slots', async () => {
  // The slice covers the first couple of shareholders; anything deeper is only
  // found because the overflow pass refetches those configs in full. Without
  // it this wallet would be silently missed — the exact failure this design
  // exists to prevent.
  const me = Keypair.generate().publicKey;
  const deep = Array.from({ length: 6 }, () => ({
    address: Keypair.generate().publicKey,
    bps: 1000,
  }));
  deep[5] = { address: me, bps: 5000 };
  const chain = chainWith([configWith(deep)]);

  const index = await buildShareholderIndex(chain, [me], { fetchImpl: chain.fetchImpl });
  assert.equal(index.get(me.toBase58())?.length, 1, 'found despite sitting in slot 6');
  assert.equal(index.get(me.toBase58())[0].shareholders.length, 6, 'full record, not the slice');
});

test('a wallet that holds no shares gets nothing', async () => {
  const chain = chainWith([configWith([{ address: Keypair.generate().publicKey, bps: 10000 }])]);
  const index = await buildShareholderIndex(chain, [Keypair.generate().publicKey], {
    fetchImpl: chain.fetchImpl,
  });
  assert.equal(index.size, 0);
});

test('the configs are read once however many wallets are asked about', async () => {
  // This is the whole point: the per-wallet sweep costs 27 filtered requests
  // each, so a hundred wallets cost 2,700. Here it stays at one.
  const wallets = Array.from({ length: 100 }, () => Keypair.generate().publicKey);
  const chain = chainWith([
    configWith([
      { address: wallets[0], bps: 6000 },
      { address: wallets[1], bps: 4000 },
    ]),
    configWith([{ address: wallets[99], bps: 10000 }]),
  ]);

  const index = await buildShareholderIndex(chain, wallets, { fetchImpl: chain.fetchImpl });
  assert.equal(chain.calls.getProgramAccounts, 1, 'one pass over the configs');
  assert.equal(index.get(wallets[0].toBase58())?.length, 1);
  assert.equal(index.get(wallets[1].toBase58())?.length, 1);
  assert.equal(index.get(wallets[99].toBase58())?.length, 1);
});

test('one wallet holding several shares collects them all', async () => {
  const me = Keypair.generate().publicKey;
  const chain = chainWith([
    configWith([{ address: me, bps: 10000 }]),
    configWith([
      { address: Keypair.generate().publicKey, bps: 5000 },
      { address: me, bps: 5000 },
    ]),
    configWith([{ address: Keypair.generate().publicKey, bps: 10000 }]),
  ]);
  const index = await buildShareholderIndex(chain, [me], { fetchImpl: chain.fetchImpl });
  assert.equal(index.get(me.toBase58())?.length, 2);
});

test('asking about no wallets does not read the chain at all', async () => {
  const chain = chainWith([configWith([{ address: Keypair.generate().publicKey, bps: 10000 }])]);
  const index = await buildShareholderIndex(chain, [], { fetchImpl: chain.fetchImpl });
  assert.equal(index.size, 0);
  assert.equal(chain.calls.getProgramAccounts, 0);
});
