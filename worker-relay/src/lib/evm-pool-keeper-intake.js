// HTTP side of the EVM pool keeper:
//   POST /evm-pool/keeper/deposit  a deposit intent + hint (re-derived through the gateway, so a hint that does not
//                                  produce the intent's leaves and memo hashes is refused)
//   POST /evm-pool/keeper/wrap     a wrap intent
//   POST /evm-pool/keeper/receive  { chainId, npk, feeBps }: a receive box to watch and sweep
//   GET  /evm-pool/keeper/quote    the relayer address and fee to prove a relayed transaction with
//   POST /evm-pool/keeper/reserve  { outLeaf0, outLeaf1, nfs }: a slot in the queue for a transfer or withdrawal about
//                                  to be proven: the root and index to prove from, and the leaves queued ahead;
//                                  then /relay { tx, reservation: id } within its time, or /cancel { reservation }
//   GET  /evm-pool/keeper/head     { root, size, pending, tail }: the pool's head and the insertions queued after it;
//                                  an unreserved relay proven against `tail` takes the next slot
//   GET  /evm-pool/keeper/events?from=<block>   confirmed pool Transact and router Received events, whole blocks
//                                  from..through; a wallet checks what it builds from them against the pool
//   POST /evm-pool/keeper/relay    { tx, call?, wrap? }: submit a user's own proven withdrawal or transfer that pays
//                                  this keeper, straight to the pool, or with a call intent (withdrawAndCall) or a
//                                  wrap intent (withdrawToV1) through the router
// Request bodies are capped before parsing. Hints are never echoed back or logged.

import { getAddress, isAddress } from 'viem';
import { depositIntent, callIntent, callEscrowAddress } from '../../../dapp/evm-pool-gateway.js';
import { P_FR } from '../../../dapp/btc-pool-zk.js';
import { ETH } from './evm-pool-keeper-config.js';
import { coverCheck, quoteFee } from './evm-pool-keeper-loop.js';
import { PipelineError } from './evm-pool-keeper-pipeline.js';
import { revertName as defaultRevertName } from './evm-pool-keeper-chain.js';
import { safeErr } from './safe-err.js';

const VMAX = 1n << 120n;
const U256 = 1n << 256n;
const ZERO32 = '0x' + '0'.repeat(64);
const PREFIX = '/evm-pool/keeper';

export class IntakeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new IntakeError(400, m);

function uint(x, name, max = U256) {
  let v;
  if (typeof x === 'number' && Number.isSafeInteger(x)) v = BigInt(x);
  else if (typeof x === 'string' && /^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(x)) v = BigInt(x);
  else throw bad(`${name} must be an integer (decimal string or 0x hex)`);
  if (v < 0n || v >= max) throw bad(`${name} out of range`);
  return v;
}
function addr(x, name) {
  if (typeof x !== 'string' || !isAddress(x)) throw bad(`${name} must be an address`);
  if (x.toLowerCase() === ETH) throw bad(`${name} must not be the zero address`);
  return getAddress(x);
}
function b32(x, name) {
  if (typeof x !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(x)) throw bad(`${name} must be 32 bytes of hex`);
  return x.toLowerCase();
}
function memo(x, name, maxBytes) {
  if (x === undefined || x === null || x === '' || x === '0x') return '0x';
  if (typeof x !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(x)) throw bad(`${name} must be 0x hex`);
  if ((x.length - 2) / 2 > maxBytes) throw bad(`${name} is longer than ${maxBytes} bytes`);
  return x.toLowerCase();
}
function deadline(x, now, cfg) {
  const d = uint(x, 'deadline', 1n << 64n);
  if (d < BigInt(now + cfg.minDeadlineSecs)) throw bad(`deadline must be at least ${cfg.minDeadlineSecs}s away`);
  if (d > BigInt(now + cfg.maxDeadlineSecs)) throw bad(`deadline must be within ${cfg.maxDeadlineSecs}s`);
  return d;
}
const obj = (x, name) => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad(`${name} must be an object`);
  return x;
};
const hex = (b) => '0x' + Buffer.from(b).toString('hex');

