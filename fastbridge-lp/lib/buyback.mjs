// Past its target, what a pair provider nets goes to TAC buybacks. The machinery is the protocol's own: TacBuyback (contracts/src/TacBuyback.sol, immutable),
// which takes ETH and buys TAC with it for the reserve, in small spaced buys its keeper (the tacit-buyback cron) makes. ETH sent to it can leave only as a buy
// into the reserve or a flush to the reserve. The provider's part is to send it ETH: an unwrap of its own pool ETH straight to the contract.
//
// The rule (lib/stats.mjs): while the provider holds less than its target on either side, or buybacks are off, every swap's net stays as capacity. At the
// target with buybacks on, a swap's net is OWED. What is owed is paid here, and only:
//   - to the one fixed address, TacBuyback as deployed (contracts/deployments/1.json), never an address from a request or a setting at run time
//   - from what the ETH side holds over its target (a send never takes it under), at most `maxPerSendEth` a send and `maxPerDayEth` a UTC day, at least `minSendEth`
//   - with FB_LP_BUYBACK=on (off unless set), and while no BTC -> ETH swap is under way (the note it spends is not one a lock waits on)
// What reached the contract, the relay's fee for the unwrap, the transaction, and the TAC the contract bought with it (its Bought events, the provider's share of
// each buy pro rata to its part of the contract's ETH then) are kept and shown.
//
//   planBuyback({ owed, ethFree, targetEth, aboveTarget, dayRouted, cfg, quiet }) -> { amount } | { skip }
//   attributeBuys({ events, pending, balanceBefore }) -> { tac, used, pending }

export const TAC_BUYBACK = '0x6919cbef0e70affa02ae02c86c532a137154f250';      // contracts/deployments/1.json tacBuyback
export const BUYBACK_DEFAULTS = Object.freeze({ enabled: false, everySecs: 1800, minSendEth: '0.01', maxPerSendEth: '0.25', maxPerDayEth: '0.5', scanSecs: 3600 });

const units = (t) => { const [w, f = ''] = String(t).split('.'); return BigInt(w) * 10n ** 8n + BigInt(f.padEnd(8, '0').slice(0, 8)); };
const amt = (k, v) => { if (!/^\d{1,6}(\.\d{1,8})?$/.test(String(v))) throw new Error(`buyback.${k} must be an amount of ETH (got "${v}")`); return units(v); };

export const buybackTopic = (keccak256) => '0x' + Buffer.from(keccak256(new TextEncoder().encode('Bought(uint8,uint256,uint256)'))).toString('hex');

export function buybackConfig(C = {}, env = process.env) {
  const b = { ...BUYBACK_DEFAULTS, ...((C && typeof C.buyback === 'object' && C.buyback) || {}) };
  // off unless the environment turns it on: a config file alone does not start sending ETH out of the provider
  const sw = env.FB_LP_BUYBACK != null ? String(env.FB_LP_BUYBACK).trim().toLowerCase() : '';
  if (sw && sw !== 'on' && sw !== 'off') throw new Error(`FB_LP_BUYBACK must be on or off (got "${env.FB_LP_BUYBACK}")`);
  const to = String(b.to || TAC_BUYBACK).toLowerCase();
  if (to !== TAC_BUYBACK) throw new Error('buyback.to must be the TacBuyback contract (contracts/deployments/1.json): the provider sends to no other address');
  const out = { enabled: sw === 'on', to, everySecs: Math.max(300, Number(b.everySecs) || 1800), scanSecs: Math.max(600, Number(b.scanSecs) || 3600), minSend: amt('minSendEth', b.minSendEth), maxPerSend: amt('maxPerSendEth', b.maxPerSendEth), maxPerDay: amt('maxPerDayEth', b.maxPerDayEth) };
  if (out.minSend <= 0n || out.minSend > out.maxPerSend || out.maxPerSend > out.maxPerDay) throw new Error('buyback amounts must be 0 < minSendEth <= maxPerSendEth <= maxPerDayEth');
  return out;
}

// The capacity target: `target.eth` of pool ETH, and Bitcoin worth `target.btcAsEth` of ETH at the market (both 10 unless set)
export function targetConfig(C = {}, env = process.env) {
  const t = { eth: '10', btcAsEth: '10', ...((C && typeof C.target === 'object' && C.target) || {}) };
  if (env.FB_LP_TARGET_ETH != null && String(env.FB_LP_TARGET_ETH).trim() !== '') { t.eth = String(env.FB_LP_TARGET_ETH).trim(); t.btcAsEth = t.eth; }
  const v = (k) => { if (!/^\d{1,6}(\.\d{1,8})?$/.test(String(t[k]))) throw new Error(`target.${k} must be an amount of ETH (got "${t[k]}")`); return units(t[k]); };
  return { eth: v('eth'), btcAsEth: v('btcAsEth') };
}

export function planBuyback({ owed, ethFree, targetEth, aboveTarget, dayRouted = 0n, cfg, quiet = true }) {
  if (!cfg || !cfg.enabled) return { skip: 'off' };
  if (!aboveTarget) return { skip: 'under the target: the net stays as capacity' };
  if (!quiet) return { skip: 'a swap is under way' };
  const over = ethFree == null ? 0n : BigInt(ethFree) - BigInt(targetEth);
  let a = BigInt(owed);
  for (const cap of [over, cfg.maxPerSend, cfg.maxPerDay - BigInt(dayRouted)]) if (cap < a) a = cap;
  if (a < cfg.minSend) return { skip: `${a > 0n ? a : 0n} can be sent now, under the least of ${cfg.minSend}` };
  return { amount: a };
}

// The TAC bought with the provider's ETH. The contract's ETH is one pot: at each buy (in order), the provider's part of it is what it sent and has not yet been
// counted spent, over the contract's ETH just before the buy (`balanceBefore(ev)` -> wei, read at the block before). Its share of the buy's ETH, and of the TAC, follow.
export async function attributeBuys({ events, pending, balanceBefore }) {
  let p = BigInt(pending), tac = 0n, used = 0n;
  for (const ev of events) {
    if (p <= 0n) break;
    const ethIn = BigInt(ev.ethIn), tacOut = BigInt(ev.tacOut);
    if (ethIn <= 0n) continue;
    let bal = null;
    try { bal = BigInt(await balanceBefore(ev)); } catch { bal = null; }
    if (bal == null || bal <= 0n) continue;                          // (a balance that cannot be read: that buy is not counted, so the TAC shown is never more than bought)
    if (bal < p) bal = p;
    let mine = (ethIn * p) / bal;
    if (mine > p) mine = p;
    tac += (tacOut * mine) / ethIn; used += mine; p -= mine;
  }
  return { tac, used, pending: p };
}
