// Sends TAC back for bridges that did not complete. The API takes claims in (POST /bridge/recover) and checks them;
// this service reads them, checks each again on its own (chain data from public explorers, the reflection state
// authenticated against the pool's attested digest), and sends the claimed amount from its key to the claim's key.
// dapp/bridge-recover.js holds the check both sides run.
//
// One claim is sent at a time. Before a send the claim is marked 'sending' with the notes it will spend, so a send
// cut short resolves from chain data: a spent note names the transaction that paid it, and an unspent one is sent
// again with the same notes once the grace period passes. A claim that no longer checks out is marked 'held'.
//
// Env:
//   RECOVER_KEY              P2WPKH private key holding the TAC it sends, hex (secret)
//   CONFIDENTIAL_BOX_TOKEN   bearer token for the API's claim routes (secret)
//   RECOVER_NETWORK          mainnet (default)
//   TACIT_WORKER_BASE        API base (default https://api.tacit.finance)
//   RECOVER_ETH_RPC          Ethereum RPC for the pool's attested digest (default https://ethereum-rpc.publicnode.com)
//   RECOVER_POLL_SECS        poll interval (default 120)
//   RECOVER_GRACE_SECS       wait before resending a send cut short (default 1200)
//   RECOVER_FEE_KEY          optional P2WPKH key whose plain sats top up RECOVER_KEY's fee money when it runs low
//                            (secret); TAC never goes to its address
//   RECOVER_MIN_SATS         plain sats below which a top-up is sent (default 6000)
//   RECOVER_TOPUP_SATS       sats per top-up, at most one per six hours (default 12000)
//   RECOVER_STEALTH_TXIDS    comma-separated txids of stealth sends to RECOVER_KEY, discovered at start (recent
//                            ones are also found by scanning TAC's recent transfers)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTacitHeadless, setWalletKey } from './sats-faucet.js';
import { makeBridgeRecover } from '../../dapp/bridge-recover.js';
import { makeConfidentialPool } from '../../dapp/confidential-pool.js';
import { makeScanReflectionIndexer } from '../../dapp/confidential-reflection-scan-indexer.js';
import { classifyConfidentialTx, readVarint, txOutputScript } from '../../dapp/burn-deposit-bitcoin.js';
import { sha256, hexToBytes, bytesToHex } from '../../dapp/vendor/tacit-deps.min.js';
import { signSchnorr, verifySchnorr } from '../../dapp/bulletproofs.js';

