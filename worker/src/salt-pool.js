// Salt mining: CreateX CREATE3 salts that only Tacit's deployer can use, ground by anyone's prover between proofs, for points.
//
// A salt is the deployer's address, 0x00 (CreateX then guards it as keccak256(pad32(deployer) ‖ salt): only that deployer can deploy with
// it, and the address is the same on every chain), the UTC day it was ground on (2 bytes, so a share cannot come back once its record has
// gone), and 9 bytes the miner picks. Its address is CreateX's CREATE3: a proxy at CREATE2(CreateX, guardedSalt, proxy init hash), which
// creates the contract at its nonce 1 (contracts/script/create3-vanity; checked against CreateX.computeCreate3Address on mainnet).
//
// A share is a salt whose address starts with at least minBits zero bits. It weighs 2^(bits − minBits), up to 2^maxWeightBits, and counts
// once, for the first address that sends it. A day's points are what the day's proofs leave of the mining campaign's daily points (the
// campaign's daily amount over its most a point earns), up to pointsPerDay: proofs come first, and the salts fill the rest, with a floor
// (floorPoints) so a day the proofs filled still pays the grinders something. They are
// shared between the day's miners by weight once the day is
// over (GET /prover/salt/credits, which the points service pays from beside the proof pool's tally): more machines share the same points,
// so what a day costs never grows with them. The best bankKeep salts found (at least bankBits good) are kept (GET /prover/salt/bank): the addresses Tacit deploys
// its next contracts to. Tacit's own machines (SALT_HOUSE, the deployer by default) are counted as grinding and banked, and never share the points.
//
// A second kind of salt is for the vanity-address market (contracts/src/VanityShop.sol, `market` below): the same layout with the shop contract's address in
// place of the deployer's, so the shop is the only account that can turn it into a token (the market's mint is the owner's: the id's top 160 bits). The id fixes
// its address through the market, not CreateX: a proxy at CREATE2(market, id, the market's deploy proxy init hash), which creates the contract at its nonce
// `nonce + 1`, the nonce being the token's (0 to 254; the miner may try several for one id, and one share names the id and the nonce, `0x<id>:<nonce>`, 0 when
// left out). An id counts once whatever its nonce, for the first send that names it. Which kinds the pool takes is SALT_SCHEMES (createx, market: createx alone
// until the shop is deployed and named in SALT_SHOP); each kind has its own bank (/prover/salt/bank: `bank` for CreateX, `marketBank`).
//
// Who is grinding now (every address that sent shares in the last liveMs, Tacit's own named so) and how fast the network grinds (the shares
// of the last hour or so, each the 2^minBits salts a share takes on average) are in GET /prover/salt, for the page's live row.
//
// A banked salt stays in the bank once it has been deployed with (the work was real and its points are paid), so the bank marks the ones
// already used: GET /prover/salt/bank gives each `spent: true` when its address holds code, and `free` for how many are left to deploy to.
// A spent salt is never asked about again; the free ones are asked at most every spentEveryMs, and an RPC that cannot answer leaves the
// marks as they were, so a free salt is never wrongly called spent.
//
// Storage (KV): sl:seen:<salt> (kept 3 days), sl:m:<day>:<miner> ({ shares, weight, best }), sl:miners:<day> ([miner]), sl:bank (best first),
// sl:bank:looked and sl:bank:market:looked (when the free ones were last asked about),
// sl:rate:<client> (when it last sent), sl:live ({ miner: { at, house } }), sl:hour:<n> (shares in UTC hour n).
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

