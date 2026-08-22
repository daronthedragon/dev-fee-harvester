/**
 * Base58 (Bitcoin alphabet), encode and decode.
 *
 * Kept dependency-free and in one place because three different things here
 * need it: reading secret keys, building RPC memcmp filters, and decoding the
 * transactions Bags hands back — which are base58, not base64.
 *
 * Implemented over byte arrays rather than BigInt: transaction payloads run to
 * well over a thousand characters, where repeated BigInt division is markedly
 * slower than the classic carry loop.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const INDEX = (() => {
  const map = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET.charCodeAt(i)] = i;
  return map;
})();

export function encodeBase58(bytes) {
  const input = Uint8Array.from(bytes);
  if (input.length === 0) return '';

  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros++;

  const size = Math.floor(((input.length - zeros) * 138) / 100) + 1;
  const b58 = new Uint8Array(size);
  let length = 0;

  for (let i = zeros; i < input.length; i++) {
    let carry = input[i];
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 256 * b58[k];
      b58[k] = carry % 58;
      carry = (carry / 58) | 0;
    }
    length = j;
  }

  let it = size - length;
  while (it < size && b58[it] === 0) it++;

  let out = '1'.repeat(zeros);
  for (; it < size; it++) out += ALPHABET[b58[it]];
  return out;
}

export function decodeBase58(str) {
  if (str.length === 0) return new Uint8Array(0);

  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;

  const size = Math.floor(((str.length - zeros) * 733) / 1000) + 1;
  const bytes = new Uint8Array(size);
  let length = 0;

  for (let i = zeros; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const value = code < 128 ? INDEX[code] : -1;
    if (value < 0) throw new Error(`invalid base58 character ${JSON.stringify(str[i])}`);

    let carry = value;
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 58 * bytes[k];
      bytes[k] = carry % 256;
      carry = (carry / 256) | 0;
    }
    length = j;
  }

  let it = size - length;
  while (it < size && bytes[it] === 0) it++;

  const out = new Uint8Array(zeros + (size - it));
  out.fill(0, 0, zeros);
  out.set(bytes.subarray(it), zeros);
  return out;
}
