import { hexToBytes, keccak_256 } from '/vendor/tacit-deps.min.js';
import { ETH_NODES } from '/eth-nodes.js';
import { calmText } from '/relay-outcome.js?cb=17e48a9a';
import { bestRoute } from '/swap/aggregate.js?cb=67d0c300';
import { checkRoute, readAccess, readToken, permitTyped, permit2Typed, splitSig, randomNonce as permit2Nonce, encApprove, quoteTacitToToken, buildTacitToToken, quoteAnyToTac, buildAnyToTac } from '/swap/route.js?cb=44449874';
import { makeTokenPools, poolState, RELAYER, KEEPERS, SERVED } from '/evm-pool-tokens.js?cb=16e0e196';
export { SERVED };

export const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
export const CHAIN = { chainId: 1, rpc: ETH_NODES,
  keeper: 'https://tacit-evm-pool-keepers.onrender.com/1/evm-pool/keeper', deployBlock: 26069245, confirmations: 3 };
const ZERO = '0x0000000000000000000000000000000000000000', ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', TAC = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7', DAI = '0x6b175474e89094c44da98b954eedeac495271d0f', PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const ZAP = '0x0000008EbBF2323f95c4fBc18254f3D65C53998c';
const PLANS_KEY = 'tacit-swap-later-v1', ARTIFACT_CACHE = 'tacit-evm-pool-artifacts-v1';
export const TOKEN_POOLS_KEY = 'tacit-token-pools-v1';
const TOKEN_POOLS_FROM = 26262000;
const lc = (s) => String(s || '').toLowerCase();
const word = (a) => lc(a).replace(/^0x/, '').padStart(64, '0');
const hexOf = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CALL_EXECUTED = '0x' + hexOf(keccak_256(new TextEncoder().encode('CallExecuted(address,address)')));
const DEADLINE_S = 1200, BASE_GAS = 520_000n;
const LATE_MS = 30 * 60e3;
const DUST_ETH = 10n ** 12n;
const DEPOSIT_TUPLE = ['uint256', 'uint256', 'uint256', 'bytes32', 'bytes32', 'address', 'uint64', 'uint256'], DEPOSIT_SIG = `(${DEPOSIT_TUPLE.join(',')})`;
const errSel = (sig) => '0x' + hexOf(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));
const NOT_EXPIRED = errSel('NotExpired()'), NOTHING_TO_RECLAIM = errSel('NothingToReclaim()');
const revertData = (e) => { for (let x = e; x; x = x.cause) { const d = x.rpc?.data?.data ?? x.rpc?.data ?? x.data?.data ?? x.data; if (typeof d === 'string' && d.startsWith('0x')) return d.toLowerCase(); } return ''; };

export const readPlans = (store = globalThis.localStorage) => { try { return (JSON.parse(store.getItem(PLANS_KEY) || '[]') || []).filter((p) => p && p.id).slice(0, 20); } catch { return []; } };
const trimPlans = (ps) => { const out = ps.slice(); for (const gone of ['done', 'stopped']) for (let i = out.length - 1; i >= 0 && out.length > 20; i--) if (out[i].state === gone) out.splice(i, 1); return out.slice(0, 20); };
const keepPlans = (ps, store = globalThis.localStorage) => { try { store.setItem(PLANS_KEY, JSON.stringify(trimPlans(ps))); return true; } catch { return false; } };

export async function routeOut({ ethCall, token, amount, to, slippageBps, deadline, random = (n) => crypto.getRandomValues(new Uint8Array(n)) }) {
  const stand = '0x' + hexOf(random(20)), q = await bestRoute({ ethCall, to: stand, refundTo: stand, tokenIn: ZERO, tokenOut: token, amountIn: amount, slippageBps, deadline });
  if (!q) return null;
  const data = q.callData.split(word(stand)).join(word(to));
  if (data === q.callData) return null;
  if (checkRoute(data, { to, tokenIn: ZERO, tokenOut: token, exactOut: false, amount, maxIn: amount, minOut: q.min, deadline, curvePools: q.curvePools || [] }) !== null) return null;
  return { ...q, callData: data, standData: q.callData, to };
}
export async function routeOutTac({ venues, amount, to, slippageBps, deadline, random = (n) => crypto.getRandomValues(new Uint8Array(n)) }) {
  if (!venues) throw new Error('TAC swaps need the page\'s venues.');
  const rt = await venues.route({ dir: 'ETH_TO_TAC', amountIn: BigInt(amount) });
  const q = rt?.single;
  if (!q || (q.venue !== 'precision' && q.venue !== 'tacit-amm') || BigInt(q.amountIn) !== BigInt(amount)) return null;
  const min = (BigInt(q.amountOut) * BigInt(10000 - slippageBps)) / 10000n;
  if (min <= 0n) return null;
  const mk = (rcpt) => venues.build({ quote: q, dir: 'ETH_TO_TAC', account: rcpt, to: rcpt, minOut: min, deadline: BigInt(deadline) });
  const stand = '0x' + hexOf(random(20)), real = mk(to), copy = mk(stand);
  if (lc(real.to) !== lc(ZROUTER) || BigInt(real.value || 0) !== BigInt(amount) || real.approval) return null;
  if (copy.data === real.data || copy.data.split(word(stand)).join(word(to)) !== real.data) return null;
  return { kind: 'tac', callData: real.data, standData: copy.data, min, out: BigInt(q.amountOut), amountIn: BigInt(q.amountIn), name: q.venue === 'precision' ? 'Precision pool' : 'Tacit pool', to, deadline: BigInt(deadline) };
}
export async function routeIn({ ethCall, venues, token, amountIn, from, slippageBps = 50, deadline }) {
  const amt = BigInt(amountIn);
  if (lc(token) === TAC) {
    if (!venues) throw new Error('TAC swaps need the page\'s venues.');
    const q = (await venues.route({ dir: 'TAC_TO_ETH', amountIn: amt, account: from }))?.r?.precision;
    if (!q || BigInt(q.amountIn) !== amt) return null;
    const out = BigInt(q.amountOut), min = (out * BigInt(10000 - slippageBps)) / 10000n;
    if (min <= 0n) return null;
    const tx = venues.build({ quote: q, dir: 'TAC_TO_ETH', account: from, to: ZAP, minOut: min, deadline: BigInt(deadline) });
    if (lc(tx.to) !== lc(ZROUTER) || BigInt(tx.value || 0) !== 0n || !lc(tx.data).includes(word(ZAP))) return null;
    return { callData: tx.data, out, min, name: 'Precision pool', amountIn: amt };
  }
  const q = await bestRoute({ ethCall, to: ZAP, refundTo: from, tokenIn: token, tokenOut: ZERO, amountIn: amt, slippageBps, deadline });
  return q && q.min > 0n ? { callData: q.callData, out: q.out, min: q.min, name: q.name, amountIn: amt } : null;
}
export async function sizeIn({ route, amountIn, min, depositWei, tries = 3 }) {
  let a = BigInt(amountIn), m = BigInt(min);
  const d = BigInt(depositWei);
  if (a <= 0n || m <= 0n || d <= 0n) return null;
  for (let i = 0; i < tries; i++) {
    a = (a * d * 10020n + m * 10000n - 1n) / (m * 10000n);
    const r = await route(a);
    if (!r) return null;
    if (r.min >= d) return r;
    m = r.min;
  }
  return null;
}
export const BOX_GAS = 500_000;
export const depositFeeOf = (q) => [q?.depositFee, q?.fee].map((x) => String(x ?? '')).find((x) => /^\d+$/.test(x)) ?? null;
export const BOXED_MARGIN_BPS = 40n;
export const boxFeeOf = (quoted) => (BigInt(quoted) * 3n) / 2n;
export async function sizeBoxed({ route, amountIn, out, needWei, tries = 3 }) {
  let a = BigInt(amountIn), o = BigInt(out);
  const keep = 10000n - BOXED_MARGIN_BPS, want = (BigInt(needWei) * 10000n + keep - 1n) / keep;
  if (a <= 0n || o <= 0n || want <= 0n) return null;
  for (let i = 0; i < tries; i++) {
    a = (a * want * 10005n + o * 10000n - 1n) / (o * 10000n);
    const r = await route(a);
    if (!r) return null;
    if (BigInt(r.out) >= want) return { ...r, amountIn: a };
    o = BigInt(r.out);
  }
  return null;
}
export const swapOf = (wei) => { const v = BigInt(wei), unit = 10n ** BigInt(Math.max(0, v.toString().length - 3)); return (v / unit) * unit; };
export async function quoteThrough({ ethCall, venues, pay, get, amountIn, slippageBps = 50, deadline, random = (n) => crypto.getRandomValues(new Uint8Array(n)) }) {
  const stand = () => '0x' + hexOf(random(20));
  const r0 = await routeIn({ ethCall, venues, token: pay, amountIn, from: stand(), slippageBps, deadline });
  if (!r0) return null;
  const x = swapOf(r0.out);
  if (x <= 0n) return null;
  const r1 = lc(get) === ZERO ? { out: x, min: x, name: 'ETH' }
    : lc(get) === TAC ? await routeOutTac({ venues, amount: x, to: stand(), slippageBps, deadline, random })
      : await routeOut({ ethCall, token: get, amount: x, to: stand(), slippageBps, deadline, random });
  return r1 ? { r0, ethWei: x, r1 } : null;
}
let TP = null;
export const tokenPools = () => (TP ||= globalThis.fetch('/evm-pool/token-pool-code.json').then((r) => { if (!r.ok) throw new Error(`token pools: HTTP ${r.status}`); return r.json(); })
  .then((code) => makeTokenPools({ code, keccak256: keccak_256 })).catch((e) => { TP = null; throw e; }));
