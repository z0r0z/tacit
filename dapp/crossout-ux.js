import { makeCrossoutMintReveal } from './crossout-mint-reveal.js';
import { makeBtcWallet } from './bitcoin-taproot-wallet.js';
import { makeBtcBind } from './btc-bind.js';

export const CROSSOUT_BETA_CAP_RAW = 100_000_000_000n;
export const CROSSOUT_TETH_CAP_RAW = 50_000_000n;
export const CROSSOUT_TETH_MIN_RAW = 100_000n;           // 0.001 tETH while the bridge is new: small enough to try, and a bridge must still exceed its relay fee
export const CROSSOUT_CBTC_CAP_RAW = 50_000_000n;
export const CROSSOUT_CBTC_MIN_RAW = 1_000n;
export const CROSSOUT_CUSD_CAP_RAW = 100_000_000_000n;    // 1,000 cUSD while the bridge is new
export const CROSSOUT_CUSD_MIN_RAW = 1_000_000_000n;      // 10 cUSD: a bridge must still exceed its relay fee
export const CROSSOUT_MINT_FEE_CEILING = 100;
// How many times a burn's Bitcoin step is sent before the record stops offering it again: the first, and two more.
export const CROSSOUT_MAX_MINT_ATTEMPTS = 3;
const CANCEL_SPENT_AFTER_MS = 6 * 3600e3;
const JOURNAL_PREFIX = 'tacit-crossout-bridge-v1';
const LEASE_TTL_MS = 30_000;

