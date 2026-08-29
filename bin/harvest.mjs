#!/usr/bin/env node
import { Connection } from '@solana/web3.js';
import process from 'node:process';
import { LAMPORTS_PER_SOL } from '../src/constants.mjs';
import { BagsClient, claimBags, scanBags } from '../src/bags.mjs';
import { claimAll, isActionable } from '../src/claim.mjs';
import { createWriteStream, existsSync } from 'node:fs';
import {
  c,
  clearProgress,
  count,
  pad,
  padStart,
  progress,
  setProgressMode,
  sol,
  statusTag,
} from '../src/format.mjs';
import { canSign, streamWallets } from '../src/keys.mjs';
import { preflight } from '../src/preflight.mjs';
import { scanStream } from '../src/scan.mjs';
import { defaultWorkerCount } from '../src/derive.mjs';
import { createLimiter } from '../src/limit.mjs';
import { DEFAULT_INDEX_URL, defaultIndexPath, openCreatorIndex } from '../src/creator-index.mjs';
import { attachDistributions, buildShareholderIndex } from '../src/sharing.mjs';
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
  --batch-size <n>     wallets scanned per pass (default 1000)
  --concurrency <n>    parallel RPC requests (default 8; raise on a private RPC)
  --workers <n>        threads for address derivation (default: cores-1, max 8; 0 = off)
  --rpc-delay <ms>     minimum gap between RPC requests, for strict rate limits
  --out <file.jsonl>   append every wallet found with fees, as it is found
  --receipts <file>    append a JSONL record of every transaction as it is sent
  --no-preflight       skip the per-wallet simulation pass
  --creator-index      read every coin's creator once, then skip wallets that
                       never launched one. Cached; reused automatically after.
  --index-file <path>  where to keep that index (default ~/.dev-fee-harvester/creators.idx)
  --rebuild-index      rebuild the creator index even if a fresh one is cached
  --index-url <url>    where to fetch a prebuilt creator index from
  --no-index-download  always build the index locally instead of fetching one
  --index-shards <n>   concurrent reads the index build is split into (default
                       256; 0 reads each program in one request, which the
                       public RPC truncates without saying so)
  --find-shares        also hunt fees held for you in team sharing configs (slower)
  --no-share-index     with --find-shares: probe 27 slots per wallet instead of
                       reading the configs once (slower; the old behaviour)
  --bags               also scan/claim Bags positions (needs BAGS_API_KEY)
                       note: authenticated responses are not yet confirmed live
  --port <n>           dashboard port (default 4600)
  --progress <mode>    auto (default), always, or never — status line while scanning
  --json               machine-readable output for scan

${c.dim('Claiming is a dry run unless you pass --execute.')}
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/** Materialise the wallet list. Only used when building a share index. */
async function collectWallets(walletsPath) {
  const all = [];
  for await (const batch of streamWallets(walletsPath, { batchSize: 1000 })) all.push(...batch);
  return all;
}

const die = (msg) => {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
};

