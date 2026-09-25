// Mix panel of the Secret Sats page: Secret Sats Join (contracts/sp1/confidential/DESIGN-secret-sats-join.md,
// client ../secret-sats-join.js). mount(el, ctx) renders the steps into el; the step styles live in index.html.
//   ctx = { tacit, wallet, network, log, refresh, ensureKey, track, errMsg, onWallet, secretModule, secretHandle,
//           hintEl, openMix }
//   secretModule() resolves to the page's secret.js module (faucet sale, pool, prover); secretHandle() is its
//   mounted instance, so a pool note bought here unlocks the Secret payment steps.
//
// 1. Entry: one output of o + f_in + margin to the wallet's own silent address (version-1 identity), paid from
//    plain sats that no Tacit validator claims. It is recorded as a silent-payment credit of class 'entry'.
// 2. It ages AGE_MIN blocks.
// 3. A round on a join board: the output keys are shuffled, the transaction is rebuilt and checked here, and
//    this wallet signs only when its own output is in it.
// 4. After confirmation the wallet finds its output by scanning the join with its scan key. The output is a
//    credit of class 'mixed': the plain Send never spends it.
// 5. Optional: that output alone funds a buy-and-shield of test cBTC; the change is ordinary sats again.

import * as J from '/secret-sats-join.js?cb=7e817f1c';
import { makeBtcPoolZap, makeNoteResolver } from '/btc-pool-zap.js?cb=f672a6c1';
import { makeBtcWallet } from '/bitcoin-taproot-wallet.js?cb=d9c3aab4';
import { secp, sha256, keccak_256, bytesToHex } from '../vendor/tacit-deps.min.js';

const WORKER_URL = '/sats/join-worker.js?cb=2ad4d02d';
const BOARDS_URL = '/sats/join-boards.json';
const TIER = { signet: 10_000 };
const AGE = J.AGE_MIN;
const POLL_MS = 30_000;
const DEMO_KEY = (net, pub) => `tacit-sats-demo-v2:${net}:${pub}`;
const STATE_KEY = (net, pub) => `tacit-sats-mix-v1:${net}:${pub}`;
const EXCL_KEY = (net) => `tacit-join-exclusions-v1:${net}`;

const STEPS = [
  { id: 'entry', title: 'Make an entry' },
  { id: 'age', title: 'Let it settle' },
  { id: 'round', title: 'Join a round' },
  { id: 'find', title: 'Find your mixed coin' },
  { id: 'use', title: 'Get private cBTC with it', optional: true },
];

const CHECKS = {
  '1-shape': 'Standard join shape',
  '2-inputs': 'Inputs are the round’s coins, fees covered',
  '3-outputs': 'Equal outputs, one per coin',
  '4-own-output': 'Your output is in it',
  '5-k-eff': 'Enough independent coins',
  '6-own-excess': 'Your fee share within limits',
  '7-size-fee': 'Size and fee rate',
};

const STEP_WORDS = { KE: 'exchanging keys', CM: 'committing', DC: 'shuffling', CONF: 'checking the shuffle', REVEAL: 'a check failed; finding who', SIG: 'signing' };

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const c of kids) if (c != null && c !== '') n.append(c);
  return n;
}
const n = (x) => Number(x).toLocaleString('en-US');
const sats = (x) => `${n(x)} sats`;

// ── power-sum decoding in a Worker; inline when a Worker cannot start ──
let worker = null, seq = 0;
const waits = new Map();
function decodeOffThread(S) {
  if (worker === false) return J.decodePowerSums(S);
  try {
    if (!worker) {
      worker = new Worker(WORKER_URL, { type: 'module' });
      worker.onmessage = ({ data }) => { const w = waits.get(data.id); waits.delete(data.id); w?.(data); };
      worker.onerror = () => { worker = false; for (const [id, w] of waits) { waits.delete(id); w({ fallback: true }); } };
    }
  } catch { worker = false; return J.decodePowerSums(S); }
  return new Promise((resolve) => {
    const id = ++seq;
    waits.set(id, (d) => resolve(d.fallback || d.err ? J.decodePowerSums(S) : d.keys ? d.keys.map(BigInt) : null));
    worker.postMessage({ id, S: S.map(String) });
  });
}

// Board list: the pinned join-boards.json, or window.__JOIN_BOARDS__ (tests). Over Tor a board's onion URL.
async function loadBoards(network) {
  let list = globalThis.__JOIN_BOARDS__;
  if (!Array.isArray(list)) {
    try { list = (await (await fetch(BOARDS_URL, { cache: 'no-store' })).json()).boards; } catch { list = []; }
  }
  const onTor = /\.onion$/i.test(location.hostname);
  return (list || []).filter((b) => b.network === network && b.url).map((b) => ({ ...b, url: (onTor && b.onion) || b.url, tor: onTor && !!b.onion }));
}

