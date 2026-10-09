#!/usr/bin/env node
// dapp/burndep-ux.js: the burn-deposit bridge state machine. Drives a full migrate -> burn -> mint cycle
// against a real wallet + real cryptography (the same fixture pattern tests/burn-deposit-reveal.test.mjs
// uses) with the network layer (worker endpoints, MARA, chain broadcast/UTXO selection, bridgeMint) stubbed
// by an in-memory "world" whose confirmation state advances under the test's own control.
//
// Run: node tests/burndep-ux.test.mjs
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeBurnDepositUx, BURNDEP_BETA_CAP_RAW } from '../dapp/burndep-ux.js';
import { makeBurnDepositKit, classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { ripemd160 } from '../dapp/vendor/tacit-deps.min.js';
import { verifySchnorr } from '../dapp/bulletproofs.js';
import { recoverClaimDigest } from '../dapp/bridge-recover.js';
import { makeConfidentialBridgeMint } from '../dapp/confidential-bridge-mint.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeBridgeMintRecovery } from '../dapp/bridge-mint-recovery.js';

let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const hmacFn = (h, k, ...m) => hmac(nobleSha256, k, Buffer.concat(m.map((x) => Buffer.from(x))));
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const kit = makeBurnDepositKit({ secp, keccak256: keccak_256, sha256 });

const stripHex = (h) => String(h).replace(/^0x/, '');
const revHex = (h) => stripHex(h).match(/../g).reverse().join('');
const withHex = (h) => '0x' + stripHex(h);
const hexToBytes = (h) => { const s = stripHex(h); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; };
const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
// The real hash160-based p2wpkh script, matching dapp/bitcoin-taproot-wallet.js exactly — needed only for the
// preflight() ownership check, which (unlike the rest of this world's stubbed chain state) runs the app's
// actual p2wpkhScript rather than a stand-in.
const realWpkhSpkHexOf = (pub) => bytesToHex(new Uint8Array([0x00, 0x14, ...ripemd160(sha256(pub))]));

// ---- load dapp/tacit.js under a DOM shim for the pure cxfer/BPP helpers only (see burn-deposit-reveal.js's
// own header comment on why only these, never anything wallet-stateful, come from tacit.js) ----
const realFetch = globalThis.fetch, realST = globalThis.setTimeout, realCT = globalThis.clearTimeout;
await import('../scratchpad/domshim2.mjs');
globalThis.setTimeout = realST; globalThis.clearTimeout = realCT;
const tacit = await import('../dapp/tacit.js');
const { encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf, encryptAmount, signSchnorr, modN } = tacit;
globalThis.fetch = realFetch;

const ASSET = withHex('a5'.repeat(32));
const WALLET_PRIV = new Uint8Array(32).fill(0x22);
const WALLET_PUB = secp.getPublicKey(WALLET_PRIV, true);
const NOTE_TXID = '5e'.repeat(31) + '02';
const NOTE_VOUT = 0;
const NOTE_AMOUNT = 900_000n, NOTE_BLINDING = 0x88888888n, NOTE_SATS = 1_000;
const FUND_TXID_1 = '61'.repeat(32);
const FUND_TXID_2 = '62'.repeat(32);
const BASE_RATE = 3;

// ---- an in-memory "world": chain state + worker/MARA endpoints, all driven by this test ----
function makeWorld() {
  const chainTxs = new Map(); // txid(display, bare) -> {confirmed, vout:[{scriptpubkey}]}
  const broadcasts = [];
  const registered = [];
  let migrateConfirmed = false, burnSubmitted = null, burnConfirmed = false, burnFolded = false, burnRegistered = false;
  let submitStatus = 'success';
  let registerConflict = false;
  // The reflection's attested state as /reflection/dump serves it: the live set (outpoint keys) and the burns it
  // recorded (destination leaves). A burn checked through /reflection/burndep/check is recorded once folded, unless
  // recordBurns is off.
  const liveKeys = new Set(), checkedDests = [];
  let recordBurns = true, noteHeight = 800, attested = 1000;
  const recoverPosts = [], recoverState = new Map();
  const chainHex = new Map();
  // A note the reflection tracks for real (its leaf in the tree, its live entry with the true commitment hash and the
  // zero auth key of a P2WPKH output), and the reflected burns the attested state has recorded.
  let reflectedNote = null, recordReflected = true;
  const reflectedDests = [];

  const wpkhSpkOf = (pub) => bytesToHex(new Uint8Array([0x00, 0x14, ...ripemd160ish(pub)]));
  // A real HASH160 isn't needed for these tests — only byte-equality between "what the source pays" and
  // "what the wallet's own p2wpkhScript computes" matters, and both sides go through this same stand-in.
  function ripemd160ish(pub) { return sha256(pub).subarray(0, 20); }

  chainTxs.set(NOTE_TXID, { confirmed: true, vout: [{ scriptpubkey: wpkhSpkOf(WALLET_PUB).replace(/^0x/, '') }] });

  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    const json = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });

    if (u.hostname === 'slipstream.mara.com') {
      if (u.pathname === '/api/transactions') { broadcasts.push({ mara: body.tx_hex }); return json({ status: submitStatus, message: submitStatus }); }
      if (u.pathname === '/api/rates') return json({ market_rate: 1, effective_rate: 1, submit_fee_rate: 1, multiplier: 1, discounted_multiplier: 1, multiplier_discount_percent: 0, slipstream_rate: 1 });
      throw new Error('world: unstubbed MARA path ' + u.pathname);
    }

    if (u.pathname === '/reflection/burndep/trace') {
      // One hop: whatever note is being traced was produced by a cxfer whose first input is the ORIGINAL
      // source note — good enough for both the initial trace (asset id's own etch path is irrelevant to
      // burndep-ux's own logic) and the migrate-confirmed -> traced hop.
      return json({ ok: true, hops: 1, bundle: { etch: { tx: '0x00', blockHash: 'aa'.repeat(32) }, cxfers: [{ tx: '0x00', txid: withHex('bb'.repeat(32)), inputs: [{ prevTxid: withHex(NOTE_TXID), prevVout: 0 }], outputs: [], rangeProof: '0x', kernelSig: '0x' }] } });
    }
    if (u.pathname === '/reflection/burndep/check') {
      const d = body && body.burnTxHex ? classifyConfidentialTx(withHex(body.burnTxHex)) : null;
      if (d && d.dest) checkedDests.push(String(d.dest).toLowerCase());
      return json({ ok: true, admitted: true, reason: 'admitted' });
    }
    if (u.pathname === '/reflection/dump') {
      const dests = [...(burnFolded && recordBurns ? checkedDests : []), ...(recordReflected ? reflectedDests : [])];
      const live = [...liveKeys].map((k) => [k, '0x00', ASSET, '0x00', 0]);
      const noteLeaves = ['0x' + '01'.repeat(32)];
      if (reflectedNote) { live.push(reflectedNote.triple); noteLeaves.push(reflectedNote.leaf); }
      return json({ attestedHeight: attested, snapshot: { height: attested, noteLeaves, liveTriples: live.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1)), spentLinks: [],
        burnNodes: [['0x' + '00'.repeat(32), '0x' + '00'.repeat(32), '0x' + '00'.repeat(32), true], ...dests.map((d) => ['0x' + '11'.repeat(32), '0x' + '00'.repeat(32), d, true])],
        pendingDepositRecords: [] } });
    }
    if (u.pathname === '/bridge/recover') {
      if (opts && opts.method === 'POST') {
        recoverPosts.push(body);
        if (!recoverState.has(body.burnTxid)) recoverState.set(body.burnTxid, { status: 'queued', txid: null });
        return json({ ok: true, ...recoverState.get(body.burnTxid) });
      }
      const c = recoverState.get(stripHex(u.searchParams.get('burn') || ''));
      return json(c ? { ok: true, ...c } : { ok: true, status: 'none' });
    }
    if (u.pathname === '/reflection/burndep') {
      // A first-writer-wins conflict against a DIFFERENT bundle already stored for this exact burn txid — an
      // identical resubmission is never modeled here since the real door returns 200 {ok:true} for that case
      // and this world's default (registerConflict=false) already does the same.
      if (registerConflict) return json({ ok: false, error: 'a different bundle is already registered for this burn txid' }, 409);
      registered.push(body); burnRegistered = true; return json({ ok: true, stored: 'k' });
    }
    if (u.pathname === '/reflection/burndep/status') {
      const txid = u.searchParams.get('txid');
      if (txid === undefined) throw new Error('world: status needs txid');
      if (stripHex(txid) === stripHex(burnSubmitted || '')) {
        if (burnFolded) return json({ ok: true, status: 'folded', burnBlockHeight: 900 });
        if (burnConfirmed) return json({ ok: true, status: burnRegistered ? 'pending' : 'awaiting-scan', burnBlockHeight: 900, registered: burnRegistered });
        return json({ ok: true, status: 'unconfirmed' });
      }
      // any other txid queried is a migrate-reveal-shaped check: confirmed, it is no burn (and, as every confirmed answer, names its block)
      return json(migrateConfirmed ? { ok: true, status: 'not-a-burn-deposit', burnBlockHeight: noteHeight } : { ok: true, status: 'unconfirmed' });
    }
    if (u.pathname === '/reflection/status') {
      return json({ network: 'mainnet', attestedHeight: attested, tipHeight: attested, lagBlocks: 0 });
    }
    if (u.pathname.startsWith('/chain/tx/') && u.pathname.endsWith('/hex')) {
      const id = stripHex(u.pathname.slice('/chain/tx/'.length, -'/hex'.length));
      if (!chainHex.has(id)) return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
      return { ok: true, status: 200, json: async () => ({}), text: async () => chainHex.get(id) };
    }
    if (u.pathname.startsWith('/chain/tx/')) {
      const txid = u.pathname.slice('/chain/tx/'.length);
      const rec = chainTxs.get(stripHex(txid));
      // Once the migrate confirms, its reveal (the burn-home) is on chain; its script is set by setBurnHomeOnChain.
      if (!rec && migrateConfirmed) return json({ status: { confirmed: true, block_height: noteHeight }, vout: [] });
      if (!rec) throw new Error('world: unknown chain tx ' + txid);
      return json({ status: { confirmed: rec.confirmed, block_height: noteHeight }, vout: rec.vout, vin: rec.vin || [] });
    }
    throw new Error('world: unstubbed path ' + u.pathname + ' ' + u.hostname);
  };

  const chain = {
    getUtxos: async (addr) => [{ txid: FUND_TXID_2, vout: 0, value: 5_000 }],
    pickSafeCommitSats: async (utxos) => utxos,
    broadcast: async (hex) => { broadcasts.push({ chain: hex }); return 'txid'; },
    broadcastWithRetry: async (hex) => { broadcasts.push({ chain: hex }); return 'txid'; },
    getFeeRate: async () => BASE_RATE,
  };

  const bridgeMintCalls = [];
  const realBm = makeConfidentialBridgeMint({ pool, ct: makeConfidentialTransfer({ keccak256: keccak_256 }) });
  const bridgeMint = {
    buildBridgeBurnEnvelope: realBm.buildBridgeBurnEnvelope, sourceLeaf: realBm.sourceLeaf,
    // Mirrors confidential-bridge-mint.js's own recovery check (lines 211-212) — a stub that accepts anything
    // is exactly how the wrong { ownerPub, secret } shape here shipped unnoticed: nothing caught it short of a
    // real mint against the live module.
    bridgeMint: async (args) => {
      const r = args.recovery;
      if (!r || (!r.seedDerived && r.ownerPub == null)) throw new Error("bridge-mint: pass recovery { ownerPub, secret } or { seedDerived: true } so the minted note stays recoverable");
      bridgeMintCalls.push(args);
      // Mirrors confidential-relay.js's real shape: onJob once the job is accepted, onUpdate as its status
      // moves — the only way a caller finds out this call isn't hung during the tens of seconds a real mint
      // spends fetching a multi-MB snapshot and waiting on network proving.
      // A caller settling it itself gets the relay's proof to send, and its own transaction is the mint's.
      if (args.selfSettle) {
        const x = await args.selfSettle({ jobId: 'job-self', publicValues: '0x' + '0a'.repeat(32), proof: '0x' + '0b'.repeat(32), memos: [] });
        return { jobId: 'job-self', ...x };
      }
      const w = args.waitOpts || {};
      if (w.onJob) w.onJob('job1', 'bridgemint');
      if (w.onUpdate) { w.onUpdate({ status: 'pending' }); w.onUpdate({ status: 'proving' }); w.onUpdate({ status: 'settled' }); }
      return { jobId: 'job1', txHash: '0x' + 'cd'.repeat(32) };
    },
  };

  return {
    fetchImpl, chain, bridgeMint, broadcasts, registered, bridgeMintCalls, recoverPosts,
    setRecoverStatus: (burn, status, txid = null) => recoverState.set(burn, { status, txid }),
    setMigrateConfirmed: (v) => { migrateConfirmed = v; },
    setBurnSubmitted: (txid) => { burnSubmitted = txid; },
    setBurnConfirmed: (v) => { burnConfirmed = v; },
    setBurnFolded: (v) => { burnFolded = v; },
    setBurnHomeOnChain: (txid, spkHex) => chainTxs.set(stripHex(txid), { confirmed: true, vout: [{ scriptpubkey: stripHex(spkHex) }] }),
    setSubmitStatus: (s) => { submitStatus = s; },
    setRegisterConflict: (v) => { registerConflict = v; },
    setLive: (txid, vout) => liveKeys.add(String(pool.outpointKey(withHex(stripHex(txid).match(/../g).reverse().join('')), vout)).toLowerCase()),
    setRecordBurns: (v) => { recordBurns = v; },
    setReflectedNote: ({ txid, vout, value, blinding, asset = ASSET, authKey = '0x' + '00'.repeat(32), bound = false }) => {
      const { cx, cy } = pool.commitXY(value, blinding);
      reflectedNote = { leaf: pool.btcNoteLeaf(asset, cx, cy, authKey), triple: [String(pool.outpointKey(withHex(revHex(txid)), vout)).toLowerCase(), pool.commitmentHash(cx, cy), asset, authKey, bound ? 1 : 0] };
    },
    // The attested state records a reflected burn: its destination, read from the reveal the way the reflection reads it.
    foldReflected: (revealHex) => { const d = classifyConfidentialTx(withHex(revealHex)); if (d && d.dest) reflectedDests.push(String(d.dest).toLowerCase()); },
    setRecordReflected: (v) => { recordReflected = v; },
    setChainTx: (txid, { confirmed = true, vout = [], vin = [] } = {}) => chainTxs.set(stripHex(txid), { confirmed, vout, vin }),
    setChainHex: (txid, hex) => chainHex.set(stripHex(txid), stripHex(hex)),
    setNoteHeight: (h) => { noteHeight = h; },
    setAttested: (h) => { attested = h; },
  };
}

function makeMemStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
    get length() { return m.size; },
    key: (i) => Array.from(m.keys())[i] ?? null,
    _raw: m,
  };
}

function makeUx(world, storage, extra = {}) {
  return makeBurnDepositUx({
    ...extra,
    network: 'signet', hrp: 'tb', workerBase: 'https://worker.example', fetchImpl: world.fetchImpl, storage,
    secp, sha256, keccak256: keccak_256, hmac: hmacFn, pool, bridgeMint: world.bridgeMint,
    chainBindingHex: () => '7c'.repeat(32), tacAssetId: ASSET, chain: world.chain,
    encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf, encryptAmount, signSchnorr, modN,
  });
}

// ==== eligibility ====
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  const holdings = [
    { txid: NOTE_TXID, vout: 0, assetId: ASSET, amount: NOTE_AMOUNT, confirmed: true },
    { txid: 'aa'.repeat(32), vout: 0, assetId: ASSET, amount: BURNDEP_BETA_CAP_RAW + 1n, confirmed: true },
    { txid: 'bb'.repeat(32), vout: 0, assetId: withHex('ff'.repeat(32)), amount: 1n, confirmed: true },
    { txid: 'cc'.repeat(32), vout: 0, assetId: ASSET, amount: 1n, confirmed: false },
    { txid: 'dd'.repeat(32), vout: 0, assetId: ASSET, amount: 1n, confirmed: true, stealth: true },
    { txid: 'd1'.repeat(32), vout: 0, assetId: ASSET, amount: 1n, confirmed: true, stealth: true, stealthTweakedSk: bytesToHex(new Uint8Array(32).fill(0x33)) },
    // dapp/tacit.js's real bridge-eth click handler passes a holding's assetId bare-hex (its button's own
    // data-aid) while tacAssetId itself is wired in 0x-prefixed (_burndepUxSingleton) — a real note must not
    // be called "not TAC" just because the two sides disagree on a leading 0x.
    { txid: 'ee'.repeat(32), vout: 0, assetId: stripHex(ASSET), amount: 1n, confirmed: true },
  ];
  const list = ux.eligibleNotes(holdings);
  ok(list[0].eligible === true, 'an ordinary confirmed TAC note under the cap is eligible');
  ok(list[1].eligible === false && /1,000 TAC/.test(list[1].reason), 'a note over the cap is ineligible with a clear reason');
  ok(list[2].eligible === false && list[2].reason === 'not TAC', 'a non-TAC note is ineligible');
  ok(list[3].eligible === false && list[3].reason === 'unconfirmed', 'an unconfirmed note is ineligible');
  ok(list[4].eligible === false && /stealth/.test(list[4].reason), 'a stealth-received note with no recovered spend key is ineligible (defensive fallback — scanHoldings should never actually produce this)');
  ok(list[5].eligible === true && list[5].stealthTweakedSk, 'a stealth-received note WITH its spend key is eligible — bridging a stealth note is supported, not blanket-excluded');
  ok(list[6].eligible === true, 'a bare-hex TAC assetId is still recognized as TAC against a 0x-prefixed tacAssetId');
  ok(n > 0, 'eligibleNotes checks ran');
}

// ==== stealth-received note: it sits on chain at P2WPKH(stealthPub), not P2WPKH(WALLET_PUB) — preflight's
// ownership check and start()'s signing must both use the note's own tweaked key (carried as
// note.stealthTweakedSk, exactly as eligibleNotes documents), never walletPriv itself. The deep cryptographic
// proof that ONLY the note's own input signs under the alternate key (funding/envelope/change/burn-home all
// stay on walletPriv) lives in tests/burn-deposit-reveal.test.mjs; this checks the integration wiring above it.
{
  const world = makeWorld();
  const STEALTH_PRIV = new Uint8Array(32).fill(0x44); // stands in for a real tweaked_sk = walletPriv + b mod N
  const stealthPub = secp.getPublicKey(STEALTH_PRIV, true);
  const STEALTH_NOTE_TXID = '5e'.repeat(31) + '09';
  world.setBurnHomeOnChain(STEALTH_NOTE_TXID, realWpkhSpkHexOf(stealthPub)); // the note's REAL on-chain script
  const storage = makeMemStorage();
  const ux = makeUx(world, storage);
  const stealthNote = { txid: STEALTH_NOTE_TXID, vout: 0, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING, stealthTweakedSk: bytesToHex(STEALTH_PRIV) };

  const pfMissingKey = await ux.preflight({ note: { ...stealthNote, stealthTweakedSk: undefined }, walletPub: WALLET_PUB });
  const ownStepMissing = pfMissingKey.steps.find((s) => s.name === 'source-ownership');
  ok(!!ownStepMissing && ownStepMissing.ok === false, "sanity: without stealthTweakedSk, preflight checks ownership against walletPub and correctly rejects this note (proves the check below isn't vacuously true)");

  const pf = await ux.preflight({ note: stealthNote, walletPub: WALLET_PUB });
  const ownStep = pf.steps.find((s) => s.name === 'source-ownership');
  ok(!!ownStep && ownStep.ok === true, "preflight's ownership check passes against the note's OWN tweaked pubkey when stealthTweakedSk is present");

  const r = await ux.start({ note: stealthNote, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  ok(r.stage === 'migrate-signed', 'start() builds and signs a migrate for a stealth-received note without throwing');
  const stealthPubHex = bytesToHex(stealthPub).slice(2).toLowerCase();
  ok(r.migrate.revealHex.toLowerCase().includes(stealthPubHex), "the signed migrate reveal's witness carries the note's own stealth pubkey (full per-input signing proof lives in tests/burn-deposit-reveal.test.mjs)");
}

// ==== full happy path: migrate-signed -> ... -> minted ====
let rec;
{
  const world = makeWorld();
  const storage = makeMemStorage();
  const ux = makeUx(world, storage);

  rec = await ux.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE,
  });
  ok(rec.stage === 'migrate-signed', 'start() produces a migrate-signed record');
  ok(broadcastsSoFar(world) === 0, 'start() signs but does not broadcast anything');
  const beforeAdvance = storage._raw.get(Array.from(storage._raw.keys())[0]);
  ok(typeof beforeAdvance === 'string' && beforeAdvance.length > 0, 'the record is journalled before any broadcast happens');

  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'migrate-sent', 'advance() broadcasts the migrate commit+reveal and moves to migrate-sent');
  ok(world.broadcasts.length === 2 && world.broadcasts.every((b) => b.chain), 'both the commit and reveal were broadcast via chain.broadcastWithRetry');

  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'migrate-sent', 'advance() stays at migrate-sent while unconfirmed');
  world.setMigrateConfirmed(true);
  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'migrate-confirmed', 'advance() moves to migrate-confirmed once the reveal confirms');

  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'traced' && Array.isArray(rec.bundle.cxfers), 'advance() traces the burn-home and moves to traced');

  world.setBurnHomeOnChain(rec.burnHome.txid, rec.burnHome.spk);
  await assert.rejects(() => ux.advance(rec.walletPub, rec.id), /needs the wallet key/, 'advancing past traced without walletPriv is refused');
  rec = await ux.advance(rec.walletPub, rec.id, { walletPriv: WALLET_PRIV });
  ok(rec.stage === 'burn-signed' && rec.envelope && rec.dest, 'advance() with the key signs the burn and moves to burn-signed');
  ok(!JSON.stringify(rec, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).toLowerCase().includes(Buffer.from(WALLET_PRIV).toString('hex')), 'the wallet private key never appears in the journalled record');
  ok(!storageContainsPrivkey(storage, WALLET_PRIV), 'the wallet private key never appears anywhere in storage');

  world.setBurnSubmitted(rec.burn.txid);
  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'burn-submitted', 'advance() submits to MARA and moves to burn-submitted');
  ok(world.broadcasts.some((b) => b.mara), 'the burn was submitted to slipstream');

  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'burn-submitted', 'advance() stays at burn-submitted while unconfirmed');
  world.setBurnConfirmed(true);
  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'burn-mined', 'advance() moves to burn-mined once the burn confirms');

  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'registered' && world.registered.length === 1, 'advance() registers the bundle and moves to registered');

  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'registered', 'advance() stays at registered until the reflection folds it');
  world.setBurnFolded(true);
  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'folded', 'advance() moves to folded once the reflection folds the burn');

  await assert.rejects(() => ux.advance(rec.walletPub, rec.id), /needs the wallet key/, 'minting without walletPriv is refused');
  const progressed = [];
  rec = await ux.advance(rec.walletPub, rec.id, { walletPriv: WALLET_PRIV, onProgress: (p) => progressed.push(p) });
  ok(rec.stage === 'minted', 'advance() with the key mints and reaches the terminal stage');
  ok(world.bridgeMintCalls.length === 1, 'bridgeMint.bridgeMint was called exactly once');
  ok(progressed.some((p) => p.phase === 'fetching-snapshot'), 'onProgress fires before the mint is built, not just at the end');
  ok(progressed.some((p) => p.phase === 'submitted' && p.jobId === 'job1'), "onProgress relays the relay's own onJob (jobId)");
  ok(['pending', 'proving', 'settled'].every((s) => progressed.some((p) => p.phase === 'status' && p.status === s)), "onProgress relays every real status the relay's onUpdate reports, not just the final one");

  const mintArgs = world.bridgeMintCalls[0];
  ok(mintArgs.recovery && mintArgs.recovery.seedDerived === true, "bridgeMint is called with recovery: { seedDerived: true } — dest.blinding came from deriveBridgeMintBlinding, not a memo-sealed secret");
  const expectedSpentTxid = withHex(revHex(rec.burnHome.txid));
  ok(mintArgs.spentTxid.toLowerCase() === expectedSpentTxid.toLowerCase() && mintArgs.spentVout === 0, 'bridgeMint is called with the burn-home outpoint in internal byte order');
  const expectedLeaf = pool.leaf(ASSET, rec.burnHome.cx, rec.burnHome.cy, pool.outpointKey(mintArgs.spentTxid, mintArgs.spentVout));
  const expectedNullifier = pool.nullifier(expectedLeaf);
  ok(rec.envelope.nullifier.toLowerCase() === expectedNullifier.toLowerCase(), "the burn's own envelope nullifier matches sourceLeaf's class-0 formula (confidential-bridge-mint.js) computed independently here");
  const kitLeaf = kit.burnDepositLeaf(ASSET, rec.burnHome.cx, rec.burnHome.cy, mintArgs.spentTxid, mintArgs.spentVout);
  ok(kitLeaf.toLowerCase() === expectedLeaf.toLowerCase(), 'kit.burnDepositLeaf and pool.leaf(...,pool.outpointKey(...)) agree on the same burned-note leaf formula');
  ok(mintArgs.dest.owner.toLowerCase() === rec.dest.owner.toLowerCase() && mintArgs.dest.value === rec.dest.value, 'bridgeMint is called with the exact destination the burn envelope committed to');

  await assert.rejects(() => ux.advance(rec.walletPub, 'no-such-id'), /no bridge record/, 'advancing an unknown record id is refused');

  // ==== recoverFromTxid into an already-folded status: the exact crash a real user hit ("Cannot read
  // properties of undefined (reading 'index')") when their local journal was rebuilt from the burn txid after
  // the bridge had already folded elsewhere. recoverFromTxid never computed `dest`, and the folded->minted
  // handler reads rec.dest.index unconditionally. dest is fully re-derivable from the wallet key alone, so a
  // freshly recovered record must carry the exact same one the original flow computed. ====
  {
    // Layered over the same world: its /reflection/burndep/status stub only ever answers {status}, since
    // nothing else in this file needs `note`/`assetId` — recoverFromTxid specifically needs both to identify
    // which asset and which burn-home a bare txid belongs to.
    const recoverFetch = async (url, opts) => {
      const u = new URL(url);
      if (u.pathname === '/reflection/burndep/status' && stripHex(u.searchParams.get('txid') || '') === stripHex(rec.burn.txid)) {
        const base = await (await world.fetchImpl(url, opts)).json();
        const withExtra = { ...base, note: { txid: withHex(rec.burnHome.txid), vout: 0 }, assetId: ASSET };
        return { ok: true, status: 200, json: async () => withExtra, text: async () => JSON.stringify(withExtra) };
      }
      return world.fetchImpl(url, opts);
    };
    const ux2 = makeUx({ ...world, fetchImpl: recoverFetch }, makeMemStorage()); // a fresh browser: no journal, recovering purely from the txid

    world.setChainHex(rec.burnHome.txid, rec.migrate.revealHex);        // the burn-home's own transaction, as the chain serves it
    // The amount is typed by the holder: one that does not reproduce the burn-home's commitment is refused, and nothing is journalled.
    const wrongStore = makeMemStorage();
    const uxWrong = makeUx({ ...world, fetchImpl: recoverFetch }, wrongStore);
    let wrongErr = null;
    try { await uxWrong.recoverFromTxid(rec.burn.txid, WALLET_PRIV, { amount: BigInt(rec.source.amount) * 9n }); } catch (e) { wrongErr = e; }
    ok(!!wrongErr && /does not match this bridge/.test(wrongErr.message) && uxWrong.list(WALLET_PUB).length === 0, 'recoverFromTxid refuses an amount that does not open the burn-home, and journals nothing');
    const recovered = await ux2.recoverFromTxid(rec.burn.txid, WALLET_PRIV, { amount: rec.source.amount });
    ok(recovered.stage === 'folded', 'recoverFromTxid on an already-folded burn lands directly on the folded stage');
    ok(!!recovered.dest, "the recovered record carries a dest — this is exactly the field a real user hit missing (Cannot read properties of undefined (reading 'index'))");
    ok(recovered.dest.owner.toLowerCase() === rec.dest.owner.toLowerCase() && recovered.dest.blinding === rec.dest.blinding && recovered.dest.value === rec.dest.value,
      'the recovered dest is byte-identical to what the original flow computed — fully re-derived from the wallet key, nothing guessed');

    const mintedFromRecovery = await ux2.advance(recovered.walletPub, recovered.id, { walletPriv: WALLET_PRIV });
    ok(mintedFromRecovery.stage === 'minted', 'a record recovered straight into folded mints successfully — this is the exact call that used to throw');
  }

  // ==== a record already saved to storage WITHOUT dest (recoverFromTxid's gap before this fix, sitting in a
  // real browser's localStorage right now — the fix above only stops NEW records from being written this way,
  // it does nothing for one already on disk) must still mint: the 'folded' handler self-heals rather than
  // trusting rec.dest to exist. ====
  {
    const storage = makeMemStorage();
    const ux3 = makeUx(world, storage);
    // Same journal format putRecord/loadAll use internally (JOURNAL_PREFIX:network:walletPubLowercase, BigInt
    // fields wrapped as {__big}) — written directly here since a real broken record was never produced by any
    // exported call, only by code that predates this fix.
    // rec is already 'minted' by this point in the file (the happy path ran to completion above) — force it
    // back to 'folded', the actual stage a stuck record like this sits at, and drop the minted-only fields.
    const { dest, stage, mintedAt, mintedJobId, mintedTxHash, ...rest } = { ...rec, walletPub: rec.walletPub.toLowerCase() };
    const brokenRec = { ...rest, stage: 'folded' };
    const wrapBig = (k, v) => (typeof v === 'bigint' && ['amount', 'blinding', 'value'].includes(k) ? { __big: v.toString() } : v);
    storage.setItem(`tacit-burndep-bridge-v1:signet:${brokenRec.walletPub}`, JSON.stringify([brokenRec], wrapBig));

    const stuck = ux3.list(rec.walletPub).find((r) => r.id === rec.id);
    ok(!!stuck && stuck.stage === 'folded' && !stuck.dest, 'sanity: the hand-written record is folded with no dest, matching a real pre-fix save');

    const healed = await ux3.advance(rec.walletPub, rec.id, { walletPriv: WALLET_PRIV });
    ok(healed.stage === 'minted', 'advance() on a pre-existing record with no dest at all still mints — the fix self-heals rather than requiring a fresh recoverFromTxid');
    ok(!!healed.dest && healed.dest.owner.toLowerCase() === dest.owner.toLowerCase() && healed.dest.blinding === dest.blinding, 'the self-healed dest matches the original — derived, not guessed');
  }
}