// → { intent, hint, reward }. `asset` is the pool's asset field.
export function parseDepositSubmission(body, { zk, asset, now, cfg }) {
  const i = obj(obj(body, 'body').intent, 'intent');
  const h = obj(body.hint, 'hint');
  const amount = uint(i.amount, 'amount', VMAX);
  if (amount === 0n) throw bad('amount must be positive');
  if (!Array.isArray(h.outputs) || h.outputs.length > 2) throw bad('hint.outputs must be an array of at most two');
  const outputs = h.outputs.map((o, k) => {
    if (o === null) return null;
    obj(o, `hint.outputs[${k}]`);
    return { v: uint(o.v, `outputs[${k}].v`, VMAX), npk: uint(o.npk, `outputs[${k}].npk`, P_FR), rho: uint(o.rho, `outputs[${k}].rho`, P_FR) };
  });
  const m0 = memo(h.memo0, 'hint.memo0', cfg.maxMemoBytes);
  const m1 = memo(h.memo1, 'hint.memo1', cfg.maxMemoBytes);
  let derived;
  try {
    derived = depositIntent(zk, {
      asset, amount, outputs, memo0: m0, memo1: m1,
      refund: addr(i.refund, 'refund'), deadline: deadline(i.deadline, now, cfg), nonce: uint(i.nonce ?? '0', 'nonce'),
    });
  } catch (e) {
    if (e instanceof IntakeError) throw e;
    throw bad(String(e.message || e).replace(/^evm-pool-gateway: /, ''));
  }
  const d = derived.intent;
  if (uint(i.outLeaf0, 'outLeaf0') !== d.outLeaf0 || uint(i.outLeaf1, 'outLeaf1') !== d.outLeaf1) throw bad('the hint does not produce the intent\'s leaves');
  if (b32(i.memo0Hash, 'memo0Hash') !== d.memo0Hash || b32(i.memo1Hash, 'memo1Hash') !== d.memo1Hash) throw bad('the hint\'s memos do not match the intent\'s memo hashes');
  const hint = { outputs: derived.hint.outputs, fee: derived.hint.fee, memo0: hex(derived.hint.memo0), memo1: hex(derived.hint.memo1) };
  return { intent: d, hint, reward: hint.fee };
}

export function parseWrapSubmission(body, { now, cfg }) {
  const i = obj(obj(body, 'body').intent, 'intent');
  const intent = {
    assetId: b32(i.assetId, 'assetId'),
    amount: uint(i.amount, 'amount'),
    tip: uint(i.tip ?? '0', 'tip'),
    tipTo: i.tipTo === undefined || i.tipTo === null || String(i.tipTo).toLowerCase() === ETH ? getAddress(ETH) : addr(i.tipTo, 'tipTo'),
    commit: b32(i.commit, 'commit'),
    refund: addr(i.refund, 'refund'),
    deadline: deadline(i.deadline, now, cfg),
    nonce: uint(i.nonce ?? '0', 'nonce'),
  };
  if (intent.amount === 0n) throw bad('amount must be positive');
  if (intent.amount + intent.tip >= U256) throw bad('amount + tip overflows');
  if (intent.commit === ZERO32) throw bad('commit must be non-zero');
  const paysKeeper = intent.tipTo.toLowerCase() === ETH || intent.tipTo.toLowerCase() === String(cfg.keeperAddress || '').toLowerCase();
  return { intent, reward: paysKeeper ? intent.tip : 0n };
}

export function parseReceiveSubmission(body, { chainId, cfg }) {
  const b = obj(body, 'body');
  if (uint(b.chainId, 'chainId', 1n << 64n) !== BigInt(chainId)) throw bad(`this keeper serves chain ${chainId}`);
  const npk = uint(b.npk, 'npk', P_FR);
  if (npk === 0n) throw bad('npk must be non-zero');
  const feeBps = Number(uint(b.feeBps, 'feeBps', 10_001n));
  if (feeBps < cfg.minReceiveFeeBps) throw bad(`this keeper sweeps boxes with feeBps ≥ ${cfg.minReceiveFeeBps}; sweep a lower-fee box directly`);
  return { intent: { npk, feeBps } };
}

const SNARK_Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
function int(x, name) {
  if (typeof x === 'number' && Number.isSafeInteger(x)) return BigInt(x);
  if (typeof x === 'string' && /^-?\d{1,78}$/.test(x)) return BigInt(x);
  throw bad(`${name} must be an integer`);
}
const coords = (x, len, name) => {
  if (!Array.isArray(x) || x.length !== len) throw bad(`${name} must have ${len} entries`);
  return x;
};

