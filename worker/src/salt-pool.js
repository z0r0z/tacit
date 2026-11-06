// Salt mining: CreateX CREATE3 salts that only Tacit's deployer can use, ground by anyone's prover between proofs, for points.
//
// A salt is the deployer's address, 0x00 (CreateX then guards it as keccak256(pad32(deployer) ‖ salt): only that deployer can deploy with
// it, and the address is the same on every chain), the UTC day it was ground on (2 bytes, so a share cannot come back once its record has
// gone), and 9 bytes the miner picks. Its address is CreateX's CREATE3: a proxy at CREATE2(CreateX, guardedSalt, proxy init hash), which
// creates the contract at its nonce 1 (contracts/script/create3-vanity; checked against CreateX.computeCreate3Address on mainnet).
//
// A share is a salt whose address starts with at least minBits zero bits. It weighs 2^(bits − minBits), up to 2^maxWeightBits, and counts
// once, for the first address that sends it. A day's points (pointsPerDay) are shared between the day's miners by weight once the day is
// over (GET /prover/salt/credits, which the points service pays from beside the proof pool's tally): more machines share the same points,
// so what a day costs never grows with them. Salts at least bankBits good are kept (GET /prover/salt/bank): the addresses Tacit deploys
// its next contracts to. Tacit's own machines (SALT_HOUSE, the deployer by default) are counted as grinding and banked, and never share the points.
//
// Who is grinding now (every address that sent shares in the last liveMs, Tacit's own named so) and how fast the network grinds (the shares
// of the last hour or so, each the 2^minBits salts a share takes on average) are in GET /prover/salt, for the page's live row.
//
// Storage (KV): sl:seen:<salt> (kept 3 days), sl:m:<day>:<miner> ({ shares, weight, best }), sl:miners:<day> ([miner]), sl:bank (best first),
// sl:rate:<client> (when it last sent), sl:live ({ miner: { at, house } }), sl:hour:<n> (shares in UTC hour n).
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

export const SALT_POOL = Object.freeze({
  deployer: '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7',
  createx: '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed',
  minBits: 26,              // SALT_MIN_BITS: a share's address starts with this many zero bits (about a minute of four laptop cores)
  maxWeightBits: 20,
  pointsPerDay: 1500,       // POINTS_SALT_DAILY: shared by weight (15 TAC a day at 0.01 TAC a point)
  bankBits: 40,             // SALT_BANK_BITS: five zero bytes and better are kept for deploys
  bankKeep: 64,
  perCall: 64,              // salts one send may carry
  sendEveryMs: 20_000,      // one send per client this often
  seenSecs: 3 * 86400,
  daySecs: 40 * 86400,
  liveMs: 15 * 60_000,      // an address that sent shares this recently is grinding now
});
const DAY_MS = 86_400_000, HOUR_MS = 3_600_000;
const PROXY_INIT_HASH = keccak_256(Uint8Array.from([0x67, 0x36, 0x3d, 0x3d, 0x37, 0x36, 0x3d, 0x34, 0xf0, 0x3d, 0x52, 0x60, 0x08, 0x60, 0x18, 0xf3]));
const ADDR = /^0x[0-9a-f]{40}$/;
const SALT = /^0x[0-9a-f]{64}$/;

export function saltPoolConfig(env = {}) {
  const n = (v, dflt, lo, hi) => { const x = Number(v); return v != null && v !== '' && Number.isInteger(x) && x >= lo && x <= hi ? x : dflt; };
  return Object.freeze({
    ...SALT_POOL,
    minBits: n(env.SALT_MIN_BITS, SALT_POOL.minBits, 16, 64),
    pointsPerDay: n(env.POINTS_SALT_DAILY, SALT_POOL.pointsPerDay, 0, 1_000_000),
    bankBits: n(env.SALT_BANK_BITS, SALT_POOL.bankBits, 24, 96),
    house: String(env.SALT_HOUSE || SALT_POOL.deployer).split(',').map((a) => a.trim().toLowerCase()).filter((a) => ADDR.test(a)),
  });
}