async function loadAndScan(args, { requireSigner = false } = {}) {
  const walletsPath = args.wallets ?? process.env.WALLETS ?? './wallets.json';
  const rpc = args.rpc ?? process.env.RPC ?? 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpc, {
    commitment: 'confirmed',
    // web3.js retries rate limits itself and logs a line per attempt, which
    // duplicates the backoff in limit.mjs and buries real output under
    // "Retrying after ...". Ours reports through the progress line instead.
    disableRetryOnRateLimit: true,
  });
  const wanted = typeof args.payer === 'string' ? args.payer : null;
  const minLamports = Number(args.min ?? 0) * LAMPORTS_PER_SOL;

  console.error(c.dim(`${walletsPath} - ${new URL(rpc).host}`));

  // The wallet list is streamed, and only wallets that turn out to hold fees
  // are retained. That is what lets the list be arbitrarily long: peak memory
  // tracks the number of funded wallets, not the number of wallets.
  const batches = streamWallets(walletsPath, { batchSize: Number(args['batch-size'] ?? 1000) });

  let out = null;
  if (typeof args.out === 'string') out = createWriteStream(args.out, { flags: 'a' });

  // The fee payer usually has no fees of its own, so it would be filtered
  // away. Track it as rows go past instead of keeping everything.
  let payer = null;
  // The creator index skips most wallets, so most rows arrive with their
  // balance unread. Choosing a payer off `?? 0` would pick one of those and
  // call it broke. Unknowns are held aside instead and priced later, only if
  // no wallet with a balance we actually read turns out to be good enough.
  const PAYER_CANDIDATES = 100;
  const unpriced = [];
  const considerPayer = (row) => {
    if (wanted) {
      if (row.label === wanted || row.publicKey.toBase58() === wanted) payer = row;
      return;
    }
    if (requireSigner && !canSign(row)) return;
    if (row.walletLamports === null) {
      if (unpriced.length < PAYER_CANDIDATES) unpriced.push(row);
      return;
    }
    if (!payer || row.walletLamports > (payer.walletLamports ?? 0)) payer = row;
  };

  /**
   * One request, at most, to settle the fee payer: read the balances of the
   * candidates the index skipped and take the best. Only reached when the
   * wallets that were priced cannot cover the fees.
   */
  const priceCandidates = async (candidates) => {
    if (candidates.length === 0) return;
    const infos = await connection.getMultipleAccountsInfo(candidates.map((r) => r.publicKey));
    candidates.forEach((row, i) => {
      row.walletLamports = infos[i]?.lamports ?? 0;
      if (!payer || row.walletLamports > (payer.walletLamports ?? 0)) payer = row;
    });
  };

  // Same pacing as the scan: the shareholder sweep is the heaviest set of
  // requests here, so --concurrency and --rpc-delay must reach it too.
  const shareLimiter = createLimiter({
    concurrency: Number(args.concurrency ?? 8),
    minDelayMs: Number(args['rpc-delay'] ?? 0),
  });

  // One streamed read of every sharing config, answering all wallets, instead
  // of 27 filtered requests each. On by default: it is faster even for a
  // single wallet, and the stream keeps it to tens of megabytes.
  let shareIndex;
  if (args['find-shares'] && !args['no-share-index']) {
    try {
      shareIndex = await buildShareholderIndex(connection, await collectWallets(walletsPath), {
        limiter: shareLimiter,
        onProgress: (e) => {
          if (e.phase === 'scan-configs') progress('reading every sharing config (one pass)');
          if (e.phase === 'scanned')
            progress(`${count(e.configs)} configs, ${count(e.overflow)} need a second look`);
          if (e.phase === 'done') progress(`indexed shares for ${count(e.wallets)} wallet(s)`);
        },
      });
      clearProgress();
    } catch (e) {
      clearProgress();
      die(`share index failed: ${e.message}`);
    }
  }

  // Every coin on the chain names its creator. Reading that one field from all
  // of them costs two streamed requests and answers, locally and for free,
  // the question the scan was paying three lookups per wallet to ask.
  //
  // Not on by default: building it reads two whole programs, which is minutes
  // well spent on a hundred thousand wallets and minutes wasted on five. Once
  // built it is cached, and a cached index is picked up on its own.
  let creatorIndex = null;
  let indexRetries = 0;
  const indexPath =
    typeof args['index-file'] === 'string' ? args['index-file'] : defaultIndexPath();
  if (
    args['creator-index'] ||
    args['rebuild-index'] ||
    (existsSync(indexPath) && !args['no-creator-index'])
  ) {
    try {
      creatorIndex = await openCreatorIndex({
        rpcEndpoint: rpc,
        path: indexPath,
        currentSlot: await connection.getSlot('confirmed'),
        rebuild: Boolean(args['rebuild-index']),
        // A prebuilt index is minutes saved, but it decides which wallets are
        // worth asking about, so it is checked against the chain before use.
        url: args['no-index-download'] ? null : (args['index-url'] ?? DEFAULT_INDEX_URL),
        onEvent: (e) => {
          if (e.type === 'loaded') {
            clearProgress();
            console.error(
              c.dim(
                `creator index: ${count(e.index.counts['bonding curves'])} curves + ` +
                  `${count(e.index.counts.pools)} pools, ${count(e.ageSlots)} slots old`,
              ),
            );
          }
          if (e.type === 'stale') progress('creator index is stale, rebuilding');
          if (e.type === 'downloaded') {
            clearProgress();
            console.error(
              c.dim(
                'creator index downloaded and checked against the chain ' +
                  `(${count(e.present)}/${count(e.checked)} known creators present` +
                  `${e.missing ? `; ${e.missing} newer than the index` : ''})`,
              ),
            );
          }
          if (e.type === 'download-stale') progress('published index is stale, building instead');
          if (e.type === 'download-failed') {
            clearProgress();
            console.error(c.yellow(`published index not used: ${e.message}`));
          }
          if (e.type === 'building')
            progress('reading every coin on the chain (one pass, minutes)');
          if (e.type === 'built') {
            clearProgress();
            console.error(c.dim(`creator index written to ${e.path}`));
          }
        },
        concurrency: Number(args.concurrency ?? 8),
        shards: Number(args['index-shards'] ?? 256),
        onProgress: (src, seen) =>
          progress(
            `creator index - ${src} ${count(seen)}` +
              (indexRetries ? ` - ${indexRetries} retries` : ''),
          ),
        onRetry: () => {
          indexRetries++;
        },
      });
      clearProgress();
    } catch (e) {
      clearProgress();
      die(`creator index failed: ${e.message}`);
    }
  }

  let rows = [];
  let retries = 0;
  try {
    for await (const chunk of scanStream(batches, connection, {
      // Distributions are attached inside the stream: a wallet that only holds
      // a share elsewhere has no balance of its own, so attaching afterwards
      // would run only on wallets that had already survived the filter.
      enrich: (batch) =>
        attachDistributions(connection, batch, {
          findShares: Boolean(args['find-shares']),
          shareIndex,
          limiter: shareLimiter,
          onProgress: (n, total) => progress(`shareholder scan ${count(n)}/${count(total)}`),
        }),
      workers: args.workers === undefined ? defaultWorkerCount() : Number(args.workers),
      concurrency: Number(args.concurrency ?? 8),
      minDelayMs: Number(args['rpc-delay'] ?? 0),
      creatorIndex,
      onRow: considerPayer,
      onRetry: () => {
        retries++;
      },
      onProgress: (scanned, found, looked) =>
        progress(
          `scanned ${count(scanned)} wallets - ${count(found)} with fees` +
            (creatorIndex ? ` - ${count(looked)} looked up` : '') +
            (retries ? ` - ${retries} retries` : ''),
        ),
    })) {
      for (const row of chunk) {
        if (minLamports > 0 && row.totalLamports < minLamports && row.selfConfigDistributable <= 0)
          continue;
        rows.push(row);
        out?.write(
          JSON.stringify({
            label: row.label,
            address: row.publicKey.toBase58(),
            pumpLamports: row.pumpLamports,
            pumpswapLamports: row.pumpswapLamports,
            totalLamports: row.totalLamports,
          }) + String.fromCharCode(10),
        );
      }
    }
  } catch (e) {
    clearProgress();
    die(`scan failed: ${e.message}`);
  }
  clearProgress();
  out?.end();

  // Settle the payer if the best one found is unpriced, missing, or too poor
  // to be trusted. With no index in play there is never anything to price and
  // this costs nothing.
  if (
    payer === null ||
    payer.walletLamports === null ||
    payer.walletLamports < MIN_PAYER_LAMPORTS
  ) {
    await priceCandidates(payer?.walletLamports === null ? [payer, ...unpriced] : unpriced);
  }
  if (payer === null) {
    die(
      requireSigner
        ? 'no signing wallet available to pay fees — add one, or drop --execute to simulate'
        : 'no wallets found',
    );
  }
  if (requireSigner && !canSign(payer)) {
    die(
      wanted
        ? `--payer ${wanted} is watch-only and cannot pay fees`
        : 'every wallet is watch-only; at least one signing key is needed to claim',
    );
  }
  if (wanted && !payer) die(`--payer ${wanted} is not one of the loaded wallets`);
  if ((payer.walletLamports ?? 0) < MIN_PAYER_LAMPORTS) {
    console.error(
      c.yellow(
        `warning: fee payer ${payer.label} holds only ${sol(payer.walletLamports ?? 0)} SOL - ` +
          'transactions may fail. Pass --payer <label|pubkey> to choose a funded wallet.',
      ),
    );
  }

  if (args.bags) {
    const client = new BagsClient({ apiKey: process.env.BAGS_API_KEY });
    rows = await scanBags(client, rows, {
      onProgress: (n, total) => progress(`bags ${n}/${total}`),
    });
    clearProgress();
    rows = rows.map((r) => ({ ...r, totalLamports: r.totalLamports + (r.bagsLamports ?? 0) }));
  }

  if (!args['no-preflight']) {
    const withFees = rows.filter(isActionable);
    const checked = await preflight(connection, withFees, payer.publicKey, {
      // Preflight simulates the transactions that would actually be sent, so
      // it has to pack them the same way the sender will.
      maxPerTx: Number(args['max-per-tx'] ?? 8),
      limiter: shareLimiter,
      onProgress: (n, total) => progress(`preflight ${count(n)}/${count(total)}`),
    });
    clearProgress();
    const byKey = new Map(checked.map((r) => [r.publicKey.toBase58(), r]));
    rows = rows.map(
      (r) =>
        byKey.get(r.publicKey.toBase58()) ?? { ...r, status: 'empty', reason: 'nothing to claim' },
    );
  }

  return { connection, rows, payer };
}

