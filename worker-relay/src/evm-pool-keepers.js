// Every EVM pool keeper in one process (src/evm-pool-keeper.js is the single-chain service it is made of): one instance on Render where
// there were four, each pool with its own nodes, store and loop, sharing the witness model and the proving key, which are the bulk of a
// keeper's memory. Proofs are made one pool at a time (one groth16 prover in flight), so the peak is one keeper's, not four.
//
//   EVM_POOL_CHAINS=1,8453,4663,1-tac   the keepers, in order; the first answers the unprefixed routes. A chain id is that chain's
//                                            pool; a chain id and a name (1-tac) is another pool on the same chain, here the TAC pool
//   EVM_POOL_<KNOB>_<chainId>                a chain's own value of any keeper knob (EVM_POOL_RPC_URL_8453, EVM_POOL_KEEPER_PRIV_8453,
//                                            EVM_POOL_START_BLOCK_8453 …); without one, the plain EVM_POOL_<KNOB> applies to every chain
//   EVM_POOL_<KNOB>_<CHAINID>_<NAME>         a named pool's own value (EVM_POOL_ADDR_1_TAC); over its chain's, which it otherwise takes
//                                            (nodes, fees) except for what is the pool's alone: its addresses, first block, store, seed,
//                                            key and price feed. A named pool that cannot start is left out; the others run on
//   EVM_POOL_KEEPER_DB_<chainId>             the chain's store (default <EVM_POOL_KEEPER_DB dir>/keeper-<chainId>.db; keeper-1-tac.db …)
//   EVM_POOL_SEED_FEED_<chainId>             another keeper's feed base (…/evm-pool/keeper) an empty store is seeded from, root-checked
//   EVM_POOL_SEED_RESET_<chainId>=1          empty a part-replayed store first (one time; unset after)
//   EVM_POOL_TOKEN_POOLS_<chainId>=<block>   serve the token pools anyone opens on that chain (dapp/evm-pool-tokens.js, a chain its
//                                            TOKEN_POOL_CHAINS names) for the tokens in EVM_POOL_TOKEN_POOLS_ALLOW_<chainId> (addresses,
//                                            comma-separated) and, on Ethereum, its SERVED, found from CreateX's logs from that block on,
//                                            each as the named pool <chainId>-x<token's first ten hex digits> with the chain's key and
//                                            zQuoter's price unless its own EVM_POOL_KEEPER_RATE_FEED_<CHAINID>_X… names another
//                                            (EVM_POOL_TOKEN_POOLS_MAX, default 30); POST /token-pools { token, chainId? } names any other
//                                            token's pool on that chain (Ethereum when none is named), kept once it is on chain and served
//                                            on a day's allowance of gas (EVM_POOL_TOKEN_POOLS_DAY_WEI, default 0.003 ETH; at most
//                                            EVM_POOL_TOKEN_POOLS_NAMED, default 10); GET /token-pools[?chainId=] lists a chain's
//
// Pools on one chain may share a key: their sends go through one queue per signer (evm-pool-keeper-chain.js), so they never race for a
// nonce. A pool that holds a token is paid in it; EVM_POOL_KEEPER_RATE_FEED keeps its price in ETH current (evm-pool-keeper-rates.js).
// Each keeper posts its pool's catch-up points (evm-pool-keeper-points.js): the ETH pool's to its registry (EVM_POOL_KEEPER_POINTS),
// any other pool's to the hub (EVM_POOL_KEEPER_POINTS_HUB, 0 for none) once the hub has code on its chain (dapp/admin/token-pools/HUB.md).
//
// HTTP, on PORT: /<id>/evm-pool/keeper/* and /<id>/health are that keeper's routes, exactly as its own service served them at
// /evm-pool/keeper/* and /health; the unprefixed routes are the first keeper's, so a page built for one keeper still works. GET /health
// is 200 only while every chain pool's (1, 8453 …) last tick succeeded; a named pool's trouble shows in its own /health and in GET /chains,
// which lists them all.