// The CREATE3 address of a salt from `deployer`, and its leading zero bits.
export function saltAddress(saltHex, { deployer = SALT_POOL.deployer, createx = SALT_POOL.createx } = {}) {
  const salt = hexToBytes(saltHex.slice(2)), dep = hexToBytes(deployer.slice(2));
  const guarded = keccak_256(concatBytes(new Uint8Array(12), dep, salt));
  const proxy = keccak_256(concatBytes(Uint8Array.of(0xff), hexToBytes(createx.slice(2)), guarded, PROXY_INIT_HASH)).slice(12);
  const a = keccak_256(concatBytes(Uint8Array.of(0xd6, 0x94), proxy, Uint8Array.of(0x01))).slice(12);
  let bits = 0;
  for (const b of a) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; }
  return { address: '0x' + bytesToHex(a), bits };
}

function makeLock() {
  let tail = Promise.resolve();
  return (fn) => { const p = tail.then(fn, fn); tail = p.then(() => {}, () => {}); return p; };
}

// kv: { get, put(key, value, { expirationTtl }?) }. Every call answers { status, body }.
export function makeSaltPool({ kv, cfg = SALT_POOL, now = () => Date.now(), lock = makeLock() }) {
  const read = async (k, d) => { const s = await kv.get(k); if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };
  const write = (k, v, secs) => kv.put(k, JSON.stringify(v), secs ? { expirationTtl: secs } : undefined);
  const dayOf = (t) => Math.floor(t / DAY_MS);
  const reply = (status, body) => ({ status, body });

  // A send: { miner, salts: [0x…], client } → { accepted, weight, rejected: [{ salt, why }] }.
  async function submit({ miner, salts, client }) {
    miner = String(miner || '').toLowerCase();
    if (!ADDR.test(miner)) return reply(400, { ok: false, error: 'miner must be the 0x address the points go to' });
    if (!Array.isArray(salts) || !salts.length || salts.length > cfg.perCall) return reply(400, { ok: false, error: `salts must be 1 to ${cfg.perCall} salts` });
    const t = now(), day = dayOf(t);
    return lock(async () => {
      const last = Number(await kv.get(`sl:rate:${client}`)) || 0;
      if (t - last < cfg.sendEveryMs) return reply(429, { ok: false, error: `one send every ${cfg.sendEveryMs / 1000} s`, retryMs: cfg.sendEveryMs - (t - last) });
      await write(`sl:rate:${client}`, t, 120);
      const head = cfg.deployer.slice(2) + '00', days = [day % 65536, (day - 1 + 65536) % 65536];
      const rec = await read(`sl:m:${day}:${miner}`, { shares: 0, weight: 0, best: null });
      const wasNew = rec.shares === 0;
      // Tacit's own machines (cfg.house, the deployer by default) bank what they find and earn nothing: they never share the day's points.
      const house = (cfg.house || [SALT_POOL.deployer]).includes(miner);
      const rejected = [], banked = [];
      let accepted = 0, weight = 0;
      for (const raw of [...new Set(salts.map((s) => String(s).toLowerCase()))]) {
        if (!SALT.test(raw) || raw.slice(2, 44) !== head) { rejected.push({ salt: raw.slice(0, 66), why: 'not a salt of Tacit\'s deployer' }); continue; }
        if (!days.includes(parseInt(raw.slice(44, 48), 16))) { rejected.push({ salt: raw, why: 'not ground today' }); continue; }
        const { address, bits } = saltAddress(raw, cfg);
        if (bits < cfg.minBits) { rejected.push({ salt: raw, why: `${bits} zero bits, under ${cfg.minBits}` }); continue; }
        if (await kv.get(`sl:seen:${raw}`) != null) { rejected.push({ salt: raw, why: 'already counted' }); continue; }
        await write(`sl:seen:${raw}`, { miner, at: t }, cfg.seenSecs);
        const w = 2 ** Math.min(bits - cfg.minBits, cfg.maxWeightBits);
        accepted++; weight += w;
        if (!rec.best || bits > rec.best.bits) rec.best = { address, bits };
        if (bits >= cfg.bankBits) banked.push({ salt: raw, address, bits, miner, at: t, ...(house ? { house: true } : {}) });
      }
      if (accepted) {
        if (!house) {
          rec.shares += accepted; rec.weight += weight;
          await write(`sl:m:${day}:${miner}`, rec, cfg.daySecs);
          if (wasNew) { const list = await read(`sl:miners:${day}`, []); if (!list.includes(miner)) { list.push(miner); await write(`sl:miners:${day}`, list, cfg.daySecs); } }
        }
        if (banked.length) {
          const bank = [...await read('sl:bank', []), ...banked].sort((a, b) => b.bits - a.bits || a.at - b.at).slice(0, cfg.bankKeep);
          await write('sl:bank', bank);
        }
        const live = Object.fromEntries(Object.entries(await read('sl:live', {})).filter(([, v]) => t - v.at < cfg.liveMs));
        live[miner] = { at: t, ...(house ? { house: true } : {}) };
        await write('sl:live', live);
        const h = Math.floor(t / HOUR_MS);
        await write(`sl:hour:${h}`, (Number(await kv.get(`sl:hour:${h}`)) || 0) + accepted, 3 * 3600);
      }
      return reply(200, { ok: true, accepted, weight: house ? 0 : weight, rejected, today: house ? null : { shares: rec.shares, weight: rec.weight, best: rec.best } });
    });
  }

  async function dayMiners(day) {
    const list = await read(`sl:miners:${day}`, []);
    const recs = await Promise.all(list.map(async (m) => ({ miner: m, ...(await read(`sl:m:${day}:${m}`, { shares: 0, weight: 0, best: null })) })));
    return recs.filter((r) => r.weight > 0);
  }
  // The day's points by weight, for the points service: { day, over, pointsPerDay, miners: [{ miner, proofs (its shares), points }] }.
  async function credits(day) {
    const today = dayOf(now());
    if (!Number.isInteger(day) || day > today || day < today - 39) return reply(400, { ok: false, error: 'day must be a UTC day number, today or before' });
    const recs = await dayMiners(day);
    const total = recs.reduce((s, r) => s + r.weight, 0);
    const miners = recs.map((r) => ({ miner: r.miner, proofs: r.shares, points: total ? Math.floor((cfg.pointsPerDay * r.weight) / total) : 0 }));
    return reply(200, { day, over: day < today, pointsPerDay: cfg.pointsPerDay, miners });
  }
  async function summary() {
    const t = now(), day = dayOf(t), recs = await dayMiners(day);
    const bank = await read('sl:bank', []);
    // The rate: the last hour's shares and this one's so far, over the time they span, each 2^minBits salts on average.
    const h = Math.floor(t / HOUR_MS), [prev, cur] = await Promise.all([kv.get(`sl:hour:${h - 1}`), kv.get(`sl:hour:${h}`)]);
    const span = HOUR_MS + (t - h * HOUR_MS);
    const rate = Math.round((((Number(prev) || 0) + (Number(cur) || 0)) * 2 ** cfg.minBits) / (span / 1000));
    const live = Object.entries(await read('sl:live', {})).filter(([, v]) => t - v.at < cfg.liveMs)
      .sort((a, b) => b[1].at - a[1].at).map(([miner, v]) => ({ miner, at: v.at, ...(v.house ? { house: true } : {}) }));
    return reply(200, {
      deployer: cfg.deployer, createx: cfg.createx, minBits: cfg.minBits, bankBits: cfg.bankBits, pointsPerDay: cfg.pointsPerDay, day, rate, live,
      today: { miners: recs.length, shares: recs.reduce((s, r) => s + r.shares, 0), weight: recs.reduce((s, r) => s + r.weight, 0) },
      top: recs.sort((a, b) => b.weight - a.weight).slice(0, 20).map((r) => ({ miner: r.miner, shares: r.shares, weight: r.weight, best: r.best })),
      bank: bank.slice(0, 10).map(({ address, bits, miner, at, house }) => ({ address, bits, miner, at, ...(house ? { house: true } : {}) })),
      banked: bank.length,
    });
  }
  async function bankList() { return reply(200, { bank: await read('sl:bank', []) }); }
  return { submit, credits, summary, bank: bankList };
}

const kvLocks = new WeakMap();
export function buildSaltPool(env) {
  const kv = env.CONFIDENTIAL_KV || env.REGISTRY_KV;
  if (!kv) return null;
  if (!kvLocks.has(kv)) kvLocks.set(kv, makeLock());
  return makeSaltPool({ kv, cfg: saltPoolConfig(env), lock: kvLocks.get(kv) });
}
