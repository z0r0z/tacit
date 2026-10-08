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
import { receiveKeys, receivedNote, receiveBoxAddress, sweepWitness, callIntent, callEscrowAddress, callIntentJson, calldata, selector, bridgeEthCall, L2_BRIDGES, RECEIVE_FEE_BPS, RECEIVE_INDEX } from './evm-pool-gateway.js';

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
// gets `timeoutMs` to answer before the next is tried, so one that stops responding cannot stall every read behind it.
export function jsonRpc(urls, fetchImpl = globalThis.fetch.bind(globalThis), { timeoutMs = 25_000 } = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  let id = 0, first = 0;
  return async (method, params = []) => {
    const all = [];
    for (let k = 0; k < list.length; k++) {
      const at = (first + k) % list.length, url = list[at];
      try {
        const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout?.(timeoutMs) });
        const j = await r.json();
        if (j.error) throw Object.assign(new Error(j.error.message || 'rpc error'), { rpc: j.error });
        first = at;
        return j.result;
      } catch (e) {
        if (e.rpc && /revert/i.test(e.message) && (method === 'eth_call' || method === 'eth_estimateGas')) throw e;
        all.push(e);
      }
    }
    throw Object.assign(all[all.length - 1] || new Error('no rpc url'), { all });
  };
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
const WRAP_SIG = '(bytes32,uint256,uint256,address,bytes32,address,uint64,uint256)';
const WRAP_TYPES = ['bytes32', 'uint256', 'uint256', 'address', 'bytes32', 'address', 'uint64', 'uint256'];
const wrapValues = (i) => [i.assetId, i.amount, i.tip, i.tipTo, i.commit, i.refund, i.deadline, i.nonce];
const withdrawToV1Data = (t, i) => calldata(`withdrawToV1(${TX_SIG},${WRAP_SIG})`, [{ tuple: TX_TYPES }, { tuple: WRAP_TYPES }], [txValues(t), wrapValues(i)]);
// V1's tETH (native ETH) asset id and its unit: a wrap amount is a whole number of 1e10 wei.
export const V1_TETH_ASSET_ID = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const V1_UNIT = 10n ** 10n;
const sweepData = (npk, feeBps, t) => calldata(`sweepReceive(uint256,uint16,${TX_SIG})`, ['uint256', 'uint16', { tuple: TX_TYPES }], [npk, feeBps, txValues(t)]);
// Reverts meaning another transaction landed first: prove again against the new state.
const RACED = new Set(['StaleRoot()', 'WrongInsertionIndex()', 'UnknownMembershipRoot()', 'BadIntent()'].map((e) => hex(selector(e))));
const revertData = (e) => { for (let x = e; x; x = x.cause) { const d = x.rpc?.data?.data ?? x.rpc?.data ?? x.data?.data ?? x.data; if (typeof d === 'string' && d.startsWith('0x')) return d; } return ''; };

// ── wallet ──

