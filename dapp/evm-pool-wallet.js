// Wallet for the EVM pool (contracts/src/TacitEvmPool.sol) on one chain: keys from the Tacit identity, notes found in
// the pool's Transact events and the router's Received events, and spends proved on this device and submitted by a
// relayer (worker-relay/src/evm-pool-keeper.js), so the user needs no gas and no funded address, or from the user's
// own wallet (a signer), with no relayer at all.
//
// Keys are the Bitcoin pool's: seed = HMAC-SHA256(identity key, "tacit-btc-pool-seed-v1"), wallet under the
// "mainnet" tag, so one Secret Sats address (bp1…) receives in both pools.
//
// Memo, one per output note, 65 bytes: pk_eph (33) ‖ ct (16) ‖ tag (16).
//   s    = compress(e·V) for the sender, compress(v·pk_eph) for the recipient (V = v·G, the address's view key)
//   npk, rho from outputKeys(A, N, s)                                      (dapp/btc-pool-zk.js, as the Bitcoin pool)
//   k    = keccak256("tacit-evm-pool-aead-v1" ‖ s)
//   ct   = be16(value) ⊕ keccak256(k ‖ 0x0000)[0..16)
//   tag  = keccak256("tacit-evm-pool-aead-tag-v1" ‖ k ‖ ct)[0..16)
// A memo is accepted only if its leaf recomputes: Poseidon(asset, value, npk, rho) = the output's leaf.

import { secp, keccak_256, sha256, hmac, concatBytes } from './vendor/tacit-deps.min.js';
import { makeBtcShieldedPool } from './btc-shielded-pool.js';
import { poolAsset, extDataHash } from './evm-pool-zk.js';
import { sharedSecrets } from './evm-pool-scan.js';
import { refuses } from './eth-nodes.js';
import { pace } from './rpc-pace.js';
import { depositIntent, receiveKeys, receivedNote, receiveBoxAddress, sweepWitness, callIntent, callEscrowAddress, callIntentJson, callIntentAbi, CALL_INTENT_SIG, calldata, selector, bridgeEthCall, L2_BRIDGES, RECEIVE_FEE_BPS, RECEIVE_INDEX } from './evm-pool-gateway.js';

export const MEMO_LEN = 65;
const REFUND_GAP = 20;
const te = new TextEncoder();
const TAG_AEAD = te.encode('tacit-evm-pool-aead-v1');
const TAG_MAC = te.encode('tacit-evm-pool-aead-tag-v1');
const TAG_EPH = te.encode('tacit-evm-pool-eph-v1');
const SEED_TAG = te.encode('tacit-btc-pool-seed-v1');
const ZERO = '0x0000000000000000000000000000000000000000';

// The relayer addresses and the most a relayed spend may pay, per chain. A quote is signed into the proof, so the
// wallet refuses one from another chain or pool, from an unexpected address, or above the ceiling. A chain config
// may override with `relayer` and `maxRelayFee`. The address is pinned only in a browser on a real origin, so a test
// or tool that runs its own keeper (a local page, node) keeps working; the other checks always apply.
const RELAYERS = {
  1: '0x7c9f8aE4e48Cbb2727F95b6477a1cf92bCFc43D0',
  8453: '0xfA2afbaB631C7Eda7CeA6AE1440605C504E322Ec',
  4663: '0xc1F8DAc6BC910A5A794b4795b5F9997e0E8A5Fad',
  4326: '0x69e4ea1992561Ce129713899244209Fd955E7D89',
};
const MAX_RELAY_FEE = { 1: 5n * 10n ** 16n, 8453: 2n * 10n ** 15n, 4663: 2n * 10n ** 15n, 4326: 2n * 10n ** 15n };
// The catch-up registry (TacitEvmPoolCheckpoints, docs/EVM-POOL.md), at one address on every chain, keeps points for the ETH pool at its one
// address: a wallet with nothing read starts at the newest point the pool vouches for, and reads the history behind it afterwards.
const ETH_POOL = '0x000000c2a20657ce25f2ba99737933d031afbee9', CHECKPOINTS = '0x00000000C3267616ED5E0DAA6F6490D109d6844D';
// One read of the history behind a point at a time for each saved state, however many wallets on the page share it.
const BACKFILLS = new Map();

// Where a read of the keeper's history feed starts. A wallet that has been away, its place more than ten minutes behind
// the tip, asks from the start of the cell its place falls in (a range of blocks counted from the pool's first block: a day
// on Ethereum, an hour on Base, where a day holds thousands of events), not from the place itself, so every wallet in a cell
// sends the same request and the request does not say when this one last read. What the wallet already holds is skipped
// when the page arrives. A wallet that is current asks from its place, which for every current wallet is within a few blocks
// of the tip, so a poll costs only what is new. A chain not listed here gets Ethereum's.
const FEED_CELL = { 1: 7_200, 8453: 1_800, 4326: 86_400, 4663: 830_000 };
const FEED_CURRENT = { 1: 50, 8453: 300, 4326: 600, 4663: 5_770 };
export function feedStart(chainId, deployBlock, from, tip) {
  const id = Number(chainId), cell = FEED_CELL[id] ?? FEED_CELL[1], first = Number(deployBlock ?? 0);
  if (tip !== undefined && tip - from <= (FEED_CURRENT[id] ?? FEED_CURRENT[1])) return from;
  return from > first ? from - ((from - first) % cell) : from;
}
const VMAX = 1n << 120n;
const G = secp.ProjectivePoint.BASE;
const N_SECP = secp.CURVE.n;

const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => { const s = String(h).replace(/^0x/, ''); return Uint8Array.from(s.match(/../g) || [], (b) => parseInt(b, 16)); };
const toBig = (b) => { let x = 0n; for (const c of b) x = (x << 8n) | BigInt(c); return x; };
const be = (v, n) => { let x = BigInt(v); const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const word = (x) => be(BigInt(x), 32);
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const randomScalar = () => { for (;;) { const s = toBig(globalThis.crypto.getRandomValues(new Uint8Array(32))) % N_SECP; if (s) return s; } };

// ── keys ──

// { v, V, a, n, A, N, address (bp1…), zkWallet } from a 32-byte Tacit identity key.
export function evmPoolKeys(zk, identityPriv) {
  if (!(identityPriv instanceof Uint8Array) || identityPriv.length !== 32) throw new Error('evm-pool-wallet: identity key must be 32 bytes');
  const pool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });
  const seed = hmac(sha256, identityPriv, SEED_TAG);
  const w = pool.walletFromSeed(seed, 'mainnet');
  const zkWallet = zk.walletKeys(seed, 'mainnet');
  return { v: BigInt(w.v), V: G.multiply(BigInt(w.v)), zkWallet, A: zkWallet.A, N: zkWallet.N, address: w.addressString, pool };
}

// ── memos ──

function seal(s, value) {
  const k = keccak_256(concatBytes(TAG_AEAD, s));
  const ks = keccak_256(concatBytes(k, new Uint8Array(2))).subarray(0, 16);
  const ct = be(value, 16).map((b, i) => b ^ ks[i]);
  return concatBytes(ct, keccak_256(concatBytes(TAG_MAC, k, ct)).subarray(0, 16));
}
function open(s, sealed) {
  const k = keccak_256(concatBytes(TAG_AEAD, s));
  const ct = sealed.subarray(0, 16);
  if (!eq(sealed.subarray(16, 32), keccak_256(concatBytes(TAG_MAC, k, ct)).subarray(0, 16))) return null;
  const ks = keccak_256(concatBytes(k, new Uint8Array(2))).subarray(0, 16);
  return toBig(ct.map((b, i) => b ^ ks[i]));
}

// Saved-state sealing: "enc1:" ‖ hex(nonce16 ‖ ciphertext ‖ tag16), a keccak counter-mode stream and tag under keys
// from the view scalar. openState returns the plain text, passes stored plain JSON through, and null for anything
// that fails its tag.
const TAG_STATE = te.encode('tacit-evm-pool-state-v1');
const stateKeys = (v, nonce) => ({
  enc: keccak_256(concatBytes(TAG_STATE, Uint8Array.of(1), word(v), nonce)),
  mac: keccak_256(concatBytes(TAG_STATE, Uint8Array.of(2), word(v), nonce)),
});
function stateStream(enc, n) {
  const out = new Uint8Array(Math.ceil(n / 32) * 32);
  for (let i = 0; i * 32 < n; i++) out.set(keccak_256(concatBytes(enc, be(BigInt(i), 4))), i * 32);
  return out.subarray(0, n);
}
export function sealState(v, text) {
  const nonce = crypto.getRandomValues(new Uint8Array(16)), pt = te.encode(text), { enc, mac } = stateKeys(v, nonce);
  const ks = stateStream(enc, pt.length), ct = pt.map((b, i) => b ^ ks[i]);
  return 'enc1:' + hex(concatBytes(nonce, ct, keccak_256(concatBytes(mac, ct)).subarray(0, 16)));
}
export function openState(v, stored) {
  if (!stored || !stored.startsWith('enc1:')) return stored || null;
  const b = unhex(stored.slice(5));
  if (b.length < 32) return null;
  const nonce = b.subarray(0, 16), ct = b.subarray(16, b.length - 16), { enc, mac } = stateKeys(v, nonce);
  if (!eq(b.subarray(b.length - 16), keccak_256(concatBytes(mac, ct)).subarray(0, 16))) return null;
  const ks = stateStream(enc, ct.length);
  return new TextDecoder().decode(ct.map((x, i) => x ^ ks[i]));
}

// An output note of `value` for a recipient { V (secp point), A, N (BabyJub) }: { v, npk, rho, leaf, memo }.
export function sealNote(zk, { to, value, asset, e = randomScalar() }) {
  const v = BigInt(value);
  if (v < 0n || v >= VMAX) throw new Error('evm-pool-wallet: value must be below 2^120');
  const s = to.V.multiply(BigInt(e)).toRawBytes(true);
  const o = zk.outputKeys(to.A, to.N, s);
  return { v, npk: o.npk, rho: o.rho, leaf: zk.leafOf(asset, v, o.npk, o.rho), memo: concatBytes(G.multiply(BigInt(e)).toRawBytes(true), seal(s, v)) };
}

const memoBytes = (memo) => (memo instanceof Uint8Array ? memo : unhex(memo));
function opened(zk, keys, s, sealed, { leaf, asset }) {
  const v = open(s, sealed);
  if (v === null || v >= VMAX) return null;
  const o = zk.ownedKeys(keys.zkWallet, s);
  if (zk.leafOf(asset, v, o.npk, o.rho) !== BigInt(leaf)) return null;
  return { v, rho: o.rho, sk: o.sk, nk: o.nk, npk: o.npk, s };
}

// The owned note behind (memo, leaf), or null: { v, rho, sk, nk, npk, s }.
export function openNote(zk, keys, item) {
  const m = memoBytes(item.memo);
  if (m.length !== MEMO_LEN) return null;
  let s;
  try { s = secp.ProjectivePoint.fromHex(m.subarray(0, 33)).multiply(keys.v).toRawBytes(true); } catch { return null; }
  return opened(zk, keys, s, m.subarray(33), item);
}

// openNote for each of [{ memo, leaf, asset }], with the shared secrets computed as one batch.
export function openNotes(zk, keys, items) {
  const ms = items.map((it) => memoBytes(it.memo));
  const live = [];
  ms.forEach((m, i) => { if (m.length === MEMO_LEN) live.push(i); });
  const ss = sharedSecrets(keys.v, live.map((i) => ms[i].subarray(0, 33)));
  const out = items.map(() => null);
  live.forEach((i, j) => { if (ss[j]) out[i] = opened(zk, keys, ss[j], ms[i].subarray(33), items[i]); });
  return out;
}

// The one-time key e of output `k` of a spend whose first input has nullifier `nf`, on `chainId`:
//   e = HMAC-SHA256(key = sha256("tacit-evm-pool-eph-v1" ‖ be32(v)), msg = be32(chainId) ‖ be32(nf) ‖ k [‖ attempt]) mod n
// A nullifier is spent once, so e never repeats across spends. A spend that never landed and is built again from the
// same note (another quote, so another change) takes the next `attempt` (1 to 15, appended to the message; attempt 0
// is the plain form), so two memos never share a keystream. The sender (or a holder of its view key) can derive it again
// from the key alone, to prove the payment to anyone who knows the recipient's address (verifyPayment). Deposits
// have no input and use a random e.
export const PAYMENT_ATTEMPTS = 16;
export function paymentKey(keys, { chainId, nf, k, attempt = 0 }) {
  const key = sha256(concatBytes(TAG_EPH, word(keys.v)));
  const msg = concatBytes(word(BigInt(chainId)), word(BigInt(nf)), Uint8Array.of(k), attempt ? Uint8Array.of(attempt) : new Uint8Array());
  const e = toBig(hmac(sha256, key, msg)) % N_SECP;
  if (!e) throw new Error('evm-pool-wallet: degenerate payment key');
  return e;
}