const MAX_CALLS = 8;
// A call intent (router §7) from JSON, normalized through the gateway. `now` bounds the deadline.
export function parseCallIntent(j, { now, cfg }) {
  const c = obj(j, 'call');
  if (!Array.isArray(c.calls) || c.calls.length === 0 || c.calls.length > MAX_CALLS) throw bad(`call.calls must hold 1 to ${MAX_CALLS} calls`);
  const outTokens = Array.isArray(c.outTokens) ? c.outTokens : [];
  const minOuts = Array.isArray(c.minOuts) ? c.minOuts : [];
  if (outTokens.length !== minOuts.length || outTokens.length > MAX_CALLS) throw bad('call.outTokens and call.minOuts must match in length');
  const anyAddr = (x, name) => { if (typeof x !== 'string' || !isAddress(x)) throw bad(`${name} must be an address`); return getAddress(x); };
  const d = uint(c.deadline, 'call.deadline', 1n << 64n);
  if (d <= BigInt(now)) throw bad('call.deadline has passed');
  try {
    return callIntent({
      calls: c.calls.map((k, i) => {
        obj(k, `call.calls[${i}]`);
        return {
          target: anyAddr(k.target, `call.calls[${i}].target`), value: uint(k.value ?? '0', `call.calls[${i}].value`),
          token: k.token == null ? ETH : anyAddr(k.token, `call.calls[${i}].token`), amount: uint(k.amount ?? '0', `call.calls[${i}].amount`),
          push: k.push === true, data: memo(k.data, `call.calls[${i}].data`, cfg.maxBody),
        };
      }),
      outputs: outTokens.map((t, i) => ({ token: anyAddr(t, `call.outTokens[${i}]`), min: uint(minOuts[i], `call.minOuts[${i}]`) })),
      to: c.to == null ? ETH : anyAddr(c.to, 'call.to'),
      refund: addr(c.refund, 'call.refund'),
      deadline: d,
      nonce: uint(c.nonce ?? '0', 'call.nonce'),
    });
  } catch (e) {
    if (e instanceof IntakeError) throw e;
    throw bad(String(e.message || e).replace(/^evm-pool-gateway: /, ''));
  }
}

// A user's proven pool transaction for relaying: it must pay this keeper (relayer) and must not be a deposit,
// which would draw on the sender's own funds. → the pool.transact arguments and the fee, and what to send:
//   { tx }                pool.transact
//   { tx, call }          router.withdrawAndCall(tx, call): tx.recipient must be the call intent's escrow
//   { tx, wrap }          router.withdrawToV1(tx, wrap): tx.recipient must be the wrap box (checked on chain)
export function parseRelaySubmission(body, { keeper, cfg, router = null, now = Math.floor(Date.now() / 1000) }) {
  const parsed = parseRelayTx(body, { keeper, cfg });
  const [pA, pB, pC, publicInputs, recipient, extAmount, relayer, fee, memo0, memo1] = parsed.args;
  const t = { pA, pB, pC, publicInputs, recipient, extAmount, relayer, fee, memo0, memo1 };
  if (body.call != null && body.wrap != null) throw bad('send either call or wrap, not both');
  if (body.call != null) {
    if (!router) throw bad('this keeper does not relay calls');
    if (extAmount >= 0n) throw bad('a call needs a withdrawal');
    const intent = parseCallIntent(body.call, { now, cfg });
    if (callEscrowAddress(intent, router).toLowerCase() !== recipient.toLowerCase()) throw bad('tx.recipient is not the call intent\'s escrow');
    return { ...parsed, functionName: 'withdrawAndCall', sendArgs: [t, intent], call: intent };
  }
  if (body.wrap != null) {
    if (!router) throw bad('this keeper does not relay wraps');
    if (extAmount >= 0n) throw bad('a wrap needs a withdrawal');
    const { intent } = parseWrapSubmission({ intent: body.wrap }, { now, cfg: { ...cfg, minDeadlineSecs: 0 } });
    return { ...parsed, functionName: 'withdrawToV1', sendArgs: [t, intent], wrap: intent };
  }
  return { ...parsed, functionName: 'pool.transact', sendArgs: parsed.args };
}

