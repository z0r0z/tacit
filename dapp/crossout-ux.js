// Orchestrates a cross-out bridge (Ethereum -> Bitcoin) end to end for TAC and, where the caller names it in
// `assets`, tETH: settle a confidential note as a
// bridge_burn (records a claim on Ethereum), wait for the reflection worker's eth-state view to cover that
// block, then mint the Bitcoin-side note via a commit/reveal T_CROSSOUT_MINT envelope. Wires together two
// already-independent, already-proven pieces -- the confidential pool's own crossOut (dapp/confidential-pool-ux.js,
// settled + corroborated against mainnet 2026-07-16/17) and dapp/crossout-mint-reveal.js (the Bitcoin-side
// builder, extracted from the same proof's tools/build-crossout-mint.mjs) -- into one resumable state
// machine, journalled so a reload picks up exactly where it left off.
//
// This module never imports dapp/tacit.js and takes every wallet-stateful primitive by injection, building a
// fresh makeBtcWallet-shaped `prims` per signing call rather than sharing one across calls -- the same
// one-wallet-source rule dapp/burndep-ux.js follows, for the same reason.
//
// v1 is self-bridge only: the destination is this wallet's own Bitcoin taproot key (the same walletPriv
// scalar tacit.js already uses for both chains -- see makeBurnDepositUx's start() call site), not an
// arbitrary recipient. Bridging to someone else's Bitcoin key is a real, later extension, not a gap in this
// one; nothing here forecloses it.
//
// State machine (one record per source note nullifier):
//   settling -> settled -> covered -> mint-signed -> mint-submitted -> mint-confirmed -> minted
// 'settling' is the intent written before the burn is sent (see start); 'mint-confirmed' is the reveal confirmed on
// Bitcoin and waiting for the worker to credit the note (GET /crossout/minted), which is what 'minted' means: a
// confirmed reveal that the fold refuses leaves 'mint-rejected', never a bridge that reads as arrived.
// Only 'start' (the settle) and 'covered'->'mint-signed' (the Bitcoin-side signing) need the wallet key;
// every other transition is a poll or a pure rebuild from already-journalled public data.
//
// Unlike burn-deposit, a crossOut's Bitcoin-side claim has no persisted retry inside the protocol if the
// worker's eth-state view is behind -- fold_crossout checks membership once, at scan time (see
// dapp/crossout-broadcast.js's header comment). The 'covered' gate below is what stands in for that: it
// blocks the mint from broadcasting until GET /reflection/eth-state/covers confirms the settle's own block is
// in view, so the claim is never revealed before it can fold.
import { makeCrossoutMintReveal } from './crossout-mint-reveal.js';
import { makeBtcWallet } from './bitcoin-taproot-wallet.js';

export const CROSSOUT_BETA_CAP_RAW = 100_000_000_000n; // 1,000 TAC at 8 decimals -- matches burndep-ux's own beta cap
export const CROSSOUT_TETH_CAP_RAW = 500_000n;         // 0.005 tETH at 8 decimals: one bridge's most while this is in beta
export const CROSSOUT_TETH_MIN_RAW = 100_000n;         // 0.001 tETH: under this the Bitcoin fees and the relay fee are most of what moves
// The mint is sent hours after the burn, whatever Bitcoin's fees are by then: above this rate (sat/vB) it waits, until the
// holder says to send it anyway. A mint is about 290 vB, so this caps what an unattended send can cost at ~29,000 sats.
export const CROSSOUT_MINT_FEE_CEILING = 100;
const JOURNAL_PREFIX = 'tacit-crossout-bridge-v1';
const LEASE_TTL_MS = 30_000;