// Checks a payment proof: that an output with `memo` and `leaf` pays a note to the pool address `to`, given its
// one-time key `e` (paymentKey). → the amount in wei, or null. `keys` is any wallet's, used only to read `to`.
export function verifyPayment(zk, keys, { to, e, memo, leaf, asset }) {
  const r = recipientOf(keys, to), m = memoBytes(memo);
  if (m.length !== MEMO_LEN || !eq(G.multiply(BigInt(e)).toRawBytes(true), m.subarray(0, 33))) return null;
  const s = r.V.multiply(BigInt(e)).toRawBytes(true), v = open(s, m.subarray(33));
  if (v === null) return null;
  const o = zk.outputKeys(r.A, r.N, s);
  return zk.leafOf(asset, v, o.npk, o.rho) === BigInt(leaf) ? v : null;
}

// A recipient from a Secret Sats address string.
const RECIPIENTS = new Map();
export function recipientOf(keys, address) {
  const a = String(address).trim();
  let r = RECIPIENTS.get(a);
  if (!r) {
    const d = keys.pool.decodeAddress(a);
    r = { V: d.V, A: d.A, N: d.N };
    if (RECIPIENTS.size >= 256) RECIPIENTS.delete(RECIPIENTS.keys().next().value);
    RECIPIENTS.set(a, r);
  }
  return { ...r };
}

// ── chain ──

const TRANSACT_TOPIC = hex(keccak_256(te.encode('Transact(bytes32,bytes32,bytes32,bytes32,uint256,bytes32,address,int256,address,uint256,bytes,bytes)')));
const RECEIVED_TOPIC = hex(keccak_256(te.encode('Received(address,uint256,uint256,uint256,uint256,uint256)')));

// A JSON-RPC reader over one or more URLs: each call tries them in turn, starting at the one that answered last, and
// fails only when all do (a revert is final at the first). The error thrown carries every node's error as `all`. A node
// gets `timeoutMs` to answer before the next is tried, so one that stops responding cannot stall every read behind it,
// and the next call starts after it even when none of the others answered either, so a retry does not wait on it again.
// `rpc.node` is the URL that answered last.
export function jsonRpc(urls, fetchImpl = globalThis.fetch.bind(globalThis), { timeoutMs = 25_000 } = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  let id = 0, first = 0;
  const timedOut = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';
  // `{ found: true }` for a record that is known to exist (a transaction in a deep block): a node that answers null for it does
  // not have it (one that keeps recent history only does), so the next is asked, and null comes back only when none has it.
  const single = async (method, params = [], { found = false } = {}) => {
    const all = [], start = first; let none = false;
    // a node known to refuse this read (eth-nodes.js) is asked after those that do not
    const turn = list.map((_, k) => (start + k) % list.length), refused = (i) => refuses(list[i], method, params);
    for (const at of [...turn.filter((i) => !refused(i)), ...turn.filter(refused)]) {
      const url = list[at];
      try {
        const signal = AbortSignal.timeout?.(timeoutMs);
        const r = await pace(url, method, () => fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal }), signal);
        const j = await r.json();
        if (j.error) throw Object.assign(new Error(j.error.message || 'rpc error'), { rpc: j.error });
        if (j.result === undefined) throw new Error(`rpc: no result (HTTP ${r.status})`);
        if (found && j.result == null) { none = true; continue; }
        first = at; single.node = url;
        return j.result;
      } catch (e) {
        if (e.rpc && /revert/i.test(e.message) && (method === 'eth_call' || method === 'eth_estimateGas')) throw e;
        if (timedOut(e)) first = (at + 1) % list.length;
        all.push(e);
      }
    }
    if (none) return null;
    throw Object.assign(all[all.length - 1] || new Error('no rpc url'), { all });
  };
  // `calls` ([{ method, params }]) in one request, → the results in order: a result, null, or an Error for a call the node
  // answered with one. The nodes are tried as above; one that refuses batches as such (Invalid Request, Method not found, an
  // error that speaks of batches, or one answer for the lot) is not asked again, one that answers with anything else but an
  // array (busy, rate limited, failing) is passed over this time only, and one that answers every call with an error counts
  // as failed. Throws when no node takes it, and the caller asks one at a time.
  const noBatch = new Set();
  single.batch = async (calls) => {
    const all = [], start = first;
    for (let k = 0; k < list.length; k++) {
      const at = (start + k) % list.length, url = list[at];
      if (noBatch.has(url)) continue;
      try {
        const base = id; id += calls.length;
        const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: base + i + 1, method: c.method, params: c.params ?? [] }))), signal: AbortSignal.timeout?.(timeoutMs) });
        const j = await r.json();
        if (!Array.isArray(j)) {
          const err = j?.error, why = String(err?.message || j?.message || ''), status = r.status ?? 200;
          const busy = status === 429 || status >= 500 || /\brate\b|rate.?limit|\blimit|too many/i.test(why);
          if (!busy && (err?.code === -32600 || err?.code === -32601 || (status === 200 && (!err || /batch/i.test(why))))) noBatch.add(url);
          throw Object.assign(new Error(why || 'the node did not answer the batch'), err ? { rpc: err } : {});
        }
        const byId = new Map(j.map((x) => [x.id, x]));
        const out = calls.map((_, i) => {
          const x = byId.get(base + i + 1);
          return !x ? new Error('no answer') : x.error ? Object.assign(new Error(x.error.message || 'rpc error'), { rpc: x.error }) : x.result;
        });
        if (calls.length && out.every((x) => x instanceof Error)) throw out[0];
        first = at; single.node = url;
        return out;
      } catch (e) { if (timedOut(e)) first = (at + 1) % list.length; all.push(e); }
    }
    throw Object.assign(all[all.length - 1] || new Error('no node takes batches'), { all });
  };
  return single;
}

// A reader over `rpc` (a jsonRpc) for several wallets reading one chain at once: the calls they make within `wait` ms go to the
// nodes as one batched request, a call asked twice in it (each wallet's eth_blockNumber) once. A call the batch answers with an
// error, or a batch no node takes, is asked again on its own, as jsonRpc asks it (every node, the errors gathered), so the
// wallets' handling of a refused range or a revert is the same as without it. A call with options ({ found }) goes on its own.
export function batchedRpc(rpc, { wait = 15, max = 40 } = {}) {
  let q = [], t = null;
  const flush = async () => {
    const calls = q.splice(0, max); t = q.length ? setTimeout(flush, 0) : null;
    const by = new Map();
    for (const c of calls) { const k = JSON.stringify([c.method, c.params]); if (!by.has(k)) by.set(k, []); by.get(k).push(c); }
    const keys = [...by.keys()], first = keys.map((k) => by.get(k)[0]);
    const done = (k, p) => p.then((v) => { for (const c of by.get(k)) c.ok(v); }, (e) => { for (const c of by.get(k)) c.no(e); });
    let got = null;
    if (first.length > 1 && rpc.batch) { try { got = await rpc.batch(first.map(({ method, params }) => ({ method, params }))); } catch { got = null; } }
    keys.forEach((k, i) => { const r = got?.[i]; done(k, got && !(r instanceof Error) ? Promise.resolve(r) : rpc(first[i].method, first[i].params)); });
  };
  const call = (method, params = [], opts) => (opts ? rpc(method, params, opts) : new Promise((ok, no) => { q.push({ method, params, ok, no }); t ||= setTimeout(flush, wait); }));
  call.batch = rpc.batch;
  return call;
}

// The text of an RPC error and of every node's error behind it, data included, for reading block limits.
const errorText = (e) => (e.all || [e]).map((x) => `${x.message} ${JSON.stringify(x.rpc?.data ?? x.data ?? '')}`).join(' ');

// What to do after an eth_getLogs over `step` blocks failed on every node, read node by node, since one node can refuse
// for its range limit while another is only rate-limited: → { step } a narrower window (the largest limit a node names
// below the current one; else a quarter when any answer speaks of ranges, sizes or limits, as an upstream timeout on a
// wide range often does), { busy } wait and ask again when a node is rate-limited, or null when it is none of these.
export function logFailure(e, step) {
  const each = (e.all || [e]).map((x) => `${x.message} ${JSON.stringify(x.rpc?.data ?? x.data ?? '')}`);
  const sizes = (t) => [...t.matchAll(/(\d[\d,]*)\s*(?:blocks?|range)\b/gi)].map((x) => Number(x[1].replace(/,/g, ''))).filter((n) => n > 0);
  const below = each.flatMap(sizes).filter((n) => n < step);
  if (below.length) return { step: Math.max(...below) };
  if (each.some((t) => /rate.?limit|too many requests|\b429\b|over rate|capacity/i.test(t))) return { busy: true };
  if (step > 1 && each.some((t) => /range|limit|too many|too large|exceed|response size|10000/i.test(t))) return { step: Math.max(1, Math.floor(step / 4)) };
  return null;
}

// How many merges, each paying `fee` out of the merged note, get two of the notes `values` to cover `need` (the plan
// prepare() follows): 0 when two already do, null when no run of merges does. Pure, so a spend is refused before the
// first merge is paid for.
export function mergePlan(values, need, fee) {
  const u = values.map(BigInt).sort((a, b) => (a < b ? -1 : 1));
  for (let merges = 0; merges < 8; merges++) {
    if (u.length && u[u.length - 1] >= need) return merges;
    if (u.length > 1 && u[u.length - 1] + u[u.length - 2] >= need) return merges;
    if (u.length < 2) return null;
    const a = u.pop(), b = u.pop();
    if (a + b <= fee) return null;
    u.push(a + b - fee);
    u.sort((x, y) => (x < y ? -1 : 1));
  }
  return null;
}

function decodeTransact(log) {
  const d = unhex(log.data);
  const w = (i) => d.subarray(32 * i, 32 * i + 32);
  const bytesAt = (off) => { const o = Number(toBig(d.subarray(off, off + 32))); const len = Number(toBig(d.subarray(o, o + 32))); return d.slice(o + 32, o + 32 + len); };
  return {
    nf: [BigInt(log.topics[1]), BigInt(log.topics[2])],
    outLeaf: [toBig(w(0)), toBig(w(1))],
    firstIndex: Number(toBig(w(2))),
    memo: [bytesAt(32 * 8), bytesAt(32 * 9)],
    block: Number(BigInt(log.blockNumber)),
    tx: log.transactionHash,
  };
}
function decodeReceived(log) {
  const d = unhex(log.data);
  const w = (i) => toBig(d.subarray(32 * i, 32 * i + 32));
  return { box: String(log.topics[1]).toLowerCase(), n: BigInt(log.topics[2]), index: Number(w(0)), value: w(1), rho: w(2), fee: w(3), block: Number(BigInt(log.blockNumber)), tx: log.transactionHash };
}

// ── calls a signer submits ──

const PAIR = { tuple: ['uint256', 'uint256'] };
const TX_TYPES = [PAIR, { tuple: [PAIR, PAIR] }, PAIR, { tuple: Array(11).fill('uint256') }, 'address', 'uint256', 'address', 'uint256', 'bytes', 'bytes'];
const TX_SIG = '(uint256[2],uint256[2][2],uint256[2],uint256[11],address,int256,address,uint256,bytes,bytes)';
const txValues = (t) => [t.pA, t.pB, t.pC, t.publicInputs, t.recipient, BigInt.asUintN(256, BigInt(t.extAmount)), t.relayer, t.fee, t.memo0, t.memo1];
const transactData = (t) => calldata(`transact${TX_SIG}`, TX_TYPES, txValues(t));
const withdrawAndCallData = (t, i) => { const a = callIntentAbi(i); return calldata(`withdrawAndCall(${TX_SIG},${CALL_INTENT_SIG})`, [{ tuple: TX_TYPES }, a.type], [txValues(t), a.value]); };
const WRAP_SIG = '(bytes32,uint256,uint256,address,bytes32,address,uint64,uint256)';
const DEPOSIT_TYPES = ['uint256', 'uint256', 'uint256', 'bytes32', 'bytes32', 'address', 'uint64', 'uint256'];
const WRAP_TYPES = ['bytes32', 'uint256', 'uint256', 'address', 'bytes32', 'address', 'uint64', 'uint256'];
const wrapValues = (i) => [i.assetId, i.amount, i.tip, i.tipTo, i.commit, i.refund, i.deadline, i.nonce];
const withdrawToV1Data = (t, i) => calldata(`withdrawToV1(${TX_SIG},${WRAP_SIG})`, [{ tuple: TX_TYPES }, { tuple: WRAP_TYPES }], [txValues(t), wrapValues(i)]);
// V1's tETH (native ETH) asset id and its unit: a wrap amount is a whole number of 1e10 wei.
export const V1_TETH_ASSET_ID = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const V1_UNIT = 10n ** 10n;
const sweepData = (npk, feeBps, t) => calldata(`sweepReceive(uint256,uint16,${TX_SIG})`, ['uint256', 'uint16', { tuple: TX_TYPES }], [npk, feeBps, txValues(t)]);
// Reverts meaning another transaction landed first: prove again against the new state.
const RACED = new Set(['StaleRoot()', 'WrongInsertionIndex()', 'UnknownMembershipRoot()', 'BadIntent()'].map((e) => hex(selector(e))));
const ALREADY_SPENT = hex(selector('AlreadyNullified()'));
const revertData = (e) => { for (let x = e; x; x = x.cause) { const d = x.rpc?.data?.data ?? x.rpc?.data ?? x.data?.data ?? x.data; if (typeof d === 'string' && d.startsWith('0x')) return d; } return ''; };

