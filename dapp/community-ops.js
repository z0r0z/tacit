// What anyone can send to keep Bitcoin's state current on Ethereum and earn the open board's fees, shared by the community ops
// page (dapp/prove/ops.js, the Relay and Bitcoin tabs of /prove/) and the runner (tools/community-runner.mjs), so both build the same calls and pass over the same work:
//   - a proof of Bitcoin's state that Tacit's prover has published (GET /reflection/proof) goes to
//     ConfidentialPool.attestBitcoinStateProven while it still builds on the pool's attested digest;
//   - a lane more than REFLECTION_MAX_LAG blocks behind the header relay first takes advanceReflectionAncestry() calls;
//   - a settle on the open board (GET /confidential/open) pays each fee leg its proof binds to whoever sends it.
// The header relay half is dapp/header-relay-advance.js. Nothing here signs: callers pass `call(to, data)` (an eth_call that
// returns hex and throws on a revert) and `fetchImpl`.

import { pvFees, pvDeadline, settleCalldata } from './relay/abi.js';

export { settleCalldata };
export const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
export const SEL_ATTEST = '0x0b36171c';             // attestBitcoinStateProven(bytes,bytes)
export const SEL_ATTESTED_DIGEST = '0xb909cdaf';    // attestedReflectionDigest()
export const SEL_ANCESTRY = '0xaa9e6609';           // advanceReflectionAncestry()
export const REFLECTION_MAX_LAG = 2016;
export const ATTEST_GAS = 550_000n;                 // about what an attest uses: a figure before the node's own estimate
export const SETTLE_GAS = 600_000n;                 // an ordinary settle: prices a board job before its own estimate
// tETH, the asset the board's fees are valued in here: its pool asset id and the wei one in-pool unit is worth.
export const ETH_ASSET_ID = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
export const ETH_UNIT_SCALE = 10_000_000_000n;
// TAC, valued too: at the TAC/tETH pool's spot price (its 0.3% pool on this pool contract, public reserves), taken at 80% for the price
// risk of a sender paid in TAC. A sender fooled by a moved price loses only the gas it chose to spend; moving the price costs more.
export const TAC_ASSET_ID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
export const TAC_ETH_POOL_ID = '0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00';   // keccak(tETH ‖ TAC ‖ be32(30)), lower id first
export const TAC_DISCOUNT_BPS = 8000n;
const SEL_POOLS = '0xb5217bb4';                     // pools(bytes32) → init, assetA, assetB, reserveA, reserveB, feeBps, totalShares
// The wei one TAC pool unit is worth to a sender, from the pool's reserves of tETH and TAC (both in pool units), with the discount.
export const tacWeiPerUnit = (ethUnits, tacUnits) => (BigInt(tacUnits) > 0n ? (BigInt(ethUnits) * ETH_UNIT_SCALE * TAC_DISCOUNT_BPS) / (BigInt(tacUnits) * 10000n) : 0n);
// It read from the pool with `call(to, data)`: → { tacWeiPerUnit } or null when the pool is not there.
export async function readPrices({ call }) {
  const h = String(await call(POOL, SEL_POOLS + TAC_ETH_POOL_ID.slice(2))).replace(/^0x/, '');
  const w = (i) => BigInt('0x' + (h.slice(i * 64, i * 64 + 64) || '0'));
  if (h.length < 64 * 7 || w(0) === 0n) return null;
  const aIsEth = lc('0x' + h.slice(64, 128)) === ETH_ASSET_ID;
  const per = aIsEth ? tacWeiPerUnit(w(3), w(4)) : tacWeiPerUnit(w(4), w(3));
  return per > 0n ? { tacWeiPerUnit: per } : null;
}

const HEX_BYTES = /^0x(?:[0-9a-f]{2})+$/i, WORD = /^0x[0-9a-f]{64}$/i;
const lc = (s) => String(s || '').toLowerCase();
const trimSlash = (s) => String(s).replace(/\/+$/, '');
const webFetch = (...a) => globalThis.fetch(...a);

