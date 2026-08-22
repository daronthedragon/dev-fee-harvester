#!/usr/bin/env node
import { Connection, PublicKey } from '@solana/web3.js';
import process from 'node:process';
import { LAMPORTS_PER_SOL } from '../src/constants.mjs';
import { BagsClient, claimBags, scanBags } from '../src/bags.mjs';
import { claimAll, isActionable, movedLamports } from '../src/claim.mjs';
import { c, pad, padStart, sol, statusTag } from '../src/format.mjs';
import { loadWallets } from '../src/keys.mjs';
import { preflight } from '../src/preflight.mjs';
import { scanWallets } from '../src/scan.mjs';
import { attachDistributions } from '../src/sharing.mjs';
import { multiSelect } from '../src/select.mjs';
import { startDashboard } from '../src/server.mjs';

const HELP = `
${c.bold('dev-fee-harvester')} — mass-select developer wallets and claim their creator fees.

  ${c.bold('harvest scan')}        read claimable fees across every wallet
  ${c.bold('harvest claim')}       pick wallets interactively, then claim in batched transactions
  ${c.bold('harvest dashboard')}   same thing in a browser, with checkboxes

${c.bold('Options')}
  --wallets <path>     wallets JSON file, or a directory of keypair files  (env WALLETS, default ./wallets.json)
  --rpc <url>          RPC endpoint (env RPC, default mainnet-beta public)
  --payer <key>        wallet that pays the fees, by label or pubkey (default: first signing wallet)
  --min <sol>          ignore wallets below this claimable amount (default 0)
  --all                take every claimable wallet, no interactive picker
  --execute            actually send. Without it everything is simulated only.
  --priority-fee <n>   compute unit price in micro-lamports (default 0)
  --max-per-tx <n>     wallets per transaction (default 8)
  --no-preflight       skip the per-wallet simulation pass
  --find-shares        also hunt fees held for you in team sharing configs (slower)
  --bags               also scan/claim Bags positions (needs BAGS_API_KEY)
  --port <n>           dashboard port (default 4600)
  --json               machine-readable output for scan

${c.dim('Claiming is a dry run unless you pass --execute.')}
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

const die = (msg) => { console.error(c.red(`error: ${msg}`)); process.exit(1); };

async function loadAndScan(args, { requireSigner = false } = {}) {
  const walletsPath = args.wallets ?? process.env.WALLETS ?? './wallets.json';
  const rpc = args.rpc ?? process.env.RPC ?? 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpc, 'confirmed');

  const wallets = await loadWallets(walletsPath).catch((e) => die(e.message));
  if (wallets.length === 0) die('no wallets found');
  console.error(c.dim(`${wallets.length} wallet(s) from ${walletsPath} · ${new URL(rpc).host}`));

  let rows = await scanWallets(connection, wallets, {
    onProgress: (n, total) => process.stderr.write(`\r${c.dim(`scanning ${n}/${total} accounts`)}`),
  });
  process.stderr.write('\r\x1b[K');

  if (args.bags) {
    const client = new BagsClient({ apiKey: process.env.BAGS_API_KEY });
    rows = await scanBags(client, rows, {
      onProgress: (n, total) => process.stderr.write(`\r${c.dim(`bags ${n}/${total}`)}`),
    });
    process.stderr.write('\r\x1b[K');
    rows = rows.map((r) => ({ ...r, totalLamports: r.totalLamports + (r.bagsLamports ?? 0) }));
  }

  rows = await attachDistributions(connection, rows, {
    findShares: Boolean(args['find-shares']),
    onProgress: (n, total) => process.stderr.write(`\r${c.dim(`shareholder scan ${n}/${total}`)}`),
  });
  process.stderr.write('\r\x1b[K');

  const min = Number(args.min ?? 0) * LAMPORTS_PER_SOL;
  if (min > 0) rows = rows.filter((r) => r.totalLamports >= min);

  const payer = pickPayer(rows, args.payer, { requireSigner });
  if ((payer.walletLamports ?? 0) < MIN_PAYER_LAMPORTS) {
    console.error(c.yellow(`warning: fee payer ${payer.label} holds only ${sol(payer.walletLamports ?? 0)} SOL — ` +
      'transactions may fail. Pass --payer <label|pubkey> to choose a funded wallet.'));
  }

  if (!args['no-preflight']) {
    const withFees = rows.filter(isActionable);
    const checked = await preflight(connection, withFees, payer.publicKey, {
      onProgress: (n, total) => process.stderr.write(`\r${c.dim(`preflight ${n}/${total}`)}`),
    });
    process.stderr.write('\r\x1b[K');
    const byKey = new Map(checked.map((r) => [r.publicKey.toBase58(), r]));
    rows = rows.map((r) => byKey.get(r.publicKey.toBase58()) ?? { ...r, status: 'empty', reason: 'nothing to claim' });
  }

  return { connection, rows, payer };
}

/**
 * Choose who pays. Claiming needs a real signing key, but scanning only needs
 * a plausible pubkey to simulate against — so a watch-only wallet set stays
 * fully scannable instead of being turned away at the door.
 */
function pickPayer(rows, wanted, { requireSigner } = {}) {
  const signers = rows.filter((r) => r.keypair);
  if (wanted && wanted !== true) {
    const pool = requireSigner ? signers : rows;
    const found = pool.find((r) => r.label === wanted || r.publicKey.toBase58() === wanted);
    if (!found) die(`--payer ${wanted} is not one of the loaded ${requireSigner ? 'signing ' : ''}wallets`);
    return found;
  }
  // Richest first: fees live in the vaults, so plenty of creator wallets are
  // themselves empty and cannot pay for the transaction that drains them.
  const byBalance = (a, b) => (b.walletLamports ?? 0) - (a.walletLamports ?? 0);
  if (signers.length > 0) return [...signers].sort(byBalance)[0];
  if (requireSigner) die('every wallet is watch-only; at least one signing key is needed to claim');
  return [...rows].sort(byBalance)[0];
}

/** Rough floor: 5000 lamports per signature, and batches carry several. */
const MIN_PAYER_LAMPORTS = 50_000;

function printTable(rows) {
  const labelWidth = Math.min(24, Math.max(6, ...rows.map((r) => r.label.length)));
  console.log(`\n${c.bold(pad('WALLET', labelWidth))} ${c.bold(pad('ADDRESS', 12))} ${c.bold(padStart('PUMP', 12))} ${c.bold(padStart('PUMPSWAP', 12))} ${c.bold(padStart('SHARING', 12))} ${c.bold(padStart('TOTAL', 12))}  STATUS`);
  for (const r of rows) {
    console.log(
      `${pad(r.label, labelWidth)} ${c.dim(pad(r.publicKey.toBase58().slice(0, 10) + '…', 12))} ` +
      `${padStart(sol(r.pumpLamports), 12)} ${padStart(sol(r.pumpswapLamports), 12)} ` +
      `${padStart(sol(r.sharingLamports ?? 0), 12)} ` +
      `${c.bold(padStart(sol(r.totalLamports), 12))}  ${statusTag(r.status)}` +
      (r.reason && r.status === 'blocked' ? c.dim(` · ${r.reason}`) : ''),
    );
    // Distributions are worth spelling out: the money leaves a shared vault
    // and is split by basis points, so "what moves" and "what you get" differ.
    for (const d of r.distributions ?? []) {
      const holders = d.config.shareholders.length;
      const note = d.distributable > 0
        ? `crank ${sol(d.distributable)} SOL to ${holders} shareholder${holders === 1 ? '' : 's'}`
        : c.dim('cranked by another row');
      console.log(c.dim(`    └ ${d.kind === 'self' ? 'sharing config' : 'share in'} ${d.mint.toBase58().slice(0, 10)}… · `) +
        note + (d.userShare > 0 ? c.green(`  → you receive ${sol(d.userShare)} SOL`) : ''));
    }
  }
  for (const r of rows) {
    if (r.sharingError) {
      console.log(c.red(`    ! shareholder scan incomplete for ${r.label}: ${r.sharingError}`));
      console.log(c.red('      totals below may understate what is owed. Retry, or use a private RPC.'));
    }
  }
  const ready = rows.filter((r) => (r.status ?? 'ready') === 'ready');
  const blocked = rows.filter((r) => r.status === 'blocked');
  const total = ready.reduce((n, r) => n + r.totalLamports, 0);
  const cranked = ready.reduce((n, r) => n + (r.distributions ?? []).reduce((m, d) => m + d.distributable, 0), 0);
  console.log(`\n${c.green(c.bold(`${sol(total)} SOL`))} claimable across ${ready.length} wallet(s)` +
    (cranked > 0 ? c.cyan(`  ·  ${sol(cranked)} SOL released by distribution`) : '') +
    (blocked.length ? c.yellow(`  ·  ${blocked.length} blocked`) : ''));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? 'help';

  if (cmd === 'help' || args.help) { console.log(HELP); return; }

  if (cmd === 'dashboard') {
    const walletsPath = args.wallets ?? process.env.WALLETS ?? './wallets.json';
    const rpc = args.rpc ?? process.env.RPC ?? 'https://api.mainnet-beta.solana.com';
    await startDashboard({ walletsPath, rpc, port: Number(args.port ?? 4600),
      allowExecute: Boolean(args.execute), findShares: Boolean(args['find-shares']) });
    return;
  }

  if (cmd === 'scan') {
    const { rows } = await loadAndScan(args);
    if (args.json) {
      console.log(JSON.stringify(rows.map((r) => ({
        label: r.label, address: r.publicKey.toBase58(), pumpLamports: r.pumpLamports,
        pumpswapLamports: r.pumpswapLamports, bagsLamports: r.bagsLamports ?? 0,
        totalLamports: r.totalLamports, status: r.status ?? 'ready', reason: r.reason ?? null,
      })), null, 2));
    } else printTable(rows);
    return;
  }

  if (cmd === 'claim') {
    const { connection, rows, payer } = await loadAndScan(args, { requireSigner: true });
    const claimable = rows.filter(isActionable);
    if (claimable.length === 0) { console.log(c.yellow('nothing to claim.')); return; }

    printTable(rows);

    let chosen;
    if (args.all) chosen = claimable.filter((r) => (r.status ?? 'ready') === 'ready');
    else chosen = await multiSelect(claimable, { title: 'Select wallets to harvest' }).catch((e) => die(e.message));

    if (chosen.length === 0) { console.log(c.yellow('no wallets selected.')); return; }

    const dryRun = !args.execute;
    const total = chosen.reduce((n, r) => n + r.totalLamports, 0);
    console.log(`\n${dryRun ? c.yellow('DRY RUN') : c.red(c.bold('EXECUTING'))} · ${chosen.length} wallet(s) · ${c.bold(sol(total))} SOL · fee payer ${c.cyan(payer.label)}\n`);

    const results = await claimAll(connection, chosen, payer, {
      dryRun,
      computeUnitPrice: Number(args['priority-fee'] ?? 0),
      maxPerTx: Number(args['max-per-tx'] ?? 8),
      onEvent: (e) => {
        if (e.type === 'planned') console.log(c.dim(`packed ${e.wallets} wallet(s) into ${e.batches} transaction(s)\n`));
        if (e.type === 'batch') {
          const tag = e.ok ? c.green('ok') : c.red('fail');
          console.log(`  ${tag}  ${pad(e.label, 30)} ${padStart(sol(e.lamports), 12)} SOL` +
            (e.signature ? `  ${c.dim(e.signature)}` : '') + (e.err ? `  ${c.red(JSON.stringify(e.err).slice(0, 90))}` : ''));
        }
      },
    }).catch((e) => die(e.message));

    if (args.bags) {
      const client = new BagsClient({ apiKey: process.env.BAGS_API_KEY });
      const bagsRows = chosen.filter((r) => (r.bagsLamports ?? 0) > 0);
      if (bagsRows.length) {
        console.log(c.dim('\nbags positions:'));
        for (const r of await claimBags(connection, client, bagsRows, { dryRun })) {
          console.log(`  ${r.ok ? c.green('ok') : c.red('fail')}  ${r.label} ${c.dim(r.mint ?? '')} ${r.err ? c.red(String(r.err).slice(0, 80)) : ''}`);
        }
      }
    }

    const landed = results.filter((r) => r.ok).reduce((n, r) => n + r.lamports, 0);
    console.log(`\n${c.bold(sol(landed))} SOL ${dryRun ? c.yellow('would be claimed (simulated)') : c.green('claimed')}`);
    if (dryRun) console.log(c.dim('re-run with --execute to send these transactions for real.'));
    return;
  }

  die(`unknown command "${cmd}" — try: harvest help`);
}

main().catch((e) => die(e.stack ?? e.message));