export const SALT_POOL = Object.freeze({
  deployer: '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7',
  createx: '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed',
  market: '0x000000000000b361194cfe6312ee3210d53c15aa',   // SALT_MARKET: the vanity-address market (the same address on every chain it is on)
  shop: null,               // SALT_SHOP: the VanityShop whose address leads the market salts; without it there are no market salts
  schemes: Object.freeze(['createx']),   // SALT_SCHEMES: the kinds of salt the pool takes, the first the one new miners should grind
  nonceMax: 254,            // the highest nonce a market address can have
  minBits: 26,              // SALT_MIN_BITS: a share's address starts with this many zero bits (about a minute of four laptop cores)
  maxWeightBits: 20,        // SALT_MAX_WEIGHT_BITS: a share weighs at most 2^this. The lower it is, the less one connection can earn in a day (it sends 64 shares in 20 s), and the more evenly a day's points go round; at 0 every share weighs the same
  pointsPerDay: 5000,       // POINTS_SALT_DAILY: the most a day's salts may share, whatever the pot (proofs take the rest)
  floorPoints: 3000,        // POINTS_SALT_FLOOR: the least a day's salts share even when the proofs took the whole pot (never more than pointsPerDay), so a laptop's grinding always earns something
  potPoints: 5000,          // the campaign's daily points when its terms cannot be read (50 TAC at 0.01 TAC a point)
  bankBits: 32,             // SALT_BANK_BITS: the best bankKeep salts at least this good (four zero bytes) are kept for deploys
  bankKeep: 64,
  // A banked salt only Tacit's deployer can use, so code at its address means that salt is spent. The bank keeps a spent salt (the work
  // was real and its points are paid), so a reader has to know which are still free: the pool marks them from the chain.
  spentRpcs: Object.freeze(['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org']),   // SALT_SPENT_RPCS
  spentEveryMs: 10 * 60_000,   // how often the free ones are looked at again; a spent one is never looked at twice
  goodBits: 32,           // SALT_GOOD_BITS: a find at least this good (four zero bytes) goes on the page's activity feed (about one a minute at today's rate)
  recentKeep: 30,           // the newest good finds kept for that feed
  perCall: 64,              // salts one send may carry
  sendEveryMs: 20_000,      // one send per client this often
  seenSecs: 3 * 86400,
  daySecs: 40 * 86400,
  liveMs: 15 * 60_000,      // an address that sent shares this recently is grinding now
});
const DAY_MS = 86_400_000, HOUR_MS = 3_600_000;
const PROXY_INIT_HASH = keccak_256(Uint8Array.from([0x67, 0x36, 0x3d, 0x3d, 0x37, 0x36, 0x3d, 0x34, 0xf0, 0x3d, 0x52, 0x60, 0x08, 0x60, 0x18, 0xf3]));
const ADDR = /^0x[0-9a-f]{40}$/;
// A share: the salt, and for a market salt its nonce after a colon (`0x<64 hex>:<0 to 254>`).
const SHARE = /^(0x[0-9a-f]{64})(?::(\d{1,3}))?$/;

// What a miner calls its software, from the share it sends (`client`) or else its HTTP User-Agent: a short label of letters, digits and . _ / + - and spaces, nothing
// else. It is only what the sender says it is: it tells which programs are mining, it proves nothing.
export function softwareLabel(x) {
  if (typeof x !== 'string') return '';
  return x.replace(/[^A-Za-z0-9._\/+ -]/g, '').trim().slice(0, 40).trim();
}

