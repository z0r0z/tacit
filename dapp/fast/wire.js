// The fast bridge for a page that holds a Tacit key: the Bitcoin and pool sides built from the key and tacit.js, the client over
// them, the providers there are to bridge with, and the key's own provider. No DOM.
//
//   const s = await openFast({ T, withKey, ux, priv, pubHex, pins })                    bridging, with any provider
//   -> { address, notes(), balance(), quoteAll(providers, units), start({ quotes }), records(), run(), recover() }
//   const p = await openProvider({ T, withKey, ux, priv, pubHex, boards, settings })    providing, for anyone
//   -> { address, claimPub, inventory(), start(), stop(), status() }
//   const list = await discoverProviders({ providers, boards })                         who there is to bridge with
//
//   T  tacit.js with the key's wallet open     withKey(fn)  a call under that key (tacit-session.js)     ux  the pool module (trade/poolux.js)

import { makeBtcWallet } from '/bitcoin-taproot-wallet.js?cb=6e90dd96';
import { makeAdaptorBtcTx, tacitKit } from '/adaptor-btc-tx.js?cb=77320a94';
import { makeEsploraBtcChain } from '/fastbridge-btc.js?cb=94a5530b';
import { makeFastBridgeEvm } from '/fastbridge-evm.js?cb=7423f235';
import { makeHttpCounter, makeCounter } from '/fastbridge-http.js?cb=11295986';
import { makeFastBridgeMarket, makeLocalStore, termsOf } from '/fastbridge-client.js?cb=632a9387';
import { makeLpService } from '/fastbridge-provider.js?cb=8b3cb635';
import { makeMailboxCounter, makeMailboxServer, makeAdPublisher, readProviders, gatewayOf } from '/fastbridge-mailbox.js?cb=7f9e72e7';
import { makeBoardClient } from '/fastbridge-board-client.js?cb=850e1c5e';
import { signSchnorr } from '/bulletproofs.js?cb=132d3648';
import { makeBtcBind, openBoundNote, fastLaneNote, makePoolRoots } from '/btc-bind.js?cb=b686d883';
import { p2trAddress } from '/crossout-notes.js?cb=591df470';
import { secp, sha256, keccak_256, hmac, hexToBytes } from '/vendor/tacit-deps.min.js';

export const TAC_ASSET = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
export const EXPLORERS = ['https://mempool.space/api', 'https://blockstream.info/api'];
const enc = new TextEncoder();
const hmacSha256 = (k, m) => hmac(sha256, k, m);
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const TERMINAL = ['done', 'refunded', 'rejected', 'aborted', 'lost'];

// The key's confirmed TAC notes as the lock takes them.
export async function notesOf(T, asset = TAC_ASSET) {
  const h = await T.scanHoldings();
  const e = h instanceof Map ? h.get(asset) : null;
  return ((e && e.utxos) || [])
    .filter((x) => x.utxo && x.utxo.status && x.utxo.status.confirmed)
    .map((x) => ({ txid: x.utxo.txid, vout: x.utxo.vout, value: x.utxo.value, amount: BigInt(x.amount), blinding: BigInt(x.blinding) }));
}

// The notes a swap may spend. TAC that Bitcoin's proof tracks (`tracks`, note id -> 'tracked' | ...) also bridges directly, so a swap
// spends the other notes (one out of the shielded pool, or with a history the bridge does not follow) whenever `covers` says they alone do.
export function untrackedFirst(notes, tracks, covers) {
  if (!tracks) return notes;
  const rest = notes.filter((n) => tracks.get(`${n.txid}:${n.vout}`) !== 'tracked');
  return rest.length < notes.length && rest.length && covers(rest) ? rest : notes;
}

// The counter of a provider from the reference kept with its swaps: one that serves HTTP, or one reached through a board.
export function counterFor(ref, { fetchImpl = (...a) => fetch(...a), call = {} } = {}) {
  if (ref && ref.kind === 'http') return makeHttpCounter({ base: ref.base, fetchImpl });
  if (ref && ref.kind === 'mailbox') return makeMailboxCounter({ board: makeBoardClient({ base: ref.boardBase, fetchImpl }), gateway: ref.gateway, ...call });
  return makeCounter(async () => ({ status: 503, body: { error: 'the provider is not reachable from here' } }));
}