// ==== resume after a simulated crash: a fresh instance, same storage, never re-signs ====
{
  const world = makeWorld();
  const storage = makeMemStorage();
  const ux1 = makeUx(world, storage);
  let r = await ux1.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE,
  });
  const migrateHexBefore = r.migrate.revealHex;
  r = await ux1.advance(r.walletPub, r.id); // migrate-sent

  // "the tab closes" — a fresh burndep-ux instance over the SAME storage picks up the record as-is.
  const ux2 = makeUx(world, storage);
  const resumed = ux2.list(r.walletPub).find((x) => x.id === r.id);
  ok(!!resumed && resumed.stage === 'migrate-sent', 'a fresh instance over the same storage sees the in-flight record');
  ok(resumed.migrate.revealHex === migrateHexBefore, 'the journalled migrate reveal is byte-identical after resume — never rebuilt');

  const before = world.broadcasts.length;
  const again = await ux2.advance(resumed.walletPub, resumed.id); // still unconfirmed -> re-sends, no state change
  ok(again.stage === 'migrate-sent', 'resuming an unconfirmed migrate stays at migrate-sent');
  ok(world.broadcasts.length > before, 'resuming an unconfirmed migrate re-sends the identical (already-journalled) bytes rather than rebuilding');
}

// ==== hop-limit refusal (post-migrate: the burn-home is always one hop deeper than its source) ====
{
  const world = makeWorld();
  world.fetchImpl0 = world.fetchImpl;
  const overLimitFetch = async (url, opts) => {
    const u = new URL(url);
    if (u.pathname === '/reflection/burndep/trace') {
      return { ok: true, json: async () => ({ ok: true, hops: 65, bundle: { etch: {}, cxfers: new Array(65).fill({ inputs: [{ prevTxid: withHex(NOTE_TXID), prevVout: 0 }] }) } }) };
    }
    return world.fetchImpl0(url, opts);
  };
  const storage = makeMemStorage();
  const ux = makeUx({ ...world, fetchImpl: overLimitFetch }, storage);
  let r = await ux.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE,
  });
  r = await ux.advance(r.walletPub, r.id);
  world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); // -> migrate-confirmed
  await assert.rejects(() => ux.advance(r.walletPub, r.id), /over the 64-hop limit/, 'refuses a hop-limit violation');
  ok(true, 'a burn-home tracing over the hop limit is refused rather than silently proceeding');
}

// ==== hop-limit boundary: a source note at exactly the 63-hop preflight limit produces a burn-home at exactly
// 64 hops (the migrate itself is one more hop), and neither check may reject the other's own limit ====
{
  const world = makeWorld();
  world.setBurnHomeOnChain(NOTE_TXID, realWpkhSpkHexOf(WALLET_PUB)); // preflight's ownership check needs the real hash160, not the world's cheap stand-in
  world.fetchImpl0 = world.fetchImpl;
  let burnHomeTxidForMock = null;
  const boundaryFetch = async (url, opts) => {
    const u = new URL(url);
    if (u.pathname === '/reflection/burndep/trace') {
      const body = JSON.parse(opts.body);
      const tracedTxid = stripHex(body.note.txid);
      const hops = burnHomeTxidForMock && tracedTxid === stripHex(burnHomeTxidForMock) ? 64 : 63;
      return { ok: true, json: async () => ({ ok: true, hops, bundle: { etch: {}, cxfers: new Array(hops).fill({ inputs: [{ prevTxid: withHex(NOTE_TXID), prevVout: 0 }] }) } }) };
    }
    return world.fetchImpl0(url, opts);
  };
  const storage = makeMemStorage();
  const ux = makeUx({ ...world, fetchImpl: boundaryFetch }, storage);

  const pf = await ux.preflight({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPub: WALLET_PUB });
  const traceStep = pf.steps.find((s) => s.name === 'trace');
  ok(!!traceStep && traceStep.ok, 'preflight accepts a source note at exactly the 63-hop limit');

  let r = await ux.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE,
  });
  burnHomeTxidForMock = r.burnHome.txid;
  r = await ux.advance(r.walletPub, r.id); // migrate-sent
  world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); // migrate-confirmed
  r = await ux.advance(r.walletPub, r.id); // -> traced (must NOT be refused at exactly 64 hops)
  ok(r.stage === 'traced' && r.hops === 64, "a 64-hop burn-home — one more than its source's own 63 — is accepted, not refused as if it shared the source's limit");
}

// ==== cap refusal in start() ====
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  await assert.rejects(
    () => ux.start({
      note: { txid: NOTE_TXID, vout: 0, sats: NOTE_SATS, amount: BURNDEP_BETA_CAP_RAW + 1n, blinding: NOTE_BLINDING },
      walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 },
    }),
    /over the beta cap/,
    'refuses over-cap',
  );
  ok(true, 'start() refuses a note over the beta cap before signing anything');
}

// ==== MARA refusal is surfaced, not silently swallowed ====
{
  const world = makeWorld();
  world.setSubmitStatus('error');
  const storage = makeMemStorage();
  const ux = makeUx(world, storage);
  let r = await ux.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE,
  });
  r = await ux.advance(r.walletPub, r.id);
  world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id);
  r = await ux.advance(r.walletPub, r.id);
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV }); // burn-signed
  await assert.rejects(() => ux.advance(r.walletPub, r.id), /slipstream submit refused/, 'a MARA status!==success response is surfaced as a real error, not treated as submitted');
  const stillAt = ux.list(r.walletPub).find((x) => x.id === r.id);
  ok(stillAt.stage === 'burn-signed', 'a refused MARA submission does not advance the stage');
}