export async function routeFrom({ ethCall, venues, tokenIn, token, amount, to, slippageBps = 50, deadline, random = (n) => crypto.getRandomValues(new Uint8Array(n)) }) {
  const stand = '0x' + hexOf(random(20)), amt = BigInt(amount), dl = BigInt(deadline), write = (d) => d.split(word(stand)).join(word(to));
  let q = null;
  if (lc(tokenIn) === TAC && lc(token) === ZERO) {
    const rt = (await venues.route({ dir: 'TAC_TO_ETH', amountIn: amt, account: stand }))?.r?.precision;
    if (!rt || BigInt(rt.amountIn) !== amt) return null;
    const min = (BigInt(rt.amountOut) * BigInt(10000 - slippageBps)) / 10000n;
    const build = (who) => venues.build({ quote: rt, dir: 'TAC_TO_ETH', account: who, to: who, minOut: min, deadline: dl });
    const tx = build(stand), real = build(to);
    if ([tx, real].some((t) => lc(t.to) !== lc(ZROUTER) || BigInt(t.value || 0) !== 0n)) return null;
    return { callData: real.data, standData: tx.data, min, out: BigInt(rt.amountOut), name: 'Precision pool', deadline: dl };
  } else if (lc(tokenIn) === TAC) {
    const r = await quoteTacitToToken({ ethCall, venues, tokenIn, tokenOut: token, amountIn: amt, account: stand, to: stand, slippageBps, deadline: dl });
    if (!r || r.amountIn !== amt) return null;
    q = { callData: buildTacitToToken({ quote: r, account: stand, to: stand, venues, access: { kind: 'approved' } }).data, min: r.min, out: r.out, name: r.hop ? `Precision pool → ${r.hop.name}` : 'Precision pool' };
  } else if (lc(token) === TAC) {
    const r = await quoteAnyToTac({ ethCall, venues, token: tokenIn, amountIn: amt, account: stand, slippageBps, deadline: dl });
    if (!r) return null;
    const min = (BigInt(r.tacOut) * BigInt(10000 - slippageBps)) / 10000n;
    const build = (who) => buildAnyToTac({ quote: r, account: who, to: who, minOut: min, keccak256: keccak_256, access: { kind: 'approved' } }).data;
    return { callData: build(to), standData: build(stand), min, out: BigInt(r.tacOut), name: r.hop ? `${r.hop.name} → Precision pool` : 'Precision pool', deadline: dl };
  } else {
    const r = await bestRoute({ ethCall, to: stand, refundTo: stand, tokenIn, tokenOut: token, amountIn: amt, slippageBps, deadline: dl });
    if (!r) return null;
    const data = write(r.callData);
    if (data === r.callData || checkRoute(data, { to, tokenIn, tokenOut: token, exactOut: false, amount: amt, maxIn: amt, minOut: r.min, deadline: dl, curvePools: r.curvePools || [] }) !== null) return null;
    return { callData: data, standData: r.callData, min: r.min, out: r.out, name: r.name, deadline: dl };
  }
  const data = write(q.callData);
  if (data === q.callData) return null;
  return { ...q, callData: data, standData: q.callData, deadline: dl };
}
const declined = (e) => e?.code === 4001 || e?.userStopped || e?.name === 'UserStopped' || /reject|denied|cancel/i.test(String(e?.message || ''));
const afterReset = (e) => {
  try { if (e && typeof e === 'object') { e.zeroed = 'USDT'; if (typeof e.message === 'string' && !/allowance was set to zero/.test(e.message)) e.message += ' Your USDT allowance was set to zero first; nothing else was sent.'; } } catch { }
  return e;
};
export function oneAtATime(fn) {
  let tail = Promise.resolve();
  return (...args) => { const run = tail.then(() => fn(...args)); tail = run.catch(() => {}); return run; };
}

export function depositFor({ swapWei, feeWei, pct, rand = Math.random, gasWei = 0n }) {
  const swap = BigInt(swapWei), share = Math.max(5, Math.round(pct * (0.75 + rand() * 0.5))), fixed = 2n * BigInt(feeWei) + BigInt(gasWei);
  const total = swap + fixed + (swap * BigInt(share)) / 100n;
  const unit = 10n ** BigInt(Math.max(0, total.toString().length - 2)), dep = ((total + unit - 1n) / unit) * unit;
  return { depositWei: dep, extraWei: dep - swap - fixed };
}
export function swapFor({ capWei, feeWei, pct, rand = Math.random, gasWei = 0n }) {
  const cap = BigInt(capWei), share = Math.max(5, Math.round(pct * (0.75 + rand() * 0.5))), fixed = 2n * BigInt(feeWei) + BigInt(gasWei);
  const unit = 10n ** BigInt(Math.max(0, cap.toString().length - 2)), top = (cap / unit) * unit;
  return top > fixed ? ((top - fixed) * 100n) / (100n + BigInt(share)) : 0n;
}
export const heldSwapMax = (balance, feeWei) => { const b = BigInt(balance), keep = 2n * BigInt(feeWei); return b > keep ? b - keep : 0n; };
const randomNonce = () => BigInt('0x' + hexOf(crypto.getRandomValues(new Uint8Array(16))));
const unsure = (e) => /may still have sent|did not answer|already on its way|waiting for it to be mined|already spent|kept moving/i.test(String(e?.message || e));
const notSent = (e) => /cancel|rejected|denied|nothing was sent|would revert|does not send calls together|could not check/i.test(String(e?.message || e));
const units = (v, d) => { const s = BigInt(v).toString().padStart(d + 1, '0'), f = s.slice(s.length - d).replace(/0+$/, ''); return s.slice(0, s.length - d) + (f ? `.${f.slice(0, 6)}` : ''); };
const BOX_MARGIN = 997n;
const refused = (e) => /relay(er)? returned|relay could not|cannot front|too low|fee went up|is full|refus|own wallet|relaying is off|price its fee|used today|gas above/i.test(String(e?.message || e));

