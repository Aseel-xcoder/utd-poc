// utd-crypto.mjs — crypto needed by the UpToDate web/PWA edition.
//
// The Android app's Database.decryptAsset() ported to JavaScript:
//   key   = MD5("8de2f4b6a06d4fa495cd7ed84c6c8a8c" + assetId + "Copyright (c) UpToDate")
//   plain = AES-128/ECB/NoPadding-decrypt(payload, key), strip PKCS pad,
//   then zlib-inflate (zlib header first, raw deflate as fallback).
//
// WebCrypto has no MD5 and no AES-ECB, so both are implemented here in
// plain JS. SHA-256 (streaming) is included for download verification.
// All three are verified against reference implementations in test_crypto.mjs.

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------- MD5 ----
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = [];
for (let i = 0; i < 64; i++) {
  MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
}

export function md5(input) {
  const bytes = typeof input === 'string' ? textEncoder.encode(input) : input;
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(off + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      const rot = ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i]))) >>> 0;
      B = (B + rot) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true); odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true); odv.setUint32(12, d0, true);
  return out;
}

// ------------------------------------------------------------ SHA-256 ----
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

export class Sha256 {
  constructor() {
    this.h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
              0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.total = 0;
    this.w = new Uint32Array(64);
  }
  _block(block, off) {
    const w = this.w;
    for (let t = 0; t < 16; t++) {
      w[t] = (block[off + 4 * t] << 24) | (block[off + 4 * t + 1] << 16) |
             (block[off + 4 * t + 2] << 8) | block[off + 4 * t + 3];
    }
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.h;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const H = this.h;
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  update(chunk) {
    this.total += chunk.length;
    let off = 0;
    if (this.bufLen) {
      const take = Math.min(64 - this.bufLen, chunk.length);
      this.buf.set(chunk.subarray(0, take), this.bufLen);
      this.bufLen += take; off += take;
      if (this.bufLen === 64) { this._block(this.buf, 0); this.bufLen = 0; }
    }
    while (off + 64 <= chunk.length) { this._block(chunk, off); off += 64; }
    if (off < chunk.length) {
      this.buf.set(chunk.subarray(off), 0);
      this.bufLen = chunk.length - off;
    }
  }
  digestHex() {
    const bitLen = this.total * 8;
    const tail = new Uint8Array(this.bufLen + 9 + 64);
    tail.set(this.buf.subarray(0, this.bufLen), 0);
    let n = this.bufLen;
    tail[n++] = 0x80;
    while ((n % 64) !== 56) n++;
    const dv = new DataView(tail.buffer);
    dv.setUint32(n, Math.floor(bitLen / 4294967296));
    dv.setUint32(n + 4, bitLen >>> 0);
    n += 8;
    for (let off = 0; off < n; off += 64) this._block(tail, off);
    return this.h.map(x => x.toString(16).padStart(8, '0')).join('');
  }
}

// ------------------------------------------------- AES-128 (decrypt) ----
function gfMul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = ((a << 1) & 0xff);
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p;
}
function gfPow(a, n) {
  let r = 1;
  while (n) {
    if (n & 1) r = gfMul(r, a);
    a = gfMul(a, a);
    n >>= 1;
  }
  return r;
}
const rotl8 = (x, n) => ((x << n) | (x >> (8 - n))) & 0xff;
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  const inv = i === 0 ? 0 : gfPow(i, 254);
  const s = (inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 0x63) & 0xff;
  SBOX[i] = s; INV_SBOX[s] = i;
}
const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function expandKey(key) {
  const w = new Uint8Array(176);
  w.set(key);
  for (let i = 4; i < 44; i++) {
    let t0 = w[4 * (i - 1)], t1 = w[4 * (i - 1) + 1],
        t2 = w[4 * (i - 1) + 2], t3 = w[4 * (i - 1) + 3];
    if (i % 4 === 0) {
      const r0 = SBOX[t1] ^ RCON[i / 4 - 1], r1 = SBOX[t2], r2 = SBOX[t3], r3 = SBOX[t0];
      t0 = r0; t1 = r1; t2 = r2; t3 = r3;
    }
    w[4 * i] = w[4 * (i - 4)] ^ t0;
    w[4 * i + 1] = w[4 * (i - 4) + 1] ^ t1;
    w[4 * i + 2] = w[4 * (i - 4) + 2] ^ t2;
    w[4 * i + 3] = w[4 * (i - 4) + 3] ^ t3;
  }
  return w;
}

export function aesEcbDecrypt(key, data) {
  if (key.length !== 16 || data.length % 16 !== 0) {
    throw new Error('bad key/data length');
  }
  const rk = expandKey(key);
  const out = new Uint8Array(data.length);
  const st = new Uint8Array(16);
  const addRk = (rnd) => { for (let i = 0; i < 16; i++) st[i] ^= rk[16 * rnd + i]; };
  const invShiftRows = () => {
    const old = st.slice();
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++)
        st[4 * c + r] = old[4 * ((c - r + 4) % 4) + r];
  };
  const invSub = () => { for (let i = 0; i < 16; i++) st[i] = INV_SBOX[st[i]]; };
  const invMix = () => {
    for (let c = 0; c < 4; c++) {
      const i = 4 * c, a0 = st[i], a1 = st[i + 1], a2 = st[i + 2], a3 = st[i + 3];
      st[i] = gfMul(a0, 14) ^ gfMul(a1, 11) ^ gfMul(a2, 13) ^ gfMul(a3, 9);
      st[i + 1] = gfMul(a0, 9) ^ gfMul(a1, 14) ^ gfMul(a2, 11) ^ gfMul(a3, 13);
      st[i + 2] = gfMul(a0, 13) ^ gfMul(a1, 9) ^ gfMul(a2, 14) ^ gfMul(a3, 11);
      st[i + 3] = gfMul(a0, 11) ^ gfMul(a1, 13) ^ gfMul(a2, 9) ^ gfMul(a3, 14);
    }
  };
  for (let off = 0; off < data.length; off += 16) {
    st.set(data.subarray(off, off + 16));
    addRk(10);
    for (let rnd = 9; rnd >= 1; rnd--) {
      invShiftRows(); invSub(); addRk(rnd); invMix();
    }
    invShiftRows(); invSub(); addRk(0);
    out.set(st, off);
  }
  return out;
}

// ------------------------------------------------------- decryptAsset ----
const KEY_PREFIX = '8de2f4b6a06d4fa495cd7ed84c6c8a8c';
const KEY_SALT = 'Copyright (c) UpToDate';

// `inflate` is injected: browser code passes a DecompressionStream-based
// implementation; tests pass a Node zlib one. Signature:
//   inflate(bytes, raw /* boolean */) -> Promise<Uint8Array> (throws on bad format)
export async function decryptAsset(assetId, payload, inflate) {
  const key = md5(KEY_PREFIX + assetId.trim() + KEY_SALT);
  let plain = aesEcbDecrypt(key, payload);
  if (plain.length) {
    const pad = plain[plain.length - 1];
    if (pad >= 1 && pad < 17) plain = plain.subarray(0, plain.length - pad);
  }
  for (const raw of [false, true]) {
    try {
      return await inflate(plain, raw);
    } catch (e) { /* try the other format */ }
  }
  return plain;
}

// Browser inflate via DecompressionStream ('deflate' = zlib, 'deflate-raw').
export async function browserInflate(bytes, raw) {
  const stream = new DecompressionStream(raw ? 'deflate-raw' : 'deflate');
  const data = await new Response(
    new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(data);
}