// ==== a registration conflict against a DIFFERENT already-stored bundle propagates rather than being swallowed
// (the worker's own door already treats an identical resubmission as a no-op 200, so anything advance() sees
// thrown here is a genuine, unresolvable conflict) — and advance() records/clears lastError+errorCount so a
// background poller has somewhere to surface a bridge that can never proceed on its own ====
{
  const world = makeWorld();
  world.setRegisterConflict(true);
  const storage = makeMemStorage();
  const ux = makeUx(world, storage);
  let r = await ux.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE,
  });
  r = await ux.advance(r.walletPub, r.id); // migrate-sent
  world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); // migrate-confirmed
  r = await ux.advance(r.walletPub, r.id); // traced
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV }); // burn-signed
  world.setBurnSubmitted(r.burn.txid);
  r = await ux.advance(r.walletPub, r.id); // burn-submitted
  world.setBurnConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); // burn-mined

  await assert.rejects(() => ux.advance(r.walletPub, r.id), /registration failed/, 'a registration conflict against a different stored bundle is thrown, not swallowed');
  let stuck = ux.list(r.walletPub).find((x) => x.id === r.id);
  ok(stuck.stage === 'burn-mined', 'the record stays at burn-mined rather than silently advancing past a failed registration');
  ok(!!stuck.lastError && /registration failed/.test(stuck.lastError.message) && stuck.errorCount === 1, 'advance() records the failure on the record itself (lastError/errorCount)');

  await assert.rejects(() => ux.advance(r.walletPub, r.id), /registration failed/, 'the same conflict is thrown again on a second attempt');
  stuck = ux.list(r.walletPub).find((x) => x.id === r.id);
  ok(stuck.errorCount === 2, 'a repeated failure increments errorCount rather than resetting it');

  world.setRegisterConflict(false);
  r = await ux.advance(r.walletPub, r.id); // registered, this time
  ok(r.stage === 'registered', 'once the conflict clears, advance() proceeds normally');
  ok(r.lastError === null && r.errorCount === 0, 'a subsequent success clears lastError/errorCount from the record');
}

// ==== cross-tab lease ====
{
  const world = makeWorld();
  const storage = makeMemStorage();
  const ux = makeUx(world, storage);
  let r = await ux.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE,
  });
  // Simulate another tab holding the lease right now.
  storage.setItem(`tacit-burndep-bridge-v1:lease:signet:${r.id}`, JSON.stringify({ owner: 'other-tab', at: Date.now() }));
  await assert.rejects(() => ux.advance(r.walletPub, r.id), /being advanced in another tab/, 'advance() refuses while another tab holds a fresh lease');
  // A stale lease (past the TTL) is treated as free.
  storage.setItem(`tacit-burndep-bridge-v1:lease:signet:${r.id}`, JSON.stringify({ owner: 'other-tab', at: Date.now() - 60_000 }));
  const advanced = await ux.advance(r.walletPub, r.id);
  ok(advanced.stage === 'migrate-sent', 'a stale lease from a crashed tab does not permanently strand the record');
}

// ==== reservation across the whole browser, not just one wallet ====
{
  const world = makeWorld();
  const storage = makeMemStorage();
  const ux = makeUx(world, storage);
  await ux.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE,
  });
  ok(ux.isReserved(NOTE_TXID, NOTE_VOUT) === true, 'the source note is reserved once a bridge exists for it');
  ok(ux.isReserved(FUND_TXID_1, 0) === true, "the migrate's own funding UTXO is reserved too, so Send can't spend it out from under the bridge");
  ok(ux.isReserved('ff'.repeat(32), 0) === false, 'an unrelated outpoint is not reserved');
}


// ==== a minted amount the recovery scan cannot guess is sealed to the key, so any device finds it ====
{
  const odd = 3712345678n;                                             // 37.12345678 TAC: not m x 10^k with m under 100
  const { world, ux, r } = await atRfolded(makeMemStorage(), { nullifierSpent: async () => false }, odd);
  await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  const call = world.bridgeMintCalls[0];
  ok(call && call.recovery && call.recovery.seedDerived !== true && call.recovery.ownerPub === '0x' + Buffer.from(WALLET_PUB).toString('hex') && /^0x[0-9a-f]{64}$/.test(call.recovery.secret),
    'an amount the scan cannot guess is minted with a memo sealed to the wallet key, not on the derived blinding alone');
  ok(pool.nkToOwner(call.recovery.secret) === call.dest.owner, 'and the sealed secret is the one the destination note is owned by');
}

// ==== the funding coin: the smallest that covers the fee, so little sits in a commit until its reveal confirms ====
{
  const ux = makeUx(makeWorld(), makeMemStorage());
  const coins = [{ txid: 'a1'.repeat(32), vout: 0, value: 90000 }, { txid: 'a2'.repeat(32), vout: 0, value: 4000 }, { txid: 'a3'.repeat(32), vout: 0, value: 12000 }, { txid: 'a4'.repeat(32), vout: 0, value: 900 }];
  ok(ux.pickFunding(coins, 3000).value === 4000, 'the smallest coin that covers the need is chosen, not the largest');
  ok(ux.pickFunding(coins, 20000).value === 90000, 'the next that covers it when the small ones do not');
  ok(ux.pickFunding(coins, 500000).value === 90000, 'the largest when none covers it, so the shortfall is reported as it was');
  ok(ux.pickFunding([], 100) === null, 'no coin, no pick');
}

// ==== TAC the reflection already tracks ====
// Preflight: a tracked source note takes the reflected path — no provenance trace, no MARA.
{
  const world = makeWorld();
  world.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: NOTE_AMOUNT, blinding: NOTE_BLINDING });
  world.setBurnHomeOnChain(NOTE_TXID, '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex'));   // the wallet's real P2WPKH
  const ux = makeUx(world, makeMemStorage());
  const pf = await ux.preflight({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPub: WALLET_PUB });
  ok(pf.ok === true && pf.path === 'reflected' && pf.burnFeeRate === BASE_RATE && !pf.steps.some((x) => x.name === 'trace' || x.name === 'mara-rates'), 'preflight routes a tracked note to the reflected path, with no trace and no MARA');
  ok(world.broadcasts.length === 0, 'preflight broadcasts nothing');
}
// A tracked note whose leaf the tree holds in an older form cannot be burned directly: preflight says so before anything is signed.
{
  const world = makeWorld();
  world.setLive(NOTE_TXID, NOTE_VOUT);                    // live, but no leaf of the burn's form in the note tree
  world.setBurnHomeOnChain(NOTE_TXID, '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex'));
  const ux = makeUx(world, makeMemStorage());
  const pf = await ux.preflight({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPub: WALLET_PUB });
  const old = pf.steps.find((x) => x.name === 'old-leaf');
  ok(pf.ok === false && !!old && old.ok === false, 'preflight refuses a tracked note whose leaf is in an older form, naming the step');
  ok(world.broadcasts.length === 0, 'and broadcasts nothing');
}
// The reflected path end to end: one standard burn of the note itself, then the class-1 mint once it is recorded.
{
  const world = makeWorld();
  const wpkh = '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex');
  world.setBurnHomeOnChain(NOTE_TXID, wpkh);
  world.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: NOTE_AMOUNT, blinding: NOTE_BLINDING });
  const ux = makeUx(world, makeMemStorage());
  const note = { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING };
  let r = await ux.startReflected({ note, walletPriv: WALLET_PRIV, feeRate: BASE_RATE });
  ok(r.stage === 'rburn-signed' && r.path === 'reflected' && world.broadcasts.length === 0, 'the burn is signed and journalled before anything is broadcast');
  const dec = classifyConfidentialTx(withHex(r.burn.hex));
  const zero = '0x' + '00'.repeat(32);
  const { cx, cy } = pool.commitXY(NOTE_AMOUNT, NOTE_BLINDING);
  const nu = pool.nullifier(pool.btcNoteLeaf(ASSET, cx, cy, zero));
  ok(dec && dec.type === 'burn' && dec.nullifier === nu && dec.target === withHex('7c'.repeat(32)), 'the reveal burns the note under its own ν (auth key zero) toward this pool');
  ok(r.mint.sourceClass === 1 && r.mint.burned.owner === zero && BigInt(r.mint.dest.value) === NOTE_AMOUNT, 'the mint is planned as class 1, the full amount, no relay fee');
  const mr = makeBridgeMintRecovery({ hmac: hmacFn, sha256, curveOrder: secp.CURVE.n });
  ok(BigInt(r.mint.dest.blinding) === BigInt(mr.deriveBridgeMintBlinding({ privkey: WALLET_PRIV, nullifier: nu })), 'the destination blinding is derived from the wallet key and ν, so the minted note is recoverable from the key');
  ok(ux.isReserved(r.burn.fundingUtxos[0].txid, r.burn.fundingUtxos[0].vout), 'the commit’s funding is reserved against other sends');
  let threw = false;
  try { await ux.startReflected({ note, walletPriv: WALLET_PRIV, feeRate: BASE_RATE }); } catch { threw = true; }
  ok(threw, 'a second bridge of the same note is refused');
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'rburn-sent' && world.broadcasts.length === 2 && world.broadcasts.every((b) => b.chain) && !world.broadcasts.some((b) => b.mara), 'commit and reveal go out through ordinary relay, never MARA');
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'rburn-sent', 'it waits for the burn to confirm');
  world.setChainTx(r.burn.txid, { confirmed: true });
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'rburn-mined' && r.burnHeight === 800, 'the confirmed burn records its height');
  world.setNoteHeight(1001);
  world.setChainTx(r.burn.txid, { confirmed: true });
  world.foldReflected(r.burn.hex);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'rfolded', 'once the attested state records its destination, it is ready to mint');
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  const call = world.bridgeMintCalls[0];
  ok(r.stage === 'minted' && call && call.sourceClass === 1 && call.burned.owner === zero && call.spentTxid === withHex(revHex(NOTE_TXID)) && call.spentVout === NOTE_VOUT && call.recovery.seedDerived === true,
    'the mint names the burned note’s outpoint as class 1 with the zero auth key, and stays recoverable from the key');
}
// A reflected burn the attested state passes without recording is not offered for minting.
{
  const world = makeWorld();
  world.setBurnHomeOnChain(NOTE_TXID, '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex'));
  world.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: NOTE_AMOUNT, blinding: NOTE_BLINDING });
  world.setRecordReflected(false);
  const ux = makeUx(world, makeMemStorage());
  let r = await ux.startReflected({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id);
  world.setChainTx(r.burn.txid, { confirmed: true });
  r = await ux.advance(r.walletPub, r.id);
  world.foldReflected(r.burn.hex);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'not-recorded' && world.bridgeMintCalls.length === 0, 'a reflected burn passed without a record is marked not mintable and never minted');
}
// The plan refuses a note whose opening does not match what the reflection tracks, before anything is signed.
{
  const world = makeWorld();
  world.setBurnHomeOnChain(NOTE_TXID, '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex'));
  world.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: NOTE_AMOUNT, blinding: NOTE_BLINDING });
  const storage = makeMemStorage();
  const ux = makeUx(world, storage);
  let threw = null;
  try { await ux.startReflected({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT + 1n, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, feeRate: BASE_RATE }); } catch (e) { threw = e; }
  ok(threw && /opening/.test(threw.message) && ux.list(Buffer.from(WALLET_PUB).toString('hex')).length === 0 && world.broadcasts.length === 0, 'a wrong opening is refused with nothing journalled or broadcast');
}
// A bridge whose burn-home is tracked pauses before its burn; its TAC goes back to the wallet.
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  let r = await ux.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id);
  world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'migrate-confirmed', 'sanity: the migrate confirmed');
  world.setLive(r.burnHome.txid, 0);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'stopped' && r.stoppedWhy === 'tracked', 'a tracked burn-home pauses the bridge before any burn is built');
  const again = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  ok(again.stage === 'stopped' && !world.broadcasts.some((b) => b.mara), 'a paused bridge never builds or sends a burn');
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  const before = world.broadcasts.length;
  r = await ux.reclaim({ rec: again, walletPriv: WALLET_PRIV });
  ok(r.stage === 'reclaim-sent' && world.broadcasts.length === before + 2, 'reclaim builds and sends the move back to the wallet (commit and reveal)');
  ok(classifyConfidentialTx(withHex(r.reclaim.revealHex))?.type === 'cxfer', 'the move back is an ordinary confidential transfer');
}
// A burn signed before the check is held back while its burn-home is tracked.
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  let r = await ux.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id); world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  ok(r.stage === 'burn-signed', 'sanity: the burn was signed while the burn-home was untracked');
  world.setLive(r.burnHome.txid, 0);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'stopped' && !world.broadcasts.some((b) => b.mara), 'a signed burn is not sent once its burn-home is tracked');
}
// A burn the reflection passed without recording is not offered for minting.
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  let r = await ux.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id); world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  world.setBurnSubmitted(r.burn.txid);
  r = await ux.advance(r.walletPub, r.id); world.setBurnConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'registered', 'sanity: registered');
  world.setRecordBurns(false); world.setBurnFolded(true);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'not-recorded', 'a burn the attested state does not record is marked not mintable instead of ready to mint');
  ok(world.bridgeMintCalls.length === 0, 'no mint is attempted for it');
}
// A record already at "ready to mint" (saved before the check) is corrected, by a click or by the background check.
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  let r = await ux.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id); world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  world.setBurnSubmitted(r.burn.txid);
  r = await ux.advance(r.walletPub, r.id); world.setBurnConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setBurnFolded(true);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'folded', 'sanity: a recorded burn reaches ready to mint');
  world.setRecordBurns(false);
  const v = await ux.verify(r.walletPub, r.id);
  ok(v.stage === 'not-recorded', 'the background check corrects a ready-to-mint record whose burn is not recorded');
  ok(world.bridgeMintCalls.length === 0, 'and never mints it');
}

