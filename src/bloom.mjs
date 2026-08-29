/**
 * A Bloom filter over Solana public keys.
 *
 * Used to answer "is this address a coin creator anywhere on the chain?"
 * without keeping the eight million creators that question is asked against.
 * The filter is one-sided: a `no` is certain, a `yes` is very probably right.
 * That is the direction the scan needs — a false positive costs one wasted
 * account lookup, while a false negative would silently drop a wallet that has
 * fees waiting, so this must never produce one.
 *
 * There is no hash function here, and that is deliberate rather than lazy.
 * A Bloom filter wants k independent, uniformly distributed indices per key.
 * Public keys are already 32 uniformly random bytes, so eight disjoint 4-byte
 * windows of the key are already eight independent uniform draws. Hashing them
 * again would cost time to arrive at the same distribution.
 *
 * Sizing: 2^27 bits is 16MB. The 13.7M coins on the chain today were made by
 * 3.47M distinct creators, which fills 18.7% of it and gives a measured
 * false-positive rate of 1.5e-6 — about one stray lookup per 670,000 wallets
 * tested. That is deliberate headroom: the filter is sized for a chain that
 * keeps growing and stays under 1% at five times today's creators.
 * `falsePositiveRate` measures it from the bits actually set rather than
 * leaving it as a claim.
 */

const MAGIC = 'DFHBLOOM';
const VERSION = 1;
const HEADER_BYTES = 32;

export const DEFAULT_LOG2_BITS = 27;
export const DEFAULT_HASHES = 8;

/**
 * A key contributes one index per 4-byte window, so k cannot exceed 8 for a
 * 32-byte key without reusing bytes.
 */
const MAX_HASHES = 8;

export function createBloom({ log2Bits = DEFAULT_LOG2_BITS, hashes = DEFAULT_HASHES } = {}) {
  if (!Number.isInteger(log2Bits) || log2Bits < 3 || log2Bits > 31) {
    throw new Error(`bloom log2Bits must be an integer in 3..31, got ${log2Bits}`);
  }
  if (!Number.isInteger(hashes) || hashes < 1 || hashes > MAX_HASHES) {
    throw new Error(`bloom hashes must be an integer in 1..${MAX_HASHES}, got ${hashes}`);
  }
  return fromParts(log2Bits, hashes, Buffer.alloc(2 ** log2Bits / 8), 0);
}

function fromParts(log2Bits, hashes, bits, added) {
  const mask = 2 ** log2Bits - 1;
  let count = added;

  /** Read the i-th 4-byte window of a 32-byte key as a bit index. */
  const indexOf = (key, i) => key.readUInt32LE(i * 4) & mask;

  const has = (key) => {
    for (let i = 0; i < hashes; i++) {
      const bit = indexOf(key, i);
      if ((bits[bit >>> 3] & (1 << (bit & 7))) === 0) return false;
    }
    return true;
  };

  return {
    log2Bits,
    hashes,
    get bytes() {
      return bits;
    },
    get added() {
      return count;
    },

    /** `key` must be the raw 32 bytes, not a base58 string. */
    add(key) {
      if (key.length !== 32) throw new Error(`bloom keys are 32 bytes, got ${key.length}`);
      for (let i = 0; i < hashes; i++) {
        const bit = indexOf(key, i);
        bits[bit >>> 3] |= 1 << (bit & 7);
      }
      count++;
    },

    has(key) {
      if (key.length !== 32) throw new Error(`bloom keys are 32 bytes, got ${key.length}`);
      return has(key);
    },

    /**
     * The false-positive rate implied by how full the filter actually is,
     * measured from the set bits rather than from the number of keys added.
     * Counting the bits is honest about collisions between them.
     */
    falsePositiveRate() {
      let set = 0;
      for (let i = 0; i < bits.length; i++) {
        // Kernighan: loops once per set bit rather than once per bit.
        for (let b = bits[i]; b; b &= b - 1) set++;
      }
      return (set / 2 ** log2Bits) ** hashes;
    },

    /** Header plus bitmap, ready to write to a file. */
    serialize() {
      const header = Buffer.alloc(HEADER_BYTES);
      header.write(MAGIC, 0, 'ascii');
      header.writeUInt8(VERSION, 8);
      header.writeUInt8(log2Bits, 9);
      header.writeUInt8(hashes, 10);
      header.writeBigUInt64LE(BigInt(count), 16);
      return Buffer.concat([header, bits]);
    },
  };
}

/**
 * Halve a filter's size, repeatedly, without ever introducing a false negative.
 *
 * The bit index for a key is `readUInt32LE(window) & mask`. Shrinking the mask
 * by one bit maps index `j` and index `j + m/2` onto the same `j`, so folding
 * the top half onto the bottom half with OR lands every key's bits exactly
 * where the smaller filter would have put them. Nothing a key set can be lost;
 * only unrelated bits collide, which costs false positives and never a missed
 * wallet.
 *
 * Used to publish a smaller filter than the one built locally, so a download
 * is megabytes rather than tens of them.
 */
export function foldBloom(bloom, log2Bits) {
  if (log2Bits > bloom.log2Bits) {
    throw new Error(`cannot fold ${bloom.log2Bits} bits up to ${log2Bits}`);
  }
  if (log2Bits === bloom.log2Bits) return bloom;

  let bits = bloom.bytes;
  for (let size = bloom.log2Bits; size > log2Bits; size--) {
    const half = bits.length / 2;
    const folded = Buffer.alloc(half);
    for (let i = 0; i < half; i++) folded[i] = bits[i] | bits[i + half];
    bits = folded;
  }
  return fromParts(log2Bits, bloom.hashes, bits, bloom.added);
}

/**
 * Rebuild a filter from `serialize()` output. Rejects anything it does not
 * recognise rather than returning a filter that answers `no` to everything —
 * which would look exactly like a chain with no creators on it.
 */
export function deserializeBloom(buf) {
  if (buf.length < HEADER_BYTES || buf.toString('ascii', 0, 8) !== MAGIC) {
    throw new Error('not a bloom filter file');
  }
  const version = buf.readUInt8(8);
  if (version !== VERSION) throw new Error(`bloom file version ${version}, expected ${VERSION}`);
  const log2Bits = buf.readUInt8(9);
  const hashes = buf.readUInt8(10);
  const expected = 2 ** log2Bits / 8;
  const bits = buf.subarray(HEADER_BYTES);
  if (bits.length !== expected) {
    throw new Error(`bloom file is ${bits.length} bytes of bitmap, expected ${expected}`);
  }
  return fromParts(log2Bits, hashes, Buffer.from(bits), Number(buf.readBigUInt64LE(16)));
}