// One line for an error from the Join client, the board or the chain.
function joinError(e, ctx) {
  const m = String(e?.message || e || '');
  if (/^board .*HTTP (5\d\d|0)|Failed to fetch|NetworkError|Load failed/i.test(m)) return 'The join board is unreachable. Try again in a minute.';
  if (/coin is spent/.test(m)) return 'Your entry coin is already spent.';
  if (/coin is unconfirmed/.test(m)) return 'Your entry is not confirmed yet.';
  if (/join: coins cover (\d+), need (\d+)/.test(m)) { const [, h, w] = m.match(/cover (\d+), need (\d+)/); return `Not enough sats: the entry needs ${sats(w)}, you have ${sats(h)}.`; }
  if (/btc-pool-zap: need (\d+) sats, have (\d+)/.test(m)) return 'The mixed coin does not cover the lot price and fees.';
  if (/no open faucet sale|already spent|race lost/.test(m)) return 'Someone took that lot first. Try again; the faucet keeps a few listed.';
  if (/^join: /.test(m)) { const t = m.slice(6); return t.charAt(0).toUpperCase() + t.slice(1) + '.'; }
  return ctx.errMsg ? ctx.errMsg(e) : m.split('\n')[0];
}

export function mount(root, ctx) {
  const { tacit } = ctx;
  const network = ctx.network || tacit.NET?.name || 'signet';
  const log = ctx.log || (() => {});
  const explorer = tacit.NET?.explorer || 'https://mempool.space/signet';
  const txLink = (txid, label) => el('a', { href: `${explorer}/tx/${txid}`, target: '_blank', rel: 'noopener noreferrer' }, label || `${txid.slice(0, 10)}…`);
  const d = TIER[network];
  const params = d ? J.networkParams(network) : null;
  const bases = Array.isArray(globalThis.__JOIN_ESPLORA__) ? globalThis.__JOIN_ESPLORA__ : [tacit.NET?.api, tacit.NET?.api2].filter(Boolean);
  const chain = J.makeEsploraChain(bases, { minGapMs: 100 });
  const exclusions = J.makeExclusionList({
    get: () => { try { return localStorage.getItem(EXCL_KEY(network)); } catch { return null; } },
    set: (v) => { try { localStorage.setItem(EXCL_KEY(network), v); } catch {} },
  });

  let who = null;           // { connected, unlocked, pubHex, sats }
  let state = {};           // per wallet, in localStorage
  let boards = null;        // [{ name, url, boardKey, tor }]
  let running = null;       // step id in flight
  let live = null;          // round progress while running
  let abort = null;         // AbortController of the running round
  let chainInfo = { tip: null, entryHeight: null, roundHeight: null };
  let estimate = null;      // { frOwn, fr, value, entryFee }
  const errs = {};
  const progress = {};

  const key = () => (who?.pubHex ? STATE_KEY(network, who.pubHex) : null);
  const load = () => { try { return JSON.parse((key() && localStorage.getItem(key())) || '{}') || {}; } catch { return {}; } };
  const save = () => { try { if (key()) localStorage.setItem(key(), JSON.stringify(state)); } catch {} };

  const intro = el('div');
  const list = el('ol', { class: 'steps', 'aria-label': 'Mix steps' });
  root.replaceChildren(intro, list);
  const sections = {};
  STEPS.forEach((s, i) => {
    const num = el('span', { class: 'step-n', 'aria-hidden': 'true' }, String(i + 1));
    const status = el('span', { class: 'step-status', 'aria-live': 'polite' });
    const body = el('div', { class: 'step-body' });
    const sec = el('li', { class: 'step', 'data-step': s.id }, num,
      el('div', {}, el('div', { class: 'step-head' }, el('span', { class: 'step-title' }, s.title), status), body));
    sections[s.id] = { sec, num, status, body, index: i + 1 };
    list.append(sec);
  });

  const keysV1 = () => tacit.deriveWalletSilentPaymentKeys(ctx.wallet.priv, 1);
  const confs = (h) => (h && chainInfo.tip ? chainInfo.tip - h + 1 : 0);
  const unusedMixed = () => (state.coins || []).filter((c) => !c.used);

  // ── steps ──
  async function run(id, fn, { needKey = true } = {}) {
    if (running) return;
    running = id; errs[id] = null; progress[id] = 'working…';
    render();
    const say = (m) => { progress[id] = m; sections[id].status.textContent = m; };
    try {
      if (needKey) await ctx.ensureKey?.();
      await fn(say);
    } catch (e) {
      errs[id] = joinError(e, ctx);
      if (!/^Cancelled/.test(errs[id])) console.warn('[sats] mix', id, e);
    } finally {
      running = null; progress[id] = null;
      render();
      schedule();
    }
  }

  function button(label, onClick, { disabled = false, quiet = false } = {}) {
    const b = el('button', { class: `btn${quiet ? ' quiet sm' : ''}`, type: 'button' }, label);
    b.disabled = disabled || !!running;
    b.addEventListener('click', onClick);
    return b;
  }
  const put = (node, ...kids) => node.append(...kids.filter((k) => k != null && k !== ''));
  const errLine = (id) => (errs[id] ? el('div', { class: 'err', role: 'alert' }, errs[id]) : null);

  function phases() {
    const out = {};
    const done = {
      entry: !!state.entry,
      age: !!state.entry && (state.entry.aged || confs(chainInfo.entryHeight) >= AGE),
      round: !!state.round,
      find: !!state.round && (state.coins || []).some((c) => c.txid === state.round.txid),
      use: !!state.zap,
    };
    let open = !!who?.connected && !!d;
    for (const { id } of STEPS) {
      if (running === id) { out[id] = 'active'; open = false; }
      else if (done[id]) out[id] = 'done';
      else if (open) { out[id] = 'active'; open = false; }
      else out[id] = 'locked';
    }
    // A mixed coin from an earlier round keeps step 5 open.
    if (out.use === 'locked' && !running && unusedMixed().length) out.use = 'active';
    return out;
  }

  function setPhase(id, phase, status = '') {
    const S = sections[id];
    S.sec.className = `step is-${phase}${running === id ? ' is-running' : ''}`;
    S.num.textContent = phase === 'done' ? '✓' : String(S.index);
    if (phase === 'active') S.sec.setAttribute('aria-current', 'step'); else S.sec.removeAttribute('aria-current');
    const line = running === id ? (progress[id] || 'working…') : status;
    if (S.status.textContent !== line) S.status.textContent = line;
    S.body.replaceChildren();
    return S;
  }

  // Fee bucket and entry value from the wallet's own fee estimate.
  async function refreshEstimate() {
    if (!d) return;
    let frOwn = 1;
    try { frOwn = Math.max(1, Math.ceil(Number(await tacit.getFeeRate()) || 1)); } catch {}
    const fr = J.chooseBucket(frOwn);
    const value = J.entryOutputValue({ d, fr, kMin: params.kMin });
    const entryFee = Math.ceil(((42 + 272 + 172 + 124) / 4) * frOwn);
    estimate = { frOwn, fr, value, entryFee, o: J.outputValue(d, fr) };
  }

  // Plain wallet coins for the entry: P2WPKH at the wallet address, outside every Tacit holding, and refused
  // one by one when validateOutpoint recognizes a Tacit UTXO.
  async function entryCoins(need, say) {
    const w = ctx.wallet;
    const all = await tacit.getUtxos(w.address());
    const plain = tacit.selectSatsUtxosSafe(all, await tacit.scanHoldings())
      .filter((u) => u.value > tacit.DUST)
      .sort((a, b) => ((b.status?.confirmed === true) - (a.status?.confirmed === true)) || b.value - a.value);
    const cache = new Map();
    const fetchTx = async (id) => { if (!cache.has(id)) cache.set(id, await tacit.getTx(id)); return cache.get(id); };
    const spk = bytesToHex(tacit.p2wpkhScript(w.pub));
    const picked = [];
    let total = 0;
    for (const u of plain) {
      say(`checking coin ${picked.length + 1}…`);
      let tacitUtxo = true;
      try { tacitUtxo = (await tacit.validateOutpoint(u.txid, u.vout, new Map(), fetchTx)) === true; } catch { tacitUtxo = true; }
      if (tacitUtxo) continue;
      picked.push({ txid: u.txid, vout: u.vout, value: u.value, spk, type: 'p2wpkh', priv: w.priv, pub33: bytesToHex(w.pub) });
      total += u.value;
      if (total >= need(picked.length)) return picked;
    }
    return picked;
  }

  async function makeEntry(say) {
    await refreshEstimate();
    const { fr, value, frOwn } = estimate;
    const keys = keysV1();
    const w = ctx.wallet;
    const changeSpk = tacit.p2wpkhScript(w.pub);
    const need = (k) => value + Math.ceil(((42 + 272 * k + 172 + 124) / 4) * frOwn) + 294;
    let e = null;
    for (let attempt = 0; attempt < 3 && !e; attempt++) {
      say('choosing coins…');
      const coins = await entryCoins(need, say);
      const have = coins.reduce((s, c) => s + c.value, 0);
      if (!coins.length || have < value + Math.ceil(((42 + 272 * coins.length + 172) / 4) * frOwn)) {
        throw new Error(`join: coins cover ${have}, need ${need(Math.max(1, coins.length)) - 294}`);
      }
      const built = J.buildEntryTx({ coins, keys: { scanPub: keys.scanPub, spendPub: keys.spendPub }, count: 1, value, changeSpk, feeRate: frOwn });
      say('sending the entry…');
      try { await tacit.broadcast(built.hex); e = built; }
      catch (err) {
        if (!/conflict|missingorspent|already spent/i.test(String(err?.message || err)) || attempt === 2) throw err;
      }
    }
    const out = e.outputs[0];
    tacit.recordSpCredit({ txidHex: e.txid, vout: out.vout, sats: value, tweakHex: out.tweak, keyVersion: 1, coinClass: 'entry' });
    state.entry = { txid: e.txid, vout: out.vout, value, tweak: out.tweak, fee: e.fee, fr, d, t: Date.now() };
    state.round = null; state.zap = null; state.candidates = []; state.lastRound = null;
    save();
    ctx.track?.(e.txid, `Mix entry ${sats(value)}`);
    log(`Entry sent: ${sats(value)} to your silent address.`);
    chainInfo.entryHeight = null;
    ctx.refresh?.();
  }

  // Round progress, shown while it runs and kept for the finished round.
  function progressList(p) {
    const at = p.stage;
    const rows = [
      ['Waiting for others', p.waitLine || ''],
      ['Shuffling', p.shuffleLine || ''],
      ['Checking your output', p.checks ? `${p.checks.filter((c) => c.ok).length} of ${p.checks.length} checks passed` : ''],
      ['Signed', p.signedLine || ''],
      ['Confirmed', p.confirmLine || ''],
    ];
    const ol = el('ol', { class: 'lines compact', 'aria-label': 'Round progress' });
    rows.forEach(([label, detail], i) => {
      const mark = i < at ? '✓ ' : i === at ? '● ' : '○ ';
      ol.append(el('li', { class: i < at ? '' : i === at ? '' : 'muted' }, el('span', {}, mark + label), el('span', {}, detail)));
    });
    return ol;
  }

  function checklist(checks) {
    if (!checks) return null;
    const ul = el('ul', { class: 'lines compact', 'aria-label': 'Checks before signing' });
    for (const c of checks) ul.append(el('li', {}, el('span', { class: c.ok ? '' : 'err' }, `${c.ok ? '✓' : '×'} ${CHECKS[c.id] || c.id}`), el('span', {}, c.detail)));
    return el('details', {}, el('summary', {}, `What your wallet checked before signing (${checks.filter((c) => c.ok).length}/${checks.length})`), ul);
  }

  async function joinRound(say) {
    const board = boards?.[0];
    if (!board) throw new Error('join: no join board is listed for this network');
    const http = J.makeHttpBoard(board.url);
    say('contacting the board…');
    const info = await http.info();
    if (info.network !== network) throw new Error(`join: the board runs ${info.network}`);
    if (board.boardKey && info.boardKey !== board.boardKey) throw new Error('join: the board’s key does not match the pinned one; not joining');
    const keys = keysV1();
    const e = state.entry;
    const coin = J.mixedCoin({ txid: e.txid, vout: e.vout, value: e.value, tweak: e.tweak, spendPriv: keys.spendPriv });
    const kMin = info.kMin || params.kMin;
    live = { stage: 0, waitLine: 'joining…' };
    abort = new AbortController();
    let topic = null, stopTopics = false;
    const watchTopic = async () => {
      while (!stopTopics) {
        try {
          const t = (await http.topics()).topics?.find((x) => x.topic === topic);
          if (t && live.stage === 0) {
            live.joins = t.joins;
            live.waitLine = t.joins < kMin ? `${t.joins} joined · waiting for ${kMin - t.joins} more` : `${t.joins} joined · starts at the next block`;
            say(live.waitLine);
            render();
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 10_000));
      }
    };
    const onEvent = (ev) => {
      if (ev.type === 'joined') { topic = ev.topic; live.waitLine = 'joined · counting others…'; watchTopic(); }
      else if (ev.type === 'formed') { live.stage = 1; live.n = ev.n; live.shuffleLine = `${ev.n} coins`; }
      else if (ev.type === 'run') { live.stage = 1; live.run = ev.r; live.shuffleLine = `${ev.n} coins${ev.r > 1 ? ` · run ${ev.r}` : ''}`; }
      else if (ev.type === 'step') {
        if (ev.step === 'CONF') live.stage = 2;
        if (ev.step === 'SIG') { live.stage = 3; live.signedLine = 'every input signed'; }
        else live.shuffleLine = `${live.n || ''} coins · ${STEP_WORDS[ev.step] || ev.step}`;
      } else if (ev.type === 'verify') { live.stage = 2; live.checks = ev.checks; }
      else if (ev.type === 'excluded') {
        live.stage = 1; live.checks = null;
        live.shuffleLine = `excluded ${ev.excluded.length} misbehaving coin${ev.excluded.length === 1 ? '' : 's'}; running again`;
      } else if (ev.type === 'broadcast') { live.stage = 4; live.signedLine = 'broadcast'; }
      const words = ['waiting for others', 'shuffling', 'checking your output', 'signed', 'broadcast'];
      say(live.stage === 0 ? live.waitLine : words[live.stage]);
      render();
    };
    let res;
    try {
      res = await J.runParticipant({
        board: http, chain, network, d: e.d, fr: e.fr, frOwn: e.fr, coin, keys: { scanPriv: keys.scanPriv, spendPub: keys.spendPub },
        exclusions, onEvent, decode: decodeOffThread, signal: abort.signal, ageMin: AGE, joinDelayMs: () => Math.random() * 5000,
      });
    } finally { stopTopics = true; abort = null; }
    if (res.candidates?.length) { state.candidates = [...(state.candidates || []), ...res.candidates.map((c) => ({ txid: c.txid, own: c.own?.[0] || null }))]; save(); }
    const last = { status: res.status, n: res.n || live.n || null, checks: live.checks || res.checks || null, t: Date.now() };
    state.lastRound = last;
    if (res.status === 'broadcast') {
      const own = res.own[0];
      state.round = { txid: res.txid, n: res.n, runs: res.runs, topic: res.topic, own: { vout: own.vout, value: own.value, tweak: own.tweak }, checks: live.checks, t: Date.now(), board: board.url };
      tacit.recordSpCredit({ txidHex: res.txid, vout: own.vout, sats: own.value, tweakHex: own.tweak, keyVersion: 1, coinClass: 'mixed' });
      save();
      ctx.track?.(res.txid, `Mixed with ${res.n - 1} others`);
      log(`Round signed by ${res.n} wallets. Waiting for a block.`);
      return;
    }
    save();
    if (res.status === 'cancelled') throw new Error('Cancelled. You left the round; your coin is untouched.');
    if (res.status === 'refused') {
      const bad = (res.checks || []).filter((c) => !c.ok).map((c) => CHECKS[c.id] || c.id);
      throw new Error(`Your wallet refused to sign (${bad.join(', ') || 'a check failed'}). Nothing was signed; your coin is untouched.`);
    }
    if (res.status === 'no-round') throw new Error(res.reason === 'below k_min' || res.reason === 'no CLOSE' ? `The round did not fill (it needs ${kMin}). Your coin is untouched; try again.` : 'This round did not admit your coin. It is untouched; try again.');
    throw new Error('Peers kept failing the round. Nothing went through; your coin is untouched. Try again.');
  }

  // After the round: the join confirmed → the output, found with the scan key alone.
  async function findOwn(txid) {
    const tx = await chain.getTx(txid);
    if (!tx?.status?.confirmed) return false;
    chainInfo.roundHeight = tx.status.block_height;
    const found = J.scanJoinForOwn(tx, keysV1());
    if (!found.length) throw new Error('join: the confirmed join pays no output this wallet can find');
    for (const f of found) {
      if ((state.coins || []).some((c) => c.txid === f.txid && c.vout === f.vout)) continue;
      (state.coins ||= []).push({ txid: f.txid, vout: f.vout, value: f.value, tweak: f.tweak, height: tx.status.block_height });
      tacit.recordSpCredit({ txidHex: f.txid, vout: f.vout, sats: f.value, tweakHex: f.tweak, blockTime: tx.status.block_time, keyVersion: 1, coinClass: 'mixed' });
    }
    save();
    log(`Found your mixed coin: ${sats(found[0].value)}.`);
    ctx.refresh?.();
    return true;
  }

  // A buy-and-shield of one faucet lot, funded by one mixed coin and nothing else.
  async function useCoin(say) {
    const coinRec = unusedMixed()[0];
    if (!coinRec) throw new Error('join: no mixed coin to use');
    const S = await ctx.secretModule();
    const keys = keysV1();
    say('finding a lot…');
    const status = await S.fetchFaucet();
    const sale = await S.pickSale(tacit, status);
    const coin = J.mixedCoin({ ...coinRec, spendPriv: keys.spendPriv });
    const feeRate = Math.max(1, Number(await tacit.getFeeRate()) || 1);
    const txCache = new Map();
    const fetchTx = async (id) => { if (!txCache.has(id)) txCache.set(id, await tacit.getTx(id)); return txCache.get(id); };
    const resolveNote = makeNoteResolver({ validateOutpoint: tacit.validateOutpoint, txOutputEnvelope: tacit.txOutputEnvelope, getParentEnvelopeData: tacit.getParentEnvelopeData, fetchTx });
    const { tacit: tk, wallet, change } = J.zapFromMixedCoin({ coin, keys, makeBtcWallet, hrp: tacit.NET?.hrp || 'tb', resolveNote, feeRate });
    const pw = S.poolWalletFor(ctx.wallet.priv, network);
    const total = S.poolClient.artifactBytes ? await S.poolClient.artifactBytes().catch(() => 0) : 0;
    const got = new Map();
    const system = await S.poolClient.system({
      onProgress: ({ name, loaded, cached }) => {
        got.set(name, loaded);
        if (cached) return;
        const sum = [...got.values()].reduce((a, b) => a + b, 0);
        say(total ? `downloading the prover (once)… ${Math.min(99, Math.floor((100 * sum) / total))}%` : 'downloading the prover (once)…');
      },
    });
    const zap = makeBtcPoolZap({ secp, sha256, keccak256: keccak_256 });
    let t0 = 0, timer = null;
    let z;
    try {
      z = await zap.buyAndShield({
        tacit: tk, pool: S.pool, sale, wallet, recipientAddress: pw.addressString, system,
        onProgress: (stage) => {
          if (stage === 'loading') say('preparing the prover…');
          if (stage !== 'proving') return;
          t0 = Date.now();
          timer = setInterval(() => say(`proving on your device… ${Math.round((Date.now() - t0) / 1000)} s`), 500);
        },
      });
    } finally { if (timer) clearInterval(timer); }
    say('buying into the pool…');
    await tacit.broadcast(z.commitHex);
    await tacit.broadcastWithRetry(z.carrierHex);
    // Change is ordinary sats at a fresh key of the own silent address.
    if (z.commitTx.outputs.length > 1) tacit.recordSpCredit({ txidHex: z.commitTxid, vout: 1, sats: z.commitTx.outputs[1].value, tweakHex: change.tweak, keyVersion: 1 });
    tacit.recordSpCredit({ txidHex: z.carrierTxid, vout: 0, sats: z.carrierTx.outputs[0].value, tweakHex: change.tweak, keyVersion: 1 });
    tacit.removeSpCredit?.(coinRec.txid, coinRec.vout);
    coinRec.used = z.carrierTxid;
    const { value, npk, rho, ...fields } = z.note;
    const poolNote = { ...fields, txid: z.carrierTxid, value: value.toString() };
    state.zap = { commitTxid: z.commitTxid, carrierTxid: z.carrierTxid, amount: value.toString(), coin: `${coinRec.txid}:${coinRec.vout}`, t: Date.now() };
    save();
    adoptPoolNote(poolNote, z);
    ctx.track?.(z.carrierTxid, 'Bought private cBTC with mixed sats');
    log('Bought private cBTC with your mixed coin.');
    ctx.refresh?.();
  }

  // The Secret payment steps unlock on a pool note in their own state; hand this one over when they have none.
  function adoptPoolNote(poolNote, z) {
    if (!who?.pubHex) return;
    const shield = { commitTxid: z.commitTxid, revealTxid: z.carrierTxid, bought: true, mixed: true };
    const h = ctx.secretHandle?.();
    if (h?.state) {
      if (h.state.poolNote) return;
      h.state.poolNote = poolNote; h.state.shield = shield;
      try { localStorage.setItem(DEMO_KEY(network, who.pubHex), JSON.stringify(h.state)); } catch {}
      try { h.render?.(); } catch {}
      return;
    }
    try {
      const k = DEMO_KEY(network, who.pubHex);
      const s = JSON.parse(localStorage.getItem(k) || '{}') || {};
      if (!s.poolNote) localStorage.setItem(k, JSON.stringify({ ...s, poolNote, shield }));
    } catch {}
  }

  function startOver() {
    if (running) return;
    (state.history ||= []).push({ entry: state.entry?.txid || null, round: state.round?.txid || null, zap: state.zap?.carrierTxid || null, t: Date.now() });
    state.entry = null; state.round = null; state.zap = null; state.lastRound = null; state.candidates = [];
    chainInfo.entryHeight = null; chainInfo.roundHeight = null;
    for (const k of Object.keys(errs)) errs[k] = null;
    save(); render(); schedule();
  }

  // ── rendering ──
  function blocker() {
    if (!d) return 'Mixing runs on signet for now. Switch the wallet to signet to try it.';
    if (!who?.connected) return 'Connect a wallet above first.';
    return null;
  }

  function renderEntry(ph) {
    const S = setPhase('entry', ph, ph === 'done' ? 'sent' : '');
    if (ph === 'done') {
      put(S.body, el('div', {}, `${sats(state.entry.value)} to your own silent address in `, txLink(state.entry.txid), '.'));
      return;
    }
    const about = 'One coin of the round’s size, paid to your own silent address, so every coin in the round looks the same.';
    if (ph !== 'active' || running === 'entry') { put(S.body, el('div', {}, about)); return; }
    const est = estimate;
    const cost = est ? est.value + est.entryFee : null;
    const short = est && who?.sats != null && who.sats < cost;
    put(S.body,
      el('div', {}, about),
      est ? el('div', {}, `Entry ${sats(est.value)}: ${sats(est.o)} comes out mixed; the rest pays the round’s fee and your later spend. About ${sats(cost)} with this fee.`) : null,
      short ? el('div', {}, `You have ${sats(who.sats)}. Get signet sats in the Secret payment tab first.`) : null,
      el('div', { class: 'row' }, button('Make the entry', () => run('entry', makeEntry), { disabled: !!short || !est })),
      errLine('entry'));
  }

  function renderAge(ph) {
    const c = confs(chainInfo.entryHeight);
    const S = setPhase('age', ph, ph === 'done' ? `${AGE}+ blocks` : state.entry ? (chainInfo.entryHeight ? `${Math.min(c, AGE)} of ${AGE} blocks` : 'unconfirmed') : '');
    if (ph === 'done') return;
    if (ph !== 'active') { put(S.body, el('div', {}, `${AGE} blocks, about an hour. Rounds count only coins this settled, so yours can’t be singled out as new.`)); return; }
    const left = Math.max(0, AGE - c);
    put(S.body, el('div', {}, chainInfo.entryHeight
      ? `Confirmed in block ${chainInfo.entryHeight}. ${left} more block${left === 1 ? '' : 's'}, about ${left * 10} min. This page checks on its own.`
      : 'Waiting for the entry to confirm (about 10 min). This page checks on its own.'), errLine('age'));
  }

  function roundNote(board) {
    const tor = board?.tor
      ? 'Connected to the board over Tor.'
      : 'The board sees your IP address beside your coin, never which output is yours. Open this page in Tor Browser to hide it.';
    return el('div', { class: 'small muted' }, tor);
  }

  function renderRound(ph) {
    const S = setPhase('round', ph, ph === 'done' ? `${state.round.n} coins` : '');
    const board = boards?.[0];
    if (ph === 'done') {
      put(S.body, el('div', {}, `Signed with ${state.round.n - 1} others in `, txLink(state.round.txid), '.'), checklist(state.round.checks));
      return;
    }
    if (running === 'round' && live) {
      const leave = live.stage === 0 && abort ? button('Leave the round', () => abort?.abort(), { quiet: true }) : null;
      put(S.body, progressList(live),
        el('div', {}, live.stage === 0 ? 'The round starts at the next signet block once enough wallets are in.' : 'Keep this tab open and in front until it is signed; a closed tab only drops you from the round.'),
        leave ? el('div', { class: 'row' }, leave) : null, roundNote(board));
      return;
    }
    const about = `You and at least ${(params?.kMin || 3) - 1} other wallets each put in one coin and get back one equal coin. The shuffle hides which is whose from the board and from each other.`;
    if (ph !== 'active') { put(S.body, el('div', {}, about)); return; }
    const last = state.lastRound;
    put(S.body,
      el('div', {}, about),
      board ? el('div', { class: 'small' }, `Board ${board.name || new URL(board.url).host} · tier ${sats(d)} · ${state.entry?.fr || 1} sat/vB`) : el('div', { class: 'err' }, 'No join board listed.'),
      el('div', { class: 'row' }, button('Join a round', () => run('round', joinRound), { disabled: !board })),
      last?.checks && last.status !== 'broadcast' ? checklist(last.checks) : null,
      roundNote(board),
      errLine('round'));
  }

  function renderFind(ph) {
    const coin = state.round && (state.coins || []).find((c) => c.txid === state.round.txid);
    const S = setPhase('find', ph, ph === 'done' ? 'found' : state.round ? 'waiting for a block' : '');
    if (ph === 'done') {
      put(S.body, el('div', {}, `${sats(coin.value)} at `, txLink(coin.txid, `${coin.txid.slice(0, 10)}…:${coin.vout}`), `, found with your scan key (block ${coin.height}). It stays apart from your plain sats: Send never spends it.`));
      return;
    }
    if (ph !== 'active') { put(S.body, el('div', {}, 'After a block, your wallet finds its output with its own scan key. Nothing about it is stored anywhere else.')); return; }
    put(S.body, progressList({ stage: 4, waitLine: `${state.round.n} joined`, shuffleLine: 'done', checks: state.round.checks, signedLine: 'broadcast', confirmLine: 'waiting for a block' }),
      el('div', {}, 'Signed and broadcast in ', txLink(state.round.txid), '. This page checks for the block on its own.'), errLine('find'));
  }

  function renderUse(ph) {
    const S = setPhase('use', ph, ph === 'done' ? 'bought' : 'optional');
    if (ph === 'done') {
      put(S.body, el('div', {}, 'Bought private cBTC with your mixed coin in ', txLink(state.zap.carrierTxid), '. Pay, receive and exit it from the Secret payment tab.'),
        el('div', { class: 'row' }, button('Mix again', startOver, { quiet: true })));
      return;
    }
    const about = 'Spend the mixed coin alone on a test cBTC lot, straight into the pool. The lot’s price is public; where the sats came from is not.';
    if (ph !== 'active' || running === 'use') { put(S.body, el('div', {}, about)); return; }
    const coin = unusedMixed()[0];
    put(S.body, el('div', {}, about),
      coin ? el('div', {}, `Uses ${sats(coin.value)} (`, txLink(coin.txid, `${coin.txid.slice(0, 10)}…:${coin.vout}`), '). The change comes back as plain sats.') : null,
      el('div', { class: 'row' },
        button('Get private cBTC', () => run('use', useCoin), { disabled: !coin }),
        button('Keep it and mix again', startOver, { quiet: true })),
      errLine('use'));
  }

  function renderHint() {
    const h = ctx.hintEl;
    if (!h) return;
    const coin = unusedMixed()[0];
    const text = state.zap ? 'Your mixed sats bought private cBTC.' : coin ? `You have a mixed coin of ${sats(coin.value)}.` : state.entry ? 'A mix is in progress.' : 'Put your sats through a join first, so the cBTC you buy has no history.';
    const open = el('button', { type: 'button', class: 'link-btn', onclick: () => ctx.openMix?.() }, state.entry || coin ? 'Open Mix' : 'Mix your sats');
    h.replaceChildren(el('span', {}, text, ' '), open);
  }

  function render() {
    const b = blocker();
    intro.replaceChildren(el('p', { class: 'note' }, b || 'Mix turns your sats into a coin with no history. Each step is one signet transaction or a short round; progress is saved in this browser.'));
    const ph = phases();
    renderEntry(ph.entry); renderAge(ph.age); renderRound(ph.round); renderFind(ph.find); renderUse(ph.use);
    renderHint();
  }

  // ── chain watching: entry age, the join's confirmation, and signed candidates that others completed ──
  let timer = null;
  async function tick() {
    if (!who?.connected || !d || document.hidden) return;
    try {
      if (state.entry && !state.round) {
        chainInfo.tip = await chain.tipHeight();
        const tx = await chain.getTx(state.entry.txid).catch(() => null);
        chainInfo.entryHeight = tx?.status?.confirmed ? tx.status.block_height : null;
        if (confs(chainInfo.entryHeight) >= AGE && !state.entry.aged) { state.entry.aged = true; save(); }
        // A transaction this wallet signed may still have been completed by the others.
        const sp = await chain.getOutspend(state.entry.txid, state.entry.vout).catch(() => null);
        if (sp?.spent && !running) {
          const cand = (state.candidates || []).find((c) => c.txid === sp.txid);
          if (cand) { state.round = { txid: cand.txid, n: null, own: cand.own, t: Date.now() }; save(); }
          else errs.round = 'Your entry coin was spent outside a round. Start over to make a new one.';
        }
      }
      if (state.round && !(state.coins || []).some((c) => c.txid === state.round.txid) && running !== 'find') {
        chainInfo.tip = await chain.tipHeight();
        try { await findOwn(state.round.txid); } catch (e) { errs.find = joinError(e, ctx); }
      }
    } catch {}
    if (!running) render();
  }
  function schedule() {
    clearInterval(timer);
    const waiting = state.entry && (!state.round || !(state.coins || []).some((c) => c.txid === state.round.txid));
    if (waiting) { timer = setInterval(tick, POLL_MS); tick(); }
  }

  ctx.onWallet?.((w) => {
    const changed = w.pubHex !== who?.pubHex;
    who = w;
    if (changed) { state = load(); chainInfo = { tip: null, entryHeight: null, roundHeight: null }; for (const k of Object.keys(errs)) errs[k] = null; schedule(); }
    if (!running) render();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && timer) tick(); });

  render();
  if (d) {
    loadBoards(network).then((b) => { boards = b; if (!running) render(); });
    refreshEstimate().then(() => { if (!running) render(); });
  }
  return { render, get state() { return state; }, get live() { return live; }, sections, stop: () => clearInterval(timer) };
}