// A bridge that did not complete is recovered: the wallet signs a claim that opens the burned note, and the record
// follows the claim until the TAC is sent back.
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  let r = await ux.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id); world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  world.setBurnSubmitted(r.burn.txid);
  r = await ux.advance(r.walletPub, r.id); world.setBurnConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setRecordBurns(false); world.setBurnFolded(true);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'not-recorded', 'sanity: not recorded');
  const notRecorded = r;
  let refused = false;
  try { await ux.recover({ rec: r, walletPriv: new Uint8Array(32).fill(0x23) }); } catch { refused = true; }
  ok(refused && world.recoverPosts.length === 0, 'another key cannot start a recovery for this wallet’s bridge');
  r = await ux.recover({ rec: r, walletPriv: WALLET_PRIV });
  ok(r.stage === 'recovering', 'recover starts the recovery');
  const claim = world.recoverPosts[0];
  ok(claim.burnTxid === stripHex(r.burn.txid).toLowerCase() && claim.amount === String(NOTE_AMOUNT), 'the claim names the burn and the amount it carried');
  const opened = pool.commitXY(BigInt(claim.amount), BigInt(claim.blinding));
  ok(BigInt(opened.cx) === BigInt(r.burnHome.cx) && BigInt(opened.cy) === BigInt(r.burnHome.cy), 'its opening opens the burned note');
  ok(claim.pubkey === Buffer.from(WALLET_PUB).toString('hex') && verifySchnorr(hexToBytes(claim.sig), recoverClaimDigest(sha256, claim), hexToBytes(claim.pubkey).slice(1)), 'it is signed by the wallet key');
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'recovering' && r.recover.status === 'queued', 'it waits while the claim is queued');
  world.setRecoverStatus(claim.burnTxid, 'sent', 'ab'.repeat(32));
  r = await ux.verify(r.walletPub, r.id);
  ok(r.stage === 'recovered' && r.recover.txid === 'ab'.repeat(32), 'the background check moves it to recovered, with the transaction that sent it');
  let threw = false;
  try { await ux.recover({ rec: { ...r, stage: 'folded' }, walletPriv: WALLET_PRIV }); } catch { threw = true; }
  ok(threw, 'only a bridge that did not complete can be recovered');

  // A fresh browser (no journal) rebuilds the row from the burn txid and the amount, then recovers the same way.
  const statusFetch = async (url, opts) => {
    const u = new URL(url);
    if (u.pathname === '/reflection/burndep/status' && stripHex(u.searchParams.get('txid') || '') === stripHex(notRecorded.burn.txid)) {
      const body = { ok: true, status: 'not-recorded', burnBlockHeight: 900, registered: true, note: { txid: withHex(notRecorded.burnHome.txid), vout: 0 }, assetId: ASSET };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
    return world.fetchImpl(url, opts);
  };
  world.setChainHex(notRecorded.burnHome.txid, notRecorded.migrate.revealHex);
  const fresh = makeUx({ ...world, fetchImpl: statusFetch }, makeMemStorage());
  const rebuilt = await fresh.recoverFromTxid(notRecorded.burn.txid, WALLET_PRIV, { amount: NOTE_AMOUNT });
  ok(rebuilt.stage === 'not-recorded', 'a burn the attested state did not record is rebuilt from its txid as a bridge that did not complete');
  const before = world.recoverPosts.length;
  const again = await fresh.recover({ rec: rebuilt, walletPriv: WALLET_PRIV });
  const c2 = world.recoverPosts[before];
  const opened2 = pool.commitXY(BigInt(c2.amount), BigInt(c2.blinding));
  ok((again.stage === 'recovering' || again.stage === 'recovered') && BigInt(opened2.cx) === BigInt(notRecorded.burnHome.cx) && BigInt(opened2.cy) === BigInt(notRecorded.burnHome.cy), 'its recovery claim, built from nothing but the key, the txid and the amount, opens the burned note');
}

// A one-step bridge is rebuilt from its burn transaction and the key alone: the burned note's opening comes from the transaction
// that made it, and the destination must be this key's own.
{
  const world = makeWorld();
  const wpkh = '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex');
  world.setBurnHomeOnChain(NOTE_TXID, wpkh);
  world.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: NOTE_AMOUNT, blinding: NOTE_BLINDING });
  const first = makeUx(world, makeMemStorage());
  const note = { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING };
  let orig = await first.startReflected({ note, walletPriv: WALLET_PRIV, feeRate: BASE_RATE });
  // What the chain shows of the burn: its two inputs (the envelope commit, then the note) and the raw transactions.
  world.setChainTx(orig.burn.txid, { confirmed: true, vin: [{ txid: orig.burn.commitTxid, vout: 0 }, { txid: NOTE_TXID, vout: NOTE_VOUT, prevout: { value: NOTE_SATS } }] });
  world.setChainHex(orig.burn.txid, orig.burn.hex);
  world.setChainHex(orig.burn.commitTxid, orig.burn.commitHex);
  const ownerOpens = async (txid, vout) => (stripHex(txid) === NOTE_TXID && vout === NOTE_VOUT ? { amount: NOTE_AMOUNT, blinding: NOTE_BLINDING } : null);

  // A fresh browser: no journal, only the key and the burn's txid.
  const fresh = makeUx(world, makeMemStorage(), { openNote: ownerOpens, nullifierSpent: async () => false });
  const rebuilt = await fresh.recoverFromTxid(orig.burn.txid, WALLET_PRIV);
  ok(rebuilt.stage === 'rburn-mined' && rebuilt.path === 'reflected', 'a one-step bridge is rebuilt from its burn txid alone, with no amount asked for');
  ok(JSON.stringify(rebuilt.mint, (k, v) => (typeof v === 'bigint' ? v.toString() : v)) === JSON.stringify(orig.mint, (k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    'its mint is exactly the one the original browser planned: same burned opening, same destination blinding and owner');
  ok(rebuilt.envelope.destLeaf === orig.envelope.destLeaf && rebuilt.envelope.burnId === orig.envelope.burnId, 'and names the same burn id and destination');
  ok((await fresh.recoverFromTxid(orig.burn.txid, WALLET_PRIV)).id === rebuilt.id && fresh.list(rebuilt.walletPub).length === 1, 'asking again returns the same row, not a second one');
  // It then follows the burn through the reflection and mints, like any other.
  world.setNoteHeight(1001); world.foldReflected(orig.burn.hex);
  let r = await fresh.advance(rebuilt.walletPub, rebuilt.id);
  ok(r.stage === 'rfolded', 'once the reflection records the burn it is ready to mint');
  r = await fresh.advance(rebuilt.walletPub, rebuilt.id, { walletPriv: WALLET_PRIV });
  const rc = world.bridgeMintCalls[world.bridgeMintCalls.length - 1];
  ok(r.stage === 'minted' && rc.sourceClass === 1 && BigInt(rc.burned.blinding) === NOTE_BLINDING && rc.spentVout === NOTE_VOUT, 'and mints the burned note as class 1');

  // Not this wallet's: a key that never received the note, and a key that is given the opening but is not the burn's owner.
  const other = new Uint8Array(32).fill(0x23);
  const stranger = makeUx(world, makeMemStorage(), { openNote: async () => null });
  let msg = null; try { await stranger.recoverFromTxid(orig.burn.txid, other); } catch (e) { msg = e.message; }
  ok(/does not open with this key/.test(msg || ''), 'a key that never received the note cannot rebuild it');
  const thief = makeUx(world, makeMemStorage(), { openNote: ownerOpens });
  msg = null; try { await thief.recoverFromTxid(orig.burn.txid, other); } catch (e) { msg = e.message; }
  ok(/not this wallet’s/.test(msg || '') && thief.list(Buffer.from(secp.getPublicKey(other, true)).toString('hex')).length === 0, 'a key given the opening but not named by the burn is refused, and nothing is journalled');
  // Already minted: the bridge is complete.
  const done = makeUx(world, makeMemStorage(), { openNote: ownerOpens, nullifierSpent: async () => true });
  const doneRec = await done.recoverFromTxid(orig.burn.txid, WALLET_PRIV);
  ok(doneRec.stage === 'minted', 'a bridge the pool has already minted is found complete');
  // A burn-deposit is not this kind: it still wants its amount.
  const dep = makeUx(world, makeMemStorage(), { openNote: ownerOpens });
  msg = null; try { await dep.recoverFromTxid('ab'.repeat(32), WALLET_PRIV); } catch (e) { msg = e.message; }
  ok(msg !== null, 'a transaction that is no burn is not mistaken for one');
}

// A mint the relay will not take is finished by the holder: the relay proves, the holder's own account sends the settle.
{
  // untracked TAC: the burn-deposit path, at 'folded'
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  let r = await ux.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id); world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  world.setBurnSubmitted(r.burn.txid);
  r = await ux.advance(r.walletPub, r.id); world.setBurnConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setBurnFolded(true);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'folded', 'sanity: ready to mint');
  const settles = [];
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV, selfSettle: async (x) => { settles.push(x); return { txHash: '0x' + 'ee'.repeat(32) }; } });
  ok(r.stage === 'minted' && r.mintedTxHash === '0x' + 'ee'.repeat(32) && r.mintedJobId === 'job-self', 'a self-settled mint is minted, under the holder’s own transaction');
  ok(settles.length === 1 && settles[0].publicValues === '0x' + '0a'.repeat(32) && settles[0].proof === '0x' + '0b'.repeat(32), 'the holder is handed the relay’s proof to send');
  ok(world.bridgeMintCalls.length === 1 && typeof world.bridgeMintCalls[0].selfSettle === 'function', 'the mint was asked for with the self-settle option');
}
{
  // tracked TAC: the one-step path, at 'rfolded'
  const world = makeWorld();
  world.setBurnHomeOnChain(NOTE_TXID, '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex'));
  world.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: NOTE_AMOUNT, blinding: NOTE_BLINDING });
  const ux = makeUx(world, makeMemStorage());
  let r = await ux.startReflected({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id);
  world.setChainTx(r.burn.txid, { confirmed: true });
  r = await ux.advance(r.walletPub, r.id);
  world.setNoteHeight(1001); world.setChainTx(r.burn.txid, { confirmed: true });
  world.foldReflected(r.burn.hex);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'rfolded', 'sanity: the one-step bridge is ready to mint');
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV, selfSettle: async () => ({ txHash: '0x' + 'dd'.repeat(32) }) });
  ok(r.stage === 'minted' && r.mintedTxHash === '0x' + 'dd'.repeat(32), 'the one-step bridge can be finished the same way');
}
// A one-step mint that landed without this page hearing of it is found in the pool and recorded, not built and sent again;
// and a mint that fails after landing is reconciled the same way instead of leaving the bridge 'ready to mint'.
async function atRfolded(storage, extra = {}, amount = NOTE_AMOUNT) {
  const world = makeWorld();
  world.setBurnHomeOnChain(NOTE_TXID, '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex'));
  world.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: amount, blinding: NOTE_BLINDING });
  const ux = makeUx(world, storage, extra);
  let r = await ux.startReflected({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id);
  world.setChainTx(r.burn.txid, { confirmed: true });
  r = await ux.advance(r.walletPub, r.id);
  world.setNoteHeight(1001); world.setChainTx(r.burn.txid, { confirmed: true });
  world.foldReflected(r.burn.hex);
  r = await ux.advance(r.walletPub, r.id);
  return { world, ux, r };
}
{
  const { world, ux, r } = await atRfolded(makeMemStorage(), { nullifierSpent: async () => true });
  const after = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  ok(after.stage === 'minted' && world.bridgeMintCalls.length === 0, 'a one-step mint already in the pool is recorded as minted, with nothing built or sent');
}
{
  let spent = false;
  const { world, ux, r } = await atRfolded(makeMemStorage(), { nullifierSpent: async () => spent });
  const after = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV, selfSettle: async () => { spent = true; throw new Error('receipt timeout'); } });
  ok(after.stage === 'minted' && world.bridgeMintCalls.length === 1, 'a mint that failed after it landed is found in the pool and recorded as minted');
}
{
  // Another page moves the record on while this call is mid-mint and then fails: the failure does not write the old stage back.
  const storage = makeMemStorage();
  const { ux, r } = await atRfolded(storage, { nullifierSpent: async () => false });
  let threw = false;
  try {
    await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV, selfSettle: async () => {
      const cur = ux.list(r.walletPub).find((x) => x.id === r.id);
      storage.setItem(`tacit-burndep-bridge-v1:signet:${r.walletPub}`, JSON.stringify(ux.list(r.walletPub).map((x) => (x.id === cur.id ? { ...x, stage: 'minted' } : x)), (k, v) => (typeof v === 'bigint' ? { __big: v.toString() } : v)));
      throw new Error('the settle reverted');
    } });
  } catch { threw = true; }
  const kept = ux.list(r.walletPub).find((x) => x.id === r.id);
  ok(threw && kept.stage === 'minted' && !kept.lastError, 'a failure after another page recorded the mint leaves the record minted, with no error written over it');
}
{
  // The lease outlasts a long step: a second page cannot start the same step while the first is mid-mint.
  const storage = makeMemStorage();
  const { ux, r } = await atRfolded(storage, { nullifierSpent: async () => false });
  let release; const gate = new Promise((res) => { release = res; });
  const first = ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV, selfSettle: async () => { await gate; return { txHash: '0x' + 'ee'.repeat(32) }; } });
  await new Promise((res) => setTimeout(res, 50));
  const other = makeBurnDepositUx({ network: 'signet', hrp: 'tb', workerBase: 'https://worker.example', fetchImpl: async () => ({ ok: true, json: async () => ({}) }), storage,
    secp, sha256, keccak256: keccak_256, hmac: hmacFn, pool, bridgeMint: { buildBridgeBurnEnvelope() {}, sourceLeaf() {}, bridgeMint: async () => ({}) }, chainBindingHex: () => '7c'.repeat(32), tacAssetId: ASSET, chain: {},
    encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf, encryptAmount, signSchnorr, modN });
  let refused = null;
  try { await other.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV }); } catch (e) { refused = e; }
  release();
  const done = await first;
  ok(!!refused && /another tab/.test(refused.message) && done.stage === 'minted', 'while one page is mid-mint, another is told it is being advanced elsewhere');
}
{
  const { world, ux, r } = await atRfolded(makeMemStorage(), { nullifierSpent: async () => false });
  await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  ok(world.bridgeMintCalls[0].waitOpts.timeoutMs === 15 * 60 * 1000, 'a mint waits up to 15 minutes on the relay’s queue');
}

