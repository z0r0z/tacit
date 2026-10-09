// Orchestrates a TAC burn-deposit bridge (Bitcoin -> Ethereum) end to end: move a note to its burn-home,
// burn it via MARA Slipstream, register + wait for the reflection to fold it, then mint the Ethereum-side
// note. Wires together three already-independent, already-tested pieces —
// dapp/burn-deposit-reveal.js (builds + signs the two Bitcoin transactions), dapp/burndep-broadcast.js (MARA
// submit/poll + worker registration), and the confidential pool's own bridgeMint (dapp/confidential-bridge-mint.js,
// via the injected `bridgeMint`) — into one resumable state machine, journalled so a reload picks up exactly
// where it left off.
//
// This module never imports dapp/tacit.js and takes every wallet-stateful primitive by injection, building a
// fresh makeBtcWallet-shaped `prims` per signing call rather than sharing one across calls — the same pattern
// dapp/cbtc-lock-mint.js uses, and the only way to keep burn-deposit-reveal.js's one-wallet-source rule from
// being violated by a caller that also happens to hold tacit.js's own, separately-stateful wallet singleton.
//
// State machine (one record per source note outpoint, journalled to storage before each broadcast so a
// resume never re-signs or double-spends):
//   migrate-signed -> migrate-sent -> migrate-confirmed -> traced -> burn-signed -> burn-submitted
//     -> burn-mined -> registered -> folded -> minted
// Only 'migrate-signed' (via start()), 'traced'->'burn-signed', and 'folded'->'minted' need the wallet key;
// every other transition is a poll or a pure rebuild from already-journalled public data, so a reload can
// carry a record forward on its own right up to the next point that needs the user present.
//
// TAC the reflection already tracks (what an ordinary transfer leaves in a wallet) takes the reflected path instead:
// one standard commit/reveal burns the note itself (dapp/bridge-burn-broadcast.js, source class 1), and the mint
// follows once the attested state records it:
//   rburn-signed -> rburn-sent -> rburn-mined -> rfolded -> minted
// Only startReflected() and 'rfolded'->'minted' need the wallet key.
import { makeBurnDepositReveal } from './burn-deposit-reveal.js';
import { makeBurnDepositBroadcaster } from './burndep-broadcast.js';
import { makeBurnDepositKit, classifyConfidentialTx } from './burn-deposit-bitcoin.js';
import { makeBtcWallet } from './bitcoin-taproot-wallet.js';
import { makeBridgeMintRecovery } from './bridge-mint-recovery.js';
import { buildRecoverClaim } from './bridge-recover.js';
import { makeBridgeBurnBroadcaster } from './bridge-burn-broadcast.js';

export const BURNDEP_BETA_CAP_RAW = 100_000_000_000n; // 1,000 TAC at 8 decimals
// A return of a note a cross-out made waits when Bitcoin's fee is above this (sat/vB), as the cross-out's own mint does.
export const RETURN_FEE_CEILING = 100;
// The registration door (worker/src/index.js) caps a bundle's cxfers at 64 hops. The migrate itself adds one
// of those hops, so the SOURCE note's own pre-migrate depth is checked against 63 (preflight, before anything
// is signed), and the BURN-HOME's post-migrate depth — source hops + 1 — is checked separately against the
// full 64 (once the migrate has confirmed). Kept as two named constants rather than one reused value, since
// the two checks apply to different points in the hop count and must not collapse into the same number.
const MAX_HOPS_SOURCE = 63;
const MAX_HOPS_BURN_HOME = 64;
const JOURNAL_PREFIX = 'tacit-burndep-bridge-v1';
const LEASE_TTL_MS = 30_000;
const DEST_INDEXES = 8; // matches confidential-recovery.js's walkBridgeMints default
// How long a mint waits on the relay's queue before the call returns; the job goes on there either way.
const MINT_WAIT_MS = 15 * 60 * 1000;

const stripHex = (h) => String(h).replace(/^0x/, '');
const withHex = (h) => (String(h).startsWith('0x') ? String(h) : '0x' + String(h));
const lc = (h) => String(h).toLowerCase();
const revHex = (h) => stripHex(h).match(/../g).reverse().join('');
const recordId = (txid, vout) => `${stripHex(txid).toLowerCase()}:${Number(vout)}`;
const now = () => Date.now();
function hexToBytesLocal(h) { const s = String(h).replace(/^0x/, ''); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; }
function bytesToHexLocal(b) { return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }

// Real localStorage exposes .length/.key(i) alongside getItem/setItem/removeItem; a plain wrapper around it
// must forward those too, or isReserved's cross-wallet scan (allRecordsAnyWallet) silently sees nothing.
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

// bigint <-> JSON-safe string, at the specific property NAMES a record ever carries a BigInt under (checked
// by name, not path, so nesting doesn't matter — every such field in this module happens to use one of these
// three names).
const BIG_FIELDS = ['amount', 'blinding', 'value'];
function serializeRecord(rec) {
  return JSON.stringify(rec, (k, v) => (typeof v === 'bigint' ? (BIG_FIELDS.includes(k) ? { __big: v.toString() } : v.toString()) : v));
}
function deserializeRecord(text) {
  return JSON.parse(text, (k, v) => (v && typeof v === 'object' && typeof v.__big === 'string' ? BigInt(v.__big) : v));
}

