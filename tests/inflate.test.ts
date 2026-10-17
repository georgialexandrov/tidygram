import { readFileSync } from 'node:fs';
import { constants, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { inflateRaw } from '../src/model/inflate.ts';

/** Deterministic pseudo-random bytes (mulberry32), so failures reproduce. */
function randomBytes(n: number, seed: number, alphabet = 256): Uint8Array {
  let a = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = ((t ^ (t >>> 14)) >>> 0) % alphabet;
  }
  return out;
}

const roundTrip = (data: Uint8Array, options: Parameters<typeof deflateRawSync>[1] = {}) => {
  const packed = new Uint8Array(deflateRawSync(data, options));
  expect(Buffer.from(inflateRaw(packed)).equals(Buffer.from(data))).toBe(true);
  return packed;
};

/** BTYPE of the first block: 0 stored, 1 fixed Huffman, 2 dynamic Huffman. */
const firstBlockType = (packed: Uint8Array) => (packed[0]! >> 1) & 3;

describe('inflateRaw', () => {
  const text = new TextEncoder().encode(readFileSync(new URL('../fixtures/drawio/flowchart.drawio', import.meta.url), 'utf8'));

  it('reads stored blocks, including several in a row', () => {
    const big = randomBytes(150_000, 1);
    const packed = roundTrip(big, { level: 0 });
    expect(firstBlockType(packed)).toBe(0);
    expect(firstBlockType(roundTrip(text, { level: 0 }))).toBe(0);
  });

  it('reads fixed-Huffman blocks', () => {
    const packed = roundTrip(text, { strategy: constants.Z_FIXED });
    expect(firstBlockType(packed)).toBe(1);
    roundTrip(randomBytes(5000, 2, 8), { strategy: constants.Z_FIXED });
  });

  it('reads dynamic-Huffman blocks with long matches and overlapping runs', () => {
    expect(firstBlockType(roundTrip(text))).toBe(2);
    roundTrip(new Uint8Array(100_000).fill(97)); // one byte, then distance-1 copies
    roundTrip(randomBytes(200_000, 3, 4), { level: 9 }); // many blocks, small alphabet
    roundTrip(new TextEncoder().encode('ab'.repeat(40_000) + 'xyz'.repeat(9000)));
  });

  it('round-trips random input at every level', () => {
    for (let level = 0; level <= 9; level++) {
      for (const [n, alphabet] of [[0, 256], [1, 256], [1000, 256], [30_000, 16]] as const) roundTrip(randomBytes(n, 100 + level + n, alphabet), { level });
    }
  });

  it('rejects truncated and corrupt data instead of looping', () => {
    const packed = new Uint8Array(deflateRawSync(text));
    expect(() => inflateRaw(packed.subarray(0, packed.length >> 1))).toThrow(/inflate/);
    expect(() => inflateRaw(new Uint8Array([0x07]))).toThrow(/inflate/); // block type 3
  });
});