// The deposit path's mint is looked for in the pool the same way before anything is sent, and the background check
// records a mint that landed without a click.
async function atFolded(extra = {}) {
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage(), extra);
  let r = await ux.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id); world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  world.setBurnSubmitted(r.burn.txid);
  r = await ux.advance(r.walletPub, r.id); world.setBurnConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setBurnFolded(true);
  r = await ux.advance(r.walletPub, r.id);
  return { world, ux, r };
}
{
  const asked = [];
  const { world, ux, r } = await atFolded({ nullifierSpent: async (nu) => { asked.push(nu); return true; } });
  ok(r.stage === 'folded', 'sanity: the deposit-path bridge is ready to mint');
  const after = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  ok(after.stage === 'minted' && world.bridgeMintCalls.length === 0 && asked.includes(r.envelope.nullifier), 'a deposit-path mint already in the pool is recorded as minted, asked by the burn’s own nullifier, with nothing sent');
}
{
  let spent = false;
  const { world, ux, r } = await atFolded({ nullifierSpent: async () => spent });
  const before = await ux.verify(r.walletPub, r.id);
  spent = true;
  const after = await ux.verify(r.walletPub, r.id);
  ok(before.stage === 'folded' && after.stage === 'minted' && world.bridgeMintCalls.length === 0, 'the background check leaves an unlanded mint ready, and records a landed one as minted without sending anything');
}
{
  let spent = false;
  const { world, ux, r } = await atFolded({ nullifierSpent: async () => spent });
  world.bridgeMint.bridgeMint = async (args) => { world.bridgeMintCalls.push(args); spent = true; throw new Error('settle timed out (box offline or backlogged)'); };
  const after = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  ok(after.stage === 'minted', 'a deposit-path mint whose wait ran out after it landed is recorded as minted');
}

// A signed burn Bitcoin never took is given up only once the chain has neither of its transactions.
async function atRburnSigned() {
  const world = makeWorld();
  world.setBurnHomeOnChain(NOTE_TXID, '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex'));
  world.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: NOTE_AMOUNT, blinding: NOTE_BLINDING });
  const seen = new Map();                                     // txid → 'present' | 'absent' | 'down'
  const fetchImpl = async (url, opts) => {
    const m = new URL(url).pathname.match(/^\/chain\/tx\/([0-9a-f]{64})$/);
    const s = m && seen.get(m[1]);
    if (s === 'down') return { ok: false, status: 503, json: async () => ({ error: 'upstream unavailable' }) };
    if (s === 'absent') return { ok: true, status: 200, json: async () => ({ error: 'not-found' }) };
    if (s === 'present') return { ok: true, status: 200, json: async () => ({ txid: m[1], status: { confirmed: false } }) };
    return world.fetchImpl(url, opts);
  };
  const ux = makeUx({ ...world, fetchImpl }, makeMemStorage());
  const r = await ux.startReflected({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, feeRate: BASE_RATE });
  return { ux, r, seen, world, commit: stripHex(r.burn.commitTxid).toLowerCase(), reveal: stripHex(r.burn.txid).toLowerCase() };
}
{
  const { ux, r, seen, world, commit, reveal } = await atRburnSigned();
  ok(r.stage === 'rburn-signed' && commit && reveal, 'sanity: a signed one-step burn with its two transaction ids');
  const refusal = async () => { try { await ux.cancelSigned(r.walletPub, r.id); return null; } catch (e) { return e.message; } };
  seen.set(commit, 'down'); seen.set(reveal, 'absent');
  ok(/could not be asked/.test(await refusal() || '') && ux.list(r.walletPub)[0]?.stage === 'rburn-signed', 'a chain that cannot be read keeps the bridge as it is');
  seen.set(commit, 'present');
  const send = world.chain.broadcastWithRetry;
  world.chain.broadcastWithRetry = async () => { throw new Error('bad-txns-inputs-missingorspent'); };
  ok(/first of its two.*refused the second/.test(await refusal() || '') && ux.list(r.walletPub)[0]?.stage === 'rburn-signed', 'a commit Bitcoin has, with a reveal it refuses, keeps the bridge and says why');
  world.chain.broadcastWithRetry = send;
  const sends = world.broadcasts.length;
  const went = await ux.cancelSigned(r.walletPub, r.id);
  ok(went?.stage === 'rburn-sent' && world.broadcasts.length === sends + 1 && world.broadcasts.at(-1).chain === r.burn.hex, 'a commit Bitcoin has gets its reveal sent, and the bridge goes on as sent');
  seen.set(reveal, 'present');
  const on = await ux.cancelSigned(r.walletPub, r.id);
  ok(on?.stage === 'rburn-sent' && ux.list(r.walletPub)[0].stage === 'rburn-sent', 'a burn Bitcoin has is not given up: it goes on as sent');
  ok((await ux.cancelSigned(r.walletPub, r.id))?.stage === 'rburn-sent', 'asked again once sent, it goes on while Bitcoin has the burn');
  seen.set(commit, 'absent'); seen.set(reveal, 'absent');
  ok((await ux.cancelSigned(r.walletPub, r.id)) === null && ux.list(r.walletPub).length === 0, 'a sent pair Bitcoin dropped, neither transaction there any more, is cancelled');
}
{
  const { ux, r, seen, commit, reveal } = await atRburnSigned();
  seen.set(commit, 'absent'); seen.set(reveal, 'absent');
  const gone = await ux.cancelSigned(r.walletPub, r.id);
  ok(gone === null && ux.list(r.walletPub).length === 0, 'with neither transaction on Bitcoin the bridge is dropped');
}

// A note newer than the attested state is not judged yet: preflight asks to wait, and a bridge holds before its burn.
{
  const world = makeWorld();
  world.setBurnHomeOnChain(NOTE_TXID, '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex'));
  world.setNoteHeight(1005);                                   // the reflection is at 1000
  const ux = makeUx(world, makeMemStorage());
  const pf = await ux.preflight({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPub: WALLET_PUB });
  const st = pf.steps.find((x) => x.name === 'not-tracked');
  ok(pf.ok === false && st && /has not reached the block/.test(st.detail), 'preflight waits when the reflection has not reached the note’s block');
  const world2 = makeWorld();
  const ux2 = makeUx(world2, makeMemStorage());
  let r = await ux2.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux2.advance(r.walletPub, r.id); world2.setMigrateConfirmed(true);
  r = await ux2.advance(r.walletPub, r.id);
  world2.setNoteHeight(1005);
  r = await ux2.advance(r.walletPub, r.id);
  ok(r.stage === 'migrate-confirmed', 'a bridge holds before tracing and burning until the reflection reaches the move’s block');
  world2.setNoteHeight(990);
  r = await ux2.advance(r.walletPub, r.id);
  ok(r.stage === 'traced', 'and continues once it has, the burn-home untracked');
}

function broadcastsSoFar(world) { return world.broadcasts.length; }
function storageContainsPrivkey(storage, priv) {
  const hex = Buffer.from(priv).toString('hex');
  for (const [, v] of storage._raw) if (String(v).toLowerCase().includes(hex)) return true;
  return false;
}

