/**
 * Re-derives every on-chain constant this tool depends on, straight from the
 * programs' own Anchor IDLs, and regenerates src/errors.mjs.
 *   node scripts/verify-onchain.mjs
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { encodeBase58 } from '../src/base58.mjs';
import { inflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { format, resolveConfig } from 'prettier';
import { CREATOR_SOURCES } from '../src/creator-index.mjs';
import {
  DISCRIMINATORS,
  PUMPSWAP_PROGRAM,
  PUMP_FEES_PROGRAM,
  PUMP_PROGRAM,
  SHARING_CONFIG_DISCRIMINATOR,
} from '../src/constants.mjs';

const c = new Connection(process.env.RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');

async function getIdl(programId) {
  const [base] = PublicKey.findProgramAddressSync([], programId);
  const acc = await c.getAccountInfo(await PublicKey.createWithSeed(base, 'anchor:idl', programId));
  if (!acc) throw new Error(`no on-chain IDL for ${programId.toBase58()}`);
  return JSON.parse(
    inflateSync(acc.data.subarray(44, 44 + acc.data.readUInt32LE(40))).toString('utf8'),
  );
}

const disc = (name) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `\n        expected ${expected}\n        actual   ${actual}`}`,
  );
};

const pump = await getIdl(PUMP_PROGRAM);
const amm = await getIdl(PUMPSWAP_PROGRAM);

console.log('discriminators:');
check(
  'collect_creator_fee',
  [...disc('collect_creator_fee')].join(','),
  [...DISCRIMINATORS.collect_creator_fee].join(','),
);
check(
  'collect_coin_creator_fee',
  [...disc('collect_coin_creator_fee')].join(','),
  [...DISCRIMINATORS.collect_coin_creator_fee].join(','),
);

console.log('account order:');
const order = (idl, n) =>
  idl.instructions
    .find((i) => i.name === n)
    .accounts.map((a) => a.name)
    .join(',');
check(
  'collect_creator_fee',
  order(pump, 'collect_creator_fee'),
  'creator,creator_vault,system_program,event_authority,program',
);
check(
  'collect_coin_creator_fee',
  order(amm, 'collect_coin_creator_fee'),
  'quote_mint,quote_token_program,coin_creator,coin_creator_vault_authority,coin_creator_vault_ata,coin_creator_token_account,event_authority,program',
);

console.log('pda seeds:');
const seedOf = (idl, ix, acct) => {
  const a = idl.instructions.find((i) => i.name === ix).accounts.find((x) => x.name === acct);
  return Buffer.from(a.pda.seeds[0].value).toString();
};
check(
  'pump creator vault seed',
  seedOf(pump, 'collect_creator_fee', 'creator_vault'),
  'creator-vault',
);
check(
  'pumpswap creator vault seed',
  seedOf(amm, 'collect_coin_creator_fee', 'coin_creator_vault_authority'),
  'creator_vault',
);
check(
  'bonding curve seed',
  seedOf(pump, 'distribute_creator_fees', 'bonding_curve'),
  'bonding-curve',
);
check(
  'sharing config seed',
  seedOf(pump, 'distribute_creator_fees', 'sharing_config'),
  'sharing-config',
);

console.log('fee sharing:');
check(
  'distribute_creator_fees discriminator',
  [...disc('distribute_creator_fees')].join(','),
  [...DISCRIMINATORS.distribute_creator_fees].join(','),
);
check(
  'distribute_creator_fees account order',
  order(pump, 'distribute_creator_fees'),
  'mint,bonding_curve,sharing_config,creator_vault,system_program,event_authority,program',
);
check(
  'SharingConfig account discriminator',
  [...createHash('sha256').update('account:SharingConfig').digest().subarray(0, 8)].join(','),
  [...SHARING_CONFIG_DISCRIMINATOR].join(','),
);

// Sharing configs live under pump_fees, not pump.fun. The IDL states which
// program owns that PDA, so take the address from there rather than trusting
// a constant someone typed.
const scPdaProgram = new PublicKey(
  Uint8Array.from(
    pump.instructions
      .find((i) => i.name === 'distribute_creator_fees')
      .accounts.find((a) => a.name === 'sharing_config').pda.program.value,
  ),
);
check(
  'pump_fees program (from IDL pda override)',
  scPdaProgram.toBase58(),
  PUMP_FEES_PROGRAM.toBase58(),
);
const feesInfo = await c.getAccountInfo(PUMP_FEES_PROGRAM);
check('pump_fees is an executable program', String(Boolean(feesInfo?.executable)), 'true');

console.log('creator index:');
// The creator index reads one 32-byte field out of eight million accounts.
// If a program moves that field, the index silently fills with the wrong
// bytes and every wallet gets skipped as "not a creator" - a wrong answer
// that looks exactly like a correct one. Re-derive the offsets here.
const FIELD_SIZES = { u8: 1, bool: 1, u16: 2, u32: 4, u64: 8, u128: 16, pubkey: 32, i64: 8 };
const offsetOf = (idl, account, field) => {
  // Anchor 0.30 leaves `accounts` as names only and puts the layout in `types`.
  const type = [...(idl.accounts ?? []), ...(idl.types ?? [])].find(
    (a) => a.name === account && a.type?.fields,
  )?.type;
  if (!type) return `no layout for ${account}`;
  let off = 8; // anchor discriminator
  for (const f of type.fields) {
    if (f.name === field) return off;
    const size = FIELD_SIZES[f.type];
    if (!size) return `unsized field ${f.name} (${JSON.stringify(f.type)}) before ${field}`;
    off += size;
  }
  return `no field ${field} on ${account}`;
};
check(
  'BondingCurve.creator offset',
  offsetOf(pump, 'BondingCurve', 'creator'),
  CREATOR_SOURCES[0].creatorOffset,
);
check(
  'Pool.coin_creator offset',
  offsetOf(amm, 'Pool', 'coin_creator'),
  CREATOR_SOURCES[1].creatorOffset,
);
const accountDisc = (n) => createHash('sha256').update(`account:${n}`).digest().subarray(0, 8);
check(
  'BondingCurve account discriminator',
  encodeBase58(accountDisc('BondingCurve')),
  CREATOR_SOURCES[0].discriminator,
);
check(
  'Pool account discriminator',
  encodeBase58(accountDisc('Pool')),
  CREATOR_SOURCES[1].discriminator,
);

const errors = {};
for (const [prefix, idl] of [
  ['pump', pump],
  ['pumpswap', amm],
])
  for (const e of idl.errors ?? [])
    errors[e.code] ??= { name: e.name, msg: e.msg ?? null, program: prefix };

// Formatted on the way out. JSON.stringify and Prettier disagree about where
// to break these objects, so writing it raw left the file failing the format
// check and produced a 360-line diff every time this script ran.
const generated = await format(
  `// GENERATED by scripts/verify-onchain.mjs from the on-chain Anchor IDLs.\n// Do not edit by hand; run \`npm run verify:onchain\` to refresh.\nexport const PROGRAM_ERRORS = ${JSON.stringify(errors, null, 2)};\n`,
  {
    ...(await resolveConfig('src/errors.mjs')),
    parser: 'babel',
  },
);
writeFileSync(new URL('../src/errors.mjs', import.meta.url), generated);
console.log(`\nwrote src/errors.mjs (${Object.keys(errors).length} error codes)`);
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