const stripHex = (h) => String(h).replace(/^0x/, '');
const withHex = (h) => (String(h).startsWith('0x') ? String(h) : '0x' + String(h));
const lc = (h) => String(h).toLowerCase();
const now = () => Date.now();
// 8-decimal units to words: 100000000000 -> "1,000", 5000000 -> "0.05".
function units8(raw) {
  const v = BigInt(raw), whole = (v / 100_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','), frac = (v % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
function hexToBytesLocal(h) { const s = String(h).replace(/^0x/, ''); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; }
function bytesToHexLocal(b) { return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }

// Real localStorage exposes .length/.key(i) alongside getItem/setItem/removeItem; a plain wrapper around it
// must forward those too, or isReserved's cross-wallet scan silently sees nothing (see burndep-ux.js's
// identical comment on its own defaultStorage).
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

const BIG_FIELDS = ['amount', 'blinding', 'value', 'fee'];
function serializeRecord(rec) {
  return JSON.stringify(rec, (k, v) => (typeof v === 'bigint' ? (BIG_FIELDS.includes(k) ? { __big: v.toString() } : v.toString()) : v));
}
function deserializeRecord(text) {
  return JSON.parse(text, (k, v) => (v && typeof v === 'object' && typeof v.__big === 'string' ? BigInt(v.__big) : v));
}

// deps: { network, hrp, workerBase, fetchImpl, storage, secp, hmac, sha256, crossOut, pool, rpc, evmLog,
//         tacAssetId, assets, chain: {getUtxos, pickSafeCommitSats, broadcastWithRetry, getFeeRate}, postHint }
// `assets` ([{ assetId, ticker, capRaw, minRaw? }]) names every asset this module will bridge, each with its own
// per-bridge cap; left out, it is TAC alone under CROSSOUT_BETA_CAP_RAW. A note of any other asset is refused
// before anything is settled, and so is a recovered settle that names one.
// `poolAddress` (the pool whose CrossOutRecorded events settle a bridge) lets a bridge whose page closed before its
// settle was seen find that settle again; without it such a record just waits.
// `crossOut`, `pool`, `rpc`, `evmLog` are the confidential pool ux's own (dapp/confidential-pool-ux.js) --
// injected rather than re-instantiated here, matching how burndep-ux.js takes `bridgeMint`/`pool` from the
// same pool ux singleton instead of building its own. `postHint` is optional (tacit.js's local fast-track
// poke at the worker's /hint route) -- a fold happens on the worker's own scan cadence regardless.
export function makeCrossoutUx(deps) {
  const {
    network = 'mainnet', hrp = 'bc', workerBase, fetchImpl, storage: storageIn = null,
    secp, hmac, sha256, crossOut, pool, rpc, evmLog, tacAssetId, assets: assetsIn = null, chain, postHint = null, feeCeiling = CROSSOUT_MINT_FEE_CEILING, poolAddress = null,
  } = deps || {};
  for (const [k, v] of Object.entries({ workerBase, secp, hmac, sha256, crossOut, pool, rpc, evmLog, chain })) {
    if (v == null) throw new Error(`crossout-ux: deps.${k} required`);
  }
  const ASSETS = (assetsIn || (tacAssetId ? [{ assetId: tacAssetId, ticker: 'TAC', capRaw: CROSSOUT_BETA_CAP_RAW }] : [])).map((a) => ({ ...a, assetId: withHex(a.assetId), capRaw: BigInt(a.capRaw), minRaw: BigInt(a.minRaw || 0) }));
  if (!ASSETS.length) throw new Error('crossout-ux: deps.tacAssetId or deps.assets required');
  const assetOf = (id) => ASSETS.find((a) => lc(stripHex(a.assetId)) === lc(stripHex(id || ''))) || null;
  const storage = storageIn || defaultStorage();
  const mintReveal = makeCrossoutMintReveal({ secp });

  function freshPrims(walletPriv) {
    const w = makeBtcWallet({
      priv: walletPriv, hrp,
      fetchUtxos: async () => [], // never used: the funding UTXO this module signs with is already resolved
      broadcastTx: async (hex) => chain.broadcastWithRetry(hex),
      fetchFeeRate: async () => chain.getFeeRate('priority'),
    });
    return w.prims;
  }

  // ---- journal: one record per source note nullifier, keyed per (network, walletPub) ----
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

  // A cross-tab lease, not a hard lock -- see burndep-ux.js's identical comment on why a stale lease is
  // treated as free and why this is not what actually prevents a double-spend (the journal-before-broadcast
  // ordering is).
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

  // ---- eligibility (pure -- no network) ----
  // `note` shape: { nullifier, value (bigint|string), blinding (bigint|string), asset, confirmed (bool) } --
  // confidential-pool-ux.js's own note shape (balance()'s per-asset .notes array), unchanged: these notes
  // flow straight into crossOut() itself, which reads notes[0].asset the same way.
  function eligibleNotes(notes) {
    return (notes || []).map((n) => {
      const value = BigInt(n.value), a = assetOf(n.asset);
      let reason = null;
      if (!a) reason = ASSETS.length === 1 ? `not ${ASSETS[0].ticker}` : 'not an asset this bridge takes';
      else if (value > a.capRaw) reason = `over the ${units8(a.capRaw)} ${a.ticker} beta limit — send part of it to yourself first to split off a smaller note`;
      else if (value < a.minRaw) reason = `under the ${units8(a.minRaw)} ${a.ticker} minimum`;
      else if (n.confirmed === false) reason = 'unconfirmed';
      else if (isReserved(n.nullifier)) reason = 'already bridging';
      return { ...n, eligible: !reason, reason };
    });
  }

  // Scans every journal this storage holds under this module's prefix (not just one wallet's) -- the same
  // technique burndep-ux.js uses for its own reservation scan, since eligibleNotes is called before any one
  // wallet's pub is settled on as "the" pub, and a Bitcoin funding UTXO can be the same physical coin across
  // two different wallet imports even though a note's nullifier never is.
  function _anyRecordMatching(pred) {
    try {
      const len = storage.length; const key = storage.key;
      if (typeof len !== 'number' || typeof key !== 'function') return false;
      const prefix = `${JOURNAL_PREFIX}:${network}:`;
      for (let i = 0; i < len; i++) {
        const k = key.call(storage, i);
        if (!k || !k.startsWith(prefix)) continue;
        const list = deserializeRecord(storage.getItem(k));
        if (Array.isArray(list) && list.some((r) => r.stage !== 'minted' && pred(r))) return true;
      }
    } catch { /* a corrupt entry is treated as unreserved */ }
    return false;
  }
  function isReserved(nullifier) {
    return _anyRecordMatching((r) => r.id === nullifier);
  }
  // Whether `txid:vout` is some in-flight record's own Bitcoin-side funding UTXO (the 'covered'->'mint-signed'
  // stage's pickFundingUtxo pick) -- checked from tacit.js's own getUtxos filter, mirroring _burndepReserved,
  // so ordinary coin selection elsewhere can never spend out from under an in-flight mint.
  function isFundingReserved(txid, vout) {
    const id = `${stripHex(txid).toLowerCase()}:${Number(vout)}`;
    return _anyRecordMatching((r) => r.mint && r.mint.fundingUtxo && `${stripHex(r.mint.fundingUtxo.txid).toLowerCase()}:${Number(r.mint.fundingUtxo.vout)}` === id);
  }

  // ---- start: settles the note on Ethereum (bridge_burn) and derives the self-bridge destination ----
  // The Bitcoin note a settle of `amount` makes for this key: its blinding is bound to the spent note's nullifier (see
  // crossOut()'s rDest), so it is the same every time from (walletPriv, nullifier, amount) and never stored.
  function deriveDest(walletPriv, nullifier, amount, assetId, destXonly) {
    const privBytes = walletPriv instanceof Uint8Array ? walletPriv : hexToBytesLocal(stripHex(walletPriv));
    const domain = new TextEncoder().encode('tacit-crossout-blinding-v1');
    const nullifierBytes = hexToBytesLocal(stripHex(nullifier));
    const msg = new Uint8Array(domain.length + nullifierBytes.length);
    msg.set(domain); msg.set(nullifierBytes, domain.length);
    const raw = hmac(sha256, privBytes, msg);
    let b = 0n; for (const x of raw) b = (b << 8n) | BigInt(x);
    b %= secp.CURVE.n;
    const { cx, cy } = pool.commitXY(BigInt(amount), b === 0n ? 1n : b);
    return { cx, cy, destCommitment: pool.btcNoteLeaf(withHex(assetId), cx, cy, withHex(destXonly)) };
  }

  // A settle found on Ethereum, from its CrossOutRecorded event and the receipt that carries it: the 'settled' record it
  // is. `amount` is what arrives on Bitcoin; the caller has already checked it against the event's destCommitment.
  function settledRecord({ id, walletPub, a, amount, fee = null, value = null, destXonly, dest, ev, txHash, ethBlock, note, createdAt = now(), recovered = false }) {
    return {
      id, network, walletPub: bytesToHexLocal(walletPub), stage: 'settled', createdAt, ...(recovered ? { recoveredAt: now() } : {}),
      source: { nullifier: id, value: value != null ? BigInt(value) : BigInt(amount), amount: BigInt(amount), ...(fee != null ? { fee: BigInt(fee) } : {}), assetId: a.assetId, ticker: a.ticker },
      destXonly,
      settle: { txHash: stripHex(txHash), claimId: ev.claimId, cx: dest.cx, cy: dest.cy, destCommitment: ev.destCommitment, ethBlock, claimIdVerified: true, claimIdNote: note },
    };
  }

  // A bridge that was started but whose settle this page never saw land (it closed, the relay timed out, the send was
  // refused) is looked for on Ethereum: its spent note's nullifier, or the destination it would have made, in a
  // CrossOutRecorded event of the pool since the block it began at. Found, it becomes an ordinary settled record. The
  // fees tried are kept because an earlier, slower attempt can still land after a later one was sent.
  async function reconcile(rec) {
    if (rec.stage !== 'settling') return rec;
    if (!poolAddress || rec.startBlock == null) return rec;
    const a = assetOf(rec.source.assetId);
    if (!a) return rec;
    const head = Number(BigInt(await rpc('eth_blockNumber', [])));
    const walletPub = hexToBytesLocal(rec.walletPub);
    const tried = (rec.source.attempts || [rec.source.fee]).map((f) => BigInt(f));
    const wanted = new Map(tried.map((f) => [lc(deriveDestFor(rec, rec.source.value - f).destCommitment), f]));
    for (let from = Math.max(0, rec.startBlock - 2); from <= head; from += 5000) {
      const logs = await rpc('eth_getLogs', [{ address: poolAddress, topics: [evmLog.TOPIC0.CrossOutRecorded], fromBlock: '0x' + from.toString(16), toBlock: '0x' + Math.min(head, from + 4999).toString(16) }]);
      for (const l of logs || []) {
        const ev = evmLog.decodeLog(l);
        if (!ev || ev.type !== 'CrossOutRecorded' || ev.destChain !== 1) continue;
        const f = wanted.get(lc(ev.destCommitment));
        if (f === undefined) {
          // Our note, spent into a destination we cannot account for: not a record this module can mint.
          if (lc(ev.nullifier) === lc(rec.id)) throw new Error('crossout-ux: this note was bridged, but to an amount this page did not ask for, so it cannot finish the Bitcoin step for it');
          continue;
        }
        const amount = rec.source.value - f;
        const settled = settledRecord({
          id: rec.id, walletPub, a, amount, fee: f, value: rec.source.value, destXonly: rec.destXonly, dest: deriveDestFor(rec, amount), ev,
          txHash: l.transactionHash, ethBlock: Number(BigInt(l.blockNumber)), note: 'found on Ethereum from the CrossOutRecorded event', createdAt: rec.createdAt,
        });
        return putRecord(settled);
      }
    }
    return rec;
  }
  // The destination for `amount`, for a record that has not kept the wallet key: its blinding needs that key, so a
  // record stores its candidate destinations (one per fee tried) when it is made and this reads them back.
  function deriveDestFor(rec, amount) {
    const d = (rec.dests || []).find((x) => BigInt(x.amount) === BigInt(amount));
    if (!d) throw new Error('crossout-ux: no destination was kept for that amount');
    return d;
  }

  // `fee` is the relay's cut of the note, taken in the note's own asset: the Bitcoin note is worth the note less it
  // (a bridge_burn makes no change, so the whole note is spent). 0 for a settle sent from the holder's own account.
  // `selfSettle` / `selfRelay` / `waitOpts` go straight to the pool's crossOut.
  async function start({ note, walletPriv, fee = 0n, selfRelay = false, selfSettle = null, waitOpts = undefined }) {
    const walletPub = secp.getPublicKey(walletPriv, true);
    const id = note.nullifier;
    const a = assetOf(note.asset);
    if (!a) throw new Error('crossout-ux: this asset cannot be bridged here');
    const earlier = getRecord(walletPub, id);
    if (earlier && earlier.stage !== 'settling') throw new Error('crossout-ux: a bridge already exists for this note');
    if (!earlier && isReserved(id)) throw new Error('crossout-ux: this note is already reserved by another bridge in progress');
    const value = BigInt(note.value); fee = BigInt(fee);
    if (value > a.capRaw) throw new Error('crossout-ux: over the beta cap');
    if (value < a.minRaw) throw new Error('crossout-ux: under the minimum');
    if (fee < 0n || fee >= value) throw new Error('crossout-ux: the relay fee must be under the note');

    const destXonly = bytesToHexLocal(freshPrims(walletPriv).wallet.xonly());
    const amount = value - fee;
    // The intent is journalled before the burn is sent. The relay proves a settle for minutes, and a page that closes or
    // stops waiting meanwhile finds the burn again from Ethereum on its next look and carries on from it.
    let startBlock = earlier ? earlier.startBlock : null;
    if (startBlock == null && poolAddress) startBlock = Number(BigInt(await rpc('eth_blockNumber', [])));
    const dests = [...(earlier ? earlier.dests : []).filter((d) => BigInt(d.amount) !== amount), { amount, ...deriveDest(walletPriv, id, amount, a.assetId, destXonly) }];
    const attempts = [...new Set([...(earlier ? earlier.source.attempts || [earlier.source.fee] : []), fee].map(String))];
    const intent = putRecord({
      id, network, walletPub: bytesToHexLocal(walletPub), stage: 'settling', createdAt: earlier ? earlier.createdAt : now(), startBlock, dests,
      source: { nullifier: id, value, amount, fee, attempts, assetId: a.assetId, ticker: a.ticker }, destXonly,
    });
    if (earlier) {
      // A previous attempt may have landed while this one was being made.
      const found = await reconcile({ ...intent, source: { ...intent.source, value } });
      if (found.stage !== 'settling') return found;
    }
    const r = await crossOut({
      walletPriv, notes: [note], amount, fee,
      destOwner: destXonly, destChain: 1, selfRelay, selfSettle, waitOpts,
    });
    const co = r.crossOuts && r.crossOuts[0];
    if (!co) throw new Error('crossout-ux: settle produced no crossOut claim');
    // The burn is done by now, so what the settle returned is what the Bitcoin step uses. That it equals the destination
    // worked out beforehand matters only to finding this bridge again from Ethereum, and is kept as a fact on the record.
    const mine = dests[dests.length - 1];

    const rec = {
      id, network, walletPub: bytesToHexLocal(walletPub), stage: 'settled', createdAt: intent.createdAt,
      source: { nullifier: id, value, amount, fee, assetId: a.assetId, ticker: a.ticker },
      destXonly,
      settle: {
        txHash: r.txHash || null, claimId: co.claimId, cx: co.cx, cy: co.cy, destCommitment: co.destCommitment,
        ethBlock: r.ethBlock, claimIdVerified: !!r.claimIdVerified, claimIdNote: r.claimIdNote,
        destAsExpected: lc(co.destCommitment) === lc(mine.destCommitment),
      },
    };
    return putRecord(rec);
  }

  // ---- advance: drive a record forward one stage. walletPriv is required only at 'covered'->'mint-signed'. ----
  async function advance(walletPub, id, { walletPriv = null, allowHighFee = false } = {}) {
    const rec = getRecord(walletPub, id);
    if (!rec) throw new Error(`crossout-ux: no bridge record for ${id}`);
    if (!tryAcquireLease(id)) throw new Error('crossout-ux: this bridge is being advanced in another tab right now');
    try {
      const fn = STAGE_ADVANCE[rec.stage];
      if (!fn) return rec; // terminal ('minted') or unknown -- nothing to do
      const result = await fn(rec, { walletPriv, allowHighFee });
      return rec.lastError ? putRecord({ ...result, lastError: null, errorCount: 0 }) : result;
    } catch (e) {
      // Only the error is written, onto the record as it is now: a copy read before the step began would undo whatever a
      // concurrent start() retry (its fee attempts, its destinations) wrote meanwhile.
      const cur = getRecord(walletPub, id) || rec;
      putRecord({ ...cur, lastError: { message: String((e && e.message) || e), at: now() }, errorCount: (cur.errorCount || 0) + 1 });
      throw e;
    } finally { releaseLease(id); }
  }

  // Picks one confirmed, safe-to-spend UTXO from `address` -- same pattern burndep-ux.js's pickFundingUtxo
  // uses (chain.pickSafeCommitSats does the actual filtering/sorting, this just takes its top pick).
  async function pickFundingUtxo(address) {
    const utxos = await chain.getUtxos(address);
    const sorted = await chain.pickSafeCommitSats(utxos);
    const pick = Array.isArray(sorted) ? sorted[0] : sorted;
    if (!pick) throw new Error('crossout-ux: no safe funding UTXO available at this address');
    return { txid: pick.txid, vout: pick.vout, value: pick.value };
  }

  // Read before anything is settled: a note burned on Ethereum can only arrive on Bitcoin, and arriving costs the
  // holder's own sats and needs Bitcoin's proof on Ethereum to keep up. `problems` stop a bridge from starting (no
  // sats free for its fees, or the proof's state unreadable, so the gate that protects the mint could not be asked
  // either); `warnings` are slower-than-usual conditions to show beside the receipt. A fee rate that rises in the hours
  // before the mint is signed is covered by asking for room for twice today's.
  // Each bridge of this key that has yet to sign its mint takes a coin of its own when it does (the top free one then), so
  // this one is checked against the coin after theirs: `pending` counts them, less the notes named in `exclude` (a bridge
  // being sent again). A signed mint's coin is already reserved and out of the list.
  async function preflight({ walletPriv, feeRate = null, exclude = [] } = {}) {
    const P = freshPrims(walletPriv), problems = [], warnings = [];
    const rate = Number(feeRate) || Number(await chain.getFeeRate('priority')) || 3;
    const needSats = mintReveal.estimateSats({ feeRate: Math.ceil(rate * 2), dust: P.DUST }), estSats = mintReveal.estimateSats({ feeRate: rate, dust: P.DUST });
    const address = P.wallet.address();
    const skip = new Set(exclude.map((x) => lc(x)));
    const pending = loadAll(secp.getPublicKey(walletPriv, true)).filter((r) => ['settling', 'settled', 'covered'].includes(r.stage) && !skip.has(lc(r.id))).length;
    let haveSats = 0, confirmed = false;
    try {
      const safe = await chain.pickSafeCommitSats(await chain.getUtxos(address));
      const coin = (Array.isArray(safe) ? safe : safe ? [safe] : [])[pending];
      if (coin) { haveSats = Number(coin.value) || 0; confirmed = !coin.status || coin.status.confirmed !== false; }
    } catch (e) { problems.push({ name: 'funding-unreadable', detail: String((e && e.message) || e) }); }
    if (!problems.length) {
      if (haveSats < needSats) problems.push({ name: 'funding', detail: haveSats ? `${haveSats} sats in the ${pending ? 'next' : 'largest'} free coin` : 'no free coin' });
      else if (!confirmed) problems.push({ name: 'funding-unconfirmed', detail: `${haveSats} sats, not yet confirmed` });
    }
    let reflection = null, coverage = null;
    try {
      const [st, head] = await Promise.all([callWorker('GET', '/reflection/status'), rpc('eth_blockNumber', [])]);
      const ethHead = Number(BigInt(head));
      if (!st || st.error || !Number.isFinite(Number(st.attestedHeight)) || !Number.isFinite(Number(st.tipHeight))) throw new Error('reflection status unreadable');
      reflection = { attestedHeight: Number(st.attestedHeight), tipHeight: Number(st.tipHeight), lagBlocks: Math.max(0, Number(st.tipHeight) - Number(st.attestedHeight)) };
      const cv = await callWorker('GET', `/reflection/eth-state/covers?block=${ethHead}`);
      if (!cv || cv.error) throw new Error('eth-state coverage unreadable');
      const best = Math.max(Number(cv.bestBlock) || 0, Number(cv.confirmedBlock) || 0);
      coverage = { ethHead, bestBlock: best || null, behindBlocks: best ? Math.max(0, ethHead - best) : null };
      if (reflection.lagBlocks > 144) warnings.push({ name: 'reflection-behind', detail: `${reflection.lagBlocks} Bitcoin blocks` });
      if (coverage.behindBlocks == null || coverage.behindBlocks > 1800) warnings.push({ name: 'coverage-behind', detail: coverage.behindBlocks == null ? 'no view yet' : `${coverage.behindBlocks} Ethereum blocks` });
    } catch (e) { problems.push({ name: 'proof-unreadable', detail: String((e && e.message) || e) }); }
    return { ok: problems.length === 0, problems, warnings, feeRate: rate, needSats, estSats, haveSats, pending, address, reflection, coverage };
  }

  const STAGE_ADVANCE = {
    settling: async (rec) => reconcile(rec),
    settled: async (rec) => {
      // completeCrossOutOnBitcoin (crossout-broadcast.js) refuses to broadcast an unverified claimId for
      // exactly this reason: a reveal built from a wrong claimId can never fold, with no on-chain error
      // anywhere to say so. crossOut() itself corroborates before returning, so this should normally already
      // be true -- surfacing it as a stuck, visible error (via advance()'s own lastError) rather than
      // silently retrying is the honest response to the rare case where it isn't.
      if (!rec.settle.claimIdVerified) {
        throw new Error(`crossout-ux: claimId not corroborated against the CrossOutRecorded event (${rec.settle.claimIdNote || 'unknown reason'}) — this bridge cannot proceed safely; contact support with this record's id`);
      }
      const covers = await callWorker('GET', `/reflection/eth-state/covers?block=${rec.settle.ethBlock}`);
      if (!covers || covers.covered !== true) return rec; // not yet -- resumable, matches burndep-ux's poll style
      return putRecord({ ...rec, stage: 'covered', coveredAt: now() });
    },
    covered: async (rec, { walletPriv, allowHighFee }) => {
      if (!walletPriv) throw new Error('crossout-ux: this stage needs the wallet key');
      const P = freshPrims(walletPriv);
      const feeRate = await chain.getFeeRate('priority');
      if (!allowHighFee && Number(feeRate) > feeCeiling) {
        throw new Error(`crossout-ux: Bitcoin fees are high right now (${Math.round(feeRate)} sat/vB), so the Bitcoin step is waiting for them to fall under ${feeCeiling}`);
      }
      const fundingUtxo = rec.mint && rec.mint.fundingUtxo ? rec.mint.fundingUtxo : await pickFundingUtxo(P.wallet.address());
      const built = mintReveal.buildCrossoutMintTxs({
        prims: P, assetId: withHex(rec.source.assetId), claimId: rec.settle.claimId, cx: rec.settle.cx, cy: rec.settle.cy,
        destXonly: rec.destXonly, fundingUtxo, feeRate,
      });
      return putRecord({
        ...rec, stage: 'mint-signed',
        mint: { commitHex: built.commitHex, commitTxid: built.commitTxid, revealHex: built.revealHex, revealTxid: built.revealTxid, feeRate: built.feeRate, fundingUtxo },
      });
    },
    'mint-signed': async (rec) => {
      await chain.broadcastWithRetry(rec.mint.commitHex);
      await chain.broadcastWithRetry(rec.mint.revealHex);
      if (postHint) { try { postHint(rec.mint.revealTxid, 0); } catch {} }
      return putRecord({ ...rec, stage: 'mint-submitted', submittedAt: now() });
    },
    'mint-submitted': async (rec) => {
      let tx;
      try { tx = await fetchChainJson(`/tx/${stripHex(rec.mint.revealTxid)}`); }
      catch { return rec; } // not found yet -- resumable
      if (!tx || !tx.status || !tx.status.confirmed) {
        // A duplicate broadcast of an already-known tx is a safe, explicit no-op.
        await chain.broadcastWithRetry(rec.mint.commitHex).catch(() => {});
        await chain.broadcastWithRetry(rec.mint.revealHex).catch(() => {});
        return rec;
      }
      return putRecord({ ...rec, stage: 'mint-confirmed', confirmedAt: now() });
    },
    // The reveal is on Bitcoin; the note is the bridge's only when the worker has credited it for this claim. That is
    // asked per (asset, claim, txid): `decided` once the scan is past the mint by the credit depth, `minted` only for
    // the tx recorded for the claim. Undecided or unreadable waits; decided and not minted is a refusal worth saying.
    'mint-confirmed': async (rec) => {
      // A reveal reorged out of its block is no longer confirmed: back to waiting for a confirmation (and re-sent if dropped).
      let tx = null;
      try { tx = await fetchChainJson(`/tx/${stripHex(rec.mint.revealTxid)}`); } catch { /* unreadable: keep waiting on the credit */ }
      if (tx && tx.status && tx.status.confirmed === false) return putRecord({ ...rec, stage: 'mint-submitted', confirmedAt: null });
      return checkCredited(rec);
    },
    'mint-rejected': async (rec) => checkCredited(rec),
  };
  async function checkCredited(rec) {
    let st;
    try {
      const q = `asset=${stripHex(rec.source.assetId)}&claim=${stripHex(rec.settle.claimId)}&txid=${stripHex(rec.mint.revealTxid)}`;
      st = await callWorker('GET', `/crossout/minted?${q}`);
    } catch { return rec; }
    if (!st || st.error || st.decided !== true) return rec;
    if (st.minted === true) return putRecord({ ...rec, stage: 'minted', mintedAt: now() });
    // Credited to another reveal of this same claim: an earlier pair of this bridge (signed again after one Bitcoin seemed
    // not to take). The note's leaf commits this key as its owner, so whichever reveal was credited made this key's note.
    if (st.mintedTxid) return putRecord({ ...rec, stage: 'minted', mintedAt: now(), creditedTxid: String(st.mintedTxid) });
    if (rec.stage === 'mint-rejected') return rec;
    return putRecord({ ...rec, stage: 'mint-rejected', rejectedAt: now(), rejectedStatus: st.status || null });
  }

  async function callWorker(method, path, body) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!f) throw new Error('crossout-ux: no fetch implementation');
    const url = `${workerBase}${path}${path.includes('?') ? '&' : '?'}network=${network}`;
    const res = await f(url, method === 'GET' ? undefined : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  }
  function fetchChainJson(path) { return callWorker('GET', `/chain${path}`); }
  // Whether a transaction is on Bitcoin (mined or in a mempool): 'present', 'absent' only on an explicit not-found, and
  // 'unknown' for anything else, a rate limit or an outage included -- a transport failure is never read as absence.
  async function chainTxState(txid) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!f) return 'unknown';
    try {
      const res = await f(`${workerBase}/chain/tx/${stripHex(txid)}?network=${network}`);
      if (res.status === 404) return 'absent';
      if (!res.ok) return 'unknown';
      const j = await res.json().catch(() => null);
      if (j && j.status) return 'present';
      return j && j.error === 'not-found' ? 'absent' : 'unknown';
    } catch { return 'unknown'; }
  }

  // Gives up a bridge that was started and never seen to settle -- after the chain has been looked at once more and shows
  // no settle for it. One that had landed is returned as the settled record it is; a burn the relay finishes after this
  // is found again from its Ethereum transaction (recoverFromEthTx).
  async function cancelIntent(walletPub, id) {
    const rec = getRecord(walletPub, id);
    if (!rec) return null;
    if (rec.stage !== 'settling') throw new Error('crossout-ux: only a bridge that has not settled can be cancelled');
    if (!poolAddress || rec.startBlock == null) throw new Error('crossout-ux: this bridge cannot be checked against Ethereum, so it was not cancelled');
    const after = await reconcile(rec);
    if (after.stage !== 'settling') return after;
    saveAll(walletPub, loadAll(walletPub).filter((r) => r.id !== id));
    return null;
  }

  // A signed mint whose first transaction Bitcoin never took (its funding coin went elsewhere, or it was refused) is
  // signed again from a coin that is free now. Only while that transaction is not on the chain: the claim is the same,
  // and a second commit/reveal pair for it costs a fee at worst (fold_crossout takes the first and ignores the rest).
  async function resign(walletPub, id) {
    const rec = getRecord(walletPub, id);
    if (!rec) throw new Error(`crossout-ux: no bridge record for ${id}`);
    if (rec.stage !== 'mint-signed' || !rec.mint) throw new Error('crossout-ux: only a signed mint that has not been sent can be signed again');
    const seen = await chainTxState(rec.mint.commitTxid);
    if (seen === 'unknown') throw new Error('crossout-ux: could not check whether its first transaction is on Bitcoin, so it was not signed again');
    if (seen === 'present') throw new Error('crossout-ux: its first transaction is already on Bitcoin, so it will go on by itself');
    const { mint, lastError, errorCount, ...rest } = rec;
    return putRecord({ ...rest, stage: 'covered', lastError: null, errorCount: 0 });
  }

  function list(walletPub) { return loadAll(walletPub); }
  function abandon(walletPub, id) { saveAll(walletPub, loadAll(walletPub).filter((r) => r.id !== id)); }

  // Recovers a bridge from just its Ethereum settle tx hash and the wallet key -- the case where the journal
  // itself is gone (a different browser/device, or cleared storage) but the settle already happened, so
  // everything else is derivable from chain data + this wallet's own deterministic derivations:
  //   - CrossOutRecorded's own `nullifier` field is the spent note's nullifier (crossOut's bindNullifier),
  //     read directly off the log rather than guessed;
  //   - the destination blinding is HMAC-bound to that nullifier (see start()'s destXonly comment and
  //     crossOut()'s own rDest derivation in confidential-pool-ux.js) -- reproducible from (walletPriv,
  //     nullifier) alone, never stored;
  //   - destXonly is always this wallet's own Bitcoin key (v1 is self-bridge only), so it needs no source at
  //     all beyond walletPriv.
  // `amount` (what arrives on Bitcoin: the note less any relay fee) is the one thing NOT recoverable from chain data (the value is hidden under the commitment) --
  // same shape as burndep-ux.js's recoverFromTxid needing `amount` for the identical reason. The recomputed
  // (cx, cy) are checked against the event's own destCommitment before anything is journalled; a wrong amount
  // (or any other wrong input) makes that check fail rather than silently writing an unopenable record.
  //
  // Always rebuilds at 'settled', even if the Bitcoin-side mint was already broadcast before the journal was
  // lost -- there is no way to ask the chain "has this claimId already been revealed" directly. Worst case,
  // advancing the recovered record re-broadcasts a second, redundant commit/reveal pair: fold_crossout's own
  // replay gate takes the first one and ignores the second, so this costs a small avoidable Bitcoin fee, not a
  // double mint. Same category of limitation as burndep-ux.js's own recoverFromTxid not recovering a bridge
  // stuck before its burn exists -- stated here rather than engineered around under this rare edge case.
  async function recoverFromEthTx(settleTxHash, walletPriv, { amount } = {}) {
    if (amount == null) throw new Error('crossout-ux: recoverFromEthTx needs { amount } -- the value that arrives on Bitcoin, the note less any relay fee (not recoverable from chain data alone)');
    const walletPub = secp.getPublicKey(walletPriv, true);
    const receipt = await rpc('eth_getTransactionReceipt', [settleTxHash]);
    if (!receipt) throw new Error('crossout-ux: no receipt for this transaction hash (not yet mined, or wrong network)');
    const ethBlock = receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : null;
    const events = (receipt.logs || []).filter((l) => !poolAddress || String(l.address || '').toLowerCase() === String(poolAddress).toLowerCase())
      .map((l) => evmLog.decodeLog(l)).filter((e) => e && e.type === 'CrossOutRecorded');
    if (!events.length) throw new Error('crossout-ux: this transaction carries no CrossOutRecorded event');
    if (events.length > 1) throw new Error('crossout-ux: this transaction recorded more than one crossOut -- recovery only handles the single-note case this module itself ever produces');
    const ev = events[0];
    const a = assetOf(ev.assetId);
    if (!a) throw new Error('crossout-ux: this crossOut is for a different asset');

    const destXonly = bytesToHexLocal(freshPrims(walletPriv).wallet.xonly());
    const dest = deriveDest(walletPriv, ev.nullifier, amount, a.assetId, destXonly);
    if (lc(dest.destCommitment) !== lc(ev.destCommitment)) {
      throw new Error('crossout-ux: recomputed destCommitment does not match the event -- wrong amount, wrong wallet key, or this settle used an explicit non-default blinding recovery cannot reproduce');
    }

    // A bridge this module already follows past 'settled' is left as it is: this would drop its signed mint and the coin
    // it reserved, and sign a second pair. Only a record still waiting to settle, or one whose claim was never matched to
    // the event (the 'check it again' case), is replaced.
    const existing = getRecord(walletPub, ev.nullifier);
    if (existing && existing.stage !== 'settling' && existing.settle && existing.settle.claimIdVerified !== false) return existing;
    const rec = settledRecord({
      id: ev.nullifier, walletPub, a, amount, destXonly, dest, ev, txHash: settleTxHash, ethBlock,
      note: 'recovered from the CrossOutRecorded event directly', recovered: true,
    });
    return putRecord(rec);
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

  return { CROSSOUT_BETA_CAP_RAW, network, assets: ASSETS, assetOf, eligibleNotes, isReserved, isFundingReserved, preflight, start, advance, resign, cancelIntent, recoverFromEthTx, resumeAll, list, abandon };
}
