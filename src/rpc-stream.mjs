/**
 * Streaming `getProgramAccounts`.
 *
 * The client builds an object per account and hands back the lot, so reading
 * every sharing config — 578,291 of them — peaks around 1.2GB before a single
 * one has been looked at. Almost all of them are then thrown away.
 *
 * The response is a stream, so it can be read as one: entries are pulled out
 * of the bytes as they arrive, handed to a callback, and dropped. Memory stops
 * tracking the size of the result and starts tracking the size of one entry.
 *
 * The scan is deliberately narrow rather than a general JSON parser. Each
 * element carries a `pubkey` and a base64 `data`, and mainnet emits them as
 *
 *   {"pubkey":"<base58>","account":{...,"data":["<base64>","base64"],...}}
 *
 * Key order is not guaranteed by JSON and is not assumed here: whichever of
 * the two appears first is taken first. An earlier version assumed `data` came
 * first, which matched nothing on mainnet while its tests — built on the same
 * assumption — passed. An unexpected shape raises rather than quietly yielding
 * nothing.
 */

const DATA_KEY = '"data":["';
const PUBKEY_KEY = '"pubkey":"';

/**
 * Read every account of a program, calling `onAccount({ pubkey, data })` for
 * each. `data` is a Buffer of whatever the dataSlice asked for.
 *
 * Returns the number of accounts seen.
 */
export async function streamProgramAccounts(
  endpoint,
  programId,
  { filters = [], dataSlice, commitment = 'confirmed', onAccount, fetchImpl = fetch } = {},
) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getProgramAccounts',
    params: [
      programId.toBase58(),
      { encoding: 'base64', commitment, filters, ...(dataSlice ? { dataSlice } : {}) },
    ],
  };

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`getProgramAccounts -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  if (!res.body) throw new Error('getProgramAccounts returned no body to stream');

  const decoder = new TextDecoder();
  let buf = '';
  let seen = 0;
  let sawResult = false;
  // The last few characters of the whole response, kept separately because
  // `buf` is consumed as it is parsed. This is how truncation is detected.
  let tail = '';

  const drain = (final) => {
    for (;;) {
      const pubAt = buf.indexOf(PUBKEY_KEY);
      const dataAt = buf.indexOf(DATA_KEY);
      // One of the pair has not arrived yet; wait for more bytes.
      if (pubAt === -1 || dataAt === -1) break;

      const pubStart = pubAt + PUBKEY_KEY.length;
      const pubEnd = buf.indexOf('"', pubStart);
      const dataStart = dataAt + DATA_KEY.length;
      const dataEnd = buf.indexOf('"', dataStart);
      if (pubEnd === -1 || dataEnd === -1) break;

      onAccount({
        pubkey: buf.slice(pubStart, pubEnd),
        data: Buffer.from(buf.slice(dataStart, dataEnd), 'base64'),
      });
      seen++;
      buf = buf.slice(Math.max(pubEnd, dataEnd) + 1);
    }

    // Keep only what could still be the head of an entry.
    if (!final && buf.length > 4096) buf = buf.slice(-4096);
  };

  for await (const chunk of res.body) {
    const text = decoder.decode(chunk, { stream: true });
    buf += text;
    tail = (tail + text).slice(-16);

    if (!sawResult) {
      // Surface an RPC-level error rather than reporting zero accounts. Read
      // the rest of it before raising: throwing the moment the key appears
      // yields a message cut off mid-token, which says nothing useful.
      const errAt = buf.indexOf('"error"');
      if (errAt !== -1 && (buf.indexOf('"result"') === -1 || buf.indexOf('"result"') > errAt)) {
        for await (const rest of res.body) buf += decoder.decode(rest, { stream: true });
        buf += decoder.decode();
        throw new Error(
          `getProgramAccounts error: ${buf.slice(buf.indexOf('"error"'), buf.indexOf('"error"') + 300)}`,
        );
      }
      if (buf.includes('"result"')) sawResult = true;
    }

    drain(false);
  }

  const rest = decoder.decode();
  buf += rest;
  tail = (tail + rest).slice(-16);
  drain(true);

  if (!sawResult && seen === 0) {
    throw new Error(`getProgramAccounts returned an unrecognised response: ${buf.slice(0, 200)}`);
  }

  // A response that stops early is the dangerous case, because it does not
  // look like a failure — it looks like a program with fewer accounts than it
  // has. An index built from one silently omits creators, and a wallet missing
  // from the index is money the scan never goes looking for.
  //
  // This is not hypothetical. The public endpoint cuts a large read off when
  // its data allowance runs out, and three reads of the same program returned
  // counts that summed to more accounts than the program has.
  //
  // A complete JSON-RPC response ends with the closing brace of its envelope.
  // Anything else means the body ended in the middle of one.
  if (!/\}\s*$/.test(tail)) {
    throw new Error(
      `getProgramAccounts response was truncated after ${seen} accounts ` +
        `(ended with ${JSON.stringify(tail)}, not a closing brace) — the result is incomplete`,
    );
  }
  return seen;
}
