#!/usr/bin/env node
// Reopening a TACD or TACE market whose price has left its band (dapp/vault/reopen.js, the calls from dapp/vault/pools.js reopenSteps), against the live
// Precision pools on a mainnet fork. First the arithmetic: each market's swap, as reopen.js prices it, against the pool's own quoteTransition at many sizes
// both ways, and its deposits against the pool's own refusal at the edge of what it takes. Then, for each market outside its band: the plan's deposit and swap
// sent as the page sends them, each pool's reserves after them exactly as planned, the price back inside the band near the peg, and the market working after:
// an ordinary deposit at its ratio (the page's addPlan) and an ordinary swap. A market inside its band has nothing to reopen.
//
//   FORK=<rpc url> FORK_BLOCK=<n> node tests/vault-reopen-fork.mjs        (anvil on PATH; FORK defaults to MEV Blocker, a caching proxy in front of it helps)
import { spawn } from 'node:child_process';
import { register } from 'node:module';
import { keccak_256 } from '@noble/hashes/sha3.js';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const { planReopen, depositOf, swapOf, inBand, v0, v1, ratioOf, grownRatio } = await import('../dapp/vault/reopen.js');
const { marketOf, addPlan, callSeed, reopenSteps } = await import('../dapp/vault/pools.js');
const { DEPLOYMENTS } = await import('../dapp/vault/deployments.js');

