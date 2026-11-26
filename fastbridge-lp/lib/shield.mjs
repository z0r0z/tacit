// Shields the public ETH of the provider's own address into private notes of its key, so ETH sent to its pool account is lent without anyone running
// tools/fastbridge-lp-shield.mjs. Off unless FB_LP_AUTO_SHIELD=on.
//
//   FB_LP_AUTO_SHIELD=on        start (off unless set)
//   FB_LP_SHIELD_RESERVE_ETH    the public ETH it never touches, for gas (0.02)
//   FB_LP_SHIELD_MIN_ETH        the smallest chunk it deposits (0.02)
//   FB_LP_SHIELD_EVERY_SECS     the least gap between deposits (600)
//
// One deposit at a time, and each is kept in `shield` (durable) from before it is sent: { nextIndex, pending: { index, amountWei, nonce, tx, phase } }.
// The key's next wrap index is kept there too; it is read from the pool's history (ux.nextWrapIndex, minutes) only when none is kept. A deposit that
// would revert (a used index shows as DepositExists) is not sent. Anything odd stops the step and is alerted; a pending deposit is settled after a
// restart, never sent again.
//
//   await s.step() -> { did }      s.info() -> what /info shows

import { checkDeposit, sendDeposit, waitMined, settleDeposit, GAS_KEPT } from './shield-core.mjs';

const TICKER = 'cETH';
const UNIT = 10n ** 10n;                                          // wei in one pool unit
const DROP = 10n ** 16n;                                          // a fall of the public ETH this big with nothing of ours under way is not gas
const err = (e) => String((e && e.message) || e).slice(0, 200);
const eth = (wei) => (Number(BigInt(wei) / UNIT) / 1e8).toFixed(4);

export function shieldConfig(env = process.env) {
  const sw = env.FB_LP_AUTO_SHIELD != null ? String(env.FB_LP_AUTO_SHIELD).trim().toLowerCase() : '';
  if (sw && sw !== 'on' && sw !== 'off') throw new Error(`FB_LP_AUTO_SHIELD must be on or off (got "${env.FB_LP_AUTO_SHIELD}")`);
  const amt = (k, d) => {
    const t = String(env[k] ?? d).trim();
    if (!/^\d{1,6}(\.\d{1,8})?$/.test(t)) throw new Error(`${k} must be an amount of ETH (got "${env[k]}")`);
    const [w, f = ''] = t.split('.');
    return (BigInt(w) * 10n ** 8n + BigInt(f.padEnd(8, '0'))) * UNIT;
  };
  const secs = Number(env.FB_LP_SHIELD_EVERY_SECS ?? 600);
  if (!Number.isInteger(secs) || secs < 30 || secs > 86400) throw new Error(`FB_LP_SHIELD_EVERY_SECS must be a whole number from 30 to 86400 (got "${env.FB_LP_SHIELD_EVERY_SECS}")`);
  const c = { enabled: sw === 'on', reserveWei: amt('FB_LP_SHIELD_RESERVE_ETH', '0.02'), minWei: amt('FB_LP_SHIELD_MIN_ETH', '0.02'), everySecs: secs };
  if (c.reserveWei < GAS_KEPT) throw new Error('FB_LP_SHIELD_RESERVE_ETH must keep at least 0.0005 ETH for gas');
  if (c.minWei <= 0n) throw new Error('FB_LP_SHIELD_MIN_ETH must be more than 0');
  return c;
}

