#!/usr/bin/env node
// Brings the fast bridge provider's TAC on Bitcoin home to its pool balance, note by note, over the regular bridge: the same steps as the Bridge tab's "Back to
// Ethereum" (preflight, burn, wait for the proof, mint into the pool), run with the provider's key, and kept in a file so each run carries on from the last.
// Only notes the bridge can carry go (tools/fastbridge-lp-inventory.mjs says which); a note that passed through Bitcoin's shielded pool cannot.
//
//   FB_LP_KEY=$(security find-generic-password -s tacit-fastbridge-lp -w) \
//   EXPECT_ADDRESS=bc1q8c9uen node --no-experimental-global-navigator tools/fastbridge-lp-bridge-home.mjs <mode> [options]
//
//   plan    (default) checks the first --count notes (2) the way the bridge does and prices them: nothing is sent, nothing is signed
//   start   --send   starts --count notes (1): builds and signs each note's burn (or its move), sends the first step. Without --send it only says what it would do.
//   tick    one pass of the page's bridge routine over every bridge this tool started (burn, wait, prove, mint). Run it every few minutes; --watch keeps going
//   status  the bridges this tool started, and where each stands (reads the file only)
//
//   --count N         how many notes (plan 2, start 1)
//   --max-fee R       refuse to start while a step would cost more than R sat/vB (20)
//   --inventory FILE  the inventory's results (default $TMPDIR/fastbridge-lp-inventory.json); notes in it classed `bridgeable` are the candidates
//   --home DIR        where it keeps its state (default ~/.tacit-lp-bridge-home)
//   EXPECT_ADDRESS    refuse to run unless the key's Bitcoin address starts with this (a wrong key moves nothing)
//
// The key is read from the environment and never printed. Nothing is sent without --send (start) or a bridge already started (tick). Node 22.

import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const args = process.argv.slice(2);
const mode = ['plan', 'start', 'tick', 'status'].includes(args[0]) ? args[0] : 'plan';
const flag = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SEND = args.includes('--send'), WATCH = args.includes('--watch');
const COUNT = Number(flag('--count', mode === 'start' ? 1 : 2)), MAX_FEE = Number(flag('--max-fee', 20));
const HOME = resolve(flag('--home', join(homedir(), '.tacit-lp-bridge-home')));
const INV = resolve(flag('--inventory', join(tmpdir(), 'fastbridge-lp-inventory.json')));
const die = (m, c = 1) => { console.log(m); process.exit(c); };
if (!(COUNT >= 1 && COUNT <= 40)) die('--count must be 1 to 40');

const keyHex = String(process.env.FB_LP_KEY || '').trim().replace(/^0x/, '');
if (mode !== 'status' && !/^[0-9a-f]{64}$/i.test(keyHex)) die('FB_LP_KEY must be 64 hex characters (set it in the environment)');
delete process.env.FB_LP_KEY;                                                       // not left in the environment of anything this process starts
if (mode === 'start' && !SEND) console.log('(no --send: this only says what it would do)');

// the dapp's modules read these globals: a file for localStorage, so a run carries on from the last; the chain read through Tacit's API (explorers rate limit)
const { JSDOM } = await import(REPO + '/tests/_jsdom.mjs');
const dom = new JSDOM('', { url: 'http://localhost/' });
const { makeFileStorage } = await import(REPO + '/fastbridge-lp/lib/storage.mjs');
const store = makeFileStorage(join(HOME, 'storage.json'));
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: store, location: dom.window.location, __TACIT_NO_INIT__: true, __TACIT_CHAIN_VIA_WORKER__: true });
if (!globalThis.navigator) globalThis.navigator = dom.window.navigator;
store.setItem('tacit-network-v1', 'mainnet');
const { secp, bytesToHex } = await import(REPO + '/dapp/vendor/tacit-deps.min.js');
const T = await import(REPO + '/dapp/tacit.js');
const { review, begin, planSet, burnMaxRate, PLAN_KEY, TAC_BTC_ID } = await import(REPO + '/dapp/bridge-in.js');
const { stepIn, IN_DONE, IN_HELD } = await import(REPO + '/dapp/bridge-tick.js');