const log = (...a) => console.log(`[bridge-recover ${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const int = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
const lc = (h) => String(h || '').replace(/^0x/, '').toLowerCase();
const key0x = (h) => '0x' + lc(h);

export const TAC_ASSET_ID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
export const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const ESPLORA = { mainnet: ['https://mempool.space/api', 'https://blockstream.info/api'] };

export function configFromEnv(env = process.env) {
  const cfg = {
    network: env.RECOVER_NETWORK || 'mainnet',
    base: (env.TACIT_WORKER_BASE || 'https://api.tacit.finance').replace(/\/$/, ''),
    token: env.CONFIDENTIAL_BOX_TOKEN || '',
    ethRpc: env.RECOVER_ETH_RPC || 'https://ethereum-rpc.publicnode.com',
    pollSecs: int(env.RECOVER_POLL_SECS, 120),
    graceSecs: int(env.RECOVER_GRACE_SECS, 1200),
    minSats: int(env.RECOVER_MIN_SATS, 6000),
    topUpSats: int(env.RECOVER_TOPUP_SATS, 12000),
    stealthTxids: String(env.RECOVER_STEALTH_TXIDS || '').split(',').map((t) => t.trim().toLowerCase()).filter((t) => /^[0-9a-f]{64}$/.test(t)),
  };
  if (cfg.network !== 'mainnet') throw new Error('bridge-recover runs on mainnet only');
  if (!cfg.token) throw new Error('CONFIDENTIAL_BOX_TOKEN is required');
  return cfg;
}

// A transaction's id (display order) from its raw hex: the double SHA-256 of its serialization without witness data. null when the hex is not a
// whole transaction (inputs, outputs, witnesses and locktime consume it exactly).
export function txidOfHex(hex) {
  try {
    const tx = hexToBytes(lc(hex));
    const segwit = tx.length > 5 && tx[4] === 0x00 && tx[5] === 0x01;
    const skip = (pos, bytesOf) => { const r = readVarint(tx, pos); if (!r) throw new Error('short'); return [r[0], pos + r[1] + (bytesOf ? r[0] : 0)]; };
    let pos = segwit ? 6 : 4; const bodyStart = pos;
    let [inCount, p] = skip(pos, false); pos = p;
    if (inCount === 0) return null;
    for (let i = 0; i < inCount; i++) { pos += 36; [, pos] = skip(pos, true); pos += 4; }
    let outCount; [outCount, pos] = skip(pos, false);
    if (outCount === 0) return null;
    for (let i = 0; i < outCount; i++) { pos += 8; [, pos] = skip(pos, true); }
    const bodyEnd = pos;
    if (segwit) for (let i = 0; i < inCount; i++) { let items; [items, pos] = skip(pos, false); for (let j = 0; j < items; j++) [, pos] = skip(pos, true); }
    if (pos + 4 !== tx.length) return null;
    const stripped = new Uint8Array(4 + (bodyEnd - bodyStart) + 4);
    stripped.set(tx.subarray(0, 4), 0); stripped.set(tx.subarray(bodyStart, bodyEnd), 4); stripped.set(tx.subarray(tx.length - 4), 4 + (bodyEnd - bodyStart));
    return bytesToHex(sha256(sha256(stripped)).reverse());
  } catch { return null; }
}

// Public chain data from the first explorer whose answer is the one asked for: a transaction's hex hashes to its id, its JSON carries that id,
// and each input's prevout script is the one its parent transaction's output holds. An answer that is not is skipped like an explorer that is down.
export function makeChain(fetchImpl = fetch, bases = ESPLORA.mainnet) {
  async function get(p, kind, accept = null) {
    let last;
    for (const b of bases) {
      try {
        const r = await fetchImpl(b + p);
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`${r.status}`);
        const v = kind === 'json' ? await r.json() : (await r.text()).trim();
        if (accept && !(await accept(v))) throw new Error('the answer is not the one asked for');
        return v;
      } catch (e) { last = e; }
    }
    throw new Error(`explorers unavailable for ${p}: ${last && last.message}`);
  }
  const hexOf = (t) => get(`/tx/${t}/hex`, 'text', (h) => txidOfHex(h) === lc(t));
  return {
    getTx: (t) => get(`/tx/${t}`, 'json', async (j) => {
      if (!j || lc(j.txid) !== lc(t)) return false;
      for (const v of j.vin || []) {
        if (!v.prevout) continue;
        const parent = await hexOf(v.txid);
        if (!parent || lc(txOutputScript(parent, v.vout)) !== lc(v.prevout.scriptpubkey)) return false;
      }
      return true;
    }),
    getTxHex: hexOf,
    outspend: (t, v) => get(`/tx/${t}/outspend/${v}`, 'json'),
  };
}

// The send loop. Everything it touches is injected so tests drive it with stand-ins.
//   api:    { claims() → [claim], mark(burnTxid, status, extra) }
//   chain:  makeChain()
//   state:  async () → { height, dests, pending, live, leaves, spent } from the authenticated reflection state (0x-prefixed keys)
//   wallet: { pubHex, spk, notes() → [{ txid, vout, amount, blinding, value }], send({ pubHex, amount, inputs }) → txid }
//   beforeSend: optional async () → true when it did something (a fee top-up) that the send should wait for
export function makeRecoverer({ verifier, pool, api, chain, state, wallet, beforeSend = null, graceSecs = 1200, now = () => Date.now(), logger = log }) {
  const opKey = (o) => key0x(pool.outpointKey('0x' + lc(o.txid).match(/../g).reverse().join(''), o.vout));

  // Untracked notes first, largest first: an untracked note sent on stays untracked, so its holder can bridge it.
  function pick(notes, amount, live, skip = null) {
    const order = notes.filter((n) => !skip || !skip.has(`${lc(n.txid)}:${n.vout}`)).sort((a, b) => {
      const la = live.has(opKey(a)) ? 1 : 0, lb = live.has(opKey(b)) ? 1 : 0;
      if (la !== lb) return la - lb;
      return BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : 0;
    });
    const out = [];
    let sum = 0n;
    for (const n of order) {
      if (sum >= amount) break;
      out.push(n); sum += BigInt(n.amount);
      if (out.length === 6) break;
    }
    return sum >= amount ? out : null;
  }

  // The transaction that spent one of a send's notes, if it paid the claim's key; else null.
  async function paidBy(claim) {
    for (const inp of claim.inputs || []) {
      const s = await chain.outspend(inp.txid, inp.vout);
      if (!s || !s.spent) continue;
      const tx = await chain.getTx(s.txid);
      const pays = (tx && tx.vout || []).some((o) => lc(o.scriptpubkey) === verifier.ownerScript(claim.pubkey));
      return { txid: s.txid, pays };
    }
    return null;
  }

  async function sendOne(claim, amount, inputs) {
    await api.mark(claim.burnTxid, 'sending', { inputs: inputs.map((n) => ({ txid: n.txid, vout: n.vout })) });
    const txid = await wallet.send({ pubHex: claim.pubkey, amount, inputs });
    logger(`sent ${amount} to ${claim.address || claim.pubkey} for ${claim.burnTxid}: ${txid}`);
    await api.mark(claim.burnTxid, 'sent', { txid });
    return txid;
  }

  // Claims whose send keeps failing are held for a person after this many tries in a row.
  const MAX_FAILS = 3, LOST_NOTES_SECS = 6 * 3600;
  const fails = new Map();
  const byAt = (a, b) => (a.at || 0) - (b.at || 0);

  // One claim: checked again on its own, its notes chosen, and sent. Returns the outcome, or null when it can wait without
  // holding up the others (a reason that clears by itself, a send that failed this time).
  async function attempt(claim, reserved = null) {
    const st = await state();
    if (!st) { logger('reflection state not authenticated yet; retrying'); return { sent: 0, stop: true }; }
    let v;
    try { v = await verifier.verifyClaim(claim, { getTx: chain.getTx, getTxHex: chain.getTxHex, state: st }); }
    catch (e) { logger(`${claim.burnTxid} could not be checked yet (${(e && e.message) || e}); retrying`); return null; }
    if (!v.ok) {
      if (v.transient) { logger(`${claim.burnTxid} waits: ${v.reason}`); return { sent: 0, waiting: claim.burnTxid }; }
      await api.mark(claim.burnTxid, 'held', { note: v.reason }); logger(`held ${claim.burnTxid}: ${v.reason}`); return { sent: 0, held: claim.burnTxid };
    }

    const notes = await wallet.notes();
    let inputs = null;
    if (claim.status === 'sending' && claim.inputs && claim.inputs.length) {
      const byKey = new Map(notes.map((n) => [`${lc(n.txid)}:${n.vout}`, n]));
      const again = claim.inputs.map((o) => byKey.get(`${lc(o.txid)}:${o.vout}`));
      if (again.every(Boolean)) inputs = again;
      else if (now() - (claim.sendingAt || 0) < LOST_NOTES_SECS * 1000) {
        // Its notes have left the wallet, but no spend of them shows yet (an explorer can trail the wallet's own view): other notes are
        // never picked in their place while the first send may still be landing.
        logger(`${claim.burnTxid}: its notes are no longer in the wallet and no spend of them is visible yet; waiting`);
        return { sent: 0, waiting: claim.burnTxid };
      } else {
        await api.mark(claim.burnTxid, 'held', { note: 'its notes left the wallet and no transaction paying the claim was found' });
        return { sent: 0, held: claim.burnTxid };
      }
    }
    if (!inputs) inputs = pick(notes, v.amount, st.live || new Set(), reserved);
    if (!inputs) { logger(`not enough TAC on hand for ${claim.burnTxid} (${claim.amount}); waiting`); return { sent: 0, short: claim.burnTxid }; }
    if (beforeSend && await beforeSend()) return { sent: 0, toppedUp: true };
    try {
      const txid = await sendOne(claim, v.amount, inputs);
      fails.delete(claim.burnTxid);
      return { sent: 1, txid };
    } catch (e) {
      const n = (fails.get(claim.burnTxid) || 0) + 1;
      fails.set(claim.burnTxid, n);
      logger(`send for ${claim.burnTxid} failed (${n} of ${MAX_FAILS}): ${(e && e.message) || e}`);
      if (n >= MAX_FAILS) { try { await api.mark(claim.burnTxid, 'held', { note: `the send failed ${n} times: ${String((e && e.message) || e).slice(0, 160)}` }); } catch {} fails.delete(claim.burnTxid); }
      return null;
    }
  }

  async function tick() {
    const all = await api.claims();
    const sending = all.filter((c) => c.status === 'sending').sort(byAt);
    const queued = all.filter((c) => c.status === 'queued').sort(byAt);
    const reserved = new Set(sending.flatMap((c) => (c.inputs || []).map((o) => `${lc(o.txid)}:${o.vout}`)));      // the notes a send still landing holds
    if (!sending.length && !queued.length) return { sent: 0 };
    let first = null;                                              // what the first claim that did not send was waiting for
    const keep = (r) => { if (r && !first) first = r; };

    // A send cut short: its notes say whether it went out. One send is settled at a time, so two claims never hold the same notes
    // (a payment to one key would otherwise read as the other's), and a send within its grace period holds the rest back.
    for (const claim of sending) {
      const paid = await paidBy(claim);
      if (paid && paid.pays) { await api.mark(claim.burnTxid, 'sent', { txid: paid.txid }); logger(`${claim.burnTxid} was sent in ${paid.txid}`); return { sent: 0, resolved: paid.txid }; }
      if (paid && !paid.pays) { await api.mark(claim.burnTxid, 'held', { note: `its notes were spent by ${paid.txid}, which does not pay the claim` }); return { sent: 0, held: claim.burnTxid }; }
      if (now() - (claim.sendingAt || 0) < graceSecs * 1000) return { sent: 0, waiting: claim.burnTxid };
      const r = await attempt(claim, reserved);
      if (r && (r.sent || r.toppedUp || r.stop)) return r;
      keep(r);
    }
    for (const claim of queued) {
      const r = await attempt(claim, reserved);
      if (r && (r.sent || r.toppedUp || r.stop)) return r;
      keep(r);
    }
    return first || { sent: 0 };
  }

  return { tick, pick };
}

// The authenticated reflection state: the API's dump, accepted only when it reproduces the pool's attested digest.
export function makeAuthedState({ cfg, deps, fetchImpl = fetch, logger = log }) {
  const { secp, keccak_256, sha256 } = deps;
  const selector = '0x' + Array.from(keccak_256(new TextEncoder().encode('attestedReflectionDigest()')).slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
  return async function state() {
    const [dumpRes, rpcRes] = await Promise.all([
      fetchImpl(`${cfg.base}/reflection/dump?network=${cfg.network}`, { headers: { Authorization: `Bearer ${cfg.token}` } }),
      fetchImpl(cfg.ethRpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: POOL, data: selector }, 'latest'] }) }),
    ]);
    if (!dumpRes.ok) throw new Error(`reflection dump ${dumpRes.status}`);
    const raw = await dumpRes.json();
    const onchain = lc((await rpcRes.json()).result);
    const snap = raw.snapshot && typeof raw.snapshot === 'object' ? raw.snapshot : raw;
    const idx = makeScanReflectionIndexer({ secp, keccak256: keccak_256, sha256 });
    idx.load(snap);
    if (lc(idx.digest()) !== onchain) { logger('reflection dump does not match the attested digest yet'); return null; }
    return {
      height: Number(snap.height),
      dests: new Set((snap.burnNodes || []).map((n) => key0x(n && n[2]))),
      pending: new Set((snap.pendingDepositRecords || []).map((r) => key0x(r && r.key))),
      live: new Set((snap.liveTriples || []).map((t) => key0x(Array.isArray(t) ? t[0] : t && t.key))),
      // The note tree and the spent set the digest above covers: the burned note must be found in both.
      leaves: new Set((snap.noteLeaves || []).map((x) => key0x(x))),
      spent: new Set((snap.spentLinks || []).map((l) => key0x(l && l[0]))),
      consumed: new Set((snap.consumedOutpointsLinks || []).map((l) => key0x(l && l[0]))),
    };
  };
}

export function makeApi({ cfg, fetchImpl = fetch }) {
  const auth = { Authorization: `Bearer ${cfg.token}` };
  return {
    async claims() {
      const r = await fetchImpl(`${cfg.base}/bridge/recover/queue?network=${cfg.network}`, { headers: auth });
      if (!r.ok) throw new Error(`claims ${r.status}`);
      return (await r.json()).claims || [];
    },
    async mark(burnTxid, status, extra = {}) {
      const r = await fetchImpl(`${cfg.base}/bridge/recover/mark?network=${cfg.network}`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ burnTxid, status, ...extra }),
      });
      if (!r.ok) throw new Error(`mark ${status} ${r.status}: ${await r.text()}`);
      return r.json();
    },
  };
}

// The key's TAC notes and sends, through the dapp's own transfer builder. Notes received by stealth send sit at one-time
// addresses: they are found among TAC's recent transfers (and any txid given), then held like any other note.
export function makeTacitWallet({ tacit, stealthTxids = [], logger = log }) {
  let primed = false;
  return {
    async notes() {
      if (!primed) {
        for (const t of stealthTxids) { try { await tacit.discoverStealthFromTxid(t, { merge: true }); } catch (e) { logger(`stealth txid ${t}: ${e && e.message || e}`); } }
        primed = true;
      }
      try { await tacit.scanAssetForStealthReceipts(TAC_ASSET_ID, { maxPages: 2, pageLimit: 50 }); } catch (e) { logger(`stealth scan: ${e && e.message || e}`); }
      try { tacit.invalidateHoldingsCache(); } catch {}
      const h = (await tacit.scanHoldings(true)).get(TAC_ASSET_ID);
      return ((h && h.utxos) || []).map((u) => ({ txid: u.utxo.txid, vout: u.utxo.vout, value: u.utxo.value, amount: BigInt(u.amount), blinding: BigInt(u.blinding), _u: u }));
    },
    async send({ pubHex, amount, inputs }) {
      const r = await tacit.buildAndBroadcastCXferMulti({ assetIdHex: TAC_ASSET_ID, recipients: [{ pubHex, amount }], forceUtxos: inputs.map((n) => n._u) });
      return r.revealTxid;
    },
  };
}

// Fee money: when the key's plain sats fall under minSats, one send of topUpSats from the fee key's plain sats, at most
// once per six hours. Returns true when it sent one, so the refund waits a round for it.
export function makeTopUp({ tacit, deps, recoverKey, feeKey, minSats = 6000, topUpSats = 12000, now = () => Date.now(), logger = log }) {
  let lastAt = -Infinity;
  return async function topUp() {
    if (!feeKey) return false;
    const addr = tacit.wallet.address();
    const have = (await tacit.getUtxos(addr)).filter((u) => u.value > tacit.DUST).reduce((a, u) => a + u.value, 0);
    if (have >= minSats || now() - lastAt < 6 * 3600 * 1000) return false;
    lastAt = now();
    setWalletKey({ tacit, deps }, feeKey);
    try {
      const r = await tacit.buildAndBroadcastSatsSend({ recipientAddr: addr, amountSats: topUpSats });
      logger(`fee money: ${topUpSats} sats from ${tacit.wallet.address()} in ${r.txid} (had ${have})`);
      return true;
    } finally { setWalletKey({ tacit, deps }, recoverKey); }
  };
}

async function main() {
  const cfg = configFromEnv();
  const keyOf = (v) => (v ? String(v).trim().toLowerCase().replace(/^0x/, '') : null);
  const recoverKey = keyOf(process.env.RECOVER_KEY), feeKey = keyOf(process.env.RECOVER_FEE_KEY);
  if (!recoverKey) throw new Error('RECOVER_KEY is required');
  const loaded = await loadTacitHeadless(cfg.network);
  const pubHex = setWalletKey(loaded, recoverKey);
  const { deps } = loaded;
  const pool = makeConfidentialPool({ secp: deps.secp, keccak256: deps.keccak_256, sha256: deps.sha256 });
  const verifier = makeBridgeRecover({ secp: deps.secp, sha256: deps.sha256, ripemd160: deps.ripemd160, pool, classifyConfidentialTx, signSchnorr, verifySchnorr, tacAssetId: TAC_ASSET_ID });
  const wallet = makeTacitWallet({ tacit: loaded.tacit, stealthTxids: cfg.stealthTxids });
  try {
    const { unifiedAddress } = await import('../../dapp/tacit-unified.js');
    const notes = await wallet.notes();
    const sats = (await loaded.tacit.getUtxos(loaded.tacit.wallet.address())).filter((u) => u.value > loaded.tacit.DUST).reduce((a, u) => a + u.value, 0);
    log(`sending from ${loaded.tacit.wallet.address()} (${unifiedAddress(recoverKey).address}): ${notes.reduce((a, n) => a + n.amount, 0n)} TAC units in ${notes.length} note(s), ${sats} sats`);
  } catch (e) { log(`sending from ${loaded.tacit.wallet.address()} (${pubHex}); balance read failed: ${e && e.message || e}`); }
  const topUp = makeTopUp({ tacit: loaded.tacit, deps, recoverKey, feeKey, minSats: cfg.minSats, topUpSats: cfg.topUpSats });
  if (feeKey) {
    setWalletKey(loaded, feeKey);
    log(`fee money from ${loaded.tacit.wallet.address()} when under ${cfg.minSats} sats`);
    setWalletKey(loaded, recoverKey);
  }
  const rec = makeRecoverer({
    verifier, pool, api: makeApi({ cfg }), chain: makeChain(), state: makeAuthedState({ cfg, deps }), wallet, beforeSend: topUp, graceSecs: cfg.graceSecs,
  });
  const chain = makeChain();
  for (;;) {
    try {
      const r = await rec.tick();
      // Notes are chosen from confirmed holdings, so let a send confirm before the next one.
      for (let i = 0; r.sent && i < 120; i++) {
        const tx = await chain.getTx(r.txid).catch(() => null);
        if (tx && tx.status && tx.status.confirmed) break;
        await sleep(60 * 1000);
      }
    } catch (e) { log(`tick failed: ${e && e.message || e}`); }
    await sleep(cfg.pollSecs * 1000);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`[bridge-recover] fatal: ${e?.message || e}`); process.exit(1); });
}