const FORK = process.env.FORK || 'https://rpc.mevblocker.io', PORT = 22000 + Math.floor(Math.random() * 1000), URL_ = `http://127.0.0.1:${PORT}`;
const anvil = spawn(process.env.ANVIL || 'anvil', ['--port', String(PORT), '--fork-url', FORK, ...(process.env.FORK_BLOCK ? ['--fork-block-number', process.env.FORK_BLOCK] : []), '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
let n = 0, fails = 0, id = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params = []) {
  const j = await (await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json();
  if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data });
  return j.result;
}
const W = (v) => BigInt(v).toString(16).padStart(64, '0'), A = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const sel = (sig) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex').slice(0, 8);
const call = (to, data, from) => rpc('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
const U = async (to, data) => BigInt((await call(to, data)).slice(0, 66));
const ME = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', ZERO = '0x' + '0'.repeat(40);
async function send(from, to, data, value = 0n) {
  const h = await rpc('eth_sendTransaction', [{ from, to, data, value: '0x' + value.toString(16), gas: '0x' + (3_000_000).toString(16) }]);
  for (let i = 0; i < 200; i++) { const r = await rpc('eth_getTransactionReceipt', [h]); if (r) return r.status === '0x1'; await sleep(100); }
  throw new Error(`no receipt for ${h}`);
}
const state = async (pool) => ({ supply: await U(pool, '0x18160ddd'), r0: await U(pool, '0x443cb4bc'), r1: await U(pool, '0x5a76f25e') });
const same = (a, b) => a.supply === b.supply && a.r0 === b.r0 && a.r1 === b.r1;
const QT = sel('quoteTransition(address,address,uint256)');

try {
  for (let i = 0; i < 60; i++) { try { await rpc('eth_chainId'); break; } catch { await sleep(500); } }
  const block = Number(BigInt(await rpc('eth_blockNumber')));
  console.log(`fork at block ${block}`);
  await rpc('anvil_setBalance', [ME, '0x' + (10n ** 20n).toString(16)]);
  const cfg = DEPLOYMENTS.pools, synths = Object.fromEntries(DEPLOYMENTS.vaults.map((v) => [v.key, v.hint.synth.toLowerCase()]));
  const vaults = Object.fromEntries(DEPLOYMENTS.vaults.map((v) => [v.key, v.vault]));
  const USDC = cfg.quotes.USDC.addr;

  // tokens for the account: TACD and TACE minted by their vaults, USDC written into its balance slot
  for (const [key, synth] of Object.entries(synths)) {
    await rpc('anvil_impersonateAccount', [vaults[key]]); await rpc('anvil_setBalance', [vaults[key], '0x' + (10n ** 18n).toString(16)]);
    ok(await send(vaults[key], synth, '0x40c10f19' + A(ME) + W(100n * 10n ** 18n)), `the ${key === 'usd' ? 'dollar' : 'ETH'} vault mints 100 of its token to the account`);
    await rpc('anvil_stopImpersonatingAccount', [vaults[key]]);
  }
  let usdcSet = false;
  for (const slot of [9n, ...Array.from({ length: 20 }, (_, i) => BigInt(i))]) {
    const key = '0x' + Buffer.from(keccak_256(Buffer.from(A(ME) + W(slot), 'hex'))).toString('hex');
    await rpc('anvil_setStorageAt', [USDC, key, '0x' + W(10_000n * 10n ** 6n)]);
    if (await U(USDC, '0x70a08231' + A(ME)) === 10_000n * 10n ** 6n) { usdcSet = true; break; }
  }
  ok(usdcSet, 'the account holds 10,000 USDC');

  for (const kind of cfg.markets) {
    const m = marketOf(kind, { sym: kind.quote, ...cfg.quotes[kind.quote] }, synths[kind.vault]), name = `${kind.vault === 'usd' ? 'TACD' : 'TACE'} / ${kind.quote} ${kind.tier}`;
    const pool = '0x' + (await call(cfg.factory, '0x83bd1387' + m.t.token0.slice(2).padStart(64, '0') + A(m.t.token1) + W(m.t.sqrtPLow) + W(m.t.sqrtPHigh) + W(m.t.fee) + A(ZERO) + A(ZERO) + W(0n))).slice(-40);
    const s = await state(pool), t = m.t;
    if (!(s.supply > 0n)) { console.log(`  --   ${name}: not opened at this block`); continue; }
    const out = !inBand(t, v0(t, s.supply) + s.r0, v1(t, s.supply) + s.r1);
    console.log(`${name} ${pool}: supply ${s.supply}, reserves ${s.r0} / ${s.r1}, ${out ? 'outside' : 'inside'} its band`);

    // the swap arithmetic against the pool's own quote, both ways, sizes from 1 to 10^20
    let bad = 0, checked = 0;
    for (const zf of [true, false]) for (let e = 0n; e <= 20n; e += 2n) for (const k of [1n, 5n]) {
      const a = k * 10n ** e, r = await call(pool, QT + A(ZERO.slice(0, -4) + 'dead') + A(zf ? t.token0 : t.token1) + W(a));
      const got = [BigInt(r.slice(0, 66)), BigInt('0x' + r.slice(66, 130)) === 1n], q = swapOf(t, s, zf, a), rOut = zf ? s.r1 : s.r0;
      const [x, y] = [v0(t, s.supply) + s.r0, v1(t, s.supply) + s.r1], nIn = (zf ? x : y) + a, nOut = (zf ? y : x) - (q.out > rOut ? 0n : q.out);
      const room = q.out <= rOut && (zf ? inBand(t, nIn, nOut) : inBand(t, nOut, nIn));
      checked++; if (got[0] !== (q.out > rOut ? 0n : q.out) || got[1] !== room) bad++;
    }
    ok(bad === 0, `${name}: the swap arithmetic is the pool's at ${checked} sizes both ways`);

    if (!out) { ok(planReopen(t, s, m.sOpen, { cap0: 10n ** 30n, cap1: 10n ** 30n }) === null, `${name}: inside its band, nothing to reopen`); continue; }

    const plan = planReopen(t, s, m.sOpen, { cap0: m.synthIs1 ? 10n ** BigInt(m.quote.dec) : 10n ** 18n, cap1: m.synthIs1 ? 10n ** 18n : 10n ** BigInt(m.quote.dec) });
    ok(!!plan, `${name}: a reopen plan within one ${kind.quote} and one ${kind.vault === 'usd' ? 'TACD' : 'TACE'}`);
    if (!plan) continue;
    // the deposit's edge: the shares planned the pool takes, the next whole step more it refuses, as the arithmetic says
    if (plan.deposit) {
      const k = plan.deposit.lp / s.supply, edge = [k, k + 1n, k + 2n].map((j) => ({ j, d: depositOf(t, s, j * s.supply) }));
      for (const { j, d } of edge) {
        const used0 = (j * s.supply * s.r0 + s.supply - 1n) / s.supply, used1 = (j * s.supply * s.r1 + s.supply - 1n) / s.supply;
        await send(ME, USDC === t.token0 ? USDC : t.token0, '0x095ea7b3' + A(cfg.factory) + W(used0)).catch(() => {});
        await send(ME, t.token1, '0x095ea7b3' + A(cfg.factory) + W(used1));
        const data = '0xbdc5ef29' + t.token0.slice(2).padStart(64, '0') + A(t.token1) + W(t.sqrtPLow) + W(t.sqrtPHigh) + W(t.fee) + A(ZERO) + A(ZERO) + W(0n) + W(0n) + W(used0) + W(used1) + W(0n) + A(ME);
        const takes = await call(cfg.factory, data, ME).then(() => true, () => false);
        ok(takes === !!d, `${name}: a deposit of ${j} times the shares there are is ${takes ? 'taken' : 'refused'} by the pool, as the arithmetic says`);
      }
    }
    // the plan, sent as the page sends it: approvals for what each call spends, then the call
    const steps = reopenSteps(m, pool, cfg.factory, plan, ME);
    for (const st of steps) {
      for (const p of st.pay) await send(ME, p.token, '0x095ea7b3' + A(p.spender) + W(p.amount));
      ok(await send(ME, st.to, st.data, st.value), `${name}: the ${st.kind} goes through`);
      const after = await state(pool), want = st.kind === 'deposit' ? plan.deposit.after : plan.swap.after;
      ok(same(after, want), `${name}: after the ${st.kind} the pool holds exactly what was planned (supply ${after.supply}, reserves ${after.r0} / ${after.r1})`);
    }
    const e = await state(pool), [ex, ey] = [v0(t, e.supply) + e.r0, v1(t, e.supply) + e.r1], peg = m.sOpen * m.sOpen;
    const pct = (r) => Number((r > peg ? r - peg : peg - r) * 100000n / peg) / 1000, g = grownRatio(t, e);
    ok(inBand(t, ex, ey), `${name}: inside its band again (${pct(ratioOf(ex, ey))}% from the peg as it reads now, its emptied side rounded)`);
    ok(pct(g) <= 0.1, `${name}: and ${pct(g)}% from the peg once deposits grow it`);
    const cost = plan.deposit ? `${plan.deposit.used0} + ${plan.deposit.used1}` : '0';
    console.log(`       spent: deposit ${cost} raw, swap ${plan.swap.amountIn} in for ${plan.swap.out} out`);

    // and it works as a market: the page's ordinary deposit at its ratio, then a swap of one unit of the quote
    const st = { r0: e.r0, r1: e.r1, supply: e.supply }, add = addPlan(m, st, 's', 10n * 10n ** 18n);
    ok(!!add, `${name}: the page plans an ordinary deposit of 10 ${kind.vault === 'usd' ? 'TACD' : 'TACE'}`);
    if (add) {
      if (m.quote.addr) await send(ME, m.quote.addr, '0x095ea7b3' + A(cfg.factory) + W(add.send.q));
      await send(ME, m.synth, '0x095ea7b3' + A(cfg.factory) + W(add.send.s));
      ok(await send(ME, cfg.factory, callSeed(m, ME, add, false), m.quote.addr ? 0n : add.send.q), `${name}: and the pool takes it`);
      const f = await state(pool), fr = ratioOf(v0(t, f.supply) + f.r0, v1(t, f.supply) + f.r1);
      ok(inBand(t, v0(t, f.supply) + f.r0, v1(t, f.supply) + f.r1) && pct(fr) <= 0.2, `${name}: after it the market trades ${pct(fr)}% from the peg`);
      const unit = 10n ** BigInt(m.quote.dec), qin = m.quote.addr ? m.quote.addr : ZERO, zf = qin.toLowerCase() === t.token0;
      if (m.quote.addr) await send(ME, m.quote.addr, '0x095ea7b3' + A(pool) + W(unit / 100n));
      const before = await state(pool), q = swapOf(t, before, zf, unit / 100n);
      ok(q.ok && await send(ME, pool, '0xa6220b66' + A(qin) + W(unit / 100n) + W(q.out) + A(ME), m.quote.addr ? 0n : unit / 100n), `${name}: a swap of 0.01 ${kind.quote} goes through for the ${q.out} the arithmetic says`);
    }
  }
} catch (e) { fails++; console.log('FAIL   ' + (e?.stack || e)); }
anvil.kill('SIGKILL');
console.log(fails ? `\n${fails} failed, ${n} passed` : `\n${n} passed`);
process.exit(fails ? 1 : 0);
