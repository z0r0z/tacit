import { getUx, forgetUx } from '/trade/poolux.js?cb=e792b253';
import { WRAP_TIP, WRAP_WITH_TIP, CETH_ID, POOL } from '/teth/read.js?cb=b2a110d0';
import { strip, word, rpc, ethCall, api, E10 } from '/trade/util.js?cb=509d6618';

export { getUx, forgetUx };

export const wrapCalldata = ({ commit, wei, to }) => WRAP_WITH_TIP + strip(commit).padStart(64, '0') + word(wei) + strip(to).toLowerCase().padStart(64, '0');

const declined = (e) => e?.code === 4001 || /user (rejected|denied)|rejected the request|denied transaction/i.test(String(e?.shortMessage || e?.message || e || ''));

export const wrapIssue = (wei) => (wei <= 0n ? 'Enter an amount.' : wei % E10 !== 0n ? 'Up to 8 decimals.' : null);

const STATES = ['ok', 'busy', 'held', 'paused', 'down'];
let stateRead = null;
export function relayState() {
  if (stateRead && Date.now() - stateRead.at < 15e3) return stateRead.p;
  const p = Promise.race([api('/confidential/relay'), new Promise((r) => setTimeout(r, 5e3, null))]).then((b) => (b && STATES.includes(b.state)
    ? { state: b.state, proving: typeof b.proving === 'boolean' ? b.proving : !['paused', 'down'].includes(b.state), settling: typeof b.settling === 'boolean' ? b.settling : ['ok', 'busy'].includes(b.state), board: b.board === true }
    : null));
  stateRead = { at: Date.now(), p };
  return p;
}
export const relayStopped = (rs) => rs?.state === 'paused' || rs?.state === 'down';

function halted(rs, queued) {
  const held = rs.state === 'held';
  return Object.assign(new Error(held ? 'The relay can’t send this one right now.' : 'The relay isn’t proving right now.'), { code: held ? 'relay_held' : 'relay_paused', queued, proving: rs.proving, relay: rs });
}
function watchRelay(stops, queued) {
  let timer = 0, started = false, over = false, why = null, end;
  const ended = new Promise((_, no) => { end = no; });
  ended.catch(() => {});
  const tick = async () => {
    const rs = await relayState();
    if (over) return;
    if (rs && stops(rs)) { why = halted(rs, queued); over = true; end(why); return; }
    timer = setTimeout(tick, 15e3);
  };
  return {
    start() { if (!started) { started = true; tick(); } },
    sleep: (ms) => (why ? Promise.reject(why) : new Promise((r) => setTimeout(r, ms))),
    race: (p) => Promise.race([p, ended]),
    quiet() { over = true; clearTimeout(timer); },
    get why() { return why; },
  };
}

export async function wrapEth({ priv, wei, tip, to, from, wallet, say = () => {}, ux = null, own = null, self = false }) {
  const t = ux || await getUx();
  say('prepare');
  const index = await t.nextWrapIndex({ walletPriv: priv(), ticker: 'cETH' });
  const built = t.buildWrap({ walletPriv: priv(), amountWei: wei, ticker: 'cETH', index });
  say('confirm');
  let hash;
  try { hash = await wallet.sendTx({ to: WRAP_TIP, data: wrapCalldata({ commit: built.commit, wei, to }), value: wei + tip, from }); }
  catch (e) {
    // Declined in the wallet: nothing was sent, so the index goes back (recovery from the key stops after 24 unused ones in a row).
    if (declined(e)) try { t.releaseWrapIndex?.({ walletPriv: priv(), ticker: 'cETH', index }); } catch { }
    throw e;
  }
  say('sent', hash);
  let rc;
  try { rc = await wallet.receipt(hash); } catch (e) { throw Object.assign(e, { deposit: { hash, built, landed: false } }); }
  if (rc.status !== '0x1') throw Object.assign(new Error(`The transaction failed (${hash.slice(0, 10)}…). Nothing was lost but its network fee.`), { reverted: true });
  return own ? proveOwn({ t, built, hash, wallet, from, prover: own, say }) : self ? proveRelay({ t, built, hash, wallet, from, say }) : settle({ t, built, hash, say });
}
export async function proveRelay({ t = null, built, hash = null, wallet, from, say = () => {} }) {
  const ux = t || await getUx();
  say('proving', hash);
  try { return await selfFinish({ t: ux, built, hash, wallet, from, say: (k, d) => { if (k !== 'proving' && k !== 'stage') say(`settle-${k}`, d); } }); }
  catch (e) { throw Object.assign(e, { deposit: { hash, built, landed: true, jobId: e.open?.jobId || null } }); }
}
export async function proveOwn({ t = null, built, hash = null, wallet, from, prover, say = () => {} }) {
  const ux = t || await getUx();
  const step = (k, d) => say(k === 'proving' ? 'input' : k === 'stage' ? 'stage' : `settle-${k}`, d);
  ux.relay.useProver(prover.prove);
  try { return await selfFinish({ t: ux, built, hash, wallet, from, say: step }); }
  catch (e) { throw Object.assign(e, { deposit: { hash, built, landed: true, own: true } }); }
  finally { ux.relay.useProver(null); }
}
export async function settle({ t = null, built, hash = null, say = () => {} }) {
  const ux = t || await getUx();
  say('proving', hash);
  let jobId = null;
  const w = watchRelay((rs) => rs.state === 'held' || relayStopped(rs), true);
  try { await w.race(ux.submitWrapSettle({ built, waitOpts: { timeoutMs: 15 * 60e3, intervalMs: 4000, viaRelay: true, sleep: w.sleep, onJob: (id) => { jobId = id; w.start(); } }, depositTx: hash })); }
  catch (e) { throw Object.assign(e, { deposit: { hash, built, landed: true, jobId: jobId || e.open?.jobId || null } }); }
  finally { w.quiet(); }
  return { hash, built };
}