// chain: { chainId, pool, router, rpc (a jsonRpc), deployBlock, logChunk?, confirmations? }
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
export function makeEvmPoolWallet({ zk, keys, chain, keeper = null, prove, store = null, signer = null, feed = true, fetchImpl = globalThis.fetch?.bind(globalThis) }) {
  const asset = poolAsset({ chainId: BigInt(chain.chainId), pool: chain.pool, token: ZERO });
  const boxes = new Map();      // an index's address is fixed by the key, so each is derived once
  const boxOf = (i) => { if (!boxes.has(i)) boxes.set(i, receiveBoxAddress(receiveKeys(zk, keys.zkWallet, i).npk, RECEIVE_FEE_BPS, chain.router)); return boxes.get(i); };
  const box = boxOf(RECEIVE_INDEX);
  const topicOf = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
  const confirmations = chain.confirmations ?? 12;
  const skey = `tacit-evm-pool-v1:${chain.chainId}:${chain.pool.toLowerCase()}:${keys.address}`;

  // State: { block, tree (an incTree tracking each unspent owned note), notes (unspent), nextRefund }. The tree keeps
  // the pool's right edge and owned paths only, so state stays small however large the pool grows.
  const blank = () => ({ block: Number(chain.deployBlock ?? 0) - 1, tree: zk.incTree(), notes: [], nextRefund: 1, attempts: {} });
  let saved = blank();
  try {
    const j = openState(keys.v, store?.get(skey));
    if (j) {
      const o = JSON.parse(j);
      let tree;
      if (o.tree) tree = zk.incTree(o.tree);
      else { // state saved with every leaf: rebuild the tree once, tracking the owned notes
        tree = zk.incTree();
        tree.append((o.leaves || []).map(BigInt), (o.notes || []).map((n) => n.index));
      }
      saved = { nextRefund: 1, attempts: {}, ...o, tree };
      delete saved.leaves;
      delete saved.spent;
    }
  } catch { saved = blank(); }
  let view = null; // saved state plus the unconfirmed tail, from the last sync

  // Receive boxes watched: box 0 (the public receive address) and the refund boxes of call intents, indices 1 up
  // to REFUND_GAP past the next unused one, so a wallet restored from its seed alone still finds every refund.
  const boxIndex = new Map();
  const boxTopics = () => {
    for (let i = 0; i < saved.nextRefund + REFUND_GAP; i++) if (![...boxIndex.values()].includes(i)) boxIndex.set(topicOf(boxOf(i)), i);
    return [...boxIndex.keys()];
  };

  // Spend and nullifier keys of a stored note, from the wallet keys: never stored.
  function withKeys(n) {
    if (n.nk) return n;
    const k = n.kind === 'receive' ? receiveKeys(zk, keys.zkWallet, n.box ?? RECEIVE_INDEX) : zk.ownedKeys(keys.zkWallet, unhex(n.s));
    return { ...n, sk: k.sk.toString(), nk: k.nk.toString(), nf: zk.nullifier(k.nk, BigInt(n.leaf), n.index).toString() };
  }
  saved = { ...saved, notes: saved.notes.map(withKeys) };
  { // state saved with every nullifier: keep only the notes still unspent
    let old = null;
    try { old = JSON.parse(openState(keys.v, store?.get(skey)) || 'null')?.spent; } catch {}
    if (old) {
      const s = new Set(old);
      for (const n of saved.notes) if (s.has(n.nf)) saved.tree.untrack(n.index);
      saved.notes = saved.notes.filter((n) => !s.has(n.nf));
    }
  }
  // The stored state is sealed under a key from the wallet's view scalar, so another script on this origin reading
  // storage finds balances and note positions only as ciphertext. A state saved before this loads as plain JSON.
  const persist = () => {
    const bare = { ...saved, tree: saved.tree.toJSON(), notes: saved.notes.map(({ sk, nk, nf, ...rest }) => rest) };
    try { store?.set(skey, sealState(keys.v, JSON.stringify(bare))); } catch {}
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

  // Appends `transacts` to a copy of `state`, keeping a path for each leaf found to be ours: a memo that opens, or
  // the leaf a Received event of one of our boxes names (the same transaction, so the same batch).
  function absorb(state, transacts, receipts) {
    const spent = new Set();
    const notes = new Map(state.notes.map((n) => [noteKey(n), n]));
    const tree = state.tree.clone();
    const received = new Map(receipts.map((r) => [r.index, r]));
    const leafAt = new Map();
    const want = [];
    transacts.forEach((t, i) => {
      if (t.outLeaf[0] === 0n && t.outLeaf[1] === 0n) return;
      for (let k = 0; k < 2; k++) if (t.outLeaf[k] !== 0n && !received.has(t.firstIndex + k) && t.memo[k].length) want.push([i, k]);
    });
    const found = openNotes(zk, keys, want.map(([i, k]) => ({ memo: transacts[i].memo[k], leaf: transacts[i].outLeaf[k], asset })));
    const opens = new Map(want.map(([i, k], j) => [`${i}:${k}`, found[j]]));
    for (const [i, t] of transacts.entries()) {
      for (const nf of t.nf) if (nf !== 0n) spent.add(nf.toString());
      if (t.outLeaf[0] === 0n && t.outLeaf[1] === 0n) continue;
      if (t.firstIndex !== tree.size) throw new Error(`evm-pool-wallet: leaf ${t.firstIndex} out of order (have ${tree.size})`);
      const track = [];
      for (let k = 0; k < 2; k++) {
        const index = t.firstIndex + k;
        leafAt.set(index, t.outLeaf[k]);
        if (t.outLeaf[k] === 0n) continue;
        if (received.has(index)) { track.push(index); continue; }
        if (!t.memo[k].length) continue;
        const o = opens.get(`${i}:${k}`);
        if (o && o.v > 0n) {
          track.push(index);
          notes.set(`${index}`, withKeys({ index, leaf: t.outLeaf[k].toString(), v: o.v.toString(), rho: o.rho.toString(), s: hex(o.s), block: t.block, tx: t.tx, kind: 'memo' }));
        }
      }
      tree.append(t.outLeaf, track);
    }
    for (const r of receipts) {
      const i = boxIndex.get(r.box) ?? RECEIVE_INDEX;
      const n = receivedNote(zk, keys.zkWallet, i, r);
      const leaf = leafAt.get(r.index) ?? -1n;
      if (leaf < 0n || n.v === 0n || zk.leafOf(asset, n.v, receiveKeys(zk, keys.zkWallet, i).npk, n.rho) !== leaf) { tree.untrack(r.index); continue; }
      notes.set(`${r.index}`, withKeys({ index: r.index, leaf: leaf.toString(), v: n.v.toString(), rho: n.rho.toString(), block: r.block, tx: r.tx, kind: 'receive', box: i }));
      if (i >= saved.nextRefund) saved.nextRefund = i + 1;
    }
    // A spent note is dropped with its path; nullifiers that are not ours are not kept.
    for (const [k, n] of notes) if (spent.has(n.nf)) { tree.untrack(n.index); notes.delete(k); }
    return { ...state, tree, notes: [...notes.values()].sort((a, b) => a.index - b.index) };
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
  // (a spend that keeps failing does that itself); it cannot move funds. Any failure leaves `saved` as it was, for the chain-log scan to continue from.
  async function syncFromFeed(safe) {
    boxTopics();
    let cand = saved;
    for (let pages = 0; pages < 10_000; pages++) {
      const from = cand.block + 1;
      if (from > safe) break;
      const r = await keeperGet(`/events?from=${from}`);
      if (Number(r.chainId) !== Number(chain.chainId) || String(r.pool).toLowerCase() !== chain.pool.toLowerCase()) throw new Error('feed is for another pool');
      const through = Math.min(Number(r.through), safe);
      if (through < from) break;
      const evs = r.events.filter((e) => e.block >= from && e.block <= through);
      const ts = evs.filter((e) => e.kind === 'transact').map((e) => ({
        nf: [BigInt(e.nf0), BigInt(e.nf1)], outLeaf: [BigInt(e.outLeaf0), BigInt(e.outLeaf1)], firstIndex: Number(e.firstIndex),
        memo: [unhex(e.memo0), unhex(e.memo1)], block: e.block, tx: e.tx,
      })).sort((a, b) => a.block - b.block || a.firstIndex - b.firstIndex);
      const rs = evs.filter((e) => e.kind === 'received' && boxIndex.has(topicOf(e.box))).map((e) => ({
        box: topicOf(e.box), n: BigInt(e.n), index: Number(e.index), value: BigInt(e.value), rho: BigInt(e.rho), fee: BigInt(e.fee), block: e.block, tx: e.tx,
      }));
      const next = { ...absorb(cand, ts, rs), block: through };
      if (next.tree.size !== cand.tree.size) {
        const size = BigInt(await view32('rootSize(bytes32)', ['bytes32'], [next.tree.root]));
        if (size !== BigInt(next.tree.size)) throw new Error('feed leaves do not match the pool');
      }
      cand = next;
    }
    if (cand === saved) return;
    saved = cand;
    persist();
  }

  // Reads new events: those `confirmations` deep are kept, the rest are re-read next time. With a keeper, confirmed
  // history comes from its feed first when it can. One read at a time: each absorbs into the state the last one left,
  // so a caller arriving while one runs waits for it, then reads what came after.
  let reading = Promise.resolve(), healedAt = 0;
  function sync() {
    const run = reading.catch(() => {}).then(readHealed);
    reading = run;
    return run;
  }
  // A node that answered short of the range it was asked (one behind the others) can leave the kept tree missing
  // leaves, so every later read stops at a leaf out of order. The chain's logs alone are then read again from the
  // start, at most once in ten minutes.
  async function readHealed() {
    try { return await readNew(); } catch (e) {
      if (!/ out of order /.test(e?.message || '') || Date.now() - healedAt < 600_000) throw e;
      healedAt = Date.now();
      const keep = { attempts: saved.attempts, nextRefund: saved.nextRefund };
      saved = { ...blank(), ...keep }; view = null; persist();
      const f = feed; feed = false;
      try { return await readNew(); } finally { feed = f; }
    }
  }
  async function readNew() {
    const tip = Number(BigInt(await chain.rpc('eth_blockNumber')));
    const safe = tip - confirmations;
    if (keeper && feed && saved.block < safe) await syncFromFeed(safe).catch(() => {});
    const from = saved.block + 1;
    if (from > tip) return summary();
    boxTopics();
    // Every Received event of the router is read and ours picked out here, so the node is not told which boxes are
    // one wallet's.
    const [tlogs, rlogs] = await Promise.all([
      logs(chain.pool, [TRANSACT_TOPIC], from, tip),
      logs(chain.router, [RECEIVED_TOPIC], from, tip),
    ]);
    const ts = tlogs.map(decodeTransact).sort((a, b) => a.block - b.block || a.firstIndex - b.firstIndex);
    const rs = rlogs.map(decodeReceived).filter((r) => boxIndex.has(r.box));
    if (safe >= from) {
      const next = { ...absorb(saved, ts.filter((t) => t.block <= safe), rs.filter((r) => r.block <= safe)), block: safe };
      if (next.tree.size !== saved.tree.size) {
        const size = BigInt(await view32('rootSize(bytes32)', ['bytes32'], [next.tree.root]));
        if (size !== BigInt(next.tree.size)) throw new Error('the node\'s logs do not match the pool');
      }
      saved = next;
      persist();
    }
    view = absorb(saved, ts.filter((t) => t.block > safe), rs.filter((r) => r.block > safe));
    return summary();
  }

  const state = () => view || saved;
  const unspent = () => state().notes.filter((n) => !pending.has(n.nf));
  const pending = new Set();
  function summary() {
    const u = unspent();
    return { balance: u.reduce((a, n) => a + BigInt(n.v), 0n), notes: u.length, leaves: state().tree.size, block: saved.block };
  }

  // ── spending ──

  // A busy keeper answers 429 with Retry-After: wait and ask again a few times. A keeper that never answers gives up
  // in time (a relay may wait on the chain; everything else answers fast), so no read or action waits on it forever.
  async function keeperFetch(path, init = {}) {
    if (!keeper) throw new Error('no relayer is configured for this chain');
    for (let i = 0; ; i++) {
      const r = await fetchImpl(`${keeper}${path}`, { ...init, signal: init.signal || AbortSignal.timeout?.(path === '/relay' ? 180_000 : 30_000) });
      if (r.status !== 429 || i >= 4) return r;
      await new Promise((ok) => setTimeout(ok, (Number(r.headers?.get?.('retry-after')) || 3) * 1000 * (0.5 + Math.random())));
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
  async function keeperGet(path) {
    const r = await keeperFetch(path);
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
    const u = unspent().sort((a, b) => (BigInt(a.v) < BigInt(b.v) ? -1 : 1));
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

  // Submits from the signer after checking the call on chain. → tx hash, or null when another transaction landed
  // first (prove again).
  async function sendSelf(to, data, value, onStep) {
    if (!signer) throw new Error('no wallet to send from: connect one, or use a relayer');
    if (signer.ready) await signer.ready();
    const v = '0x' + BigInt(value).toString(16);
    // A signer may bring its own reader (`signer.rpc`), so the node that reads this key's notes and boxes is not also
    // shown the signer's address and its transactions.
    try { await (signer.rpc || chain.rpc)('eth_call', [{ from: signer.address, to, data, value: v }, 'latest']); }
    catch (e) {
      const d = revertData(e);
      if (RACED.has(d.slice(0, 10))) return null;
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
  // its own slot. → { id, tree }, 'stale' (a spend is queued already: wait), 'tail' (the keeper has paused this
  // connection's reservations: prove against the queue's tail and send without one), or null (prove without a slot).
  async function reserveSlot(sealed, ins) {
    const leaf = (k) => String(sealed[k] ? sealed[k].leaf : 0n);
    let r;
    try {
      const res = await keeperPost('/reserve', { outLeaf0: leaf(0), outLeaf1: leaf(1), nfs: ins.map((n) => n.nf) });
      if (res.status === 409) return 'stale';
      if (res.status === 403) return 'tail';
      if (res.status !== 200) return null;
      r = res.body;
    } catch { return null; }
    for (let i = 0; i < 3; i++) {
      let t = state().tree;
      if (BigInt(r.root) !== t.root) { await sync(); t = state().tree; }
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
    for (let i = 0; i < 90; i++) {
      const r = await read('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (!r) { await sleep(2000); continue; }
      if (!(r.status === '0x1' || r.status === 1 || r.status === 'success')) return false;
      return !nfs.length || (r.logs || []).some((l) => String(l.address).toLowerCase() === String(chain.pool).toLowerCase()
        && String(l.topics?.[0]).toLowerCase() === TRANSACT_TOPIC && nfs.every((nf) => [l.topics[1], l.topics[2]].some((t) => t != null && BigInt(t) === BigInt(nf))));
    }
    return true;
  }

  // One transaction: spends `ins`, creates `outs` ([{ to, value } | null] × 2) and moves `extAmount` across the pool
  // boundary (> 0 in from the signer, < 0 out to `recipient`). With a relayer's quote `q` the relayer submits it
  // for q.fee, proven to follow what the relayer has queued; without, the signer does and pays the gas. Waits for
  // it to be mined and proves again when another transaction lands first. → tx hash.
  // selfCall(tx) → { to, data }: what the signer submits, when not pool.transact (withdrawToV1).
  async function transact({ ins, outs, extAmount = 0n, recipient = ZERO, q = null, extra = {}, selfCall = null, onStep = () => {} }) {
    // A spend's outputs take one-time keys the sender can derive again (paymentKey); a deposit's are random.
    const attempt = ins.length ? nextAttempt(ins[0].nf) : 0;
    const eOf = (k) => (ins.length ? paymentKey(keys, { chainId: chain.chainId, nf: BigInt(ins[0].nf), k, attempt }) : undefined);
    const sealed = outs.map((o, k) => (o ? sealNote(zk, { to: o.to, value: o.value, asset, e: eOf(k) }) : null));
    const memo0 = sealed[0]?.memo ?? new Uint8Array(), memo1 = sealed[1]?.memo ?? new Uint8Array();
    const fee = q ? BigInt(q.fee) : 0n, relayer = q ? q.relayer : ZERO;
    const inputs = [...ins.map(asInput), ...Array(2 - ins.length).fill({ dummy: true })];
    const inserts = sealed.some(Boolean);
    const simulated = !!(extra.call || extra.wrap);
    for (let round = 0; round < 8; round++) {
      if (round) { onStep('someone else got in first, proving again'); await jitter(round); await sync(); }
      let tree = state().tree, slot = null;
      if (q && inserts && !simulated) {
        const r = await reserveSlot(sealed, ins);
        if (r === 'stale') continue;
        if (r === 'tail') tree = (await queueTail(false)) || tree;
        else if (r) { slot = r.id; tree = r.tree; }
      } else if (q && inserts) tree = (await queueTail(true)) || tree;
      const eh = extDataHash({ chainId: BigInt(chain.chainId), pool: chain.pool, recipient, extAmount, relayer, fee, memo0, memo1 });
      const w = zk.buildWitness({ asset, tree, inputs, outputs: sealed.map((o) => (o ? { v: o.v, npk: o.npk, rho: o.rho } : null)), extAmount, fee, extDataHash: eh });
      onStep('proving on this device');
      let proved;
      try { proved = await prove(w.input); } catch (e) { if (slot) await releaseSlot(slot); throw e; }
      const { proof, publicSignals } = proved;
      const tx = toTx(proof, publicSignals, { recipient, extAmount: extAmount.toString(), relayer, fee: fee.toString(), memo0: hex(memo0), memo1: hex(memo1) });
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
        if (((r.status >= 502 && r.status <= 504) || (r.status >= 520 && r.status <= 524)) && !r.body?.error) throw unanswered();
        if (r.status === 409 && r.body.stale) continue;
        if (r.status === 429) { if (slot) await releaseSlot(slot); await sleep(5000); continue; }
        if (r.status !== 200 || !r.body.txHash) { if (slot) await releaseSlot(slot); throw new Error(r.body.error || `relayer returned ${r.status}`); }
        h = r.body.txHash;
      } else {
        const c = selfCall ? selfCall(tx) : { to: chain.pool, data: transactData(tx) };
        h = await sendSelf(c.to, c.data, extAmount > 0n ? extAmount : 0n, onStep);
        if (!h) continue;
      }
      for (const n of ins) pending.add(n.nf);
      onStep('waiting for it to be mined');
      if (await landed(h, ins.map((n) => n.nf), q ? chain.rpc : signer?.rpc || chain.rpc)) {
        // Returns once this wallet sees it (spent notes gone, change in), so the next action can build on it.
        const spent = new Set(ins.map((n) => n.nf));
        const seen = await waitFor(() => !state().notes.some((n) => spent.has(n.nf)), 60_000).then(() => true, () => false);
        // Not seen landing (no receipt in time, or dropped or replaced): its notes come back if the chain still has
        // them unspent a while later. A late landing then only makes a spend of them fail and read the chain again.
        if (!seen) setTimeout(() => { sync().then(() => { if (state().notes.some((n) => spent.has(n.nf))) for (const nf of spent) pending.delete(nf); }).catch(() => {}); }, 15 * 60_000).unref?.();
        return h;
      }
      for (const n of ins) pending.delete(n.nf);
    }
    // No round landed: rebuild the state from the chain, so a note a feed wrongly showed as unspent is dropped.
    await rescanFromChain().catch(() => {});
    throw new Error('the pool kept moving; try again');
  }

  // Forgets the synced state and rebuilds it from chain logs alone (no feed).
  async function rescanFromChain() {
    await reading.catch(() => {});
    const keep = { attempts: saved.attempts, nextRefund: saved.nextRefund };
    saved = { ...blank(), ...keep }; view = null; persist();
    const f = feed; feed = false;
    try { return await sync(); } finally { feed = f; }
  }

  // A quote above `maxFee`, the most the caller showed for it, is refused so the spend never costs more than shown.
  function withinFee(q, maxFee) {
    if (maxFee == null || BigInt(q.fee) <= BigInt(maxFee)) return q;
    throw Object.assign(new Error('The relay fee went up since it was shown. Check the new fee and try again.'), { feeMoved: BigInt(q.fee) });
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
  // before the first merge when no run of them would, so no fee is paid for a spend that cannot happen.
  async function prepare(need, q, onStep) {
    const fee = q ? BigInt(q.fee) : 0n;
    if (mergePlan(unspent().map((n) => n.v), need, fee) == null) throw new Error('not enough in the pool for this amount and its fee');
    for (let guard = 0; guard < 8; guard++) {
      const pick = select(need);
      if (pick) return pick;
      const u = unspent().sort((a, b) => (BigInt(b.v) < BigInt(a.v) ? -1 : 1));
      if (u.length < 2) break;
      const total = BigInt(u[0].v) + BigInt(u[1].v);
      if (total <= fee) break;
      onStep('combining notes first');
      await transact({ ins: [u[0], u[1]], outs: [{ to: keys, value: total - fee }, null], q, onStep });
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
    const u = unspent().map((n) => BigInt(n.v)).sort((a, b) => (b < a ? -1 : 1)), total = (u[0] ?? 0n) + (u[1] ?? 0n);
    if (total <= fee) throw new Error('not enough in the pool for this amount and its fee');
    return total - fee;
  };
  const NODE_INTERFACE = '0x00000000000000000000000000000000000000C8';
  const hasCode = async (rpc, a) => { const c = await rpc('eth_getCode', [a, 'latest']); return !!c && c !== '0x'; };

  const api = {
    address: keys.address,
    receiveBox: box,
    asset,
    sync,
    summary,
    notes: () => unspent(),
    // Sets the user's own wallet for self-submitted actions ({ address, send }, as the signer option).
    connect(s) { signer = s; },
    // Forgets the synced state and rebuilds it from chain logs alone (no feed).
    rescan: () => rescanFromChain(),
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
    async withdraw({ to, amount, via = null, maxFee = null, onStep = () => {} }) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(to)) || BigInt(to) === 0n) throw new Error('enter a 0x address');
      if (amount !== 'max' && BigInt(amount) <= 0n) throw new Error('enter an amount');
      await sync();
      const q = await quoteFor(via, null, maxFee);
      const fee = q ? BigInt(q.fee) : 0n, a = amount === 'max' ? maxOf(fee) : BigInt(amount);
      const ins = await prepare(a + fee, q, onStep);
      const change = ins.reduce((s, n) => s + BigInt(n.v), 0n) - a - fee;
      return transact({ ins, outs: [change > 0n ? { to: self, value: change } : null, null], extAmount: -a, recipient: to, q, onStep });
    },

    // Watches receive boxes through `index`, e.g. a payment-request box a payment reached on another chain, so a payment
    // to it here is found too. → true when `index` lay past what was watched: earlier events for it were never read,
    // so the synced state should be rebuilt (rescan, or a fresh wallet) to find them.
    watchThrough(index) {
      const unread = index >= saved.nextRefund + REFUND_GAP;
      if (index >= saved.nextRefund) { saved.nextRefund = index + 1; persist(); }
      return unread;
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

    // Withdraws `amount` wei into `intent`'s escrow (gateway callIntent) and has the relayer run it in the same
    // transaction (router.withdrawAndCall). → tx hash.
    // gas: what the withdrawal and its calls need; by default the relay's plus 250k per call.
    async withdrawAndCall({ intent, amount, gas = null, maxFee = null, onStep = () => {} }) {
      const a = BigInt(amount);
      if (a <= 0n) throw new Error('enter an amount');
      await sync();
      const q = withinFee(await keeperGet(`/quote?gas=${gas ?? 450_000 + 250_000 * (intent.calls?.length ?? 1)}`), maxFee);
      const fee = BigInt(q.fee);
      const ins = await prepare(a + fee, q, onStep);
      const change = ins.reduce((s, n) => s + BigInt(n.v), 0n) - a - fee;
      return transact({
        ins, outs: [change > 0n ? { to: self, value: change } : null, null], extAmount: -a, recipient: callEscrowAddress(intent, chain.router),
        q, extra: { call: callIntentJson(intent) }, onStep,
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
    async deposit({ amount, onStep = () => {} }) {
      const a = BigInt(amount);
      if (a <= 0n) throw new Error('enter an amount');
      const before = (await sync()).balance;
      const h = await transact({ ins: [], outs: [{ to: self, value: a }, null], extAmount: a, onStep });
      // Returns once the note is spendable here (log providers can trail the receipt by a few seconds).
      await waitFor(() => summary().balance >= before + a, 60_000).catch(() => {});
      return h;
    },

    // Deposits `amount` wei from the signer straight into a private note for someone else's pool address (bp1…),
    // proved here and sent by the signer: the deposit (its sender and amount) shows on chain, whom it pays does not;
    // the recipient finds it by its memo. → tx hash.
    async depositTo({ to, amount, onStep = () => {} }) {
      const recipient = recipientOf(keys, to);
      const a = BigInt(amount);
      if (a <= 0n) throw new Error('enter an amount');
      await sync();
      return transact({ ins: [], outs: [{ to: recipient, value: a }, null], extAmount: a, onStep });
    },

    // Sweeps a receive box (the private ETH address by default) into a note here, submitted by the signer: no fee,
    // any amount. → tx hash.
    async sweep({ index = RECEIVE_INDEX, onStep = () => {} } = {}) {
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
        if (h) return h;
        onStep('someone else got in first, proving again');
      }
      throw new Error('the pool kept moving; try again');
    },

    // Moves `amount` wei from this Ethereum pool to the same wallet's private ETH address on an L2 (8453 Base, 4663
    // Robinhood Chain) in one relayed withdraw-and-call through the L2's canonical bridge; that chain's keeper then
    // sweeps it into a note there (watchReceive on the L2 wallet). Arrives in minutes. The amount and the address
    // are public on Ethereum; which note paid is not. l2Rpc (a jsonRpc on the L2) is needed for Robinhood Chain,
    // whose retryable is priced from the L2. `now`: the chain's time in unix seconds, which its hour-long deadline
    // counts from (this device's clock by default). → tx hash.
    async bridgeOut({ toChainId, amount, l2Rpc = null, maxFee = null, now = null, onStep = () => {} }) {
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
      const intent = callIntent({ calls: [c], refund, deadline: BigInt((now ?? Math.floor(Date.now() / 1000)) + 3600), nonce });
      // The OP portal burns L1 gas to buy the deposit's L2 gas (~620k in all); a retryable costs ~100k.
      return api.withdrawAndCall({ intent, amount: value, gas: b.kind === 'op' ? 1_300_000 : 700_000, maxFee, onStep });
    },

    // Moves `amount` wei (a multiple of 1e10) from this Ethereum pool into a V1 tETH note with commitment `commit`,
    // in one transaction (router.withdrawToV1): relayed by default, or from the signer with via: 'self'. `commit` is
    // V1's wrap commitment for the wallet's own next V1 note (confidential-pool-ux buildWrap(...).commit); the V1
    // wallet finds the deposit from its key and makes it a note with its usual wrap settle. `now` as for bridgeOut. → tx hash.
    async toV1({ amount, commit, via = null, maxFee = null, now = null, onStep = () => {} }) {
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
        deadline: BigInt((now ?? Math.floor(Date.now() / 1000)) + 3600), nonce: BigInt(hex(globalThis.crypto.getRandomValues(new Uint8Array(16)))),
      };
      const box = '0x' + String(await chain.rpc('eth_call', [{ to: chain.router, data: calldata(`wrapBoxOf(${WRAP_SIG})`, [{ tuple: WRAP_TYPES }], [wrapValues(intent)]) }, 'latest'])).slice(-40);
      const ins = await prepare(a + fee, q, onStep);
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