// SALT_SCHEMES (a comma list of createx and market), SALT_SHOP and SALT_MARKET: the kinds of salt taken. Market salts need a shop address; without a valid one the
// market is left out, so a half-set environment cannot open a kind of salt nobody can use.
function marketTerms(env) {
  const addr = (v, d) => (ADDR.test(String(v || '').trim().toLowerCase()) ? String(v).trim().toLowerCase() : d);
  const want = String(env.SALT_SCHEMES || '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => x === 'createx' || x === 'market');
  const shop = addr(env.SALT_SHOP, null);
  const schemes = (want.length ? [...new Set(want)] : ['createx']).filter((x) => x !== 'market' || shop);
  return { schemes: Object.freeze(schemes.length ? schemes : ['createx']), shop, market: addr(env.SALT_MARKET, SALT_POOL.market) };
}

export function saltPoolConfig(env = {}) {
  const n = (v, dflt, lo, hi) => { const x = Number(v); return v != null && v !== '' && Number.isInteger(x) && x >= lo && x <= hi ? x : dflt; };
  return Object.freeze({
    ...SALT_POOL,
    minBits: n(env.SALT_MIN_BITS, SALT_POOL.minBits, 16, 64),
    maxWeightBits: n(env.SALT_MAX_WEIGHT_BITS, SALT_POOL.maxWeightBits, 0, 40),
    pointsPerDay: n(env.POINTS_SALT_DAILY, SALT_POOL.pointsPerDay, 0, 1_000_000),
    floorPoints: n(env.POINTS_SALT_FLOOR, SALT_POOL.floorPoints, 0, 1_000_000),
    bankBits: n(env.SALT_BANK_BITS, SALT_POOL.bankBits, 24, 96),
    spentRpcs: ((us) => (us.length ? Object.freeze(us) : SALT_POOL.spentRpcs))(
      String(env.SALT_SPENT_RPCS || '').split(',').map((u) => u.trim()).filter((u) => /^https:\/\//.test(u)).slice(0, 4)),
    goodBits: n(env.SALT_GOOD_BITS, SALT_POOL.goodBits, 24, 96),
    ...marketTerms(env),
    house: String(env.SALT_HOUSE || SALT_POOL.deployer).split(',').map((a) => a.trim().toLowerCase()).filter((a) => ADDR.test(a)),
  });
}

// The CREATE3 address of a salt from `deployer`, and its leading zero bits.
export function saltAddress(saltHex, { deployer = SALT_POOL.deployer, createx = SALT_POOL.createx } = {}) {
  const salt = hexToBytes(saltHex.slice(2)), dep = hexToBytes(deployer.slice(2));
  const guarded = keccak_256(concatBytes(new Uint8Array(12), dep, salt));
  const proxy = keccak_256(concatBytes(Uint8Array.of(0xff), hexToBytes(createx.slice(2)), guarded, PROXY_INIT_HASH)).slice(12);
  const a = keccak_256(concatBytes(Uint8Array.of(0xd6, 0x94), proxy, Uint8Array.of(0x01))).slice(12);
  return { address: '0x' + bytesToHex(a), bits: zeroBits(a) };
}

// The market's deploy proxy: the init code VanityMarket hashes as DEPLOY_PROXY_INITHASH (checked against the market's own value in the tests).
const MARKET_PROXY_INIT_HASH = keccak_256(hexToBytes('60288060093d393df36001600581360334348434363434376d01e4a82b33373de1334e7d8f48795af49247f034521b34f3'));
const zeroBits = (a) => {
  let bits = 0;
  for (const b of a) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; }
  return bits;
};
// The address of the vanity market's id at `nonce`, and its leading zero bits: the contract the market's deploy proxy (CREATE2 of the id from the market) creates as
// its transaction number nonce + 1 (VanityMarket.computeAddress; the tests hold the market's own answers).
export function marketAddress(idHex, nonce = 0, { market = SALT_POOL.market } = {}) {
  const proxy = keccak_256(concatBytes(Uint8Array.of(0xff), hexToBytes(market.slice(2)), hexToBytes(idHex.slice(2)), MARKET_PROXY_INIT_HASH)).slice(12);
  const n = nonce + 1;   // 1 to 255: RLP is the byte itself up to 0x7f and 0x81 then the byte above that
  const enc = n <= 0x7f ? Uint8Array.of(n) : Uint8Array.of(0x81, n);
  const a = keccak_256(concatBytes(Uint8Array.of(0xc0 + 22 + enc.length - 1, 0x94), proxy, enc)).slice(12);
  return { address: '0x' + bytesToHex(a), bits: zeroBits(a) };
}

function makeLock() {
  let tail = Promise.resolve();
  return (fn) => { const p = tail.then(fn, fn); tail = p.then(() => {}, () => {}); return p; };
}

// kv: { get, put(key, value, { expirationTtl }?) }. potPoints() → the campaign's daily points (its terms: daily amount over the most a
// point earns); proofPoints(day) → the points the day's proofs earned (the proof pool's and the board's tallies). Every call answers
// { status, body }. `codeAt(address)` → whether an address holds code, for marking a banked salt spent; the default asks cfg.spentRpcs.
const marketOn = (cfg) => (cfg.schemes || []).includes('market') && ADDR.test(String(cfg.shop || ''));

// Does an address hold code? Asks each RPC in turn and gives up quietly: a bank whose spent marks could not be refreshed is served with
// the marks it already had, never with a free salt wrongly called spent.
export function makeCodeAt({ rpcs = SALT_POOL.spentRpcs, fetchFn = (...a) => fetch(...a), timeoutMs = 8000 } = {}) {
  return async (address) => {
    for (const url of rpcs) {
      try {
        const r = await fetchFn(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!r.ok) continue;
        const code = (await r.json())?.result;
        if (typeof code === 'string' && code.startsWith('0x')) return code.length > 2;
      } catch { /* the next RPC */ }
    }
    return null;   // unknown: leave the mark alone
  };
}

export function makeSaltPool({ kv, cfg = SALT_POOL, now = () => Date.now(), lock = makeLock(), potPoints = async () => cfg.potPoints, proofPoints = async () => 0, codeAt = null }) {
  // What a day's salts share: what its proofs leave of the pot, up to pointsPerDay, and at least floorPoints (itself never past pointsPerDay)
  // however much the proofs took. The floor is points on top of the pot: the campaign shares its daily amount over every point of the day.
  // `campaignPot`: the campaign's daily points as the day itself had them (the service that pays the day knows its own terms for it); without it the
  // campaign's terms now, which are right for today and wrong for a day gone by once the daily amount has changed.
  const saltPot = async (day, campaignPot = null) => {
    const [pot, used] = await Promise.all([campaignPot != null ? campaignPot : potPoints().catch(() => cfg.potPoints), proofPoints(day).catch(() => 0)]);
    const left = Math.floor((Number(pot) || cfg.potPoints) - (Number(used) || 0));
    return Math.max(0, Math.min(cfg.pointsPerDay, cfg.floorPoints || 0), Math.min(cfg.pointsPerDay, left));
  };
  const read = async (k, d) => { const s = await kv.get(k); if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };
  const write = (k, v, secs) => kv.put(k, JSON.stringify(v), secs ? { expirationTtl: secs } : undefined);
  const dayOf = (t) => Math.floor(t / DAY_MS);
  const reply = (status, body) => ({ status, body });

  // The bank, with each salt marked `spent` if its address holds code by now. Spending is one way, so a salt already marked is never
  // asked about again; the free ones are asked at most every spentEveryMs. An RPC that cannot answer leaves the bank as it stands, so a
  // salt is called spent only on an answer that says so. Readers pick their next deploy address from the ones left free.
  const look = codeAt || makeCodeAt({ rpcs: cfg.spentRpcs || SALT_POOL.spentRpcs });
  async function withSpent(key) {
    const bank = await read(key, []);
    if (!Array.isArray(bank) || !bank.length) return bank;
    const free = bank.filter((b) => !b.spent && ADDR.test(String(b.address || '')));
    const since = Number(await kv.get(`${key}:looked`)) || 0;
    if (!free.length || now() - since < (cfg.spentEveryMs ?? SALT_POOL.spentEveryMs)) return bank;
    // The turn is taken before the chain is asked, so a burst of requests asks once between them, and an RPC that is
    // down costs one round of calls rather than one per request.
    await kv.put(`${key}:looked`, String(now()));
    const seen = await Promise.all(free.map((b) => look(b.address).catch(() => null)));
    const spent = new Set(free.filter((b, i) => seen[i] === true).map((b) => b.address));
    if (!spent.size) return bank;
    return lock(async () => {
      // re-read inside the lock: a send may have rewritten the bank while the chain was being asked
      const marked = (await read(key, [])).map((b) => (spent.has(b.address) ? { ...b, spent: true } : b));
      await write(key, marked);
      return marked;
    });
  }
  const bankView = ({ address, bits, miner, at, house, spent }) => ({ address, bits, miner, at, ...(house ? { house: true } : {}), ...(spent ? { spent: true } : {}) });

  // A send: { miner, salts: [0x…], client } → { accepted, weight, rejected: [{ salt, why }] }.
  async function submit({ miner, salts, client, software, ua }) {
    miner = String(miner || '').toLowerCase();
    if (!ADDR.test(miner)) return reply(400, { ok: false, error: 'miner must be the 0x address the points go to' });
    if (!Array.isArray(salts) || !salts.length || salts.length > cfg.perCall) return reply(400, { ok: false, error: `salts must be 1 to ${cfg.perCall} salts` });
    const t = now(), day = dayOf(t);
    return lock(async () => {
      const last = Number(await kv.get(`sl:rate:${client}`)) || 0;
      if (t - last < cfg.sendEveryMs) return reply(429, { ok: false, error: `one send every ${cfg.sendEveryMs / 1000} s`, retryMs: cfg.sendEveryMs - (t - last) });
      await write(`sl:rate:${client}`, t, 120);
      const schemes = cfg.schemes || ['createx'];
      const heads = { createx: schemes.includes('createx') ? cfg.deployer.slice(2) + '00' : null, market: schemes.includes('market') && cfg.shop ? cfg.shop.slice(2) + '00' : null };
      const days = [day % 65536, (day - 1 + 65536) % 65536];
      const rec = await read(`sl:m:${day}:${miner}`, { shares: 0, weight: 0, best: null });
      const wasNew = rec.shares === 0;
      // Tacit's own machines (cfg.house, the deployer by default) bank what they find and earn nothing: they never share the day's points.
      const house = (cfg.house || [SALT_POOL.deployer]).includes(miner);
      const rejected = [], good = [], banked = { createx: [], market: [] };
      let accepted = 0, weight = 0;
      for (const raw of [...new Set(salts.map((s) => String(s).toLowerCase()))]) {
        const shape = SHARE.exec(raw);
        const salt = shape ? shape[1] : raw;
        const scheme = !shape ? null : heads.createx && salt.slice(2, 44) === heads.createx ? 'createx' : heads.market && salt.slice(2, 44) === heads.market ? 'market' : null;
        if (!scheme) { rejected.push({ salt: raw.slice(0, 66), why: heads.market ? 'not a salt of Tacit\'s deployer or shop' : 'not a salt of Tacit\'s deployer' }); continue; }
        const nonce = shape[2] == null ? 0 : Number(shape[2]);
        if (scheme === 'createx' && shape[2] != null) { rejected.push({ salt: raw, why: 'a nonce is for market salts only' }); continue; }
        if (nonce > cfg.nonceMax) { rejected.push({ salt: raw, why: `nonce over ${cfg.nonceMax}` }); continue; }
        if (!days.includes(parseInt(salt.slice(44, 48), 16))) { rejected.push({ salt: raw, why: 'not ground today' }); continue; }
        const { address, bits } = scheme === 'market' ? marketAddress(salt, nonce, cfg) : saltAddress(salt, cfg);
        if (bits < cfg.minBits) { rejected.push({ salt: raw, why: `${bits} zero bits, under ${cfg.minBits}` }); continue; }
        if (await kv.get(`sl:seen:${salt}`) != null) { rejected.push({ salt: raw, why: 'already counted' }); continue; }
        await write(`sl:seen:${salt}`, { miner, at: t }, cfg.seenSecs);
        const w = 2 ** Math.min(bits - cfg.minBits, cfg.maxWeightBits);
        accepted++; weight += w;
        if (!rec.best || bits > rec.best.bits) rec.best = { address, bits, salt };
        if (bits >= cfg.bankBits) banked[scheme].push({ salt, address, bits, miner, at: t, ...(scheme === 'market' ? { nonce } : {}), ...(house ? { house: true } : {}) });
        if (bits >= cfg.goodBits) good.push({ address, bits, miner, at: t, ...(house ? { house: true } : {}) });
      }
      if (accepted) {
        if (!house) {
          rec.shares += accepted; rec.weight += weight;
          await write(`sl:m:${day}:${miner}`, rec, cfg.daySecs);
          if (wasNew) { const list = await read(`sl:miners:${day}`, []); if (!list.includes(miner)) { list.push(miner); await write(`sl:miners:${day}`, list, cfg.daySecs); } }
        }
        // The bank is the best bankKeep salts found so far: it is written only when one of these enters it, so once it is full it
        // changes only on a better find.
        for (const [scheme, found] of Object.entries(banked)) {
          if (!found.length) continue;
          const key = scheme === 'market' ? 'sl:bank:market' : 'sl:bank';
          const bank = [...await read(key, []), ...found].sort((a, b) => b.bits - a.bits || a.at - b.at).slice(0, cfg.bankKeep);
          if (bank.some((b) => found.includes(b))) await write(key, bank);
        }
        // The newest good finds, newest first, for the page's activity feed: written only when a send brings one.
        if (good.length) await write('sl:recent', [...good.sort((a, b) => b.bits - a.bits), ...await read('sl:recent', [])].slice(0, cfg.recentKeep));
        const live = Object.fromEntries(Object.entries(await read('sl:live', {})).filter(([, v]) => t - v.at < cfg.liveMs));
        const sw = softwareLabel(software) || softwareLabel(ua);
        live[miner] = { at: t, ...(sw ? { sw } : {}), ...(house ? { house: true } : {}) };
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
  async function credits(day, { pot: campaignPot = null } = {}) {
    const today = dayOf(now());
    if (!Number.isInteger(day) || day > today || day < today - 39) return reply(400, { ok: false, error: 'day must be a UTC day number, today or before' });
    const recs = await dayMiners(day);
    const total = recs.reduce((s, r) => s + r.weight, 0);
    const pot = await saltPot(day, Number.isSafeInteger(campaignPot) && campaignPot > 0 && campaignPot <= 100_000_000 ? campaignPot : null);
    const miners = recs.map((r) => ({ miner: r.miner, proofs: r.shares, points: total ? Math.floor((pot * r.weight) / total) : 0 }));
    return reply(200, { day, over: day < today, pointsPerDay: pot, miners });
  }
  async function summary() {
    const t = now(), day = dayOf(t), recs = await dayMiners(day);
    const bank = await withSpent('sl:bank');
    const market = marketOn(cfg);
    const marketBank = market ? await withSpent('sl:bank:market') : [];
    // The rate: the last hour's shares and this one's so far, over the time they span, each 2^minBits salts on average.
    const h = Math.floor(t / HOUR_MS), [prev, cur] = await Promise.all([kv.get(`sl:hour:${h - 1}`), kv.get(`sl:hour:${h}`)]);
    const span = HOUR_MS + (t - h * HOUR_MS);
    const rate = Math.round((((Number(prev) || 0) + (Number(cur) || 0)) * 2 ** cfg.minBits) / (span / 1000));
    const live = Object.entries(await read('sl:live', {})).filter(([, v]) => t - v.at < cfg.liveMs)
      .sort((a, b) => b[1].at - a[1].at).map(([miner, v]) => ({ miner, at: v.at, ...(v.sw ? { sw: v.sw } : {}), ...(v.house ? { house: true } : {}) }));
    // the miners sending now, by what their software calls itself ('unknown': it said nothing); Tacit's own machines are not counted
    const software = {};
    for (const m of live) if (!m.house) software[m.sw || 'unknown'] = (software[m.sw || 'unknown'] || 0) + 1;
    return reply(200, {
      // today's pot so far: it shrinks as the day's proofs come in
      deployer: cfg.deployer, createx: cfg.createx, schemes: cfg.schemes || ['createx'], ...(market ? { shop: cfg.shop, market: cfg.market, nonceMax: cfg.nonceMax } : {}), minBits: cfg.minBits, maxWeightBits: cfg.maxWeightBits, bankBits: cfg.bankBits, pointsPerDay: await saltPot(day), day, rate, live, software: Object.fromEntries(Object.entries(software).sort((a, b) => b[1] - a[1])),
      today: { miners: recs.length, shares: recs.reduce((s, r) => s + r.shares, 0), weight: recs.reduce((s, r) => s + r.weight, 0) },
      top: recs.sort((a, b) => b.weight - a.weight).slice(0, 20).map((r) => ({ miner: r.miner, shares: r.shares, weight: r.weight, best: r.best })),
      bank: bank.slice(0, 10).map(bankView),
      banked: bank.length, bankFree: bank.filter((b) => !b.spent).length,
      ...(market ? { marketBank: marketBank.slice(0, 10).map((b) => ({ ...bankView(b), nonce: b.nonce })), marketBanked: marketBank.length, marketBankFree: marketBank.filter((b) => !b.spent).length } : {}),
      recent: (await read('sl:recent', [])).slice(0, 12).map(({ address, bits, miner, at, house }) => ({ address, bits, miner, at, ...(house ? { house: true } : {}) })),
    });
  }
  // The whole bank, each salt marked `spent` once its address holds code, and how many are still free to deploy to.
  async function bankList() {
    const bank = await withSpent('sl:bank');
    const market = marketOn(cfg) ? await withSpent('sl:bank:market') : null;
    return reply(200, {
      bank, free: bank.filter((b) => !b.spent).length,
      ...(market ? { marketBank: market, marketFree: market.filter((b) => !b.spent).length } : {}),
    });
  }
  return { submit, credits, summary, bank: bankList };
}

const kvLocks = new WeakMap();
export function buildSaltPool(env, { potPoints, proofPoints } = {}) {
  const kv = env.CONFIDENTIAL_KV || env.REGISTRY_KV;
  if (!kv) return null;
  if (!kvLocks.has(kv)) kvLocks.set(kv, makeLock());
  return makeSaltPool({ kv, cfg: saltPoolConfig(env), lock: kvLocks.get(kv), ...(potPoints ? { potPoints } : {}), ...(proofPoints ? { proofPoints } : {}) });
}
