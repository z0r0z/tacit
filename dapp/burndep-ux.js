import { makeBurnDepositReveal } from './burn-deposit-reveal.js';
import { makeBurnDepositBroadcaster } from './burndep-broadcast.js';
import { makeBurnDepositKit, classifyConfidentialTx, extractTaprootEnvelope, parseCxferEnvelopeFull } from './burn-deposit-bitcoin.js';
import { makeBtcWallet } from './bitcoin-taproot-wallet.js';
import { makeBridgeMintRecovery } from './bridge-mint-recovery.js';
import { buildRecoverClaim } from './bridge-recover.js';
import { makeBridgeBurnBroadcaster } from './bridge-burn-broadcast.js';

export const BURNDEP_BETA_CAP_RAW = 100_000_000_000n;
export const RETURN_FEE_CEILING = 100;
// The reflection guest folds a burn-deposit whose provenance holds at most 256 transfers; the move to the burn address is one of
// them, so the note itself may have 255 behind it.
const MAX_HOPS_BURN_HOME = 256;
const MAX_HOPS_SOURCE = MAX_HOPS_BURN_HOME - 1;
const TRACE_WAIT_MAX_S = 60;
const TRACE_TOTAL_MS = 10 * 60 * 1000;
const CHECK_HOLD_MS = 20 * 60 * 1000;
const JOURNAL_PREFIX = 'tacit-burndep-bridge-v1';
const LEASE_TTL_MS = 30_000;
const DEST_INDEXES = 8;
const MINT_WAIT_MS = 15 * 60 * 1000;
const MINT_QUEUE_MS = 20 * 60 * 1000;
const DAY_REFUSAL = /free relayed settles for today|prove capacity for today|relay-paid proofs for today/i;
const BUDGET_CODES = ['free_budget', 'prove_budget'];
const dayRefusal = (e) => BUDGET_CODES.includes(e && e.code) || DAY_REFUSAL.test(String((e && e.message) || e || ''));
export const relayFault = (e) => dayRefusal(e) || /produced no proof|could not make this proof|moved on while this|0x8a98f245|waited in the queue past its deadline/i.test(String((e && e.message) || e || ''));
export function mintRetryDue(rec, { ranOut = false, at = Date.now() } = {}) {
  const e = rec && rec.lastError;
  if (!e) return true;
  const since = at - Number(e.at || 0);
  if (Number(e.until) > at) return since > 60 * 60e3;
  return (relayFault(e) || (Number(rec.errorCount) || 0) < 4) && since > (ranOut ? 60 : 10) * 60e3;
}
const nextUtcDay = (t) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 1); };

const stripHex = (h) => String(h).replace(/^0x/, '');
const withHex = (h) => (String(h).startsWith('0x') ? String(h) : '0x' + String(h));
const lc = (h) => String(h).toLowerCase();
const revHex = (h) => stripHex(h).match(/../g).reverse().join('');
const recordId = (txid, vout) => `${stripHex(txid).toLowerCase()}:${Number(vout)}`;
const now = () => Date.now();
function hexToBytesLocal(h) { const s = String(h).replace(/^0x/, ''); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; }
function bytesToHexLocal(b) { return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }

function defaultStorage() {
  const ls = (() => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } })();
  return {
    getItem: (k) => (ls ? ls.getItem(k) : null),
    setItem: (k, v) => { if (ls) ls.setItem(k, v); },
    removeItem: (k) => { if (ls) ls.removeItem(k); },
    get length() { return ls ? ls.length : 0; },
    key: (i) => (ls ? ls.key(i) : null),
  };
}

const BIG_FIELDS = ['amount', 'blinding', 'value'];
function serializeRecord(rec) {
  return JSON.stringify(rec, (k, v) => (typeof v === 'bigint' ? (BIG_FIELDS.includes(k) ? { __big: v.toString() } : v.toString()) : v));
}
function deserializeRecord(text) {
  return JSON.parse(text, (k, v) => (v && typeof v === 'object' && typeof v.__big === 'string' ? BigInt(v.__big) : v));
}

