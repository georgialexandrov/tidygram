/**
 * Raw DEFLATE decoder (RFC 1951), synchronous and dependency-free. draw.io
 * stores compressed pages as base64 of raw deflate; `parseDiagram` is sync in
 * the editor, the CLI and the tests, and neither `node:zlib` (Node only) nor
 * `DecompressionStream` (async) fits all three. Diagram pages are small, so
 * the straightforward bit-at-a-time Huffman decode (after zlib's puff.c) is
 * fast enough and easy to check.
 */

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** Order in which a dynamic block lists the code-length code lengths. */
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Canonical Huffman code: how many codes of each length, and the symbols in code order. */
interface Huffman {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function huffman(lengths: ArrayLike<number>): Huffman {
  const counts = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]!]!++;
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  for (let len = 1; len < 16; len++) offsets[len] = offsets[len - 1]! + counts[len - 1]!;
  const symbols = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offsets[lengths[i]!]!++] = i;
  return { counts, symbols };
}

const FIXED_LIT = huffman(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)));
const FIXED_DIST = huffman(new Array<number>(30).fill(5));

export function inflateRaw(input: Uint8Array): Uint8Array {
  let pos = 0;
  let bitBuf = 0;
  let bitCount = 0;
  let out = new Uint8Array(Math.max(1024, input.length * 4));
  let size = 0;

  const fail = (why: string): never => {
    throw new Error(`inflate: ${why}`);
  };
  const bits = (n: number): number => {
    while (bitCount < n) {
      if (pos >= input.length) fail('unexpected end of data');
      bitBuf |= input[pos++]! << bitCount;
      bitCount += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return v;
  };
  const reserve = (n: number) => {
    if (size + n <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, size + n));
    bigger.set(out.subarray(0, size));
    out = bigger;
  };
  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.counts[len]!;
      if (code - first < count) return h.symbols[index + code - first]!;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    return fail('invalid Huffman code');
  };

  const stored = () => {
    bitBuf = 0;
    bitCount = 0;
    if (pos + 4 > input.length) fail('unexpected end of data');
    const len = input[pos]! | (input[pos + 1]! << 8);
    const nlen = input[pos + 2]! | (input[pos + 3]! << 8);
    pos += 4;
    if (len !== (~nlen & 0xffff)) fail('stored block length mismatch');
    if (pos + len > input.length) fail('unexpected end of data');
    reserve(len);
    out.set(input.subarray(pos, pos + len), size);
    size += len;
    pos += len;
  };

  const codes = (lit: Huffman, dist: Huffman) => {
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) {
        reserve(1);
        out[size++] = sym;
      } else if (sym === 256) {
        return;
      } else {
        const li = sym - 257;
        if (li >= 29) fail('invalid length symbol');
        const len = LENGTH_BASE[li]! + bits(LENGTH_EXTRA[li]!);
        const di = decode(dist);
        if (di >= 30) fail('invalid distance symbol');
        const d = DIST_BASE[di]! + bits(DIST_EXTRA[di]!);
        if (d > size) fail('distance too far back');
        reserve(len);
        // Byte by byte: the source may overlap what is being written (runs).
        for (let i = 0; i < len; i++, size++) out[size] = out[size - d]!;
      }
    }
  };

  const dynamic = () => {
    const nlen = bits(5) + 257;
    const ndist = bits(5) + 1;
    const ncode = bits(4) + 4;
    if (nlen > 286 || ndist > 30) fail('bad dynamic block counts');
    const clen = new Uint8Array(19);
    for (let i = 0; i < ncode; i++) clen[CLEN_ORDER[i]!] = bits(3);
    const lencode = huffman(clen);
    const lengths = new Uint8Array(nlen + ndist);
    for (let i = 0; i < nlen + ndist; ) {
      const sym = decode(lencode);
      if (sym < 16) {
        lengths[i++] = sym;
        continue;
      }
      let repeat: number;
      let value = 0;
      if (sym === 16) {
        if (i === 0) fail('repeat with no previous length');
        value = lengths[i - 1]!;
        repeat = 3 + bits(2);
      } else if (sym === 17) repeat = 3 + bits(3);
      else repeat = 11 + bits(7);
      if (i + repeat > nlen + ndist) fail('too many code lengths');
      while (repeat--) lengths[i++] = value;
    }
    if (!lengths[256]) fail('no end-of-block code');
    codes(huffman(lengths.subarray(0, nlen)), huffman(lengths.subarray(nlen)));
  };

  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) stored();
    else if (type === 1) codes(FIXED_LIT, FIXED_DIST);
    else if (type === 2) dynamic();
    else fail('invalid block type');
  }
  return out.slice(0, size);
}