const stripHex = (h) => String(h).replace(/^0x/, '');
const withHex = (h) => (String(h).startsWith('0x') ? String(h) : '0x' + String(h));
const lc = (h) => String(h).toLowerCase();
const now = () => Date.now();
function units8(raw) {
  const v = BigInt(raw), whole = (v / 100_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','), frac = (v % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
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

const BIG_FIELDS = ['amount', 'blinding', 'value', 'fee'];
function serializeRecord(rec) {
  return JSON.stringify(rec, (k, v) => (typeof v === 'bigint' ? (BIG_FIELDS.includes(k) ? { __big: v.toString() } : v.toString()) : v));
}
function deserializeRecord(text) {
  return JSON.parse(text, (k, v) => (v && typeof v === 'object' && typeof v.__big === 'string' ? BigInt(v.__big) : v));
}

export function makeCrossoutUx(deps) {
  const {
    network = 'mainnet', hrp = 'bc', workerBase, fetchImpl, storage: storageIn = null,
    secp, hmac, sha256, crossOut, pool, rpc, evmLog, tacAssetId, assets: assetsIn = null, chain, postHint = null, feeCeiling = CROSSOUT_MINT_FEE_CEILING, poolAddress = null, deployBlock = 0, nullifierSpent = null,
    // a bridge that arrives ready for Ethereum: Tacit's transfer codec (adaptor-btc-tx.js tacitKit) and the pool's chain binding
    bindKit = null, bindTarget = null,
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
      fetchUtxos: async () => [],
      broadcastTx: async (hex) => chain.broadcastWithRetry(hex),
      fetchFeeRate: async () => chain.getFeeRate('priority'),
    });
    return w.prims;
  }

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
    } catch { }
    return false;
  }
  function isReserved(nullifier) {
    return _anyRecordMatching((r) => r.id === nullifier);
  }
  function isFundingReserved(txid, vout) {
    const id = `${stripHex(txid).toLowerCase()}:${Number(vout)}`;
    return _anyRecordMatching((r) => r.mint && r.mint.fundingUtxo && `${stripHex(r.mint.fundingUtxo.txid).toLowerCase()}:${Number(r.mint.fundingUtxo.vout)}` === id);
  }

  function destBlinding(walletPriv, nullifier) {
    const privBytes = walletPriv instanceof Uint8Array ? walletPriv : hexToBytesLocal(stripHex(walletPriv));
    const domain = new TextEncoder().encode('tacit-crossout-blinding-v1');
    const nullifierBytes = hexToBytesLocal(stripHex(nullifier));
    const msg = new Uint8Array(domain.length + nullifierBytes.length);
    msg.set(domain); msg.set(nullifierBytes, domain.length);
    const raw = hmac(sha256, privBytes, msg);
    let b = 0n; for (const x of raw) b = (b << 8n) | BigInt(x);
    b %= secp.CURVE.n;
    return b === 0n ? 1n : b;
  }
  function deriveDest(walletPriv, nullifier, amount, assetId, destXonly) {
    const { cx, cy } = pool.commitXY(BigInt(amount), destBlinding(walletPriv, nullifier));
    return { cx, cy, destCommitment: pool.btcNoteLeaf(withHex(assetId), cx, cy, withHex(destXonly)) };
  }

  function settledRecord({ id, walletPub, a, amount, fee = null, value = null, destXonly, dest, ev, txHash, ethBlock, note, createdAt = now(), recovered = false }) {
    return {
      id, network, walletPub: bytesToHexLocal(walletPub), stage: 'settled', createdAt, ...(recovered ? { recoveredAt: now() } : {}),
      source: { nullifier: id, value: value != null ? BigInt(value) : BigInt(amount), amount: BigInt(amount), ...(fee != null ? { fee: BigInt(fee) } : {}), assetId: a.assetId, ticker: a.ticker },
      destXonly,
      settle: { txHash: stripHex(txHash), claimId: ev.claimId, cx: dest.cx, cy: dest.cy, destCommitment: ev.destCommitment, ethBlock, claimIdVerified: true, claimIdNote: note },
    };
  }

  // Where this page last finished looking for a burn's settle without finding it, per intent (and the fees it has tried): the next look resumes a little
  // before that instead of reading every block since the intent again, which an intent left unsettled would do on every pass for as long as it stays.
  // Kept in this page's memory only, so a reload looks from the start once. The overlap (about three hours of blocks, one read) is for a node whose logs run
  // behind its head. A look that decides something (a burn started again for a note, a bridge cancelled) is made over all the blocks, whatever was seen before.
  const scannedTo = new Map(), RESCAN_BLOCKS = 1000;
  async function reconcile(rec, { full = false } = {}) {
    if (rec.stage !== 'settling') return rec;
    if (!poolAddress || rec.startBlock == null) return rec;
    const a = assetOf(rec.source.assetId);
    if (!a) return rec;
    const head = Number(BigInt(await rpc('eth_blockNumber', [])));
    const walletPub = hexToBytesLocal(rec.walletPub);
    const tried = (rec.source.attempts || [rec.source.fee]).map((f) => BigInt(f));
    const wanted = new Map(tried.map((f) => [lc(deriveDestFor(rec, rec.source.value - f).destCommitment), f]));
    const mark = `${rec.id}:${tried.length}`, resume = full ? null : scannedTo.get(mark);
    for (let from = Math.max(0, rec.startBlock - 2, resume != null ? resume - RESCAN_BLOCKS : 0); from <= head; from += 5000) {
      const logs = await rpc('eth_getLogs', [{ address: poolAddress, topics: [evmLog.TOPIC0.CrossOutRecorded], fromBlock: '0x' + from.toString(16), toBlock: '0x' + Math.min(head, from + 4999).toString(16) }]);
      for (const l of logs || []) {
        const ev = evmLog.decodeLog(l);
        if (!ev || ev.type !== 'CrossOutRecorded' || ev.destChain !== 1) continue;
        const f = wanted.get(lc(ev.destCommitment));
        if (f === undefined) {
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
    scannedTo.set(mark, head);
    return rec;
  }
  function deriveDestFor(rec, amount) {
    const d = (rec.dests || []).find((x) => BigInt(x.amount) === BigInt(amount));
    if (!d) throw new Error('crossout-ux: no destination was kept for that amount');
    return d;
  }

  async function start({ note, walletPriv, fee = 0n, selfRelay = false, selfSettle = null, waitOpts = undefined, ready = false }) {
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
    // ready: the note it mints on Bitcoin is bound to the pool right after, so it can come back by the fast lane (TAC only)
    const bindOnArrival = !!ready && !!bindKit && !!bindTarget && a.ticker === 'TAC';

    const destXonly = bytesToHexLocal(freshPrims(walletPriv).wallet.xonly());
    const amount = value - fee;
    let startBlock = earlier ? earlier.startBlock : null;
    if (startBlock == null && poolAddress) startBlock = Number(BigInt(await rpc('eth_blockNumber', [])));
    const dests = [...(earlier ? earlier.dests : []).filter((d) => BigInt(d.amount) !== amount), { amount, ...deriveDest(walletPriv, id, amount, a.assetId, destXonly) }];
    const attempts = [...new Set([...(earlier ? earlier.source.attempts || [earlier.source.fee] : []), fee].map(String))];
    const intent = putRecord({
      id, network, walletPub: bytesToHexLocal(walletPub), stage: 'settling', createdAt: earlier ? earlier.createdAt : now(), startBlock, dests,
      source: { nullifier: id, value, amount, fee, attempts, assetId: a.assetId, ticker: a.ticker }, destXonly, ...(bindOnArrival ? { ready: true } : {}),
    });
    if (!getRecord(walletPub, id)) throw new Error('crossout-ux: this browser cannot keep the bridge record (its storage is blocked), so nothing was burned');
    if (earlier) {
      const found = await reconcile({ ...intent, source: { ...intent.source, value } }, { full: true });
      if (found.stage !== 'settling') return found;
    }
    const r = await crossOut({
      walletPriv, notes: [note], amount, fee,
      destOwner: destXonly, destChain: 1, selfRelay, selfSettle, waitOpts,
    });
    const co = r.crossOuts && r.crossOuts[0];
    if (!co) throw new Error('crossout-ux: settle produced no crossOut claim');
    const mine = dests[dests.length - 1];

    const rec = {
      id, network, walletPub: bytesToHexLocal(walletPub), stage: 'settled', createdAt: intent.createdAt,
      source: { nullifier: id, value, amount, fee, assetId: a.assetId, ticker: a.ticker },
      destXonly, ...(bindOnArrival ? { ready: true } : {}),
      settle: {
        txHash: r.txHash || null, claimId: co.claimId, cx: co.cx, cy: co.cy, destCommitment: co.destCommitment,
        ethBlock: r.ethBlock, claimIdVerified: !!r.claimIdVerified, claimIdNote: r.claimIdNote,
        destAsExpected: lc(co.destCommitment) === lc(mine.destCommitment),
      },
    };
    return putRecord(rec);
  }

  const inFlight = new Set();
  // A busy or unreachable service (429, 5xx, no network) is an outage to wait out, not one of the page's few tries: the row still says what failed, and
  // the next try comes after the usual rest, but the count that ends the page's automatic tries does not move.
  const passing = (e) => { const st = Number(e && e.status); return st === 429 || st >= 500 || /failed to fetch|networkerror|load failed|timed? ?out|aborted|\b(?:API|HTTP|status)\s*(?:429|5\d\d)\b|\((?:429|5\d\d)\)/i.test(String((e && e.message) || e)); };
  async function advance(walletPub, id, { walletPriv = null, allowHighFee = false } = {}) {
    const rec = getRecord(walletPub, id);
    if (!rec) throw new Error(`crossout-ux: no bridge record for ${id}`);
    if (walletPriv && lc(bytesToHexLocal(secp.getPublicKey(walletPriv, true))) !== lc(rec.walletPub)) throw new Error('crossout-ux: this bridge belongs to another key');
    if (inFlight.has(id)) throw new Error('crossout-ux: this bridge is being advanced in this page right now');
    if (!tryAcquireLease(id)) throw new Error('crossout-ux: this bridge is being advanced in another tab right now');
    inFlight.add(id);
    try {
      const fn = STAGE_ADVANCE[rec.stage];
      if (!fn) return rec;
      const result = await fn(rec, { walletPriv, allowHighFee });
      return rec.lastError ? putRecord({ ...result, lastError: null, errorCount: 0 }) : result;
    } catch (e) {
      const cur = getRecord(walletPub, id) || rec;
      const waiting = !!(e && e.feeWait), funding = !!(e && e.fundWait);
      putRecord({ ...cur,
        lastError: { message: String((e && e.message) || e), at: now(), ...(waiting ? { feeWait: true } : {}), ...(funding ? { fundWait: true, needSats: e.needSats, haveSats: e.haveSats, address: e.address } : {}) },
        errorCount: (cur.errorCount || 0) + (waiting || funding || passing(e) ? 0 : 1) });
      throw e;
    } finally { inFlight.delete(id); releaseLease(id); }
  }

  // The Bitcoin step is paid from one plain coin of the key's own address. A bridge starts without one: the sats are only needed here,
  // hours after the burn, so a coin that is missing or too small is a wait (`fundWait`, not counted as a failure) that the page
  // retries and the row turns into a request, never an error that ends the tries.
  async function pickFundingUtxo(address, needSats) {
    const utxos = await chain.getUtxos(address);
    const sorted = await chain.pickSafeCommitSats(utxos);
    const pick = Array.isArray(sorted) ? sorted[0] : sorted;
    const haveSats = pick ? Number(pick.value) || 0 : 0;
    if (!pick || haveSats < needSats) {
      throw Object.assign(new Error(`crossout-ux: the Bitcoin step needs a free coin of ${needSats} sats at ${address}${pick ? `, the largest holds ${haveSats}` : ''}`), { fundWait: true, needSats, haveSats, address });
    }
    return { txid: pick.txid, vout: pick.vout, value: pick.value };
  }

  async function preflight({ walletPriv, feeRate = null, exclude = [] } = {}) {
    const P = freshPrims(walletPriv), problems = [], warnings = [];
    const rate = Number(feeRate) || Number(await chain.getFeeRate('priority')) || 3;
    const needSats = mintReveal.estimateSats({ feeRate: Math.ceil(rate * 2), dust: P.DUST }), estSats = mintReveal.estimateSats({ feeRate: rate, dust: P.DUST });
    const address = P.wallet.address();
    const skip = new Set(exclude.map((x) => lc(x)));
    const pending = loadAll(secp.getPublicKey(walletPriv, true)).filter((r) => ['settling', 'settled', 'covered'].includes(r.stage) && !skip.has(lc(r.id))).length;
    let haveSats = 0, confirmed = false, read = true;
    try {
      const safe = await chain.pickSafeCommitSats(await chain.getUtxos(address));
      const coin = (Array.isArray(safe) ? safe : safe ? [safe] : [])[pending];
      if (coin) { haveSats = Number(coin.value) || 0; confirmed = !coin.status || coin.status.confirmed !== false; }
    } catch (e) { warnings.push({ name: 'funding-unreadable', detail: String((e && e.message) || e) }); read = false; }
    // The coin pays the Bitcoin step, hours after the burn, so a bridge may start without it: these are warnings, not problems, and
    // the burn's row asks for the sats again when the step is due.
    if (read) {
      if (haveSats < needSats) warnings.push({ name: 'funding', detail: haveSats ? `${haveSats} sats in the ${pending ? 'next' : 'largest'} free coin` : 'no free coin' });
      else if (!confirmed) warnings.push({ name: 'funding-unconfirmed', detail: `${haveSats} sats, not yet confirmed` });
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
      if (!rec.settle.claimIdVerified) {
        throw new Error(`crossout-ux: claimId not corroborated against the CrossOutRecorded event (${rec.settle.claimIdNote || 'unknown reason'}) — this bridge cannot proceed safely; contact support with this record's id`);
      }
      const covers = await callWorker('GET', `/reflection/eth-state/covers?block=${rec.settle.ethBlock}`);
      if (!covers || covers.covered !== true) return rec;
      return putRecord({ ...rec, stage: 'covered', coveredAt: now() });
    },
    covered: async (rec, { walletPriv, allowHighFee }) => {
      if (!walletPriv) throw new Error('crossout-ux: this stage needs the wallet key');
      const P = freshPrims(walletPriv);
      const feeRate = await chain.getFeeRate('priority');
      if (!allowHighFee && Number(feeRate) > feeCeiling) {
        const cost = mintReveal.estimateSats({ feeRate: Math.ceil(Number(feeRate)), dust: P.DUST }).toLocaleString('en-US');
        throw Object.assign(new Error(`crossout-ux: Bitcoin fees are high right now (${Math.round(feeRate)} sat/vB, about ${cost} sats for this step), so it is waiting for them to fall under ${feeCeiling}`), { feeWait: true });
      }
      const needSats = mintReveal.estimateSats({ feeRate: Math.max(1, Number(feeRate) || 3), dust: P.DUST });
      const fundingUtxo = rec.mint && rec.mint.fundingUtxo ? rec.mint.fundingUtxo : await pickFundingUtxo(P.wallet.address(), needSats);
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
      const rv = await chainTx(rec.mint.revealTxid);
      if (rv.state === 'present' && rv.confirmed) return putRecord({ ...rec, stage: 'mint-confirmed', confirmedAt: now() });
      if (rv.state === 'unknown') return rec;
      const refused = [];
      for (const hex of [rec.mint.commitHex, rec.mint.revealHex]) {
        try { await chain.broadcastWithRetry(hex); } catch (e) { const m = String((e && e.message) || e); if (!/already|known|in block|in mempool/i.test(m)) refused.push(m); }
      }
      if (rv.state === 'absent' && refused.length) throw new Error(`crossout-ux: Bitcoin did not take the signed transactions again: ${refused[0].slice(0, 160)}`);
      return rec;
    },
    'mint-confirmed': async (rec, { walletPriv, allowHighFee } = {}) => {
      const rv = await chainTx(rec.mint.revealTxid);
      if (rv.state === 'absent' || (rv.state === 'present' && rv.confirmed === false)) return putRecord({ ...rec, stage: 'mint-submitted', confirmedAt: null });
      if (rec.ready && !(rec.bind && rec.bind.sent)) {
        if (!walletPriv) return rec;
        const credited = await checkCredited({ ...rec, stage: 'mint-confirmed' }, { store: false });
        if (credited.stage !== 'minted') return credited.stage === 'mint-rejected' ? putRecord(credited) : rec;
        return checkCredited(await bindArrived(rec, { walletPriv, allowHighFee }));
      }
      return checkCredited(rec);
    },
    'mint-rejected': async (rec) => checkCredited(rec),
  };
  async function checkCredited(rec, { store = true } = {}) {
    const keep = store ? putRecord : (r) => r;
    let st;
    try {
      const q = `asset=${stripHex(rec.source.assetId)}&claim=${stripHex(rec.settle.claimId)}&txid=${stripHex(rec.mint.revealTxid)}`;
      st = await callWorker('GET', `/crossout/minted?${q}`);
    } catch { return rec; }
    if (!st || st.error || st.decided !== true) return rec;
    if (st.minted === true) return keep({ ...rec, stage: 'minted', mintedAt: now() });
    if (st.mintedTxid) return keep({ ...rec, stage: 'minted', mintedAt: now(), creditedTxid: String(st.mintedTxid) });
    if (rec.stage === 'mint-rejected') return rec;
    return keep({ ...rec, stage: 'mint-rejected', rejectedAt: now(), rejectedStatus: st.status || null });
  }

  // The note a ready bridge minted, bound to the pool where it landed (btc-bind.js): one transfer from the key's Taproot address to
  // itself, signed by key path, so once the reflection has it the note moves back to Ethereum by the fast lane. Its opening is the
  // one the burn committed (destBlinding), checked against the minted commitment. The pair is kept before it is sent, and sent again
  // until Bitcoin has it.
  async function bindArrived(rec, { walletPriv, allowHighFee = false }) {
    if (rec.bind && rec.bind.revealHex && !rec.bind.sent) {
      await chain.broadcastWithRetry(rec.bind.commitHex);
      await chain.broadcastWithRetry(rec.bind.revealHex);
      return putRecord({ ...rec, bind: { ...rec.bind, sent: true, sentAt: now() } });
    }
    const P = freshPrims(walletPriv);
    const amount = BigInt(rec.source.amount), blinding = destBlinding(walletPriv, rec.id);
    const { cx, cy } = pool.commitXY(amount, blinding);
    if (lc(stripHex(cx)) !== lc(stripHex(rec.settle.cx)) || lc(stripHex(cy)) !== lc(stripHex(rec.settle.cy))) throw new Error('crossout-ux: the minted note does not open from this key, so it was not made ready');
    if (lc(rec.destXonly) !== lc(bytesToHexLocal(P.wallet.xonly()))) throw new Error('crossout-ux: the minted note is not at this key\'s Taproot address');
    const feeRate = await chain.getFeeRate('priority');
    if (!allowHighFee && Number(feeRate) > feeCeiling) throw Object.assign(new Error(`crossout-ux: Bitcoin fees are high right now (${Math.round(feeRate)} sat/vB), so making it ready waits for them to fall under ${feeCeiling}`), { feeWait: true });
    const satsUtxos = (await chain.pickSafeCommitSats(await chain.getUtxos(P.wallet.address()))).map((u) => ({ txid: u.txid, vout: u.vout, value: Number(u.value) }));
    const binder = makeBtcBind({ prims: P, kit: bindKit, target: bindTarget() });
    let pair;
    try {
      pair = binder.bindTransfer({ asset: hexToBytesLocal(stripHex(rec.source.assetId)), notes: [{ txid: stripHex(rec.mint.revealTxid), vout: 0, value: P.DUST, amount, blinding, taproot: true }], sizes: [amount], satsUtxos, feeRate: Math.max(1, Math.ceil(Number(feeRate) || 3)) });
    } catch (e) {
      if (/not enough sats/.test(String(e && e.message))) throw Object.assign(new Error(`crossout-ux: making it ready needs a free coin at ${P.wallet.address()}`), { fundWait: true, address: P.wallet.address() });
      throw e;
    }
    const kept = putRecord({ ...rec, bind: { commitHex: pair.commitHex, revealHex: pair.revealHex, commitTxid: pair.commitTxid, txid: pair.revealTxid, sent: false } });
    await chain.broadcastWithRetry(pair.commitHex);
    await chain.broadcastWithRetry(pair.revealHex);
    return putRecord({ ...kept, bind: { ...kept.bind, sent: true, sentAt: now() } });
  }

  async function callWorker(method, path, body) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!f) throw new Error('crossout-ux: no fetch implementation');
    const url = `${workerBase}${path}${path.includes('?') ? '&' : '?'}network=${network}`;
    const res = await f(url, method === 'GET' ? undefined : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  }
  function fetchChainJson(path) { return callWorker('GET', `/chain${path}`); }
  async function chainTx(txid) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!f) return { state: 'unknown' };
    try {
      const res = await f(`${workerBase}/chain/tx/${stripHex(txid)}?network=${network}`);
      if (res.status === 404) return { state: 'absent' };
      if (!res.ok) return { state: 'unknown' };
      const j = await res.json().catch(() => null);
      if (j && j.status) return { state: 'present', confirmed: j.status.confirmed === true };
      return { state: j && j.error === 'not-found' ? 'absent' : 'unknown' };
    } catch { return { state: 'unknown' }; }
  }
  const chainTxState = async (txid) => (await chainTx(txid)).state;

  async function cancelIntent(walletPub, id) {
    const rec = getRecord(walletPub, id);
    if (!rec) return null;
    if (rec.stage !== 'settling') throw new Error('crossout-ux: only a bridge that has not settled can be cancelled');
    if (!poolAddress || rec.startBlock == null) throw new Error('crossout-ux: this bridge cannot be checked against Ethereum, so it was not cancelled');
    const after = await reconcile(rec, { full: true });
    if (after.stage !== 'settling') return after;
    if (nullifierSpent) {
      let spent;
      try { spent = await nullifierSpent(id); } catch { throw new Error('crossout-ux: could not check whether this note was spent, so it was not cancelled'); }
      if (spent && now() - Number(rec.createdAt || now()) < CANCEL_SPENT_AFTER_MS) throw new Error('crossout-ux: this note has been spent on Ethereum, so its burn may have landed; it was not cancelled. If you bridged it, find it with its Ethereum transaction hash');
    }
    saveAll(walletPub, loadAll(walletPub).filter((r) => r.id !== id));
    return null;
  }

  async function resign(walletPub, id) {
    const rec = getRecord(walletPub, id);
    if (!rec) throw new Error(`crossout-ux: no bridge record for ${id}`);
    if ((rec.stage !== 'mint-signed' && rec.stage !== 'mint-submitted') || !rec.mint) throw new Error('crossout-ux: only a signed mint that Bitcoin does not have can be signed again');
    const seen = await chainTxState(rec.mint.commitTxid);
    if (seen === 'unknown') throw new Error('crossout-ux: could not check whether its first transaction is on Bitcoin, so it was not signed again');
    if (seen === 'present') throw new Error('crossout-ux: its first transaction is already on Bitcoin, so it will go on by itself');
    const { mint, lastError, errorCount, ...rest } = rec;
    return putRecord({ ...rest, stage: 'covered', lastError: null, errorCount: 0 });
  }

  // A Bitcoin step that confirmed and was not credited does not use the burn up: the proof folds a mint only when its commitment and key
  // are in the Ethereum cross-out set it carries, and a mint it skipped (scanned before the proof held this burn, or in a batch with no
  // Ethereum state) consumed no claim, so a second step for the same burn is folded like the first would have been. It is sent again from
  // the same record, over a coin that is free now, once the proof covers the burn (a second one sent earlier is skipped the same way),
  // and at most CROSSOUT_MAX_MINT_ATTEMPTS times, since each costs Bitcoin fees and a step that is refused for another reason is refused again.
  async function retryRejected(walletPub, id) {
    const rec = getRecord(walletPub, id);
    if (!rec) throw new Error(`crossout-ux: no bridge record for ${id}`);
    if (rec.stage !== 'mint-rejected' || !rec.mint) throw new Error('crossout-ux: only a Bitcoin step that confirmed and was not credited can be sent again');
    if (rec.settle && rec.settle.claimIdVerified === false) throw new Error('crossout-ux: this burn’s claim was not matched to its record on Ethereum, so its Bitcoin step is not sent again');
    const sent = (rec.attempts || []).length + 1;
    if (sent >= CROSSOUT_MAX_MINT_ATTEMPTS) throw new Error(`crossout-ux: this burn’s Bitcoin step has been sent ${sent} times without being credited, so it is not sent again here`);
    // The verdict may have moved on since it was read: a step the worker now credits ends the retry.
    const after = await checkCredited(rec);
    if (after.stage !== 'mint-rejected') return after;
    let covers;
    try { covers = await callWorker('GET', `/reflection/eth-state/covers?block=${rec.settle.ethBlock}`); } catch { covers = null; }
    if (!covers || covers.covered !== true) throw new Error('crossout-ux: Bitcoin’s proof does not cover this burn yet, and a Bitcoin step sent before it does is skipped the same way; try again once it does');
    const { mint, lastError, errorCount, rejectedAt, rejectedStatus, ...rest } = rec;
    return putRecord({
      ...rest, stage: 'covered', lastError: null, errorCount: 0, coveredAt: now(), retriedAt: now(),
      attempts: [...(rec.attempts || []), { commitTxid: mint.commitTxid, revealTxid: mint.revealTxid, rejectedAt: rejectedAt || null, status: rejectedStatus || null }],
    });
  }

  function list(walletPub) { return loadAll(walletPub); }
  function abandon(walletPub, id) { saveAll(walletPub, loadAll(walletPub).filter((r) => r.id !== id)); }

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
    let dest = deriveDest(walletPriv, ev.nullifier, amount, a.assetId, destXonly), fee = null, value = null;
    if (lc(dest.destCommitment) !== lc(ev.destCommitment)) {
      const burned = BigInt(amount);
      for (const f of feeLadder(burned)) {
        if (f === 0n) continue;
        const d = deriveDest(walletPriv, ev.nullifier, burned - f, a.assetId, destXonly);
        if (lc(d.destCommitment) === lc(ev.destCommitment)) { dest = d; fee = f; value = burned; amount = burned - f; break; }
      }
    }
    if (lc(dest.destCommitment) !== lc(ev.destCommitment)) {
      throw new Error('crossout-ux: recomputed destCommitment does not match the event -- wrong amount, wrong wallet key, or this settle used an explicit non-default blinding recovery cannot reproduce');
    }

    const existing = getRecord(walletPub, ev.nullifier);
    if (existing && existing.stage !== 'settling' && existing.settle && existing.settle.claimIdVerified !== false) return existing;
    const rec = settledRecord({
      id: ev.nullifier, walletPub, a, amount, fee, value, destXonly, dest, ev, txHash: settleTxHash, ethBlock,
      note: 'recovered from the CrossOutRecorded event directly', recovered: true,
    });
    let st = null;
    try { st = await callWorker('GET', `/crossout/minted?asset=${stripHex(a.assetId)}&claim=${stripHex(ev.claimId)}&txid=${'00'.repeat(32)}`); } catch { }
    return putRecord(st && !st.error && st.status === 'minted' ? { ...rec, stage: 'minted', mintedAt: now(), ...(st.mintedTxid ? { creditedTxid: String(st.mintedTxid) } : {}) } : rec);
  }


  function* feeLadder(value) {
    yield 0n;
    for (let scale = 1n; scale < value; scale *= 10n) for (let d = scale === 1n ? 1n : 10n; d <= 99n; d++) { const f = d * scale; if (f >= value) return; yield f; }
  }
  async function crossOutLogs(from, to) {
    if (from > to) return [];
    try {
      return (await rpc('eth_getLogs', [{ address: poolAddress, topics: [evmLog.TOPIC0.CrossOutRecorded], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }])) || [];
    } catch (e) {
      if (to - from < 1000) throw e;
      const mid = Math.floor((from + to) / 2);
      return [...await crossOutLogs(from, mid), ...await crossOutLogs(mid + 1, to)];
    }
  }
  async function recoverFromKey({ walletPriv, spent = [], skipClaims = [] } = {}) {
    if (!poolAddress) return [];
    const walletPub = secp.getPublicKey(walletPriv, true);
    const mine = new Map();
    for (const n of spent) { const a = assetOf(n.asset); if (a && !getRecord(walletPub, n.nullifier)) mine.set(lc(n.nullifier), { n, a }); }
    if (!mine.size) return [];
    const skip = new Set(skipClaims.map((c) => lc(c)));
    const head = Number(BigInt(await rpc('eth_blockNumber', [])));
    const events = [];
    for (let from = Number(deployBlock) || 0; from <= head; from += 20_000) {
      for (const l of await crossOutLogs(from, Math.min(head, from + 19_999))) {
        const ev = evmLog.decodeLog(l);
        const m = ev && ev.type === 'CrossOutRecorded' && ev.destChain === 1 ? mine.get(lc(ev.nullifier)) : null;
        if (m && lc(ev.assetId) === lc(m.a.assetId)) events.push({ ev, l, ...m });
      }
    }
    const destXonly = bytesToHexLocal(freshPrims(walletPriv).wallet.xonly());
    const made = [];
    for (const { ev, l, n, a } of events) {
      if (skip.has(lc(ev.claimId)) || getRecord(walletPub, ev.nullifier)) continue;
      const value = BigInt(n.value);
      let hit = null;
      for (const fee of feeLadder(value)) {
        const dest = deriveDest(walletPriv, ev.nullifier, value - fee, a.assetId, destXonly);
        if (lc(dest.destCommitment) === lc(ev.destCommitment)) { hit = { fee, dest }; break; }
      }
      if (!hit) continue;
      let st = null;
      try { st = await callWorker('GET', `/crossout/minted?asset=${stripHex(a.assetId)}&claim=${stripHex(ev.claimId)}&txid=${'00'.repeat(32)}`); } catch { }
      if (!st || st.error) continue;
      const rec = settledRecord({
        id: ev.nullifier, walletPub, a, amount: value - hit.fee, fee: hit.fee, value, destXonly, dest: hit.dest, ev, txHash: l.transactionHash,
        ethBlock: Number(BigInt(l.blockNumber)), note: 'found on Ethereum from this key\'s spent notes', recovered: true,
      });
      made.push(putRecord(st.status === 'minted' ? { ...rec, stage: 'minted', mintedAt: now(), ...(st.mintedTxid ? { creditedTxid: String(st.mintedTxid) } : {}) } : rec));
    }
    return made.filter((r) => r.stage !== 'minted');
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

  return { CROSSOUT_BETA_CAP_RAW, network, assets: ASSETS, assetOf, eligibleNotes, isReserved, isFundingReserved, preflight, start, advance, resign, retryRejected, cancelIntent, recoverFromEthTx, recoverFromKey, resumeAll, list, abandon };
}