const priv = keyHex ? Uint8Array.from(keyHex.match(/../g).map((x) => parseInt(x, 16))) : null;
if (priv) { T.wallet.priv = priv; T.wallet.pub = secp.getPublicKey(priv, true); }
const pubHex = priv ? bytesToHex(T.wallet.pub) : null;
const addr = priv ? T.wallet.address() : null;
if (addr && process.env.EXPECT_ADDRESS && !addr.startsWith(process.env.EXPECT_ADDRESS)) die('the key\'s Bitcoin address is not the one expected: nothing done');
if (addr) console.log(`key's Bitcoin address ${addr.slice(0, 10)}…${addr.slice(-6)}`);
const ux = T.bridgeUx();
const TAC = 10n ** 8n, fmtTac = (v) => (Number(BigInt(v)) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 2 });
const mem = { get: (k) => { try { return JSON.parse(store.getItem(k)); } catch { return null; } }, set: (k, v) => store.setItem(k, JSON.stringify(v)) };
const planOf = (rec) => mem.get(PLAN_KEY)?.[pubHex]?.[rec.id] || null;

// The bridge asks the wallet to classify its coins before it picks one to pay a fee with (a coin that carries a note must never be spent as a fee), and the
// wallet does that with a full scan of the key's history, which takes longer than its own limit for this key. The inventory already opened every note the key
// holds from the chain, so the classifier is told the notes (the ones this tool bridges); every other output at the address of note size (546 sats or less) is
// kept out of fees by the wallet's own dust rule, as the provider's daemon already relies on when it picks coins for its takes.
if (mode !== 'status') {
  if (!existsSync(INV)) die(`no inventory at ${INV}: run tools/fastbridge-lp-inventory.mjs first (or point --inventory at its results)`);
  const notesKnown = JSON.parse(readFileSync(INV, 'utf8'));
  const holdings = new Map([[TAC_BTC_ID, { assetIdHex: TAC_BTC_ID, utxos: notesKnown.map((r) => ({ utxo: { txid: r.txid, vout: r.vout, value: 546 }, amount: BigInt(r.amount) })), balance: 0n, ghosts: [], pending: [], inflated: [], unverified: [] }]]);
  holdings.unclassified = new Set();
  T._testSetScanHoldingsOverride(() => holdings);
}