// ETH as a short figure: three decimals from 0.01 up, two significant digits below, "<0.0001" under that.
export function ethText(wei) {
  const x = Number(BigInt(wei)) / 1e18;
  return x >= 0.01 ? x.toFixed(3) : x >= 0.0001 ? x.toPrecision(2) : x > 0 ? '<0.0001' : '0';
}

// ── proofs of Bitcoin's state ──
// attestBitcoinStateProven(bytes publicValues, bytes proof): two dynamic arguments, offsets from the start of the arguments.
export function encodeAttest(publicValues, proof) {
  const pad32 = (n) => n.toString(16).padStart(64, '0');
  const body = (hex) => { const h = hex.replace(/^0x/, ''); return pad32(h.length / 2) + h + '0'.repeat((64 - (h.length % 64)) % 64); };
  const a = body(publicValues), b = body(proof);
  return SEL_ATTEST + pad32(0x40) + pad32(0x40 + a.length / 2) + a + b;
}
// What a published proof is to the pool whose attested digest is `digest`: 'none' (nothing published), 'malformed' (not in the form
// the pool takes), 'spent' (it builds on a state the pool has left: landed already, or passed by another proof), or 'ready'.
export function attestOffer(rec, digest) {
  if (!rec) return 'none';
  if (!WORD.test(rec.priorDigest || '') || !HEX_BYTES.test(rec.publicValues || '') || !HEX_BYTES.test(rec.proof || '')) return 'malformed';
  return lc(rec.priorDigest) === lc(digest) ? 'ready' : 'spent';
}
// The latest published proof and the pool's digest, read together. → { rec, digest, offer }
export async function readProof({ api, call, fetchImpl = webFetch, network = 'mainnet' }) {
  const [r, digest] = await Promise.all([
    fetchImpl(`${trimSlash(api)}/reflection/proof?network=${network}`).then((x) => { if (!x.ok) throw new Error(`reflection/proof: HTTP ${x.status}`); return x.json(); }),
    call(POOL, SEL_ATTESTED_DIGEST),
  ]);
  const rec = (r && r.proof) || null;
  return { rec, digest: lc(digest), offer: attestOffer(rec, digest) };
}
// The pool's refusal of an attest, in words, when its error names one of the two that mean the proof no longer fits.
export function attestRefusal(message) {
  const m = String(message || '');
  if (/e677decb/i.test(m)) return 'the pool has already moved past this batch';
  if (/d3897419/i.test(m)) return 'the header relay has not confirmed this batch yet';
  return null;
}
// A lane more than REFLECTION_MAX_LAG blocks behind the relay's confirmed tip needs a checkpoint first; each call walks at most that many.
export const needsAncestry = (lag) => lag != null && lag > REFLECTION_MAX_LAG;
export const ancestryCalls = (lag) => Math.max(1, Math.ceil((lag - REFLECTION_MAX_LAG) / REFLECTION_MAX_LAG));