export function relayWords(e) {
  const m = String(e?.message || e || ''), code = e?.code;
  if (code === 'open' || e?.open || /settle held|waiting for a sender/i.test(m)) return 'Your note is proved and waiting to be sent. Anyone can send it, and it goes through on its own once a relay does.';
  if (code === 'prove_budget') return 'The relay has made as many proofs as it can for today. Try again after midnight UTC. Your deposit is safe and waits to be finished.';
  if (code === 'relay_paused') return `${e.proving ? 'The relay can’t send this one right now.' : 'The relay isn’t proving right now.'} ${e.queued ? 'Your deposit is safe and keeps its place in line: it goes through once the relay is back.' : 'Your deposit is safe and waits to be finished.'}`;
  if (code === 'relay_held' && e.queued) return 'The relay can’t send this one right now. It still proves it, so your wallet can send the settle.';
  if (code === 'relay_held' || /can.t take this one/i.test(m)) return 'The relay can’t take this one right now. Your deposit is safe and waits to be finished.';
  if (code === 'free_budget' || /free relayed settles for today are used up/i.test(m)) return 'The relay’s free settles for today are used up. They open again at midnight UTC.';
  if (/settle timed out|status polling for job/i.test(m)) return 'The relay is still working on it. It goes through on its own, so there is no need to send the deposit again.';
  if (/prove timed out/i.test(m)) return 'The relay is taking longer than usual to prove it, and this page stopped waiting.';
  if (/relay lost the job/i.test(m)) return 'The relay lost track of this request.';
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Could not reach the relay.';
  return m.replace(/^Error:\s*/, '').replace(/\brelayer/gi, 'relay').slice(0, 220);
}

const proveAmt = (wei) => (Number(wei) / 1e18).toFixed(2);
export function ownWords(e) {
  if (e?.code === 'prover_credit') return `Your prover credit is ${proveAmt(e.have ?? 0n)} PROVE, and a proof needs about ${proveAmt(e.need ?? 0n)} PROVE on hand.`;
  if (e?.code === 'not_proved') return 'Succinct’s prover did not take it in time. Nothing was sent. The network kept its base fee (about 0.39 PROVE). Try again, or let the relay prove this one.';
  return relayWords(e);
}
export const ownable = (e) => e?.code === 'prove_budget' || e?.code === 'relay_paused' || /prove (failed|timed out)|prove capacity/i.test(String(e?.message || ''));

const WRAP_SETTLE_GAS = 593_000n;
const DEPOSIT_STATUS = '0x7da9874f';

export function selfable(e) {
  if (!e) return false;
  if (e.open) return true;
  if (e.code === 'prove_budget') return false;
  if (e.code === 'relay_paused') return !!e.proving;
  if (['relay_held', 'free_budget', 'open'].includes(e.code) || e.httpStatus === 429 || e.httpStatus >= 500) return true;
  return /settle held|waiting for a sender|can.t take this one|free relayed settles|settle timed out|status polling for job|relay lost the job|settle failed/i.test(String(e.message || e));
}

export async function settleCost() {
  try { return WRAP_SETTLE_GAS * BigInt(await rpc('eth_gasPrice', [])); } catch { return null; }
}

async function consumed(built) {
  if (!built?.depositId) return false;
  try { const r = await ethCall(POOL, DEPOSIT_STATUS + strip(built.depositId).padStart(64, '0')); return !!r && r !== '0x' && BigInt(r) === 2n; } catch { return false; }
}

function memosFor(ux, built, memos) {
  if (!Array.isArray(memos)) return null;
  try { return ux.relay.provenMemos({ memos }, { leaves: [built.leaf], outputs: built.outputs }, built.memos || []); } catch { return null; }
}

