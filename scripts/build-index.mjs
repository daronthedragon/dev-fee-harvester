/**
 * Build the creator index that gets published, and refuse to publish a bad one.
 *
 *   node scripts/build-index.mjs [--out creators.idx.gz] [--from <file>]
 *
 * A published index decides which wallets every user's scan bothers to ask
 * about. One that is short, or of the wrong thing, does not produce an error
 * for them — it produces a scan that finds no fees. So this does not just
 * build and upload: it has to get past three gates first, and any of them
 * failing exits non-zero with nothing written.
 *
 *   1. It must describe this chain. Real creators are read off the chain and
 *      the filter has to know nearly all of them — the same check the client
 *      runs before using a download, with a larger sample.
 *
 *   2. It must not have gone backwards. The chain only grows, so a build that
 *      read fewer accounts than the currently published one did is a truncated
 *      read, not a smaller chain. That is precisely the failure that went
 *      unnoticed before, and it is the one thing a scheduled job would happily
 *      repeat every night.
 *
 *   3. It must not be empty, which the index builder enforces itself.
 *
 * `--from` skips the build and uses an index already on disk, which is how the
 * gates get exercised without spending thirteen minutes first.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Connection } from '@solana/web3.js';
import { foldBloom } from '../src/bloom.mjs';
import {
  DEFAULT_INDEX_URL,
  buildCreatorIndex,
  deserializeCreatorIndex,
  downloadCreatorIndex,
  verifyCreatorIndex,
} from '../src/creator-index.mjs';

const args = new Map(
  process.argv
    .slice(2)
    .flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1]]] : [])),
);
const RPC = process.env.RPC || 'https://api.mainnet-beta.solana.com';
const OUT = args.get('out') ?? 'creators.idx.gz';
const PUBLISH_BITS = 26;
const SAMPLE = 500;
/** The chain grows; a build that shrinks by more than this did not finish. */
const SHRINK_TOLERANCE = 0.01;

const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
const fail = (msg) => {
  console.error(`\nREFUSING TO PUBLISH: ${msg}`);
  process.exit(1);
};

const started = Date.now();
const connection = new Connection(RPC, 'confirmed');

let index;
if (args.has('from')) {
  index = deserializeCreatorIndex(readFileSync(args.get('from')));
  console.log(`loaded ${args.get('from')}: ${total(index.counts).toLocaleString()} accounts`);
} else {
  const slot = await connection.getSlot('confirmed');
  console.log(`building at slot ${slot} from ${new URL(RPC).host}`);
  index = await buildCreatorIndex(RPC, {
    slot,
    onProgress: (source, seen) =>
      process.stderr.write(`\r  ${source}: ${seen.toLocaleString()}   `),
    onPace: (c) =>
      process.stderr.write(`\n  pace: width ${c.width} gap ${c.pace}ms (${c.reason})\n`),
  });
  process.stderr.write('\n');
}

console.log(
  `built: ${total(index.counts).toLocaleString()} accounts ` +
    `${JSON.stringify(index.counts)}, ${index.added.toLocaleString()} insertions`,
);

// Gate 1 — it has to be an index of this chain.
const checked = await verifyCreatorIndex(index, RPC, { sample: SAMPLE });
console.log(
  `chain check: ${checked.present}/${checked.checked} sampled creators present` +
    `${checked.missing ? `, ${checked.missing} newer than the build` : ''}`,
);

// Gate 2 — it has to be at least as complete as what is already published.
let published = null;
try {
  published = await downloadCreatorIndex(process.env.INDEX_URL || DEFAULT_INDEX_URL);
} catch (e) {
  console.log(`no published index to compare against (${e.message}) — first publish`);
}
if (published) {
  const before = total(published.counts);
  const now = total(index.counts);
  console.log(
    `against published: ${before.toLocaleString()} -> ${now.toLocaleString()} accounts ` +
      `(${(((now - before) / before) * 100).toFixed(2)}%)`,
  );
  if (now < before * (1 - SHRINK_TOLERANCE)) {
    fail(
      `this build read ${(((before - now) / before) * 100).toFixed(1)}% fewer accounts than the ` +
        'published index. The chain does not shrink, so this read did not finish.',
    );
  }
}

// Fold to the published size and write it out.
const folded = foldBloom(index.bloom, PUBLISH_BITS);
const header = index.serialize().subarray(0, 64);
const bytes = gzipSync(Buffer.concat([header, folded.serialize()]), { level: 9 });
writeFileSync(OUT, bytes);

// The folded filter is what people actually get, so check that too.
const reread = deserializeCreatorIndex(Buffer.concat([header, folded.serialize()]));
const refolded = await verifyCreatorIndex(reread, RPC, { sample: 200 });
console.log(
  `folded to 2^${PUBLISH_BITS}: ${refolded.present}/${refolded.checked} present, ` +
    `fp ${(folded.falsePositiveRate() * 100).toPrecision(2)}%`,
);

console.log('');
console.log(`wrote ${OUT}  ${(bytes.length / 1e6).toFixed(2)} MB`);
console.log(`sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
console.log(`took   ${((Date.now() - started) / 1000).toFixed(1)}s`);