function parseRelayTx(body, { keeper, cfg }) {
  const t = obj(obj(body, 'body').tx, 'tx');
  const pA = coords(t.pA, 2, 'pA').map((v, i) => uint(v, `pA[${i}]`, SNARK_Q));
  const pB = coords(t.pB, 2, 'pB').map((row, i) => coords(row, 2, `pB[${i}]`).map((v, j) => uint(v, `pB[${i}][${j}]`, SNARK_Q)));
  const pC = coords(t.pC, 2, 'pC').map((v, i) => uint(v, `pC[${i}]`, SNARK_Q));
  const publicInputs = coords(t.publicInputs, 11, 'publicInputs').map((v, i) => uint(v, `publicInputs[${i}]`, P_FR));
  const extAmount = int(t.extAmount, 'extAmount');
  if (extAmount > 0n) throw bad('deposits are not relayed: a deposit is paid by whoever sends it');
  if (extAmount <= -VMAX) throw bad('extAmount out of range');
  const recipient = extAmount < 0n ? addr(t.recipient, 'recipient') : (t.recipient == null || String(t.recipient).toLowerCase() === ETH ? getAddress(ETH) : addr(t.recipient, 'recipient'));
  if (typeof t.relayer !== 'string' || !isAddress(t.relayer) || t.relayer.toLowerCase() !== String(keeper).toLowerCase()) throw bad(`relayer must be this keeper, ${keeper}`);
  const fee = uint(t.fee, 'fee', VMAX);
  const memo0 = memo(t.memo0, 'memo0', cfg.maxMemoBytes);
  const memo1 = memo(t.memo1, 'memo1', cfg.maxMemoBytes);
  return { args: [pA, pB, pC, publicInputs, recipient, extAmount, getAddress(keeper), fee, memo0, memo1], fee };
}

// Stored JSON (decimal strings) → contract arguments.
export function depositIntentArgs(j) {
  return {
    amount: BigInt(j.amount), outLeaf0: BigInt(j.outLeaf0), outLeaf1: BigInt(j.outLeaf1),
    memo0Hash: j.memo0Hash, memo1Hash: j.memo1Hash, refund: getAddress(j.refund), deadline: BigInt(j.deadline), nonce: BigInt(j.nonce),
  };
}
export function wrapIntentArgs(j) {
  return {
    assetId: j.assetId, amount: BigInt(j.amount), tip: BigInt(j.tip), tipTo: getAddress(j.tipTo ?? ETH), commit: j.commit,
    refund: getAddress(j.refund), deadline: BigInt(j.deadline), nonce: BigInt(j.nonce),
  };
}
export function hintArgs(j) {
  const unhex = (m) => Uint8Array.from(Buffer.from(String(m).replace(/^0x/, ''), 'hex'));
  return {
    outputs: j.outputs.map((o) => (o ? { v: BigInt(o.v), npk: BigInt(o.npk), rho: BigInt(o.rho) } : null)),
    fee: BigInt(j.fee), memo0: unhex(j.memo0), memo1: unhex(j.memo1),
  };
}

export function makeRateLimiter({ perMin = 20, burst = 10, maxClients = 10_000, now = () => Date.now() } = {}) {
  const buckets = new Map();
  const fill = (b, t) => { b.tokens = Math.min(burst, b.tokens + ((t - b.at) * perMin) / 60_000); b.at = t; };
  return (key) => {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxClients) for (const [k, v] of buckets) { fill(v, t); if (v.tokens >= burst) buckets.delete(k); }
      if (buckets.size >= maxClients) return false;
      b = { tokens: burst, at: t };
      buckets.set(key, b);
    }
    fill(b, t);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

