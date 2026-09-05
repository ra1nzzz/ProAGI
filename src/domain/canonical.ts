import type { Hash } from './types';

type Canonical = null | boolean | number | string | readonly Canonical[] | { readonly [key: string]: Canonical };

function normalize(value: unknown): Canonical | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('ERR_CANONICALIZATION');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map(normalize).filter((item): item is Canonical => item !== undefined);
  }
  if (typeof value === 'object') {
    const result: Record<string, Canonical> = {};
    const normalizedKeys = new Map<string, string>();
    for (const originalKey of Object.keys(value as object)) {
      const key = originalKey.normalize('NFC');
      if (normalizedKeys.has(key)) throw new Error('ERR_CANONICALIZATION');
      normalizedKeys.set(key, originalKey);
    }
    for (const key of [...normalizedKeys.keys()].sort(compareCodePoints)) {
      const originalKey = normalizedKeys.get(key)!;
      const item = normalize((value as Record<string, unknown>)[originalKey]);
      if (item !== undefined) result[key] = item;
    }
    return result;
  }
  throw new Error('ERR_CANONICALIZATION');
}

function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const delta = (left[i]?.codePointAt(0) ?? 0) - (right[i]?.codePointAt(0) ?? 0);
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

export function canonicalJson(value: unknown): string {
  const normalized = normalize(value);
  if (normalized === undefined) throw new Error('ERR_CANONICALIZATION');
  return JSON.stringify(normalized);
}

// Browser-safe synchronous SHA-256. It deliberately has no I/O, clock or randomness.
export function sha256(value: string): Hash {
  const bytes = new TextEncoder().encode(value);
  const words = new Uint32Array(64);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const constants = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const x = words[i - 15] ?? 0;
      const y = words[i - 2] ?? 0;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      words[i] = add(words[i - 16] ?? 0, s0, words[i - 7] ?? 0, s1);
    }
    let a = state[0] ?? 0; let b = state[1] ?? 0; let c = state[2] ?? 0; let d = state[3] ?? 0;
    let e = state[4] ?? 0; let f = state[5] ?? 0; let g = state[6] ?? 0; let h = state[7] ?? 0;
    for (let i = 0; i < 64; i += 1) {
      const sigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = add(h, sigma1, choose, constants[i] ?? 0, words[i] ?? 0);
      const sigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = add(sigma0, majority);
      h = g; g = f; f = e; e = add(d, t1); d = c; c = b; b = a; a = add(t1, t2);
    }
    state[0] = add(state[0] ?? 0, a); state[1] = add(state[1] ?? 0, b);
    state[2] = add(state[2] ?? 0, c); state[3] = add(state[3] ?? 0, d);
    state[4] = add(state[4] ?? 0, e); state[5] = add(state[5] ?? 0, f);
    state[6] = add(state[6] ?? 0, g); state[7] = add(state[7] ?? 0, h);
  }
  return `sha256:${[...state].map((word) => word.toString(16).padStart(8, '0')).join('')}`;
}

function rotr(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function add(...values: number[]): number {
  return values.reduce((sum, value) => (sum + value) >>> 0, 0);
}

export function hashCanonical(value: unknown): Hash {
  return sha256(canonicalJson(value));
}

export function semanticId(namespace: string, value: unknown): string {
  const namespaceBytes = hexBytes('6ba7b8109dad11d180b400c04fd430c8');
  const nameBytes = new TextEncoder().encode(`proagi:${namespace}:${canonicalJson(value)}`);
  const digest = sha1(concatBytes(namespaceBytes, nameBytes)).slice(0, 16);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha1(input: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = input.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  let h0 = 0x67452301; let h1 = 0xefcdab89; let h2 = 0x98badcfe; let h3 = 0x10325476; let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 80; index += 1) words[index] = rotateLeft((words[index - 3] ?? 0) ^ (words[index - 8] ?? 0) ^ (words[index - 14] ?? 0) ^ (words[index - 16] ?? 0), 1);
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4;
    for (let index = 0; index < 80; index += 1) {
      let f: number; let k: number;
      if (index < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (index < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (index < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = add(rotateLeft(a, 5), f, e, k, words[index] ?? 0);
      e = d; d = c; c = rotateLeft(b, 30); b = a; a = temp;
    }
    h0 = add(h0, a); h1 = add(h1, b); h2 = add(h2, c); h3 = add(h3, d); h4 = add(h4, e);
  }
  const output = new Uint8Array(20);
  const outputView = new DataView(output.buffer);
  [h0, h1, h2, h3, h4].forEach((word, index) => outputView.setUint32(index * 4, word, false));
  return output;
}

function rotateLeft(value: number, amount: number): number {
  return (value << amount) | (value >>> (32 - amount));
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left); output.set(right, left.length);
  return output;
}
