#!/usr/bin/env node
// The Tacit chain's own traffic: two wallets (A and B) from one seed paying each other small amounts on the live chain, one action every
// 20 to 40 minutes, with its Ethereum account (A's key) shielding TAC in by a signed permit the leader sends in, and taking some out now
// and then (the leader pays exits out), so the chain lands blocks, every path a user takes is run end to end, and the notes join the set.
// It never sends an Ethereum transaction itself: no ETH is needed.
//
//   node tacit-bot/bot.mjs keygen --out <file>     a new seed written to <file> (mode 600); prints only the public addresses
//   BOT_SEED=… node tacit-bot/bot.mjs addresses    the account and the two chain wallets' lanes
//   BOT_SEED=… node tacit-bot/bot.mjs status       balances, the leader's terms and whether the bot would act (sends nothing)
//   BOT_SEED=… node tacit-bot/bot.mjs run          the loop, with GET /health on $PORT
//
// Env: BOT_SEED (32 bytes hex, required), BOT_STATE_DIR (default ./tacit-bot-state; a Render disk), RPC_URL (comma-separated, keyless
// nodes by default), PORT (health, default 8080), TACIT_BLOCKS / TACIT_LEADER (default: dapp/tacit-chain-config.js), and the BOT_* limits
// in lib.mjs settings().
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256, secp } from '../dapp/vendor/tacit-deps.min.js';
import { makeChainClient, chainStatus, UNIT } from '../dapp/tacit-chain-client.js';
import { TACIT_CHAIN } from '../dapp/tacit-chain-config.js';
import { settings, identities, makeBudget, makeFailures, health, decide, nextWait, fmt, T } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const sel = (sig) => Buffer.from(keccak_256(new TextEncoder().encode(sig)).slice(0, 4)).toString('hex');
const big = (h) => BigInt('0x' + (strip(h) || '0'));

/// A localStorage kept in one JSON file, written whole and renamed into place, so a crash never leaves half a file.
export function fileStorage(path) {
  let m = {};
  try { m = JSON.parse(readFileSync(path, 'utf8')); } catch { }
  const flush = () => { const tmp = path + '.tmp'; writeFileSync(tmp, JSON.stringify(m)); renameSync(tmp, path); };
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); flush(); }, removeItem: (k) => { delete m[k]; flush(); } };
}

/// JSON-RPC over the given nodes, the next one tried when one fails.
export function makeRpc(urls, fetchImpl = globalThis.fetch) {
  let at = 0, id = 0;
  return async (method, params) => {
    let last;
    for (let i = 0; i < urls.length; i++) {
      const url = urls[(at + i) % urls.length];
      try {
        const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(15e3) });
        const j = await r.json();
        if (j.error) { if (/revert/i.test(j.error.message || '')) throw Object.assign(new Error(j.error.message), { revert: true }); throw new Error(j.error.message); }
        at = (at + i) % urls.length;
        return j.result;
      } catch (e) { last = e; if (e.revert) throw e; }
    }
    throw last;
  };
}
const DEFAULT_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://rpc.mevblocker.io', 'https://eth.drpc.org', 'https://1rpc.io/eth'];

/// The Halo2 prover the app uses, in this thread (no worker).
export async function halo2System() {
  const { makeHalo2System } = await import('../dapp/btc-pool-halo2-prover.js');
  const D = join(HERE, '../dapp/btc-pool/'), pin = JSON.parse(readFileSync(D + 'pin.json', 'utf8'));
  return makeHalo2System({ wasm: readFileSync(D + pin.wasm), params: readFileSync(D + pin.params), vk: readFileSync(D + pin.vk), pinnedVkHash: pin.vk_hash, worker: null });
}

