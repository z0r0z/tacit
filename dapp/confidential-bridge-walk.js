// The work inside confidential-recovery.js walkBridgeMints: for each burn nullifier, the blinding a bridge mint of this key would have used, and
// from it every note a mint could have made (each value on a grid, each asset, each destination index), hashed and compared with the leaves
// that have no memo. It is the most of what opening a wallet costs the first time on a device (about two thousand point additions and as many
// hashes for every nullifier), so it is kept here, free of the pool and the recovery factory, where the page and a worker
// (confidential-bridge-worker.js) both run the same code: a worker can only find what the page would have.
//
// Deps are passed in (`G`, `keccak256`, `deriveBlinding`, the value points) so the page and the worker bring their own.

const FIELD_P = 2n ** 256n - 0x1000003d1n;
const fieldInv = (x) => { let a = ((x % FIELD_P) + FIELD_P) % FIELD_P, m = FIELD_P, u = 1n, v = 0n; while (a) { const q = m / a; [a, m] = [m - q * a, a]; [u, v] = [v - q * u, u]; } return ((v % FIELD_P) + FIELD_P) % FIELD_P; };
export function be32(x, out, off) { const dv = new DataView(out.buffer, out.byteOffset + off, 32); for (let j = 24; j >= 0; j -= 8) { dv.setBigUint64(j, x & 0xffffffffffffffffn); x >>= 64n; } }
export function toAffineBatch(ps) {
  if (!ps.length || ps.some((q) => typeof q.pz !== 'bigint' || q.pz === 0n)) return ps.map((q) => q.toAffine());
  const pre = new Array(ps.length);
  let acc = 1n;
  for (let k = 0; k < ps.length; k++) { pre[k] = acc; acc = (acc * ps[k].pz) % FIELD_P; }
  let inv = fieldInv(acc);
  const out = new Array(ps.length);
  for (let k = ps.length - 1; k >= 0; k--) {
    const zi = (inv * pre[k]) % FIELD_P;
    inv = (inv * ps[k].pz) % FIELD_P;
    out[k] = { x: (ps[k].px * zi) % FIELD_P, y: (ps[k].py * zi) % FIELD_P };
  }
  return out;
}

const hexToBytes = (h) => Uint8Array.from((String(h == null ? '' : h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const w32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const noBreath = async () => {};

// The value grid: [[value, H·value], …] for the given values and, with `roundValues`, every m·10^k below 100·10^maxExp. `breathe()` is awaited
// between stretches so the thread that runs this can hand itself back.
export async function valuePoints({ H, values = [], roundValues = true, maxExp = 18, breathe = noBreath }) {
  const points = new Map();
  for (const v of values) { const b = BigInt(v); if (b > 0n && !points.has(b)) points.set(b, H.multiply(b)); }
  if (roundValues) {
    for (let k = 0; k <= maxExp; k++) {
      await breathe();
      const base = H.multiply(10n ** BigInt(k));
      let acc = base;
      for (let m = 1; m < 100; m++) { const v = BigInt(m) * 10n ** BigInt(k); if (!points.has(v)) points.set(v, acc); acc = acc.add(base); if (m % 16 === 0) await breathe(); }
    }
  }
  return [...points];
}

// `owners`: [{ asset: { assetId }, idBytes, notes: [{ i, secret, owner, ownerBytes }] }], the destination notes this key derives for each asset.
// `nulls`: [{ n, want }] a burn nullifier and the Set (or array) of leaves of its transaction that have no memo.
// → { found, tried }, the notes whose leaf is one of the wanted ones, and how many candidates were hashed.
export async function walkNullifiers({ G, keccak256, deriveBlinding, p, owners, pts, nulls, breathe = noBreath }) {
  const found = [];
  let tried = 0;
  const buf = new Uint8Array(128);
  const same = (d, w) => { for (let j = 0; j < 32; j++) if (d[j] !== w[j]) return false; return true; };
  for (const { n, want } of nulls) {
    await breathe();
    const b = deriveBlinding(p, n);
    const Gb = G.multiply(b);
    const wanted = [...want].map((w) => hexToBytes(w));
    const sums = [];
    for (const [, Pv] of pts) { sums.push(Pv.add(Gb)); if (sums.length % 32 === 0) await breathe(); }
    const cands = toAffineBatch(sums).map((a, k) => {
      const xy = new Uint8Array(64);
      be32(a.x, xy, 0); be32(a.y, xy, 32);
      return { v: pts[k][0], x: a.x, y: a.y, xy };
    });
    for (const { asset, idBytes, notes } of owners) {
      buf.set(idBytes, 0);
      for (const dn of notes) {
        await breathe();
        buf.set(dn.ownerBytes, 96);
        for (const c of cands) {
          tried++;
          buf.set(c.xy, 32);
          const d = keccak256(buf);
          if (!wanted.some((w) => same(d, w))) continue;
          found.push({ value: c.v, blinding: w32(b), secret: dn.secret, asset: asset.assetId, owner: dn.owner, cx: w32(c.x), cy: w32(c.y), leaf: '0x' + bytesToHex(d), burnNullifier: n, destIndex: dn.i });
        }
      }
    }
  }
  return { found, tried };
}