// deps: { network, hrp, workerBase, fetchImpl, storage, secp, sha256, keccak256, hmac, pool, bridgeMint,
//         chainBindingHex, tacAssetId, chain: {getUtxos, pickSafeCommitSats, broadcastWithRetry, getFeeRate},
//         encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf,
//         encryptAmount, signSchnorr, modN }
// The last group (encodeCXferBppPayload..modN) are the pure cxfer/BPP helpers burn-deposit-reveal.js's
// MIGRATE_NEED lists — safe to source from dapp/tacit.js directly (they take explicit arguments, no implicit
// wallet dependency), unlike anything that reads a wallet singleton's own .priv/.pub. chain.pickSafeCommitSats
// is expected to be tacit.js's own (it reads the dapp's live holdings scan internally) — this module only
// ever calls it as an opaque `(utxos) => sorted safe-to-spend utxos` function.
export function makeBurnDepositUx(deps) {
  const {
    network = 'mainnet', hrp = 'bc', workerBase, fetchImpl, storage: storageIn = null,
    secp, sha256, keccak256, hmac, pool, bridgeMint, chainBindingHex, tacAssetId,
    chain, encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf,
    encryptAmount, signSchnorr, modN,
    // Optional. openNote(txid, vout) → { amount, blinding } | null: the opening of a note this key received or changed, from
    // the transaction that made it (dapp/note-opening.js). nullifierSpent(ν) → boolean: whether the pool has spent ν.
    // Together they let a one-step bridge be rebuilt from its burn transaction and the key alone.
    openNote = null, nullifierSpent = null,
    // Optional. openHeldNote(txid, vout, walletPriv) → { assetId, amount, blinding, owner } | null: the opening of a note a cross-out
    // made at this key's own Taproot output (dapp/crossout-notes.js), so a bridge of such a note is rebuilt from its burn too.
    openHeldNote = null,
    // Optional. The assets a tracked note can be sent back to Ethereum as ([{ assetId, ticker, capRaw }]); left out, TAC alone
    // under BURNDEP_BETA_CAP_RAW. The burn-deposit path below is TAC's own and does not read this.
    assets: assetsIn = null,
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

  // A fresh wallet-shaped prims object per signing call, never shared/reused across calls — the whole point
  // of building it here rather than taking one from the caller (see this module's own header comment).
  function freshPrims(walletPriv) {
    const w = makeBtcWallet({
      priv: walletPriv, hrp,
      fetchUtxos: async () => [], // never used: every fundingUtxo this module signs with is already resolved
      // buildMigrationTxs/buildBurnDepositRevealTxs never actually invoke broadcastTx (both build+sign only,
      // "nothing broadcast" per their own doc comments) — wired to broadcastWithRetry anyway so this prims
      // object satisfies makeBtcWallet's own shape rather than depending on that being true forever.
      broadcastTx: async (hex) => chain.broadcastWithRetry(hex),
      fetchFeeRate: async () => chain.getFeeRate('priority'),
    });
    return { ...w.prims, ...pureCxferPrims };
  }
  // p2wpkhScript is a pure function of an explicit pubkey (dapp/bitcoin-taproot-wallet.js) — this throwaway
  // instance's own key is never used for anything, it only exists to reach that one prim.
  const scratchPrims = freshPrims(new Uint8Array(32).fill(1));
  function p2wpkhScriptOf(pubkeyHexOrBytes) {
    const pub = typeof pubkeyHexOrBytes === 'string' ? hexToBytesLocal(stripHex(pubkeyHexOrBytes)) : pubkeyHexOrBytes;
    return scratchPrims.p2wpkhScript(pub);
  }

  // ---- journal: one record per source outpoint, keyed per (network, walletPub) so a resume never silently
  // adopts another key's in-flight bridge ----
  function journalKey(walletPub) { return `${JOURNAL_PREFIX}:${network}:${lc(typeof walletPub === 'string' ? walletPub : bytesToHexLocal(walletPub))}`; }
  function loadAll(walletPub) {
    try { const raw = storage.getItem(journalKey(walletPub)); const arr = raw ? deserializeRecord(raw) : []; return Array.isArray(arr) ? arr : []; }
    catch { return []; }
  }
  function saveAll(walletPub, list) { storage.setItem(journalKey(walletPub), serializeRecord(list)); }
  function putRecord(rec) {
    const list = loadAll(rec.walletPub).filter((r) => r.id !== rec.id);
    const saved = { ...rec, updatedAt: now() };
    list.push(saved);
    saveAll(rec.walletPub, list);
    return saved;
  }
  function getRecord(walletPub, id) { return loadAll(walletPub).find((r) => r.id === id) || null; }

  // A cross-tab lease, not a hard lock: a stale (LEASE_TTL_MS-old) lease is treated as free, so a crashed tab
  // never permanently strands a record. Good enough to stop two tabs racing the SAME advance() concurrently;
  // not a substitute for the journal-before-broadcast ordering, which is what actually prevents a double-spend.
  function leaseKey(id) { return `${JOURNAL_PREFIX}:lease:${network}:${id}`; }
  const sessionId = `${now()}-${Math.random().toString(36).slice(2)}`;
  function tryAcquireLease(id) {
    const key = leaseKey(id);
    try {
      const raw = storage.getItem(key);
      if (raw) { const held = JSON.parse(raw); if (held.owner !== sessionId && now() - held.at < LEASE_TTL_MS) return false; }
    } catch { /* a corrupt lease is treated as free */ }
    storage.setItem(key, JSON.stringify({ owner: sessionId, at: now() }));
    return true;
  }
  function releaseLease(id) { try { storage.removeItem(leaseKey(id)); } catch {} }

  // ---- the reflection's own view of a note and of a burn ----
  // The burn-deposit carries TAC the reflection has not yet seen; a note the reflection already tracks bridges through
  // the reflected-note path, which binds the burn to that note's own nullifier. So a tracked note is routed there, a
  // burn-deposit whose burn-home turns out tracked pauses before its burn (the holder keeps the TAC and can move it
  // back), and a burn is offered for minting once the attested state records it. Read from the public attested state,
  // cached briefly; the live set is keyed by outpoint, as the scan keys it.
  const PRIVATE_NOTE = 'received privately: send it to yourself first, then bridge the new note';
  let reflCache = null, reflInflight = null;
  // Reads that overlap (a page's several bridges, a check beside a tick) share the one fetch of the multi-megabyte state.
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
      // Whether each live note is bound to a deployment, and every leaf in the note tree: the burn names its note by a leaf
      // of one form, which the tree must hold.
      liveBound: new Map(snap.liveTriples.map((t) => [lc(t[0]), Number(t[4]) === 1])),
      leaves: Array.isArray(snap.noteLeaves) ? new Set(snap.noteLeaves.map(lc)) : null,
      dests: new Set(snap.burnNodes.map((n) => lc(n[2] || ''))),
      pending: new Set((snap.pendingDepositRecords || []).map((r) => lc(r.key))),
    };
    return reflCache;
  }
  const outpointOf = (txid, vout) => lc(pool.outpointKey(withHex(revHex(txid)), Number(vout)));
  // Whether an unspent note is tracked: true or false once the attested state has reached the block that created it,
  // null before then (a note's status is not settled until the reflection has passed its block).
  async function isLive(txid, vout, { fresh = false } = {}) {
    const r = await reflected(fresh);
    const t = await fetchChainJson(`/tx/${stripHex(txid)}`);
    const h = Number(t && t.status && t.status.block_height);
    if (!t || !t.status || !t.status.confirmed || !Number.isInteger(h) || !Number.isInteger(r.height) || h > r.height) return null;
    return r.live.has(outpointOf(txid, vout));
  }
  // true: the attested state records this burn (its destination as a burn, or its pending record). false: the
  // reflection has passed the burn's block without recording it, so it is not mintable. null: not reached yet.
  async function burnRecorded(rec) {
    const r = await reflected(true);
    let destLeaf = rec.envelope && rec.envelope.destLeaf;
    if (!destLeaf && rec.dest) {
      const { cx, cy } = pool.commitXY(BigInt(rec.dest.value), BigInt(rec.dest.blinding));
      destLeaf = pool.leaf(withHex(tacAssetId), cx, cy, rec.dest.owner);
    }
    if (destLeaf && r.dests.has(lc(destLeaf))) return true;
    if (r.pending.has(outpointOf(rec.burnHome.txid, 0))) return true;
    const st = await checkTxidStatus(rec.burn.txid);
    const h = Number(st && st.burnBlockHeight);
    if (!Number.isInteger(h) || !Number.isInteger(r.height) || h > r.height) return null;
    return false;
  }

  // ---- eligibility (pure — no network) ----
  // `holding` shape: { txid, vout, sats, assetId, amount (bigint|string), blinding (bigint|string),
  //                    confirmed (bool), stealth (bool, true for a note received via a stealth claim),
  //                    stealthTweakedSk (hex string|null — the note's own spend key when stealth is true;
  //                    see dapp/tacit.js's per-input signing-key pattern. scanHoldings always populates this
  //                    alongside stealth:true, so the fallback reason below is defensive, not expected). }.
  function eligibleNotes(holdings) {
    return (holdings || []).map((h) => {
      const amount = BigInt(h.amount);
      let reason = null;
      // stripHex both sides: the caller's h.assetId and this module's own tacAssetId aren't guaranteed to
      // agree on a leading 0x (tacit.js's real wiring passes tacAssetId 0x-prefixed but a holding's own
      // assetIdHex bare — see dapp/tacit.js's _burndepUxSingleton and its bridge-eth click handler), and a
      // bare lc() comparison would call every real TAC note "not TAC".
      if (lc(stripHex(h.assetId)) !== lc(stripHex(tacAssetId))) reason = 'not TAC';
      else if (amount > BURNDEP_BETA_CAP_RAW) reason = 'over the 1,000 TAC beta limit — send part of it to yourself first to split off a smaller note';
      else if (h.confirmed === false) reason = 'unconfirmed';
      else if (h.stealth && !h.stealthTweakedSk) reason = 'received privately (stealth) — rescan holdings to recover its spend key, then retry';
      else if (isReserved(h.txid, h.vout)) reason = 'already bridging';
      return { ...h, eligible: !reason, reason };
    });
  }

  function isReserved(txid, vout) {
    const op = recordId(txid, vout);
    for (const rec of allRecordsAnyWallet()) {
      if (rec.stage === 'minted') continue;
      if (rec.id === op) return true;
      if (rec.migrate && recordId(rec.migrate.fundingUtxo.txid, rec.migrate.fundingUtxo.vout) === op) return true;
      if (rec.burn && rec.burn.fundingUtxo && recordId(rec.burn.fundingUtxo.txid, rec.burn.fundingUtxo.vout) === op) return true;
      if (rec.burn && Array.isArray(rec.burn.fundingUtxos) && rec.burn.fundingUtxos.some((u) => recordId(u.txid, u.vout) === op)) return true;
    }
    return false;
  }
  // Reservations must hold across every wallet this browser has ever bridged from, not just the "current"
  // one — a second imported key sharing a UTXO with the first is the same physical coin either way. Storage
  // keys are prefixed predictably (journalKey), so this scans them directly via the enumeration defaultStorage
  // forwards from real localStorage.
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

  // ---- preflight: everything checkable before signing anything ----
  // note: one entry from eligibleNotes (already confirmed .eligible). walletPub: compressed pubkey bytes/hex,
  // for the ownership check only — never the private key.
  async function preflight({ note, walletPub }) {
    const out = { steps: [], ok: false };
    const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); return ok; };
    if (!step('cap', BigInt(note.amount) <= BURNDEP_BETA_CAP_RAW, `${note.amount} raw units`)) return out;

    let srcTx;
    try { srcTx = await fetchChainJson(`/tx/${stripHex(note.txid)}`); }
    catch (e) { step('source-lookup', false, String(e.message || e)); return out; }
    const vout = srcTx && srcTx.vout && srcTx.vout[note.vout];
    if (!step('source-confirmed', !!(srcTx.status && srcTx.status.confirmed), 'source output confirmed on Bitcoin')) return out;
    // A stealth-received note sits at P2WPKH(commit), commit = walletPub + b·G, not at P2WPKH(walletPub) —
    // its own tweaked key (carried on the note by scanHoldings, see eligibleNotes' shape comment) is the
    // ownership proof instead.
    const ownerPub = note.stealthTweakedSk ? secp.getPublicKey(hexToBytesLocal(stripHex(note.stealthTweakedSk)), true) : walletPub;
    const ownWpkh = lc(bytesToHexLocal(p2wpkhScriptOf(ownerPub)));
    if (!step('source-ownership', !!vout && lc(vout.scriptpubkey) === ownWpkh, "source output pays this wallet's own address")) return out;
    let live;
    try { live = await isLive(note.txid, note.vout, { fresh: true }); }
    catch (e) { step('reflection', false, String(e.message || e)); return out; }
    if (live === null) { step('not-tracked', false, 'the reflection has not reached the block this note was made in yet; try again in a little while'); return out; }
    if (live) {
      // Tracked: burned directly, in one standard transaction, with no provenance trace and no MARA submission.
      if (!step('reflected', !note.stealthTweakedSk, note.stealthTweakedSk ? PRIVATE_NOTE : 'tracked by the reflection: bridges in one Bitcoin transaction')) return out;
      // The burn names the note by its leaf in the form the mint binds to. A note made before that form is in the tree under
      // an older leaf, which the burn cannot use; sending it once to its own address makes it a note of the current form.
      const refl = await reflected();
      if (refl.leaves) {
        const { cx, cy } = pool.commitXY(BigInt(note.amount), BigInt(note.blinding));
        const bound = refl.liveBound.get(outpointOf(note.txid, note.vout));
        const leaf = bridgeMint.sourceLeaf({ sourceClass: bound ? 2 : 1, asset: withHex(tacAssetId), cx, cy, owner: '0x' + '00'.repeat(32), chainBinding: withHex(chainBindingHex()) });
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
    try { traced = await traceNote({ txid: note.txid, vout: note.vout, assetId: tacAssetId }); }
    catch (e) { step('trace', false, String(e.message || e)); return out; }
    if (!step('trace', traced.hops <= MAX_HOPS_SOURCE, `${traced.hops} hop(s) to the etch (max ${MAX_HOPS_SOURCE})`)) return out;
    out.bundle = traced.bundle;
    out.hops = traced.hops;

    let rates = null;
    try { rates = await broadcaster.slipstreamRates(); step('mara-rates', true, `${rates.effective_rate} sat/vB effective`); }
    catch (e) { step('mara-rates', false, String(e.message || e)); }
    out.slipstreamRates = rates;

    let migrateRate = null;
    try { migrateRate = await chain.getFeeRate('priority'); step('fee-estimate', true, `${migrateRate} sat/vB`); }
    catch (e) { step('fee-estimate', false, String(e.message || e)); return out; }
    out.migrateFeeRate = migrateRate;

    out.ok = out.steps.every((s) => s.ok);
    return out;
  }

  // ---- preflightHeld: a note this key holds at its own Taproot output, which a cross-out made ----
  // The same checks as the reflected branch of preflight, for a note whose output is P2TR(this key) and whose auth key is that
  // key: it must be confirmed, tracked by the reflection, and in the note tree under the leaf the burn names it by.
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
      // A note bound to a deployment is burned as class 2; this path sends class 1 only, so such a note stops here, before anything is signed.
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

  // A reflected burn marked not recorded is looked at again: its transaction is read afresh (a reorg can move it to a later block, and
  // the attested state is judged against the block it is in now) and it goes back to waiting to be recorded.
  async function recheckBurn(walletPub, id) {
    const rec = getRecord(walletPub, id);
    if (!rec || rec.path !== 'reflected' || rec.stage !== 'not-recorded') throw new Error('burndep-ux: only a reflected burn marked not recorded can be checked again');
    const t = await fetchChainJson(`/tx/${stripHex(rec.burn.txid)}`);
    if (!t || !t.status || !t.status.confirmed) throw new Error('burndep-ux: that burn is not confirmed on Bitcoin just now; try again once it is');
    return putRecord({ ...rec, stage: 'rburn-mined', burnHeight: Number(t.status.block_height), lastError: null, errorCount: 0 });
  }

  async function traceNote({ txid, vout, assetId }) {
    // maxDepth is the walk's own budget, shared by both callers of traceNote (the source note in preflight,
    // the burn-home after migrate) — set to the larger of the two limits so neither trace is cut short before
    // the length check below gets a chance to run on the real hop count.
    const res = await callWorker('POST', '/reflection/burndep/trace', { note: { txid: stripHex(txid), vout }, assetId, maxDepth: MAX_HOPS_BURN_HOME });
    if (!res.ok) throw new Error(res.error || 'trace failed');
    return { bundle: res.bundle, hops: res.hops };
  }

  // Picks one confirmed, safe-to-spend UTXO from `address` — chain.pickSafeCommitSats does the actual
  // filtering/sorting (see this module's own header comment on why that call is opaque here), this just
  // takes its top pick.
  // A commit takes its funding coin whole and returns the rest through its reveal, so a smaller coin keeps less in the commit
  // until the reveal confirms: the smallest coin that covers `need` sats is chosen, the largest when none does.
  function pickFunding(utxos, need = 0) {
    const list = (Array.isArray(utxos) ? utxos : [utxos]).filter(Boolean);
    const cover = list.filter((u) => Number(u.value) >= need).sort((a, b) => Number(a.value) - Number(b.value));
    return cover[0] || list.slice().sort((a, b) => Number(b.value) - Number(a.value))[0] || null;
  }
  async function pickFundingUtxo(address, need = 0) {
    const utxos = await chain.getUtxos(address);
    const sorted = await chain.pickSafeCommitSats(utxos);
    const pick = pickFunding(sorted, need);
    if (!pick) throw new Error('burndep-ux: no safe funding UTXO available at this address');
    return { txid: pick.txid, vout: pick.vout, value: pick.value };
  }

  // ---- start: the very first signature, migrating the source note to its burn-home ----
  async function start({ note, walletPriv, fundingUtxo, feeRate = null }) {
    const walletPub = secp.getPublicKey(walletPriv, true);
    const id = recordId(note.txid, note.vout);
    if (getRecord(walletPub, id)) throw new Error('burndep-ux: a bridge already exists for this note');
    if (isReserved(note.txid, note.vout)) throw new Error('burndep-ux: this note is already reserved by another bridge in progress');
    if (BigInt(note.amount) > BURNDEP_BETA_CAP_RAW) throw new Error('burndep-ux: over the beta cap');

    // A stealth-received note's own spend key (see eligibleNotes' shape comment) — buildMigrationTxs signs
    // the source input with it while keeping the funding/envelope/change side on walletPriv.
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
    return putRecord(rec);
  }

  // ---- startReflected: a tracked note burned directly (source class 1), signed now, journalled before any broadcast ----
  // The note sits at this wallet's own P2WPKH output (auth key zero); the burn binds its ν, this pool's chain binding and
  // a destination note whose blinding is derived from the wallet key and ν, so the minted note is recoverable from the
  // key alone. bridge-burn-broadcast.js checks the plan against the attested state and reads the signed reveal back
  // the way the reflection does before anything is journalled.
  let _burner = null;
  const burner = () => _burner || (_burner = makeBridgeBurnBroadcaster({ pool, bridgeMint }));
  async function startReflected({ note, walletPriv, feeRate = null, allowHighFee = false }) {
    const walletPub = secp.getPublicKey(walletPriv, true);
    const id = recordId(note.txid, note.vout);
    if (getRecord(walletPub, id)) throw new Error('burndep-ux: a bridge already exists for this note');
    if (isReserved(note.txid, note.vout)) throw new Error('burndep-ux: this note is already reserved by another bridge in progress');
    // `note.assetId` names the asset (TAC when left out); `note.p2tr` says the note sits at this key's own Taproot output (a
    // cross-out made it) rather than its P2WPKH output, so the key is its auth key and it is spent by key path.
    const asset = assetOf(note.assetId || tacAssetId);
    if (!asset) throw new Error('burndep-ux: this asset cannot be sent back to Ethereum here');
    if (BigInt(note.amount) > asset.capRaw) throw new Error('burndep-ux: over the beta cap');
    if (note.stealthTweakedSk) throw new Error(`burndep-ux: ${PRIVATE_NOTE}`);
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
      dest: { owner: pickDestOwner(walletPriv, asset.assetId).owner },
      deriveDestBlinding: (nu) => mintRecovery.deriveBridgeMintBlinding({ privkey: walletPriv, nullifier: nu }),
    });
    const p = built.plan;
    const funding = built.commitTx.inputs.map((i) => ({ txid: i.txid, vout: i.vout }));
    return putRecord({
      id, network, walletPub: bytesToHexLocal(walletPub), path: 'reflected', stage: 'rburn-signed', createdAt: now(),
      source: { txid: stripHex(note.txid).toLowerCase(), vout: Number(note.vout), sats: Number(note.sats), assetId: asset.assetId, ticker: asset.ticker, ...(p2tr ? { p2tr: true } : {}), amount: BigInt(note.amount), blinding: BigInt(note.blinding) },
      burn: { txid: built.revealTxid, hex: built.revealHex, commitTxid: built.commitTxid, commitHex: built.commitHex, fee: built.commitFee + built.revealFee, feeRate: built.feeRate, fundingUtxo: funding[0], fundingUtxos: funding },
      envelope: { destLeaf: p.destLeaf, nullifier: p.nullifier, burnId: p.burnId },
      mint: {
        sourceClass: p.sourceClass, spentTxid: p.spentTxid, spentVout: p.spentVout, chainBinding: p.chainBinding,
        burned: { value: p.burned.value, blinding: p.burned.blinding, owner: p.burned.owner },
        dest: { value: p.dest.value, blinding: p.dest.blinding, owner: p.dest.owner },
      },
    });
  }

  // ---- advance: drive a record forward one stage. walletPriv is required only at the two stages that sign. ----
  // Tracks failures on the record itself (lastError, errorCount), not just in whatever caught the throw —
  // the background poller (dapp/tacit.js) advances unattended and otherwise has nowhere to put a repeated
  // failure, which would leave a permanently-stuck bridge (a hop-limit refusal, an unresolvable registration
  // conflict, anything else that can never succeed on its own) showing the same "in progress" stage label
  // forever with no sign anything is wrong. A caller still sees the thrown error immediately either way; this
  // is for whoever looks at the record later, possibly a different tab, after the throw is long gone.
  // onProgress({ phase, ... }): best-effort, fire-and-forget UI feedback for a step that can take real time
  // (today only the mint, which fetches a multi-MB snapshot and waits on real network proving — everything
  // else here is a broadcast or a single small request, over before a progress indicator would even paint).
  // selfSettle({ jobId, publicValues, proof, memos }) → { txHash }: at the mint, the relay proves and the caller sends the
  // settle itself and pays its gas, for a relay that will not take the mint (a fee floor, a spent free budget, load).
  const inFlight = new Set();                                  // bridges this page is moving on now
  async function advance(walletPub, id, { walletPriv = null, onProgress = null, selfSettle = null } = {}) {
    const rec = getRecord(walletPub, id);
    if (!rec) throw new Error(`burndep-ux: no bridge record for ${id}`);
    // A key that is not the bridge's would sign or seal its steps as another key.
    if (walletPriv && lc(bytesToHexLocal(secp.getPublicKey(walletPriv, true))) !== lc(rec.walletPub)) throw new Error('burndep-ux: this bridge belongs to another key');
    if (inFlight.has(id)) throw new Error('burndep-ux: this bridge is being advanced in this page right now');
    if (!tryAcquireLease(id)) throw new Error('burndep-ux: this bridge is being advanced in another tab right now');
    inFlight.add(id);
    // A stage can outlast the lease (a mint waits on a proof), so it is kept while this call holds it: no other page starts the
    // same step meanwhile.
    const renew = setInterval(() => { try { storage.setItem(leaseKey(id), JSON.stringify({ owner: sessionId, at: now() })); } catch {} }, Math.max(1000, Math.floor(LEASE_TTL_MS / 3)));
    let at = null;
    try {
      // Read again under the lease: another page may have moved the record on since the read above.
      const cur = getRecord(walletPub, id);
      if (!cur) throw new Error(`burndep-ux: no bridge record for ${id}`);
      at = cur;
      const fn = STAGE_ADVANCE[cur.stage];
      if (!fn) return cur; // terminal ('minted') or unknown — nothing to do
      const result = await fn(cur, { walletPriv, onProgress, selfSettle });
      return cur.lastError ? putRecord({ ...result, lastError: null, errorCount: 0 }) : result;
    } catch (e) {
      // Only a record still where this call found it takes the error: one that another page moved on keeps what it reached.
      const now_ = at && getRecord(walletPub, id);
      if (now_ && now_.stage === at.stage) putRecord({ ...now_, lastError: { message: String((e && e.message) || e), at: now() }, errorCount: (now_.errorCount || 0) + 1 });
      throw e;
    } finally { inFlight.delete(id); clearInterval(renew); releaseLease(id); }
  }

  const STAGE_ADVANCE = {
    'migrate-signed': async (rec) => {
      await chain.broadcastWithRetry(rec.migrate.commitHex);
      await chain.broadcastWithRetry(rec.migrate.revealHex);
      return putRecord({ ...rec, stage: 'migrate-sent', sentAt: now() });
    },
    'migrate-sent': async (rec) => {
      const st = await checkTxidStatus(rec.migrate.revealTxid);
      if (st.status === 'not-found' || st.status === 'unconfirmed') {
        // A duplicate broadcast of an already-known tx is a safe, explicit no-op (never rebuild — BP+ proofs
        // are non-deterministic, so a rebuilt migrate would be a different, conflicting transaction).
        await chain.broadcastWithRetry(rec.migrate.commitHex).catch(() => {});
        await chain.broadcastWithRetry(rec.migrate.revealHex).catch(() => {});
        return rec;
      }
      return putRecord({ ...rec, stage: 'migrate-confirmed', migrateConfirmedAt: now() });
    },
    'migrate-confirmed': async (rec) => {
      const tracked = await isLive(rec.burnHome.txid, 0, { fresh: true });
      if (tracked === true) return putRecord({ ...rec, stage: 'stopped', stoppedAt: now(), stoppedWhy: 'tracked' });
      if (tracked === null) return rec; // waits for the reflection to reach the move's block
      const traced = await traceNote({ txid: rec.burnHome.txid, vout: 0, assetId: tacAssetId });
      if (traced.hops > MAX_HOPS_BURN_HOME) throw new Error(`burndep-ux: burn-home traces in ${traced.hops} hops, over the ${MAX_HOPS_BURN_HOME}-hop limit`);
      const bundle = { ...traced.bundle, burned: { cx: rec.burnHome.cx, cy: rec.burnHome.cy } };
      return putRecord({ ...rec, stage: 'traced', bundle, hops: traced.hops });
    },
    traced: async (rec, { walletPriv }) => {
      const tracked = await isLive(rec.burnHome.txid, 0, { fresh: true });
      if (tracked === true) return putRecord({ ...rec, stage: 'stopped', stoppedAt: now(), stoppedWhy: 'tracked' });
      if (tracked === null) return rec; // waits for the reflection to reach the move's block
      if (!walletPriv) throw new Error('burndep-ux: this stage needs the wallet key');
      const P = freshPrims(walletPriv);
      // Reconstruct the burn-home's own signing key from the wallet + source outpoint (never journalled) and
      // check it against what's actually on chain before building anything that spends it.
      const burnHomeOnChain = await fetchChainJson(`/tx/${stripHex(rec.burnHome.txid)}`);
      const chainSpk = burnHomeOnChain.vout[0].scriptpubkey;
      const burnHome = reveal.reconstructBurnHome({
        prims: P, walletPriv, source: { txid: rec.source.txid, vout: rec.source.vout },
        amount: rec.source.amount, burnHomeTxid: rec.burnHome.txid, chainSpk,
      });

      const rates = await broadcaster.slipstreamRates();
      const feeRate = Math.max(Number(rates.effective_rate), Number(rates.submit_fee_rate), 1) * 1.1;
      const dest = deriveDest(walletPriv, burnHome, rec.burnHome.txid, rec.source.amount);
      const target = withHex(chainBindingHex());
      const { cx: destCx, cy: destCy } = pool.commitXY(dest.value, dest.blinding);
      const destLeaf = pool.leaf(withHex(tacAssetId), destCx, destCy, dest.owner);
      const envelope = { assetId: withHex(tacAssetId), nullifier: dest.nullifier, destLeaf, target };

      const fundingUtxo = rec.burn && rec.burn.fundingUtxo ? rec.burn.fundingUtxo : await pickFundingUtxo(P.wallet.address(), Math.ceil(700 * feeRate * 1.3) + 846);
      const built = await reveal.buildBurnDepositRevealTxs({ prims: P, burnHome, envelope, fundingUtxo, feeRate });
      const check = await callWorker('POST', '/reflection/burndep/check', {
        bundle: rec.bundle, assetId: withHex(tacAssetId), burnTxHex: built.revealHex,
      });
      if (!check.ok || !check.admitted) throw new Error(`burndep-ux: the burn would not be admitted yet: ${(check && check.reason) || (check && check.error) || 'unknown'}`);

      return putRecord({
        ...rec, stage: 'burn-signed',
        burn: { hex: built.revealHex, txid: built.revealTxid, feeRate: built.feeRate, fee: built.fee, fundingUtxo },
        envelope, dest,
      });
    },
    'burn-signed': async (rec) => {
      // A burn signed earlier is held back while its burn-home is tracked.
      const tracked = await isLive(rec.burnHome.txid, 0, { fresh: true });
      if (tracked === true) return putRecord({ ...rec, stage: 'stopped', stoppedAt: now(), stoppedWhy: 'tracked' });
      if (tracked === null) return rec; // waits for the reflection to reach the move's block
      // submitToSlipstream itself throws on a non-success status (burndep-broadcast.js) — nothing further to
      // check here.
      await broadcaster.submitToSlipstream(rec.burn.hex);
      return putRecord({ ...rec, stage: 'burn-submitted', submittedAt: now() });
    },
    'burn-submitted': async (rec) => {
      const st = await checkTxidStatus(rec.burn.txid);
      if (st.status === 'not-found' || st.status === 'unconfirmed') return rec;
      return putRecord({ ...rec, stage: 'burn-mined', burnMinedAt: now() });
    },
    'burn-mined': async (rec) => {
      // The worker's own registration door already tells an idempotent resubmission apart from a real
      // conflict: an identical bundle resubmit returns 200 {ok:true} without ever throwing (first-writer-wins
      // is a no-op on a byte-identical write), so registerBurnDeposit throwing here is always a genuine,
      // first-writer-wins conflict against a DIFFERENT bundle already stored for this exact burn txid — never
      // something safe to swallow and proceed past.
      await broadcaster.registerBurnDeposit({ burnTxidDisplay: rec.burn.txid, bundle: rec.bundle, network });
      return putRecord({ ...rec, stage: 'registered', registeredAt: now() });
    },
    'reclaim-sent': async (rec) => {
      const t = await fetchChainJson(`/tx/${stripHex(rec.reclaim.txid)}`).catch(() => null);
      if (!t || !t.status || !t.status.confirmed) {
        // Re-sending a known transaction is a no-op; never rebuilt, since a rebuilt cancel would conflict with this one.
        await chain.broadcastWithRetry(rec.reclaim.commitHex).catch(() => {});
        await chain.broadcastWithRetry(rec.reclaim.revealHex).catch(() => {});
        return rec;
      }
      return putRecord({ ...rec, stage: 'reclaimed', reclaimedAt: now() });
    },
    // The reflected path: broadcast, confirm, wait for the attested state to record the burn, then mint.
    'rburn-signed': async (rec) => {
      await chain.broadcastWithRetry(rec.burn.commitHex);
      await chain.broadcastWithRetry(rec.burn.hex);
      return putRecord({ ...rec, stage: 'rburn-sent', sentAt: now() });
    },
    'rburn-sent': async (rec) => {
      const t = await fetchChainJson(`/tx/${stripHex(rec.burn.txid)}`).catch(() => null);
      if (!t || !t.status || !t.status.confirmed) {
        // Re-sending a known transaction is a no-op; the signed pair is never rebuilt.
        await chain.broadcastWithRetry(rec.burn.commitHex).catch(() => {});
        await chain.broadcastWithRetry(rec.burn.hex).catch(() => {});
        return rec;
      }
      return putRecord({ ...rec, stage: 'rburn-mined', burnMinedAt: now(), burnHeight: t.status.block_height });
    },
    'rburn-mined': async (rec) => {
      const r = await reflected(true);
      if (r.dests.has(lc(rec.envelope.destLeaf))) return putRecord({ ...rec, stage: 'rfolded', foldedAt: now() });
      const h = Number(rec.burnHeight);
      if (!Number.isInteger(h) || !Number.isInteger(r.height) || h > r.height) return rec;
      return putRecord({ ...rec, stage: 'not-recorded', notRecordedAt: now() });
    },
    rfolded: async (rec, { walletPriv, onProgress, selfSettle }) => {
      if (!walletPriv) throw new Error('burndep-ux: this stage needs the wallet key');
      const say = (phase, extra) => { try { onProgress && onProgress({ phase, ...extra }); } catch { /* best-effort */ } };
      const m = rec.mint;
      const already = await mintLanded(rec);
      if (already) return already;
      say('fetching-snapshot');
      let minted;
      try {
        minted = await bridgeMint.bridgeMint({
        network, sourceClass: m.sourceClass, spentTxid: m.spentTxid, spentVout: m.spentVout,
        asset: withHex((rec.source && rec.source.assetId) || tacAssetId), chainBinding: m.chainBinding,
        burned: { value: BigInt(m.burned.value), blinding: BigInt(m.burned.blinding), owner: m.burned.owner },
        dest: { value: BigInt(m.dest.value), blinding: BigInt(m.dest.blinding), owner: m.dest.owner },
        // The destination blinding is derived from the wallet key and ν, which the recovery scan re-derives.
        recovery: recoveryFor(walletPriv, m.dest.value, (rec.source && rec.source.assetId) || tacAssetId),
        selfSettle,
        waitOpts: { timeoutMs: MINT_WAIT_MS, onJob: (jobId) => say('submitted', { jobId }), onUpdate: (st) => say('status', { status: st.status }) },
        });
      } catch (e) {
        const done = await mintLanded(rec);
        if (done) return done;
        throw e;
      }
      return putRecord({ ...rec, stage: 'minted', mintedAt: now(), mintedJobId: minted.jobId || null, mintedTxHash: minted.txHash || null });
    },
    // A recovery in flight: follow its claim until the TAC is sent back to this wallet.
    recovering: async (rec) => {
      const c = await callWorker('GET', `/bridge/recover?burn=${stripHex(rec.burn.txid)}`);
      if (c && c.status === 'sent') return putRecord({ ...rec, stage: 'recovered', recover: { ...rec.recover, status: 'sent', txid: c.txid, sentAt: now() } });
      if (c && c.status === 'none') return putRecord({ ...rec, stage: 'not-recorded' });
      if (c && c.status && c.status !== (rec.recover && rec.recover.status)) return putRecord({ ...rec, recover: { ...rec.recover, status: c.status } });
      return rec;
    },
    registered: async (rec) => {
      const st = await checkTxidStatus(rec.burn.txid);
      if (st.status !== 'folded') return rec;
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
      const say = (phase, extra) => { try { onProgress && onProgress({ phase, ...extra }); } catch { /* best-effort */ } };
      // A record saved before dest was always written (recoverFromTxid's old gap, or any other path that
      // reaches here without it) has no dest yet — derive and persist it now rather than throwing on
      // rec.dest.index, since it's fully determined by the wallet key and doesn't need rebuilding from chain.
      const dest = rec.dest || deriveDest(walletPriv, rec.burnHome, rec.burnHome.txid, rec.source.amount);
      say('fetching-snapshot'); // bridgeMint's own fetchReflectionSnapshot() is the multi-MB reflection dump — no
      // hook inside that call itself, so this fires for the whole build+submit span up to the relay's own onJob.
      let minted;
      try {
        minted = await bridgeMint.bridgeMint({
        network, sourceClass: 0,
        spentTxid: withHex(revHex(rec.burnHome.txid)), spentVout: 0,
        asset: withHex(tacAssetId), chainBinding: withHex(chainBindingHex()),
        burned: { value: rec.source.amount, blinding: rec.burnHome.blinding, owner: '0x' + '00'.repeat(32) },
        dest: { value: dest.value, blinding: dest.blinding, owner: dest.owner },
        // dest.blinding came from deriveBridgeMintBlinding (below), which the recovery scan re-derives on its
        // own from the seed — the { ownerPub, secret } memo-sealing path is for a blinding it has no other way
        // to find, which isn't the case here.
        recovery: recoveryFor(walletPriv, dest.value),
        selfSettle,
        waitOpts: {
          timeoutMs: MINT_WAIT_MS,
          onJob: (jobId) => say('submitted', { jobId }),
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

  // A mint that landed without this page hearing of it (a lost answer, a wait that ran out, a settle sent by someone else)
  // shows as the burned note's nullifier spent in the pool: the record is complete, and nothing is built or sent again.
  // The pool takes each nullifier once, so a second mint of one burn could only fail; this keeps it from being sent.
  async function mintLanded(rec) {
    const nu = (rec.envelope && rec.envelope.nullifier) || (rec.dest && rec.dest.nullifier);
    if (!nullifierSpent || !nu) return null;
    try { return (await nullifierSpent(nu)) ? putRecord({ ...rec, stage: 'minted', mintedAt: now(), lastError: null, errorCount: 0 }) : null; } catch { return null; }
  }

  // A stable, always-available choice: this beta ships one bridge per note, so index 0 never collides with
  // itself, and recovery (confidential-recovery.js's walkBridgeMints) tries indexes 0..7 regardless of which
  // one was actually used, so nothing is lost if a future version needs to rotate this.
  function pickDestOwner(walletPriv, assetId = tacAssetId) {
    const dn = pool.deriveNote(walletPriv, withHex(assetId), 0);
    return { destIndex: 0, owner: pool.nkToOwner(dn.secret), secret: dn.secret };
  }

  // How the minted note stays recoverable from the key alone. The destination blinding is derived from the key, but the amount is
  // hidden in the commitment, and the recovery scan finds it only among round amounts (m x 10^k with m under 100) and ones this
  // browser's journal remembers. A round amount keeps the derived blinding as before; any other amount also seals a memo to the
  // key, which any device reads back from the chain.
  const scanRound = (v) => { let x = BigInt(v); if (x <= 0n) return false; while (x % 10n === 0n) x /= 10n; return x < 100n; };
  // A balance read searches the derived blinding for TAC alone (a deep recovery covers the other assets), so a note of any other
  // asset is always sealed to the key, whatever its amount.
  function recoveryFor(walletPriv, value, assetId = tacAssetId) {
    if (lc(stripHex(assetId)) === lc(stripHex(tacAssetId)) && scanRound(value)) return { seedDerived: true };
    return { ownerPub: '0x' + bytesToHexLocal(secp.getPublicKey(walletPriv, true)), secret: pickDestOwner(walletPriv, assetId).secret };
  }

  // The mint-time destination note: fully re-derivable from the wallet key plus the burn-home's own commitment
  // and txid, so any record that already knows those two things can compute it, not only one built by the
  // 'traced' stage transition itself (recoverFromTxid rebuilds a record from chain data alone and needs this
  // too, for any status that maps straight to 'folded' or later).
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
    return res.json();
  }
  function fetchChainJson(path) { return callWorker('GET', `/chain${path}`); }
  async function fetchChainText(path) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!f) throw new Error('burndep-ux: no fetch implementation');
    const res = await f(`${workerBase}/chain${path}${path.includes('?') ? '&' : '?'}network=${network}`);
    if (!res.ok) throw new Error(`burndep-ux: chain read failed (${res.status})`);
    return (await res.text()).trim().replace(/^0x/, '');
  }

  function list(walletPub) { return loadAll(walletPub); }
  function abandon(walletPub, id) { saveAll(walletPub, loadAll(walletPub).filter((r) => r.id !== id)); }

  // Whether a transaction is on Bitcoin (mined or in a mempool): 'present', 'absent' only on an explicit not-found, and
  // 'unknown' for anything else, a rate limit or an outage included -- a transport failure is never read as absence.
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

  // Gives up a bridge whose signed burn or move Bitcoin never took, once the chain is asked again and has neither of its
  // two transactions: its TAC was never spent. One whose reveal Bitcoin has is not given up but goes on as sent, and one
  // whose commit alone is there, or that could not be checked, is kept. → the record that goes on, or null once dropped.
  async function cancelSigned(walletPub, id) {
    if (!getRecord(walletPub, id)) return null;
    if (!tryAcquireLease(id)) throw new Error('burndep-ux: this bridge is being advanced in another tab right now');
    try {
      const rec = getRecord(walletPub, id);
      if (!rec) return null;
      const signed = rec.stage === 'rburn-signed' ? rec.burn : rec.stage === 'migrate-signed' ? rec.migrate : null;
      if (!signed) throw new Error('burndep-ux: only a bridge whose signed transaction Bitcoin never took can be cancelled');
      const [commit, reveal] = await Promise.all([chainTxState(signed.commitTxid), chainTxState(signed.txid || signed.revealTxid)]);
      if (reveal === 'present') return putRecord({ ...rec, stage: rec.stage === 'rburn-signed' ? 'rburn-sent' : 'migrate-sent', sentAt: now(), lastError: null, errorCount: 0 });
      if (commit === 'present') throw new Error('burndep-ux: the first of its two transactions is on Bitcoin, so it was not cancelled');
      if (commit !== 'absent' || reveal !== 'absent') throw new Error('burndep-ux: Bitcoin could not be asked about its transactions just now, so it was not cancelled; try again in a minute');
      abandon(walletPub, id);
      return null;
    } finally { releaseLease(id); }
  }

  // Recovers a bridge from just its burn txid and the wallet key — the case where the journal itself is
  // gone (a different browser/device, or cleared storage) but the migrate has already confirmed, so
  // everything downstream of it is derivable from chain data + the deterministic key derivations. Rebuilds
  // a record starting at whatever stage the burn's own status implies, then journals it under this wallet so
  // resumeAll/advance carry it forward normally. Does not recover a bridge stuck before the burn even exists
  // (mid-migrate, no burn tx yet) — that window is covered by the journal, not by chain data alone.
  // A one-step burn (a tracked note burned directly) needs no amount: the burned note's opening follows from the key and the
  // transaction that made it, and the burn must name this key's own destination. Returns the rebuilt record, or null when
  // the burn is not of that kind (a burn-deposit, which recoverFromTxid rebuilds from its amount instead).
  async function recoverReflectedBurn(burnTxidDisplay, walletPriv) {
    if (!openNote && !openHeldNote) return null;
    const id = stripHex(burnTxidDisplay).toLowerCase();
    const burnTx = await fetchChainJson(`/tx/${id}`);
    if (!burnTx || !burnTx.vin || burnTx.vin.length < 2) return null;
    const env = classifyConfidentialTx('0x' + await fetchChainText(`/tx/${id}/hex`));
    const asset = env && env.type === 'burn' ? assetOf(env.assetId) : null;
    if (!asset) return null;
    const prev = classifyConfidentialTx('0x' + await fetchChainText(`/tx/${stripHex(burnTx.vin[0].txid)}/hex`));
    if (prev && prev.type === 'cxfer') return null;                         // vin[0] is a burn-home: a burn-deposit
    if (!burnTx.status || !burnTx.status.confirmed) throw new Error('burndep-ux: that burn has not confirmed yet; try again once it has');

    const note = burnTx.vin[1];                                             // [envelope commit, the burned note]
    // A note at this wallet's P2WPKH output is opened from the transaction that made it (TAC); one a cross-out made at this key's
    // Taproot output is opened from the key and the chain, and that key is its owner.
    const ZERO = '0x' + '00'.repeat(32);
    let opened = lc(stripHex(asset.assetId)) === lc(stripHex(tacAssetId)) && openNote ? await openNote(note.txid, note.vout) : null, burnedOwner = ZERO;
    if (!opened && openHeldNote) {
      const held = await openHeldNote(note.txid, note.vout, walletPriv);
      if (held && lc(stripHex(held.assetId)) === lc(stripHex(asset.assetId))) { opened = held; burnedOwner = held.owner; }
    }
    if (!opened) throw new Error('burndep-ux: this key did not receive that burned note, so it is not this wallet’s bridge');
    const walletPub = secp.getPublicKey(walletPriv, true);
    const { cx, cy } = pool.commitXY(BigInt(opened.amount), BigInt(opened.blinding));
    const srcLeaf = pool.btcNoteLeaf(asset.assetId, cx, cy, burnedOwner);
    const nu = pool.nullifier(srcLeaf);
    if (lc(env.nullifier) !== lc(nu)) throw new Error('burndep-ux: the burn does not match that note’s opening (a note not held at this wallet’s own address cannot be rebuilt this way)');
    // The destination is this key's own: only its owner derives the blinding, and the burn pins the leaf that commits to it.
    const owner = pickDestOwner(walletPriv, asset.assetId).owner;
    const destBlinding = mintRecovery.deriveBridgeMintBlinding({ privkey: walletPriv, nullifier: env.nullifier });
    const { cx: dx, cy: dy } = pool.commitXY(BigInt(opened.amount), destBlinding);
    if (lc(pool.leaf(asset.assetId, dx, dy, owner)) !== lc(env.dest)) throw new Error('burndep-ux: that burn names a destination that is not this wallet’s, so it is not this wallet’s bridge');

    const rid = recordId(note.txid, note.vout);
    const existing = getRecord(walletPub, rid);
    if (existing) {
      if (existing.stage !== 'minted' && nullifierSpent && await nullifierSpent(env.nullifier).catch(() => false)) return putRecord({ ...existing, stage: 'minted', mintedAt: now(), lastError: null, errorCount: 0 });
      return existing;
    }
    const spentTxid = withHex(revHex(note.txid));                           // internal byte order, as the mint names it
    const rec = {
      id: rid, network, walletPub: bytesToHexLocal(walletPub), path: 'reflected', stage: 'rburn-mined', createdAt: now(), recoveredAt: now(),
      source: { txid: stripHex(note.txid).toLowerCase(), vout: Number(note.vout), sats: note.prevout ? note.prevout.value : null, assetId: asset.assetId, ticker: asset.ticker, ...(burnedOwner !== ZERO ? { p2tr: true } : {}), amount: BigInt(opened.amount), blinding: BigInt(opened.blinding) },
      burn: { txid: id, hex: null },
      burnHeight: Number(burnTx.status.block_height),
      envelope: { destLeaf: env.dest, nullifier: env.nullifier, burnId: pool.bridgeBurnId(1, spentTxid, Number(note.vout), srcLeaf, env.target) },
      mint: {
        sourceClass: 1, spentTxid, spentVout: Number(note.vout), chainBinding: env.target,
        burned: { value: BigInt(opened.amount), blinding: BigInt(opened.blinding), owner: burnedOwner },
        dest: { value: BigInt(opened.amount), blinding: destBlinding, owner },
      },
    };
    // Already minted elsewhere: the bridge is complete, and there is nothing to press.
    if (nullifierSpent && await nullifierSpent(env.nullifier).catch(() => false)) return putRecord({ ...rec, stage: 'minted', mintedAt: now() });
    return putRecord(rec);
  }

  async function recoverFromTxid(burnTxidDisplay, walletPriv, { amount } = {}) {
    const reflectedBridge = await recoverReflectedBurn(burnTxidDisplay, walletPriv);
    if (reflectedBridge) return reflectedBridge;
    if (amount == null) throw new Error('burndep-ux: recoverFromTxid needs { amount } — the confidential value the original note carried (not recoverable from chain data alone)');
    const walletPub = secp.getPublicKey(walletPriv, true);
    const status = await checkTxidStatus(burnTxidDisplay);
    if (status.status === 'not-found') throw new Error('burndep-ux: unknown burn txid');
    if (!status.note || !status.assetId) throw new Error('burndep-ux: this txid does not classify as a burn-deposit');
    if (lc(stripHex(status.assetId)) !== lc(stripHex(tacAssetId))) throw new Error('burndep-ux: this burn is for a different asset');
    const burnHomeTxid = stripHex(status.note.txid);

    const traced = await traceNote({ txid: burnHomeTxid, vout: 0, assetId: tacAssetId });
    // cxfers[0] is the migrate itself (the hop directly producing the burn-home); its own first input is the
    // source note. inputs[].prevTxid is already display-hex (see burndep-live-tracer.js's own seed()/inputs
    // construction, sourced straight from esplora's vin[].txid) — no byte-order flip needed here.
    const firstInput = traced.bundle && traced.bundle.cxfers && traced.bundle.cxfers[0] && traced.bundle.cxfers[0].inputs && traced.bundle.cxfers[0].inputs[0];
    if (!firstInput) throw new Error('burndep-ux: could not recover the source note behind this burn-home');
    const source = { txid: stripHex(firstInput.prevTxid), vout: firstInput.prevVout };

    const burnHomeOnChain = await fetchChainJson(`/tx/${burnHomeTxid}`);
    const chainSpk = burnHomeOnChain.vout[0].scriptpubkey;
    const P = freshPrims(walletPriv);
    const burnHome = reveal.reconstructBurnHome({ prims: P, walletPriv, source, amount, burnHomeTxid, chainSpk });
    // The script check above covers the key and the outpoint; the amount is the holder's to type, so it must reproduce the
    // commitment the burn-home carries on chain before anything is journalled or registered from it.
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
      // blinding is not recoverable (and not needed): every stage recoverFromTxid can resume into is past the
      // point anything reads the source note's own opening — only its outpoint and amount matter from here.
      source: { txid: source.txid, vout: source.vout, sats: burnHome.value, assetId: tacAssetId, amount: BigInt(amount), blinding: 0n },
      burnHome: {
        txid: burnHomeTxid, vout: 0, value: burnHome.value, cx: burnHome.cx, cy: burnHome.cy, blinding: burnHome.blinding,
        xonly: bytesToHexLocal(burnHome.xonly), spk: bytesToHexLocal(burnHome.spk), controlBlock: bytesToHexLocal(burnHome.controlBlock), scriptS: bytesToHexLocal(burnHome.scriptS),
      },
      bundle, hops: traced.hops,
      burn: { txid: stripHex(burnTxidDisplay), hex: null, fundingUtxo: null },
      // A record recovered straight into 'registered' or 'folded' skips the 'traced' transition that normally
      // computes this — without it, reaching 'folded' throws trying to read rec.dest.index. Same derivation,
      // fully determined by the wallet key and the burn-home already reconstructed above.
      dest: deriveDest(walletPriv, burnHome, burnHomeTxid, BigInt(amount)),
    };
    // A bridge this browser already finished is not rebuilt into an earlier stage.
    const had = getRecord(walletPub, rec.id);
    if (had && (had.stage === 'minted' || had.stage === 'reclaimed' || had.stage === 'recovered')) return had;
    return putRecord(rec);
  }

  // ---- cancel: reclaim a stuck burn-home by moving its value into an ordinary note (an "un-migrate" cxfer,
  // see buildCancelTx's own header comment for why this must be a real cxfer envelope and not a bare
  // payment). Usable from any stage where a confirmed burn-home UTXO is known to exist and has not yet been
  // spent by the real burn-envelope reveal. That is narrower than "migrate-confirmed through anything short
  // of folded/minted": burn-mined (and everything after it — registered, folded, minted) is reached ONLY once
  // rec.burn.txid — the transaction that spends the burn-home as its very first input — is ITSELF confirmed
  // (see STAGE_ADVANCE['burn-submitted']), so by the time a record reaches burn-mined the burn-home is
  // already spent and there is nothing left to cancel. migrate-signed/migrate-sent are excluded the other
  // direction: the burn-home isn't a confirmed UTXO yet, so reconstructBurnHome has no real on-chain script
  // to verify against.
  const CANCEL_TOO_EARLY_STAGES = new Set(['migrate-signed', 'migrate-sent']);
  const CANCELABLE_STAGES = new Set(['migrate-confirmed', 'traced', 'burn-signed', 'burn-submitted', 'stopped']);
  // rec: a record from list()/getRecord (any stage). Self-reclaim only, to this same wallet's own address —
  // v1 has no destination parameter, matching crossout-ux.js's own "v1 is self-bridge only" scope. Returns
  // the same { hex: revealHex, txid: revealTxid, fee, ... } buildCancelTx does; nothing broadcast, nothing
  // journalled — a cancel isn't a step in the state machine's own forward progression, so the caller decides
  // what to do with the result (broadcast commit then reveal, then abandon() the record once it confirms).
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
    // Same reconstruction path STAGE_ADVANCE.traced already uses: re-derive the burn-home's own signing key
    // from the wallet + source outpoint (never journalled) and verify it against the real on-chain output
    // before building anything that spends it.
    const burnHomeOnChain = await fetchChainJson(`/tx/${stripHex(rec.burnHome.txid)}`);
    const chainSpk = burnHomeOnChain.vout[0].scriptpubkey;
    const burnHome = reveal.reconstructBurnHome({
      prims: P, walletPriv, source: { txid: rec.source.txid, vout: rec.source.vout },
      amount: rec.source.amount, burnHomeTxid: rec.burnHome.txid, chainSpk,
    });
    const fundingUtxo = await pickFundingUtxo(P.wallet.address(), Math.ceil(535 * (feeRate || 10) * 1.3) + 846);
    return reveal.buildCancelTx({ prims: P, burnHome, assetId: tacAssetId, walletPriv, walletPub, fundingUtxo, feeRate });
  }

  // Sends a stopped bridge's TAC back to this wallet: the cancel is built (buildCancel), broadcast, and followed to its
  // confirmation, after which the note is an ordinary one in this wallet's holdings.
  async function reclaim({ rec, walletPriv, feeRate = null } = {}) {
    const built = await buildCancel({ rec, walletPriv, feeRate });
    await chain.broadcastWithRetry(built.commitHex);
    await chain.broadcastWithRetry(built.revealHex);
    return putRecord({ ...rec, stage: 'reclaim-sent', reclaim: { commitTxid: built.commitTxid, txid: built.revealTxid, commitHex: built.commitHex, revealHex: built.revealHex }, reclaimSentAt: now() });
  }
  // A bridge that did not complete: its TAC comes back to this wallet. The wallet key signs a claim naming the burn, the
  // amount and the burned note's opening (dapp/bridge-recover.js); once it checks out the same amount is sent to this
  // wallet's address, and the record follows it through 'recovering' to 'recovered'.
  async function recover({ rec, walletPriv } = {}) {
    if (!rec || (rec.stage !== 'not-recorded' && rec.stage !== 'recovering')) throw new Error('burndep-ux: only a bridge that did not complete can be recovered');
    if (!walletPriv) throw new Error('burndep-ux: recovering needs the wallet key');
    if (bytesToHexLocal(secp.getPublicKey(walletPriv, true)) !== lc(rec.walletPub)) throw new Error('burndep-ux: this bridge belongs to a different wallet');
    // The burned note's opening: the burn-home's for a burn-deposit, the note's own for a burn of a tracked note.
    const blinding = rec.burnHome ? rec.burnHome.blinding : rec.source.blinding;
    const claim = buildRecoverClaim({ secp, sha256, signSchnorr }, { burnTxid: rec.burn.txid, amount: rec.source.amount, blinding, walletPriv });
    const r = await callWorker('POST', '/bridge/recover', claim);
    if (!r || !r.ok) throw new Error((r && r.error) || 'the recovery could not be started; try again in a moment');
    return putRecord({ ...rec, stage: r.status === 'sent' ? 'recovered' : 'recovering', recover: { status: r.status, txid: r.txid || null, at: now() } });
  }

  // The key-free part of a stage the holder drives: a bridge whose burn-home is live stops, an unrecorded burn says
  // so, and a mint that landed is complete, without waiting for a click. Used by a page's background refresh.
  async function verify(walletPub, id) {
    const rec = getRecord(walletPub, id);
    if (!rec) return null;
    if ((rec.stage === 'traced' || rec.stage === 'migrate-confirmed') && (await isLive(rec.burnHome.txid, 0, { fresh: true })) === true) {
      return putRecord({ ...rec, stage: 'stopped', stoppedAt: now(), stoppedWhy: 'tracked' });
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
    BURNDEP_BETA_CAP_RAW, assets: ASSETS, assetOf, eligibleNotes, isReserved, pickFunding, preflight, preflightHeld, recheckBurn, RETURN_FEE_CEILING, start, startReflected, advance, resumeAll, recoverFromTxid, list, abandon,
    cancelSigned, buildCancel, reclaim, recover, verify, isLive, burnRecorded,
    slipstreamStatus: broadcaster.slipstreamStatus,
    checkTxidStatus,
  };
}