export function makeShield({ cfg, ux, key, address, quiet = async () => true, turn = (fn) => fn(), load, save, now = () => Math.floor(Date.now() / 1000), log = () => {}, alert = () => {}, waitTries = 90, waitMs = 4000 }) {
  let st = null, busy = false, halted = null, bal = null, nextAt = -Infinity, stuckSaid = -Infinity;
  const ethOf = async () => BigInt(await ux.rpc('eth_getBalance', [address, 'latest']));
  const keep = () => save({ id: 'shield', ...st });
  const stop = (why, o = {}) => { halted = why; alert({ level: 'error', msg: `auto-shield: stopped: ${why}`, ...o }); return { did: 'halted' }; };

  async function state() {
    if (st) return st;
    const kept = await load().catch(() => null);
    st = { nextIndex: null, pending: null, shielded: '0', count: 0, lastTx: null, lastAt: null, ...(kept && kept.v === 1 ? kept : {}), v: 1 };
    return st;
  }

  async function index() {
    if (Number.isInteger(st.nextIndex)) return st.nextIndex;
    log({ level: 'info', msg: 'auto-shield: reading the pool history for the key\'s next wrap index (once)' });
    const i = await ux.nextWrapIndex({ walletPriv: key, ticker: TICKER });
    if (!Number.isInteger(i) || i < 0) throw new Error('the next wrap index could not be read');
    st.nextIndex = i; await keep();
    return i;
  }

  // a deposit that is on the way or on the chain: waited for, then settled
  async function finish() {
    const p = st.pending, amountWei = BigInt(p.amountWei);
    if (!p.tx) {
      // killed between the record and the send: sent if the account's nonce moved
      const n = Number(BigInt(await ux.rpc('eth_getTransactionCount', [address, 'pending'])));
      if (n > p.nonce) return stop('a deposit may have been sent without its transaction being kept; check the address\'s transactions before setting FB_LP_AUTO_SHIELD again', { index: p.index });
      st.pending = null; await keep();
      return { did: 'cleared' };
    }
    let receipt = p.phase === 'mined' ? { status: '0x1' } : await waitMined(ux, p.tx, { tries: waitTries, delayMs: waitMs });
    if (!receipt) {
      if (now() - (p.at || 0) > 3600 && now() - stuckSaid > 21600) { stuckSaid = now(); alert({ level: 'warn', msg: 'auto-shield: a deposit has not been mined for over an hour', tx: p.tx, index: p.index }); }
      return { did: 'pending' };
    }
    if (receipt.status !== '0x1') { st.pending = null; st.nextIndex = null; await keep(); return stop('a deposit reverted', { tx: p.tx, index: p.index }); }
    if (p.phase !== 'mined') { p.phase = 'mined'; await keep(); }
    // the deposit is rebuilt from its index: the same note, so the settle is the one the deposit asked for
    const built = await ux.buildRouterWrap({ walletPriv: key, amountWei, ticker: TICKER, index: p.index });
    try { await settleDeposit({ ux, key, address, sent: { ...built, from: address, txHash: p.tx }, turn }); }
    catch (e) { return stop('a deposit was made and its settle did not go through; it is not repeated', { tx: p.tx, index: p.index, error: err(e) }); }
    st.pending = null; st.nextIndex = p.index + 1; st.shielded = String(BigInt(st.shielded) + amountWei); st.count += 1; st.lastTx = p.tx; st.lastAt = now();
    bal = null; nextAt = now() + cfg.everySecs;
    await keep();
    log({ level: 'info', msg: 'auto-shield: shielded', eth: eth(amountWei), index: p.index, tx: p.tx });
    return { did: 'shielded', amount: amountWei };
  }

  async function step() {
    if (!cfg.enabled) return { did: 'off' };
    if (halted) return { did: 'halted' };
    if (busy) return { did: 'busy' };
    busy = true;
    try {
      await state();
      if (st.pending) return finish();
      if (now() < nextAt) return { did: 'wait' };
      if (!(await quiet())) return { did: 'quiet' };
      const have = await ethOf();
      if (bal != null && have + DROP < bal) { const was = bal; bal = have; alert({ level: 'warn', msg: 'auto-shield: the address\'s ETH fell without anything of the provider\'s under way; no deposit this time', was: eth(was), now: eth(have) }); return { did: 'dropped' }; }
      bal = have;
      const room = have > cfg.reserveWei ? have - cfg.reserveWei : 0n;
      const amountWei = room - (room % UNIT);
      if (amountWei < cfg.minWei) return { did: 'low' };
      const at = await index();
      try { await checkDeposit({ ux, key, address, amountWei, ticker: TICKER, index: at }); }
      catch (e) {
        if (e && e.duplicate) { st.nextIndex = null; await keep(); return stop(`wrap index ${at} is already used on the pool; restart to read the history again`, { index: at }); }
        alert({ level: 'warn', msg: 'auto-shield: the deposit would not go through, so nothing was sent', error: err(e) });
        nextAt = now() + cfg.everySecs;
        return { did: 'failed' };
      }
      // recorded before it is sent, so a restart finds it
      const nonce = Number(BigInt(await ux.rpc('eth_getTransactionCount', [address, 'pending'])));
      st.pending = { index: at, amountWei: String(amountWei), nonce, tx: null, phase: 'sent', at: now() };
      await keep();
      let sent;
      try { sent = await turn(() => sendDeposit({ ux, key, amountWei, ticker: TICKER, index: at })); }
      catch (e) { st.pending = null; await keep(); alert({ level: 'warn', msg: 'auto-shield: the deposit could not be sent', error: err(e) }); nextAt = now() + cfg.everySecs; return { did: 'failed' }; }
      st.pending.tx = sent.txHash; await keep();
      log({ level: 'info', msg: 'auto-shield: deposit sent', eth: eth(amountWei), index: at, tx: sent.txHash });
      return finish();
    } catch (e) {
      alert({ level: 'warn', msg: 'auto-shield: a step failed', error: err(e) });
      return { did: 'failed' };
    } finally { busy = false; }
  }

  const info = () => ({ on: !!cfg.enabled, halted, reserveEth: eth(cfg.reserveWei), minEth: eth(cfg.minWei), pending: st && st.pending ? { index: st.pending.index, tx: st.pending.tx } : null, shielded: st ? { eth: eth(st.shielded), count: st.count, lastTx: st.lastTx, lastAt: st.lastAt } : null });
  return { step, info, halted: () => halted };
}