import { createServer } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { poolAsset } from '../../dapp/evm-pool-zk.js';
import { loadKeeperConfig, checkKeeperSigner } from './lib/evm-pool-keeper-config.js';
import { clientKey } from './lib/token-bucket.js';
import { openKeeperStore } from './lib/evm-pool-keeper-store.js';
import { makeKeeperChain } from './lib/evm-pool-keeper-chain.js';
import { makeLeafSync, makeFactsSync } from './lib/evm-pool-keeper-leaves.js';
import { makePipeline } from './lib/evm-pool-keeper-pipeline.js';
import { makeKeeperProver, loadZk } from './lib/evm-pool-keeper-prover.js';
import { seedFromFeed } from './lib/evm-pool-keeper-seed.js';
import { createKeeper } from './lib/evm-pool-keeper-loop.js';
import { makePointPoster, signerGate } from './lib/evm-pool-keeper-points.js';
import { makeRateFeed, parseRateFeed } from './lib/evm-pool-keeper-rates.js';
import { makeTokenPoolDiscovery } from './lib/evm-pool-token-discovery.js';
import { makeGasBudget, budgeted } from './lib/evm-pool-gas-budget.js';
import { createIntakeHandler, IntakeError } from './lib/evm-pool-keeper-intake.js';
import { makeServiceGateway } from './lib/evm-pool-keeper-sealed.js';
import { makeTokenPools, keeperIdOf, SERVED, CHAIN_ID as TOKEN_POOLS_CHAIN, TOKEN_POOL_CHAINS } from '../../dapp/evm-pool-tokens.js';
import { keccak_256 } from '../../dapp/vendor/tacit-deps.min.js';
import { safeErr } from './lib/safe-err.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ID = /^(\d+)(?:-([a-z][a-z0-9]*))?$/;
export const suffixOf = (id) => `_${id.toUpperCase().replace(/-/g, '_')}`;
// The keepers named, in order: { id, chainId, suffix } ('1' → chain 1's pool; '1-tac' → another pool on chain 1); none = disabled.
export function instancesOf(env = process.env) {
  const out = String(env.EVM_POOL_CHAINS || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = ID.exec(s), chainId = m ? Number(m[1]) : NaN;
    if (!m || !Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`EVM_POOL_CHAINS: bad chain id "${s}"`);
    return { id: s, chainId, suffix: suffixOf(s) };
  });
  if (new Set(out.map((x) => x.id)).size !== out.length) throw new Error('EVM_POOL_CHAINS: a keeper is named twice');
  return out;
}
// The chain ids alone, in order (a chain with several pools is named once per pool).
export const chainsOf = (env = process.env) => instancesOf(env).map((x) => x.chainId);

// What is a pool's alone: a named pool never takes these from its chain's knobs (it would watch the chain's pool, share its store, sign
// with the chain keeper's key unawares, or take a price feed meant for another pool).
const POOL_OWN = ['EVM_POOL_ADDR', 'EVM_POOL_ROUTER_ADDR', 'EVM_POOL_START_BLOCK', 'EVM_POOL_KEEPER_DB', 'EVM_POOL_SEED_FEED', 'EVM_POOL_SEED_RESET', 'EVM_POOL_KEEPER_PRIV', 'EVM_POOL_KEEPER_RATE_FEED'];
// One keeper's view of the environment: EVM_POOL_<KNOB>_<chainId> wins over EVM_POOL_<KNOB>, and for a named pool its own
// EVM_POOL_<KNOB>_<CHAINID>_<NAME> wins over both; a named pool has no address, first block, store or seed but its own. EVM_POOL_CHAIN_ID is
// the chain itself and the store defaults to a file of its own beside the shared one.
export function envFor(inst, env = process.env) {
  const { id, chainId, suffix } = typeof inst === 'object' ? inst : instancesOf({ EVM_POOL_CHAINS: String(inst) })[0];
  const chainSuffix = `_${chainId}`, named = suffix !== chainSuffix;
  const out = { ...env };
  if (named) for (const k of POOL_OWN) delete out[k];
  const take = (sfx, skip = []) => {
    for (const [k, v] of Object.entries(env)) {
      if (!k.startsWith('EVM_POOL_') || !k.endsWith(sfx)) continue;
      const knob = k.slice(0, -sfx.length);
      if (!skip.includes(knob)) out[knob] = v;
    }
  };
  take(chainSuffix, named ? POOL_OWN : []);
  if (named) take(suffix);
  for (const k of Object.keys(out)) if (/^EVM_POOL_.*_\d+(_[A-Z][A-Z0-9]*)?$/.test(k)) delete out[k];
  out.EVM_POOL_CHAIN_ID = String(chainId);
  if (!env[`EVM_POOL_KEEPER_DB${suffix}`]) {
    const base = env.EVM_POOL_KEEPER_DB || '/var/lib/tacit-evm-pool-keeper/keeper.db';
    out.EVM_POOL_KEEPER_DB = join(dirname(base), `keeper-${id}.db`);
  }
  return out;
}