// ==== a tETH note at this key's own Taproot output (a cross-out made it): sent back by key path, auth key = the key ====
{
  const TETH = withHex('3c'.repeat(32)), XONLY = bytesToHex(WALLET_PUB.slice(1));
  const CAP = 500_000n, AMT = 400_000n, SATS = 330;
  const assets = [{ assetId: ASSET, ticker: 'TAC', capRaw: BURNDEP_BETA_CAP_RAW }, { assetId: TETH, ticker: 'tETH', capRaw: CAP }];
  const held = { txid: NOTE_TXID, vout: NOTE_VOUT, sats: SATS, amount: AMT, blinding: NOTE_BLINDING, assetId: TETH, p2tr: true };
  const setup = () => {
    const world = makeWorld();
    world.setBurnHomeOnChain(NOTE_TXID, '5120' + XONLY.slice(2));
    world.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: AMT, blinding: NOTE_BLINDING, asset: TETH, authKey: XONLY });
    return { world, ux: makeUx(world, makeMemStorage(), { assets }) };
  };
  {
    const { world, ux } = setup();
    const pf = await ux.preflightHeld({ note: held, walletPub: WALLET_PUB });
    ok(pf.ok === true && pf.path === 'reflected' && pf.burnFeeRate === BASE_RATE && world.broadcasts.length === 0, 'preflightHeld passes for a tracked tETH note at the key\'s own Taproot output, and sends nothing');
    const bad = (note, why) => ux.preflightHeld({ note, walletPub: WALLET_PUB }).then((x) => !x.ok && x.steps.some((y) => !y.ok && y.name === why));
    ok(await bad({ ...held, assetId: withHex('ff'.repeat(32)) }, 'asset'), 'an asset it cannot send back is refused by name');
    ok(await bad({ ...held, amount: CAP + 1n }, 'cap'), 'over the cap is refused by name');
    const { ux: other } = setup();
    const oPub = secp.getPublicKey(new Uint8Array(32).fill(0x44), true);
    ok(!(await other.preflightHeld({ note: held, walletPub: oPub })).ok, 'a note at some other key\'s Taproot output is not this key\'s to send back');
    const w2 = makeWorld(); w2.setBurnHomeOnChain(NOTE_TXID, '5120' + XONLY.slice(2)); w2.setLive(NOTE_TXID, NOTE_VOUT);
    const u2 = makeUx(w2, makeMemStorage(), { assets });
    const pf2 = await u2.preflightHeld({ note: held, walletPub: WALLET_PUB });
    ok(!pf2.ok && pf2.steps.some((y) => y.name === 'old-leaf' && !y.ok), 'a live note whose leaf is not in the tree in the burn\'s form is refused before anything is signed');
    const w3 = makeWorld(); w3.setBurnHomeOnChain(NOTE_TXID, '5120' + XONLY.slice(2));
    const pf3 = await makeUx(w3, makeMemStorage(), { assets }).preflightHeld({ note: held, walletPub: WALLET_PUB });
    ok(!pf3.ok && pf3.steps.some((y) => y.name === 'reflected' && !y.ok), 'a note the reflection does not track yet is not offered');
  }
  {
    const { world, ux } = setup();
    let r = await ux.startReflected({ note: held, walletPriv: WALLET_PRIV, feeRate: BASE_RATE });
    ok(r.stage === 'rburn-signed' && r.source.assetId === TETH && r.source.ticker === 'tETH' && r.source.p2tr === true && world.broadcasts.length === 0, 'the burn is signed and journalled as a tETH, Taproot-owned note, with nothing sent');
    const { cx, cy } = pool.commitXY(AMT, NOTE_BLINDING);
    const nu = pool.nullifier(pool.btcNoteLeaf(TETH, cx, cy, XONLY));
    const dec = classifyConfidentialTx(withHex(r.burn.hex));
    ok(dec && dec.type === 'burn' && dec.nullifier === nu && dec.assetId === TETH && dec.target === withHex('7c'.repeat(32)), 'the reveal burns the note under its own ν (auth key = this key) for tETH, toward this pool');
    ok(r.mint.sourceClass === 1 && r.mint.burned.owner === XONLY && BigInt(r.mint.dest.value) === AMT, 'the mint is planned as class 1 with this key as the burned note\'s owner, the full amount');
    const dn = pool.deriveNote(WALLET_PRIV, TETH, 0);
    ok(r.mint.dest.owner === pool.nkToOwner(dn.secret) && r.mint.dest.owner !== pool.nkToOwner(pool.deriveNote(WALLET_PRIV, ASSET, 0).secret), 'the Ethereum note is owned by the key\'s tETH note owner, not TAC\'s');
    const mr = makeBridgeMintRecovery({ hmac: hmacFn, sha256, curveOrder: secp.CURVE.n });
    ok(BigInt(r.mint.dest.blinding) === BigInt(mr.deriveBridgeMintBlinding({ privkey: WALLET_PRIV, nullifier: nu })), 'its blinding comes from the key and ν, so the minted note is found again from the key');
    let threw = false; try { await ux.startReflected({ note: held, walletPriv: WALLET_PRIV, feeRate: BASE_RATE }); } catch { threw = true; }
    ok(threw, 'the same note cannot be sent twice');
    r = await ux.advance(r.walletPub, r.id);
    ok(r.stage === 'rburn-sent' && world.broadcasts.length === 2 && world.broadcasts.every((b) => b.chain), 'commit and reveal go out through ordinary relay');
    world.setChainTx(r.burn.txid, { confirmed: true });
    r = await ux.advance(r.walletPub, r.id);
    world.setNoteHeight(1001); world.setChainTx(r.burn.txid, { confirmed: true }); world.foldReflected(r.burn.hex);
    r = await ux.advance(r.walletPub, r.id);
    ok(r.stage === 'rfolded', 'recorded by the attested state, it is ready to mint');
    r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
    const call = world.bridgeMintCalls[0];
    ok(r.stage === 'minted' && call.asset === TETH && call.sourceClass === 1 && call.burned.owner === XONLY && call.spentTxid === withHex(revHex(NOTE_TXID)),
      'the mint is for tETH and names the Taproot-owned note as class 1');
    ok(call.recovery.seedDerived !== true && call.recovery.ownerPub === '0x' + Buffer.from(WALLET_PUB).toString('hex') && pool.nkToOwner(call.recovery.secret) === call.dest.owner,
      'a round tETH amount is still sealed to the key, since a balance read searches the derived blinding for TAC alone');
  }
  {
    // The note's auth key is the key's x-only form, so a key whose public point has an odd y is spent as well as an even one
    // (the builder checks the key-path signature against the output key before it returns).
    for (const fill of [0x22, 0x23, 0x24, 0x25, 0x26, 0x27]) {
      const priv = new Uint8Array(32).fill(fill), pub = secp.getPublicKey(priv, true), xo = bytesToHex(pub.slice(1));
      const world = makeWorld();
      world.setBurnHomeOnChain(NOTE_TXID, '5120' + xo.slice(2));
      world.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: AMT, blinding: NOTE_BLINDING, asset: TETH, authKey: xo });
      const u = makeUx(world, makeMemStorage(), { assets });
      const r = await u.startReflected({ note: held, walletPriv: priv, feeRate: BASE_RATE });
      ok(r.stage === 'rburn-signed' && r.mint.burned.owner === xo, `the burn is signed for a key with ${pub[0] === 2 ? 'even' : 'odd'} y (0x${fill.toString(16)}…)`);
    }
  }
  {
    // An amount the scan cannot guess is sealed to the key under the tETH note owner.
    const odd = 123_457n;
    const world = makeWorld();
    world.setBurnHomeOnChain(NOTE_TXID, '5120' + XONLY.slice(2));
    world.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: odd, blinding: NOTE_BLINDING, asset: TETH, authKey: XONLY });
    const ux = makeUx(world, makeMemStorage(), { assets });
    let r = await ux.startReflected({ note: { ...held, amount: odd }, walletPriv: WALLET_PRIV, feeRate: BASE_RATE });
    r = await ux.advance(r.walletPub, r.id); world.setChainTx(r.burn.txid, { confirmed: true }); r = await ux.advance(r.walletPub, r.id);
    world.setNoteHeight(1001); world.setChainTx(r.burn.txid, { confirmed: true }); world.foldReflected(r.burn.hex); r = await ux.advance(r.walletPub, r.id);
    await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
    const c = world.bridgeMintCalls[0];
    ok(c.recovery.seedDerived !== true && pool.nkToOwner(c.recovery.secret) === c.dest.owner && c.dest.owner === pool.nkToOwner(pool.deriveNote(WALLET_PRIV, TETH, 0).secret), 'a non-round tETH amount is sealed to the key under the tETH note owner');
  }
  {
    // A tETH return burn is rebuilt from its transaction id and the key alone, the note opened by what the cross-out made.
    const { world, ux } = setup();
    let orig = await ux.startReflected({ note: held, walletPriv: WALLET_PRIV, feeRate: BASE_RATE });
    world.setChainTx(orig.burn.txid, { confirmed: true, vin: [{ txid: orig.burn.commitTxid, vout: 0 }, { txid: NOTE_TXID, vout: NOTE_VOUT, prevout: { value: SATS } }] });
    world.setChainHex(orig.burn.txid, orig.burn.hex);
    world.setChainHex(orig.burn.commitTxid, orig.burn.commitHex);
    const opener = async (txid, vout, priv) => (stripHex(txid) === NOTE_TXID && vout === NOTE_VOUT && Buffer.from(priv).equals(Buffer.from(WALLET_PRIV))
      ? { assetId: TETH, amount: AMT, blinding: NOTE_BLINDING, owner: XONLY } : null);
    const fresh = makeUx(world, makeMemStorage(), { assets, openHeldNote: opener, nullifierSpent: async () => false });
    const rebuilt = await fresh.recoverFromTxid(orig.burn.txid, WALLET_PRIV);
    const ser = (x) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
    ok(rebuilt.stage === 'rburn-mined' && rebuilt.path === 'reflected' && rebuilt.source.assetId === TETH && rebuilt.source.ticker === 'tETH' && rebuilt.source.p2tr === true, 'a tETH return burn is rebuilt from its txid alone, as a tETH, Taproot-owned bridge');
    ok(ser(rebuilt.mint) === ser(orig.mint) && rebuilt.envelope.destLeaf === orig.envelope.destLeaf && rebuilt.envelope.burnId === orig.envelope.burnId, 'with exactly the mint the original browser planned');
    world.setNoteHeight(1001); world.foldReflected(orig.burn.hex);
    let r = await fresh.advance(rebuilt.walletPub, rebuilt.id);
    r = await fresh.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
    const mc = world.bridgeMintCalls[world.bridgeMintCalls.length - 1];
    ok(r.stage === 'minted' && mc.asset === TETH && mc.burned.owner === XONLY, 'and mints it as tETH with this key as the burned note\'s owner');
    const thief = makeUx(world, makeMemStorage(), { assets, openHeldNote: opener });
    const otherKey = new Uint8Array(32).fill(0x23);
    let msg = null; try { await thief.recoverFromTxid(orig.burn.txid, otherKey); } catch (e) { msg = e.message; }
    ok(/does not open with this key/.test(msg || ''), 'a key whose cross-out did not make the note cannot rebuild the bridge');
    const none = makeUx(world, makeMemStorage(), { assets });
    msg = null; try { await none.recoverFromTxid(orig.burn.txid, WALLET_PRIV); } catch (e) { msg = e.message; }
    ok(msg !== null && none.list(Buffer.from(WALLET_PUB).toString('hex')).length === 0, 'without an opener for such notes it is not rebuilt, and nothing is journalled');
    const done = makeUx(world, makeMemStorage(), { assets, openHeldNote: opener, nullifierSpent: async () => true });
    ok((await done.recoverFromTxid(orig.burn.txid, WALLET_PRIV)).stage === 'minted', 'one the pool has already minted is found complete');
  }
  {
    // A burn marked not recorded can be looked at again; it returns to waiting, and is recorded if the state now holds it.
    const { world, ux } = setup();
    let r = await ux.startReflected({ note: held, walletPriv: WALLET_PRIV, feeRate: BASE_RATE });
    world.setRecordReflected(false);
    r = await ux.advance(r.walletPub, r.id); world.setChainTx(r.burn.txid, { confirmed: true }); r = await ux.advance(r.walletPub, r.id);
    world.setNoteHeight(1001); world.setChainTx(r.burn.txid, { confirmed: true }); world.foldReflected(r.burn.hex);
    r = await ux.advance(r.walletPub, r.id);
    ok(r.stage === 'not-recorded', 'sanity: a burn the state passed without recording is marked not recorded');
    let msg = null; try { await ux.recheckBurn(r.walletPub, 'nope'); } catch (e) { msg = e.message; }
    ok(/only a reflected burn marked not recorded/.test(msg || ''), 'checking something that is not such a burn is refused');
    world.setChainTx(r.burn.txid, { confirmed: false });
    msg = null; try { await ux.recheckBurn(r.walletPub, r.id); } catch (e) { msg = e.message; }
    ok(/not confirmed on Bitcoin just now/.test(msg || '') && ux.list(r.walletPub)[0].stage === 'not-recorded', 'a burn Bitcoin does not show confirmed is not put back to waiting');
    world.setChainTx(r.burn.txid, { confirmed: true }); world.setRecordReflected(true);
    r = await ux.recheckBurn(r.walletPub, r.id);
    ok(r.stage === 'rburn-mined' && r.burnHeight === 1001 && r.lastError === null, 'a confirmed one goes back to waiting to be recorded, at the block it is in now');
    r = await ux.advance(r.walletPub, r.id);
    ok(r.stage === 'rburn-mined', 'it waits while the proof is short of the block the burn is in now');
    world.setAttested(1001);
    r = await ux.advance(r.walletPub, r.id);
    ok(r.stage === 'rfolded', 'and is recorded and ready to mint once the state holds its burn');
  }
  {
    // A bound note is refused by the check, not at planning; a high fee waits; another key is refused; one page does not advance twice at once.
    const { world, ux } = setup();
    world.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: AMT, blinding: NOTE_BLINDING, asset: TETH, authKey: XONLY, bound: true });
    const pf = await ux.preflightHeld({ note: held, walletPub: WALLET_PUB });
    ok(!pf.ok && pf.steps.some((y) => y.name === 'bound' && !y.ok), 'a note bound to a deployment is refused by the check, naming the step');
    const { world: w2, ux: u2 } = setup();
    let msg = null; try { await u2.startReflected({ note: held, walletPriv: WALLET_PRIV, feeRate: 400 }); } catch (e) { msg = e.message; }
    ok(/fees are high right now \(400 sat\/vB\)/.test(msg || '') && w2.broadcasts.length === 0 && u2.list(Buffer.from(WALLET_PUB).toString('hex')).length === 0, 'a return waits when Bitcoin\'s fee is above the ceiling, with nothing signed or journalled');
    w2.chain.getUtxos = async () => [{ txid: FUND_TXID_2, vout: 0, value: 300_000 }];
    const high = await u2.startReflected({ note: held, walletPriv: WALLET_PRIV, feeRate: 400, allowHighFee: true });
    ok(high.stage === 'rburn-signed', 'and is signed when the holder says to go ahead');
    const { world: w3, ux: u3 } = setup();
    const r3 = await u3.startReflected({ note: held, walletPriv: WALLET_PRIV, feeRate: BASE_RATE });
    const other = new Uint8Array(32).fill(0x24);
    msg = null; try { await u3.advance(r3.walletPub, r3.id, { walletPriv: other }); } catch (e) { msg = e.message; }
    ok(/belongs to another key/.test(msg || '') && u3.list(r3.walletPub)[0].stage === 'rburn-signed' && !u3.list(r3.walletPub)[0].lastError && w3.broadcasts.length === 0, 'another key is refused before anything is sent, and the bridge is left as it was');
    const p1 = u3.advance(r3.walletPub, r3.id);
    msg = null; try { await u3.advance(r3.walletPub, r3.id); } catch (e) { msg = e.message; }
    await p1;
    ok(/being advanced in this page right now/.test(msg || '') && w3.broadcasts.length === 2, 'a second advance in the same page while the first is sending is refused, so the pair goes out once');
    // TAC keeps its own behaviour: no ceiling on a tracked TAC note.
    const wt = makeWorld(); wt.setBurnHomeOnChain(NOTE_TXID, '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex'));
    wt.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: NOTE_AMOUNT, blinding: NOTE_BLINDING });
    wt.chain.getUtxos = async () => [{ txid: FUND_TXID_2, vout: 0, value: 300_000 }];
    const tr = await makeUx(wt, makeMemStorage()).startReflected({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, feeRate: 400 });
    ok(tr.stage === 'rburn-signed', 'the TAC bridge is unchanged: no ceiling is put on it');
  }
  {
    // TAC alone stays what it was: no assets configured, a tETH note is refused.
    const world = makeWorld(); world.setBurnHomeOnChain(NOTE_TXID, '5120' + XONLY.slice(2));
    world.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: AMT, blinding: NOTE_BLINDING, asset: TETH, authKey: XONLY });
    const ux = makeUx(world, makeMemStorage());
    let threw = null; try { await ux.startReflected({ note: held, walletPriv: WALLET_PRIV, feeRate: BASE_RATE }); } catch (e) { threw = e; }
    ok(threw && /cannot be sent back/.test(threw.message) && world.broadcasts.length === 0, 'without tETH configured, a tETH note is refused before anything is signed');
  }
}