// Every provider there is to bridge with: the ones that serve HTTP (checked against the key the page pins for each) and the ones on the
// boards (their ads, checked). One entry for each provider key, the one that serves HTTP first.
export async function discoverProviders({ providers = [], boards = [], fetchImpl = (...a) => fetch(...a), now }) {
  const out = [];
  await Promise.all(providers.map(async (p) => {
    try {
      const i = await makeHttpCounter({ base: p.base, fetchImpl }).info();
      const claimPub = String(i.claimPub || '').toLowerCase();
      if (p.claimPub && p.claimPub.toLowerCase() !== claimPub) return;
      out.push({ id: claimPub, name: p.name || 'Provider', ref: { kind: 'http', base: p.base, claimPub }, terms: termsOf(i), http: true });
    } catch { /* a provider that does not answer is not listed */ }
  }));
  await Promise.all(boards.map(async (boardBase) => {
    try {
      for (const p of await readProviders({ board: makeBoardClient({ base: boardBase, fetchImpl }), ...(now ? { now } : {}) })) {
        out.push({ id: p.id, name: p.name, ref: { kind: 'mailbox', boardBase, gateway: p.ad.gateway, claimPub: p.ad.claimPub }, terms: termsOf(p.ad) });
      }
    } catch { /* a board that does not answer has no providers here */ }
  }));
  const seen = new Set();
  return out.sort((a, b) => (b.http ? 1 : 0) - (a.http ? 1 : 0)).filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

// What both roles need of a key: its Bitcoin wallet, which must be the one tacit.js reads, and the Bitcoin and pool sides.
function sides({ T, ux, priv, hrp, bases, fetchImpl, asset, seedTag, forNotes }) {
  const { prims } = makeBtcWallet({ priv, hrp, fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
  // the lock spends notes at the wallet's own address: both must name the same one
  if (prims.wallet.address() !== T.wallet.address()) throw new Error('The Bitcoin address of this key is not the one the wallet reads. Nothing was done.');
  const builder = makeAdaptorBtcTx({ prims, kit: tacitKit(T) });
  const btc = makeEsploraBtcChain({
    bases, prims, builder, fetchImpl,
    // a provider reads the notes it is locked to and whether they are spent on Ethereum
    ...(forNotes ? { tacit: T, pool: ux.pool, ethGetStorageAt: (to, slot, tag) => ux.rpc('eth_getStorageAt', [to, slot, tag]), poolAddress: ux.cfg.pool, binding: ux.chainBindingHex(), keccak256: keccak_256, secp } : {}),
  });
  const seed = hmac(sha256, priv, enc.encode(seedTag));
  const evm = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256, walletPriv: priv, seed, asset: asset.evmAsset, poolAddress: ux.cfg.pool });
  return { prims, btc, seed, evm };
}

export async function openFast({ T, withKey, ux, priv, pubHex, pins = {}, fetchImpl = (...a) => fetch(...a), bases = EXPLORERS, hrp = 'bc', now, call = {}, counterFor: counterOf = (ref) => counterFor(ref, { fetchImpl, call }) }) {
  const asset = { btcAsset: TAC_ASSET, evmAsset: TAC_ASSET, ...pins };
  const { prims, btc, seed, evm } = sides({ T, ux, priv, hrp, bases, fetchImpl, asset, seedTag: 'tacit-fastbridge-user-seed' });
  const store = makeLocalStore(`tacit-fastbridge-v1:mainnet:${pubHex}:`);
  const market = makeFastBridgeMarket({ btc, evm, store, seed, pins: asset, counterFor: counterOf, ...(now ? { now } : {}) });
  const notes = () => withKey((t) => notesOf(t, asset.btcAsset));
  const balance = async () => (await notes()).reduce((s, n) => s + n.amount, 0n);
  const fastFirst = async (all, quotes) => untrackedFirst(all, await withKey((t) => t.bridgeUx().noteTracking(all)).catch(() => null),
    (rest) => quotes.length > 0 && quotes.every(({ provider, quote }) => market.clientFor(provider.ref).pickNotes(rest, quote.btcValue)));
  return {
    address: prims.wallet.address(), notes, balance, market,
    quoteAll: (providers, units, o) => market.quoteAll(providers, units, o),
    start: async ({ quotes }) => market.start({ quotes, notes: await fastFirst(await notes(), quotes) }),
    records: market.records, run: market.run, recover: market.recover,
  };
}

// ── TAC made ready for Ethereum: bound notes and the fast lane ──

// A bind is opt-in and small while the fast lane is new: at most this much at a time, and at least what a move's fee leaves worth moving.
export const BIND_MIN = 10n * 10n ** 8n, BIND_MAX = 1000n * 10n ** 8n;
// reflection takes blocks 24 deep, then its proof lands
const REFLECT_DEPTH = 24, REFLECT_LAG_MINS = 40;
const NULLIFIER_SPENT_SLOT = 70n;

//   const b = await openBound({ T, withKey, ux, priv, pubHex, witnessBase })
//   -> { notes(), balance(), bound(), bind({ amount }), move(note), unbind(note) }
// notes() are what a bind spends: the key's TAC at its trading address and TAC back from Ethereum at its Taproot address; bound() the bound notes there, each
// { txid, vout, amount, state: 'waiting' | 'ready' | 'moved' | 'spent', etaMins }; move() spends one into the key's private balance,
// the relay settling it for a fee taken from the note.
// TAC that came back from Ethereum: cross-out mints at the Taproot address, opened from the key (tacit.js crossoutNotes), the ones
// the worker says were minted. A bind spends them where they are, by key path, with no move to the trading address first.
export async function returnedNotesOf(t) {
  const known = {};
  try { for (const r of t.crossoutUx().list(hex(t.wallet.pub))) if (r.settle && r.settle.claimId) known[String(r.settle.claimId).toLowerCase()] = { amount: BigInt(r.source.amount ?? r.source.value), nullifier: r.id }; } catch { /* opened from the chain instead */ }
  const found = await t.crossoutNotes().discover({ walletPriv: t.wallet.priv, assetIds: [TAC_ASSET], known });
  return found.filter((n) => n.confirmed && n.credited === true && n.amount != null && n.blinding != null)
    .map((n) => ({ txid: n.txid, vout: n.vout, value: n.sats, amount: BigInt(n.amount), blinding: BigInt(n.blinding), taproot: true }));
}

export async function openBound({ T, withKey, ux, priv, pubHex, witnessBase = 'https://api.tacit.finance', fetchImpl = (...a) => fetch(...a), bases = EXPLORERS, hrp = 'bc', returnedNotes = returnedNotesOf }) {
  const { prims } = makeBtcWallet({ priv, hrp, fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
  if (prims.wallet.address() !== T.wallet.address()) throw new Error('The Bitcoin address of this key is not the one the wallet reads. Nothing was done.');
  const binding = ux.chainBindingHex();
  const btc = makeEsploraBtcChain({ bases, prims, builder: null, fetchImpl });
  const binder = makeBtcBind({ prims, kit: tacitKit(T), target: binding });
  const getStorageAt = (to, slot) => ux.rpc('eth_getStorageAt', [to, slot, 'latest']);
  const roots = makePoolRoots({ pool: ux.cfg.pool, getStorageAt, keccak256: keccak_256 });
  const authKey = '0x' + hex(prims.wallet.xonly());
  const taproot = p2trAddress(prims.wallet.xonly(), hrp);
  const witnessFor = async (body) => {
    const r = await fetchImpl(`${witnessBase.replace(/\/$/, '')}/reflection/note-witness?network=mainnet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`the relay could not say whether the note is ready (${r.status})`);
    return r.json();
  };
  const spentOnEthereum = async (nu) => {
    const slot = '0x' + hex(keccak_256(hexToBytes(String(nu).replace(/^0x/, '').padStart(64, '0') + NULLIFIER_SPENT_SLOT.toString(16).padStart(64, '0'))));
    return BigInt(await getStorageAt(ux.cfg.pool, slot)) !== 0n;
  };
  const utxosAt = async (address) => {
    for (const b of bases) {
      try { const r = await fetchImpl(`${b}/address/${address}/utxo`, { signal: AbortSignal.timeout(20000) }); if (r.ok) return r.json(); } catch { /* the next explorer */ }
    }
    throw new Error('no explorer answered for the Taproot address');
  };

  // what a bind can spend: the trading address's notes and the returned ones
  const notes = async () => [...(await withKey((t) => notesOf(t, TAC_ASSET))), ...(await withKey(returnedNotes).catch(() => []))];
  const balance = async () => (await notes()).reduce((s, n) => s + n.amount, 0n);

  async function bound() {
    const [utxos, tip] = await Promise.all([utxosAt(taproot), btc.tip()]);
    const out = [];
    for (const u of utxos) {
      const tx = await btc.fetchTx(u.txid);
      const o = tx && openBoundNote({ tacit: T, priv: prims.wallet.priv, pub: prims.wallet.pub, tx, vout: u.vout });
      if (!o || '0x' + o.target !== binding.toLowerCase() || o.asset !== TAC_ASSET) continue;
      const note = { txid: u.txid, vout: u.vout, value: u.value, amount: o.amount, blinding: o.blinding, asset: '0x' + o.asset };
      const height = u.status && u.status.confirmed ? u.status.block_height : null;
      const lane = height ? await fastLaneNote({ pool: ux.pool, roots, witnessFor, note, authKey, chainBinding: binding }) : { ready: false, why: 'reflecting' };
      const moved = lane.nullifier ? await spentOnEthereum(lane.nullifier) : false;
      const left = height ? Math.max(0, height + REFLECT_DEPTH - tip) * 10 + REFLECT_LAG_MINS : REFLECT_DEPTH * 10 + REFLECT_LAG_MINS + 10;
      const state = moved ? 'moved' : lane.ready ? 'ready' : lane.why === 'spent' ? 'spent' : 'waiting';
      out.push({ ...note, state, etaMins: state === 'waiting' ? left : 0, lane });
    }
    return out.sort((a, b) => (a.state === b.state ? (a.amount > b.amount ? -1 : 1) : a.state === 'ready' ? -1 : 1));
  }

  // The notes the reflection tracks (its live set, keyed keccak(txid ‖ vout) in internal byte order). The reflection folds a bind
  // only when every note it spends is tracked; a bind of any other note would make a bound note that never becomes ready.
  async function tracked() {
    const r = await fetchImpl(`${witnessBase.replace(/\/$/, '')}/reflection/live?network=mainnet`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`the relay could not list the notes it tracks (${r.status})`);
    const j = await r.json();
    if (!Array.isArray(j.liveTriples)) throw new Error('the relay could not list the notes it tracks');
    return new Set(j.liveTriples.map((t) => String(t[0]).toLowerCase()));
  }
  const keyOf = (n) => {
    const b = new Uint8Array(36);
    b.set(hexToBytes(n.txid).reverse(), 0);
    new DataView(b.buffer).setUint32(32, n.vout >>> 0, true);
    return '0x' + hex(keccak_256(b));
  };

  // BIND: `amount` of the key's tracked TAC, from its largest notes, into a bound note of that size (and the rest, bound too, when a note is larger)
  async function bind({ amount }) {
    const want = BigInt(amount);
    if (want < BIND_MIN || want > BIND_MAX) throw new Error(`make ready between ${BIND_MIN / 10n ** 8n} and ${BIND_MAX / 10n ** 8n} TAC at a time`);
    const [mine, live] = await Promise.all([notes(), tracked()]);
    const all = mine.filter((n) => live.has(keyOf(n))).sort((a, b) => (a.amount > b.amount ? -1 : 1));
    const held = all.reduce((s, n) => s + n.amount, 0n);
    if (held < want) throw new Error(held < mine.reduce((s, n) => s + n.amount, 0n) ? `only ${held / 10n ** 8n} TAC of yours can be made ready now: the rest is newer than the bridge's last check, or older than it tracks (bridge that from the front page)` : 'your TAC on Bitcoin does not cover that amount');
    const picked = [];
    let sum = 0n;
    for (const n of all) { if (sum >= want || picked.length >= 8) break; picked.push(n); sum += n.amount; }
    if (sum < want) throw new Error('your TAC on Bitcoin does not cover that amount in one go');
    const pair = binder.bindTransfer({ asset: hexToBytes(TAC_ASSET), notes: picked, sizes: sum > want ? [want, sum - want] : [want], satsUtxos: await btc.satsUtxos(), feeRate: await btc.feeRate() });
    await btc.broadcast(pair);
    return { txid: pair.revealTxid };
  }

  // MOVE: one ready bound note into the key's private balance, the relay settling it for a fee from the note
  async function move(n) {
    const lane = await fastLaneNote({ pool: ux.pool, roots, witnessFor, note: n, authKey, chainBinding: binding });
    if (!lane.ready) throw new Error(lane.why === 'reflecting' ? 'this note is not ready yet' : lane.why === 'spent' ? 'this note is already spent' : 'the relay and the pool differ for now: try again in a few minutes');
    const fee = await ux.quoteTransferFee(BigInt(n.amount), 'cTAC');
    if (fee >= BigInt(n.amount)) throw new Error('this note is smaller than the fee of moving it');
    return ux.fastlaneExit({ walletPriv: priv, notes: [lane.input], authPriv: '0x' + hex(prims.wallet.priv), spendRoot: lane.spendRoot, bitcoinSpentRoot: lane.bitcoinSpentRoot, fee, selfRelay: false });
  }

  // UNBIND: one bound note back to ordinary TAC at the trading address (usable on Bitcoin once the reflection passes it)
  async function unbind(n) {
    const pair = binder.unbindTransfer({ asset: hexToBytes(TAC_ASSET), note: n, satsUtxos: await btc.satsUtxos(), feeRate: await btc.feeRate() });
    await btc.broadcast(pair);
    return { txid: pair.revealTxid };
  }

  return { notes, balance, bound, bind, move, unbind, taproot };
}

// ── the key's own provider ──

// A provider's defaults, in base units of TAC (8 places): 0.30% and 1 TAC, from 10 to 1,000 TAC.
export const PROVIDER_DEFAULTS = { feeBps: 30, flatFee: 100_000_000n, minAmount: 1_000_000_000n, maxAmount: 100_000_000_000n };

// Whether the one who provides is at the page: a tab that has been in the background for a while (a laptop closing, another tab) may not be
// there to finish what it takes on, so it takes on nothing new until it is back. Swaps already under way are tended and answered all the same.
const AWAY_AFTER_MS = 30000;
function presence(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || typeof doc.addEventListener !== 'function') return () => true;
  let hiddenAt = doc.hidden ? Date.now() : null;
  doc.addEventListener('visibilitychange', () => { hiddenAt = doc.hidden ? (hiddenAt ?? Date.now()) : null; });
  return () => hiddenAt == null || Date.now() - hiddenAt < AWAY_AFTER_MS;
}

export async function openProvider({ T, ux, priv, pubHex, boards = [], name = null, fetchImpl = (...a) => fetch(...a), bases = EXPLORERS, hrp = 'bc', now = () => Math.floor(Date.now() / 1000), tickSecs = 15, pollMs = 3000, present = presence() }) {
  const asset = { btcAsset: TAC_ASSET, evmAsset: TAC_ASSET };
  const { prims, btc, seed, evm } = sides({ T, ux, priv, hrp, bases, fetchImpl, asset, seedTag: 'tacit-fastbridge-lp-seed', forNotes: true });
  const claimPub = hex(prims.wallet.pub);
  const adName = name || `Provider ${claimPub.slice(2, 8)}`;
  const swaps = makeLocalStore(`tacit-fastlp-v1:mainnet:${pubHex}:swaps:`), quoteStore = makeLocalStore(`tacit-fastlp-v1:mainnet:${pubHex}:quotes:`);
  const keys = gatewayOf(priv);
  // more Bitcoin confirmations for a larger amount
  const confs = (v) => (BigInt(v) >= 10_000n * 10n ** 8n ? 3 : BigInt(v) >= 1_000n * 10n ** 8n ? 2 : 1);
  let service = null, stops = [], running = false, accepting = false, lastError = null, busy = false;

  async function status() {
    const recs = await swaps.list();
    const done = recs.filter((r) => r.phase === 'done');
    return {
      running, accepting, open: recs.filter((r) => !TERMINAL.includes(r.phase)).length, done: done.length,
      earned: done.reduce((a, r) => a + (BigInt(r.offer.btc.value) - BigInt(r.offer.evm.amount)), 0n), lastError,
      lastTake: done.filter((r) => r.take).sort((a, b) => (b.updated || 0) - (a.updated || 0))[0]?.take.txid ?? null,
      held: service && service.held ? await service.held().catch(() => null) : null,
    };
  }
  async function inventory() {
    return { pool: await evm.available(), address: btc.address, claimPub };
  }
  const configOf = (s) => ({
    claimPub, csvBlocks: 144, alertSecs: 3600,
    quote: { btcAsset: asset.btcAsset, evmAsset: asset.evmAsset, minAmount: s.minAmount, maxAmount: s.maxAmount, feeBps: s.feeBps, flatFee: s.flatFee, validSecs: 600 },
    policy: {
      minCsv: 72, evmWindowSecs: 4 * 3600, minClaimSecs: 3600, claimSlackSecs: 7200, roundSecs: 600, refundMarginSecs: 600, maxOfferAgeSecs: 3600,
      minAmount: s.minAmount, maxAmount: s.maxAmount, minConfsFor: confs,
    },
  });
  // Starts the swaps that are open on their way (the takes and the refunds are not to be left), and, when `accept` is set, answers
  // requests and posts the ad on every board. Settings: { feeBps, flatFee, minAmount, maxAmount } in base units.
  async function start({ settings = {}, accept = true } = {}) {
    if (running) return;
    // what the service finds wrong is said in the panel (a lock it could not check, a request that failed), not kept from the one who provides
    const said = (o) => { if (o.level === 'error' || o.level === 'warn') lastError = `${o.msg}${o.error ? `: ${o.error}` : ''}`.slice(0, 200); };
    service = makeLpService({ seed, btc, evm, swaps, quoteStore, config: configOf({ ...PROVIDER_DEFAULTS, ...settings }), now, log: said });
    await service.start();
    running = true; accepting = !!accept; lastError = null;
    const note = (o) => { lastError = o.error || o.msg || null; };
    // what is new is taken on only while the one who provides is at the page: a quote, a reservation, or an offer for a swap not stored yet
    const away = { status: 200, body: { ok: false, retry: true, why: 'the provider is away from its page right now: try again shortly, or another provider' } };
    const isNew = async (req) => req.method === 'POST' && (req.path === '/quote' || req.path === '/reserve' || (req.path === '/offer' && !(req.body && req.body.offer && (await swaps.get(String(req.body.offer.swapId || '').toLowerCase().replace(/^0x/, ''))))));
    // a provider that only finishes (accept false) answers what is open and takes on nothing new, as one away from its page does
    const taking = () => accept && present();
    const handle = async (req) => (!taking() && (await isNew(req)) ? (req.path === '/quote' ? { status: 503, body: { error: away.body.why } } : away) : service.handle(req));
    // The ad is posted while it is at the page, or while a bridge it took on is open: the board carries a user's requests only to a provider
    // whose ad stands, and a user whose bridge is open must still reach it for the pool lock's offer. New bridges are declined while away.
    const openSwap = async () => (await swaps.list()).some((r) => !TERMINAL.includes(r.phase));
    const adHandle = async (req) => (taking() || (await openSwap()) ? service.handle(req) : { status: 503, body: null });
    // on the board whether it takes new bridges or only finishes open ones: a user whose bridge is open reaches it only through the board
    {
      for (const base of boards) {
        const board = makeBoardClient({ base, fetchImpl });
        const mail = makeMailboxServer({ board, keys, handle, signReply: (d) => signSchnorr(d, priv), now, pollMs, log: note });
        const ads = makeAdPublisher({ board, handle: adHandle, claimPriv: priv, claimPub, keys, name: adName, now, everySecs: 60, log: note });
        mail.start(); ads.start();
        stops.push(() => { mail.stop(); ads.stop(); });
      }
    }
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try { await service.tick(); } catch (e) { lastError = String((e && e.message) || e).slice(0, 160); } finally { busy = false; }
    }, tickSecs * 1000);
    stops.push(() => clearInterval(timer));
  }
  function stop() { for (const f of stops) f(); stops = []; running = false; accepting = false; }
  return { address: btc.address, claimPub, inventory, start, stop, status, present, service: () => service };
}