// Routes: "/<id>/<rest>" names a keeper; anything else is the default (first) one's. -> { id, path } or null for a keeper not run.
export function routeOf(url, ids) {
  const m = /^\/(\d+(?:-[a-z][a-z0-9]*)?)(\/.*)?$/.exec(url);
  const list = ids.map(String);
  if (m) {
    if (!list.includes(m[1])) return null;
    return { id: m[1], path: (m[2] || '/') + url.slice(m[0].length) };
  }
  return { id: list[0], path: url };
}

// A chain's own pool has an id of digits; a token pool on it is `<chainId>-<name>`.
export const isChainPool = (id) => /^\d+$/.test(id);

// What GET /health says. `ok` (its status code, which Render restarts the whole service on) fails only for a chain pool whose loop has
// finished no tick in `stuckMs` (a hang); `ready` is every chain pool's last tick having worked (a node's bad minute shows there).
export function healthOf({ running, keepers, at = Date.now(), stuckMs = 600_000 }) {
  const chains = running.filter(isChainPool);
  // (a loop busy in a long history replay is making progress: its leaf sync says when it last stored a chunk)
  const stuck = chains.filter((c) => at - Math.max(keepers.get(c).lastTickAt, keepers.get(c).leafSync?.progressAt ?? 0) > stuckMs);
  return {
    ok: stuck.length === 0,
    ready: chains.every((c) => keepers.get(c).lastTickOk),
    chains: Object.fromEntries(running.map((c) => [c, keepers.get(c).lastTickOk])),
    ...(stuck.length ? { stuck } : {}),
  };
}

// One prover at a time across every chain: a groth16 proof is the only thing here that takes real memory. They are made in the order
// asked, except that a proof asked with a priority (a chain whose users are waiting on a swap) goes ahead of lower ones by that many
// `headStartMs` of waiting, so it is never behind a long line of another chain's but cannot starve it either: a proof that has waited
// longer than the head start is first. A failure does not block the next.
export function serialProver(prover, { now = Date.now, headStartMs = 60_000 } = {}) {
  const queue = [];
  let running = false;
  async function drain() {
    if (running) return;
    running = true;
    while (queue.length) {
      const at = now();
      let best = 0;
      const age = (j) => (at - j.since) + j.priority * headStartMs;      // how long it has waited, plus its head start
      for (let i = 1; i < queue.length; i++) if (age(queue[i]) > age(queue[best])) best = i;
      const job = queue.splice(best, 1)[0];
      try { job.resolve(await prover.prove(job.input)); } catch (e) { job.reject(e); }
    }
    running = false;
  }
  return {
    ...prover,
    prove(input, { priority = 0 } = {}) {
      return new Promise((resolve, reject) => { queue.push({ input, priority: Number(priority) || 0, since: now(), resolve, reject }); drain(); });
    },
  };
}

// A keeper's catch-up point poster (lib/evm-pool-keeper-points.js): the ETH pool's points go to its registry, any other pool's to the
// hub once the hub has code on the chain, and the pools that share a key on a chain post one at a time. A pool served on a day's
// allowance of gas (named on request) posts none: one post would spend most of the day's allowance, which is for its users' relays.
export function pointPosterFor({ chain, cfg, budgeted = false, log, now }) {
  if (budgeted) return null;
  return makePointPoster({ chain, cfg, log, ...(now ? { now } : {}), gate: signerGate(chain.chainId, chain.address) });
}

// A keeper's history step: its stored history (the /events feed) brought up to date, then a catch-up point posted from it when one is
// due. → the hash of a post sent, or null.
export async function historyStep(k) {
  let synced;
  try { synced = await k.leafSync.sync(); } catch (e) { k.log(`history sync: ${safeErr(e)}`); return null; }
  if (!k.poster) return null;
  try { return await k.poster.maybePost(synced); } catch (e) { k.log(`catch-up point: ${safeErr(e)}`); return null; }
}