function table() {
  const recs = pubHex ? ux.list(pubHex) : [];
  if (!recs.length) return console.log('no bridges started by this tool yet');
  const by = {};
  for (const r of recs) by[r.stage] = (by[r.stage] || 0) + 1;
  console.log(`${recs.length} bridges: ${Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  for (const r of recs) console.log(`  ${r.id.slice(0, 10)}…:${r.id.split(':')[1]} ${fmtTac(r.source?.amount ?? 0)} TAC  ${r.path || 'two-step'}  ${r.stage}${r.lastError ? `  ! ${String(r.lastError.message || r.lastError).slice(0, 90)}` : ''}${r.feeWait ? '  (waiting for a lower fee)' : ''}`);
}
if (mode === 'status') {
  // status reads the file only: the journal is keyed by the key's public key, which the file names
  const pubs = new Set(); for (let i = 0; i < store.length; i++) { const m = /^tacit-burndep-bridge-v1:mainnet:([0-9a-f]{66})$/.exec(store.key(i) || ''); if (m) pubs.add(m[1]); }
  if (!pubs.size) die('no bridges started by this tool yet', 0);
  for (const p of pubs) {
    const raw = JSON.parse(store.getItem(`tacit-burndep-bridge-v1:mainnet:${p}`) || '[]');
    const by = {}; for (const r of raw) by[r.stage] = (by[r.stage] || 0) + 1;
    console.log(`${raw.length} bridges for key ${p.slice(0, 8)}…: ${Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', ')}`);
    for (const r of raw) console.log(`  ${String(r.id).slice(0, 10)}…:${String(r.id).split(':')[1]} ${r.source?.amount != null ? fmtTac(r.source.amount.__big ?? r.source.amount) : '?'} TAC  ${r.path || 'two-step'}  ${r.stage}${r.lastError ? `  ! ${String(r.lastError.message || r.lastError).slice(0, 90)}` : ''}`);
  }
  process.exit(0);
}

if (mode === 'tick') {
  const open = () => ux.list(pubHex).filter((r) => !IN_DONE.includes(r.stage) && !IN_HELD.includes(r.stage));
  for (let pass = 0; ; pass++) {
    if (!open().length) { table(); die('nothing left to move on', 0); }
    await stepIn({ ux, pub: pubHex, withKey: async (fn) => fn(T), priv: () => priv, planOf, alive: () => true, on: { minted: (r) => console.log(`  minted: ${r.id.slice(0, 10)}… (${fmtTac(r.source?.amount ?? 0)} TAC is in the pool)`), burnSent: (r) => console.log(`  burn sent: ${r.id.slice(0, 10)}…`) } });
    table();
    if (!WATCH) process.exit(0);
    await new Promise((r) => setTimeout(r, 60000));
  }
}

// plan / start: the candidate notes are the inventory's bridgeable ones, opened from the chain with the key (the bridge needs each note's blinding)
const inv = JSON.parse(readFileSync(INV, 'utf8')).filter((r) => r.cls === 'bridgeable').sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : 0));
const started = new Set(ux.list(pubHex).map((r) => r.id));
const todo = inv.filter((r) => !started.has(`${r.txid}:${r.vout}`) && !ux.isReserved(r.txid, r.vout));
console.log(`${inv.length} notes the bridge can carry (${fmtTac(inv.reduce((a, r) => a + BigInt(r.amount), 0n))} TAC) in the inventory; ${inv.length - todo.length} already started or reserved; ${todo.length} to go`);
if (!todo.length) { table(); process.exit(0); }

const BASES = ['https://mempool.bitaroo.net/api', 'https://mempool.emzy.de/api', 'https://blockstream.info/api'];
let turn = 0;
async function ex(path) {
  for (let pass = 0; pass < 5; pass++) {
    for (let k = 0; k < BASES.length; k++) {
      try { const r = await fetch(BASES[(turn + k) % BASES.length] + path, { signal: AbortSignal.timeout(25000) }); if (r.ok) { turn++; return await r.json(); } if (r.status === 404) return null; } catch { /* the next */ }
      await new Promise((x) => setTimeout(x, 400));
    }
    await new Promise((x) => setTimeout(x, 4000 * (pass + 1)));
  }
  throw new Error('explorers unreachable');
}
const hexB = (h) => Uint8Array.from(String(h).match(/../g).map((x) => parseInt(x, 16)));
async function openNote(r) {
  const tx = await ex('/tx/' + r.txid);
  const env = T.txOutputEnvelope(tx);
  const dec = env && (env.opcode === 0x22 ? T.decodeCXferBppPayload(env.payload) : env.opcode === 0x23 ? T.decodeCXferPayload(env.payload) : null);
  if (!dec || tx.vin.length < 2) throw new Error('not a transfer this tool can open');
  const f = tx.vin[1], le = new Uint8Array(4); new DataView(le.buffer).setUint32(0, f.vout >>> 0, true);
  const out = dec.outputs[r.vout];
  const rev = Uint8Array.from([...hexB(f.txid)].reverse()), anchorBytes = new Uint8Array(36); anchorBytes.set(rev, 0); anchorBytes.set(le, 32);
  const o = T.openTransferOutput({ priv, pub: T.wallet.pub, senderPubHex: (f.witness && f.witness.length === 2 && f.witness[1].length === 66) ? f.witness[1] : null, anchorBytes, vout: r.vout, ct: out.encryptedAmount, commitment: out.commitment });
  if (!o) throw new Error('this key cannot open the note');
  const status = tx.status || {};
  return { txid: r.txid, vout: r.vout, sats: 546, assetId: TAC_BTC_ID, amount: BigInt(o.amount), blinding: BigInt(o.blinding), confirmed: !!status.confirmed, height: status.block_height, stealth: false, stealthTweakedSk: null, form: 'tacit', p2tr: false };
}

const chosen = todo.slice(0, COUNT);
let coins;
try { coins = await T.pickSafeCommitSats(await T.getUtxos(addr)); } catch (e) { die(`could not read this key's free Bitcoin coins: ${String(e.message || e).slice(0, 160)}`); }
const coinList = Array.isArray(coins) ? coins : [coins].filter(Boolean);
console.log(`free Bitcoin coins for fees: ${coinList.length} (${coinList.reduce((s, c) => s + Number(c.value || 0), 0).toLocaleString('en-US')} sats)`);
if (!coinList.length) die('this key has no free Bitcoin coins to pay fees with: nothing done');
let sats = 0, ok = 0;
for (const [i, r] of chosen.entries()) {
  const label = `${r.txid.slice(0, 10)}…:${r.vout} ${fmtTac(r.amount)} TAC`;
  let rv;
  try {
    const note = await openNote(r);
    if (note.amount !== BigInt(r.amount)) throw new Error('the note opens to a different amount than the inventory said');
    console.log(`[${i + 1}/${chosen.length}] checking ${label} with the bridge (its trace takes about a minute)…`);
    rv = await review(T, { note, walletPub: T.wallet.pub, coins });
  } catch (e) { console.log(`  ${label}: could not be checked: ${String(e.message || e).slice(0, 160)}`); continue; }
  if (!rv.ok) { console.log(`  ${label}: the bridge will not take it: ${(rv.pf?.steps || []).filter((s) => !s.ok).map((s) => `${s.name}: ${String(s.detail || '').slice(0, 100)}`).join('; ') || 'not ok'}`); continue; }
  const rate = rv.one ? rv.pf.burnFeeRate : rv.pf.migrateFeeRate;
  console.log(`  ${label}: ${rv.one ? 'one burn (reflected)' : 'two steps (move, then burn)'}, about ${rv.cost.fee.toLocaleString('en-US')} sats at ${Math.round(rate)} sat/vB${rv.cost.later ? ` plus ${rv.cost.later.toLocaleString('en-US')} sats for the burn after` : ''}${rv.short ? '  — NOT ENOUGH free coins' : ''}`);
  if (rv.short) continue;
  sats += rv.cost.fee + (rv.cost.later || 0); ok++;
  if (mode === 'start' && SEND) {
    if (rate > MAX_FEE) { console.log(`  not started: ${Math.round(rate)} sat/vB is above --max-fee ${MAX_FEE}`); continue; }
    let made;
    try { made = await begin(T, { review: rv, priv }); }
    catch (e) { console.log(`  not started: ${String(e.message || e).slice(0, 200)}\n  stopping here: the notes started so far go on, and a later run starts the rest (Bitcoin allows only so many unconfirmed transactions in a chain: press again once these confirm)`); break; }
    planSet(mem, pubHex, made.id, { at: Date.now(), burn: { maxRate: burnMaxRate(rv.pf) } });
    store.flush?.();
    console.log(`  STARTED ${made.id.slice(0, 10)}… stage ${made.stage}`);
    await new Promise((x) => setTimeout(x, 3000));
  }
}
console.log(`${ok} of ${chosen.length} notes ready; about ${sats.toLocaleString('en-US')} sats in fees for them${mode === 'start' && SEND ? '' : ' (nothing sent)'}`);
if (mode === 'start' && SEND) table();
store.flush?.();
process.exit(0);