/// An ERC-2612 permit signed with `priv`: { v, r, s }.
export async function signPermit({ priv, domainSeparator, owner, spender, value, nonce, deadline }) {
  const k = (s) => Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
  const h = (...w) => Buffer.from(keccak_256(Buffer.from(w.map((x) => (typeof x === 'bigint' ? word(x) : strip(x).padStart(64, '0'))).join(''), 'hex'))).toString('hex');
  const struct = h(k('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'), owner, spender, BigInt(value), BigInt(nonce), BigInt(deadline));
  const sig = await secp.signAsync(keccak_256(Buffer.from('1901' + strip(domainSeparator) + struct, 'hex')), priv);
  return { v: 27 + sig.recovery, r: '0x' + word(sig.r), s: '0x' + word(sig.s) };
}

/// The bot: { tick, view, snapshot, resume }. Everything it reaches is passed in, so the tests run it against a local node.
export async function makeBot({ seed, cfg, rpcCall, system, stateDir, env = process.env, fetchImpl = (...a) => globalThis.fetch(...a), log = (o) => console.log(JSON.stringify(o)), rand = Math.random, now = () => Date.now(), chainId = 1n, wrapCommit }) {
  const s = settings(env);
  const ids = identities(seed);
  mkdirSync(stateDir, { recursive: true });
  const clients = {
    a: makeChainClient({ cfg, rpcCall, priv: ids.a, system, storage: fileStorage(join(stateDir, 'wallet-a.json')), fetchImpl }),
    b: makeChainClient({ cfg, rpcCall, priv: ids.b, system, storage: fileStorage(join(stateDir, 'wallet-b.json')), fetchImpl }),
  };
  const botFile = join(stateDir, 'bot.json');
  let saved = {};
  try { saved = JSON.parse(readFileSync(botFile, 'utf8')); } catch { }
  const budget = makeBudget(s.dailyFeeBudget, now);
  budget.restore(saved.budget);
  const fails = makeFailures(s.maxFailures);
  const hs = { started: new Date(now()).toISOString(), lastAction: null, lastSuccess: null, lastError: null, actions: saved.actions || 0, landed: saved.landed || 0, paused: null, balances: null };
  let wrapIndex = saved.wrapIndex || 0;
  const persist = () => { const tmp = botFile + '.tmp'; writeFileSync(tmp, JSON.stringify({ budget: budget.toJSON(), wrapIndex, actions: hs.actions, landed: hs.landed })); renameSync(tmp, botFile); };

  const ethCall = async (to, data) => strip(await rpcCall('eth_call', [{ to, data: '0x' + data }, 'latest']));
  const blocksCall = (sig, args = '') => ethCall(cfg.blocks, sel(sig) + args);
  let tacAddr = null;
  const tacToken = async () => (tacAddr ||= '0x' + (await blocksCall('TAC()')).slice(24));
  const eoaTac = async () => big(await ethCall(await tacToken(), '70a08231' + strip(ids.eoa.address).padStart(64, '0'))) / UNIT;
  // the confidential pool commitment a shield's inbox fixes as its way back (TacitBlocks.giveBack, if no block takes the deposit in):
  // a wrap note of A's key at the bot's own counter, so A's key alone recovers it
  let ux = null;
  const backFor = wrapCommit || (async (units) => {
    if (!ux) {
      const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
      const { sha256 } = await import('../dapp/vendor/tacit-deps.min.js');
      ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: 'mainnet' });
    }
    const index = wrapIndex++; persist();
    return { back: '0x' + strip(ux.buildWrap({ walletPriv: '0x' + Buffer.from(ids.a).toString('hex'), amountWei: (BigInt(units) * UNIT).toString(), ticker: 'TAC', index }).commit), index };
  });

  const leaderGet = async (path) => { try { const r = await fetchImpl(cfg.leader + path, { signal: AbortSignal.timeout(10e3) }); return r.ok ? await r.json() : null; } catch { return null; } };

  /// What the bot holds and what the chain asks, read fresh (both wallets scanned first, so payments received are picked up).
  async function view() {
    await Promise.all([clients.a.scan(), clients.b.scan()]);
    const side = async (c) => {
      const [worth, qp, qw] = await Promise.all([c.worth(), c.quote('pay'), c.quote('withdraw')]);
      return { worth, most: qp.most, outMost: qw.most, settling: c.settling(), fee: qp.fee, holders: qp.holders };
    };
    const [a, b, eoa, f] = await Promise.all([side(clients.a), side(clients.b), eoaTac(), clients.a.fee()]);
    return { a, b, eoa, fee: f.units, shieldCap: f.shieldCap, sweepFee: f.sweepFee };
  }

  async function shield(units, v) {
    const c = clients.a, t0 = now();
    const sh = await c.shield(units);
    const proveMs = now() - t0;
    const { back, index } = await backFor(units);
    const inbox = await sh.inbox(back);
    const value = sh.permitValue();
    const token = await tacToken();
    const [dom, nonce] = await Promise.all([ethCall(token, '3644e515'), ethCall(token, '7ecebe00' + strip(ids.eoa.address).padStart(64, '0'))]);
    const deadline = BigInt(Math.floor(now() / 1000) + 3600);
    const sig = await signPermit({ priv: ids.eoa.priv, domainSeparator: dom.slice(0, 64), owner: ids.eoa.address, spender: inbox, value, nonce: big(nonce), deadline });
    const permit = { owner: ids.eoa.address.toLowerCase(), fee: String(sh.sweepFee), deadline: String(deadline), v: sig.v, r: sig.r, s: sig.s, back };
    await sh.offer({ back, permit, meta: { inbox, src: 'bot', wrapIndex: index, pay: { until: Number(deadline) * 1000 } } });
    const r = await sh.submit({ back, permit, timeoutMs: s.landTimeoutMin * 60e3 });
    return { ...r, proveMs, inbox, cost: sh.fee + BigInt(sh.sweepFee) / UNIT + (units - (await c.quote('shield', units)).arrives - sh.fee) };
  }
  async function pay(from, to, units) {
    const recv = clients[to];
    // through the leader's directory, as a payer finds an address (the receiver's published there the first time)
    const lane = await recv.lane();
    const toAddr = await clients[from].resolve(lane).catch(async (e) => {
      if (!/no leader knows/.test(e.message || '')) throw e;
      await recv.publish();
      log({ action: 'publish', wallet: to });
      return clients[from].resolve(lane);
    });
    const t0 = now();
    const p = await clients[from].preparePay(toAddr, units);
    const proveMs = now() - t0;
    let seen = null;
    const r = await clients[from].send(p, {
      timeoutMs: s.landTimeoutMin * 60e3,
      onStatus: (x) => { if (x.status === 'queued') recv.incoming().then((u) => { seen = u; }, () => {}); },
    });
    return { ...r, proveMs, incomingSeen: seen == null ? null : fmt(seen) };
  }

  /// One action, chosen from a fresh view. → the log line.
  async function tick() {
    if (fails.stopped()) return { action: 'stopped', failures: fails.count() };
    const t0 = now();
    let status = null, leaderState = null, mp = null;
    try { status = await chainStatus({ cfg, rpcCall, fetchImpl }); } catch (e) { hs.lastError = String(e.message || e); }
    [leaderState, mp] = await Promise.all([leaderGet('/state'), leaderGet('/mempool')]);
    const h = health(s, { status, leaderState, mempool: mp?.spends?.length ?? 0, now: now() });
    if (!h.ok) { hs.paused = h.why; const line = { action: 'pause', why: h.why }; log(line); return line; }
    hs.paused = null;
    let v, act;
    try {
      v = await view();
      hs.balances = { a: fmt(v.a.worth), b: fmt(v.b.worth), eoa: fmt(v.eoa) };
      act = decide(s, v, rand);
    } catch (e) { return failed({ action: 'view' }, e, t0); }
    if (act.kind === 'idle') { const line = { action: 'idle', why: act.why, ...hs.balances }; log(line); return line; }
    // what it costs, before it is spent: over the day's budget waits for tomorrow
    const est = act.kind === 'shield' ? v.fee + v.sweepFee / UNIT + 1n + act.units / 500n : act.kind === 'withdraw' ? v.fee + act.units / 1000n + 1n : v.fee + v[act.from].holders;
    if (!budget.fits(est)) { hs.paused = 'daily fee budget spent'; const line = { action: 'pause', why: hs.paused, spent: fmt(budget.spent()) }; log(line); return line; }
    const line = { action: act.kind, from: act.from, to: act.to, units: act.units != null ? fmt(act.units) : undefined };
    hs.lastAction = { ...line, at: new Date(now()).toISOString() };
    try {
      let r;
      if (act.kind === 'shield') r = await shield(act.units, v);
      else if (act.kind === 'pay') r = await pay(act.from, act.to, act.units);
      else if (act.kind === 'merge') r = await pay(act.from, act.from, v[act.from].most);
      else r = await clients[act.from].withdraw(ids.eoa.address, act.units, { timeoutMs: s.landTimeoutMin * 60e3 });
      // the receiver must hold it once it landed: a payment that landed and is not found is a bug worth stopping for
      if (act.kind === 'pay') {
        const before = v[act.to].worth, after = await clients[act.to].scan().then(() => clients[act.to].worth());
        if (after < before + act.units - 1n) throw new Error(`landed, but ${act.to} holds ${fmt(after)} (was ${fmt(before)}, +${fmt(act.units)} expected)`);
      }
      const cost = r.cost ?? est;
      budget.add(cost);
      fails.ok();
      hs.actions += 1; hs.landed += 1;
      hs.lastSuccess = new Date(now()).toISOString();
      persist();
      const done = { ...line, ok: true, height: r.height, id: r.id, proveMs: r.proveMs, ms: now() - t0, fee: fmt(cost), feesToday: fmt(budget.spent()), incomingSeen: r.incomingSeen };
      log(done);
      return done;
    } catch (e) { return failed(line, e, t0); }
  }
  function failed(line, e, t0) {
    const stop = fails.fail();
    hs.lastError = String(e?.message || e);
    hs.actions += 1;
    persist();
    const out = { ...line, ok: false, error: hs.lastError, kept: e?.kept ? e.kept.id : undefined, ms: now() - t0, failures: fails.count(), ...(stop ? { stopped: true } : {}) };
    log(out);
    return out;
  }
  /// Spends kept from before a restart, handed to the leader again (each waits up to `timeoutMs` to land).
  async function resume(timeoutMs = 5 * 60e3) {
    for (const [name, c] of Object.entries(clients)) {
      let list = [];
      try { list = await c.pending(); } catch (e) { log({ action: 'resume', wallet: name, ok: false, error: String(e.message || e) }); continue; }
      for (const e of list.filter((x) => !x.refused)) {
        try { const r = await c.resubmit(e, { timeoutMs }); log({ action: 'resume', wallet: name, id: e.id, kind: e.kind, ok: true, height: r.height }); }
        catch (err) { log({ action: 'resume', wallet: name, id: e.id, kind: e.kind, ok: false, error: String(err.message || err) }); }
      }
    }
  }
  const snapshot = () => ({ ok: !fails.stopped() && !hs.paused, stopped: fails.stopped(), failures: fails.count(), ...hs, feesToday: fmt(budget.spent()), feeBudget: fmt(s.dailyFeeBudget), account: ids.eoa.address });
  return { tick, view, resume, snapshot, settings: s, clients, ids, decide: (v) => decide(s, v, rand) };
}