/** Rough floor: 5000 lamports per signature, and batches carry several. */
const MIN_PAYER_LAMPORTS = 50_000;

function printTable(rows) {
  const labelWidth = Math.min(24, Math.max(6, ...rows.map((r) => r.label.length)));
  console.log(
    `\n${c.bold(pad('WALLET', labelWidth))} ${c.bold(pad('ADDRESS', 12))} ${c.bold(padStart('PUMP', 12))} ${c.bold(padStart('PUMPSWAP', 12))} ${c.bold(padStart('SHARING', 12))} ${c.bold(padStart('TOTAL', 12))}  STATUS`,
  );
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
      const note =
        d.distributable > 0
          ? `crank ${sol(d.distributable)} SOL to ${holders} shareholder${holders === 1 ? '' : 's'}`
          : c.dim('cranked by another row');
      console.log(
        c.dim(
          `    └ ${d.kind === 'self' ? 'sharing config' : 'share in'} ${d.mint.toBase58().slice(0, 10)}… · `,
        ) +
          note +
          (d.userShare > 0 ? c.green(`  → you receive ${sol(d.userShare)} SOL`) : ''),
      );
    }
  }
  for (const r of rows) {
    if (r.sharingError) {
      console.log(c.red(`    ! shareholder scan incomplete for ${r.label}: ${r.sharingError}`));
      console.log(
        c.red('      totals below may understate what is owed. Retry, or use a private RPC.'),
      );
    }
  }
  const ready = rows.filter((r) => (r.status ?? 'ready') === 'ready');
  const blocked = rows.filter((r) => r.status === 'blocked');
  const total = ready.reduce((n, r) => n + r.totalLamports, 0);
  const cranked = ready.reduce(
    (n, r) => n + (r.distributions ?? []).reduce((m, d) => m + d.distributable, 0),
    0,
  );
  console.log(
    `\n${c.green(c.bold(`${sol(total)} SOL`))} claimable across ${ready.length} wallet(s)` +
      (cranked > 0 ? c.cyan(`  ·  ${sol(cranked)} SOL released by distribution`) : '') +
      (blocked.length ? c.yellow(`  ·  ${blocked.length} blocked`) : ''),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? 'help';

  if (args.progress !== undefined) {
    try {
      setProgressMode(String(args.progress));
    } catch (e) {
      die(e.message);
    }
  }

  if (cmd === 'help' || args.help) {
    console.log(HELP);
    return;
  }

  if (cmd === 'dashboard') {
    const walletsPath = args.wallets ?? process.env.WALLETS ?? './wallets.json';
    const rpc = args.rpc ?? process.env.RPC ?? 'https://api.mainnet-beta.solana.com';
    await startDashboard({
      walletsPath,
      rpc,
      port: Number(args.port ?? 4600),
      allowExecute: Boolean(args.execute),
      findShares: Boolean(args['find-shares']),
      concurrency: Number(args.concurrency ?? 8),
      rpcDelayMs: Number(args['rpc-delay'] ?? 0),
    });
    return;
  }

  if (cmd === 'scan') {
    const { rows } = await loadAndScan(args);
    if (args.json) {
      console.log(
        JSON.stringify(
          rows.map((r) => ({
            label: r.label,
            address: r.publicKey.toBase58(),
            pumpLamports: r.pumpLamports,
            pumpswapLamports: r.pumpswapLamports,
            bagsLamports: r.bagsLamports ?? 0,
            totalLamports: r.totalLamports,
            status: r.status ?? 'ready',
            reason: r.reason ?? null,
          })),
          null,
          2,
        ),
      );
    } else printTable(rows);
    return;
  }

  if (cmd === 'claim') {
    const { connection, rows, payer } = await loadAndScan(args, {
      requireSigner: Boolean(args.execute),
    });
    const claimable = rows.filter(isActionable);
    if (claimable.length === 0) {
      console.log(c.yellow('nothing to claim.'));
      return;
    }

    printTable(rows);

    let chosen;
    if (args.all) chosen = claimable.filter((r) => (r.status ?? 'ready') === 'ready');
    else
      chosen = await multiSelect(claimable, { title: 'Select wallets to harvest' }).catch((e) =>
        die(e.message),
      );

    if (chosen.length === 0) {
      console.log(c.yellow('no wallets selected.'));
      return;
    }

    const dryRun = !args.execute;
    const total = chosen.reduce((n, r) => n + r.totalLamports, 0);
    console.log(
      `\n${dryRun ? c.yellow('DRY RUN') : c.red(c.bold('EXECUTING'))} · ${chosen.length} wallet(s) · ${c.bold(sol(total))} SOL · fee payer ${c.cyan(payer.label)}\n`,
    );

    // Real money moves here, so the record of it is written as it happens
    // rather than at the end. A run that is interrupted halfway still leaves
    // behind every signature it sent.
    const receiptPath = args.receipts;
    const receipts = receiptPath ? createWriteStream(receiptPath, { flags: 'a' }) : null;
    // Simulation logs are for reading on screen, not for a durable record of
    // what moved. Keep the receipt to the facts of the transaction.
    const record = ({ logs: _logs, ...event }) =>
      receipts?.write(`${JSON.stringify({ ts: Date.now(), ...event })}\n`);

    const results = await claimAll(connection, chosen, payer, {
      dryRun,
      computeUnitPrice: Number(args['priority-fee'] ?? 0),
      maxPerTx: Number(args['max-per-tx'] ?? 8),
      onEvent: (e) => {
        if (e.type === 'planned')
          console.log(c.dim(`packed ${e.wallets} wallet(s) into ${e.batches} transaction(s)\n`));
        if (e.type === 'retry') {
          console.log(c.dim(`  ..    ${pad(e.label, 30)} retrying — ${e.reason}`));
          record(e);
        }
        if (e.type === 'batch') {
          // An indeterminate batch is not a failure. It means the transaction
          // may have moved money and we could not find out, which needs a
          // louder mark than "fail" so it is not skimmed past.
          const tag = e.ok ? c.green('ok') : e.indeterminate ? c.yellow('CHECK') : c.red('fail');
          console.log(
            `  ${tag}  ${pad(e.label, 30)} ${padStart(sol(e.lamports), 12)} SOL` +
              (e.signature ? `  ${c.dim(e.signature)}` : '') +
              (e.err ? `  ${c.red(JSON.stringify(e.err).slice(0, 90))}` : ''),
          );
          record(e);
        }
      },
    }).catch((e) => die(e.message));

    receipts?.end();

    if (args.bags) {
      const client = new BagsClient({ apiKey: process.env.BAGS_API_KEY });
      const bagsRows = chosen.filter((r) => (r.bagsLamports ?? 0) > 0);
      if (bagsRows.length) {
        console.log(c.dim('\nbags positions:'));
        for (const r of await claimBags(connection, client, bagsRows, { dryRun })) {
          console.log(
            `  ${r.ok ? c.green('ok') : c.red('fail')}  ${r.label} ${c.dim(r.mint ?? '')} ${r.err ? c.red(String(r.err).slice(0, 80)) : ''}`,
          );
        }
      }
    }

    const unresolved = results.filter((r) => r.indeterminate);
    if (unresolved.length > 0) {
      console.log(
        c.yellow(
          `\n${unresolved.length} transaction(s) could not be confirmed either way. ` +
            `They may have claimed. Check before re-running:`,
        ),
      );
      for (const r of unresolved)
        console.log(c.yellow(`  ${r.signature}  (${r.wallets.join(', ')})`));
    }

    const landed = results.filter((r) => r.ok).reduce((n, r) => n + r.lamports, 0);
    console.log(
      `\n${c.bold(sol(landed))} SOL ${dryRun ? c.yellow('would be claimed (simulated)') : c.green('claimed')}`,
    );
    if (receiptPath) console.log(c.dim(`receipts appended to ${receiptPath}`));
    if (dryRun) console.log(c.dim('re-run with --execute to send these transactions for real.'));
    return;
  }

  die(`unknown command "${cmd}" — try: harvest help`);
}

main().catch((e) => die(e.stack ?? e.message));