// An IPv6 client is keyed by its /64, which one subscriber holds in full and could otherwise rotate through.
export function ipKey(addr) {
  const a = String(addr).trim().toLowerCase();
  if (!a.includes(':') || /^(::ffff:)?\d+\.\d+\.\d+\.\d+$/.test(a)) return a;
  const [h, t = ''] = a.split('::'), head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const full = a.includes('::') ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  return `${full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

function clientKey(req) {
  const f = req.headers?.['x-forwarded-for'];
  // The right-most hop is the one the fronting proxy appended; earlier hops are client-supplied.
  if (f) { const k = String(f).split(',').pop().trim(); if (k) return ipKey(k); }
  return ipKey(req.socket?.remoteAddress || 'unknown');
}

function readJson(req, max) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) {
    req.resume();
    return Promise.reject(new IntakeError(413, 'body too large'));
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); });
    req.on('end', () => {
      if (size > max) return reject(new IntakeError(413, 'body too large'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('body is not JSON')); }
    });
    req.on('error', reject);
  });
}

// chain: { address, chainId, pool, router, asset, v1, depositBoxOf(intent), wrapBoxOf(intent), wrapToken(assetId) }
// Events per /events page: whole blocks, so a page can run over when one block holds more.
const EVENTS_PAGE = 5000;

export function createIntakeHandler({
  store, chain, zk, assetField, cfg, now = () => Math.floor(Date.now() / 1000), log = () => {}, isReady = () => true,
  revertName = defaultRevertName, leafSync = null, pipeline = null,
}) {
  const limited = makeRateLimiter({ perMin: cfg.ratePerMin, burst: Math.max(1, Math.min(10, cfg.ratePerMin)) });
  // Reads a wallet makes around every spend (head, quote, events) have their own, larger allowance.
  const readLimited = makeRateLimiter({ perMin: cfg.ratePerMin * 6, burst: Math.max(1, Math.min(30, cfg.ratePerMin * 3)) });
  // /head is cached for a second, and until the queue changes, so many wallets polling it cost a few reads.
  let headCache = null;
  async function headNow() {
    const size = pipeline ? pipeline.size() : 0;
    if (headCache && Date.now() - headCache.at < 1000 && headCache.size === size) return headCache.value;
    let value;
    if (pipeline) value = await pipeline.head();
    else {
      const { root, nextIndex } = await chain.poolState();
      const h = { root: BigInt(root).toString(), size: BigInt(nextIndex).toString() };
      value = { ...h, pending: [], tail: h };
    }
    headCache = { at: Date.now(), size, value };
    return value;
  }
  const view = (r) => (r.kind === 'receive'
    ? { box: r.box, kind: r.kind, status: r.status === 'pending' ? 'watching' : r.status, ...(r.note ? { note: r.note } : {}) }
    : { box: r.box, kind: r.kind, status: r.status, reward: r.reward, ...(r.tx_hash ? { txHash: r.tx_hash } : {}) });
  const STALE = new Set(['StaleRoot', 'WrongInsertionIndex']);

  async function accept(kind, body) {
    const t = now();
    let parsed, box, token;
    if (kind === 'receive') {
      parsed = parseReceiveSubmission(body, { chainId: chain.chainId, cfg });
      box = await chain.receiveBoxOf(parsed.intent.npk, parsed.intent.feeBps);
      const watchUntil = t + cfg.receiveWatchSecs;
      const known = store.get(box);
      if (known) {
        // Registering again renews the watch and asks for a look now.
        if (known.kind !== kind) throw bad('box already registered under another kind');
        store.update(box, { status: 'pending', next_check: t, checks: 0, deadline: watchUntil, updated: t });
        return view(store.get(box));
      }
      if (store.receiveCount() >= cfg.maxReceive && !store.evictLapsedReceive(t)) throw new IntakeError(503, 'the keeper is at capacity; try again later');
      store.addIntent({ box, kind, intent: parsed.intent, reward: 0n, token: chain.asset, deadline: watchUntil, now: t });
      log(`watching receive box ${box} (fee cap ${parsed.intent.feeBps} bps)`);
      return view(store.get(box));
    }
    if (store.pendingCount() >= cfg.maxPending && !store.evictUnfundedPending()) throw new IntakeError(503, 'the keeper is at capacity; try again later');
    if (kind === 'deposit') {
      parsed = parseDepositSubmission(body, { zk, asset: assetField, now: t, cfg });
      box = await chain.depositBoxOf(parsed.intent);
      token = chain.asset;
    } else {
      if (!chain.v1 || chain.v1.toLowerCase() === ETH) throw bad('this router has no wrap target');
      parsed = parseWrapSubmission(body, { now: t, cfg });
      const w = await chain.wrapToken(parsed.intent.assetId);
      if (!w.registered) throw bad('assetId is not registered on the wrap target');
      box = await chain.wrapBoxOf(parsed.intent);
      token = w.token;
    }
    const fresh = store.addIntent({ box, kind, intent: parsed.intent, hint: parsed.hint ?? null, reward: parsed.reward, token, deadline: parsed.intent.deadline, now: t });
    const r = store.get(box);
    if (r.kind !== kind) throw bad('box already registered under another kind');
    if (fresh) log(`accepted ${kind} box ${box} reward ${parsed.reward}`);
    return view(r);
  }

  let gasCache = { at: 0, price: 0n };
  const gasPrice = async () => {
    const t = Date.now();
    if (t - gasCache.at > 5000) gasCache = { at: t, price: BigInt(await chain.gasPrice()) };
    return gasCache.price;
  };
  // Nullifiers (and, for a transaction that inserts, its insertion slot) of relays sent and not yet settled: a
  // second submission of the same spend is refused instead of being sent to revert.
  const inflight = new Map();
  const relayKeys = (args) => {
    const pub = args[3];
    const keys = [pub[7], pub[8]].filter((x) => x !== 0n).map((x) => `nf:${x}`);
    if (pub[9] !== 0n || pub[10] !== 0n) keys.push(`slot:${pub[1]}:${pub[3]}`);
    return keys;
  };
  const busyKeys = (keys, t) => keys.some((k) => (inflight.get(k) ?? 0) > t);

  // A keeper that cannot front a send says so up front, so a wallet sends it itself instead of proving for a relay
  // that would fail. Its own fees refill it once it is running.
  async function mustFront(gas) {
    const room = chain.canFront ? await chain.canFront(gas) : { ok: true };
    if (!room.ok) throw new IntakeError(503, "the relay is busy with other sends; try again in a minute. Sending it from your own wallet also works, and shows your address as the sender");
  }

  // The fee for `gas` (default relayGas; a withdrawal that also runs calls asks for more), within the gas cap.
  async function quote(gasParam) {
    let gas = cfg.relayGas;
    if (gasParam != null) {
      if (!/^\d{1,9}$/.test(gasParam)) throw bad('gas must be a whole number');
      gas = BigInt(gasParam);
      if (gas < cfg.relayGas) gas = cfg.relayGas;
      if (gas > cfg.gasCap) throw bad(`gas above the ${cfg.gasCap} cap`);
    }
    const price = await gasPrice();
    await mustFront((gas * 13n) / 10n);
    const q = quoteFee({ token: chain.asset, gas, gasPrice: price, cfg });
    // What collecting a receive box costs now, and the smallest balance whose 0.25% cap pays for it.
    const sweep = quoteFee({ token: chain.asset, gas: cfg.sweepGas, gasPrice: price, cfg, floor: !cfg.rates.has(chain.asset.toLowerCase()) });
    return {
      chainId: chain.chainId, pool: chain.pool, relayer: chain.address, asset: chain.asset, fee: q.toString(), gas: gas.toString(),
      sweepFee: sweep.toString(), receiveMin: ((sweep * 10_000n + 24n) / 25n).toString(),
    };
  }

  const asIntake = (e) => (e instanceof PipelineError ? Object.assign(new IntakeError(e.status, e.message), { stale: !!e.stale }) : e);
  const txOf = (args) => { const [pA, pB, pC, publicInputs, recipient, extAmount, relayer, fee, memo0, memo1] = args; return { pA, pB, pC, publicInputs, recipient, extAmount, relayer, fee, memo0, memo1 }; };

  // With a pipeline, a transaction that inserts notes joins the keeper's queue: a plain transfer or withdrawal in the
  // slot it reserved (or, unreserved, at the tail it was proven against), checked off chain; a call or wrap only
  // at the front of an empty queue, where it can be simulated. Its fee is checked before it is queued.
  async function relay(body) {
    const parsed = parseRelaySubmission(body, { keeper: chain.address, cfg, router: chain.router, now: now() });
    const { args, fee, wrap, functionName, sendArgs } = parsed;
    if (wrap) {
      if (!chain.v1 || chain.v1.toLowerCase() === ETH) throw bad('this router has no wrap target');
      if ((await chain.wrapBoxOf(wrap)).toLowerCase() !== args[4].toLowerCase()) throw bad('tx.recipient is not the wrap intent\'s box');
    }
    const inserts = args[3][9] !== 0n || args[3][10] !== 0n;
    if (!pipeline || !inserts) return relayChecked(parsed);
    const plain = functionName === 'pool.transact';
    if (!plain && await pipeline.busy()) throw new IntakeError(429, 'transactions ahead of this one are still landing; try again in a few seconds');
    let est = cfg.relayGas;
    if (!plain) {
      try { est = await chain.estimate(functionName, sendArgs); }
      catch (e) {
        const name = revertName(e);
        if (STALE.has(name)) throw Object.assign(new IntakeError(409, `${name}: re-prove against the pool's current root`), { stale: true });
        throw bad(name ? `the transaction reverts: ${name}` : 'the transaction reverts');
      }
    }
    const price = await gasPrice();
    const cov = coverCheck({ reward: fee, token: chain.asset, gas: est, gasPrice: price, cfg });
    if (!cov.ok) throw Object.assign(bad(`fee too low: ${cov.reason}`), { needFee: quoteFee({ token: chain.asset, gas: est, gasPrice: price, cfg }).toString() });
    await mustFront(cov.gas);
    if (cfg.dryRun) return { dryRun: true, gas: est.toString() };
    const send = async ({ simulate }) => {
      const hash = await chain.send(functionName, sendArgs, { gas: cov.gas, simulate });
      log(`relayed ${plain ? (args[5] < 0n ? 'withdrawal' : 'transfer') : functionName} ${hash} fee ${fee}${simulate ? '' : ' (queued)'}`);
      return hash;
    };
    const opts = { chainId: chain.chainId, pool: chain.pool, front: !plain };
    try {
      const hash = body.reservation != null
        ? await pipeline.fulfil(String(body.reservation), txOf(args), send, opts)
        : await pipeline.append(txOf(args), send, opts);
      return { txHash: hash };
    } catch (e) {
      const name = revertName(e);
      if (STALE.has(name) || name === 'AlreadyNullified') throw Object.assign(new IntakeError(409, `${name}: re-prove against the pool's current root`), { stale: true });
      if (name) throw bad(`the transaction reverts: ${name}`);
      throw asIntake(e);
    }
  }

  // A slot in the queue for a transaction about to be proven: { outLeaf0, outLeaf1, nfs }.
  async function reserve(body, owner) {
    if (!pipeline) throw new IntakeError(404, 'this keeper does not queue');
    const b = obj(body, 'body');
    const outLeaf = [uint(b.outLeaf0, 'outLeaf0', P_FR), uint(b.outLeaf1, 'outLeaf1', P_FR)];
    if (outLeaf[0] === 0n && outLeaf[1] === 0n) throw bad('nothing to insert: no slot needed');
    if (!Array.isArray(b.nfs) || b.nfs.length > 2) throw bad('nfs must list at most two nullifiers');
    const nfs = b.nfs.map((x, i) => uint(x, `nfs[${i}]`, P_FR));
    try { return { chainId: chain.chainId, pool: chain.pool, ...(await pipeline.reserve({ outLeaf, nfs, owner })) }; }
    catch (e) { throw asIntake(e); }
  }

  // queued: follows the keeper's unmined transactions, so it is sent unsimulated at the relay gas budget.
  async function relayChecked({ args, fee, functionName, sendArgs }, { queued = false } = {}) {
    const keys = relayKeys(args);
    const t0 = Date.now();
    if (busyKeys(keys, t0)) throw Object.assign(new IntakeError(409, 'this spend is already being relayed'), { stale: true });
    let est = cfg.relayGas;
    if (!queued) {
      try { est = await chain.estimate(functionName, sendArgs); }
      catch (e) {
        const name = revertName(e);
        if (STALE.has(name)) throw Object.assign(new IntakeError(409, `${name}: re-prove against the pool's current root`), { stale: true });
        throw bad(name ? `the transaction reverts: ${name}` : 'the transaction reverts');
      }
    }
    const price = await gasPrice();
    const cov = coverCheck({ reward: fee, token: chain.asset, gas: est, gasPrice: price, cfg });
    if (!cov.ok) throw Object.assign(bad(`fee too low: ${cov.reason}`), { needFee: quoteFee({ token: chain.asset, gas: est, gasPrice: price, cfg }).toString() });
    await mustFront(cov.gas);
    if (cfg.dryRun) return { dryRun: true, gas: est.toString() };
    if (busyKeys(keys, Date.now())) throw Object.assign(new IntakeError(409, 'this spend is already being relayed'), { stale: true });
    const hold = Date.now() + cfg.receiptWaitSecs * 1000;
    for (const k of keys) inflight.set(k, hold);
    let hash;
    try { hash = await chain.send(functionName, sendArgs, { gas: cov.gas, simulate: !queued }); }
    catch (e) {
      for (const k of keys) inflight.delete(k);
      const name = revertName(e);
      if (STALE.has(name) || name === 'AlreadyNullified') throw Object.assign(new IntakeError(409, `${name}: re-prove against the pool's current root`), { stale: true });
      if (name) throw bad(`the transaction reverts: ${name}`);
      throw e;
    }
    // Held until a receipt settles it; with none in time the hold simply lapses (a failed send is released above).
    chain.waitReceipt(hash, cfg.receiptWaitSecs * 1000).then((rc) => { if (rc) for (const k of keys) inflight.delete(k); }).catch(() => {});
    for (const [k, until] of inflight) if (until <= Date.now()) inflight.delete(k);
    log(`relayed ${functionName === 'pool.transact' ? (args[5] < 0n ? 'withdrawal' : 'transfer') : functionName} ${hash} fee ${fee}`);
    return { txHash: hash };
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/$/, '');
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ...(code === 429 ? { 'Retry-After': '10' } : {}) });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }
    try {
      let m;
      if (p === '/health' && req.method === 'GET') return send(isReady() ? 200 : 503, { ok: isReady() });
      if (p === `${PREFIX}/info` && req.method === 'GET') {
        return send(200, {
          chainId: chain.chainId, pool: chain.pool, router: chain.router, asset: chain.asset, keeper: chain.address,
          wraps: !!chain.v1 && chain.v1.toLowerCase() !== ETH, relay: cfg.relay, minReceiveFeeBps: cfg.minReceiveFeeBps,
        });
      }
      if (p === `${PREFIX}/events` && req.method === 'GET') {
        if (!leafSync) return send(404, { error: 'no event feed' });
        if (!readLimited(clientKey(req))) throw new IntakeError(429, 'rate limited');
        const from = url.searchParams.get('from') ?? '0';
        if (!/^\d{1,12}$/.test(from)) throw bad('from must be a block number');
        // ?facts=1 adds each event's public facts (recipient, amount, fee, sender, target, block time) so far, and the block
        // every event up to has them all (factsThrough); without it the feed keeps the shape it always had.
        const facts = url.searchParams.get('facts') === '1';
        const { events, through, factsThrough } = leafSync.eventsFrom(Number(from), EVENTS_PAGE, { facts });
        return send(200, { chainId: chain.chainId, pool: chain.pool, router: chain.router, from: Number(from), through, ...(facts ? { factsThrough } : {}), events });
      }
      if (p === `${PREFIX}/head` && req.method === 'GET') {
        if (!readLimited(clientKey(req))) throw new IntakeError(429, 'rate limited');
        return send(200, { chainId: chain.chainId, pool: chain.pool, ...(await headNow()) });
      }
      if (p === `${PREFIX}/quote` && req.method === 'GET') {
        if (!cfg.relay) return send(404, { error: 'relaying is off' });
        if (!readLimited(clientKey(req))) throw new IntakeError(429, 'rate limited');
        return send(200, await quote(url.searchParams.get('gas')));
      }
      if (p === `${PREFIX}/reserve` && req.method === 'POST') {
        if (!cfg.relay) return send(404, { error: 'relaying is off' });
        if (!limited(clientKey(req))) throw new IntakeError(429, 'rate limited');
        return send(200, await reserve(await readJson(req, cfg.maxBody), clientKey(req)));
      }
      if (p === `${PREFIX}/cancel` && req.method === 'POST') {
        if (!pipeline) return send(404, { error: 'this keeper does not queue' });
        if (!readLimited(clientKey(req))) throw new IntakeError(429, 'rate limited');
        const b = obj(await readJson(req, cfg.maxBody), 'body');
        if (typeof b.reservation !== 'string' || !/^[0-9a-f]{24}$/.test(b.reservation)) throw bad('reservation must be a reservation id');
        await pipeline.cancel(b.reservation);
        return send(200, { ok: true });
      }
      if (p === `${PREFIX}/relay` && req.method === 'POST') {
        if (!cfg.relay) return send(404, { error: 'relaying is off' });
        if (!limited(clientKey(req))) throw new IntakeError(429, 'rate limited');
        return send(200, await relay(await readJson(req, cfg.maxBody)));
      }
      if (p === `${PREFIX}/receive` && req.method === 'POST') {
        if (!limited(clientKey(req))) throw new IntakeError(429, 'rate limited');
        return send(200, await accept('receive', await readJson(req, cfg.maxBody)));
      }
      if ((p === `${PREFIX}/deposit` || p === `${PREFIX}/wrap`) && req.method === 'POST') {
        if (!limited(clientKey(req))) throw new IntakeError(429, 'rate limited');
        const body = await readJson(req, cfg.maxBody);
        return send(200, await accept(p.endsWith('/deposit') ? 'deposit' : 'wrap', body));
      }
      if ((m = p.match(/^\/evm-pool\/keeper\/status\/(0x[0-9a-fA-F]{40})$/)) && req.method === 'GET') {
        const r = store.get(m[1]);
        return r ? send(200, view(r)) : send(404, { error: 'unknown box' });
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      if (e instanceof IntakeError) {
        // A refused relay says why in the log (no address or IP), so a refusal a wallet reports can be traced.
        if (/\/relay$/.test(p) && e.status !== 429) log(`relay refused ${e.status}: ${e.message}${e.needFee ? ` (needs ${e.needFee})` : ''}`);
        return send(e.status, { error: e.message, ...(e.stale ? { stale: true } : {}), ...(e.needFee ? { needFee: e.needFee } : {}) });
      }
      log(`intake error: ${safeErr(e)}`);
      return send(500, { error: 'internal error' });
    }
  };
}