// The router calls that pay a token pool's deposit (TacitEvmPoolRouter), as the `selfCall` of deposit/depositTo. `pull` is how the
// router takes the token from the signer:
//   { kind: 'allowance' }                      an allowance to the router is in place already
//   { kind: 'permit', value, deadline, v, r, s }  an EIP-2612 permit for the router, which the router applies first
//   { kind: 'permit2', permitSingle, sig }     a Permit2 signature naming the router
//   { kind: 'batch', token }                   no allowance: an approval of exactly this deposit, in the same batch (the call's `before`)
// The amount every way takes is the deposit's own `extAmount`, so the call cannot move more or less than the proof says; a permit
// for another amount is refused here. A permit that fails on chain is skipped by the router, so a missing allowance reverts the
// call, and the signer's pre-send check (eth_call, or eth_simulateV1 for a batch) refuses it.
const NO_PERMIT = { deadline: 0n, v: 0, r: '0x' + '00'.repeat(32), s: '0x' + '00'.repeat(32) };
const TX_TUPLE = { tuple: TX_TYPES };
const PERMIT2_TYPES = [{ tuple: ['address', 'uint256', 'uint256', 'uint256'] }, 'address', 'uint256'];
export const approveCall = (token, spender, amount) => ({ to: token, data: calldata('approve(address,uint256)', ['address', 'uint256'], [spender, BigInt(amount)]), value: 0n });
export function routerDeposit(router, tx, pull = { kind: 'allowance' }) {
  const amount = BigInt(tx.extAmount);
  if (amount <= 0n) throw new Error('evm-pool-wallet: a deposit has a positive amount');
  const permit = (p) => ({ to: router, data: calldata(`depositWithPermit(${TX_SIG},uint256,uint8,bytes32,bytes32)`, [TX_TUPLE, 'uint256', 'uint8', 'bytes32', 'bytes32'], [txValues(tx), p.deadline, p.v, p.r, p.s]) });
  if (pull.kind === 'allowance') return permit(NO_PERMIT);
  if (pull.kind === 'permit') {
    if (BigInt(pull.value) !== amount) throw new Error('evm-pool-wallet: the permit is for another amount than this deposit');
    return permit(pull);
  }
  if (pull.kind === 'permit2') {
    const d = pull.permitSingle.details;
    if (BigInt(d.amount) !== amount) throw new Error('evm-pool-wallet: the Permit2 signature is for another amount than this deposit');
    const ps = [[d.token, d.amount, d.expiration, d.nonce], pull.permitSingle.spender, pull.permitSingle.sigDeadline];
    return { to: router, data: calldata(`depositWithPermit2(${TX_SIG},((address,uint160,uint48,uint48),address,uint256),bytes)`, [TX_TUPLE, { tuple: PERMIT2_TYPES }, 'bytes'], [txValues(tx), ps, pull.sig]) };
  }
  if (pull.kind === 'batch') return { ...permit(NO_PERMIT), before: [approveCall(pull.token, router, amount)] };
  throw new Error(`evm-pool-wallet: unknown way to pay, ${pull.kind}`);
}
// The zap's call that shields a token into the ETH pool (TacitEvmPoolZap), as the `selfCall` of deposit/depositTo: it takes `amountIn` of
// `token` from the signer, runs `swap` (zRouter calldata paying the zap at least the deposit's ETH) and deposits exactly the proof's
// `extAmount`; what the swap leaves goes back to the signer. It is sent no ETH. `pull` is how the zap takes the token:
//   { kind: 'allowance' }                          an allowance to the zap is in place already
//   { kind: 'permit', value, deadline, v, r, s }   an EIP-2612 permit of exactly `amountIn` for the zap, which the zap applies first
//   { kind: 'permit2', nonce, deadline, sig }      a Permit2 signature transfer of exactly `amountIn` naming the zap
export function zapDeposit(zap, tx, { token, amountIn, swap, pull = { kind: 'allowance' } }) {
  const a = BigInt(amountIn), T = { tuple: TX_TYPES };
  if (BigInt(tx.extAmount) <= 0n) throw new Error('evm-pool-wallet: a deposit has a positive amount');
  if (pull.kind === 'allowance') return { to: zap, value: 0n, data: calldata(`zapToken(${TX_SIG},address,uint256,bytes)`, [T, 'address', 'uint256', 'bytes'], [txValues(tx), token, a, swap]) };
  if (pull.kind === 'permit') {
    if (BigInt(pull.value) !== a) throw new Error('evm-pool-wallet: the permit is for another amount than the zap takes');
    return { to: zap, value: 0n, data: calldata(`zapTokenWithPermit(${TX_SIG},address,uint256,uint256,uint8,bytes32,bytes32,bytes)`, [T, 'address', 'uint256', 'uint256', 'uint8', 'bytes32', 'bytes32', 'bytes'], [txValues(tx), token, a, BigInt(pull.deadline), pull.v, pull.r, pull.s, swap]) };
  }
  if (pull.kind === 'permit2') return { to: zap, value: 0n, data: calldata(`zapTokenWithPermit2(${TX_SIG},address,uint256,uint256,uint256,bytes,bytes)`, [T, 'address', 'uint256', 'uint256', 'uint256', 'bytes', 'bytes'], [txValues(tx), token, a, BigInt(pull.nonce), BigInt(pull.deadline), pull.sig, swap]) };
  throw new Error(`evm-pool-wallet: unknown way to pay, ${pull.kind}`);
}

// ── wallet ──