// A plain JSON-RPC call over `urls`, each tried in turn (the token pools' discovery reads logs and views through the chain keeper's nodes).
const rpcOver = (urls) => async (method, params) => {
  let last;
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
      const j = await r.json();
      if (j.error) { if (method === 'eth_call') throw Object.assign(new Error(j.error.message), { revert: true }); throw new Error(j.error.message); }
      return j.result;
    } catch (e) { if (e?.revert) throw e; last = e; }
  }
  throw last || new Error('no node');
};

async function main() {
  const insts = instancesOf();
  if (!insts.length) { console.log('[evm-pool-keepers] disabled: EVM_POOL_CHAINS is not set'); return; }
  const log = (...a) => console.log(`[evm-pool-keepers ${new Date().toISOString()}]`, ...a);
  const zk = await loadZk();
  const provers = new Map(); // one per distinct (wasm, zkey, vk), shared by the pools that use it
  const keepers = new Map();
  const pools = new Map();    // chainId:pool → id, so two keepers never watch one pool
  const running = [];
  const chainPool = isChainPool;

  // One keeper, made ready to serve (its nodes, price, prover, store, intake), or an error. `needPrice`: a token pool found on chain starts
  // only once its token can be priced (one no pool trades is not worth a keeper's loop). → the keeper, or null when it is not configured.
  async function startKeeper(inst, env, { needPrice = false, dayBudgetWei = null } = {}) {
    const { id, chainId } = inst;
    const clog = (...a) => console.log(`[evm-pool-keeper ${id} ${new Date().toISOString()}]`, ...a);
    const cfg = loadKeeperConfig(env);
    if (!cfg.enabled) { clog(`disabled: ${cfg.reason}`); return null; }
    if (!cfg.keeperKey) throw new Error(`EVM_POOL_KEEPER_PRIV${inst.suffix !== `_${chainId}` ? inst.suffix : ` (or _${chainId})`} is not set`);
    const poolKey = `${chainId}:${cfg.pool.toLowerCase()}`;
    if (pools.has(poolKey)) throw new Error(`keeper ${id} watches pool ${cfg.pool}, which keeper ${pools.get(poolKey)} watches already`);
    const account = privateKeyToAccount(cfg.keeperKey.startsWith('0x') ? cfg.keeperKey : `0x${cfg.keeperKey}`);
    checkKeeperSigner(cfg, account.address);
    cfg.keeperAddress = account.address;
    const chain = await makeKeeperChain({ cfg, account, log: clog });
    if (chain.chainId !== chainId) throw new Error(`keeper ${id}: its node is on chain ${chain.chainId}, not ${chainId}`);
    // a pool served on request spends at most a day's allowance of gas: a send past it is refused before it is signed
    if (dayBudgetWei) budgeted(chain, makeGasBudget({ dayWei: dayBudgetWei }), () => new IntakeError(503, "the relay has used today's gas for this pool; try again tomorrow. Sending it from your own wallet also works, and shows your address as the sender"), cfg.relayGas);
    // a pool that holds a token: its price in ETH, kept current from the chain, before the first fee is checked
    const ethPool = BigInt(chain.asset) === 0n;
    if (cfg.rateFeed && ethPool) clog('EVM_POOL_KEEPER_RATE_FEED ignored: this pool holds ETH, whose price is one');
    const rates = cfg.rateFeed && !ethPool ? makeRateFeed({ feed: cfg.rateFeed, token: chain.asset, read: chain.readContract, cfg, log: clog }) : null;
    if (rates) await rates.refresh();
    if (needPrice && !rates?.rate()) throw Object.assign(new Error(`no price for ${chain.asset} yet`), { noPrice: true });
    const assetField = poolAsset({ chainId: BigInt(chain.chainId), pool: chain.pool, token: chain.asset });
    const pk = [cfg.wasm, cfg.zkey, cfg.vk, cfg.vkHash, cfg.wasmSha256, cfg.zkeySha256, cfg.nativeProver].join('|');
    if (!provers.has(pk)) provers.set(pk, serialProver(await makeKeeperProver(cfg)));
    const prover = provers.get(pk);
    const store = openKeeperStore(cfg.dbPath);
    // An empty store (a new instance, a replaced disk) is seeded from another keeper's feed when one is named, checked against the pool's
    // root; EVM_POOL_SEED_RESET=1 empties a store part-way through a log replay first. Else, or on any failure, the log replay runs as before.
    if (env.EVM_POOL_SEED_FEED) {
      try { await seedFromFeed({ store, chain, zk, feedUrl: env.EVM_POOL_SEED_FEED, startBlock: cfg.startBlock, reset: env.EVM_POOL_SEED_RESET === '1', log: clog }); }
      catch (e) { clog(`seed from ${env.EVM_POOL_SEED_FEED} not taken: ${safeErr(e)}`); }
    }
    const leafSync = makeLeafSync({ store, chain, zk, startBlock: cfg.startBlock, confirmations: cfg.confirmations, logChunk: cfg.logChunk, log: clog });
    const pipeline = cfg.pipeline ? makePipeline({ chain, verify: prover.verify, assetField, baseTree: () => leafSync.sync(), maxDepth: cfg.pipelineDepth, log: clog }) : null;
    const keeper = createKeeper({ store, chain, prover, zk, assetField, leafSync, pipeline, cfg, log: clog });
    const assetKey = chain.asset.toLowerCase();
    if (!cfg.minFees.has(assetKey) && !cfg.rates.has(assetKey) && !rates) clog(`warning: no EVM_POOL_KEEPER_MIN_FEES, _TOKEN_RATES or _RATE_FEED entry for the pool asset ${assetKey}; deposits will be skipped`);
    clog(`keeper ${account.address} on chain ${chain.chainId}: pool ${chain.pool} router ${chain.router} asset ${chain.asset} vk ${prover.vkHash.slice(0, 16)} store ${cfg.dbPath}${cfg.dryRun ? ' (dry run)' : ''}`);
    const poster = pointPosterFor({ chain, cfg, budgeted: !!dayBudgetWei, log: clog });
    const k = { id, chainId, cfg, chain, store, leafSync, keeper, rates, poster, lastTickOk: true, lastTickAt: Date.now(), wake: null, log: clog };
    k.handler = createIntakeHandler({ store, chain, zk, assetField, cfg, log: clog, leafSync, pipeline, isReady: () => k.lastTickOk, onDue: () => k.wake?.() });
    pools.set(poolKey, id);
    return k;
  }

  // A keeper's loops: its price, the history's facts, and its ticks.
  let started = 0;   // the loops of 15 keepers starting together hash and read at once: each starts a little after the one before
  function runKeeper(k) {
    const stagger = process.uptime() < 120 ? Math.min(started++, 20) * Number(process.env.EVM_POOL_KEEPER_STAGGER_MS ?? 2000) : 0;
    if (k.rates) setInterval(() => { k.rates.refresh().catch(() => {}); }, k.cfg.rateSecs * 1000).unref?.();
    // The history's public facts fill in on their own loop: a backfill or a slow node never delays a relay or a proof.
    if (k.cfg.facts) {
      const facts = makeFactsSync({ store: k.store, chain: k.chain, startBlock: k.cfg.startBlock, logChunk: k.cfg.logChunk, concurrency: k.cfg.factsConcurrency });
      (async () => {
        await sleep(stagger);
        for (;;) {
          let more = false;
          try { more = await facts.step(20_000); } catch (e) { k.log(`history facts: ${safeErr(e)}`); }
          await sleep(more ? 1000 : k.cfg.historySecs * 1000);
        }
      })();
    }
    (async () => {
      let lastHistory = 0;
      await sleep(stagger);
      for (;;) {
        try { await k.keeper.tick(); k.lastTickOk = true; }
        catch (e) { k.lastTickOk = false; k.log(`tick failed: ${safeErr(e)}`); }
        k.lastTickAt = Date.now();
        if (Date.now() - lastHistory >= k.cfg.historySecs * 1000) {
          lastHistory = Date.now();
          await historyStep(k);
          k.lastTickAt = Date.now();
        }
        // Until the next pending row falls due (a box just registered is looked at again in seconds), a poll interval at most, and
        // at once when a box is registered or asked about; never faster than twice a second.
        const due = k.keeper.nextDue?.();
        const ms = Math.min(k.cfg.pollSecs * 1000, due == null ? Infinity : Math.max(500, (due - Date.now() / 1000) * 1000));
        await new Promise((resolve) => { const timer = setTimeout(resolve, ms); k.wake = () => { clearTimeout(timer); resolve(); }; });
        k.wake = null;
      }
    })();
  }

  for (const inst of insts) {
    try {
      const k = await startKeeper(inst, envFor(inst));
      if (k) { keepers.set(inst.id, k); running.push(inst.id); }
    } catch (e) {
      // a chain's own pool failing stops the process as it always has; another pool on a chain is left out, and the rest run
      if (inst.suffix === `_${inst.chainId}`) throw e;
      console.log(`[evm-pool-keeper ${inst.id} ${new Date().toISOString()}] not started: ${safeErr(e)}`);
    }
  }
  if (!running.length) { log('no chain is enabled'); return; }

  // POST /token-pools { token, chainId? }: someone names a token pool for the relay to keep, on the chain named or Ethereum (each chain's
  // set once its token pools are on, below)
  const tokenApis = new Map();  // chainId → { notify, list }
  const asked = new Map();      // client → the times it named a pool in the last hour
  const askedOk = (who) => { const t = Date.now(), a = (asked.get(who) || []).filter((x) => t - x < 3_600_000); if (a.length >= 30) return false; a.push(t); asked.set(who, a); return true; };
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

  // How long the event loop was blocked, sampled: a minute's worst and its 99th percentile are in /health and logged when over a second,
  // so a stall that fails a health check can be traced to its time and size.
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let lagNow = { p99Ms: 0, maxMs: 0 };
  setInterval(() => {
    lagNow = { p99Ms: Math.round(loopDelay.percentile(99) / 1e6), maxMs: Math.round(loopDelay.max / 1e6) };
    if (lagNow.maxMs > 1000) log(`the event loop was blocked up to ${lagNow.maxMs} ms in the last minute (p99 ${lagNow.p99Ms} ms)`);
    loopDelay.reset();
  }, 60_000).unref();

  const port = Number(process.env.PORT || 10000);
  const serve = (req, res) => {
    const url = req.url || '/';
    const [path, query = ''] = url.split('?');
    if (path === '/token-pools' || path === '/token-pools/') {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
      const apiOf = (c) => (/^\d{1,10}$/.test(String(c ?? TOKEN_POOLS_CHAIN)) ? tokenApis.get(Number(c ?? TOKEN_POOLS_CHAIN)) : null);
      const none = (c) => json(res, 404, { error: `this relay keeps no token pools${c != null && Number(c) !== TOKEN_POOLS_CHAIN ? ` on chain ${c}` : ''}` });
      if (req.method === 'GET') { const c = new URLSearchParams(query).get('chainId'); const api = apiOf(c); return api ? json(res, 200, api.list()) : none(c); }
      if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' });
      if (!tokenApis.size) return none(null);
      const who = clientKey(req);                                  // not the client's own X-Forwarded-For, which it can change on every call
      if (!askedOk(who)) return json(res, 429, { error: 'rate limited' });
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
      req.on('end', async () => {
        let token = null, chainId = null;
        try { ({ token, chainId = null } = JSON.parse(body || '{}')); } catch { /* below */ }
        if (!/^0x[0-9a-fA-F]{40}$/.test(String(token || '')) || BigInt(token) === 0n) return json(res, 400, { error: 'name a token: { "token": "0x…", "chainId"?: 1 }' });
        const api = apiOf(chainId);
        if (!api) return none(chainId);
        try { return json(res, 200, await api.notify(token)); } catch (e) { return json(res, 502, { error: safeErr(e) }); }
      });
      return;
    }
    if (url === '/health' || url === '/health/') {
      // the chains' own pools decide the service's health; another pool's trouble (a token pool's node, its price) shows, and restarts nothing
      // Render restarts the whole service, every chain with it, when this fails: so it fails only for a hang, not for a tick that failed.
      const h = healthOf({ running, keepers, stuckMs: Number(process.env.EVM_POOL_KEEPER_STUCK_SECS || 600) * 1000 });
      res.writeHead(h.ok ? 200 : 503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ...h, loop: lagNow, rssMb: Math.round(process.memoryUsage().rss / 1048576), uptimeS: Math.round(process.uptime()) }));
    }
    if (url === '/chains' || url === '/chains/') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=60' });
      return res.end(JSON.stringify({ chains: running.map((id) => { const k = keepers.get(id); return { id, chainId: k.chainId, keeper: k.cfg.keeperAddress, pool: k.cfg.pool, router: k.cfg.router, asset: k.chain.asset, base: `/${id}/evm-pool/keeper` }; }) }));
    }
    const r = routeOf(url, running);
    if (!r) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify({ error: 'no such chain' })); }
    req.url = r.path;
    return keepers.get(r.id).handler(req, res);
  };

  // The private route for the whole service (docs/EVM-POOL.md "Private route"): one gateway key in the base environment and one POST /sealed
  // that carries any pool's routes, so a wallet's burst of reads for every pool is one envelope.
  const sealed = process.env.EVM_POOL_KEEPER_GATEWAY_KEY ? makeServiceGateway({
    secret: process.env.EVM_POOL_KEEPER_GATEWAY_KEY, serve, json, log,
    forwarders: String(process.env.EVM_POOL_KEEPER_FORWARDERS || '').split(',').map((a) => a.trim()).filter(Boolean),
    ratePerMin: Number(process.env.EVM_POOL_KEEPER_RATE_PER_MIN || 20),
  }) : null;
  // A request that throws, or whose handler rejects, is answered 500 and logged: it never reaches the process, which every chain's keeper shares.
  const failed = (res) => (e) => {
    log(`request failed: ${safeErr(e)}`);
    try { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end('{"error":"internal error"}'); } catch { /* the socket is gone */ }
  };
  createServer((req, res) => {
    try { Promise.resolve(sealed?.(req, res) ? undefined : serve(req, res)).catch(failed(res)); } catch (e) { failed(res)(e); }
  })
    .listen(port, () => log(`listening on ${port}: keepers ${running.join(', ')} (unprefixed routes are ${running[0]}'s)${sealed ? '; the private route is on at POST /sealed' : ''}`));

  for (const id of running) runKeeper(keepers.get(id));

  // Token pools anyone opens (dapp/evm-pool-tokens.js), found on chain and served as they appear: EVM_POOL_TOKEN_POOLS_<chainId>=<first block>
  // turns it on for a chain whose own pool runs here; each runs on that chain's nodes and key, paid in its token at zQuoter's price (or the
  // feed its own knob names). Only the tokens listed are served: deep enough that whoever opens a pool cannot set the price its fees are
  // taken at. SERVED is Ethereum's list; another chain serves what its EVM_POOL_TOKEN_POOLS_ALLOW_<chainId> names.
  for (const chainId of [...new Set(running.filter(chainPool).map((id) => keepers.get(id).chainId))]) {
    const from = process.env[`EVM_POOL_TOKEN_POOLS_${chainId}`];
    if (!from) continue;
    const tlog = (...a) => console.log(`[evm-pool-token-pools ${chainId} ${new Date().toISOString()}]`, ...a);
    if (!TOKEN_POOL_CHAINS[chainId]) { tlog(`no token pools on chain ${chainId}: dapp/evm-pool-tokens.js has no constants for it`); continue; }
    const ck = keepers.get(String(chainId));
    const code = JSON.parse(readFileSync(new URL('../../dapp/evm-pool/token-pool-code.json', import.meta.url), 'utf8'));
    const tp = makeTokenPools({ code, keccak256: keccak_256, chain: TOKEN_POOL_CHAINS[chainId] });
    const extra = String(process.env[`EVM_POOL_TOKEN_POOLS_ALLOW_${chainId}`] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const tokens = [...new Set([...(chainId === TOKEN_POOLS_CHAIN ? Object.keys(SERVED) : []), ...extra.map((x) => x.toLowerCase())])];
    for (const t of extra) tp.poolOf(t);   // a bad address stops here, at start
    const disc = makeTokenPoolDiscovery({ tp, tokens, rpc: rpcOver([...(ck.cfg.logRpcUrls?.length ? ck.cfg.logRpcUrls : []), ...ck.cfg.rpcUrls]), fromBlock: BigInt(from),
      statePath: join(dirname(ck.cfg.dbPath), `token-pools-${chainId}.json`), confirmations: BigInt(process.env.EVM_POOL_TOKEN_POOLS_CONFIRMATIONS || 3),
      maxNamed: Number(process.env.EVM_POOL_TOKEN_POOLS_NAMED || 10), log: tlog });
    const chainKey = process.env[`EVM_POOL_KEEPER_PRIV_${chainId}`] || process.env.EVM_POOL_KEEPER_PRIV;
    const dayWei = BigInt(process.env.EVM_POOL_TOKEN_POOLS_DAY_WEI || 3_000_000_000_000_000n);
    const max = Number(process.env.EVM_POOL_TOKEN_POOLS_MAX || 30), served = new Set();
    // whether zQuoter prices the token now, read through the chain's own keeper before a keeper is made for it (so a token with no price
    // costs one read a round, not a keeper's start)
    const priced = async (token, feed) => {
      const f = makeRateFeed({ feed: parseRateFeed(feed), token, read: ck.chain.readContract, cfg: { rates: new Map(), rateWindowSecs: 0, rateMaxAgeSecs: 0 } });
      return (await f.refresh()) != null;
    };
    const idOf = (token) => keeperIdOf(token, chainId);
    const serve = async (p) => {
      const id = idOf(p.token), inst = { id, chainId, suffix: suffixOf(id) };
      if (keepers.has(id)) return;
      if (served.size >= max) { tlog(`${max} token pools served already; ${p.token}'s waits`); return; }
      const feed = process.env[`EVM_POOL_KEEPER_RATE_FEED${inst.suffix}`] || 'zq';
      if (!(await priced(p.token, feed).catch(() => false))) { tlog(`${p.token}'s pool not served yet: no price for it (${feed})`); return; }
      // its own knobs, which an EVM_POOL_<KNOB>_<CHAINID>_X… set in the environment still overrides
      const own = { ADDR: p.pool, ROUTER_ADDR: p.router, START_BLOCK: String(p.block), KEEPER_PRIV: chainKey, KEEPER_RATE_FEED: 'zq', KEEPER_POLL_SECS: '60' };
      const env = envFor(inst, { ...Object.fromEntries(Object.entries(own).map(([kk, v]) => [`EVM_POOL_${kk}${inst.suffix}`, v])), ...process.env });
      try {
        // a pool named on request (not one of the listed tokens) is served on a day's allowance of gas
        const k = await startKeeper(inst, env, { needPrice: true, dayBudgetWei: disc.named(p.token) ? dayWei : null });
        if (!k) return;
        keepers.set(id, k); running.push(id); served.add(id); runKeeper(k);
        tlog(`serving the ${p.token} pool at /${id}/evm-pool/keeper`);
      } catch (e) { tlog(`${p.token}'s pool not served yet: ${safeErr(e)}`); }
    };
    const notify = async (token) => {
      const r = await disc.notify(token);
      // kept now, or kept before and not served yet (its price unread then): served as soon as it can be
      const entry = r.entry || (r.status === 'known' || r.status === 'served' ? disc.known().find((x) => x.token.toLowerCase() === token.toLowerCase()) : null);
      if (entry && !keepers.has(idOf(entry.token))) serve(entry).catch(() => {});
      return { status: r.status, pool: r.pool ?? null, id: idOf(token), serving: keepers.has(idOf(token)) };
    };
    const list = () => ({ chainId, pools: running.filter((id) => id.startsWith(`${chainId}-x`)).map((id) => { const k = keepers.get(id); return { id, pool: k.cfg.pool, asset: k.chain.asset, named: !!k.chain.gasBudget, ...(k.chain.gasBudget ? { gasLeftWei: k.chain.gasBudget.left().toString() } : {}) }; }) });
    tokenApis.set(chainId, { notify, list });
    (async () => {
      for (const p of disc.known()) await serve(p);
      for (;;) {
        try { for (const p of await disc.scan()) await serve(p); } catch (e) { tlog(`scan: ${safeErr(e)}`); }
        // a pool found before its token could be priced is tried again each round
        for (const p of disc.known()) if (!keepers.has(idOf(p.token))) await serve(p);
        await sleep(Number(process.env.EVM_POOL_TOKEN_POOLS_SECS || 300) * 1000);
      }
    })();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('[evm-pool-keepers] failed:', safeErr(e, 500)); process.exit(1); });
}