// ── the commands
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
async function publicLines(seed) {
  const ids = identities(seed);
  const cfg = { blocks: process.env.TACIT_BLOCKS || TACIT_CHAIN.blocks, leader: process.env.TACIT_LEADER || TACIT_CHAIN.leader };
  const out = { account: ids.eoa.address };
  try {
    const rpcCall = makeRpc((process.env.RPC_URL || DEFAULT_RPCS.join(',')).split(','));
    for (const [n, priv] of [['a', ids.a], ['b', ids.b]]) out[`lane_${n}`] = '0x' + Buffer.from(await makeChainClient({ cfg, rpcCall, priv, system: () => null, storage: null }).lane()).toString('hex');
  } catch { }
  return out;
}
async function main() {
  const cmd = process.argv[2];
  if (cmd === 'keygen') {
    const out = arg('out');
    if (!out) { console.error('keygen --out <file>: the seed is written there, never printed'); process.exit(1); }
    if (existsSync(out)) { console.error(`${out} exists: not overwritten`); process.exit(1); }
    const seed = randomBytes(32).toString('hex');
    closeSync(openSync(out, 'wx', 0o600));
    writeFileSync(out, seed + '\n', { mode: 0o600 });
    const ids = identities(seed);
    console.log(JSON.stringify({ seedFile: out, account: ids.eoa.address, fundWith: 'TAC only: withdraw TAC from the Tacit chain to this account (no ETH is ever needed)', seed: 'BOT_SEED is the file\'s contents' }));
    return;
  }
  const seed = process.env.BOT_SEED;
  if (!seed) { console.error('BOT_SEED is not set'); process.exit(1); }
  if (cmd === 'addresses') { console.log(JSON.stringify(await publicLines(seed))); return; }
  const cfg = { blocks: process.env.TACIT_BLOCKS || TACIT_CHAIN.blocks, leader: process.env.TACIT_LEADER || TACIT_CHAIN.leader };
  const rpcCall = makeRpc((process.env.RPC_URL || DEFAULT_RPCS.join(',')).split(',').map((x) => x.trim()).filter(Boolean));
  const stateDir = process.env.BOT_STATE_DIR || join(process.cwd(), 'tacit-bot-state');
  const sys = halo2System();
  const bot = await makeBot({ seed, cfg, rpcCall, system: () => sys, stateDir });
  if (cmd === 'status') {
    const v = await bot.view();
    const f = (x) => ({ worth: fmt(x.worth), canPay: fmt(x.most), canWithdraw: fmt(x.outMost), settling: x.settling });
    console.log(JSON.stringify({ account: bot.ids.eoa.address, accountTac: fmt(v.eoa), a: f(v.a), b: f(v.b), leaderFee: fmt(v.fee), sweepFee: fmt(v.sweepFee / UNIT), shieldCap: v.shieldCap == null ? null : fmt(v.shieldCap), next: (({ units, ...x }) => ({ ...x, units: units == null ? undefined : fmt(units) }))(bot.decide(v)) }, null, 1));
    return;
  }
  if (cmd !== 'run') { console.error('keygen | addresses | status | run (see the header)'); process.exit(1); }
  const port = Number(process.env.PORT || 8080);
  createServer((req, res) => {
    const ok = req.url === '/health' || req.url === '/';
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
    res.end(ok ? JSON.stringify(bot.snapshot()) : '{}');
  }).listen(port);
  console.log(JSON.stringify({ action: 'start', account: bot.ids.eoa.address, blocks: cfg.blocks, leader: cfg.leader, port }));
  await bot.resume();
  for (;;) {
    const r = await bot.tick().catch((e) => ({ action: 'tick', ok: false, error: String(e.message || e) }));
    if (r.stopped || r.action === 'stopped') { console.log(JSON.stringify({ action: 'stopped', why: 'too many failures in a row: look at the log, then restart' })); break; }
    await new Promise((ok) => setTimeout(ok, nextWait(bot.settings)));
  }
  // stopped: the health answer stays up (stopped: true) and nothing more is done until a restart
  await new Promise(() => {});
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e?.stack || e); process.exit(1); });