export function makeBurnDepositUx(deps) {
  const {
    network = 'mainnet', hrp = 'bc', workerBase, fetchImpl, storage: storageIn = null,
    secp, sha256, keccak256, hmac, pool, bridgeMint, chainBindingHex, tacAssetId,
    chain, encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf,
    encryptAmount, signSchnorr, modN,
    openNote = null, nullifierSpent = null,
    openHeldNote = null,
    assets: assetsIn = null,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = deps || {};
  for (const [k, v] of Object.entries({ workerBase, secp, sha256, keccak256, hmac, pool, bridgeMint, chainBindingHex, tacAssetId, chain })) {
    if (v == null) throw new Error(`burndep-ux: deps.${k} required`);
  }
  const ASSETS = (assetsIn || [{ assetId: tacAssetId, ticker: 'TAC', capRaw: BURNDEP_BETA_CAP_RAW }]).map((a) => ({ ...a, assetId: withHex(a.assetId), capRaw: BigInt(a.capRaw) }));
  const assetOf = (id) => ASSETS.find((a) => lc(stripHex(a.assetId)) === lc(stripHex(id || ''))) || null;
  const storage = storageIn || defaultStorage();
  const cryptoDeps = { secp, keccak256, sha256 };
  const kit = makeBurnDepositKit(cryptoDeps);
  const reveal = makeBurnDepositReveal({ pool, secp });
  const broadcaster = makeBurnDepositBroadcaster({ workerBase, fetchImpl });
  const mintRecovery = makeBridgeMintRecovery({ hmac, sha256, curveOrder: secp.CURVE.n });
  const pureCxferPrims = { encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf, encryptAmount, signSchnorr, modN, sha256 };
  for (const [k, v] of Object.entries(pureCxferPrims)) {
    if (v == null) throw new Error(`burndep-ux: deps.${k} required (pure cxfer helper — see burn-deposit-reveal.js's MIGRATE_NEED)`);
  }

  function freshPrims(walletPriv) {
    const w = makeBtcWallet({
      priv: walletPriv, hrp,
      fetchUtxos: async () => [],
      broadcastTx: async (hex) => chain.broadcastWithRetry(hex),
      fetchFeeRate: async () => chain.getFeeRate('priority'),
    });
    return { ...w.prims, ...pureCxferPrims };
  }
  const scratchPrims = freshPrims(new Uint8Array(32).fill(1));
  function p2wpkhScriptOf(pubkeyHexOrBytes) {
    const pub = typeof pubkeyHexOrBytes === 'string' ? hexToBytesLocal(stripHex(pubkeyHexOrBytes)) : pubkeyHexOrBytes;
    return scratchPrims.p2wpkhScript(pub);
  }

  function journalKey(walletPub) { return `${JOURNAL_PREFIX}:${network}:${lc(typeof walletPub === 'string' ? walletPub : bytesToHexLocal(walletPub))}`; }
  function loadAll(walletPub) {
    try { const raw = storage.getItem(journalKey(walletPub)); const arr = raw ? deserializeRecord(raw) : []; return Array.isArray(arr) ? arr : []; }
    catch { return []; }
  }
  function saveAll(walletPub, list) {
    try { storage.setItem(journalKey(walletPub), serializeRecord(list)); }
    catch (e) {
      // a full store: the provenance bundle of a bridge that is finished is not read again, so it is let go and the save is tried once more
      const slim = list.map((r) => (r.bundle && ['minted', 'reclaimed', 'recovered'].includes(r.stage) ? (({ bundle, ...rest }) => rest)(r) : r));
      if (slim.every((r, i) => r === list[i])) throw e;
      storage.setItem(journalKey(walletPub), serializeRecord(slim));
    }
  }
  function putRecord(rec) {
    const list = loadAll(rec.walletPub).filter((r) => r.id !== rec.id);
    const saved = { ...rec, updatedAt: now() };
    list.push(saved);
    saveAll(rec.walletPub, list);
    return saved;
  }
  function getRecord(walletPub, id) { return loadAll(walletPub).find((r) => r.id === id) || null; }
  function keptRecord(rec) {
    const saved = putRecord(rec);
    if (!getRecord(rec.walletPub, rec.id)) throw new Error('burndep-ux: this browser cannot keep the bridge record (its storage is blocked), so nothing was sent');
    return saved;
  }

  function leaseKey(id) { return `${JOURNAL_PREFIX}:lease:${network}:${id}`; }
  const sessionId = `${now()}-${Math.random().toString(36).slice(2)}`;
  function tryAcquireLease(id) {
    const key = leaseKey(id);
    try {
      const raw = storage.getItem(key);
      if (raw) { const held = JSON.parse(raw); if (held.owner !== sessionId && now() - held.at < LEASE_TTL_MS) return false; }
    } catch { }
    storage.setItem(key, JSON.stringify({ owner: sessionId, at: now() }));
    return true;
  }
  function releaseLease(id) { try { storage.removeItem(leaseKey(id)); } catch {} }

  const PRIVATE_NOTE = 'received privately: send it to yourself first, then bridge the new note';
  let reflCache = null, reflInflight = null;
  function reflected(fresh = false) {
    if (!fresh && reflCache && now() - reflCache.at < 60000) return Promise.resolve(reflCache);
    return reflInflight || (reflInflight = readReflected().finally(() => { reflInflight = null; }));
  }
  async function readReflected() {
    const d = await callWorker('GET', '/reflection/dump');
    const snap = d && d.snapshot;
    if (!snap || !Array.isArray(snap.liveTriples) || !Array.isArray(snap.burnNodes)) {
      throw new Error('burndep-ux: could not read the reflection state to check this bridge; try again in a moment');
    }
    reflCache = {
      at: now(), height: Number(snap.height ?? d.attestedHeight),
      live: new Set(snap.liveTriples.map((t) => lc(t[0]))),
      liveBound: new Map(snap.liveTriples.map((t) => [lc(t[0]), Number(t[4]) === 1])),
      leaves: Array.isArray(snap.noteLeaves) ? new Set(snap.noteLeaves.map(lc)) : null,
      dests: new Set(snap.burnNodes.map((n) => lc(n[2] || ''))),
      pending: new Set((snap.pendingDepositRecords || []).map((r) => lc(r.key))),
    };
    return reflCache;
  }
  const outpointOf = (txid, vout) => lc(pool.outpointKey(withHex(revHex(txid)), Number(vout)));
  async function isLive(txid, vout, { fresh = false } = {}) {
    const t = await fetchChainJson(`/tx/${stripHex(txid)}`);
    const h = Number(t && t.status && t.status.block_height);
    if (!t || !t.status || !t.status.confirmed || !Number.isInteger(h)) return null;
    if (fresh && h > ((await attestedHeight().catch(() => null)) ?? Infinity)) return null;
    const r = await reflected(fresh);
    if (!Number.isInteger(r.height) || h > r.height) return null;
    return r.live.has(outpointOf(txid, vout));
  }
  async function attestedHeight() {
    const r = await callWorker('GET', '/reflection/status');
    const h = Number(r && r.attestedHeight);
    return Number.isInteger(h) && h > 0 ? h : null;
  }
  function destLeaf(rec) {
    let leaf = rec && rec.envelope && rec.envelope.destLeaf;
    if (!leaf && rec && rec.dest && rec.dest.value != null && rec.dest.blinding != null) {
      const { cx, cy } = pool.commitXY(BigInt(rec.dest.value), BigInt(rec.dest.blinding));
      leaf = pool.leaf(withHex((rec.source && rec.source.assetId) || tacAssetId), cx, cy, rec.dest.owner);
    }
    return leaf ? lc(leaf) : null;
  }
  async function burnRecorded(rec) {
    const r = await reflected(true);
    const leaf = destLeaf(rec);
    if (leaf && r.dests.has(leaf)) return true;
    if (r.pending.has(outpointOf(rec.burnHome.txid, 0))) return true;
    const st = await checkTxidStatus(rec.burn.txid);
    const h = Number(st && st.burnBlockHeight);
    if (!Number.isInteger(h) || !Number.isInteger(r.height) || h > r.height) return null;
    return false;
  }

  function eligibleNotes(holdings) {
    return (holdings || []).map((h) => {
      const amount = BigInt(h.amount);
      let reason = null;
      if (lc(stripHex(h.assetId)) !== lc(stripHex(tacAssetId))) reason = 'not TAC';
      else if (amount > BURNDEP_BETA_CAP_RAW) reason = 'over the 1,000 TAC beta limit — send part of it to yourself first to split off a smaller note';
      else if (h.confirmed === false) reason = 'unconfirmed';
      else if (h.stealth && !h.stealthTweakedSk) reason = 'received privately (stealth) — rescan holdings to recover its spend key, then retry';
      else if (isReserved(h.txid, h.vout)) reason = 'already bridging';
      return { ...h, eligible: !reason, reason };
    });
  }

  const SPENDS_NOTHING = new Set(['minted', 'reclaimed', 'reclaim-sent', 'recovered', 'recovering', 'not-recorded', 'stopped']);
  // The move's change (its reveal's vout 1) is what the move set aside to pay the burn's fee (bridgeCost's `later`), so until the
  // burn is signed it is held for that bridge: another move or send spending it would leave the burn with nothing to pay with.
  const BEFORE_BURN = new Set(['migrate-signed', 'migrate-sent', 'migrate-confirmed', 'traced']);
  const moveChangeOf = (rec) => (rec.migrate && rec.migrate.revealTxid && BEFORE_BURN.has(rec.stage) ? recordId(rec.migrate.revealTxid, 1) : null);
  // A burn built while its check waits holds its coin for CHECK_HOLD_MS. It is sent only once signed (rec.burn), so a hold past that
  // is spent by nothing: it holds nothing for anyone else, and its own bridge may pick the coin again.
  const heldBurn = (rec) => (rec && rec.checkWait && rec.checkWait.burn && now() - Number(rec.checkWait.burn.at || 0) < CHECK_HOLD_MS ? rec.checkWait.burn : null);
  // `except`: a bridge id whose own holds are not counted (that bridge asking whether it may spend a coin itself).
  function isReserved(txid, vout, except = null) {
    const op = recordId(txid, vout);
    for (const rec of allRecordsAnyWallet()) {
      if (except && rec.id === except) continue;
      if (rec.stage === 'reclaim-sent') { const u = rec.reclaim && rec.reclaim.fundingUtxo; if (u && recordId(u.txid, u.vout) === op) return true; continue; }
      if (SPENDS_NOTHING.has(rec.stage)) continue;
      if (rec.id === op) return true;
      if (rec.migrate && rec.migrate.fundingUtxo && recordId(rec.migrate.fundingUtxo.txid, rec.migrate.fundingUtxo.vout) === op) return true;
      if (moveChangeOf(rec) === op) return true;
      const held = heldBurn(rec) && heldBurn(rec).fundingUtxo;
      if (held && recordId(held.txid, held.vout) === op) return true;
      if (rec.burn && rec.burn.fundingUtxo && recordId(rec.burn.fundingUtxo.txid, rec.burn.fundingUtxo.vout) === op) return true;
      if (rec.burn && Array.isArray(rec.burn.fundingUtxos) && rec.burn.fundingUtxos.some((u) => recordId(u.txid, u.vout) === op)) return true;
    }
    return false;
  }
  function allRecordsAnyWallet() {
    const out = [];
    const prefix = `${JOURNAL_PREFIX}:${network}:`;
    const len = storage.length;
    if (typeof len === 'number' && typeof storage.key === 'function') {
      for (let i = 0; i < len; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(prefix)) { try { out.push(...deserializeRecord(storage.getItem(k))); } catch {} }
      }
    }
    return out;
  }

  async function preflight({ note, walletPub, onProgress = null }) {
    const out = { steps: [], ok: false };
    const step = (name, ok, detail, more) => { out.steps.push({ name, ok, detail, ...more }); return ok; };
    if (!step('cap', BigInt(note.amount) <= BURNDEP_BETA_CAP_RAW, `${note.amount} raw units`)) return out;

    let srcTx;
    try { srcTx = await fetchChainJson(`/tx/${stripHex(note.txid)}`); }
    catch (e) { step('source-lookup', false, String(e.message || e)); return out; }
    const vout = srcTx && srcTx.vout && srcTx.vout[note.vout];
    if (!step('source-confirmed', !!(srcTx.status && srcTx.status.confirmed), 'source output confirmed on Bitcoin')) return out;
    const ownerPub = note.stealthTweakedSk ? secp.getPublicKey(hexToBytesLocal(stripHex(note.stealthTweakedSk)), true) : walletPub;
    const ownWpkh = lc(bytesToHexLocal(p2wpkhScriptOf(ownerPub)));
    if (!step('source-ownership', !!vout && lc(vout.scriptpubkey) === ownWpkh, "source output pays this wallet's own address")) return out;
    let live;
    try { live = await isLive(note.txid, note.vout, { fresh: true }); }
    catch (e) { step('reflection', false, String(e.message || e)); return out; }
    if (live === null) { step('not-tracked', false, 'the reflection has not reached the block this note was made in yet; try again in a little while'); return out; }
    if (live) {
      if (!step('reflected', !note.stealthTweakedSk, note.stealthTweakedSk ? PRIVATE_NOTE : 'tracked by the reflection: bridges in one Bitcoin transaction')) return out;
      const refl = await reflected();
      if (refl.leaves) {
        const { cx, cy } = pool.commitXY(BigInt(note.amount), BigInt(note.blinding));
        const bound = refl.liveBound.get(outpointOf(note.txid, note.vout));
        if (!step('bound', !bound, 'this note is bound to a deployment, which this bridge does not burn')) return out;
        const leaf = bridgeMint.sourceLeaf({ sourceClass: 1, asset: withHex(tacAssetId), cx, cy, owner: '0x' + '00'.repeat(32), chainBinding: withHex(chainBindingHex()) });
        if (!step('old-leaf', refl.leaves.has(lc(leaf)), 'this note is in an older form the bridge cannot burn directly: send it once to your own address first')) return out;
      }
      out.path = 'reflected';
      let burnRate = null;
      try { burnRate = await chain.getFeeRate('priority'); step('fee-estimate', true, `${burnRate} sat/vB`); }
      catch (e) { step('fee-estimate', false, String(e.message || e)); return out; }
      out.burnFeeRate = burnRate;
      out.ok = out.steps.every((x) => x.ok);
      return out;
    }
    step('not-tracked', true, 'not tracked by the reflection');

    let traced;
    try { traced = await traceNote({ txid: note.txid, vout: note.vout, assetId: tacAssetId, onProgress }); }
    catch (e) {
      if (e && e.code === 'trace_reading') { step('trace', false, String(e.message), { reading: true, read: e.read }); return out; }
      const through = unprovableThrough(String((e && e.message) || e));
      if (through) {
        const at = /burndep-live-tracer: (?:input )?([0-9a-f]{64})/i.exec(String((e && e.message) || e));
        step('trace', false, String(e.message || e), { unprovable: true, through, ...(at ? { at: at[1].toLowerCase() } : {}) });
        return out;
      }
      const long = /provenance exceeded (?:maxDepth \((\d+)\)|\d+ outpoints)/.exec(String((e && e.message) || e));
      step('trace', false, long ? `over ${long[1] || MAX_HOPS_SOURCE} hop(s) to the etch (max ${MAX_HOPS_SOURCE})` : String(e.message || e),
        long ? { tooLong: true, hops: Number(long[1]) || null, atLeast: true, max: MAX_HOPS_SOURCE } : undefined);
      return out;
    }
    if (!step('trace', traced.hops <= MAX_HOPS_SOURCE, `${traced.hops} hop(s) to the etch (max ${MAX_HOPS_SOURCE})`,
      traced.hops > MAX_HOPS_SOURCE ? { tooLong: true, hops: traced.hops, atLeast: false, max: MAX_HOPS_SOURCE } : undefined)) return out;
    out.bundle = traced.bundle;
    out.hops = traced.hops;

    let rates = null;
    try { rates = await broadcaster.slipstreamRates(); step('mara-rates', true, `${rates.effective_rate} sat/vB effective`); }
    catch (e) { step('mara-rates', false, String(e.message || e)); }
    out.slipstreamRates = rates;
    out.burnRate = rates ? burnRateOf(rates) : null;

    let migrateRate = null;
    try { migrateRate = await chain.getFeeRate('priority'); step('fee-estimate', true, `${migrateRate} sat/vB`); }
    catch (e) { step('fee-estimate', false, String(e.message || e)); return out; }
    out.migrateFeeRate = migrateRate;

    out.ok = out.steps.every((s) => s.ok);
    return out;
  }

  async function noteForms(notes) {
    const r = await reflected();
    const out = new Map(), zero = '0x' + '00'.repeat(32);
    for (const n of notes || []) {
      const id = `${n.txid}:${n.vout}`;
      if (!r.live.has(outpointOf(n.txid, n.vout))) { out.set(id, null); continue; }
      if (n.stealthTweakedSk) { out.set(id, 'private'); continue; }
      if (!r.leaves || n.amount == null || n.blinding == null) { out.set(id, null); continue; }
      const { cx, cy } = pool.commitXY(BigInt(n.amount), BigInt(n.blinding));
      const leaf = bridgeMint.sourceLeaf({ sourceClass: 1, asset: withHex(tacAssetId), cx, cy, owner: zero, chainBinding: withHex(chainBindingHex()) });
      out.set(id, r.leaves.has(lc(leaf)) ? 'ready' : 'old');
    }
    return out;
  }

  // Whether the reflection tracks each note, read from the state noteForms reads and with no explorer call: 'tracked' (a live output),
  // 'bound' (a live output bound to a deployment, which a plain transfer is not for), 'new' (made in a block the proof has not reached, or no
  // known block) or 'untracked' (a block it has passed that left no live output).
  async function noteTracking(notes) {
    const r = await reflected(), out = new Map();
    for (const n of notes || []) {
      const key = outpointOf(n.txid, n.vout), h = Number(n.height);
      out.set(`${n.txid}:${n.vout}`, r.live.has(key) ? (r.liveBound.get(key) ? 'bound' : 'tracked')
        : Number.isInteger(h) && h > 0 && Number.isInteger(r.height) && h <= r.height ? 'untracked' : 'new');
    }
    return out;
  }

  // Whether a note's history can be followed back to the etch, for a caller that does not burn the note but whose counterparty may check
  // it this way: a fast bridge provider screens a lock with this same trace, and a lock it refuses costs its holder the Bitcoin fees and a
  // day. A note the reflection tracks needs no trace. Map note id -> a verdict, by `state`:
  //   'tracked' | 'traced' (with `hops`)   the history is followed
  //   'unprovable' (with `through`: 'shielded' | 'pool' | 'arrived' | 'other', and `at`, the transaction)   some transfer in it cannot be
  //                                        followed, which never changes
  //   'long' (with `hops`, `max`)          more transfers behind it than the proof folds
  //   'unread' (with `reading`, `error`)   not told: the service did not answer, or is still reading a long history
  // A verdict that is final is kept while the page stays open: the history of a confirmed note does not change.
  const lineageKept = new Map();
  async function lineage(notes, { onProgress = null } = {}) {
    const out = new Map();
    let r = null;
    try { r = await reflected(); } catch { /* the trace tells instead */ }
    for (const n of notes || []) {
      const id = `${n.txid}:${n.vout}`, kept = lineageKept.get(recordId(n.txid, n.vout));
      if (kept) { out.set(id, kept); continue; }
      const key = outpointOf(n.txid, n.vout);
      let v;
      if (r && r.live.has(key) && !r.liveBound.get(key)) v = { state: 'tracked' };
      else {
        try { const t = await traceNote({ txid: n.txid, vout: n.vout, assetId: tacAssetId, onProgress }); v = t.hops <= MAX_HOPS_SOURCE ? { state: 'traced', hops: t.hops } : { state: 'long', hops: t.hops, max: MAX_HOPS_SOURCE }; }
        catch (e) {
          const m = String((e && e.message) || e), through = unprovableThrough(m), at = /burndep-live-tracer: (?:input )?([0-9a-f]{64})/i.exec(m), long = /provenance exceeded (?:maxDepth \((\d+)\)|\d+ outpoints)/.exec(m);
          v = e && e.code === 'trace_reading' ? { state: 'unread', reading: true, read: e.read, error: m }
            : through ? { state: 'unprovable', through, ...(at ? { at: at[1].toLowerCase() } : {}) }
            : long ? { state: 'long', hops: Number(long[1]) || null, max: MAX_HOPS_SOURCE }
            : { state: 'unread', error: m };
        }
      }
      if (v.state !== 'unread') lineageKept.set(recordId(n.txid, n.vout), v);
      out.set(id, v);
    }
    return out;
  }

  async function preflightHeld({ note, walletPub }) {
    const out = { steps: [], ok: false };
    const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); return ok; };
    const a = assetOf(note.assetId || tacAssetId);
    if (!step('asset', !!a, a ? a.ticker : 'an asset this cannot send back')) return out;
    if (!step('cap', BigInt(note.amount) <= a.capRaw, `${note.amount} raw units`)) return out;
    let srcTx;
    try { srcTx = await fetchChainJson(`/tx/${stripHex(note.txid)}`); }
    catch (e) { step('source-lookup', false, String(e.message || e)); return out; }
    const vout = srcTx && srcTx.vout && srcTx.vout[note.vout];
    if (!step('source-confirmed', !!(srcTx && srcTx.status && srcTx.status.confirmed), 'the note\'s output is confirmed on Bitcoin')) return out;
    const owner = '0x' + bytesToHexLocal(typeof walletPub === 'string' ? hexToBytesLocal(stripHex(walletPub)).slice(1) : walletPub.slice(1));
    if (!step('source-ownership', !!vout && lc(vout.scriptpubkey) === '5120' + stripHex(owner), 'the note\'s output is this key\'s own Taproot output')) return out;
    let live;
    try { live = await isLive(note.txid, note.vout, { fresh: true }); }
    catch (e) { step('reflection', false, String(e.message || e)); return out; }
    if (live === null) { step('not-tracked', false, 'the reflection has not reached the block this note was made in yet; try again in a little while'); return out; }
    if (!step('reflected', live === true, 'tracked by the reflection: bridges in one Bitcoin transaction')) return out;
    const refl = await reflected();
    if (refl.leaves) {
      const { cx, cy } = pool.commitXY(BigInt(note.amount), BigInt(note.blinding));
      const bound = refl.liveBound.get(outpointOf(note.txid, note.vout));
      if (!step('bound', !bound, 'this note is bound to a deployment, which this path does not send back')) return out;
      const leaf = bridgeMint.sourceLeaf({ sourceClass: 1, asset: a.assetId, cx, cy, owner, chainBinding: withHex(chainBindingHex()) });
      if (!step('old-leaf', refl.leaves.has(lc(leaf)), 'this note is not in the reflected note tree in the form the burn names it by')) return out;
    }
    out.path = 'reflected';
    try { out.burnFeeRate = await chain.getFeeRate('priority'); step('fee-estimate', true, `${out.burnFeeRate} sat/vB`); }
    catch (e) { step('fee-estimate', false, String(e.message || e)); return out; }
    out.ok = out.steps.every((x) => x.ok);
    return out;
  }

  async function recheckBurn(walletPub, id) {
    const rec = getRecord(walletPub, id);
    if (!rec || rec.path !== 'reflected' || rec.stage !== 'not-recorded') throw new Error('burndep-ux: only a reflected burn marked not recorded can be checked again');
    const t = await fetchChainJson(`/tx/${stripHex(rec.burn.txid)}`);
    if (!t || !t.status || !t.status.confirmed) throw new Error('burndep-ux: that burn is not confirmed on Bitcoin just now; try again once it is');
    return putRecord({ ...rec, stage: 'rburn-mined', burnHeight: Number(t.status.block_height), lastError: null, errorCount: 0 });
  }

  // The public part of an API's 202 answer: where the check stands in its line, and once it runs what it is doing (reading the
  // blocks of the history, so many of so many transactions; building the header chain; verifying every transfer).
  function waitProgress(p) {
    if (!p || (p.state !== 'queued' && p.state !== 'running')) return {};
    const n = (x) => (Number.isFinite(Number(x)) && Number(x) >= 0 ? Math.round(Number(x)) : 0);
    const doing = p.state === 'running' && (p.phase === 'reading' || p.phase === 'headers' || p.phase === 'verifying') ? { phase: p.phase, done: n(p.done), total: n(p.total) } : {};
    return { progress: { state: p.state, ahead: n(p.ahead), runningSec: n(p.runningSec), ...doing } };
  }

  // A history the reflection guest cannot follow back to the etch: some transfer in it spends an output that no transfer made
  // (a pool or farm action, a shielded-pool exit, TAC that arrived from Ethereum, or a shape the guest refuses). That does not
  // change with time, unlike a read that failed, so it is told apart: 'pool', 'shielded', 'arrived' or 'other'.
  function unprovableThrough(m) {
    const kind = /classified as '([a-z_]+)'/.exec(m), op = /resolvable leaf \(opcode 0x([0-9a-f]{2})\)/i.exec(m);
    if (kind) return kind[1] === 'crossout_mint' ? 'arrived' : /^(swap|lp_|harvest|protocol_fee|farm)/.test(kind[1]) ? 'pool' : 'other';
    if (op) return /^6[cd]$/i.test(op[1]) ? 'shielded' : 'other'; // 0x6c shields into the pool, 0x6d spends from it (an exit is the note a spend makes)
    if (/not produced by a known cxfer and not a supply leaf|non-confidential input at index|atomic settlement whose asset input/.test(m)) return 'other';
    return null;
  }

  // The API reads a long history in parts, a bounded time per request, and keeps what it read: while it answers `pending` this
  // asks again (reporting how many transfers it has read so far) until the trace is whole, for up to TRACE_TOTAL_MS. A history it
  // read before comes back at once. The walk stops past the burn-home's limit, so a longer history reads as "more than 256".
  async function traceNote({ txid, vout, assetId, onProgress = null }) {
    const ask = () => callWorker('POST', '/reflection/burndep/trace', { note: { txid: stripHex(txid), vout }, assetId, maxDepth: MAX_HOPS_BURN_HOME });
    const until = now() + TRACE_TOTAL_MS;
    // A rate limit is waited out once before the API has read anything, and up to three times once it is part way through.
    for (let limited = 0, reading = false; ;) {
      let res;
      try { res = await ask(); }
      catch (e) {
        if (Number(e && e.status) !== 429 || !(e.retryAfter > 0 && e.retryAfter <= TRACE_WAIT_MAX_S) || limited++ >= (reading ? 3 : 1) || now() > until) throw e;
        await sleep((e.retryAfter + 1) * 1000);
        continue;
      }
      if (res && res.pending) {
        reading = true;
        if (onProgress) { try { onProgress(Number(res.read) || 0); } catch { /* a closed view */ } }
        if (now() > until) {
          throw Object.assign(new Error('burndep-ux: this TAC’s history is long and still being read from Bitcoin; try again in a few minutes'), { code: 'trace_reading', read: Number(res.read) || 0 });
        }
        await sleep(Math.min(10, Math.max(1, Number(res.retryAfter) || 2)) * 1000);
        continue;
      }
      if (!res.ok) throw new Error(res.error || 'trace failed');
      return { bundle: res.bundle, hops: res.hops };
    }
  }

  function bridgeCost({ path, feeRate, coins = [], noteSats = 546, p2tr = false, burnRate = null } = {}) {
    const r = Number(feeRate), DUST = 546, feeFor = (vb, at = r) => Math.max(500, Math.ceil(vb * at)), commitVb = (n) => 85 + 68 * n;
    const vals = (coins || []).map((c) => Number(c && c.value)).filter((v) => v > 0).sort((a, b) => b - a);
    if (path === 'reflected') {
      const revealFee = feeFor(p2tr ? 218 : 228), commitValue = Math.max(DUST, revealFee + DUST - Number(noteSats));
      let total = 0, n = 0, commitFee = feeFor(commitVb(1));
      for (const v of vals) { if (total >= commitValue + commitFee + DUST) break; total += v; n += 1; commitFee = feeFor(commitVb(n)); }
      const need = commitValue + commitFee;
      return { fee: commitFee + revealFee, need, ok: n > 0 && total >= need, have: total };
    }
    const commitFee = feeFor(commitVb(1)), fee = commitFee + feeFor(415), later = feeFor(270, Number(burnRate) > 0 ? Number(burnRate) : r), need = Math.max(fee + DUST - Number(noteSats), DUST + commitFee) + later;
    return { fee, need, ok: (vals[0] || 0) >= need, have: vals[0] || 0, later };
  }

  const burnRateOf = (rates) => Math.max(Number(rates && rates.effective_rate) || 0, Number(rates && rates.submit_fee_rate) || 0, 1) * 1.1;

  function pickFunding(utxos, need = 0) {
    const list = (Array.isArray(utxos) ? utxos : [utxos]).filter(Boolean);
    const unconfirmed = (u) => (u.status && u.status.confirmed === false ? 1 : 0);
    const cover = list.filter((u) => Number(u.value) >= need).sort((a, b) => unconfirmed(a) - unconfirmed(b) || Number(a.value) - Number(b.value));
    return cover[0] || list.slice().sort((a, b) => unconfirmed(a) - unconfirmed(b) || Number(b.value) - Number(a.value))[0] || null;
  }
  // `rec`'s own coins are spent first, its move's change (moveChangeOf) and the coin its last burn held: the wallet's coin list leaves
  // them out, being held for that bridge. When every free coin is held for this key's other bridges, that is said (code 'held'),
  // since each of their burns returns change this one can pay with.
  async function pickFundingUtxo(address, need = 0, rec = null) {
    const own = rec ? await ownCoins(rec, address) : [];
    const ownPick = pickFunding(own, need);
    if (ownPick && ownPick.value >= need) return ownPick;
    const utxos = await chain.getUtxos(address);
    const sorted = await chain.pickSafeCommitSats(utxos);
    const pick = pickFunding([...own, ...(Array.isArray(sorted) ? sorted : [sorted])], need);
    if (!pick) {
      const others = rec && loadAll(rec.walletPub).some((r) => r.id !== rec.id && ((heldBurn(r) && heldBurn(r).fundingUtxo) || (r.stage === 'burn-signed' && r.burn && r.burn.fundingUtxo)));
      if (others) throw Object.assign(new Error('burndep-ux: the free bitcoin at this address is held for your other bridges’ burns'), { code: 'held' });
      throw new Error('burndep-ux: no safe funding UTXO available at this address');
    }
    return { txid: pick.txid, vout: pick.vout, value: pick.value };
  }
  async function ownCoins(rec, address) {
    const kept = rec.checkWait && rec.checkWait.burn && rec.checkWait.burn.fundingUtxo;
    const [change, held] = await Promise.all([
      moveChange(rec, address),
      // the coin its last burn held, unless another bridge has taken it since (two burns on one coin would leave one stuck)
      kept && !isReserved(kept.txid, kept.vout, rec.id)
        ? fetchChainJson(`/tx/${stripHex(kept.txid)}/outspend/${Number(kept.vout)}`).then((o) => (o && o.spent === false ? { txid: stripHex(kept.txid).toLowerCase(), vout: Number(kept.vout), value: Number(kept.value) } : null), () => null)
        : null,
    ]);
    return [change, held].filter(Boolean);
  }
  async function moveChange(rec, address) {
    if (!moveChangeOf(rec)) return null;
    const txid = stripHex(rec.migrate.revealTxid).toLowerCase();
    const [t, out] = await Promise.all([fetchChainJson(`/tx/${txid}`), fetchChainJson(`/tx/${txid}/outspend/1`)]).catch(() => [null, null]);
    const o = t && Array.isArray(t.vout) ? t.vout[1] : null;
    if (!o || o.scriptpubkey_address !== address || !out || out.spent !== false) return null;
    return { txid, vout: 1, value: Number(o.value) };
  }

  async function startingLease(id, run) {
    if (inFlight.has(id)) throw new Error('burndep-ux: this note is being started in this page right now');
    if (!tryAcquireLease(id)) throw new Error('burndep-ux: this note is being started in another tab right now');
    inFlight.add(id);
    const renew = setInterval(() => { try { storage.setItem(leaseKey(id), JSON.stringify({ owner: sessionId, at: now() })); } catch {} }, Math.max(1000, Math.floor(LEASE_TTL_MS / 3)));
    try { return await run(); } finally { inFlight.delete(id); clearInterval(renew); releaseLease(id); }
  }
  const start = (args) => startingLease(recordId(args.note.txid, args.note.vout), () => startNow(args));
  async function startNow({ note, walletPriv, fundingUtxo, feeRate = null }) {
    const walletPub = secp.getPublicKey(walletPriv, true);
    const id = recordId(note.txid, note.vout);
    if (getRecord(walletPub, id)) throw new Error('burndep-ux: a bridge already exists for this note');
    if (isReserved(note.txid, note.vout)) throw new Error('burndep-ux: this note is already reserved by another bridge in progress');
    if (BigInt(note.amount) > BURNDEP_BETA_CAP_RAW) throw new Error('burndep-ux: over the beta cap');

    const sourcePriv = note.stealthTweakedSk ? hexToBytesLocal(stripHex(note.stealthTweakedSk)) : null;
    const P = freshPrims(walletPriv);
    const mig = await reveal.buildMigrationTxs({
      prims: P, walletPriv, sourcePriv,
      note: { assetId: tacAssetId, amount: BigInt(note.amount), blinding: BigInt(note.blinding), txid: note.txid, vout: note.vout, sats: note.sats },
      fundingUtxo, feeRate,
    });
    const rec = {
      id, network, walletPub: bytesToHexLocal(walletPub), stage: 'migrate-signed', createdAt: now(),
      source: { txid: note.txid, vout: note.vout, sats: note.sats, assetId: tacAssetId, amount: BigInt(note.amount), blinding: BigInt(note.blinding) },
      migrate: {
        commitHex: mig.commitHex, revealHex: mig.revealHex, commitTxid: mig.commitTxid, revealTxid: mig.revealTxid,
        fundingUtxo: { txid: fundingUtxo.txid, vout: fundingUtxo.vout, value: fundingUtxo.value },
        feeRate: mig.feeRate, commitFee: mig.commitFee, revealFee: mig.revealFee,
      },
      burnHome: {
        txid: mig.burnHome.txid, vout: mig.burnHome.vout, value: mig.burnHome.value,
        cx: mig.burnHome.cx, cy: mig.burnHome.cy, blinding: mig.burnHome.blinding,
        xonly: bytesToHexLocal(mig.burnHome.xonly), spk: bytesToHexLocal(mig.burnHome.spk),
        controlBlock: bytesToHexLocal(mig.burnHome.controlBlock), scriptS: bytesToHexLocal(mig.burnHome.scriptS),
      },
    };
    if (getRecord(walletPub, id)) throw new Error('burndep-ux: a bridge already exists for this note');
    return keptRecord(rec);
  }

  let _burner = null;
  const burner = () => _burner || (_burner = makeBridgeBurnBroadcaster({ pool, bridgeMint }));
  // `recipient` { pubHex, name? } pays someone else: the burn names a stealth lock for their address (OP_BRIDGE_STEALTH_MINT) instead
  // of a note for this key, and they claim it under their private payments.
  const startReflected = (args) => startingLease(recordId(args.note.txid, args.note.vout), () => startReflectedNow(args));
  async function startReflectedNow({ note, walletPriv, feeRate = null, allowHighFee = false, recipient = null }) {
    const walletPub = secp.getPublicKey(walletPriv, true);
    const id = recordId(note.txid, note.vout);
    if (getRecord(walletPub, id)) throw new Error('burndep-ux: a bridge already exists for this note');
    if (isReserved(note.txid, note.vout)) throw new Error('burndep-ux: this note is already reserved by another bridge in progress');
    const asset = assetOf(note.assetId || tacAssetId);
    if (!asset) throw new Error('burndep-ux: this asset cannot be sent back to Ethereum here');
    if (BigInt(note.amount) > asset.capRaw) throw new Error('burndep-ux: over the beta cap');
    if (note.stealthTweakedSk) throw new Error(`burndep-ux: ${PRIVATE_NOTE}`);
    const recipientPub = recipient ? lc(withHex(String(recipient.pubHex))) : null;
    if (recipient) {
      if (!/^0x0[23][0-9a-f]{64}$/.test(recipientPub)) throw new Error('burndep-ux: the recipient must be a private-payment address');
      if (recipientPub === '0x' + bytesToHexLocal(walletPub)) throw new Error('burndep-ux: that is this key’s own address; bridge without a recipient to receive it yourself');
    }
    const lockDeadline = recipient ? bridgeMint.stealthDeadline(Math.floor(now() / 1000)) : null;
    const lockerScanPriv = recipient ? '0x' + bytesToHexLocal(walletPriv) : null;
    const p2tr = !!note.p2tr;
    if (p2tr && !allowHighFee) {
      const rate = Number(feeRate != null ? feeRate : await chain.getFeeRate('priority'));
      if (rate > RETURN_FEE_CEILING) throw new Error(`burndep-ux: Bitcoin fees are high right now (${Math.round(rate)} sat/vB), so this waits for them to fall under ${RETURN_FEE_CEILING}`);
    }
    const d = await callWorker('GET', '/reflection/dump');
    const s = d && d.snapshot;
    if (!s || !Array.isArray(s.noteLeaves) || !Array.isArray(s.liveTriples)) throw new Error('burndep-ux: could not read the reflection state; try again in a moment');
    const snapshot = { noteLeaves: s.noteLeaves, liveTriples: s.liveTriples, spentLinks: s.spentLinks || [], cbtcLockTriples: s.cbtcLockTriples || [], burnNodes: s.burnNodes || [], height: d.attestedHeight ?? s.height };
    const P = freshPrims(walletPriv);
    const safe = await chain.pickSafeCommitSats(await chain.getUtxos(P.wallet.address()));
    const built = await burner().buildBridgeBurnTxs({
      prims: P, snapshot, feeRate, fundingUtxos: Array.isArray(safe) ? safe : [safe].filter(Boolean),
      note: { txid: stripHex(note.txid), vout: Number(note.vout), sats: Number(note.sats), asset: asset.assetId, value: BigInt(note.amount), blinding: BigInt(note.blinding), script: p2tr ? '5120' + bytesToHexLocal(walletPub.slice(1)) : bytesToHexLocal(p2wpkhScriptOf(walletPub)) },
      notePriv: walletPriv, chainBinding: withHex(chainBindingHex()), sourceClass: 1, fee: 0n,
      ...(recipient
        ? { stealthDest: (nu, v) => bridgeMint.stealthDestFor({ asset: asset.assetId, lockerScanPriv, nullifier: nu, recipientSpendPub: recipientPub, value: v, deadline: lockDeadline }) }
        : {
          dest: { owner: pickDestOwner(walletPriv, asset.assetId).owner },
          deriveDestBlinding: (nu) => mintRecovery.deriveBridgeMintBlinding({ privkey: walletPriv, nullifier: nu }),
        }),
    });
    const p = built.plan;
    const funding = built.commitTx.inputs.map((i) => ({ txid: i.txid, vout: i.vout }));
    if (getRecord(walletPub, id)) throw new Error('burndep-ux: a bridge already exists for this note');
    return keptRecord({
      id, network, walletPub: bytesToHexLocal(walletPub), path: 'reflected', stage: 'rburn-signed', createdAt: now(),
      source: { txid: stripHex(note.txid).toLowerCase(), vout: Number(note.vout), sats: Number(note.sats), assetId: asset.assetId, ticker: asset.ticker, ...(p2tr ? { p2tr: true } : {}), amount: BigInt(note.amount), blinding: BigInt(note.blinding) },
      burn: { txid: built.revealTxid, hex: built.revealHex, commitTxid: built.commitTxid, commitHex: built.commitHex, fee: built.commitFee + built.revealFee, feeRate: built.feeRate, fundingUtxo: funding[0], fundingUtxos: funding },
      envelope: { destLeaf: p.destLeaf, nullifier: p.nullifier, burnId: p.burnId },
      ...(p.stealth ? { stealth: stealthRecord(p.stealth, recipient) } : {}),
      mint: {
        sourceClass: p.sourceClass, spentTxid: p.spentTxid, spentVout: p.spentVout, chainBinding: p.chainBinding,
        burned: { value: p.burned.value, blinding: p.burned.blinding, owner: p.burned.owner },
        dest: { value: p.dest.value, blinding: p.dest.blinding, owner: p.dest.owner },
      },
    });
  }

  // What the journal keeps of a stealth bridge: public fields only. The ephemeral key, the lock's blinding and the refund key are not
  // kept; stealthDestFor derives them again from this key, the burn's nullifier, the recipient and the deadline.
  function stealthRecord(sd, recipient) {
    return {
      recipientPub: sd.recipientSpendPub, ...(recipient && recipient.name ? { recipientName: String(recipient.name) } : {}),
      deadline: String(sd.deadline), ownerPub: sd.ownerPub, lockLeaf: sd.lockLeaf, refundPub: sd.refundPub, ephemeralPub: sd.ephemeralPub,
    };
  }
  function stealthDestOf(rec, walletPriv) {
    const sd = bridgeMint.stealthDestFor({
      asset: withHex((rec.source && rec.source.assetId) || tacAssetId), lockerScanPriv: '0x' + bytesToHexLocal(walletPriv), nullifier: rec.envelope.nullifier,
      recipientSpendPub: rec.stealth.recipientPub, value: BigInt(rec.mint.dest.value), deadline: BigInt(rec.stealth.deadline),
    });
    if (lc(sd.lockLeaf) !== lc(rec.envelope.destLeaf)) throw new Error('burndep-ux: this key does not rebuild the stealth lock this burn named, so it cannot mint it');
    return sd;
  }

  const ARM_RETRY_MS = 10 * 60 * 1000, ARM_TRIES = 6, ARM_GRACE_MS = 15 * 60 * 1000;
  const ARMABLE = new Set(['rburn-signed', 'rburn-sent', 'rburn-mined', 'rfolded']);
  async function armMint(walletPub, id, { walletPriv }) {
    const rec = getRecord(walletPub, id);
    // The relay arms only a plain mint (POST /confidential/arm takes type bridgemint), so a bridge that pays a stealth address is minted
    // from this page once the burn is folded.
    if (!rec || rec.path !== 'reflected' || !rec.mint || rec.stealth || !ARMABLE.has(rec.stage) || typeof bridgeMint.armMint !== 'function') return rec;
    const a = rec.arm;
    if (a && (a.ok || Number(a.tries) >= ARM_TRIES || now() - Number(a.at || 0) < ARM_RETRY_MS)) return rec;
    if (!walletPriv) throw new Error('burndep-ux: arming needs the wallet key');
    const m = rec.mint, assetId = (rec.source && rec.source.assetId) || tacAssetId;
    let arm;
    try {
      const r = await bridgeMint.armMint({
        network, sourceClass: m.sourceClass, spentTxid: m.spentTxid, spentVout: m.spentVout, asset: withHex(assetId), chainBinding: m.chainBinding,
        burned: { value: BigInt(m.burned.value), blinding: BigInt(m.burned.blinding), owner: m.burned.owner },
        dest: { value: BigInt(m.dest.value), blinding: BigInt(m.dest.blinding), owner: m.dest.owner },
        recovery: recoveryFor(walletPriv, m.dest.value, assetId),
      });
      arm = r.ok ? { ok: true, status: r.status || 'armed', dest: r.dest, at: now() } : { ok: false, code: r.code || null, error: String(r.error || '').slice(0, 200), tries: (a && a.tries || 0) + 1, at: now() };
    } catch (e) { arm = { ok: false, error: String((e && e.message) || e).slice(0, 200), tries: (a && a.tries || 0) + 1, at: now() }; }
    const cur = getRecord(walletPub, id);
    return cur ? putRecord({ ...cur, arm }) : rec;
  }

  const inFlight = new Set();
  const WAITS = new Set(['migrate-sent', 'migrate-confirmed', 'traced', 'burn-submitted', 'burn-mined', 'registered', 'rburn-sent', 'rburn-mined', 'recovering', 'reclaim-sent']);
  const passing = (e) => { const st = Number(e && e.status); return st === 429 || st >= 500 || (e && e.code === 'trace_reading') || /failed to fetch|networkerror|load failed|timed? ?out|aborted|\bAPI (429|5\d\d)\b|rate limited|chain APIs unreachable|rates failed \(5\d\d\)/i.test(String((e && e.message) || e)); };
  // A signed burn that a busy or unreachable miner (429, 5xx, no network) did not take is not one the miner refused, so it does not count at the pace of a refusal
  // ("The miner did not take this burn" and Move back come after three counted failures, and Move back costs two transactions to undo a burn that may be fine):
  // it counts once in half an hour, so a miner this page cannot reach for about an hour still offers Move back, and a blip of a few minutes does not.
  const SLOW_COUNT = new Set(['burn-signed']), SLOW_COUNT_MS = 30 * 60 * 1000;
  async function advance(walletPub, id, { walletPriv = null, onProgress = null, selfSettle = null, maxFeeRate = null, go = false } = {}) {
    const rec = getRecord(walletPub, id);
    if (!rec) throw new Error(`burndep-ux: no bridge record for ${id}`);
    if (walletPriv && lc(bytesToHexLocal(secp.getPublicKey(walletPriv, true))) !== lc(rec.walletPub)) throw new Error('burndep-ux: this bridge belongs to another key');
    if (inFlight.has(id)) throw new Error('burndep-ux: this bridge is being advanced in this page right now');
    if (!tryAcquireLease(id)) throw new Error('burndep-ux: this bridge is being advanced in another tab right now');
    inFlight.add(id);
    const renew = setInterval(() => { try { storage.setItem(leaseKey(id), JSON.stringify({ owner: sessionId, at: now() })); } catch {} }, Math.max(1000, Math.floor(LEASE_TTL_MS / 3)));
    let at = null;
    try {
      const cur = getRecord(walletPub, id);
      if (!cur) throw new Error(`burndep-ux: no bridge record for ${id}`);
      at = cur;
      const fn = STAGE_ADVANCE[cur.stage];
      if (!fn) return cur;
      const result = await fn(cur, { walletPriv, onProgress, selfSettle, maxFeeRate, go });
      return cur.lastError ? putRecord({ ...result, lastError: null, errorCount: 0 }) : result;
    } catch (e) {
      const now_ = at && getRecord(walletPub, id);
      if (now_ && now_.stage === at.stage && !(WAITS.has(at.stage) && passing(e))) {
        const slow = SLOW_COUNT.has(at.stage) && passing(e), prev = Number(now_.lastError && now_.lastError.countedAt) || 0;
        const counted = !relayFault(e) && (!slow || now() - prev >= SLOW_COUNT_MS);
        putRecord({ ...now_, lastError: { message: String((e && e.message) || e), at: now(), ...(counted ? { countedAt: now() } : prev ? { countedAt: prev } : {}), ...(dayRefusal(e) ? { until: nextUtcDay(now()) } : relayFault(e) ? { relay: true } : {}) }, errorCount: (now_.errorCount || 0) + (counted ? 1 : 0) });
      }
      throw e;
    } finally { inFlight.delete(id); clearInterval(renew); releaseLease(id); }
  }

  const STAGE_ADVANCE = {
    'migrate-signed': async (rec) => {
      await sendPair(rec.migrate.commitHex, rec.migrate.commitTxid, rec.migrate.revealHex);
      return putRecord({ ...rec, stage: 'migrate-sent', sentAt: now() });
    },
    'migrate-sent': async (rec) => {
      const st = await checkTxidStatus(rec.migrate.revealTxid);
      if (!Number.isInteger(st && st.burnBlockHeight)) {
        await resend(rec.migrate.commitHex, rec.migrate.revealHex, rec.migrate.revealTxid);
        return rec;
      }
      return putRecord({ ...rec, stage: 'migrate-confirmed', migrateConfirmedAt: now(), migrateHeight: st.burnBlockHeight });
    },
    'migrate-confirmed': async (rec) => {
      const tracked = await isLive(rec.burnHome.txid, 0, { fresh: true });
      if (tracked === true) return putRecord({ ...rec, stage: 'stopped', stoppedAt: now(), stoppedWhy: 'tracked' });
      if (tracked === null) return rec;
      const traced = await traceNote({ txid: rec.burnHome.txid, vout: 0, assetId: tacAssetId });
      if (traced.hops > MAX_HOPS_BURN_HOME) throw new Error(`burndep-ux: burn-home traces in ${traced.hops} hops, over the ${MAX_HOPS_BURN_HOME}-hop limit`);
      const bundle = { ...traced.bundle, burned: { cx: rec.burnHome.cx, cy: rec.burnHome.cy } };
      return putRecord({ ...rec, stage: 'traced', bundle, hops: traced.hops, homeChecked: true });
    },
    traced: async (rec, { walletPriv, maxFeeRate, go = false }) => {
      const tracked = await isLive(rec.burnHome.txid, 0, { fresh: true });
      if (tracked === true) return putRecord({ ...rec, stage: 'stopped', stoppedAt: now(), stoppedWhy: 'tracked' });
      if (tracked === null) return rec;
      if (!walletPriv) throw new Error('burndep-ux: this stage needs the wallet key');
      const P = freshPrims(walletPriv);
      const burnHomeOnChain = await fetchChainJson(`/tx/${stripHex(rec.burnHome.txid)}`);
      const chainSpk = burnHomeOnChain.vout[0].scriptpubkey;
      const burnHome = reveal.reconstructBurnHome({
        prims: P, walletPriv, source: { txid: rec.source.txid, vout: rec.source.vout },
        amount: rec.source.amount, burnHomeTxid: rec.burnHome.txid, chainSpk,
      });

      const dest = deriveDest(walletPriv, burnHome, rec.burnHome.txid, rec.source.amount);
      const target = withHex(chainBindingHex());
      const { cx: destCx, cy: destCy } = pool.commitXY(dest.value, dest.blinding);
      const destLeaf = pool.leaf(withHex(tacAssetId), destCx, destCy, dest.owner);
      const envelope = { assetId: withHex(tacAssetId), nullifier: dest.nullifier, destLeaf, target };

      // While its check waits, the burn it was asked about is kept and asked about again unchanged, so the API joins the check it
      // already has running (or reads its answer) rather than starting another; past CHECK_HOLD_MS it is built again at the day's rate.
      let burn = heldBurn(rec);
      if (!burn) {
        const rates = await broadcaster.slipstreamRates();
        const feeRate = burnRateOf(rates);
        if (maxFeeRate != null && feeRate > Number(maxFeeRate)) {
          return putRecord({ ...rec, feeWait: { rate: feeRate, max: Number(maxFeeRate), at: now() } });
        }
        let fundingUtxo = rec.burn && rec.burn.fundingUtxo ? rec.burn.fundingUtxo : null;
        // Every free coin held for this key's other burns is a wait, not a failure: their change comes back, and the page asks again.
        if (!fundingUtxo) {
          try { fundingUtxo = await pickFundingUtxo(P.wallet.address(), Math.ceil(300 * feeRate) + 846, rec); }
          catch (e) { if (e && e.code === 'held') return putRecord({ ...rec, checkWait: { at: now(), go: !!go || !!(rec.checkWait && rec.checkWait.go), fund: 'others' } }); throw e; }
        }
        const built = await reveal.buildBurnDepositRevealTxs({ prims: P, burnHome, envelope, fundingUtxo, feeRate });
        burn = { hex: built.revealHex, txid: built.revealTxid, feeRate: built.feeRate, fee: built.fee, fundingUtxo, at: now() };
      }
      // A long history's first check is still reading its blocks, or the API is busy checking others: nothing is sent yet, and the
      // next advance asks again (a holder who pressed Burn it is carried on by the page without a second press, `go`).
      // What the API said about the wait (where the check stands in its line, or that the line is full) is kept for the page to show.
      const wait = (said) => putRecord({ ...rec, feeWait: null, checkWait: { at: now(), go: !!go || !!(rec.checkWait && rec.checkWait.go), burn, ...said } });
      let check;
      try { check = await callWorker('POST', '/reflection/burndep/check', { bundle: rec.bundle, assetId: withHex(tacAssetId), burnTxHex: burn.hex }); }
      catch (e) { if (Number(e && e.status) === 429) return wait({ busy: true }); throw e; }
      if (check && check.pending) return wait(waitProgress(check.progress));
      if (!check.ok || !check.admitted) throw new Error(`burndep-ux: the burn would not be admitted yet: ${(check && check.reason) || (check && check.error) || 'unknown'}`);

      const { at: _builtAt, ...signed } = burn;
      return putRecord({ ...rec, stage: 'burn-signed', feeWait: null, checkWait: null, burn: signed, envelope, dest });
    },
    'burn-signed': async (rec) => {
      const tracked = await isLive(rec.burnHome.txid, 0, { fresh: true });
      if (tracked === true) return putRecord({ ...rec, stage: 'stopped', stoppedAt: now(), stoppedWhy: 'tracked' });
      if (tracked === null) return rec;
      try { await broadcaster.submitToSlipstream(rec.burn.hex); }
      catch (e) {
        // A burn Bitcoin already has needs no sending: an earlier send whose answer this page never saw, or another browser's, put it
        // there, and the miner now refuses it because the burn itself has spent its coins. The bridge carries on from its mining.
        if ((await chainTxState(rec.burn.txid)) === 'present') {
          return putRecord({ ...rec, stage: 'burn-submitted', submittedAt: rec.submittedAt || now(), lastError: null, errorCount: 0 });
        }
        // A signed burn whose coin another transaction has spent can never be mined: when Bitcoin plainly has neither the burn nor its
        // coin unspent, the bridge goes back to its move (the burn address untouched) and builds its burn on another coin.
        const u = rec.burn.fundingUtxo;
        const out = u ? await fetchChainJson(`/tx/${stripHex(u.txid)}/outspend/${Number(u.vout)}`).catch(() => null) : null;
        if (out && out.spent === true && out.txid && lc(stripHex(out.txid)) !== lc(stripHex(rec.burn.txid)) && (await chainTxState(rec.burn.txid)) === 'absent') {
          const { burn, envelope, ...rest } = rec;
          return putRecord({ ...rest, stage: 'traced', checkWait: { at: now(), go: true }, lastError: null, errorCount: 0, rebuiltFrom: { burnTxid: burn.txid, coinSpentBy: lc(stripHex(out.txid)), at: now() } });
        }
        throw e;
      }
      return putRecord({ ...rec, stage: 'burn-submitted', submittedAt: now() });
    },
    'burn-submitted': async (rec) => {
      const st = await checkTxidStatus(rec.burn.txid);
      if (!Number.isInteger(st && st.burnBlockHeight)) return rec;
      return putRecord({ ...rec, stage: 'burn-mined', burnMinedAt: now(), burnHeight: st.burnBlockHeight });
    },
    'burn-mined': async (rec) => {
      await broadcaster.registerBurnDeposit({ burnTxidDisplay: rec.burn.txid, bundle: rec.bundle, network });
      return putRecord({ ...rec, stage: 'registered', registeredAt: now() });
    },
    'reclaim-sent': async (rec) => {
      const t = await fetchChainJson(`/tx/${stripHex(rec.reclaim.txid)}`).catch(() => null);
      if (!t || !t.status || !t.status.confirmed) {
        if (rec.burn && rec.burn.txid) {
          const b = await fetchChainJson(`/tx/${stripHex(rec.burn.txid)}`).catch(() => null);
          if (b && b.status && b.status.confirmed) return putRecord({ ...rec, stage: 'burn-mined', burnMinedAt: now(), burnHeight: b.status.block_height });
        }
        const refused = [];
        for (const hex of [rec.reclaim.commitHex, rec.reclaim.revealHex]) {
          try { await chain.broadcastWithRetry(hex); } catch (e) { refused.push(String((e && e.message) || e)); }
        }
        if (refused.length && /missingorspent|missing-inputs|inputs-missing|bad-txns-inputs|already spent|txn-mempool-conflict|conflict/i.test(refused[0])) {
          const [c, r] = await Promise.all([chainTxState(rec.reclaim.commitTxid), chainTxState(rec.reclaim.txid)]);
          if (c === 'absent' && r === 'absent') {
            const { reclaim, reclaimFrom, reclaimSentAt, ...rest } = rec;
            return putRecord({ ...rest, stage: reclaimFrom || 'stopped', lastError: { message: 'Bitcoin did not take the move back, and its coin was spent elsewhere. Your TAC is where it was: Move back makes it again.', at: now() }, errorCount: 0 });
          }
        }
        return rec;
      }
      return putRecord({ ...rec, stage: 'reclaimed', reclaimedAt: now() });
    },
    'rburn-signed': async (rec) => {
      await sendPair(rec.burn.commitHex, rec.burn.commitTxid, rec.burn.hex);
      return putRecord({ ...rec, stage: 'rburn-sent', sentAt: now() });
    },
    'rburn-sent': async (rec) => {
      const t = await txMined(rec.burn.txid);
      if (t.state !== 'mined') {
        await resend(rec.burn.commitHex, rec.burn.hex, rec.burn.txid);
        return rec;
      }
      return putRecord({ ...rec, stage: 'rburn-mined', burnMinedAt: now(), burnHeight: t.height });
    },
    'rburn-mined': async (rec) => {
      const h0 = Number(rec.burnHeight), at = await attestedHeight().catch(() => null);
      if (Number.isInteger(h0) && Number.isInteger(at) && at < h0) return rec;
      const r = await reflected(true);
      if (r.dests.has(lc(rec.envelope.destLeaf))) return putRecord({ ...rec, stage: 'rfolded', foldedAt: now() });
      const h = Number(rec.burnHeight);
      if (!Number.isInteger(h) || !Number.isInteger(r.height) || h > r.height) return rec;
      return putRecord({ ...rec, stage: 'not-recorded', notRecordedAt: now() });
    },
    rfolded: async (rec, { walletPriv, onProgress, selfSettle }) => {
      if (!walletPriv) throw new Error('burndep-ux: this stage needs the wallet key');
      const say = (phase, extra) => { try { onProgress && onProgress({ phase, ...extra }); } catch { } };
      const m = rec.mint;
      const already = await mintLanded(rec);
      if (already) return already;
      if (mintQueued(rec, selfSettle)) return rec;
      if (!selfSettle && rec.arm && rec.arm.ok && typeof bridgeMint.armedStatus === 'function') {
        const st = await bridgeMint.armedStatus(rec.arm.dest, { network }).catch(() => null);
        if (st && st.status === 'minted') { const done = await mintLanded(rec); if (done) return done; }
        if (st && (st.status === 'queued' || st.status === 'armed') && now() - Number(rec.foldedAt || rec.arm.at || 0) < ARM_GRACE_MS) {
          if (st.jobId) { noteJob(rec, st.jobId); return getRecord(rec.walletPub, rec.id) || rec; }
          return rec;
        }
      }
      say('fetching-snapshot');
      let minted;
      try {
        const common = {
          network, sourceClass: m.sourceClass, spentTxid: m.spentTxid, spentVout: m.spentVout,
          asset: withHex((rec.source && rec.source.assetId) || tacAssetId), chainBinding: m.chainBinding,
          burned: { value: BigInt(m.burned.value), blinding: BigInt(m.burned.blinding), owner: m.burned.owner },
          selfSettle,
          waitOpts: { timeoutMs: MINT_WAIT_MS, onJob: (jobId) => { noteJob(rec, jobId); say('submitted', { jobId }); }, onUpdate: (st) => say('status', { status: st.status }) },
        };
        minted = rec.stealth
          ? await bridgeMint.bridgeStealthMint({ ...common, stealthDest: stealthDestOf(rec, walletPriv), lockerScanPriv: '0x' + bytesToHexLocal(walletPriv) })
          : await bridgeMint.bridgeMint({
            ...common,
            dest: { value: BigInt(m.dest.value), blinding: BigInt(m.dest.blinding), owner: m.dest.owner },
            recovery: recoveryFor(walletPriv, m.dest.value, (rec.source && rec.source.assetId) || tacAssetId),
          });
      } catch (e) {
        const done = await mintLanded(rec);
        if (done) return done;
        throw e;
      }
      return putRecord({ ...rec, stage: 'minted', mintedAt: now(), mintedJobId: minted.jobId || null, mintedTxHash: minted.txHash || null });
    },
    recovering: async (rec) => {
      const c = await callWorker('GET', `/bridge/recover?burn=${stripHex(rec.burn.txid)}`);
      if (c && c.status === 'sent') return putRecord({ ...rec, stage: 'recovered', recover: { ...rec.recover, status: 'sent', txid: c.txid, sentAt: now() } });
      if (c && c.status === 'none') return putRecord({ ...rec, stage: 'not-recorded' });
      if (c && c.status && c.status !== (rec.recover && rec.recover.status)) return putRecord({ ...rec, recover: { ...rec.recover, status: c.status } });
      return rec;
    },
    registered: async (rec) => {
      const st = await checkTxidStatus(rec.burn.txid);
      if (!rec.burnHeight && Number.isInteger(st && st.burnBlockHeight)) rec = putRecord({ ...rec, burnHeight: st.burnBlockHeight });
      if (st.status !== 'folded' && st.status !== 'not-recorded') return rec;
      const recorded = await burnRecorded(rec);
      if (recorded === false) return putRecord({ ...rec, stage: 'not-recorded', notRecordedAt: now() });
      if (recorded !== true) return rec;
      return putRecord({ ...rec, stage: 'folded', foldedAt: now() });
    },
    folded: async (rec, { walletPriv, onProgress, selfSettle }) => {
      const already = await mintLanded(rec);
      if (already) return already;
      const recorded = await burnRecorded(rec);
      if (recorded === false) return putRecord({ ...rec, stage: 'not-recorded', notRecordedAt: now() });
      if (!walletPriv) throw new Error('burndep-ux: this stage needs the wallet key');
      if (mintQueued(rec, selfSettle)) return rec;
      const say = (phase, extra) => { try { onProgress && onProgress({ phase, ...extra }); } catch { } };
      const dest = rec.dest || deriveDest(walletPriv, rec.burnHome, rec.burnHome.txid, rec.source.amount);
      say('fetching-snapshot');
      let minted;
      try {
        minted = await bridgeMint.bridgeMint({
        network, sourceClass: 0,
        spentTxid: withHex(revHex(rec.burnHome.txid)), spentVout: 0,
        asset: withHex(tacAssetId), chainBinding: withHex(chainBindingHex()),
        burned: { value: rec.source.amount, blinding: rec.burnHome.blinding, owner: '0x' + '00'.repeat(32) },
        dest: { value: dest.value, blinding: dest.blinding, owner: dest.owner },
        recovery: recoveryFor(walletPriv, dest.value),
        selfSettle,
        waitOpts: {
          timeoutMs: MINT_WAIT_MS,
          onJob: (jobId) => { noteJob(rec, jobId); say('submitted', { jobId }); },
          onUpdate: (st) => say('status', { status: st.status }),
        },
        });
      } catch (e) {
        const done = await mintLanded({ ...rec, dest });
        if (done) return done;
        throw e;
      }
      return putRecord({ ...rec, dest, stage: 'minted', mintedAt: now(), mintedJobId: minted.jobId || null, mintedTxHash: minted.txHash || null });
    },
  };

  async function sendPair(commitHex, commitTxid, revealHex) {
    try { await chain.broadcastWithRetry(commitHex); }
    catch (e) { if ((await chainTxState(commitTxid)) !== 'present') throw e; }
    await chain.broadcastWithRetry(revealHex);
  }
  async function resend(commitHex, revealHex, revealTxid) {
    const errs = [];
    if (commitHex) await chain.broadcastWithRetry(commitHex).catch((e) => errs.push(e));
    if (revealHex) await chain.broadcastWithRetry(revealHex).catch((e) => errs.push(e));
    if (errs.length && (await chainTxState(revealTxid)) === 'absent') throw errs[errs.length - 1];
  }

  function noteJob(rec, jobId) {
    try { const cur = getRecord(rec.walletPub, rec.id); if (cur) putRecord({ ...cur, mintJob: { id: String(jobId), at: now() } }); } catch { }
  }
  function mintQueued(rec, selfSettle) {
    const j = rec.mintJob;
    if (selfSettle || !j || now() - Number(j.at || 0) > MINT_QUEUE_MS) return false;
    return !(rec.lastError && Number(rec.lastError.at || 0) > Number(j.at || 0));
  }

  async function mintLanded(rec) {
    const nu = (rec.envelope && rec.envelope.nullifier) || (rec.dest && rec.dest.nullifier);
    if (!nullifierSpent || !nu) return null;
    try { return (await nullifierSpent(nu)) ? putRecord({ ...rec, stage: 'minted', mintedAt: now(), lastError: null, errorCount: 0 }) : null; } catch { return null; }
  }

  function pickDestOwner(walletPriv, assetId = tacAssetId) {
    const dn = pool.deriveNote(walletPriv, withHex(assetId), 0);
    return { destIndex: 0, owner: pool.nkToOwner(dn.secret), secret: dn.secret };
  }

  const scanRound = (v) => { let x = BigInt(v); if (x <= 0n) return false; while (x % 10n === 0n) x /= 10n; return x < 100n; };
  function recoveryFor(walletPriv, value, assetId = tacAssetId) {
    if (lc(stripHex(assetId)) === lc(stripHex(tacAssetId)) && scanRound(value)) return { seedDerived: true };
    return { ownerPub: '0x' + bytesToHexLocal(secp.getPublicKey(walletPriv, true)), secret: pickDestOwner(walletPriv, assetId).secret };
  }

  function deriveDest(walletPriv, { cx, cy }, burnHomeTxid, amount) {
    const { destIndex, owner } = pickDestOwner(walletPriv);
    const nullifier = pool.nullifier(kit.burnDepositLeaf(withHex(tacAssetId), cx, cy, withHex(revHex(burnHomeTxid)), 0));
    const blinding = mintRecovery.deriveBridgeMintBlinding({ privkey: walletPriv, nullifier });
    return { index: destIndex, owner, blinding, value: amount, nullifier };
  }

  async function checkTxidStatus(txid) {
    return callWorker('GET', `/reflection/burndep/status?txid=${stripHex(txid)}`);
  }
  async function callWorker(method, path, body) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!f) throw new Error('burndep-ux: no fetch implementation');
    const url = `${workerBase}${path}${path.includes('?') ? '&' : '?'}network=${network}`;
    const res = await f(url, method === 'GET' ? undefined : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      const said = (j && (j.error || j.reason)) || (res.status === 404 ? 'not found' : `the service answered ${res.status}`);
      const wait = Number(j && j.retryAfter) || Number(res.headers && res.headers.get && res.headers.get('retry-after')) || null;
      throw Object.assign(new Error(`burndep-ux: ${said}`), { status: res.status, retryAfter: wait });
    }
    return res.json();
  }
  function fetchChainJson(path) { return callWorker('GET', `/chain${path}`); }
  async function fetchChainText(path) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!f) throw new Error('burndep-ux: no fetch implementation');
    const res = await f(`${workerBase}/chain${path}${path.includes('?') ? '&' : '?'}network=${network}`);
    // carries the status, so a busy or failing explorer (429, 5xx) is a read to repeat (`passing`), not an answer that this is no bridge
    if (!res.ok) throw Object.assign(new Error(`burndep-ux: chain read failed (${res.status})`), { status: res.status });
    return (await res.text()).trim().replace(/^0x/, '');
  }

  function list(walletPub) { return loadAll(walletPub); }
  function abandon(walletPub, id) { saveAll(walletPub, loadAll(walletPub).filter((r) => r.id !== id)); }

  const DIRECT_EXPLORERS = ['https://mempool.space/api', 'https://blockstream.info/api'];
  async function txMined(txid) {
    const id = stripHex(txid);
    const mined = (s) => (s.confirmed === true && Number.isInteger(Number(s.block_height)) ? { state: 'mined', height: Number(s.block_height) } : { state: 'notmined' });
    let answered = false, failure = null;
    try {
      const t = await fetchChainJson(`/tx/${id}`);
      if (t && t.status && typeof t.status.confirmed === 'boolean') { if (t.status.confirmed) return mined(t.status); answered = true; }
      else failure = new Error('the service gave no status');
    } catch (e) { if (Number(e && e.status) === 404) answered = true; else failure = e; }
    const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    for (const base of f ? DIRECT_EXPLORERS : []) {
      try {
        const res = await f(`${base}/tx/${id}/status`);
        if (res.status === 404) { answered = true; break; }
        if (!res.ok) { failure = failure || new Error(`${base} answered ${res.status}`); continue; }
        const s = await res.json().catch(() => null);
        if (s && typeof s.confirmed === 'boolean') { if (s.confirmed) return mined(s); answered = true; break; }
        failure = failure || new Error(`${base} gave no status`);
      } catch (e) { failure = failure || e; }
    }
    if (answered) return { state: 'notmined' };
    throw Object.assign(new Error(`burndep-ux: could not read Bitcoin from this page just now (${String((failure && failure.message) || 'no answer').slice(0, 80)}); it tries again on its own`), { status: 503 });
  }

  async function chainTxState(txid) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!f || !txid) return 'unknown';
    try {
      const res = await f(`${workerBase}/chain/tx/${stripHex(txid)}?network=${network}`);
      if (res.status === 404) return 'absent';
      if (!res.ok) return 'unknown';
      const j = await res.json().catch(() => null);
      if (j && j.status) return 'present';
      return j && j.error === 'not-found' ? 'absent' : 'unknown';
    } catch { return 'unknown'; }
  }

  async function cancelSigned(walletPub, id) {
    if (!getRecord(walletPub, id)) return null;
    if (inFlight.has(id)) throw new Error('burndep-ux: this bridge is being advanced in this page right now');
    if (!tryAcquireLease(id)) throw new Error('burndep-ux: this bridge is being advanced in another tab right now');
    inFlight.add(id);
    try {
      const rec = getRecord(walletPub, id);
      if (!rec) return null;
      const burn = rec.stage === 'rburn-signed' || rec.stage === 'rburn-sent', signed = burn ? rec.burn : rec.stage === 'migrate-signed' || rec.stage === 'migrate-sent' ? rec.migrate : null;
      if (!signed) throw new Error('burndep-ux: only a bridge whose signed transaction Bitcoin never took can be cancelled');
      const [commit, reveal] = await Promise.all([chainTxState(signed.commitTxid), chainTxState(signed.txid || signed.revealTxid)]);
      if (reveal === 'present') return putRecord({ ...rec, stage: burn ? 'rburn-sent' : 'migrate-sent', sentAt: rec.sentAt || now(), lastError: null, errorCount: 0 });
      if (commit === 'present') {
        try { await chain.broadcastWithRetry(signed.hex || signed.revealHex); }
        catch (e) { throw new Error(`burndep-ux: the first of its two transactions is on Bitcoin, so it was not cancelled, and Bitcoin refused the second: ${String((e && e.message) || e)}`); }
        return putRecord({ ...rec, stage: burn ? 'rburn-sent' : 'migrate-sent', sentAt: rec.sentAt || now(), lastError: null, errorCount: 0 });
      }
      if (commit !== 'absent' || reveal !== 'absent') throw new Error('burndep-ux: Bitcoin could not be asked about its transactions just now, so it was not cancelled; try again in a minute');
      abandon(walletPub, id);
      return null;
    } finally { inFlight.delete(id); releaseLease(id); }
  }

  // `recipient` { pubHex, name? }: the address a burn paid, for a bridge that paid someone else. Its lock cannot be told from the
  // chain alone (the envelope holds only the lock's hash), so the holder names the address and the deadline is found among the few
  // days around the burn's block time (the deadline is a whole UTC day, see stealthDeadline).
  async function recoverReflectedBurn(burnTxidDisplay, walletPriv, { recipient = null } = {}) {
    if (!openNote && !openHeldNote) return null;
    const id = stripHex(burnTxidDisplay).toLowerCase();
    const burnTx = await fetchChainJson(`/tx/${id}`).catch((e) => {
      if (e && e.status === 404) throw new Error('burndep-ux: Bitcoin has no transaction with that id, or has not seen it yet');
      throw e;
    });
    if (!burnTx || !burnTx.vin || burnTx.vin.length < 2) return null;
    const env = classifyConfidentialTx('0x' + await fetchChainText(`/tx/${id}/hex`));
    const asset = env && env.type === 'burn' ? assetOf(env.assetId) : null;
    if (!asset) return null;
    const prev = classifyConfidentialTx('0x' + await fetchChainText(`/tx/${stripHex(burnTx.vin[0].txid)}/hex`));
    if (prev && prev.type === 'cxfer') return null;
    if (!burnTx.status || !burnTx.status.confirmed) throw new Error('burndep-ux: that burn has not confirmed yet; try again once it has');

    const note = burnTx.vin[1];
    const ZERO = '0x' + '00'.repeat(32);
    let opened = lc(stripHex(asset.assetId)) === lc(stripHex(tacAssetId)) && openNote ? await openNote(note.txid, note.vout) : null, burnedOwner = ZERO;
    if (!opened && openHeldNote) {
      const held = await openHeldNote(note.txid, note.vout, walletPriv);
      if (held && lc(stripHex(held.assetId)) === lc(stripHex(asset.assetId))) { opened = held; burnedOwner = held.owner; }
    }
    if (!opened) throw new Error('burndep-ux: the note that burn spent does not open with this key, so it was not rebuilt here');
    const walletPub = secp.getPublicKey(walletPriv, true);
    const { cx, cy } = pool.commitXY(BigInt(opened.amount), BigInt(opened.blinding));
    const srcLeaf = pool.btcNoteLeaf(asset.assetId, cx, cy, burnedOwner);
    const nu = pool.nullifier(srcLeaf);
    if (lc(env.nullifier) !== lc(nu)) throw new Error('burndep-ux: the burn does not match that note’s opening (a note not held at this wallet’s own address cannot be rebuilt this way)');
    const owner = pickDestOwner(walletPriv, asset.assetId).owner;
    const destBlinding = mintRecovery.deriveBridgeMintBlinding({ privkey: walletPriv, nullifier: env.nullifier });
    const { cx: dx, cy: dy } = pool.commitXY(BigInt(opened.amount), destBlinding);
    let stealth = null;
    if (lc(pool.leaf(asset.assetId, dx, dy, owner)) !== lc(env.dest)) {
      const recipientPub = recipient ? lc(withHex(String(recipient.pubHex))) : null;
      if (recipientPub) {
        const at = Number(burnTx.status.block_time) || Math.floor(now() / 1000);
        for (const deadline of bridgeMint.stealthDeadlineCandidates(at)) {
          const sd = bridgeMint.stealthDestFor({ asset: asset.assetId, lockerScanPriv: '0x' + bytesToHexLocal(walletPriv), nullifier: env.nullifier, recipientSpendPub: recipientPub, value: BigInt(opened.amount), deadline });
          if (lc(sd.lockLeaf) === lc(env.dest)) { stealth = sd; break; }
        }
      }
      if (!stealth) throw new Error(recipient ? 'burndep-ux: that burn does not name a stealth lock for that address' : 'burndep-ux: that burn names a destination that is not this wallet’s, so it is not this wallet’s bridge. If it paid someone else, give their address');
    }

    const rid = recordId(note.txid, note.vout);
    const existing = getRecord(walletPub, rid);
    if (existing) {
      if (existing.stage !== 'minted' && nullifierSpent && await nullifierSpent(env.nullifier).catch(() => false)) return putRecord({ ...existing, stage: 'minted', mintedAt: now(), lastError: null, errorCount: 0 });
      return existing;
    }
    const spentTxid = withHex(revHex(note.txid));
    const rec = {
      id: rid, network, walletPub: bytesToHexLocal(walletPub), path: 'reflected', stage: 'rburn-mined', createdAt: now(), recoveredAt: now(),
      source: { txid: stripHex(note.txid).toLowerCase(), vout: Number(note.vout), sats: note.prevout ? note.prevout.value : null, assetId: asset.assetId, ticker: asset.ticker, ...(burnedOwner !== ZERO ? { p2tr: true } : {}), amount: BigInt(opened.amount), blinding: BigInt(opened.blinding) },
      burn: { txid: id, hex: null },
      burnHeight: Number(burnTx.status.block_height),
      envelope: { destLeaf: env.dest, nullifier: env.nullifier, burnId: pool.bridgeBurnId(1, spentTxid, Number(note.vout), srcLeaf, env.target) },
      ...(stealth ? { stealth: stealthRecord(stealth, recipient) } : {}),
      mint: {
        sourceClass: 1, spentTxid, spentVout: Number(note.vout), chainBinding: env.target,
        burned: { value: BigInt(opened.amount), blinding: BigInt(opened.blinding), owner: burnedOwner },
        dest: stealth ? { value: BigInt(opened.amount), blinding: BigInt(stealth.lBlinding), owner: stealth.ownerPub } : { value: BigInt(opened.amount), blinding: destBlinding, owner },
      },
    };
    if (nullifierSpent && await nullifierSpent(env.nullifier).catch(() => false)) return putRecord({ ...rec, stage: 'minted', mintedAt: now() });
    return putRecord(rec);
  }

  // A burn's reveal carries no range proof, so the envelope script it spends is a couple of hundred bytes; a transfer's is nearly a
  // thousand. A transaction whose script is plainly a transfer's is not read: the explorer's answer for the address already says so.
  const TRANSFER_SCRIPT_HEX = 1200;
  const looksLikeTransfer = (tx) => { const w = tx.vin[0] && tx.vin[0].witness; return Array.isArray(w) && w.length >= 3 && String(w[1]).length > TRANSFER_SCRIPT_HEX; };
  // A move to a burn address (the first step of a bridge the reflection does not track) is a transfer whose vout 0 is the burn
  // address this key derives for the note its vin 1 spends: told apart from the explorer's answer alone, with no read.
  function moveSourceOf(tx, P, walletPriv) {
    const home = tx.vout && tx.vout[0], src = tx.vin[1];
    if (tx.vin.length !== 2 || !home || home.scriptpubkey_type !== 'v1_p2tr' || Number(home.value) !== 546 || !src || !/^[0-9a-f]{64}$/i.test(String(src.txid || ''))) return null;
    const source = { txid: lc(src.txid), vout: Number(src.vout) };
    return reveal.isBurnHomeOf({ prims: P, walletPriv, source, spk: home.scriptpubkey }) ? source : null;
  }
  // Rebuilds a bridge from its move alone: the amount opens with the key (the move encrypts it to itself), and must open the burn
  // address's commitment. A burn address still unspent goes on to its burn; one already burned goes on from that burn; one moved
  // back has nothing left to bridge.
  async function recoverMove(tx, source, P, walletPriv) {
    const id = lc(stripHex(tx.txid));
    const envHex = extractTaprootEnvelope('0x' + await fetchChainText(`/tx/${id}/hex`));
    const env = envHex ? parseCxferEnvelopeFull(envHex) : null;
    if (!env || lc(stripHex(env.asset)) !== lc(stripHex(tacAssetId)) || env.commitments.length !== 1) return null;
    const anchor = hexToBytesLocal(revHex(source.txid) + bytesToHexLocal(Uint8Array.of(source.vout & 0xff, (source.vout >>> 8) & 0xff, (source.vout >>> 16) & 0xff, source.vout >>> 24)));
    const ks = deriveAmountKeystreamSelf(walletPriv, anchor, 0), ct = hexToBytesLocal(env.encryptedAmounts[0]);
    let amount = 0n;
    for (let i = 7; i >= 0; i--) amount = (amount << 8n) | BigInt(ct[i] ^ ks[i]);
    if (amount <= 0n) return null;
    const burnHome = reveal.reconstructBurnHome({ prims: P, walletPriv, source, amount, burnHomeTxid: id, chainSpk: tx.vout[0].scriptpubkey });
    const pt = secp.ProjectivePoint.fromHex(stripHex(env.commitments[0])).toAffine();
    if (BigInt(burnHome.cx) !== pt.x || BigInt(burnHome.cy) !== pt.y) return null;

    const next = await fetchChainJson(`/tx/${id}/outspend/0`);
    if (next && next.spent) {
      if (!next.status || !next.status.confirmed) throw Object.assign(new Error('burndep-ux: what spent this move is not confirmed yet'), { status: 503 });
      return recoverFromTxid(next.txid, walletPriv, { amount }).catch((e) => {
        if (/does not classify as a burn-deposit/.test(String((e && e.message) || e))) return null;
        throw e;
      });
    }
    const walletPub = secp.getPublicKey(walletPriv, true);
    const rec = {
      id: recordId(source.txid, source.vout), network, walletPub: bytesToHexLocal(walletPub), stage: 'migrate-confirmed', createdAt: now(), recoveredAt: now(),
      migrateConfirmedAt: now(), migrateHeight: Number(tx.status.block_height),
      source: { txid: source.txid, vout: source.vout, sats: Number(tx.vin[1].prevout && tx.vin[1].prevout.value) || null, assetId: tacAssetId, amount, blinding: 0n },
      migrate: { commitTxid: lc(tx.vin[0].txid), revealTxid: id },
      burnHome: {
        txid: id, vout: 0, value: burnHome.value, cx: burnHome.cx, cy: burnHome.cy, blinding: burnHome.blinding,
        xonly: bytesToHexLocal(burnHome.xonly), spk: bytesToHexLocal(burnHome.spk), controlBlock: bytesToHexLocal(burnHome.controlBlock), scriptS: bytesToHexLocal(burnHome.scriptS),
      },
    };
    return getRecord(walletPub, rec.id) ? null : putRecord(rec);
  }

  // `left` is how many candidates this call did not get to (past `limit`, or a read that could not be answered just now).
  async function discover({ walletPriv, txs = [], skip = [], limit = 20 } = {}) {
    if (!walletPriv) throw new Error('burndep-ux: discover needs the wallet key');
    const walletPub = secp.getPublicKey(walletPriv, true), P = freshPrims(walletPriv);
    const have = new Set(loadAll(walletPub).map((r) => r && r.burn && r.burn.txid).filter(Boolean).map(lc));
    const skipped = new Set(skip.map(lc)), found = [], tried = [];
    let left = 0;
    for (const tx of txs) {
      const id = tx && tx.txid ? lc(stripHex(tx.txid)) : null;
      if (!id || have.has(id) || skipped.has(id)) continue;
      if (!tx.status || !tx.status.confirmed || !Array.isArray(tx.vin) || tx.vin.length < 2) continue;
      const first = tx.vin[0] && tx.vin[0].prevout;
      if (first && first.scriptpubkey_type && first.scriptpubkey_type !== 'v1_p2tr') continue;
      const moved = looksLikeTransfer(tx) ? moveSourceOf(tx, P, walletPriv) : null;
      if (looksLikeTransfer(tx) && (!moved || getRecord(walletPub, recordId(moved.txid, moved.vout)))) continue;
      if (tried.length >= limit) { left++; continue; }
      try {
        const rec = moved ? await recoverMove(tx, moved, P, walletPriv) : await recoverReflectedBurn(id, walletPriv);
        if (rec) found.push(rec);
        tried.push(id);
      } catch (e) { if (!passing(e)) tried.push(id); else left++; }
    }
    return { found, tried, left };
  }

  // A move's own transaction id finds its bridge too: the move alone says what it holds, and this key alone opens it (`discover` does the
  // same over an address's history). null when the transaction is no move of this key's.
  async function recoverMoveFromTxid(txidDisplay, walletPriv) {
    const tx = await fetchChainJson(`/tx/${stripHex(txidDisplay).toLowerCase()}`).catch(() => null);
    if (!tx || !Array.isArray(tx.vin) || !looksLikeTransfer(tx)) return null;
    const P = freshPrims(walletPriv), source = moveSourceOf(tx, P, walletPriv);
    if (!source) return null;
    if (!tx.status || !tx.status.confirmed) throw new Error('burndep-ux: that move has not confirmed on Bitcoin yet; try again once it has');
    const kept = getRecord(secp.getPublicKey(walletPriv, true), recordId(source.txid, source.vout));
    const rec = kept || await recoverMove(tx, source, P, walletPriv);
    if (!rec) throw new Error('burndep-ux: nothing is left to finish for that move: its burn address was spent by something other than a burn, or its amount does not open with this key');
    return rec;
  }

  async function recoverFromTxid(burnTxidDisplay, walletPriv, { amount, recipient = null } = {}) {
    const reflectedBridge = await recoverReflectedBurn(burnTxidDisplay, walletPriv, { recipient });
    if (reflectedBridge) return reflectedBridge;
    const moved = await recoverMoveFromTxid(burnTxidDisplay, walletPriv);
    if (moved) return moved;
    if (amount == null) throw new Error('burndep-ux: recoverFromTxid needs { amount } — the confidential value the original note carried (not recoverable from chain data alone)');
    const walletPub = secp.getPublicKey(walletPriv, true);
    const status = await checkTxidStatus(burnTxidDisplay);
    if (status.status === 'not-found') throw new Error('burndep-ux: Bitcoin has no transaction with that id, or has not seen it yet');
    if (status.status === 'unconfirmed') throw new Error('burndep-ux: that burn has not confirmed on Bitcoin yet; try again once it has');
    if (!status.note || !status.assetId) throw new Error('burndep-ux: this txid does not classify as a burn-deposit');
    if (lc(stripHex(status.assetId)) !== lc(stripHex(tacAssetId))) throw new Error('burndep-ux: this burn is for a different asset');
    const burnHomeTxid = stripHex(status.note.txid);

    const traced = await traceNote({ txid: burnHomeTxid, vout: 0, assetId: tacAssetId });
    const firstInput = traced.bundle && traced.bundle.cxfers && traced.bundle.cxfers[0] && traced.bundle.cxfers[0].inputs && traced.bundle.cxfers[0].inputs[0];
    if (!firstInput) throw new Error('burndep-ux: could not recover the source note behind this burn-home');
    const source = { txid: stripHex(firstInput.prevTxid), vout: firstInput.prevVout };

    const burnHomeOnChain = await fetchChainJson(`/tx/${burnHomeTxid}`);
    const chainSpk = burnHomeOnChain.vout[0].scriptpubkey;
    const P = freshPrims(walletPriv);
    const burnHome = reveal.reconstructBurnHome({ prims: P, walletPriv, source, amount, burnHomeTxid, chainSpk });
    const homeEnv = classifyConfidentialTx('0x' + await fetchChainText(`/tx/${burnHomeTxid}/hex`));
    const homeAt = homeEnv && homeEnv.type === 'cxfer' ? (homeEnv.vouts || []).indexOf(0) : -1;
    if (homeAt < 0 || !homeEnv.commitments || !homeEnv.commitments[homeAt]) throw new Error('burndep-ux: could not read the burn-home’s commitment, so that amount cannot be checked; try again in a moment');
    const homePt = secp.ProjectivePoint.fromHex(stripHex(homeEnv.commitments[homeAt])).toAffine();
    if (BigInt(burnHome.cx) !== homePt.x || BigInt(burnHome.cy) !== homePt.y) throw new Error('burndep-ux: that amount does not match this bridge; check it and try again');
    const bundle = { ...traced.bundle, burned: { cx: burnHome.cx, cy: burnHome.cy } };

    const stageByStatus = { unconfirmed: 'burn-submitted', 'awaiting-scan': status.registered ? 'registered' : 'burn-mined', pending: status.registered ? 'registered' : 'burn-mined', folded: 'folded', 'not-recorded': 'not-recorded' };
    const stage = stageByStatus[status.status];
    if (!stage) throw new Error(`burndep-ux: cannot recover from status '${status.status}'`);

    const rec = {
      id: recordId(source.txid, source.vout), network, walletPub: bytesToHexLocal(walletPub), stage, createdAt: now(), recoveredAt: now(),
      source: { txid: source.txid, vout: source.vout, sats: burnHome.value, assetId: tacAssetId, amount: BigInt(amount), blinding: 0n },
      burnHome: {
        txid: burnHomeTxid, vout: 0, value: burnHome.value, cx: burnHome.cx, cy: burnHome.cy, blinding: burnHome.blinding,
        xonly: bytesToHexLocal(burnHome.xonly), spk: bytesToHexLocal(burnHome.spk), controlBlock: bytesToHexLocal(burnHome.controlBlock), scriptS: bytesToHexLocal(burnHome.scriptS),
      },
      bundle, hops: traced.hops,
      burn: { txid: stripHex(burnTxidDisplay), hex: null, fundingUtxo: null },
      dest: deriveDest(walletPriv, burnHome, burnHomeTxid, BigInt(amount)),
    };
    const had = getRecord(walletPub, rec.id);
    if (had && (had.stage === 'minted' || had.stage === 'reclaimed' || had.stage === 'recovered')) return had;
    return putRecord(rec);
  }

  const CANCEL_TOO_EARLY_STAGES = new Set(['migrate-signed', 'migrate-sent']);
  const CANCELABLE_STAGES = new Set(['migrate-confirmed', 'traced', 'burn-signed', 'burn-submitted', 'stopped']);
  async function buildCancel({ rec, walletPriv, feeRate = null } = {}) {
    if (!walletPriv) throw new Error('burndep-ux: buildCancel needs the wallet key');
    if (!rec || !rec.stage) throw new Error('burndep-ux: rec required');
    if (!CANCELABLE_STAGES.has(rec.stage)) {
      if (CANCEL_TOO_EARLY_STAGES.has(rec.stage)) {
        throw new Error(`burndep-ux: cannot cancel yet — no confirmed burn-home exists at stage '${rec.stage}'`);
      }
      throw new Error(`burndep-ux: cannot cancel at stage '${rec.stage}' — the burn-home is already spent, or the bridge is already terminal`);
    }
    const P = freshPrims(walletPriv);
    const walletPub = secp.getPublicKey(walletPriv, true);
    const burnHomeOnChain = await fetchChainJson(`/tx/${stripHex(rec.burnHome.txid)}`);
    const chainSpk = burnHomeOnChain.vout[0].scriptpubkey;
    const burnHome = reveal.reconstructBurnHome({
      prims: P, walletPriv, source: { txid: rec.source.txid, vout: rec.source.vout },
      amount: rec.source.amount, burnHomeTxid: rec.burnHome.txid, chainSpk,
    });
    const rate = Number(feeRate != null ? feeRate : await chain.getFeeRate('priority'));
    const fundingUtxo = await pickFundingUtxo(P.wallet.address(), Math.ceil(600 * rate * 1.3) + 846, rec);
    const built = await reveal.buildCancelTx({ prims: P, burnHome, assetId: tacAssetId, walletPriv, walletPub, fundingUtxo, feeRate: rate });
    return { ...built, fundingUtxo: { txid: fundingUtxo.txid, vout: fundingUtxo.vout, value: fundingUtxo.value } };
  }

  async function reclaim({ rec: given, walletPriv, feeRate = null } = {}) {
    if (!given || !given.id || !given.walletPub) throw new Error('burndep-ux: rec required');
    if (inFlight.has(given.id)) throw new Error('burndep-ux: this bridge is being advanced in this page right now');
    if (!tryAcquireLease(given.id)) throw new Error('burndep-ux: this bridge is being advanced in another tab right now');
    inFlight.add(given.id);
    try {
      const rec = getRecord(given.walletPub, given.id);
      if (!rec || rec.stage !== given.stage) throw new Error('burndep-ux: this bridge moved on while the move back was being made; look at its row, then try again');
      if (rec.burn && rec.burn.txid) {
        const burnState = await chainTxState(rec.burn.txid);
        if (burnState === 'present') return putRecord({ ...rec, stage: 'burn-submitted', submittedAt: rec.submittedAt || now(), lastError: null, errorCount: 0 });
        // a burn that cannot be looked up may still be mined: moving back races it, and the commit would be left holding the funding coin
        if (burnState !== 'absent') throw new Error('burndep-ux: Bitcoin could not be asked about the burn just now, so nothing was moved back; try again in a minute');
      }
      const built = await buildCancel({ rec, walletPriv, feeRate });
      const sent = putRecord({ ...rec, stage: 'reclaim-sent', reclaimFrom: rec.stage, reclaim: { commitTxid: built.commitTxid, txid: built.revealTxid, commitHex: built.commitHex, revealHex: built.revealHex, fundingUtxo: built.fundingUtxo }, reclaimSentAt: now(), lastError: null, errorCount: 0 });
      try { await chain.broadcastWithRetry(built.commitHex); }
      catch (e) {
        if ((await chainTxState(built.commitTxid)) === 'absent') { putRecord(rec); throw e; }
      }
      await chain.broadcastWithRetry(built.revealHex).catch(() => {});
      return sent;
    } finally { inFlight.delete(given.id); releaseLease(given.id); }
  }
  async function recover({ rec, walletPriv } = {}) {
    if (!rec || (rec.stage !== 'not-recorded' && rec.stage !== 'recovering')) throw new Error('burndep-ux: only a bridge that did not complete can be recovered');
    if (!walletPriv) throw new Error('burndep-ux: recovering needs the wallet key');
    if (bytesToHexLocal(secp.getPublicKey(walletPriv, true)) !== lc(rec.walletPub)) throw new Error('burndep-ux: this bridge belongs to a different wallet');
    const blinding = rec.burnHome ? rec.burnHome.blinding : rec.source.blinding;
    const claim = buildRecoverClaim({ secp, sha256, signSchnorr }, { burnTxid: rec.burn.txid, amount: rec.source.amount, blinding, walletPriv });
    const r = await callWorker('POST', '/bridge/recover', claim);
    if (!r || !r.ok) throw new Error((r && r.error) || 'the recovery could not be started; try again in a moment');
    return putRecord({ ...rec, stage: r.status === 'sent' ? 'recovered' : 'recovering', recover: { status: r.status, txid: r.txid || null, at: now() } });
  }

  async function verify(walletPub, id) {
    const rec = getRecord(walletPub, id);
    if (!rec) return null;
    if ((rec.stage === 'traced' && !rec.homeChecked) || rec.stage === 'migrate-confirmed') {
      const live = await isLive(rec.burnHome.txid, 0, { fresh: true });
      if (live === true) return putRecord({ ...rec, stage: 'stopped', stoppedAt: now(), stoppedWhy: 'tracked' });
      if (live === false && rec.stage === 'traced') return putRecord({ ...rec, homeChecked: true });
    }
    if (rec.stage === 'folded' || rec.stage === 'rfolded') { const done = await mintLanded(rec); if (done) return done; }
    if (rec.stage === 'folded' && (await burnRecorded(rec)) === false) return putRecord({ ...rec, stage: 'not-recorded', notRecordedAt: now() });
    if (rec.stage === 'recovering') return STAGE_ADVANCE.recovering(rec);
    return rec;
  }

  async function resumeAll(walletPub, { walletPriv = null } = {}) {
    const out = [];
    for (const rec of loadAll(walletPub)) {
      if (rec.stage === 'minted') continue;
      try { out.push({ id: rec.id, record: await advance(walletPub, rec.id, { walletPriv }) }); }
      catch (e) { out.push({ id: rec.id, error: String(e.message || e) }); }
    }
    return out;
  }

  return {
    BURNDEP_BETA_CAP_RAW, assets: ASSETS, assetOf, eligibleNotes, isReserved, pickFunding, bridgeCost, noteForms, noteTracking, lineage, preflight, preflightHeld, recheckBurn, RETURN_FEE_CEILING, start, startReflected, advance, resumeAll, recoverFromTxid, discover, list, abandon,
    cancelSigned, buildCancel, reclaim, recover, verify, isLive, burnRecorded, destLeaf, relayFault, mintRetryDue, armMint,
    quoteRate: () => chain.getFeeRate('priority'),
    slipstreamStatus: broadcaster.slipstreamStatus,
    checkTxidStatus,
  };
}