// ── the open board ──
// What a proof pays its sender in ETH: its tETH legs at the asset's unit scale. Legs in other assets count nothing here.
export function ethFeeWei(publicValues) {
  try { return pvFees(publicValues).filter((f) => lc(f.assetId) === ETH_ASSET_ID).reduce((a, f) => a + f.value * ETH_UNIT_SCALE, 0n); }
  catch { return 0n; }
}
// ... and with `prices` (readPrices): its TAC legs too, at what a sender takes TAC to be worth.
export function feeWeiOf(publicValues, prices = null) {
  const per = prices?.tacWeiPerUnit ? BigInt(prices.tacWeiPerUnit) : 0n;
  try { return pvFees(publicValues).reduce((a, f) => a + (lc(f.assetId) === ETH_ASSET_ID ? f.value * ETH_UNIT_SCALE : lc(f.assetId) === TAC_ASSET_ID ? f.value * per : 0n), 0n); }
  catch { return 0n; }
}
// When a job's settle stops being accepted, in ms (0 = never): the board's figure, else the deadline its proof commits to.
export function expiresAtMs(job) {
  const by = Number(job?.expiresAt) || 0;
  if (by) return by;
  try { return pvDeadline(job.publicValues) * 1000; } catch { return 0; }
}
// A job any account can send now: open (no sender has taken it), with its proof and memos, and not expiring within `marginMs`.
export function sendable(job, { nowMs = Date.now(), marginMs = 120_000 } = {}) {
  if (!job || job.status !== 'open' || !HEX_BYTES.test(job.publicValues || '') || !HEX_BYTES.test(job.proof || '') || !Array.isArray(job.memos)) return false;
  const by = expiresAtMs(job);
  return !(by && by - nowMs < marginMs);
}
// The board in figures: how many jobs can be sent, their tETH fees together, and the board's own USD figure for all their legs.
export function boardSummary(jobs, opts = {}) {
  const ready = (jobs || []).filter((j) => sendable(j, opts));
  const feeUsd = ready.reduce((a, j) => a + (Number.isFinite(j.feeUsd) && j.feeUsd > 0 ? j.feeUsd : 0), 0);
  return { waiting: ready.length, feeWei: ready.reduce((a, j) => a + feeWeiOf(j.publicValues, opts.prices), 0n), feeUsd };
}
// Whether a fee pays `costWei` with `marginBps` to spare.
export const feeCovers = (feeWei, costWei, marginBps = 0n) => BigInt(feeWei) >= (BigInt(costWei) * (10000n + BigInt(marginBps))) / 10000n;
// The job to send next, or null. With `costWei`: the oldest whose tETH fee covers that cost with `marginBps` to spare, as a relayer
// that sends only what pays picks. Without: the one paying the most (in tETH, then by the board's USD figure), oldest among equals.
// `skip` holds job ids to pass over (ones that would not go through a moment ago).
export function pickSettle(jobs, { costWei = null, marginBps = 0n, nowMs = Date.now(), marginMs = 120_000, skip = null, prices = null } = {}) {
  const live = (jobs || []).filter((j) => sendable(j, { nowMs, marginMs }) && !(skip && skip.has(j.jobId)))
    .map((j) => ({ j, fee: feeWeiOf(j.publicValues, prices), usd: Number(j.feeUsd) || 0, since: Number(j.openSince) || 0 }));
  if (costWei != null) return live.filter((x) => feeCovers(x.fee, costWei, marginBps)).sort((a, b) => a.since - b.since)[0]?.j || null;
  return live.sort((a, b) => (b.fee > a.fee ? 1 : b.fee < a.fee ? -1 : 0) || b.usd - a.usd || a.since - b.since)[0]?.j || null;
}
// The board as the API lists it, refused when it names a pool other than POOL: settles go to the pool named here, not by the answer.
export async function readBoard({ api, fetchImpl = webFetch, limit = 64 }) {
  const res = await fetchImpl(`${trimSlash(api)}/confidential/open?limit=${Number(limit)}`);
  if (!res.ok) throw new Error(`confidential/open: HTTP ${res.status}`);
  const b = await res.json();
  if (b?.pool && lc(b.pool) !== lc(POOL)) throw new Error(`the board names pool ${b.pool}, not ${POOL}`);
  return { pool: b?.pool || null, jobs: Array.isArray(b?.jobs) ? b.jobs : [] };
}
// Tells the API a job landed, so it leaves the board and its holder's page reads it settled. → { ok, status } as the API answers.
export async function reportLanded({ api, fetchImpl = webFetch, jobId, txHash }) {
  const res = await fetchImpl(`${trimSlash(api)}/confidential/landed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId, txHash }) });
  let body = null;
  try { body = await res.json(); } catch { /* the status alone */ }
  return { ok: res.ok && body?.ok !== false, status: res.status, body };
}
