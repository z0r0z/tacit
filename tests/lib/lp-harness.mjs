// Shared by the tests of the LP service and of the page's client: the LP's config for a world, the service on a socket
// of its own driven by the world's clock, a request helper, and a world whose user talks to that socket over HTTP.
import { realFetch } from './real-fetch.mjs';
import { bytesToHex, hexToBytes } from '../../dapp/vendor/tacit-deps.min.js';
import { makeHttpCounter } from '../../dapp/fastbridge-http.js';
import { ASSET } from './chain-sim.mjs';
import { world, memStore } from './fastbridge-world.mjs';
import { makeLpService } from '../../fastbridge-lp/lib/service.mjs';
import { makeHttpServer } from '../../fastbridge-lp/lib/http.mjs';

export const closers = [];

export function configFor(w, { quote = {}, policy = {}, alertSecs } = {}) {
  return {
    claimPub: bytesToHex(w.lW.wallet.pub), csvBlocks: 144, alertSecs,
    quote: { btcAsset: bytesToHex(w.etch.asset), evmAsset: ASSET, minAmount: 1000, maxAmount: 1_000_000, feeBps: 0, flatFee: 0, validSecs: 3600, ...quote },
    policy: {
      minCsv: 72, minConfsFor: () => 1, evmWindowSecs: 4 * 3600, minClaimSecs: 3600, claimSlackSecs: 7200, roundSecs: 600, refundMarginSecs: 600,
      maxOfferAgeSecs: 3600, minAmount: 1000, maxAmount: 1_000_000, ...policy,
    },
  };
}

// The service on a socket of its own, driven by the world's clock: `w.lpTick` becomes its tick.
export async function serve(w, { config = configFor(w), quoteStore = memStore(), swaps = w.lpStore, btc = w.lBtc, origins = ['*'], limits, maxBody, trustProxy } = {}) {
  const alerts = [], logs = [];
  const svc = makeLpService({ seed: w.lKeys.seed, btc, evm: w.lEvmCtx, swaps, quoteStore, config, now: w.clock.now, log: (o) => logs.push(o), alert: (o) => alerts.push(o) });
  await svc.start();
  const server = makeHttpServer({ handle: svc.handle, origins, ...(limits ? { limits } : {}), ...(maxBody ? { maxBody } : {}), ...(trustProxy ? { trustProxy } : {}) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const s = { svc, server, config, quoteStore, swaps, alerts, logs, base: `http://127.0.0.1:${server.address().port}` };
  s.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  closers.push(s.close);
  w.lpStore = swaps;
  w.lpTick = () => svc.tick();
  return s;
}

export async function call(base, method, path, body, headers = {}) {
  const r = await realFetch(base + path, { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, headers: r.headers, text };
}

// a world whose user talks to whatever `ref.base` names, over HTTP
export function httpWorld(opts = {}) {
  const ref = { base: null };
  const w = world({ funds: 0, userCounter: () => makeHttpCounter({ base: () => ref.base, fetchImpl: realFetch }), ...opts });
  return { w, ref };
}
export const startSwap = (w, q) => w.userBl.start({ asset: w.etch.asset, amount: BigInt(q.btcValue), notes: [w.note], counterClaimPub: hexToBytes(q.claimPub), evmAsset: q.evmAsset, evmAmount: BigInt(q.evmAmount), quoteId: q.id });
export const bothDone = (w) => async () => (await w.user())?.phase === 'done' && (await w.lp())?.phase === 'done';