export async function notifyPool(token, get = globalThis.fetch, keepers = KEEPERS) {
  const r = await get(`${keepers}/token-pools`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(20_000) });
  return r.ok ? r.json().catch(() => null) : null;
}
export const HOP_GAS = BASE_GAS + 900_000n;
export async function relayFee(gas = Number(BASE_GAS + 400_000n), get = globalThis.fetch, keeper = CHAIN.keeper, pool = null) {
  const r = await get(`${keeper}/quote?gas=${gas}`, { signal: AbortSignal.timeout(10_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !/^\d+$/.test(String(j.fee ?? '')) || (pool && lc(j.pool) !== lc(pool))) throw new Error('The relay could not quote its fee right now. Try again in a moment.');
  return BigInt(j.fee);
}
export async function depositFee(get = globalThis.fetch, keeper = CHAIN.keeper) {
  const r = await get(`${keeper}/quote?gas=${BOX_GAS}`, { signal: AbortSignal.timeout(10_000) });
  const least = depositFeeOf(await r.json().catch(() => ({})));
  if (!r.ok || least == null) throw new Error('The relay could not quote its fee right now. Try again in a moment.');
  return BigInt(least);
}

export function makeLater({ keyHex, signer, ethCall, venues = null, ux = null, sendPrivate = null, store = globalThis.localStorage, chain = CHAIN, prove: proveWith = null, tokens = null, walletOf = null, routes = {}, knows = null, callRan = null, now = Date.now }) {
  const rt = { routeOut, routeFrom, routeOutTac, ...routes };
  const secs = () => Math.floor(now() / 1000);
  let modsP = null, proverP = null, rpc = null, keyAddr = null;
  const wallets = new Map();
  const poolDest = (plan) => !!plan?.dest && plan.dest.kind !== 'address';
  async function tacitAccount() {
    if (!ux) throw new Error('A private destination needs the pool module.');
    const t = await ux(), priv = hexToBytes(await keyHex());
    const tk = t.assetByTicker.TAC ? 'TAC' : 'cTAC', meta = t.assetByTicker[tk];
    if (!meta?.assetId) throw new Error('TAC is not a pool asset on this network.');
    return { t, priv, acct: t.account(priv), tk, meta };
  }
  const prover = { ms: null, ready: false };
  const mods = () => (modsP ||= (async () => {
    const [zkm, wm, gw, pm, pos] = await Promise.all([import('/evm-pool-zk.js'), import('/evm-pool-wallet.js?cb=62522386'), import('/evm-pool-gateway.js'), import('/evm-pool-zk-prover.js?cb=00ff69c2'), import('/vendor/tacit-poseidon.min.js')]);
    const PO = { 2: pos.poseidon2, 3: pos.poseidon3, 4: pos.poseidon4, 5: pos.poseidon5, 7: pos.poseidon7 };
    return { zk: zkm.makeEvmPoolZk({ poseidon: (xs) => PO[xs.length](xs) }), wm, gw, vkHash: pm.vkHash };
  })().catch((e) => { modsP = null; throw e; }));

  async function artifact(name, sha) {
    const url = '/evm-pool/' + name, key = `${url}?sha256=${sha}`;
    let cache = null; try { cache = await caches.open(ARTIFACT_CACHE); } catch { }
    const hit = cache ? await cache.match(key).catch(() => null) : null;
    const bytes = new Uint8Array(await (hit || await fetch(url).then((r) => { if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r; })).arrayBuffer());
    if (hexOf(await crypto.subtle.digest('SHA-256', bytes)) !== lc(sha).replace(/^0x/, '')) { if (hit) await cache.delete(key).catch(() => {}); throw new Error(`${name} does not match the ceremony’s pinned hash`); }
    if (!hit && cache) await cache.put(key, new Response(bytes)).catch(() => {});
    return bytes;
  }
  function warm() {
    if (proveWith) return Promise.resolve(proveWith);
    return (proverP ||= (async () => {
      const [{ vkHash }, p] = await Promise.all([mods(), fetch('/evm-pool/pin.json', { cache: 'no-store' }).then((r) => r.json())]);
      const [vkB, wasm, zkey] = await Promise.all([artifact(p.vk, p.vk_sha256), artifact(p.wasm, p.wasm_sha256), artifact(p.zkey, p.zkey_sha256)]);
      const vk = JSON.parse(new TextDecoder().decode(vkB));
      if (vkHash(vk) !== lc(p.vk_hash).replace(/^0x/, '')) throw new Error('The verification key does not match the ceremony pin.');
      const worker = new Worker('/evm-pool-prove-worker.js?cb=7f41e5e0', { type: 'module' });
      let id = 0; const waiting = new Map();
      let up = false;
      worker.onmessage = ({ data }) => { up = true; const w = waiting.get(data.id); if (!w) return; waiting.delete(data.id); data.ok ? w.resolve(data) : w.reject(new Error(data.error)); };
      const stop = (why) => { worker.terminate?.(); for (const w of waiting.values()) w.reject(new Error(why)); waiting.clear(); proverP = null; prover.ready = false; };
      worker.onerror = (ev) => { ev.preventDefault?.(); stop(up ? 'Proving stopped on this device, likely short of memory. Close other tabs and try again.' : 'The prover could not start in this browser. Try again.'); };
      const call = (msg, transfer = [], ms = 0) => new Promise((resolve, reject) => {
        const i = ++id, t = ms ? setTimeout(() => stop('Proving took too long on this device. Close other tabs and try again.'), ms) : 0;
        waiting.set(i, { resolve: (d) => { clearTimeout(t); resolve(d); }, reject: (e) => { clearTimeout(t); reject(e); } });
        worker.postMessage({ ...msg, id: i }, transfer);
      });
      await call({ op: 'init', wasm, zkey, vk }, [wasm.buffer, zkey.buffer], 5 * 60e3);
      prover.ready = true;
      return async (input) => { const t = performance.now(), r = await call({ op: 'prove', input }, [], 8 * 60e3); prover.ms = performance.now() - t; return { proof: r.proof, publicSignals: r.publicSignals }; };
    })().catch((e) => { proverP = null; throw e; }));
  }
  const prove = oneAtATime(async (input) => (await warm())(input));

  async function keyId() {
    const priv = await keyHex();
    if (keyAddr?.priv !== priv) { const m = await mods(); keyAddr = { priv, address: m.wm.evmPoolKeys(m.zk, hexToBytes(priv)).address }; }
    return lc(keyAddr.address);
  }
  const keyIdIfOpen = () => keyId().catch(() => undefined);
  const mine = async (plan) => !plan.key || plan.key === await keyId();
  const OTHER_KEY = 'This swap was made with another Tacit key. Open that key to use it.';
  async function wallet(hop = null) {
    if (walletOf) return walletOf(hop);
    const priv = await keyHex(), m = await mods(), cached = keyAddr?.priv === priv;
    let keys = cached ? null : m.wm.evmPoolKeys(m.zk, hexToBytes(priv));
    if (!cached) keyAddr = { priv, address: keys.address };
    const key = `${keyAddr.address}:${lc(hop?.pool || POOL)}`;
    if (wallets.has(key)) return wallets.get(key);
    keys ||= m.wm.evmPoolKeys(m.zk, hexToBytes(priv));
    const kv = { open: true, get: (k) => { try { return store.getItem(k); } catch { return null; } }, set: (k, v) => { try { store.setItem(k, v); } catch { } } };
    rpc ||= m.wm.jsonRpc(chain.rpc);
    const base = { chainId: chain.chainId, rpc, confirmations: chain.confirmations, logChunk: chain.logChunk };
    const w = hop
      ? m.wm.makeEvmPoolWallet({ zk: m.zk, keys, keeper: keeperOf(hop), store: kv, feed: true, prove,
        chain: { ...base, pool: hop.pool, router: hop.router, token: hop.token, deployBlock: hop.from || TOKEN_POOLS_FROM, relayer: chain.tokenRelayer || RELAYER, maxRelayFee: SERVED[lc(hop.token)]?.maxRelayFee ?? 10n ** 36n } })
      : m.wm.makeEvmPoolWallet({ zk: m.zk, keys, keeper: chain.keeper, store: kv, feed: true, prove, chain: { ...base, pool: POOL, router: ROUTER, deployBlock: chain.deployBlock, dustFloor: DUST_ETH } });
    w.connect(signer);
    wallets.set(key, w);
    return w;
  }
  const keeperOf = (hop) => (chain.keepers ? `${chain.keepers}/${hop.id}/evm-pool/keeper` : hop.keeper || `${KEEPERS}/${hop.id}/evm-pool/keeper`);
  const tps = () => (tokens ? Promise.resolve(tokens) : tokenPools());
  async function hopOf(token) {
    const tp = await tps(), p = tp.poolOf(token);
    return { ...p, keeper: keeperOf(p), state: await poolState(tp, token, (to, data) => ethCall(to, data, 'latest')) };
  }
  async function openPool(token, { onStep = () => {} } = {}) {
    const tp = await tps(), have = await poolState(tp, token, (to, data) => ethCall(to, data, 'latest')), tx = tp.openTx(token, have);
    if (!tx) return null;
    if (signer.ready) await signer.ready();
    onStep('open the pool');
    const h = await signer.send({ to: tx.to, data: tx.data, value: 0n });
    onStep('waiting for it to be mined');
    const rc = await mined(h, 'The pool was not opened.');
    notifyPool(token, globalThis.fetch, chain.keepers || KEEPERS).catch(() => {});
    return { hash: h, block: Number(BigInt(rc?.blockNumber ?? 0)) };
  }


  async function chainKnows(h) {
    if (knows) return knows(h);
    if (walletOf) return true;
    if (!h) return undefined;
    try { rpc ||= (await mods()).wm.jsonRpc(chain.rpc); return (await rpc('eth_getTransactionReceipt', [h], { found: true })) != null; } catch { return undefined; }
  }
  async function receiptOf(h) {
    try { rpc ||= (await mods()).wm.jsonRpc(chain.rpc); return await rpc('eth_getTransactionReceipt', [h], { found: true }); } catch { return undefined; }
  }
  async function ranCall(plan) {
    if (!plan.escrow) return undefined;
    if (callRan) return callRan(plan);
    if (!plan.swapBlock || walletOf) return undefined;
    try {
      rpc ||= (await mods()).wm.jsonRpc(chain.rpc);
      const logs = await rpc('eth_getLogs', [{ address: plan.hop?.router || ROUTER, topics: [CALL_EXECUTED, '0x' + word(plan.escrow)], fromBlock: '0x' + Math.max(0, Number(plan.swapBlock) - 2).toString(16), toBlock: 'latest' }]);
      return Array.isArray(logs) && logs.length ? { tx: logs[0].transactionHash } : null;
    } catch { return undefined; }
  }
  async function mined(h, failed = 'The approval did not go through. Nothing was deposited.') {
    rpc ||= (await mods()).wm.jsonRpc(chain.rpc);
    const rc = signer.receipt ? await signer.receipt(h) : await (async () => { for (let i = 0; i < 80; i++) { const r = await rpc('eth_getTransactionReceipt', [h]).catch(() => null); if (r) return r; await sleep(3000); } return null; })();
    if (!rc) throw new Error('It has not confirmed yet. Check your wallet before sending anything again.');
    if (rc.status !== '0x1') throw new Error(failed);
    return rc;
  }
  async function routerPull({ token, router, sym, amount, deadline, onStep }) {
    const owner = signer.address, acc = await readAccess({ ethCall, token, owner, spender: router });
    if (acc.balance < amount) throw new Error(`Not enough ${sym} in the wallet for the deposit. Nothing was sent.`);
    if (acc.allowed >= amount) return { kind: 'allowance' };
    if (signer.signTyped) {
      const t = await readToken({ ethCall, keccak256: keccak_256, address: token }).catch(() => null);
      if (t?.permit && acc.nonce != null && lc(token) !== DAI) {
        try {
          onStep('sign the permit');
          const p = splitSig(await signer.signTyped(permitTyped({ token, name: t.name, version: t.permit, owner, spender: router, value: amount, nonce: acc.nonce, deadline })));
          await ethCall(token, '0xd505accf' + word(owner) + word(router) + amount.toString(16).padStart(64, '0') + BigInt(deadline).toString(16).padStart(64, '0') + p.v.toString(16).padStart(64, '0') + word(p.r) + word(p.s), 'latest');
          return { kind: 'permit', value: amount, deadline: BigInt(deadline), ...p };
        } catch (e) { if (declined(e)) throw e; }
      }
    }
    let zeroed = false;
    if (acc.allowed > 0n && lc(token) === USDT) { onStep('reset the allowance'); await mined(await signer.send({ to: token, data: encApprove(router, 0n), value: 0n })); zeroed = true; }
    try {
      if (signer.batch && signer.canBatch && await Promise.resolve(signer.canBatch()).catch(() => false)) return { kind: 'batch', token };
      onStep('approve');
      await mined(await signer.send({ to: token, data: encApprove(router, amount), value: 0n }));
    } catch (e) { throw zeroed ? afterReset(e) : e; }
    return { kind: 'allowance' };
  }
  const keepPool = (hop, sym, dec) => {
    try {
      const all = (JSON.parse(store.getItem(TOKEN_POOLS_KEY) || '[]') || []).filter((x) => x?.pool && lc(x.pool) !== lc(hop.pool));
      store.setItem(TOKEN_POOLS_KEY, JSON.stringify([{ token: lc(hop.token), sym, dec, pool: hop.pool, router: hop.router, id: hop.id, from: hop.from || TOKEN_POOLS_FROM }, ...all].slice(0, 40)));
    } catch { }
  };
  const approvals = (token, amount, had) => [...(had > 0n && lc(token) === USDT ? [{ to: token, data: encApprove(ZAP, 0n), value: 0n }] : []), { to: token, data: encApprove(ZAP, amount), value: 0n }];
  async function zapPull({ token, sym, amount, deadline, onStep }) {
    const owner = signer.address, acc = await readAccess({ ethCall, token, owner, spender: ZAP });
    if (acc.balance < amount) throw new Error(`Not enough ${sym} in the wallet for the deposit. Nothing was sent.`);
    if (acc.allowed >= amount) return { kind: 'allowance' };
    if (signer.signTyped) {
      const t = await readToken({ ethCall, keccak256: keccak_256, address: token }).catch(() => null);
      if (t?.permit && acc.nonce != null && lc(token) !== DAI) {
        try {
          onStep('sign the permit');
          const p = splitSig(await signer.signTyped(permitTyped({ token, name: t.name, version: t.permit, owner, spender: ZAP, value: amount, nonce: acc.nonce, deadline })));
          await ethCall(token, '0xd505accf' + word(owner) + word(ZAP) + amount.toString(16).padStart(64, '0') + BigInt(deadline).toString(16).padStart(64, '0') + p.v.toString(16).padStart(64, '0') + word(p.r) + word(p.s), 'latest');
          return { kind: 'permit', value: amount, deadline: BigInt(deadline), ...p };
        } catch (e) { if (declined(e)) throw e; }
      }
      if (acc.permit2 >= amount) {
        try {
          onStep('sign the permit');
          const nonce = permit2Nonce(), sig = await signer.signTyped(permit2Typed({ token, amount, nonce, deadline, spender: ZAP }));
          const { gw } = await mods();
          await ethCall(PERMIT2, gw.calldata('permitTransferFrom(((address,uint256),uint256,uint256),(address,uint256),address,bytes)', [{ tuple: [{ tuple: ['address', 'uint256'] }, 'uint256', 'uint256'] }, { tuple: ['address', 'uint256'] }, 'address', 'bytes'],
            [[[token, amount], nonce, BigInt(deadline)], [ZAP, amount], owner, sig]), 'latest', { from: ZAP });
          return { kind: 'permit2', nonce, deadline: BigInt(deadline), sig };
        } catch (e) { if (declined(e)) throw e; }
      }
    }
    const ask = approvals(token, amount, acc.allowed);
    if (signer.batch && signer.canBatch && await Promise.resolve(signer.canBatch()).catch(() => false)) return { kind: 'allowance', before: ask };
    let zeroed = false;
    try { for (const c of ask) { const reset = c.data === encApprove(ZAP, 0n); onStep(reset ? 'reset the allowance' : 'approve'); await mined(await signer.send(c)); if (reset) zeroed = true; } }
    catch (e) { throw zeroed ? afterReset(e) : e; }
    return { kind: 'allowance' };
  }

  async function start({ swapWei, extraWei = 0n, token, sym, dec, to, toName = null, depositWei, dest = { kind: 'address' }, gasWei = 0n, pay = null, hop = null, onStep = () => {} }) {
    if (hop) return startHop({ swapWei, extraWei, token, sym, dec, to, toName, depositWei, pay, hop, onStep });
    if (!signer.address) throw new Error('Connect a wallet to deposit from.');
    if (dest.kind !== 'address') {
      if (lc(token) !== TAC) throw new Error(`Only TAC can go to a private balance from here: ${sym} is not a pool asset.`);
      to = (await tacitAccount()).acct.address;
    }
    if (lc(to) === lc(signer.address)) throw new Error('Send it to another address: the wallet that deposits would tie the two together.');
    if (pay && (lc(pay.token) === ZERO || lc(pay.token) === lc(token))) throw new Error('Pay with another token than the one it buys.');
    const w = await wallet(), m_ = await mods();
    warm().catch(() => {});
    const readAt = Date.now(), synced = w.sync();
    synced.catch(() => {});
    let selfCall = null, paid = null, batched = null;
    if (pay) {
      onStep('reading the price again');
      const deadline = BigInt(secs() + DEADLINE_S), slippageBps = pay.slippageBps ?? 50;
      const size = () => sizeIn({ route: (a) => routeIn({ ethCall, venues, token: pay.token, amountIn: a, from: signer.address, slippageBps, deadline }), amountIn: pay.amountIn, min: pay.min, depositWei });
      const r = (await size().catch(() => null)) || (await sleep(1500), await size());
      if (!r) throw new Error(`No onchain route sells ${pay.sym} for the deposit right now. Nothing was sent.`);
      if (pay.most != null && r.amountIn > BigInt(pay.most)) throw Object.assign(new Error(`The price moved: the deposit takes more ${pay.sym} than was shown. Nothing was sent; check it and press again.`), { moved: true, amountIn: r.amountIn });
      const pull = await zapPull({ token: pay.token, sym: pay.sym, amount: r.amountIn, deadline, onStep });
      const zap = (tx) => m_.wm.zapDeposit(ZAP, tx, { token: pay.token, amountIn: r.amountIn, swap: r.callData, pull });
      selfCall = (tx) => ({ ...zap(tx), ...(pull.before?.length ? { before: pull.before } : {}) });
      batched = pull.before?.length ? { calls: pull.before, alone: zap } : null;
      paid = { token: lc(pay.token), sym: pay.sym, dec: pay.dec, amountWei: String(r.amountIn), typed: String(pay.amountIn), route: r.name };
    }
    const s0 = await synced;
    const plan = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), key: await keyIdIfOpen(), from: lc(signer.address), swapWei: String(swapWei), extraWei: String(extraWei),
      depositWei: String(depositWei), token: lc(token), sym, dec, to: lc(to), ...(toName ? { toName: String(toName) } : {}), ...(paid ? { pay: paid } : {}), dest, gasWei: String(gasWei), state: 'depositing', leaves0: s0.leaves };
    keptOrStop(plan);
    try {
      plan.depositTx = await w.deposit({ amount: BigInt(depositWei), selfCall, onStep, readAt }).catch(async (e) => {
        if (!e?.noBatch || !batched) throw e;
        let zeroed = false;
        try { for (const c of batched.calls) { const reset = c.data === encApprove(ZAP, 0n); onStep(reset ? 'reset the allowance' : 'approve'); await mined(await signer.send(c)); if (reset) zeroed = true; } }
        catch (x) { throw zeroed ? afterReset(x) : x; }
        return w.deposit({ amount: BigInt(depositWei), selfCall: batched.alone, onStep });
      });
      plan.state = 'waiting'; plan.depositedAt = Date.now(); plan.err = null;
      plan.leaves0 = (await w.sync(5000).catch(() => s0)).leaves;
    } catch (e) {
      plan.state = notSent(e) ? 'stopped' : 'unsure';
      plan.err = String(e?.message || e).slice(0, 200); throw e;
    } finally { save(plan); }
    return plan;
  }
  async function startHop({ swapWei, extraWei, token, sym, dec, to, toName, depositWei, pay, hop, onStep }) {
    if (!signer.address) throw new Error('Connect a wallet to deposit from.');
    if (lc(to) === lc(signer.address)) throw new Error('Send it to another address: the wallet that deposits would tie the two together.');
    if (!hop.state?.pool || !hop.state?.router) throw new Error(`The private ${pay.sym} pool is not open yet.`);
    const w = await wallet(hop), m_ = await mods(), amount = BigInt(depositWei);
    warm().catch(() => {});
    const deadline = BigInt(secs() + DEADLINE_S);
    const readAt = Date.now(), synced = w.sync();
    synced.catch(() => {});
    const pull = await routerPull({ token: hop.token, router: hop.router, sym: pay.sym, amount, deadline, onStep });
    const s0 = await synced;
    const plan = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), key: await keyIdIfOpen(), from: lc(signer.address), swapWei: String(swapWei), extraWei: String(extraWei),
      depositWei: String(depositWei), token: lc(token), sym, dec, to: lc(to), ...(toName ? { toName: String(toName) } : {}), dest: { kind: 'address' }, gasWei: '0',
      hop: { token: lc(hop.token), pool: hop.pool, router: hop.router, id: hop.id, from: hop.from || TOKEN_POOLS_FROM, sym: pay.sym, dec: pay.dec }, state: 'depositing', leaves0: s0.leaves };
    keptOrStop(plan);
    keepPool(hop, pay.sym, pay.dec);
    try {
      plan.depositTx = await w.deposit({ amount, selfCall: (tx) => m_.wm.routerDeposit(hop.router, tx, pull), onStep, readAt }).catch(async (e) => {
        if (!e?.noBatch || pull.kind !== 'batch') throw e;
        onStep('approve');
        await mined(await signer.send({ to: hop.token, data: encApprove(hop.router, amount), value: 0n }));
        return w.deposit({ amount, selfCall: (tx) => m_.wm.routerDeposit(hop.router, tx, { kind: 'allowance' }), onStep });
      });
      plan.state = 'waiting'; plan.depositedAt = Date.now(); plan.err = null;
      plan.leaves0 = (await w.sync(5000).catch(() => s0)).leaves;
    } catch (e) {
      plan.state = notSent(e) ? 'stopped' : 'unsure';
      plan.err = String(e?.message || e).slice(0, 200); throw e;
    } finally { save(plan); }
    return plan;
  }
  async function startBoxed({ swapWei, extraWei = 0n, token, sym, dec, to, toName = null, depositWei, pay, fund, refund = null, waitMs = 600_000, pollMs = 3000, onStep = () => {} }) {
    if (!signer.address) throw new Error('Connect a wallet to deposit from.');
    if (lc(to) === lc(signer.address)) throw new Error('Send it to another address: the wallet that deposits would tie the two together.');
    if (lc(pay.token) === ZERO || lc(pay.token) === lc(token)) throw new Error('Pay with another token than the one it buys.');
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(to || ''))) throw Object.assign(new Error('Add the address it goes to. Nothing was sent.'), { nothingSpent: true });
    const w = await wallet(), back = lc(refund || (await w.refundBox()));
    const least = depositFeeOf(await w.quote(BOX_GAS).catch(() => null));
    if (least == null) throw Object.assign(new Error('The pool’s keeper could not quote its fee right now. Nothing was sent. Try again in a moment.'), { nothingSpent: true });
    const fee = boxFeeOf(least), amount = BigInt(depositWei) + fee;
    const s0 = await w.sync();
    const plan = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), key: await keyIdIfOpen(), from: lc(signer.address), swapWei: String(swapWei), extraWei: String(extraWei),
      depositWei: String(depositWei), token: lc(token), sym, dec, to: lc(to), ...(toName ? { toName: String(toName) } : {}),
      pay: { token: lc(pay.token), sym: pay.sym, dec: pay.dec, amountWei: String(pay.amountIn), ...(pay.typed != null ? { typed: String(pay.typed) } : {}), route: pay.route || 'relay' }, dest: { kind: 'address' }, gasWei: '0',
      boxed: true, state: 'depositing', leaves0: s0.leaves };
    keptOrStop(plan);
    let ran = false;
    try {
      onStep('opening your deposit box');
      const box = await w.depositBox({ amount, fee, refund: back, deadline: secs() + 2 * DEADLINE_S });
      plan.box = box.box; plan.boxWei = String(amount); plan.boxIntent = box.intent ?? null; plan.boxDeadline = box.deadline ?? null; save(plan);
      const sold = await fund({ box: box.box, amount, fee, onStep });
      ran = true; plan.soldAt = Date.now();
      plan.depositTx = typeof sold === 'string' ? sold : sold?.hash || null;
      if (sold?.amountIn != null) plan.pay.amountWei = String(sold.amountIn);
      if (sold?.route) plan.pay.route = sold.route;
      save(plan);
      onStep('making your deposit private');
      const end = Date.now() + waitMs;
      for (;;) {
        const s = await w.sync();
        if (w.notes().some((n) => BigInt(n.v) === BigInt(depositWei) && Number(n.index) >= Number(s0.leaves))) { plan.leaves0 = s.leaves; break; }
        if (Date.now() > end) throw Object.assign(new Error('The swap went through and its deposit is on its way. It is checked again below; nothing is lost.'), { pending: true });
        await sleep(pollMs);
      }
      plan.state = 'waiting'; plan.depositedAt = Date.now(); plan.err = null;
    } catch (e) {
      plan.state = ran ? 'depositing'
        : e?.nothingSpent || declined(e) || /cancel|rejected|denied|nothing was (sent|spent)|did not take|price moved/i.test(String(e?.message || e)) ? 'stopped' : 'unsure';
      plan.err = String(e?.message || e).slice(0, 200); throw e;
    } finally { save(plan); }
    return plan;
  }
  let aheadWant = null, aheadRun = null;
  function ahead({ depositWei, hop = null }) {
    aheadWant = { depositWei, hop };
    return (aheadRun ||= (async () => {
      try {
        for (let want; (want = aheadWant); ) {
          aheadWant = null;
          try {
            const w = await wallet(want.hop);
            if (!aheadWant) await w.prepareDeposit(BigInt(want.depositWei));
          } catch (e) { if (e?.unlockCancelled || !aheadWant) { aheadWant = null; throw e; } }
        }
      } finally { aheadRun = null; }
    })());
  }
  async function adopt({ swapWei, token, sym, dec, to = null, toName = null, hop = null, pay = null, feeWei, into = null }) {
    const swap = BigInt(swapWei), fee = BigInt(feeWei), unit = hop ? pay.sym : 'ETH';
    if (swap <= 0n) throw new Error('enter an amount');
    if (into) { into = { ...into, refund: into.refund || (await tacitAccount()).acct.address }; to = into.refund; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(to))) throw new Error('Add the address it goes to.');
    if (into?.hop && !(into.hop.state?.pool && into.hop.state?.router)) throw new Error(`The private ${sym} pool is not open yet.`);
    if (into?.hop && into.hop.token && lc(into.hop.token) !== lc(token)) throw new Error(`The private ${sym} pool takes another token than ${sym}. Nothing was sent.`);
    if (hop && !(hop.state?.pool && hop.state?.router)) throw new Error(`The private ${unit} pool is not open yet.`);
    const w = await wallet(hop), s = await w.sync();
    if (s.balance < swap + 2n * fee) throw new Error(`Your private ${unit} balance holds less than the swap and the relay’s fee. Nothing was sent.`);
    const plan = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), key: await keyIdIfOpen(), held: true, swapWei: String(swap), extraWei: '0', depositWei: String(swap + 2n * fee),
      token: lc(token), sym, dec, to: lc(to), ...(toName ? { toName: String(toName) } : {}), dest: { kind: 'address' }, gasWei: '0',
      ...(hop ? { hop: { token: lc(hop.token), pool: hop.pool, router: hop.router, id: hop.id, from: hop.from || TOKEN_POOLS_FROM, sym: pay.sym, dec: pay.dec } } : {}),
      ...(into ? { into: { refund: lc(into.refund), hop: into.hop ? { token: lc(into.hop.token), pool: into.hop.pool, router: into.hop.router, id: into.hop.id, from: into.hop.from || TOKEN_POOLS_FROM, sym, dec } : null } } : {}),
      state: 'waiting', depositedAt: Date.now(), leaves0: s.leaves };
    keptOrStop(plan);
    if (hop) keepPool(hop, pay.sym, pay.dec);
    if (into?.hop) keepPool(into.hop, sym, dec);
    return plan;
  }
  async function depositBoxFor({ into, floor, refund = null }) {
    if (!into?.hop?.state?.pool || !into.hop.state.router) throw new Error('The private pool is not open yet.');
    const w = await wallet(into.hop), back = refund || (await tacitAccount()).acct.address;
    const fee = BigInt((await w.quote(Number(HOP_GAS))).fee), amount = (BigInt(floor) * BOX_MARGIN) / 1000n;
    if (amount <= fee * 2n) throw new Error('Too small to go into that pool: its relay\u2019s fee takes too much of it. Nothing was sent.');
    return w.depositBox({ amount, fee, refund: back, deadline: secs() + 2 * DEADLINE_S });
  }
  async function swapIntoPool({ swapWei, token, into, refund = null, shownMin = null, slippageBps = 50, onStep = () => {}, onBox = null }) {
    const swap = BigInt(swapWei);
    if (!signer.address) throw new Error('Connect a wallet to swap from.');
    if (!into?.hop?.state?.pool || !into.hop.state.router) throw new Error('The private pool is not open yet.');
    if (into.hop.token && lc(into.hop.token) !== lc(token)) throw new Error('That private pool takes another token than this swap pays. Nothing was sent.');
    const w = await wallet(into.hop), back = refund || (await tacitAccount()).acct.address;
    onStep('reading the price again');
    const deadline = BigInt(secs() + DEADLINE_S);
    const route = (to) => (lc(token) === TAC ? rt.routeOutTac({ venues, amount: swap, to, slippageBps, deadline }) : rt.routeOut({ ethCall, token, amount: swap, to, slippageBps, deadline }));
    const first = await route('0x' + hexOf(crypto.getRandomValues(new Uint8Array(20))));
    if (!first) throw new Error('No onchain route for this right now. Nothing was sent.');
    const fee = BigInt((await w.quote(Number(HOP_GAS))).fee), amount = (BigInt(shownMin ?? first.min) * BOX_MARGIN) / 1000n;
    if (amount <= fee * 2n) throw new Error('Too small to go into that pool: its relay\u2019s fee takes too much of it. Nothing was sent.');
    if (shownMin != null && first.min * 10000n < BigInt(shownMin) * 9990n) throw Object.assign(new Error('The price moved since it was shown. Nothing was sent; check the new one and press again.'), { moved: true });
    const box = await w.depositBox({ amount, fee, refund: back, deadline: secs() + 2 * DEADLINE_S });
    const r = await route(box.box);
    if (!r || r.min < amount) throw Object.assign(new Error('The price moved while the deposit box was made. Nothing was sent; press again.'), { moved: true });
    onBox?.({ box: box.box, intent: box.intent ?? null, deadline: box.deadline ?? null, arrives: box.value });
    if (signer.ready) await signer.ready();
    onStep('confirm in your wallet');
    const h = await signer.send({ to: ZROUTER, data: r.callData, value: swap });
    onStep('waiting for the block');
    const rc = signer.receipt ? await signer.receipt(h).catch(() => null) : null;
    if (rc && !(rc.status === '0x1' || rc.status === 1 || rc.status === 'success')) throw new Error('The swap was sent but failed on chain, so nothing reached the deposit box.');
    return { hash: h, box: box.box, arrives: box.value, intent: box.intent ?? null, deadline: box.deadline ?? null };
  }
  function save(plan) { keepPlans([plan, ...readPlans(store).filter((p) => p.id !== plan.id)], store); }
  function keptOrStop(plan) {
    if (!keepPlans([plan, ...readPlans(store)], store) || !readPlans(store).some((x) => x.id === plan.id)) throw new Error('This browser could not keep the swap’s plan, so nothing was sent. Free some browser storage and try again.');
  }
  const forget = (id) => keepPlans(readPlans(store).filter((p) => p.id !== id), store);
  async function check(plan) {
    if (!(await mine(plan))) return { ...plan, err: OTHER_KEY };
    if (poolDest(plan) && (plan.state === 'shielding' || plan.state === 'held')) return plan;
    const w = await wallet(plan.hop), s = await w.sync(), notes = w.notes();
    let verdict = null;
    if (!plan.depositedAt) {
      const found = notes.filter((n) => BigInt(n.v) === BigInt(plan.depositWei) && Number(n.index) >= Number(plan.leaves0 || 0)).map((n) => Number(n.index));
      if (found.length) {
        plan.state = 'waiting'; plan.depositedAt = plan.at; plan.err = null; plan.leaves0 = plan.boxed ? s.leaves : Math.min(...found) - (Math.min(...found) % 2) + 2;
      }
      else if (plan.boxed && plan.box && Date.now() - plan.at < 2 * DEADLINE_S * 1000) {
        const sold = !!(plan.depositTx || plan.soldAt);
        plan.state = sold ? 'depositing' : 'unsure';
        plan.err = sold ? null : 'The relay may still send the swap, and the pool’s keeper may still complete the box. Check again in a few minutes.';
      }
      else if (!plan.boxed && Date.now() - plan.at < LATE_MS) { plan.state = 'unsure'; plan.err = 'The deposit is not in the pool yet. If it was sent, it may still be on its way: check again in a few minutes.'; }
      else { plan.state = 'stopped'; plan.err = plan.boxed ? 'The deposit did not reach the pool before its box’s deadline. If the relay’s swap ran, what it paid is still in the box, which anyone can send back to an address your key owns.' : 'The deposit did not reach the pool. If your wallet shows it as sent, check it there before swapping again.'; }
    } else if (await (async () => {
      const ran = await ranCall(plan);
      if (ran !== undefined) { if (ran && ran.tx && !plan.swapTx) plan.swapTx = ran.tx; return ran !== null; }
      const rc = plan.outTx ? await receiptOf(plan.outTx) : undefined, fresh = plan.swapAt && Date.now() - plan.swapAt < 20 * 60e3;
      if (rc && (rc.status === '0x1' || rc.status === 1 || rc.status === 'success')) { plan.swapTx ||= plan.outTx; return true; }
      if (plan.outIns?.length) {
        if (plan.outIns.every((i) => !notes.some((n) => Number(n.index) === Number(i)))) return true;
        verdict = rc ? 'failed' : plan.outTx && rc === null && fresh ? 'sent' : null;
        return false;
      }
      if (rc) { verdict = 'failed'; return false; }
      if (plan.outTx && rc === null && fresh) { verdict = 'sent'; return false; }
      return plan.balBefore != null && s.balance + BigInt(plan.swapWei) <= BigInt(plan.balBefore);
    })()) {
      if (poolDest(plan)) { plan.state = 'shielding'; plan.swapDoneAt = Date.now(); } else { plan.state = 'done'; plan.doneAt = Date.now(); }
      plan.err = null; delete plan.from;
    } else if (verdict === 'sent') { plan.state = 'unsure'; plan.err = 'The payout was sent and is not mined yet. Check again in a few minutes.'; }
    else if (verdict !== 'failed' && (plan.state === 'unsure' || plan.state === 'swapping') && plan.swapAt && Date.now() - plan.swapAt < 20 * 60e3) {
      if (plan.state === 'swapping') plan.err = 'The swap was sent and is not in a block yet. Check again in a few minutes.';
    }
    else { plan.state = 'waiting'; plan.err = null; plan.outIns = null; plan.outTx = null; }
    save(plan);
    return plan;
  }

  const boxRead = async (method, params, opts) => { rpc ||= (await mods()).wm.jsonRpc(chain.rpc); return rpc(method, params, opts); };
  const boxArgs = (plan) => {
    const i = plan.boxIntent || {};
    try { return [BigInt(i.amount), BigInt(i.outLeaf0), BigInt(i.outLeaf1), String(i.memo0Hash), String(i.memo1Hash), String(i.refund), BigInt(i.deadline), BigInt(i.nonce)]; }
    catch { throw new Error('This swap’s deposit box record is incomplete. Nothing was sent.'); }
  };
  async function boxHolds(plan) {
    if (!plan.boxed || !plan.box || !plan.boxIntent) return null;
    return BigInt(await boxRead('eth_getBalance', [plan.box, 'latest']));
  }
  async function reclaimBox(plan, { onStep = () => {} } = {}) {
    const p = readPlans(store).find((x) => x.id === plan.id) || plan;
    if (p.state !== 'stopped' || !p.boxed || !p.box || !p.boxIntent) throw new Error('This swap has no deposit box to send back. Nothing was sent.');
    if (p.reclaimTx) {
      const rc = p.reclaimedAt ? { status: '0x1' } : await boxRead('eth_getTransactionReceipt', [p.reclaimTx], { found: true }).catch(() => null);
      if (rc && rc.status === '0x1') { p.reclaimedAt ||= Date.now(); save(p); return { plan: p, hash: p.reclaimTx, wei: BigInt(p.reclaimWei || 0), to: lc(p.boxIntent.refund), again: true }; }
      if (!rc && Date.now() - (p.reclaimAt || 0) < 30 * 60e3) throw new Error('The send-back is still being mined. Check again in a few minutes; nothing more was sent.');
      p.reclaimTx = null; p.reclaimAt = null; save(p);
    }
    const m = await mods(), args = boxArgs(p), refund = lc(p.boxIntent.refund), deadline = Number(p.boxIntent.deadline);
    const at = '0x' + String(await boxRead('eth_call', [{ to: ROUTER, data: m.gw.calldata(`depositBoxOf(${DEPOSIT_SIG})`, [{ tuple: DEPOSIT_TUPLE }], [args]) }, 'latest'])).slice(-40);
    if (lc(at) !== lc(p.box)) throw new Error('This swap’s deposit box record does not match its box. Nothing was sent.');
    const held = BigInt(await boxRead('eth_getBalance', [p.box, 'latest']));
    if (held === 0n) throw new Error('The deposit box holds nothing, so there is nothing to send back. Nothing was sent.');
    if (secs() <= deadline) throw new Error(`The box can be sent back once its deadline has passed, in about ${Math.ceil((deadline - secs()) / 60) + 1} min. Nothing was sent.`);
    const data = m.gw.calldata(`reclaimDeposit(${DEPOSIT_SIG},address)`, [{ tuple: DEPOSIT_TUPLE }, 'address'], [args, ZERO]);
    if (signer.ready) await signer.ready();
    if (!signer.address) throw new Error('Connect a wallet to send it from.');
    try { await (signer.rpc || boxRead)('eth_call', [{ from: signer.address, to: ROUTER, data }, 'latest']); }
    catch (e) {
      const d = revertData(e);
      if (d.startsWith(NOT_EXPIRED)) throw new Error('The box’s deadline has not passed yet. Nothing was sent; try again in a few minutes.');
      if (d.startsWith(NOTHING_TO_RECLAIM)) throw new Error('The deposit box holds nothing, so there is nothing to send back. Nothing was sent.');
      if (!d && !e?.rpc) throw new Error('Could not check the send-back just now, so nothing was sent. Try again in a moment.');
      throw new Error(`The router would refuse it: ${String(e?.message || e).slice(0, 120)}. Nothing was sent.`);
    }
    onStep('confirm in your wallet');
    const h = await signer.send({ to: ROUTER, data, value: 0n });
    p.reclaimTx = h; p.reclaimAt = Date.now(); p.reclaimWei = String(held); save(p);
    onStep('waiting for the block');
    const failed = 'The send-back failed on chain, so the box still holds it. Nothing was returned.';
    try { await mined(h, failed); }
    catch (e) { if (e?.message === failed) { p.reclaimTx = null; p.reclaimAt = null; save(p); } throw e; }
    p.reclaimedAt = Date.now(); p.err = 'The deposit box was sent back to an address only your key controls.'; save(p);
    return { plan: p, hash: h, wei: held, to: refund };
  }
  async function reclaimIntoBox(rec, { onStep = () => {}, onSent = () => {} } = {}) {
    const router = rec?.router, token = lc(rec?.token || ZERO);
    if (!router || !rec?.box || !rec?.intent) throw new Error('This deposit box record is incomplete. Nothing was sent.');
    if (rec.reclaimTx) {
      const rc = await boxRead('eth_getTransactionReceipt', [rec.reclaimTx], { found: true }).catch(() => null);
      if (rc && rc.status === '0x1') return { hash: rec.reclaimTx, held: BigInt(rec.reclaimHeld || 0), to: lc(rec.intent.refund), again: true };
      if (!rc && Date.now() - (rec.reclaimAt || 0) < 30 * 60e3) throw new Error('The send-back is still being mined. Check again in a few minutes; nothing more was sent.');
    }
    const m = await mods(), args = boxArgs({ boxIntent: rec.intent }), refund = lc(rec.intent.refund), deadline = Number(rec.intent.deadline);
    const at = '0x' + String(await boxRead('eth_call', [{ to: router, data: m.gw.calldata(`depositBoxOf(${DEPOSIT_SIG})`, [{ tuple: DEPOSIT_TUPLE }], [args]) }, 'latest'])).slice(-40);
    if (lc(at) !== lc(rec.box)) throw new Error('This deposit box record does not match its box. Nothing was sent.');
    const held = token === ZERO ? BigInt(await boxRead('eth_getBalance', [rec.box, 'latest']))
      : BigInt(await boxRead('eth_call', [{ to: token, data: '0x70a08231' + lc(rec.box).replace(/^0x/, '').padStart(64, '0') }, 'latest']));
    if (held === 0n) throw new Error('The deposit box holds nothing, so there is nothing to send back. Nothing was sent.');
    if (secs() <= deadline) throw new Error(`The box can be sent back once its deadline has passed, in about ${Math.ceil((deadline - secs()) / 60) + 1} min. Nothing was sent.`);
    const data = m.gw.calldata(`reclaimDeposit(${DEPOSIT_SIG},address)`, [{ tuple: DEPOSIT_TUPLE }, 'address'], [args, token]);
    if (signer.ready) await signer.ready();
    if (!signer.address) throw new Error('Connect a wallet to send it from.');
    try { await (signer.rpc || boxRead)('eth_call', [{ from: signer.address, to: router, data }, 'latest']); }
    catch (e) {
      const d = revertData(e);
      if (d.startsWith(NOT_EXPIRED)) throw new Error('The box’s deadline has not passed yet. Nothing was sent; try again in a few minutes.');
      if (d.startsWith(NOTHING_TO_RECLAIM)) throw new Error('The deposit box holds nothing, so there is nothing to send back. Nothing was sent.');
      if (!d && !e?.rpc) throw new Error('Could not check the send-back just now, so nothing was sent. Try again in a moment.');
      throw new Error(`The router would refuse it: ${String(e?.message || e).slice(0, 120)}. Nothing was sent.`);
    }
    onStep('confirm in your wallet');
    const h = await signer.send({ to: router, data, value: 0n });
    onSent(h, held);
    onStep('waiting for the block');
    await mined(h, 'The send-back failed on chain, so the box still holds it. Nothing was returned.');
    return { hash: h, held, to: refund };
  }

  async function blend(plan) {
    if (!(await mine(plan))) throw new Error(OTHER_KEY);
    const w = await wallet(plan.hop), s = await w.sync(15000);
    const last = Math.max(-1, ...w.notes().map((n) => Number(n.index)));
    const since = plan.held ? Math.max(0, s.leaves - (last < 0 ? 0 : last - (last % 2) + 2)) : Math.max(0, s.leaves - Number(plan.leaves0 || 0));
    return { since, mins: Math.floor((Date.now() - (plan.depositedAt || plan.at)) / 60000), balance: s.balance };
  }

  const boxesOffered = new Map();
  async function offer(plan, { slippageBps = 50 } = {}) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(plan.to || ''))) throw new Error('This swap has no address to pay. Remove it and start again.');
    const same = !plan.into && (plan.hop ? lc(plan.token) === lc(plan.hop.token) : plan.token === ZERO);
    if (same) return { min: BigInt(plan.swapWei), out: BigInt(plan.swapWei), name: plan.hop ? `${plan.hop.sym} itself` : 'ETH itself', at: Date.now() };
    const deadline = BigInt(secs() + DEADLINE_S);
    const route = async (to) => {
      if (plan.hop) {
        const r = await rt.routeFrom({ ethCall, venues, tokenIn: plan.hop.token, token: plan.token, amount: BigInt(plan.swapWei), to, slippageBps, deadline });
        if (!r) throw new Error(`No onchain route sells ${plan.hop.sym} for ${plan.sym} right now. Nothing was sent; try again in a while.`);
        return r;
      }
      const r = lc(plan.token) === TAC
        ? await rt.routeOutTac({ venues, amount: BigInt(plan.swapWei), to, slippageBps, deadline })
        : await rt.routeOut({ ethCall, token: plan.token, amount: BigInt(plan.swapWei), to, slippageBps, deadline });
      if (!r) throw new Error(`No onchain route sells ETH for ${plan.sym} right now. Nothing was sent; try again in a while.`);
      return r;
    };
    if (!plan.into) return { ...(await route(plan.to)), at: Date.now() };
    const w = await wallet(plan.into.hop), stand = '0x' + hexOf(crypto.getRandomValues(new Uint8Array(20)));
    const first = await route(stand), q = await w.quote(Number(plan.into.hop ? HOP_GAS : BASE_GAS + 200_000n));
    const fee = BigInt(q.fee), amount = (first.min * BOX_MARGIN) / 1000n;
    if (amount <= fee * 2n) throw new Error(`Too small to go into the ${plan.sym} pool: the relay's fee there is ${units(fee, plan.dec)} ${plan.sym} of it. Nothing was sent.`);
    const last = boxesOffered.get(plan.id);
    const box = last && last.amount <= amount && last.amount * 1000n >= amount * 990n && last.fee >= fee && last.deadline > secs() + DEADLINE_S * 3 / 2 ? last
      : { ...(await w.depositBox({ amount, fee, refund: plan.into.refund, deadline: secs() + 2 * DEADLINE_S })), fee };
    boxesOffered.set(plan.id, box);
    const r = await route(box.box);
    if (r.min < box.amount) throw Object.assign(new Error('The price moved while the deposit box was made. Nothing was sent; read it again.'), { moved: true });
    return { ...r, at: Date.now(), intoBox: box, arrives: box.value };
  }
  async function swapOut(plan, { shown, slippageBps = 50, via = 'relay', onStep = () => {} } = {}) {
    if (!shown) throw new Error('Read the price first.');
    const now_ = readPlans(store).find((x) => x.id === plan.id) || plan;
    if (now_.state !== 'waiting') throw new Error(`This swap is not waiting to be sent (${now_.state}). Check it first. Nothing was sent.`);
    if (!(await mine(plan))) throw new Error(`${OTHER_KEY} Nothing was sent.`);
    if (via === 'self' && plan.from && lc(signer.address) === plan.from) throw new Error('Not from the wallet that deposited: that would tie the deposit to the swap. Connect another wallet, or let the relay send it.');
    const w = await wallet(plan.hop), amount = BigInt(plan.swapWei), gas = BigInt(plan.gasWei || 0);
    const aside = plan.hop ? BigInt(plan.depositWei) - amount - BigInt(plan.extraWei || 0) : null, maxFee = aside != null && aside > 0n ? aside : null;
    const s = await w.sync();
    if (s.balance < amount + gas) throw new Error(`The deposit is not in the pool yet, or was spent. Check it on ${plan.hop ? 'the front page' : 'the private ETH page'}.`);
    const same = !plan.into && (plan.hop ? lc(plan.token) === lc(plan.hop.token) : plan.token === ZERO);
    let r = shown;
    if (!same && (Date.now() - shown.at > 60e3 || !shown.callData)) {
      onStep('reading the price again');
      r = await offer(plan, { slippageBps });
      if (r.min < shown.min) throw Object.assign(new Error(`The price moved: it now pays at least ${units(r.min, plan.dec)} ${plan.sym} where ${units(shown.min, plan.dec)} was shown. Nothing was sent; read it again.`), { moved: true });
    }
    if (poolDest(plan) && !plan.hop && !same) { const { t, acct } = await tacitAccount(); plan.tacBefore = String(BigInt(await t.ethCall(TAC, '0x70a08231' + word(acct.address)) || '0x0')); }
    plan.min = String(r.min); plan.route = r.name;
    plan.state = 'swapping'; plan.balBefore = String(s.balance); plan.swapBlock = s.block ?? null; plan.swapAt = Date.now(); plan.err = null; plan.outIns = null; plan.outTx = null; save(plan);
    boxesOffered.delete(plan.id);
    try {
      warm().catch(() => {});
      let h;
      if (same) h = await w.withdraw({ to: plan.to, amount, via: via === 'self' ? 'self' : null, maxFee, onStep, onSend: (ins) => { plan.outIns = ins; save(plan); }, onSent: (x) => { plan.outTx = x; save(plan); } });
      else if (plan.hop) {
        const m = await mods(), refund = (plan.callRefund ||= await w.refundBox());
        const intent = m.gw.callIntent({ calls: [{ target: ZROUTER, value: 0n, token: plan.hop.token, amount, push: false, data: r.callData }], refund, deadline: r.deadline, nonce: randomNonce() });
        plan.escrow = m.gw.callEscrowAddress(intent, plan.hop.router); save(plan);
        h = await w.withdrawAndCall({ intent, amount, gas: Number(HOP_GAS), maxFee, via, onStep });
      } else {
        const m = await mods(), refund = (plan.callRefund ||= await w.refundBox());
        const calls = [{ target: ZROUTER, value: amount, data: r.callData }, ...(gas > 0n ? [{ target: plan.to, value: gas }] : [])];
        const intent = m.gw.callIntent({ calls, refund, deadline: r.deadline, nonce: randomNonce() });
        plan.escrow = m.gw.callEscrowAddress(intent, ROUTER); save(plan);
        const multi = r.standData.startsWith('0xac9650d8');
        const routeGas = BigInt(await rpc('eth_estimateGas', [{ from: POOL, to: ZROUTER, value: '0x' + amount.toString(16), data: r.standData }]).catch(() => (multi ? '0xaae60' : '0x61a80')));
        h = await w.withdrawAndCall({ intent, amount: amount + gas, gas: Number(BASE_GAS + (routeGas * 3n) / 2n + (gas > 0n ? 40_000n : 0n)), via, onStep });
      }
      plan.swapTx = h; plan.proveMs = prover.ms; delete plan.from;
      if (plan.into && r.intoBox) { plan.intoBox = r.intoBox.box; plan.intoIntent = r.intoBox.intent ?? null; plan.intoDeadline = r.intoBox.deadline ?? null; }
      if (await chainKnows(h) !== true) throw new Error('The swap was sent but is not in a block yet; it may still have sent. Check it in a few minutes before swapping again.');
      if (poolDest(plan)) { plan.state = 'shielding'; plan.swapDoneAt = Date.now(); }
      else { plan.state = 'done'; plan.doneAt = Date.now(); }
      return plan;
    } catch (e) {
      plan.state = unsure(e) ? 'unsure' : 'waiting'; plan.refused = refused(e); plan.err = calmText(String(e?.message || e)).slice(0, 200);
      if (plan.state === 'waiting') { plan.outIns = null; plan.outTx = null; }
      throw e;
    } finally { save(plan); }
  }

  async function shield(plan, { onStep = () => {}, waitOpts } = {}) {
    if (!poolDest(plan)) throw new Error('This swap pays an address.');
    if (!(await mine(plan))) throw new Error(OTHER_KEY);
    if (!plan.swapTx && !plan.swapDoneAt) throw new Error('The swap out has not been made yet.');
    const { t, priv, acct, tk, meta } = await tacitAccount();
    if (lc(acct.address) !== lc(plan.to)) throw new Error('Another Tacit key is open than the one this swap pays. Open that one and press again.');
    const scale = BigInt(meta.unitScale || 10n ** 10n);
    await wallet();
    if (plan.shieldTx) {
      const rc = await rpc('eth_getTransactionReceipt', [plan.shieldTx]).catch(() => null);
      if (!rc) throw new Error('Making it private is still being mined. Press again in a minute.');
      if (rc.status !== '0x1') { plan.shieldTx = null; plan.shielded = null; plan.shieldIndex = null; save(plan); }
    }
    let amount = plan.shieldTx ? BigInt(plan.shielded || 0) : 0n;
    if (!plan.shieldTx) {
      const rc = plan.swapTx ? await rpc('eth_getTransactionReceipt', [plan.swapTx]).catch(() => null) : null;
      const paid = (rc?.logs || []).filter((l) => lc(l.address) === TAC && l.topics?.[0] === TRANSFER && lc('0x' + String(l.topics[2] || '').slice(26)) === lc(acct.address))
        .reduce((a, l) => a + BigInt(l.data), 0n);
      const held = async () => BigInt(await t.ethCall(TAC, '0x70a08231' + word(acct.address)) || '0x0');
      const before = paid ? 0n : BigInt(plan.tacBefore || 0), least = paid || BigInt(plan.min || 1);
      onStep('waiting for the TAC');
      let got = (await held()) - before;
      for (let i = 0; i < 30 && got < least; i++) { await sleep(4000); got = (await held()) - before; }
      if (got <= 0n || (paid && got < paid)) throw new Error('The TAC has not reached this key’s address yet. Press again in a minute.');
      const take = paid || got;
      amount = take - (take % scale);
      if (amount <= 0n) throw new Error('Too little TAC to make private.');
    }
    plan.state = 'shielding'; plan.err = null; save(plan);
    try {
      if (!plan.shieldTx) {
        onStep('making it private');
        const w = await t.routerWrap({ walletPriv: priv, amountWei: amount.toString(), ticker: tk });
        plan.shieldTx = w?.txHash || null; plan.shielded = String(amount); plan.shieldIndex = w?.index ?? null; save(plan);
        onStep('waiting for it to be mined');
        if (w?.txHash) await t.waitReceipt(w.txHash);
      }
      if (plan.shieldIndex != null) {
        const built = t.buildWrap({ walletPriv: priv, amountWei: amount.toString(), ticker: tk, index: plan.shieldIndex });
        const state = Number(BigInt(await t.ethCall(t.cfg.pool, '0x7da9874f' + String(built.depositId).replace(/^0x/, '').padStart(64, '0'))));
        if (state !== 1 && state !== 2) throw new Error('The pool does not show the deposit yet. Press again in a minute.');
        if (state === 1) {
          onStep('the relay is settling it');
          await t.submitWrapSettle({ built, depositTx: plan.shieldTx, waitOpts: { timeoutMs: 15 * 60e3, intervalMs: 4000, viaRelay: true } });
        }
      }
      if (plan.dest.kind === 'tacit') {
        if (!sendPrivate) throw new Error('Private now, in your balance; sending it on needs the page.');
        onStep('sending it on');
        const r = await sendPrivate({ asset: String(meta.assetId).toLowerCase(), units: amount / scale, ticker: tk, sendTo: { pubHex: plan.dest.pubHex, name: plan.dest.name || null }, label: `Send ${plan.sym} privately`, say: (k) => onStep(k === 'send' ? 'the relay is sending it on' : k === 'note' ? 'finding the note' : k), waitOpts });
        plan.sendTx = r?.sent?.txHash || null;
      }
      plan.state = 'done'; plan.doneAt = Date.now();
      return plan;
    } catch (e) {
      plan.state = 'held'; plan.err = String(e?.message || e).slice(0, 220); throw e;
    } finally { save(plan); }
  }

  return { start, startBoxed, ahead, adopt, swapIntoPool, depositBoxFor, blend, offer, swapOut, shield, check, reclaimBox, reclaimIntoBox, boxHolds, forget, warm, modules: mods, hopOf, openPool, plans: () => readPlans(store), get proveMs() { return prover.ms; }, get proverReady() { return prover.ready; } };
}