// chain: { chainId, pool, router, rpc (a jsonRpc), deployBlock, logChunk?, confirmations?, token? }
// `token`: the pool's ERC-20 asset (TacitEvmPool's ASSET()); left out, the pool holds native ETH. A token pool is moved by the
// user's own wallet: a deposit goes through the router with the `selfCall` it is given (routerDeposit builds the calls),
// and the receive box, the bridges and the move into V1 are ETH's alone.
// keeper: base URL of a keeper (…/evm-pool/keeper) or null; prove(input) → { proof, publicSignals } (snarkjs shape);
// store: { get(k), set(k, v) } for the synced state, or null to keep it in memory. What is stored is view-level only
// (the tree's right edge and the paths of owned notes, and each owned note's position, value, rho and shared
// secret); spend keys are derived in memory.
// signer: { address, send({ to, data, value }) → tx hash, ready?() } for the user's own wallet, or null (ready, when
// given, runs before a self-submitted action, e.g. to connect). A spend goes through
// the keeper when there is one, unless called with { via: 'self' }; deposits and sweeps of the private ETH address
// by the signer are always its own.
// feed: read confirmed history from the keeper's /events first (checked against the pool; see sync), then the rest
// from chain logs.
// partial: a state with nothing read starts at the pool's newest catch-up point (the registry's, for the ETH pool) and sync() returns at
// once with the notes after it, summary().behind naming the point until the history behind it is read: by backfill(), or by the caller's
// own readBack() (in a worker, say) then adopt(). Only a caller that shows such a balance as unfinished sets it. Without it a wallet
// reads from the pool's first block as it always did, and one that finds a state begun at a point (another page's) reads the history
// behind it before sync() returns, so no caller of it sees a balance short of the notes behind a point.
export function makeEvmPoolWallet({ zk, keys, chain, keeper = null, prove, store = null, signer = null, feed = true, fetchImpl = globalThis.fetch?.bind(globalThis), partial = false }) {
  const token = chain.token ?? ZERO, isToken = BigInt(token) !== 0n;
  // `chain.dustFloor`: a note worth less than this is not kept (default 0: every note is). Anyone can pay a public pool address, and every note kept costs this device about
  // 6 KB of saved state and a pass over it with each block (150 of them are 860 KB and over a second a read). A caller that never spends such notes sets it: a note under a
  // millionth of an ETH is worth less than a thousandth of what it costs to spend.
  const dustFloor = chain.dustFloor != null ? BigInt(chain.dustFloor) : 0n;
  const ethOnly = (what) => { if (isToken) throw new Error(`${what} is for the ETH pools, not a token pool`); };
  const asset = poolAsset({ chainId: BigInt(chain.chainId), pool: chain.pool, token });
  const boxes = new Map();      // an index's address is fixed by the key, so each is derived once
  const boxOf = (i) => { if (!boxes.has(i)) boxes.set(i, receiveBoxAddress(receiveKeys(zk, keys.zkWallet, i).npk, RECEIVE_FEE_BPS, chain.router)); return boxes.get(i); };
  const box = boxOf(RECEIVE_INDEX);
  const topicOf = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
  const confirmations = chain.confirmations ?? 12;
  const skey = `tacit-evm-pool-v1:${chain.chainId}:${chain.pool.toLowerCase()}:${keys.address}`;

  // State: { block, tree (an incTree tracking each unspent owned note), notes (unspent), nextRefund }. The tree keeps
  // the pool's right edge and owned paths only, so state stays small however large the pool grows. A state begun at a
  // catch-up point also has `from` ({ size, block, root }, the point): the leaves before it are in the edge, and notes
  // among them are not known until the history behind it is read.
  // `first`: the lowest leaf found to be this key's, read from the first block (null for none yet; absent in a state saved before it was kept).
  // `pointed`: the point a state that took the history behind it in had begun at.
  const blank = () => ({ block: Number(chain.deployBlock ?? 0) - 1, tree: zk.incTree(), notes: [], nextRefund: 1, attempts: {}, first: null });
  const loadState = (raw) => {
    const j = openState(keys.v, raw);
    if (!j) return null;
    const o = JSON.parse(j);
    let tree;
    if (o.tree) tree = zk.incTree(o.tree);
    else { // state saved with every leaf: rebuild the tree once, tracking the owned notes
      tree = zk.incTree();
      tree.append((o.leaves || []).map(BigInt), (o.notes || []).map((n) => n.index));
    }
    const st = { nextRefund: 1, attempts: {}, ...o, tree };
    delete st.leaves;         // `spent` (a state saved with every nullifier) stays for the migration below, which drops it
    return st;
  };
  let saved = blank();
  try { saved = loadState(store?.get(skey)) || blank(); } catch { saved = blank(); }
  let view = null; // saved state plus the unconfirmed tail, from the last sync
  let tail = { after: null, ts: [], rs: [] }; // that tail's events, and the block the saved state had read through when they were read

  // Receive boxes watched: box 0 (the public receive address) and the refund boxes of call intents, indices 1 up
  // to REFUND_GAP past the next unused one, so a wallet restored from its seed alone still finds every refund.
  const boxIndex = new Map();
  const boxTopics = () => { for (let i = boxIndex.size; i < saved.nextRefund + REFUND_GAP; i++) boxIndex.set(topicOf(boxOf(i)), i); };
  // This wallet's receipts among `all`, the Received events of one read (a feed page, or a chain-log read). A box found
  // used moves the next unused one past it, and with it the boxes watched, so they are matched again until that stops:
  // a run of paid boxes longer than the gap is found in one read.
  function ours(all) {
    for (;;) {
      boxTopics();
      const mine = all.filter((r) => boxIndex.has(r.box));
      const next = mine.reduce((a, r) => Math.max(a, boxIndex.get(r.box) + 1), saved.nextRefund);
      if (next === saved.nextRefund) return mine;
      saved.nextRefund = next;
    }
  }

  // Spend and nullifier keys of a stored note, from the wallet keys: never stored.
  function withKeys(n) {
    if (n.nk) return n;
    const k = n.kind === 'receive' ? receiveKeys(zk, keys.zkWallet, n.box ?? RECEIVE_INDEX) : zk.ownedKeys(keys.zkWallet, unhex(n.s));
    return { ...n, sk: k.sk.toString(), nk: k.nk.toString(), nf: zk.nullifier(k.nk, BigInt(n.leaf), n.index).toString() };
  }
  saved = { ...saved, notes: saved.notes.map(withKeys) };
  { // state saved with every nullifier: keep only the notes still unspent
    const old = saved.spent;
    delete saved.spent;
    if (old) {
      const s = new Set(old);
      for (const n of saved.notes) if (s.has(n.nf)) saved.tree.untrack(n.index);
      saved.notes = saved.notes.filter((n) => !s.has(n.nf));
    }
  }
  // The stored state is sealed under a key from the wallet's view scalar, so another script on this origin reading
  // storage finds balances and note positions only as ciphertext. A state saved before this loads as plain JSON.
  // A write the store does not keep (it is out of room: the set throws, or swallows that and the old text stays) leaves
  // the state in memory for this visit, and summary() says so (`stored` false), so a page can tell that the next visit
  // reads the history again. A state begun at a catch-up point is not written over the whole history another wallet on
  // this store has taken in: the next read goes on from that instead.
  let stored = true;
  const persist = () => {
    if (!store) return;
    if (saved.from) { try { const s = loadState(store.get(skey)); if (s && !s.from && s.block >= saved.from.block) return; } catch {} }
    const bare = { ...saved, tree: saved.tree.toJSON(), notes: saved.notes.map(({ sk, nk, nf, ...rest }) => rest) };
    const text = sealState(keys.v, JSON.stringify(bare));
    try { store.set(skey, text); stored = store.get(skey) === text; } catch { stored = false; }
  };
  const noteKey = (n) => `${n.index}`;
  // The attempt number of the next spend built from the note with nullifier `nf` (see paymentKey), remembered with the
  // state so a reload does not start over; the table keeps the latest 64 notes.
  function nextAttempt(nf) {
    const k = String(nf), a = saved.attempts[k] ?? 0;
    delete saved.attempts[k];
    saved.attempts[k] = (a + 1) % PAYMENT_ATTEMPTS;
    for (const old of Object.keys(saved.attempts).slice(0, -64)) delete saved.attempts[old];
    persist();
    return a;
  }

  // Notes seen spent, kept three days with the time they were seen and without their keys (withKeys derives those again), at
  // most a few dozen, newest first (by the block that spent them), one to a position. A state rebuilt from the chain keeps
  // its list, the block it had read through (spentSeen) and the notes it held (held): a spend at or before that block of a
  // note it did not hold was seen then or is long past, so it is not taken as one seen now.
  const SPENT_KEEP_MS = 3 * 864e5, SPENT_KEEP_MAX = 24;
  const freshSpent = (list) => (Array.isArray(list) ? list : []).filter((n) => n && Number.isFinite(n.spentAt) && Date.now() - n.spentAt < SPENT_KEEP_MS);
  function keepSpent(state, gone) {
    const now = Date.now(), seen = new Set(), out = [], held = new Set(state.held);
    const fresh = gone.filter((n) => state.spentSeen == null || n.spentBlock > state.spentSeen || held.has(n.index)).sort((a, b) => b.spentBlock - a.spentBlock || b.index - a.index);
    for (const n of [...fresh.map(({ sk, nk, nf, ...bare }) => ({ ...bare, spentAt: now })), ...freshSpent(state.recentSpent)]) if (!seen.has(n.index)) { seen.add(n.index); out.push(n); }
    return out.slice(0, SPENT_KEEP_MAX);
  }
  // A blank state to rebuild from the chain, keeping what its logs do not say: the attempt numbers, the next unused box, and
  // what keepSpent reads (a rebuild that has not yet read as far as the state before it keeps that state's).
  const rebuilt = () => {
    const behind = saved.block < saved.spentSeen;
    return {
      ...blank(), attempts: saved.attempts, nextRefund: saved.nextRefund, recentSpent: saved.recentSpent,
      spentSeen: behind ? saved.spentSeen : saved.block, held: [...(behind ? saved.held ?? [] : []), ...saved.notes.map((n) => n.index)],
    };
  };

  // Appends `transacts` to a copy of `state`, keeping a path for each leaf found to be ours: a memo that opens, or
  // the leaf a Received event of one of our boxes names (the same transaction, so the same batch). The state's tree is
  // copied unless a working copy is given (absorbPaced hands every slice the one it made).
  function absorb(state, transacts, receipts, tree = state.tree.clone()) {
    const spent = new Map(); // nullifier → the block of the Transact that spent it
    const notes = new Map(state.notes.map((n) => [noteKey(n), n]));
    const received = new Map(receipts.map((r) => [r.index, r]));
    const leafAt = new Map();
    const want = [];
    // Behind a catch-up point whose block came before the tree reached its count, the first read after it starts with leaves the edge holds already.
    const edge = state.from ? state.from.size : 0, inserts = (t) => !(t.outLeaf[0] === 0n && t.outLeaf[1] === 0n) && t.firstIndex >= edge;
    transacts.forEach((t, i) => {
      if (!inserts(t)) return;
      for (let k = 0; k < 2; k++) if (t.outLeaf[k] !== 0n && !received.has(t.firstIndex + k) && t.memo[k].length) want.push([i, k]);
    });
    const found = openNotes(zk, keys, want.map(([i, k]) => ({ memo: transacts[i].memo[k], leaf: transacts[i].outLeaf[k], asset })));
    const opens = new Map(want.map(([i, k], j) => [`${i}:${k}`, found[j]]));
    // The batch's leaves go into the tree in one append: each call hashes the path to the root, so one call per
    // transaction costs 32 hashes for every pair, and one for the batch costs about one per leaf.
    const batch = [], track = [];
    for (const [i, t] of transacts.entries()) {
      for (const nf of t.nf) if (nf !== 0n) spent.set(nf.toString(), t.block);
      if (!inserts(t)) continue;
      if (t.firstIndex !== tree.size + batch.length) throw new Error(`evm-pool-wallet: leaf ${t.firstIndex} out of order (have ${tree.size + batch.length})`);
      for (let k = 0; k < 2; k++) {
        const index = t.firstIndex + k;
        leafAt.set(index, t.outLeaf[k]);
        if (t.outLeaf[k] === 0n) continue;
        if (received.has(index)) { track.push(index); continue; }
        if (!t.memo[k].length) continue;
        const o = opens.get(`${i}:${k}`);
        if (o && o.v > 0n && o.v >= dustFloor) {
          track.push(index);
          notes.set(`${index}`, withKeys({ index, leaf: t.outLeaf[k].toString(), v: o.v.toString(), rho: o.rho.toString(), s: hex(o.s), block: t.block, tx: t.tx, kind: 'memo' }));
        }
      }
      batch.push(t.outLeaf[0], t.outLeaf[1]);
    }
    tree.append(batch, track);
    for (const r of receipts) {
      const i = boxIndex.get(r.box) ?? RECEIVE_INDEX;
      const n = receivedNote(zk, keys.zkWallet, i, r);
      const leaf = leafAt.get(r.index) ?? -1n;
      if (leaf < 0n || n.v === 0n || n.v < dustFloor || zk.leafOf(asset, n.v, receiveKeys(zk, keys.zkWallet, i).npk, n.rho) !== leaf) { tree.untrack(r.index); continue; }
      notes.set(`${r.index}`, withKeys({ index: r.index, leaf: leaf.toString(), v: n.v.toString(), rho: n.rho.toString(), block: r.block, tx: r.tx, kind: 'receive', box: i }));
    }
    // A spent note is dropped with its path; nullifiers that are not ours are not kept. It is remembered for a few days apart from
    // the notes (no balance, spend or merge reads that list): a day's holding reward is for the notes held at a snapshot, and
    // claims open after the day, so a note spent since still has a claim to make.
    const gone = [];
    const low = track.length ? Math.min(...track) : null, first = state.first === undefined ? undefined : low == null ? state.first : Math.min(state.first ?? low, low);
    for (const [k, n] of notes) if (spent.has(n.nf)) { tree.untrack(n.index); notes.delete(k); gone.push({ ...n, spentBlock: spent.get(n.nf) }); }
    return { ...state, tree, notes: [...notes.values()].sort((a, b) => a.index - b.index), recentSpent: keepSpent(state, gone), first };
  }

  // absorb, a slice of transactions at a time with a pause between, so a long read (a first one, or the history behind a point) does not hold the
  // page for seconds: a receipt goes with the transaction whose leaves it names.
  const SLICE = 64;
  async function absorbPaced(state, transacts, receipts) {
    if (transacts.length <= SLICE) return absorb(state, transacts, receipts);
    const sliceOf = new Map();
    transacts.forEach((t, i) => { if (t.outLeaf[0] !== 0n || t.outLeaf[1] !== 0n) for (let k = 0; k < 2; k++) sliceOf.set(t.firstIndex + k, Math.floor(i / SLICE)); });
    let st = state, t0 = Date.now();
    const tree = state.tree.clone();
    for (let i = 0; i < transacts.length; i += SLICE) {
      st = absorb(st, transacts.slice(i, i + SLICE), receipts.filter((r) => (sliceOf.get(r.index) ?? 0) === i / SLICE), tree);
      if (Date.now() - t0 > 40) { await sleep(0); t0 = Date.now(); }
    }
    return st;
  }

  async function logs(address, topics, from, to) {
    const out = [];
    let step = Number(chain.logChunk ?? 5000), busy = 0;
    for (let a = from; a <= to;) {
      const b = Math.min(to, a + step - 1);
      try {
        for (const l of await chain.rpc('eth_getLogs', [{ address, topics, fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }])) out.push(l);
        a = b + 1; busy = 0;
      } catch (e) {
        const f = logFailure(e, step);
        if (f?.step) { step = f.step; continue; }
        if (f?.busy && ++busy <= 6) { await sleep(1500 * busy); continue; }
        throw e;
      }
    }
    return out;
  }

  const view32 = async (sig, types, values) => chain.rpc('eth_call', [{ to: chain.pool, data: calldata(sig, types, values) }, 'latest']);

  // Confirmed history from the keeper's feed, up to `safe`. A page is kept only if the tree it builds is one the pool
  // has held at that size, so the feed cannot forge leaves. No nullifier is sent to a node to ask whether it is
  // spent: a spend the feed left out shows when the chain-log scan reaches it, or as a refused spend, which rescans.
  // A feed that withholds a memo or a Received event can hide a note until rescan() reads the chain's logs alone
  // (a spend refused for this wallet's state does that itself); it cannot move funds. Each page is kept as soon as it
  // checks, so a failure, or a page closed partway through a long history, loses only the page being read: the next
  // read, by the feed or the chain-log scan, continues from the last one kept. The first request starts where feedStart
  // says (the cell this wallet's place falls in when it has been away, its place when it is current) and each later one
  // where the page before it ended, so pages that end before the wallet's place are passed over, and only events from its
  // place on are kept.
  let feedBusyUntil = 0;
  async function syncFromFeed(safe) {
    // A wallet within a few thousand blocks of the head reads the chain's logs in a call or two: a busy feed (429) is not waited for, and not asked again for half a minute.
    const near = safe - saved.block <= 20_000;
    if (near && Date.now() < feedBusyUntil) return;
    let ask = feedStart(chain.chainId, chain.deployBlock, saved.block + 1, safe);
    for (let pages = 0; pages < 10_000; pages++) {
      const cand = saved, from = cand.block + 1;
      if (from > safe) break;
      let r;
      try { r = await keeperGet(`/events?from=${ask}`, near ? 0 : 4); } catch (e) { if (near) feedBusyUntil = Date.now() + 30_000; throw e; }
      if (Number(r.chainId) !== Number(chain.chainId) || String(r.pool).toLowerCase() !== chain.pool.toLowerCase()) throw new Error('feed is for another pool');
      const through = Math.min(Number(r.through), safe);
      if (!Number.isInteger(through)) throw new Error('the feed named no block');
      if (through < ask) break;
      ask = through + 1;
      if (through < from) continue;
      const evs = r.events.filter((e) => e.block >= from && e.block <= through);
      const ts = evs.filter((e) => e.kind === 'transact').map((e) => ({
        nf: [BigInt(e.nf0), BigInt(e.nf1)], outLeaf: [BigInt(e.outLeaf0), BigInt(e.outLeaf1)], firstIndex: Number(e.firstIndex),
        memo: [unhex(e.memo0), unhex(e.memo1)], block: e.block, tx: e.tx,
      })).sort((a, b) => a.block - b.block || a.firstIndex - b.firstIndex);
      const rs = ours(evs.filter((e) => e.kind === 'received').map((e) => ({ ...e, box: topicOf(e.box) }))).map((e) => ({
        box: e.box, n: BigInt(e.n), index: Number(e.index), value: BigInt(e.value), rho: BigInt(e.rho), fee: BigInt(e.fee), block: e.block, tx: e.tx,
      }));
      const next = { ...(await absorbPaced(cand, ts, rs)), block: through };
      if (next.tree.size !== cand.tree.size) {
        const size = BigInt(await view32('rootSize(bytes32)', ['bytes32'], [next.tree.root]));
        if (size !== BigInt(next.tree.size)) throw new Error('feed leaves do not match the pool');
      }
      // `nextRefund` from the live state: a refund box taken while the page was read raised it past the snapshot's.
      saved = { ...next, nextRefund: Math.max(next.nextRefund, saved.nextRefund) };
      persist();
    }
  }

  // Reads new events: those `confirmations` deep are kept, the rest are re-read next time. With a keeper, confirmed
  // history comes from its feed first when it can. One read at a time: each absorbs into the state the last one left,
  // so a caller arriving while one runs waits for it, then reads what came after.
  // `maxAge` (ms): a read that finished that recently stands for this one (a screen that asks every half minute for each of its swaps reads the pool once).
  let reading = Promise.resolve(), healedAt = 0, readAt = 0;
  function syncRead(maxAge = 0) {
    if (maxAge > 0 && Date.now() - readAt < maxAge) return reading.catch(() => {}).then(summary);
    const run = reading.catch(() => {}).then(readHealed).then((r) => { readAt = Date.now(); return r; });
    reading = run;
    return run;
  }
  const sync = (maxAge = 0) => syncRead(maxAge).then(async (r) => {
    if (partial || !saved.from) return r;
    await startBackfill();
    if (saved.from) await syncRead();            // another wallet on the page took the history in place of the point
    if (saved.from) throw new Error('the older history could not be read just now; try again');
    return summary();
  });
  // A node that answered short of the range it was asked (one behind the others) can leave the kept tree missing
  // leaves, so every later read stops at a leaf out of order. The chain's logs alone are then read again from the
  // start, at most once in ten minutes. A state begun at a catch-up point is read again at once, and if the first leaf
  // after the point is still out of order in the chain's own logs, the point named the wrong block: it is passed over.
  async function readHealed() {
    try { return await readNew(); } catch (e) {
      // A gap in the unconfirmed tail alone is a node a block behind, not a tree missing leaves: the next read sees it whole.
      const at = saved.from;
      if (e?.tail || !/ out of order /.test(e?.message || '') || (!at && Date.now() - healedAt < 600_000)) throw e;
      healedAt = Date.now();
      saved = rebuilt(); view = null; readAt = 0; persist();
      const f = feed; feed = false;
      try { return await readNew(); }
      catch (e2) {
        if (!at || e2?.tail || !/ out of order /.test(e2?.message || '')) throw e2;
        badPoints.add(at.size);
        saved = rebuilt(); view = null; persist();
        return await readNew();
      } finally { feed = f; }
    }
  }

  // ── catch-up points ──
  // A point is the tree's right edge at a leaf count, kept by the registry only if the pool held the root it folds to there. It is checked
  // again here before it is used (the pool's own word on the root, and its leaf count at the point's block where a node serves that old a
  // state), and one whose block turns out wrong is passed over for the one before it. → { size, block, root, filled }, or null.
  const points = !partial ? null : chain.points !== undefined ? chain.points : !isToken && chain.pool.toLowerCase() === ETH_POOL ? CHECKPOINTS : null;
  const badPoints = new Set();
  const fold = (size, filled) => { let cur = 0n; for (let l = 0; l < 32; l++) cur = Math.floor(size / 2 ** l) % 2 ? zk.H([filled[l], cur]) : zk.H([cur, zk.zeros[l]]); return cur; };
  async function readPoint(safe) {
    if (!points) return null;
    try {
      const at = (data, tag = 'latest') => chain.rpc('eth_call', [{ to: points, data }, tag]);
      const top = await at(calldata('latest()', [], []));
      let size = typeof top === 'string' && top.length > 2 ? Number(BigInt(top)) : 0;
      for (let i = 0; size && i < 6; i++) {
        const r = await at(calldata('pointAt(uint256)', ['uint256'], [BigInt(size)]));
        if (typeof r !== 'string' || r.length < 2 + 64 * 34) return null;
        const w = (k) => BigInt('0x' + r.slice(2 + 64 * k, 66 + 64 * k)), block = Number(w(0)), prev = Number(w(1));
        if (!badPoints.has(size) && size % 2 === 0 && block >= Number(chain.deployBlock ?? 0) && block <= safe) {
          const filled = Array.from({ length: 32 }, (_, k) => w(2 + k)), root = fold(size, filled);
          const [held, had] = await Promise.all([
            view32('rootSize(bytes32)', ['bytes32'], [root]).then((x) => BigInt(x) === BigInt(size), () => false),
            chain.rpc('eth_call', [{ to: chain.pool, data: calldata('nextIndex()', [], []) }, '0x' + block.toString(16)]).then((x) => BigInt(x), () => null),
          ]);
          if (held && (had == null || had <= BigInt(size))) return { size, block, root, filled };
        }
        size = prev;
      }
    } catch {}
    return null;
  }
  // The history behind a point is read by a second wallet into a state of its own, kept under its own name so a later visit goes on where
  // this one stopped; once it has read as far as this state, and their trees are the same, it takes this state's place.
  const bkey = `${skey}:back`, mem = new Map();
  const backStore = { get: (k) => (k === skey ? (store ? store.get(bkey) : mem.get(bkey)) : store?.get(k)), set: (k, v) => (k === skey ? (store ? store.set(bkey, v) : mem.set(bkey, v)) : store?.set(k, v)) };
  const dropBack = () => { if (store) store.set(bkey, ''); else mem.delete(bkey); };
  // Reads the history behind the point as far as the head; → the second state's summary.
  async function readBack() {
    if (!saved.from) return summary();
    const back = makeEvmPoolWallet({ zk, keys, chain, keeper, prove: null, store: backStore, feed, fetchImpl });
    if (saved.nextRefund > 1) back.watchThrough(saved.nextRefund - 1);
    return back.sync();
  }
  // Takes the second state in place of this one when it has read as far (this one reads to the same block first, if behind it). → true once
  // this state holds the whole history.
  function adopt() {
    if (!saved.from) return Promise.resolve(true);
    const run = reading.catch(() => {}).then(async () => {
      if (!saved.from) return true;
      let b = null;
      try { b = loadState(backStore.get(skey)); } catch {}
      if (!b || b.from || b.block < saved.from.block) return false;
      if (b.block > saved.block) await readNew(b.block);
      if (!saved.from) return true;
      if (b.block !== saved.block) return false;
      if (b.tree.size !== saved.tree.size || b.tree.root !== saved.tree.root) { dropBack(); return false; }
      saved = { ...b, notes: b.notes.map(withKeys), attempts: { ...b.attempts, ...saved.attempts }, nextRefund: Math.max(b.nextRefund, saved.nextRefund), pointed: saved.from };
      // The unconfirmed tail of the last read goes onto the whole history as it was on the point's state, so a note younger
      // than `confirmations` stays in view, and can be chosen for a spend, across the join.
      try { view = tail.after === saved.block ? absorb(saved, tail.ts, tail.rs) : null; } catch { view = null; }
      readAt = 0; persist(); dropBack();
      return true;
    });
    reading = run;
    return run;
  }
  function startBackfill() {
    if (!BACKFILLS.has(skey)) {
      const p = (async () => { for (let i = 0; i < 4; i++) { await readBack(); if (await adopt()) return true; } return false; })().catch(() => false).finally(() => BACKFILLS.delete(skey));
      BACKFILLS.set(skey, p);
    }
    return BACKFILLS.get(skey);
  }

  async function readNew(until = Infinity) {
    // Another wallet on this page, or another tab, has taken the whole history in place of a point: go on from that.
    if (saved.from) { try { const s = loadState(store?.get(skey)); if (s && !s.from && s.block >= saved.from.block) { saved = { ...s, notes: s.notes.map(withKeys), attempts: { ...s.attempts, ...saved.attempts }, nextRefund: Math.max(s.nextRefund, saved.nextRefund) }; view = null; } } catch {} }
    const tip = Number(BigInt(await chain.rpc('eth_blockNumber'))), tipNode = chain.rpc.node;
    const safe = Math.min(tip - confirmations, until);
    // Nothing read yet: the newest point the pool vouches for, the history behind it read later.
    if (saved.block < Number(chain.deployBlock ?? 0) && !saved.tree.size && until === Infinity) {
      const pt = await readPoint(safe);
      if (pt) { saved = { ...saved, block: pt.block, tree: zk.incTree({ size: pt.size, root: pt.root.toString(), filled: pt.filled.map(String), tracked: {} }), notes: [], from: { size: pt.size, block: pt.block, root: pt.root.toString() } }; view = null; persist(); }
    }
    if (keeper && feed && saved.block < safe) await syncFromFeed(safe).catch(() => {});
    const from = saved.block + 1;
    if (from > tip) return summary();
    // The pool's Transact and the router's Received events come in one query per range, so a node that answers short
    // of it leaves out both events of a sweep or neither. Every Received event of the router is read and ours picked
    // out here, so the node is not told which boxes are one wallet's.
    const got = await logs([chain.pool, chain.router], [[TRANSACT_TOPIC, RECEIVED_TOPIC]], from, tip);
    // Logs from another node than the one that named the tip (that one failed them) can stop short of it, at the other's
    // own head: what is kept as read ends at the lower of the two heads, so no leaf between them is passed over.
    const head = chain.rpc.node !== tipNode ? Number(BigInt(await chain.rpc('eth_blockNumber'))) : tip;
    const kept = Math.min(safe, head - confirmations);
    const of = (l, address, t) => String(l.address).toLowerCase() === address.toLowerCase() && String(l.topics?.[0]).toLowerCase() === t;
    const ts = got.filter((l) => of(l, chain.pool, TRANSACT_TOPIC)).map(decodeTransact).sort((a, b) => a.block - b.block || a.firstIndex - b.firstIndex);
    const rs = ours(got.filter((l) => of(l, chain.router, RECEIVED_TOPIC)).map(decodeReceived));
    if (kept >= from) {
      const next = { ...(await absorbPaced(saved, ts.filter((t) => t.block <= kept), rs.filter((r) => r.block <= kept))), block: kept };
      if (next.tree.size !== saved.tree.size) {
        const size = BigInt(await view32('rootSize(bytes32)', ['bytes32'], [next.tree.root]));
        if (size !== BigInt(next.tree.size)) throw new Error('the node\'s logs do not match the pool');
      }
      // `nextRefund` from the live state: a refund box taken during the read raised it past the snapshot's.
      saved = { ...next, nextRefund: Math.max(next.nextRefund, saved.nextRefund) };
      persist();
    }
    tail = { after: saved.block, ts: ts.filter((t) => t.block > kept), rs: rs.filter((r) => r.block > kept) };
    try { view = absorb(saved, tail.ts, tail.rs); }
    catch (e) { if (e instanceof Error) e.tail = true; throw e; }
    return summary();
  }

  const state = () => view || saved;
  const unspent = () => state().notes.filter((n) => !pending.has(n.nf));
  const pending = new Set();
  // Notes a spend under way has chosen. A claim lasts until that spend's transaction ends (or ten minutes, so a failure between two steps cannot hold notes for good): a second
  // spend from this wallet takes other notes, or says that the funds are in use, and does not build a proof on the same ones. The balance still counts them.
  const claimed = new Map();
  const claim = (ins) => { const t = Date.now(); for (const n of ins) claimed.set(n.nf, t); };
  const taken = (n) => (claimed.get(n.nf) ?? 0) > Date.now() - 600_000;
  const free = () => unspent().filter((n) => !taken(n));
  function summary() {
    const u = unspent();
    return { balance: u.reduce((a, n) => a + BigInt(n.v), 0n), notes: u.length, leaves: state().tree.size, block: saved.block, behind: saved.from ? { size: saved.from.size, block: saved.from.block } : null, stored };
  }

  // ── spending ──

  // A busy keeper answers 429 with Retry-After (10 s from this keeper), which a page on another origin cannot read: wait
  // what it says, 10 s when unread, at most 30 s, and ask again up to four times. A keeper that never answers gives up
  // in time (a relay may wait on the chain; everything else answers fast), so no read or action waits on it forever.
  async function keeperFetch(path, init = {}, tries = 4) {
    if (!keeper) throw new Error('no relayer is configured for this chain');
    for (let i = 0; ; i++) {
      const r = await fetchImpl(`${keeper}${path}`, { ...init, signal: init.signal || AbortSignal.timeout?.(path === '/relay' ? 180_000 : 30_000) });
      if (r.status !== 429 || i >= tries) return r;
      const after = Number(r.headers?.get?.('retry-after'));
      await sleep(Math.min(after > 0 ? after : 10, 30) * 1000 * (0.5 + Math.random()));
    }
  }
  const realOrigin = !!globalThis.location?.hostname && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(globalThis.location.hostname);
  const wantRelayer = (chain.relayer ?? (realOrigin ? RELAYERS[chain.chainId] : undefined))?.toLowerCase();
  const maxRelayFee = chain.maxRelayFee != null ? BigInt(chain.maxRelayFee) : MAX_RELAY_FEE[chain.chainId];
  function vetQuote(q) {
    if (Number(q.chainId) !== Number(chain.chainId) || String(q.pool).toLowerCase() !== chain.pool.toLowerCase()) {
      throw new Error('the relayer quoted another chain or pool, so nothing was signed');
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(q.relayer ?? '') || (wantRelayer && q.relayer.toLowerCase() !== wantRelayer)) {
      throw new Error('the relayer quoted an address this wallet does not expect, so nothing was signed');
    }
    if (!/^\d+$/.test(String(q.fee)) || (maxRelayFee != null && BigInt(q.fee) > maxRelayFee)) {
      throw new Error('the relayer quoted a fee above this wallet\'s limit, so nothing was signed');
    }
    return q;
  }
  async function keeperGet(path, tries = 4) {
    const r = await keeperFetch(path, {}, tries);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `relayer returned ${r.status}`);
    return path.startsWith('/quote') ? vetQuote(j) : j;
  }
  async function keeperPost(path, body) {
    const r = await keeperFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, body: j };
  }

  // Up to two unspent notes covering `need`, smallest sufficient first; null if no two do.
  function select(need) {
    const u = free().sort((a, b) => (BigInt(a.v) < BigInt(b.v) ? -1 : 1));
    const one = u.find((n) => BigInt(n.v) >= need);
    if (one) return [one];
    for (let i = u.length - 1; i > 0; i--) for (let j = i - 1; j >= 0; j--) if (BigInt(u[i].v) + BigInt(u[j].v) >= need) return [u[i], u[j]];
    return null;
  }
  const asInput = (n) => ({ v: BigInt(n.v), rho: BigInt(n.rho), nk: BigInt(n.nk), sk: BigInt(n.sk), index: n.index });
  const toTx = (proof, publicSignals, rest) => ({
    pA: [proof.pi_a[0], proof.pi_a[1]].map(String),
    pB: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]].map((r) => r.map(String)),
    pC: [proof.pi_c[0], proof.pi_c[1]].map(String),
    publicInputs: publicSignals.map(String),
    ...rest,
  });
  // The proof of a transaction that spends `inputs` and creates `sealed`, built on `tree`, as pool.transact takes it.
  async function proveTx({ tree, inputs, sealed, extAmount, recipient, relayer, fee, onStep = () => {} }) {
    const memo0 = sealed[0]?.memo ?? new Uint8Array(), memo1 = sealed[1]?.memo ?? new Uint8Array();
    const eh = extDataHash({ chainId: BigInt(chain.chainId), pool: chain.pool, recipient, extAmount, relayer, fee, memo0, memo1 });
    const w = zk.buildWitness({ asset, tree, inputs, outputs: sealed.map((o) => (o ? { v: o.v, npk: o.npk, rho: o.rho } : null)), extAmount, fee, extDataHash: eh });
    onStep('proving on this device');
    const { proof, publicSignals } = await prove(w.input);
    return toTx(proof, publicSignals, { recipient, extAmount: extAmount.toString(), relayer, fee: fee.toString(), memo0: hex(memo0), memo1: hex(memo1) });
  }
  // The deposit proved ahead (prepareDeposit): its amount, when it is done, and the proof with the head it was built on. The deposit of that amount takes it, once.
  let aheadDeposit = null;
  const takeAheadDeposit = (a) => { const t = aheadDeposit?.amount === a ? aheadDeposit : null; if (t) aheadDeposit = null; return t; };

  // Submits from the signer after checking the call on chain. → tx hash, or null when another transaction landed
  // first (prove again).
  // `before`: calls (an approval) the wallet sends ahead of this one, all in one atomic batch (signer.batch).
  async function sendSelf(to, data, value, onStep, before = []) {
    if (!signer) throw new Error('no wallet to send from: connect one, or use a relayer');
    if (signer.ready) await signer.ready();
    const v = '0x' + BigInt(value).toString(16);
    if (before.length) {
      if (!signer.batch) throw new Error('this wallet does not send calls together');
      // Where the node runs eth_simulateV1 the batch is checked in order, the approval first; the wallet checks it again before it signs.
      const calls = [...before, { to, data, value }].map((x) => ({ to: x.to, data: x.data, value: BigInt(x.value ?? 0n) }));
      const sim = await (signer.rpc || chain.rpc)('eth_simulateV1', [{ blockStateCalls: [{ calls: calls.map((x) => ({ from: signer.address, to: x.to, data: x.data, value: '0x' + x.value.toString(16) })) }], validation: false }, 'latest']).then((r) => r?.[0]?.calls, () => null);
      const bad = Array.isArray(sim) && sim.find((x) => x.status !== '0x1');
      if (bad) {
        const d = String(bad.error?.data || bad.returnData || '');
        if (RACED.has(d.slice(0, 10))) return null;
        throw new Error(`the transaction would revert: ${String(bad.error?.message || 'it failed').slice(0, 120)}${d ? ` (${d.slice(0, 10)})` : ''}`);
      }
      onStep('confirm in your wallet');
      return signer.batch(calls, () => onStep('waiting for the block'));
    }
    // A signer that sends through a relay (signer.relayed) checks the whole order itself, as the relay will run it, and answers null when the pool moved (prove again).
    if (signer.relayed) { onStep('confirm in your wallet'); return signer.send({ to, data, value: BigInt(value) }); }
    // A signer may bring its own reader (`signer.rpc`), so the node that reads this key's notes and boxes is not also
    // shown the signer's address and its transactions.
    try { await (signer.rpc || chain.rpc)('eth_call', [{ from: signer.address, to, data, value: v }, 'latest']); }
    catch (e) {
      const d = revertData(e);
      if (RACED.has(d.slice(0, 10))) return null;
      // notes this wallet holds that the pool has spent: said so, and the state read again from the chain (the relay path does the same)
      if (d.slice(0, 10) === ALREADY_SPENT) throw Object.assign(new Error('Those funds were already spent. Check Activity.'), { said: true, spent: true });
      // no revert in the answer: the check itself failed (every node), which is not the pool refusing the call
      if (!d && !e?.rpc) throw Object.assign(new Error('Could not check the transaction just now, so nothing was sent. Try again in a moment.'), { said: true });
      throw new Error(`the transaction would revert: ${e.message || e}${d ? ` (${d.slice(0, 10)})` : ''}`);
    }
    onStep('confirm in your wallet');
    return signer.send({ to, data, value: BigInt(value) });
  }

  const sleep =(ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (round) => sleep(Math.min(8000, 500 * 2 ** round) * (0.5 + Math.random()));

  // The tree a relayed insertion is proven against: this wallet's, plus the insertions the keeper has queued after
  // the pool's head (GET /head), checked to reach the keeper's announced tail. With `empty`, waits for an empty
  // queue (a call or wrap is simulated, so it cannot follow unmined ones). null: prove against the wallet's own.
  async function queueTail(empty) {
    for (let i = 0; i < 30; i++) {
      let h;
      try { h = await keeperGet('/head'); } catch { return null; }
      if (empty && h.pending.length) { await sleep(3000); continue; }
      let t = state().tree;
      if (BigInt(h.root) !== t.root) {
        await sync();
        t = state().tree;
        if (BigInt(h.root) !== t.root) { if (BigInt(h.size) >= BigInt(t.size)) { await sleep(1500); continue; } return null; }
      }
      const c = t.clone();
      c.append(h.pending.flatMap((x) => [BigInt(x.outLeaf0), BigInt(x.outLeaf1)]));
      return c.root === BigInt(h.tail.root) ? c : null;
    }
    return null;
  }

  // A slot in the keeper's queue for a transaction inserting `sealed`'s leaves and spending `ins`, and the tree to
  // prove it against: this wallet's, plus the leaves queued ahead of the slot. Many wallets prove at once, each in
  // its own slot. → { id, tree }, 'queued' (a spend of these notes is in the queue already), 'spent' (the pool has
  // them spent), 'stale' (refused for the queue's state: try again), 'tail' (the keeper has paused this connection's
  // reservations: prove against the queue's tail and send without one), or null (prove without a slot). On the private route
  // (dapp/sealed-request.js) a caller has no address of its own to hold a slot under, so it sends without one, as a paused one does.
  async function reserveSlot(sealed, ins) {
    if (fetchImpl?.sealed) return 'tail';
    const leaf = (k) => String(sealed[k] ? sealed[k].leaf : 0n);
    let r;
    try {
      const res = await keeperPost('/reserve', { outLeaf0: leaf(0), outLeaf1: leaf(1), nfs: ins.map((n) => n.nf) });
      const why = String(res.body?.error || '');
      if (res.status === 409) return /already queued/.test(why) ? 'queued' : 'stale';
      if (res.status === 400 && /already spent/.test(why)) return 'spent';
      if (res.status === 403) return 'tail';
      if (res.status !== 200) return null;
      r = res.body;
    } catch { return null; }
    for (let i = 0; i < 3; i++) {
      let t = state().tree;
      if (BigInt(r.root) !== t.root) { await sync().catch(async (e) => { await releaseSlot(r.id); throw e; }); t = state().tree; }
      if (BigInt(r.root) === t.root) {
        const c = t.clone();
        c.append(r.pending.flatMap((x) => [BigInt(x.outLeaf0), BigInt(x.outLeaf1)]));
        if (c.root === BigInt(r.oldRoot) && c.size === Number(r.start)) return { id: r.id, tree: c };
        break;
      }
      await sleep(1000);
    }
    await releaseSlot(r.id);
    return null;
  }
  const releaseSlot = (id) => keeperPost('/cancel', { reservation: id }).catch(() => {});

  // true once mined, false if it reverted, true on no answer in time (it may still land; sync will tell). A spend counts
  // only when the receipt carries the pool's Transact for its nullifiers, so a hash for some other transaction is not
  // taken as this payment.
  async function landed(hash, nfs = [], read = chain.rpc) {
    for (let i = 0; i < 120; i++) {
      const r = await read('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (!r) { await sleep(i < 60 ? 1000 : 2000); continue; }       // each second for the first minute, then every two: three minutes in all
      if (!(r.status === '0x1' || r.status === 1 || r.status === 'success')) return false;
      return !nfs.length || (r.logs || []).some((l) => String(l.address).toLowerCase() === String(chain.pool).toLowerCase()
        && String(l.topics?.[0]).toLowerCase() === TRANSACT_TOPIC && nfs.every((nf) => [l.topics[1], l.topics[2]].some((t) => t != null && BigInt(t) === BigInt(nf))));
    }
    return true;
  }

  // Notes already spent (from this key elsewhere, or by an earlier try of this spend), said in words.
  const spentAlready = () => Object.assign(new Error('Those funds were already spent. Check Activity.'), { said: true });
  const holds = (ins) => ins.every((n) => state().notes.some((m) => m.nf === n.nf));
  // Waits up to `ms` for this wallet to read `ins` spent. → whether it did.
  const seenSpent = (ins, ms) => waitFor(() => !holds(ins), ms).then(() => true, () => false);
  // The pool has `ins` spent, as the relay found: once this wallet reads that spend too, it says so. One that still holds
  // them after a minute read a history without that spend (a feed that left it out), so it rebuilds from the chain's logs.
  async function spentOnChain(ins, onStep) {
    onStep('reading the pool again');
    if (!(await seenSpent(ins, 60_000))) await rescanFromChain().catch(() => {});
    return spentAlready();
  }

  // One transaction: spends `ins`, creates `outs` ([{ to, value } | null] × 2) and moves `extAmount` across the pool
  // boundary (> 0 in from the signer, < 0 out to `recipient`). With a relayer's quote `q` the relayer submits it
  // for q.fee, proven to follow what the relayer has queued; without, the signer does and pays the gas. Waits for
  // it to be mined and proves again when another transaction lands first. A spend whose notes are spent already, or
  // that the relay holds or is sending already, is not proved again: it ends with that said. → tx hash.
  // selfCall(tx) → { to, data }: what the signer submits, when not pool.transact (withdrawToV1).
  // ahead: a deposit proved before it was asked for (prepareDeposit), sent as it is while the pool's head is the one it was proved against.
  async function transact(args) {
    try { return await transactOnce(args); } finally { for (const n of args.ins) claimed.delete(n.nf); }
  }
  async function transactOnce({ ins, outs, extAmount = 0n, recipient = ZERO, q = null, extra = {}, selfCall = null, ahead = null, onStep = () => {}, onSend = null, onSent = null }) {
    // A spend's outputs take one-time keys the sender can derive again (paymentKey); a deposit's are random.
    const attempt = ins.length ? nextAttempt(ins[0].nf) : 0;
    const eOf = (k) => (ins.length ? paymentKey(keys, { chainId: chain.chainId, nf: BigInt(ins[0].nf), k, attempt }) : undefined);
    const sealed = outs.map((o, k) => (o ? sealNote(zk, { to: o.to, value: o.value, asset, e: eOf(k) }) : null));
    const fee = q ? BigInt(q.fee) : 0n, relayer = q ? q.relayer : ZERO;
    const inputs = [...ins.map(asInput), ...Array(2 - ins.length).fill({ dummy: true })];
    const inserts = sealed.some(Boolean);
    const simulated = !!(extra.call || extra.wrap);
    const made = ahead ? await ahead.done.catch(() => null) : null;
    let treeRefused = false;
    for (let round = 0; round < 8; round++) {
      if (round) { onStep('someone else got in first, proving again'); await jitter(round); await sync(); }
      if (!holds(ins)) throw spentAlready();
      let tree = state().tree, slot = null;
      if (q && inserts && !simulated) {
        const r = await reserveSlot(sealed, ins);
        if (r === 'spent') throw await spentOnChain(ins, onStep);
        // A spend of these notes waits in the relay's queue: from this key elsewhere, or the reservation of an earlier try,
        // which the keeper drops 90 s after it was made. Once it lands the funds are spent; else reserve again.
        if (r === 'queued') {
          onStep('a spend of these funds is queued already; waiting for it');
          if (await seenSpent(ins, 120_000)) throw spentAlready();
          continue;
        }
        if (r === 'stale') continue;
        if (r === 'tail') tree = (await queueTail(false)) || tree;
        else if (r) { slot = r.id; tree = r.tree; }
      } else if (q && inserts) tree = (await queueTail(true)) || tree;
      try { onSend?.(ins.map((n) => n.index)); } catch { }       // the leaves of the notes this spend is built from, given before it is proved and sent, for a caller that must tell later whether it went
      let tx = !round && made && made.root === tree.root && made.size === tree.size ? made.tx : null;
      if (!tx) {
        try { tx = await proveTx({ tree, inputs, sealed, extAmount, recipient, relayer, fee, onStep }); } catch (e) { if (slot) await releaseSlot(slot); throw e; }
      }
      let h;
      if (q) {
        onStep('sending through the relayer');
        // An unanswered request may still have been sent: read the chain again, and say so rather than invite a blind retry.
        const unanswered = () => {
          sync().catch(() => {});
          return Object.assign(new Error('The relay did not answer, and it may still have sent your payment. Check Activity before sending again.'), { said: true });
        };
        const r = await keeperPost('/relay', { tx, ...extra, ...(slot ? { reservation: slot } : {}) }).catch(() => { throw unanswered(); });
        // A gateway's own timeout or error (502-504, 520-524) says nothing of whether the relay sent it: the same as no answer.
        // The relay's own refusals come with its JSON error (a 503 when it cannot front the gas or is full) and send nothing.
        if (((r.status >= 502 && r.status <= 504) || (r.status >= 520 && r.status <= 524) || r.status === 200) && !r.body?.error && !r.body?.txHash) throw unanswered();
        if (r.status !== 200 || !r.body.txHash) {
          if (slot) await releaseSlot(slot);
          const why = String(r.body?.error || '');
          // Final: the pool has the notes spent, or the relay is sending this spend already (it lands, or is on its way).
          if (/AlreadyNullified|already spent/.test(why)) throw await spentOnChain(ins, onStep);
          if (/already being relayed/.test(why)) {
            onStep('a spend of these funds is on its way already; waiting for it');
            throw (await seenSpent(ins, 120_000)) ? spentAlready()
              : Object.assign(new Error('A spend of these funds is already on its way. Check Activity before sending again.'), { said: true });
          }
          if (r.status === 409 && r.body.stale) { if (/StaleRoot|WrongInsertionIndex|unknown membership root/i.test(why)) treeRefused = true; continue; }
          // A relay that rate limits this connection has been asked over the time it asked to be waited for (keeperFetch). Proving again cannot help a limiter and costs
          // half a minute a round, so this ends here, with nothing sent, in words that offer the wallet's own send.
          if (r.status === 429) throw Object.assign(new Error('The relay is rate limiting this connection, so nothing was sent. Try again in a minute, or send it from your own wallet.'), { said: true, busy: true });
          if (/^\d+$/.test(String(r.body?.needFee ?? ''))) throw feeWentUp(r.body.needFee);
          throw new Error(why || `relayer returned ${r.status}`);
        }
        h = r.body.txHash;
      } else {
        const c = selfCall ? selfCall(tx) : { to: chain.pool, data: transactData(tx) };
        // a call that names its own value (the zap, sent no ETH) is sent that; a deposit into the ETH pool is otherwise sent its amount
        try { h = await sendSelf(c.to, c.data, c.value ?? (extAmount > 0n && !isToken ? extAmount : 0n), onStep, c.before); }
        catch (e) {
          if (made && tx === made.tx) aheadDeposit ||= ahead;   // the proof made ahead stands for the next try: if this send did land, that one is refused before the wallet
          if (e?.spent) await rescanFromChain().catch(() => {});
          throw e;
        }
        if (!h) { treeRefused = true; continue; }
      }
      try { onSent?.(h); } catch { }                              // (the hash, before the wait for the block)
      for (const n of ins) pending.add(n.nf);
      onStep('waiting for it to be mined');
      if (await landed(h, ins.map((n) => n.nf), q ? chain.rpc : signer?.rpc || chain.rpc)) {
        // Returns once this wallet sees it (spent notes gone, change in), so the next action can build on it.
        const spent = new Set(ins.map((n) => n.nf));
        const seen = await waitFor(() => !state().notes.some((n) => spent.has(n.nf)), 60_000).then(() => true, () => false);
        // Not seen landing (no receipt in time, or dropped or replaced): its notes come back if the chain still has
        // them unspent a while later. A late landing then only makes a spend of them fail and read the chain again.
        if (!seen) setTimeout(() => { sync().catch(() => {}).then(() => { for (const nf of spent) pending.delete(nf); }); }, 15 * 60_000).unref?.();
        return h;
      }
      for (const n of ins) pending.delete(n.nf);
    }
    // No round landed. When the pool refused the tree a round was proved against (a stale or unknown root, a wrong
    // insertion index), the state is rebuilt from the chain's logs alone; a queue or a busy relay is no reason to.
    if (treeRefused) await rescanFromChain().catch(() => {});
    throw new Error('the pool kept moving; try again');
  }

  // Forgets the synced state and rebuilds it from chain logs alone (no feed).
  // (Overlapping rescans share one switch: the feed is back on when the last has finished, not off for good because a second one found it already off.)
  let feedOffs = 0, feedWas = false;
  async function rescanFromChain() {
    await reading.catch(() => {});
    saved = rebuilt(); view = null; readAt = 0; persist();
    if (!feedOffs++) feedWas = feed;
    feed = false;
    try { return await sync(); } finally { if (!--feedOffs) feed = feedWas; }
  }

  // A quote above `maxFee`, the most the caller showed for it, is refused so the spend never costs more than shown. The
  // error carries the fee now (feeMoved), as does a relay's refusal of a proven spend whose fee no longer covers its gas.
  const feeWentUp = (fee) => Object.assign(new Error('The relay fee went up since it was shown. Check the new fee and try again.'), { feeMoved: BigInt(fee) });
  function withinFee(q, maxFee) {
    if (maxFee == null || BigInt(q.fee) <= BigInt(maxFee)) return q;
    throw feeWentUp(q.fee);
  }
  // The relayer's quote for a spend, or null when the signer submits it.
  async function quoteFor(via, gas = null, maxFee = null) {
    if (via === 'relay' && !keeper) throw new Error('no relayer is configured for this chain');
    if (via === 'self' || !keeper) {
      if (!signer) throw new Error('no relayer and no wallet to send from');
      return null;
    }
    return withinFee(await keeperGet(gas ? `/quote?gas=${gas}` : '/quote'), maxFee);
  }

  // Merges the two largest notes into one, repeatedly, until two notes cover `need` (each merge pays a fee). Refuses
  // before the first merge when no run of them would, so no fee is paid for a spend that cannot happen. A merge is an
  // ordinary spend: where `q` is priced for a call (withdrawAndCall, toV1), `mergeQuote` gives the ordinary quote it
  // pays, asked for only once a merge is needed.
  async function prepare(need, q, onStep, mergeQuote = null) {
    const ready = select(need);
    if (ready) { claim(ready); return ready; }
    const mq = q && mergeQuote ? await mergeQuote() : q, fee = mq ? BigInt(mq.fee) : 0n;
    if (mergePlan(free().map((n) => n.v), need, fee) == null) {
      throw new Error(mergePlan(unspent().map((n) => n.v), need, fee) == null ? 'not enough in the pool for this amount and its fee' : 'another spend from this wallet is under way and holds those funds; try again when it has finished');
    }
    for (let guard = 0; guard < 8; guard++) {
      const pick = select(need);
      if (pick) { claim(pick); return pick; }
      const u = free().sort((a, b) => (BigInt(b.v) < BigInt(a.v) ? -1 : 1));
      if (u.length < 2) break;
      const total = BigInt(u[0].v) + BigInt(u[1].v);
      if (total <= fee) break;
      onStep('combining notes first');
      claim([u[0], u[1]]);
      await transact({ ins: [u[0], u[1]], outs: [{ to: keys, value: total - fee }, null], q: mq, onStep });
      await waitFor(() => unspent().some((n) => BigInt(n.v) === total - fee));
    }
    throw new Error('not enough in the pool for this amount and its fee');
  }
  async function waitFor(ok, ms = 180_000) {
    const t0 = Date.now();
    for (;;) {
      await sync();
      if (ok()) return;
      if (Date.now() - t0 > ms) throw new Error('timed out waiting for the previous transaction');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  const self = { V: keys.V, A: keys.A, N: keys.N };
  // amount 'max': all that one spend takes out, its two largest notes, less the fee quoted for that very spend.
  const maxOf = (fee) => {
    const u = free().map((n) => BigInt(n.v)).sort((a, b) => (b < a ? -1 : 1)), total = (u[0] ?? 0n) + (u[1] ?? 0n);
    if (total <= fee) throw new Error('not enough in the pool for this amount and its fee');
    return total - fee;
  };
  const NODE_INTERFACE = '0x00000000000000000000000000000000000000C8';
  const hasCode = async (rpc, a) => { const c = await rpc('eth_getCode', [a, 'latest']); return !!c && c !== '0x'; };
  // The chain's time in unix seconds, its latest block's, which a call intent's deadline counts from (this device's clock only where no node serves the block).
  const chainNow = () => chain.rpc('eth_getBlockByNumber', ['latest', false]).then((b) => Number(BigInt(b.timestamp))).catch(() => Math.floor(Date.now() / 1000));

  const api = {
    address: keys.address,
    receiveBox: box,
    asset,
    sync,
    summary,
    notes: () => unspent(),
    // The notes held now and those seen spent in the last three days, with their keys: what a holding claim may be made for.
    holdingNotes: () => [...state().notes, ...freshSpent(state().recentSpent).map(withKeys)],
    // Sets the user's own wallet for self-submitted actions ({ address, send }, as the signer option).
    connect(s) { signer = s; },
    // Forgets the synced state and rebuilds it from chain logs alone (no feed).
    rescan: () => rescanFromChain(),
    // Behind a catch-up point: the history before it, read into a second state (readBack), then taken in place of this one (adopt); backfill does both.
    readBack,
    adopt,
    backfill: () => startBackfill(),
    // Where this key's history can be read from: a catch-up point behind which it holds no leaf, { size, block }, with partial set while the
    // history behind the point is still unread (so that is not known yet); null for the pool's first block.
    historyFrom: () => (saved.from ? { size: saved.from.size, block: saved.from.block, partial: true }
      : saved.pointed && saved.first !== undefined && (saved.first === null || saved.first >= saved.pointed.size) ? { size: saved.pointed.size, block: saved.pointed.block, partial: false } : null),
    // The relayer's quote: priced for a spend that burns `gas` (withdrawAndCall, toV1) when given, else an ordinary one.
    quote: (gas = null) => keeperGet(gas ? `/quote?gas=${gas}` : '/quote'),
    // The receive box at `index` (0 is the private ETH address; later ones are one-time addresses, e.g. per payment
    // request, found again from the seed within the same gap as refund boxes). → address
    receiveBoxAt: (index = RECEIVE_INDEX) => boxOf(index),
    // ETH at a receive box not yet swept into a note. → wei
    waiting: async (index = RECEIVE_INDEX) => BigInt(await chain.rpc('eth_getBalance', [boxOf(index), 'latest'])),
    // Asks the relayer to watch a receive box (and look now).
    watchReceive: (index = RECEIVE_INDEX) => keeperPost('/receive', { chainId: chain.chainId, npk: receiveKeys(zk, keys.zkWallet, index).npk.toString(), feeBps: RECEIVE_FEE_BPS }),

    // Pays `amount` wei (or 'max') out of the pool to `to` (0x…). → tx hash.
    async withdraw({ to, amount, via = null, maxFee = null, onStep = () => {}, onSend = null, onSent = null }) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(to)) || BigInt(to) === 0n) throw new Error('enter a 0x address');
      if (amount !== 'max' && BigInt(amount) <= 0n) throw new Error('enter an amount');
      await sync();
      const q = await quoteFor(via, null, maxFee);
      const fee = q ? BigInt(q.fee) : 0n, a = amount === 'max' ? maxOf(fee) : BigInt(amount);
      const ins = await prepare(a + fee, q, onStep);
      const change = ins.reduce((s, n) => s + BigInt(n.v), 0n) - a - fee;
      return transact({ ins, outs: [change > 0n ? { to: self, value: change } : null, null], extAmount: -a, recipient: to, q, onStep, onSend, onSent });
    },

    // Watches receive boxes through `index`, e.g. a payment-request box a payment reached on another chain, so a payment
    // to it here is found too. → true when `index` lay past what was watched: earlier events for it were never read,
    // so the synced state should be rebuilt (rescan, or a fresh wallet) to find them.
    watchThrough(index) {
      const unread = index >= saved.nextRefund + REFUND_GAP;
      if (index >= saved.nextRefund) { saved.nextRefund = index + 1; persist(); }
      return unread;
    },

    // A deposit box that pays a note of `amount - fee` to this key: the intent is sealed for it, given to this pool's relay, which completes
    // it with its own proof once the box holds `amount` (the fee is its reward). Anything that pays the box (a swap's output from another
    // pool) lands here as a note, with no step of this wallet's; what the box holds above `amount` goes to `refund` after the deadline.
    // → { box, amount, value, deadline }
    async depositBox({ amount, fee, refund, deadline, nonce = BigInt(hex(globalThis.crypto.getRandomValues(new Uint8Array(16)))) }) {
      const a = BigInt(amount), f = BigInt(fee);
      if (a <= f) throw new Error('the deposit box must hold more than the relay\u2019s fee');
      const n = sealNote(zk, { to: self, value: a - f, asset });
      const { intent, hint } = depositIntent(zk, { asset, amount: a, outputs: [{ v: n.v, npk: n.npk, rho: n.rho }], memo0: n.memo, refund, deadline, nonce });
      const box = '0x' + String(await chain.rpc('eth_call', [{ to: chain.router, data: calldata(`depositBoxOf(${'(' + DEPOSIT_TYPES.join(',') + ')'})`, [{ tuple: DEPOSIT_TYPES }], [[intent.amount, intent.outLeaf0, intent.outLeaf1, intent.memo0Hash, intent.memo1Hash, intent.refund, intent.deadline, intent.nonce]]) }, 'latest'])).slice(-40);
      const str = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
      const res = await keeperPost('/deposit', { intent: str(intent), hint: { outputs: [{ v: n.v.toString(), npk: n.npk.toString(), rho: n.rho.toString() }, null], memo0: hex(n.memo), memo1: '0x' } });
      if (res.status !== 200 || String(res.body?.box || '').toLowerCase() !== box.toLowerCase()) throw new Error(`The relay did not take this deposit (${res.body?.error || res.status}), so nothing was sent.`);
      // `intent` is what a reclaim of whatever the box holds above its floor needs (public: the pool emits it with the deposit); it cannot be built again from the keys, as its nonce and note are random
      return { box, amount: a, value: a - f, deadline: Number(deadline), intent: str(intent) };
    },

    // A fresh receive box for a call intent's refund (anything returned is swept back into a note here), and asks
    // the relayer to watch it. → the box address.
    async refundBox() {
      const i = saved.nextRefund++;
      persist();
      const npk = receiveKeys(zk, keys.zkWallet, i).npk;
      if (keeper) await keeperPost('/receive', { chainId: chain.chainId, npk: npk.toString(), feeBps: RECEIVE_FEE_BPS }).catch(() => {});
      return boxOf(i);
    },

    // Withdraws `amount` (wei, or the token pool's base units) into `intent`'s escrow (gateway callIntent) and runs it in the same
    // transaction (router.withdrawAndCall): sent by the relayer, or with `via: 'self'` by the signer (who pays the gas and is seen
    // sending it). In a token pool the escrow holds the token, and a call approves or pushes it (a call's token, amount and push). → tx hash.
    // gas: what the withdrawal and its calls need; by default the relay's plus 250k per call.
    async withdrawAndCall({ intent, amount, gas = null, maxFee = null, via = 'relay', onStep = () => {} }) {
      if (isToken && (intent.calls || []).some((c) => BigInt(c.value || 0) !== 0n)) throw new Error('a token pool\'s escrow holds the token, not ETH: its calls send no value');
      const a = BigInt(amount);
      if (a <= 0n) throw new Error('enter an amount');
      await sync();
      const self_ = via === 'self';
      const q = self_ ? null : withinFee(await keeperGet(`/quote?gas=${gas ?? 450_000 + 250_000 * (intent.calls?.length ?? 1)}`), maxFee);
      const fee = q ? BigInt(q.fee) : 0n;
      const ins = await prepare(a + fee, q, onStep, () => quoteFor(via, null, maxFee));
      const change = ins.reduce((s, n) => s + BigInt(n.v), 0n) - a - fee;
      return transact({
        ins, outs: [change > 0n ? { to: self, value: change } : null, null], extAmount: -a, recipient: callEscrowAddress(intent, chain.router),
        q, extra: q ? { call: callIntentJson(intent) } : {}, onStep,
        selfCall: self_ ? (tx) => ({ to: chain.router, data: withdrawAndCallData(tx, intent) }) : null,
      });
    },

    // Sends `amount` wei (or 'max') privately to a Secret Sats address. → tx hash.
    async send({ to, amount, via = null, maxFee = null, onStep = () => {} }) {
      const recipient = recipientOf(keys, to);
      if (amount !== 'max' && BigInt(amount) <= 0n) throw new Error('enter an amount');
      await sync();
      const q = await quoteFor(via, null, maxFee);
      const fee = q ? BigInt(q.fee) : 0n, a = amount === 'max' ? maxOf(fee) : BigInt(amount);
      const ins = await prepare(a + fee, q, onStep);
      const change = ins.reduce((s, n) => s + BigInt(n.v), 0n) - a - fee;
      return transact({ ins, outs: [{ to: recipient, value: a }, { to: self, value: change }], q, onStep });
    },

    // Deposits `amount` wei from the signer into a private note here. → tx hash.
    // `selfCall(tx)` → { to, data, value?, before? }: what the signer submits in place of pool.transact; a token pool takes its
    // deposit through the router (routerDeposit), with `before` (an approval) sent in the same batch; the ETH pool can take one
    // through the zap (zapDeposit), from a token swapped for the deposit's ETH in the same transaction.
    // `readAt`: when the caller began reading the pool just before this call. That read stands for the one made here, when it began after any proof made ahead was
    // done and is a few seconds old at most; a head that moves after it is found by the check before the wallet, which proves again.
    async deposit({ amount, selfCall = null, onStep = () => {}, readAt = 0 }) {
      const a = BigInt(amount);
      if (a <= 0n) throw new Error('enter an amount');
      const ahead = takeAheadDeposit(a);
      if (ahead && !ahead.ready) onStep('proving on this device');
      let before;
      try {
        await ahead?.done.catch(() => {});                          // a proof still being made is waited for before the pool is read, so a head that moved meanwhile is found
        before = (readAt && Date.now() - readAt < 5000 && (!ahead || (ahead.at ?? Infinity) <= readAt) ? summary() : await sync()).balance;
      } catch (e) { if (ahead && !aheadDeposit) aheadDeposit = ahead; throw e; }   // a read that failed does not cost the proof
      const h = await transact({ ins: [], outs: [{ to: self, value: a }, null], extAmount: a, selfCall, ahead, onStep });
      // Returns once the note is spendable here (log providers can trail the receipt by a few seconds).
      await waitFor(() => summary().balance >= before + a, 60_000).catch(() => {});
      return h;
    },

    // Proves a deposit of `amount` before it is asked for: the deposit of that amount made next finds its proof made. The proof builds on the
    // pool's head, so it stands until another transaction inserts into the pool; a deposit that finds the head moved proves its own. One proof
    // is kept, the latest asked for, and taken by the deposit of its amount, once.
    async prepareDeposit(amount) {
      const a = BigInt(amount);
      if (a <= 0n) throw new Error('enter an amount');
      if (aheadDeposit?.amount === a) return aheadDeposit.done.then(() => true);
      const mine = aheadDeposit = { amount: a, ready: false };
      mine.done = (async () => {
        await sync();
        const tree = state().tree, sealed = [sealNote(zk, { to: self, value: a, asset }), null];
        const tx = await proveTx({ tree, inputs: [{ dummy: true }, { dummy: true }], sealed, extAmount: a, recipient: ZERO, relayer: ZERO, fee: 0n });
        mine.ready = true; mine.at = Date.now();
        return { tx, root: tree.root, size: tree.size };
      })();
      mine.done.catch(() => { if (aheadDeposit === mine) aheadDeposit = null; });
      return mine.done.then(() => true);
    },

    // Deposits `amount` wei from the signer straight into a private note for someone else's pool address (bp1…),
    // proved here and sent by the signer: the deposit (its sender and amount) shows on chain, whom it pays does not;
    // the recipient finds it by its memo. → tx hash.
    async depositTo({ to, amount, selfCall = null, onStep = () => {} }) {
      const recipient = recipientOf(keys, to);
      const a = BigInt(amount);
      if (a <= 0n) throw new Error('enter an amount');
      await sync();
      return transact({ ins: [], outs: [{ to: recipient, value: a }, null], extAmount: a, selfCall, onStep });
    },

    // Sweeps a receive box (the private ETH address by default) into a note here, submitted by the signer: no fee,
    // any amount. → tx hash.
    async sweep({ index = RECEIVE_INDEX, onStep = () => {} } = {}) {
      ethOnly('Sweeping a receive box');
      const npk = receiveKeys(zk, keys.zkWallet, index).npk, box = boxOf(index);
      for (let round = 0; round < 4; round++) {
        await sync();
        const [bal, n] = await Promise.all([
          chain.rpc('eth_getBalance', [box, 'latest']),
          chain.rpc('eth_call', [{ to: chain.router, data: calldata('receiveCount(address)', ['address'], [box]) }, 'latest']),
        ]);
        const amount = BigInt(bal);
        if (amount === 0n) throw new Error('nothing is waiting at your private ETH address');
        const w = sweepWitness(zk, { asset, tree: state().tree, npk, feeBps: RECEIVE_FEE_BPS, box, n: BigInt(n), amount, fee: 0n, relayer: ZERO, chainId: chain.chainId, pool: chain.pool });
        onStep('proving on this device');
        const { proof, publicSignals } = await prove(w.input);
        const tx = toTx(proof, publicSignals, { recipient: ZERO, extAmount: amount.toString(), relayer: ZERO, fee: '0', memo0: '0x', memo1: '0x' });
        const h = await sendSelf(chain.router, sweepData(npk, RECEIVE_FEE_BPS, tx), 0n, onStep);
        if (h) { onStep('waiting for the block'); if (await landed(h)) return h; }
        onStep('someone else got in first, proving again');
      }
      throw new Error('the pool kept moving; try again');
    },

    // Moves `amount` wei from this Ethereum pool to the same wallet's private ETH address on an L2 (8453 Base, 4663
    // Robinhood Chain) in one relayed withdraw-and-call through the L2's canonical bridge; that chain's keeper then
    // sweeps it into a note there (watchReceive on the L2 wallet). Arrives in minutes. The amount and the address
    // are public on Ethereum; which note paid is not. l2Rpc (a jsonRpc on the L2) is needed for Robinhood Chain,
    // whose retryable is priced from the L2. `now`: the chain's time in unix seconds, which its hour-long deadline
    // counts from (the chain's latest block by default). → tx hash.
    async bridgeOut({ toChainId, amount, l2Rpc = null, maxFee = null, now = null, onStep = () => {} }) {
      ethOnly('Bridging out');
      if (Number(chain.chainId) !== 1) throw new Error('bridging out starts from the Ethereum pool');
      const b = L2_BRIDGES[Number(toChainId)];
      if (!b) throw new Error(`no bridge to chain ${toChainId}`);
      const a = BigInt(amount);
      if (a <= 0n) throw new Error('enter an amount');
      // Code at `to` on Ethereum would make an Arbitrum refund land on its alias; a box has code only mid-sweep.
      if (await hasCode(chain.rpc, box)) throw new Error('your private ETH address is mid-sweep on Ethereum; try again in a minute');
      let args = { chainId: toChainId, to: box, amount: a };
      if (b.kind === 'arbitrum') {
        if (!l2Rpc) throw new Error('bridging to this chain needs an RPC for it');
        if (await hasCode(l2Rpc, box)) throw new Error('your private ETH address is mid-sweep on the destination; try again in a minute');
        const block = await chain.rpc('eth_getBlockByNumber', ['latest', false]);
        const maxSubmissionCost = BigInt(await chain.rpc('eth_call', [{ to: b.inbox, data: calldata('calculateRetryableSubmissionFee(uint256,uint256)', ['uint256', 'uint256'], [0n, BigInt(block.baseFeePerGas) * 2n]) }, 'latest']));
        // A thin fee cap strands the ticket if the L2 base fee moves before it runs; unused gas refunds to `to`.
        const gp = BigInt(await l2Rpc('eth_gasPrice'));
        const maxFeePerGas = gp * 8n > 100_000_000n ? gp * 8n : 100_000_000n;
        let gasLimit = 300_000n;
        try {
          const est = BigInt(await l2Rpc('eth_estimateGas', [{ to: NODE_INTERFACE, data: calldata('estimateRetryableTicket(address,uint256,address,uint256,address,address,bytes)',
            ['address', 'uint256', 'address', 'uint256', 'address', 'address', 'bytes'], [box, 10n ** 18n + 1n, box, 1n, box, box, '0x']) }]));
          gasLimit = (est * 3n) / 2n;
        } catch {}
        args = { ...args, maxSubmissionCost, gasLimit, maxFeePerGas };
      }
      const { call: c, value } = bridgeEthCall(args);
      const refund = await api.refundBox();
      const nonce = BigInt(hex(globalThis.crypto.getRandomValues(new Uint8Array(16))));
      const intent = callIntent({ calls: [c], refund, deadline: BigInt((now ?? (await chainNow())) + 3600), nonce });
      // The OP portal burns L1 gas to buy the deposit's L2 gas (~620k in all); a retryable costs ~100k.
      return api.withdrawAndCall({ intent, amount: value, gas: b.kind === 'op' ? 1_300_000 : 700_000, maxFee, onStep });
    },

    // Moves `amount` wei (a multiple of 1e10) from this Ethereum pool into a V1 tETH note with commitment `commit`,
    // in one transaction (router.withdrawToV1): relayed by default, or from the signer with via: 'self'. `commit` is
    // V1's wrap commitment for the wallet's own next V1 note (confidential-pool-ux buildWrap(...).commit); the V1
    // wallet finds the deposit from its key and makes it a note with its usual wrap settle. `now` as for bridgeOut. → tx hash.
    async toV1({ amount, commit, via = null, maxFee = null, now = null, onStep = () => {} }) {
      ethOnly('Moving into V1');
      if (Number(chain.chainId) !== 1) throw new Error('V1 is on Ethereum; move to V1 from the Ethereum pool');
      const a = BigInt(amount);
      if (a <= 0n || a % V1_UNIT !== 0n) throw new Error('the amount must be a positive multiple of 1e10 wei');
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(commit)) || BigInt(commit) === 0n) throw new Error('commit must be a 32-byte V1 wrap commitment');
      await sync();
      const q = await quoteFor(via, 700_000, maxFee);
      const fee = q ? BigInt(q.fee) : 0n;
      const intent = {
        assetId: V1_TETH_ASSET_ID, amount: a, tip: 0n, tipTo: ZERO, commit,
        // Only a box funded and never completed is reclaimable; withdrawToV1 funds and completes in one call.
        refund: await api.refundBox(),
        deadline: BigInt((now ?? (await chainNow())) + 3600), nonce: BigInt(hex(globalThis.crypto.getRandomValues(new Uint8Array(16)))),
      };
      const box = '0x' + String(await chain.rpc('eth_call', [{ to: chain.router, data: calldata(`wrapBoxOf(${WRAP_SIG})`, [{ tuple: WRAP_TYPES }], [wrapValues(intent)]) }, 'latest'])).slice(-40);
      const ins = await prepare(a + fee, q, onStep, () => quoteFor(via, null, maxFee));
      const change = ins.reduce((s, n) => s + BigInt(n.v), 0n) - a - fee;
      return transact({
        ins, outs: [change > 0n ? { to: self, value: change } : null, null], extAmount: -a, recipient: box, q, onStep,
        extra: { wrap: { ...intent, amount: a.toString(), tip: '0', deadline: intent.deadline.toString(), nonce: intent.nonce.toString() } },
        selfCall: (tx) => ({ to: chain.router, data: withdrawToV1Data(tx, intent) }),
      });
    },
  };
  return api;
}
