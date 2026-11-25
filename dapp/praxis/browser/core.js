// The browser's half of a Phase 2 contribution: stream the previous file in, scale every point by one scalar, write the
// next file out. Pure JS around the gnark wasm (gowasm/), so the same code runs in a page and in Node (the tests).
//
// A Phase 2 file with no commitments (the SP1 wrapper) is, in gnark's order:
//   u16 0 | G1 delta (32) | u32 n, PKK (n x 32) | u32 n, Z (n x 32) | G2 delta (64) | proof: G1 (32), G2 (64) | u8 len, challenge
// A contribution keeps everything the same size: G1 delta and G2 delta times delta, PKK and Z times delta^-1, a new proof, and the
// challenge, which is the sha256 of the whole previous file. Nothing that depends on the challenge comes before the end, so the file
// streams in one pass: the previous file is hashed as it passes, and the tail is written once the hash is known.

export const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const DST_DELTA = 0;
// a real copy: Buffer#slice is a view, and a view of a transferred buffer is gone
const copy = (u8) => new Uint8Array(u8);
const P = 32; // bytes per compressed G1 point

export function toBE32(x) {
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}
function fromBytes(b) { let x = 0n; for (const v of b) x = (x << 8n) | BigInt(v); return x; }
function modpow(a, e, m) { let r = 1n; a %= m; while (e > 0n) { if (e & 1n) r = (r * a) % m; a = (a * a) % m; e >>= 1n; } return r; }

// A scalar in [1, r) from 64 random bytes (the reduction bias is 2^-258), and its inverse.
export function newScalar(getRandomValues) {
  for (;;) {
    const b = new Uint8Array(64);
    getRandomValues(b);
    const d = fromBytes(b) % R;
    if (d !== 0n) return { delta: toBE32(d), inv: toBE32(modpow(d, R - 2n, R)) };
  }
}

// Exactly n bytes at a time from any stream of chunks.
class Reader {
  constructor(source) { this.it = source[Symbol.asyncIterator](); this.buf = new Uint8Array(0); this.done = false; this.n = 0; }
  async take(n) {
    if (n === 0) return new Uint8Array(0);
    const parts = []; let have = 0;
    if (this.buf.length) { parts.push(this.buf); have = this.buf.length; this.buf = new Uint8Array(0); }
    while (have < n) {
      const { value, done } = await this.it.next();
      if (done) throw new Error('the file ends early');
      this.onChunk?.(value);
      parts.push(value); have += value.length;
    }
    let out;
    if (parts.length === 1) out = parts[0];
    else { out = new Uint8Array(have); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } }
    if (have > n) { this.buf = out.subarray(n); out = out.subarray(0, n); }
    this.n += n;
    return out;
  }
  async atEnd() {
    if (this.buf.length) return false;
    const { done, value } = await this.it.next();
    if (!done) { this.onChunk?.(value); this.buf = value; return value.length === 0; }
    return true;
  }
}

// opts: source (async iterable of Uint8Array), write(Uint8Array) (called in file order), pool {scale(buf, scalarBE32), proof(...)},
//       hash {update(u8), sum()}, scalar {delta, inv}, chunkPoints, inflight, onProgress(done, total)
export async function contribute(opts) {
  const { source, write, pool, hash, scalar, chunkPoints = 1 << 16, inflight = 8, onProgress } = opts;
  const rd = new Reader(source);
  rd.onChunk = (c) => hash.update(c);
  const queue = [];
  let total = 0, done = 0;
  const flush = async (limit) => {
    while (queue.length > limit) { const b = await queue.shift(); await write(b); }
  };
  const same = async (b) => { queue.push(Promise.resolve(b)); await flush(inflight); };
  const scaled = async (n, sc) => {
    for (let left = n; left > 0; ) {
      const k = Math.min(left, chunkPoints);
      const raw = await rd.take(k * P);
      // a decoded copy: the reader's bytes may be a view into a larger buffer that was already hashed
      const mine = copy(raw);
      queue.push(pool.scale(mine.buffer, sc).then((r) => { done += k; onProgress?.(done, total); return r; }));
      await flush(inflight);
      left -= k;
    }
  };

  const count = await rd.take(2);
  if (count[0] !== 0 || count[1] !== 0) throw new Error('this file has commitments; the browser path handles the SP1 wrapper layout only');
  await same(copy(count));

  const d1 = await rd.take(P);
  queue.push(pool.scale(copy(d1).buffer, scalar.delta)); await flush(inflight);

  for (const _ of [0, 1]) { // PKK, then Z
    const h = await rd.take(4);
    const n = new DataView(h.buffer, h.byteOffset, 4).getUint32(0);
    if (!_) total += n; else total += n;
    await same(copy(h));
    if (n * P > 2 ** 31) throw new Error('count too large');
    await scaled(n, scalar.inv);
  }
  const g2prev = copy(await rd.take(64));
  await rd.take(96); // the previous contribution's proof
  const len = (await rd.take(1))[0];
  await rd.take(len); // its challenge
  if (!(await rd.atEnd())) throw new Error('bytes after the end of the file');

  await flush(0);
  const challenge = await hash.sum();
  const proof = await pool.proof(scalar.delta, challenge, g2prev, DST_DELTA);
  const tail = new Uint8Array(64 + 32 + 64 + 1 + 32);
  tail.set(proof.g2delta, 0); tail.set(proof.commitment, 64); tail.set(proof.pok, 96); tail[160] = 32; tail.set(challenge, 161);
  await write(tail);
  return { challenge, points: done };
}