export async function selfFinish({ t = null, built, hash = null, jobId = null, open = null, wallet, from, say = () => {} }) {
  const ux = t || await getUx();
  const w = ux.relay.ownProving?.() ? null : watchRelay((rs) => relayStopped(rs) && !rs.proving, false);
  const watched = (p) => { if (!w) return p; w.start(); return w.race(p); };
  const waitOpts = { timeoutMs: 15 * 60e3, intervalMs: 4000, onUpdate: (st) => { if (st?.stage) say('stage', st.inputPublic ? `${st.stage}:public` : st.stage); }, ...(w ? { sleep: w.sleep, viaRelay: true } : {}) };
  let mine = null;
  async function send({ jobId: id, publicValues, proof, memos }) {
    if (w?.why) throw w.why;
    w?.quiet();
    const data = ux.settleCalldata({ publicValues, proof, memos });
    say('check');
    try { await rpc('eth_call', [{ from, to: POOL, data }, 'latest']); }
    catch (e) {
      if (await consumed(built)) return { txHash: null, already: true };
      throw new Error(e?.revert ? 'The settle would not go through, so nothing was sent. Try again in a moment.' : 'The settle could not be checked, so nothing was sent. Try again in a moment.');
    }
    say('confirm');
    const txHash = await wallet.sendTx({ to: POOL, data, from });
    say('sent', txHash);
    const rc = await wallet.receipt(txHash);
    if (rc.status !== '0x1') {
      if (await consumed(built)) return { txHash: null, already: true };
      throw new Error('The settle failed. Nothing was lost but its network fee, and the deposit still waits to be finished.');
    }
    mine = txHash;
    if (id) await ux.relay.landed(id, txHash);
    return { txHash };
  }
  const done = (txHash = mine) => ({ hash, built, txHash, already: !mine });
  try {
    if (await consumed(built)) return done();
    let pr = open?.publicValues && open?.proof ? open : null;
    const rs = !pr && jobId && w ? await relayState() : null;
    if (!pr && jobId && !(rs?.state === 'held' && !rs.board)) {
      say('proving');
      try {
        const st = await watched(ux.relay.waitForSettle(jobId, { ...waitOpts, openGraceMs: 0 }));
        return done(st.txHash || null);
      } catch (e) {
        if (e?.open) pr = e.open;
        else if (!/settle failed|relay lost the job/i.test(String(e?.message || ''))) throw e;
      }
    }
    if (pr) {
      const memos = memosFor(ux, built, pr.memos);
      if (memos) {
        const sent = await send({ ...pr, memos });
        if (sent.txHash) await ux.relay.verifyEmittedMemos({ jobId: pr.jobId, status: 'settled', txHash: sent.txHash }, [built.leaf], memos);
        return done();
      }
    }
    say('proving');
    const r = await watched(ux.submitWrapSettle({ built, waitOpts, depositTx: hash, selfSettle: send }));
    return done(mine || r?.txHash || null);
  } finally { w?.quiet(); }
}

export async function readHeld({ priv, ux = null }) {
  const t = ux || await getUx();
  const r = await t.balance(priv(), { cbtc: false, bridge: false, positions: true });
  const g = r.byAsset?.[CETH_ID], notes = g?.notes || [];
  const pending = (r.diag?.wrap?.pending || []).filter((d) => String(d.asset).toLowerCase() === CETH_ID).map((d) => ({ index: d.index, value: BigInt(d.value), txHash: d.txHash || null, depositId: d.depositId || null }));
  return { value: g ? BigInt(g.value) : 0n, notes: notes.length, pending, positions: Array.isArray(r.farmPositions) && !r.diag?.errors?.farm ? r.farmPositions : null, partial: Object.keys(r.diag?.errors || {}).length > 0, errors: r.diag?.errors || {} };
}
export async function finish({ priv, pending, ux = null, say = () => {}, self = null, own = null }) {
  const t = ux || await getUx();
  let done = 0, err = null;
  const left = [];
  for (const [i, p] of pending.entries()) {
    const jobId = p.jobId || null;
    try {
      const built = t.buildWrap({ walletPriv: priv(), amountWei: p.value * E10, ticker: 'cETH', index: p.index });
      say('proving', p.txHash);
      if (own) await proveOwn({ t, built, hash: p.txHash, wallet: own.wallet, from: own.from, prover: own.prover, say });
      else if (self) await selfFinish({ t, built, hash: p.txHash, jobId, open: p.open || null, ...self, say });
      else await settle({ t, built, hash: p.txHash });
      done++;
    } catch (e) {
      err ||= e; left.push({ ...p, jobId: e?.deposit?.jobId || jobId || e?.open?.jobId || null, open: e?.open || null });
      if (own) { left.push(...pending.slice(i + 1)); break; }
    }
  }
  return { done, err, left };
}