// ==== answers that are not progress, coins held back, a dropped burn, a mint already queued, the fee a preview shows ====
{
  // An error answer from the status route (a rate limit) is never read as a confirmation, and is not kept as a failure.
  const world = makeWorld();
  let limited = false;
  const fetchImpl = async (url, opts) => (limited && new URL(url).pathname === '/reflection/burndep/status'
    ? { ok: false, status: 429, json: async () => ({ ok: false, error: 'too many status requests — retry in ~40s', retryAfter: 40 }) } : world.fetchImpl(url, opts));
  const ux = makeUx({ ...world, fetchImpl }, makeMemStorage());
  let r = await ux.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id);
  world.setMigrateConfirmed(true); limited = true;
  let msg = null; try { await ux.advance(r.walletPub, r.id); } catch (e) { msg = e.message; }
  let cur = ux.list(r.walletPub)[0];
  ok(/too many status requests/.test(msg || '') && cur.stage === 'migrate-sent' && !cur.lastError, 'a rate-limited status read leaves the move waiting, and is not kept on the record as a failure');
  limited = false;
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'migrate-confirmed' && r.migrateHeight === 800, 'answered, the confirmed move goes on, with the block it is in');
  r = await ux.advance(r.walletPub, r.id);
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  world.setBurnSubmitted(r.burn.txid);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'burn-submitted', 'sanity: the burn is with the miner');
  limited = true;
  msg = null; try { await ux.advance(r.walletPub, r.id); } catch (e) { msg = e.message; }
  cur = ux.list(r.walletPub)[0];
  ok(msg && cur.stage === 'burn-submitted' && !cur.lastError, 'a rate-limited read never moves a burn the miner holds on to mined');
  limited = false; world.setBurnConfirmed(true);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'burn-mined' && r.burnHeight === 900, 'a mined burn keeps the block it is in, for the wait that follows');
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'registered', 'sanity: registered');
}
{
  // The same journal, read by a page whose status route answers "not recorded": a registered burn is said not to have completed.
  const world = makeWorld();
  const storage = makeMemStorage();
  let notRecorded = false;
  const fetchImpl = async (url, opts) => (notRecorded && new URL(url).pathname === '/reflection/burndep/status'
    ? { ok: true, status: 200, json: async () => ({ ok: true, status: 'not-recorded', burnBlockHeight: 900, registered: true }) } : world.fetchImpl(url, opts));
  const ux = makeUx({ ...world, fetchImpl }, storage);
  let r = await ux.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id); world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  world.setBurnSubmitted(r.burn.txid);
  r = await ux.advance(r.walletPub, r.id); world.setBurnConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'registered', 'sanity: a registered burn-deposit');
  notRecorded = true;
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'not-recorded', 'a registered burn the reflection passed without recording is said to have not completed, not waited on forever');
}
{
  // Coins a record will never spend are not held back: a burn signed and never sent, of a bridge that then stopped.
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  let r = await ux.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id); world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  const coin = r.burn.fundingUtxo;
  ok(r.stage === 'burn-signed' && ux.isReserved(coin.txid, coin.vout), 'a signed burn holds its coin back');
  world.setLive(r.burnHome.txid, 0);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'stopped' && !ux.isReserved(coin.txid, coin.vout), 'once the bridge stops before sending it, the coin is free for other spends');
}
{
  // A sent burn Bitcoin dropped and will not take again is said on its row; once Bitcoin has neither transaction it can be cancelled.
  const world = makeWorld();
  world.setBurnHomeOnChain(NOTE_TXID, '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex'));
  world.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: NOTE_AMOUNT, blinding: NOTE_BLINDING });
  const gone = new Set();
  const fetchImpl = async (url, opts) => {
    const m = new URL(url).pathname.match(/^\/chain\/tx\/([0-9a-f]{64})$/);
    if (m && gone.has(m[1])) return { ok: false, status: 404, json: async () => { throw new SyntaxError('Unexpected token T'); } };
    return world.fetchImpl(url, opts);
  };
  const ux = makeUx({ ...world, fetchImpl }, makeMemStorage());
  let r = await ux.startReflected({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'rburn-sent', 'sanity: sent');
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'rburn-sent' && !r.lastError, 'a burn Bitcoin still holds waits quietly');
  gone.add(stripHex(r.burn.txid).toLowerCase()); gone.add(stripHex(r.burn.commitTxid).toLowerCase());
  const send = world.chain.broadcastWithRetry;
  world.chain.broadcastWithRetry = async () => { throw new Error('mempool min fee not met'); };
  for (let i = 0; i < 3; i++) await ux.advance(r.walletPub, r.id).catch(() => {});
  const cur = ux.list(r.walletPub)[0];
  ok(cur.stage === 'rburn-sent' && cur.errorCount === 3 && /min fee/.test(cur.lastError.message), 'a burn Bitcoin dropped and refuses again is said on the record, each try counted');
  world.chain.broadcastWithRetry = send;
  ok((await ux.cancelSigned(r.walletPub, r.id)) === null && ux.list(r.walletPub).length === 0 && !ux.isReserved(NOTE_TXID, NOTE_VOUT), 'and is cancelled once Bitcoin has neither transaction, its note free again');
}
{
  // A mint the relay took is not built and sent again from a reload while it is with the relay; it is found once it lands.
  const world = makeWorld();
  world.setBurnHomeOnChain(NOTE_TXID, '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex'));
  world.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: NOTE_AMOUNT, blinding: NOTE_BLINDING });
  const storage = makeMemStorage();
  let landed = false;
  const ux = makeUx(world, storage, { nullifierSpent: async () => landed });
  let r = await ux.startReflected({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id); world.setChainTx(r.burn.txid, { confirmed: true });
  r = await ux.advance(r.walletPub, r.id); world.foldReflected(r.burn.hex);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'rfolded', 'sanity: ready to mint');
  // The page closes while the relay proves: the record carries the job, as noted when the relay took it.
  const raw = JSON.parse(storage.getItem(`tacit-burndep-bridge-v1:signet:${r.walletPub}`));
  raw[0].mintJob = { id: 'job-queued', at: Date.now() };
  storage.setItem(`tacit-burndep-bridge-v1:signet:${r.walletPub}`, JSON.stringify(raw));
  const reloaded = makeUx(world, storage, { nullifierSpent: async () => landed });
  const calls = world.bridgeMintCalls.length;
  r = await reloaded.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  ok(r.stage === 'rfolded' && world.bridgeMintCalls.length === calls, 'a reload while the mint is with the relay does not send it again');
  landed = true;
  r = await reloaded.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  ok(r.stage === 'minted' && world.bridgeMintCalls.length === calls, 'once it lands it is found in the pool, complete');
  // Without a job noted (or after a failure said since), the mint is built as before.
  const w2 = makeWorld();
  w2.setBurnHomeOnChain(NOTE_TXID, '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex'));
  w2.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: NOTE_AMOUNT, blinding: NOTE_BLINDING });
  const u2 = makeUx(w2, makeMemStorage());
  let q = await u2.startReflected({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, feeRate: BASE_RATE });
  q = await u2.advance(q.walletPub, q.id); w2.setChainTx(q.burn.txid, { confirmed: true });
  q = await u2.advance(q.walletPub, q.id); w2.foldReflected(q.burn.hex);
  q = await u2.advance(q.walletPub, q.id);
  q = await u2.advance(q.walletPub, q.id, { walletPriv: WALLET_PRIV });
  ok(q.stage === 'minted' && w2.bridgeMintCalls.length === 1, 'a mint with no job noted is built and sent once');
}
{
  // The fee a preview shows is the fee the builder then pays, and its gate matches what the builder can fund.
  const world = makeWorld();
  world.setBurnHomeOnChain(NOTE_TXID, '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex'));
  world.setReflectedNote({ txid: NOTE_TXID, vout: NOTE_VOUT, value: NOTE_AMOUNT, blinding: NOTE_BLINDING });
  const ux = makeUx(world, makeMemStorage());
  for (const rate of [1, 5, 20]) {
    const coins = [{ txid: FUND_TXID_2, vout: 0, value: 5_000 + rate * 1000 }];
    world.chain.getUtxos = async () => coins;
    const cost = ux.bridgeCost({ path: 'reflected', feeRate: rate, coins, noteSats: NOTE_SATS });
    const r = await ux.startReflected({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, feeRate: rate });
    ok(cost.ok && Math.abs(cost.fee - r.burn.fee) <= Math.max(2, rate * 2), `at ${rate} sat/vB the preview's fee (${cost.fee}) is the fee the burn pays (${r.burn.fee})`);
    ux.abandon(r.walletPub, r.id);
  }
  const short = ux.bridgeCost({ path: 'reflected', feeRate: 20, coins: [{ value: 3_000 }, { value: 3_000 }], noteSats: NOTE_SATS });
  ok(!short.ok && short.need > 6_000, `two small coins short of a one-step burn at 20 sat/vB are said short (${short.need} needed)`);
  const two = ux.bridgeCost({ path: 'deposit', feeRate: 20, coins: [{ value: 9_000 }, { value: 9_000 }], noteSats: NOTE_SATS });
  ok(!two.ok && two.have === 9_000 && two.need > 9_000, 'the move spends one coin whole, so two coins that only add up are said short');
}
console.log(failures ? `\n${failures} FAILURES (${n} passed)` : `\nall ${n} burndep-ux checks passed`);
process.exit(failures ? 1 : 0);
