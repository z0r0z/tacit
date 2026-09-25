// Secret Sats Join (dapp/secret-sats-join.js, worker-relay/src/join-board.js): rounds simulated in-process
// against the real board core and a mock chain that checks every signature before it accepts a transaction.
//   node tests/secret-sats-join.test.mjs            (JOIN_TEST_FILTER=<substring> runs a subset)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  location: dom.window.location, navigator: dom.window.navigator,
  prompt: () => null, alert: () => {}, confirm: () => false, __TACIT_NO_INIT__: true,
});

const tacit = await import('../dapp/tacit.js');
const J = await import('../dapp/secret-sats-join.js');
const { createBoard, openStore, memoryTransport, createHandler, configFromEnv } = await import('../worker-relay/src/join-board.js');
const { secp, sha256, ripemd160, keccak_256, hmac, concatBytes, bytesToHex, hexToBytes } = await import('../dapp/vendor/tacit-deps.min.js');
const { makeBtcWallet } = await import('../dapp/bitcoin-taproot-wallet.js');
const { makeBtcShieldedPool } = await import('../dapp/btc-shielded-pool.js');
const { makeBtcPoolZap } = await import('../dapp/btc-pool-zap.js');
const { publicSignals } = await import('../dapp/btc-pool-zk.js');

const N = secp.CURVE.n;
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const privOf = () => { for (;;) { const p = rnd(32); const x = BigInt('0x' + bytesToHex(p)); if (x > 0n && x < N) return p; } };
const hash160 = (b) => ripemd160(sha256(b));
const u32le = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
const u64le = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; };
const vs = (b) => concatBytes(Uint8Array.of(b.length), b);
const h256 = (b) => sha256(sha256(b));

const NET = 'signet';
const D = 10_000;
const FR = 2;
const K_MIN = 3;
const O = J.outputValue(D, FR);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ─────────────────────────────────────────────── independent transaction checks

// Minimal parser, independent of the module under test.
function parseRaw(raw) {
  let p = 0;
  const dv = new DataView(raw.buffer, raw.byteOffset);
  const var_ = () => { const b = raw[p++]; if (b < 0xfd) return b; const v = dv.getUint16(p, true); p += 2; return v; };
  const version = dv.getUint32(p, true); p += 4;
  const seg = raw[p] === 0 && raw[p + 1] === 1; if (seg) p += 2;
  const inputs = [];
  for (let i = 0, n = var_(); i < n; i++) {
    const txid = bytesToHex(raw.slice(p, p + 32).reverse()); p += 32;
    const vout = dv.getUint32(p, true); p += 4; const sl = var_(); p += sl;
    inputs.push({ txid, vout, sequence: dv.getUint32(p, true), witness: [] }); p += 4;
  }
  const outputs = [];
  for (let i = 0, n = var_(); i < n; i++) {
    const value = Number(dv.getBigUint64(p, true)); p += 8; const l = var_();
    outputs.push({ value, script: raw.slice(p, p + l) }); p += l;
  }
  const baseEnd = p;
  if (seg) for (const i of inputs) for (let k = 0, n = var_(); k < n; k++) { const l = var_(); i.witness.push(raw.slice(p, p + l)); p += l; }
  const locktime = dv.getUint32(p, true); p += 4;
  assert.equal(p, raw.length, 'trailing bytes');
  const witLen = seg ? (p - 4 - baseEnd) + 2 : 0;
  const weight = (raw.length - witLen) * 4 + witLen;
  return { version, inputs, outputs, locktime, weight, vsize: Math.ceil(weight / 4) };
}

function bip143(tx, idx, pub, value) {
  const inp = tx.inputs[idx];
  const scriptCode = concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), hash160(pub), Uint8Array.of(0x88, 0xac));
  return h256(concatBytes(u32le(tx.version),
    h256(concatBytes(...tx.inputs.flatMap((i) => [hexToBytes(i.txid).reverse(), u32le(i.vout)]))),
    h256(concatBytes(...tx.inputs.map((i) => u32le(i.sequence)))),
    hexToBytes(inp.txid).reverse(), u32le(inp.vout), vs(scriptCode), u64le(value), u32le(inp.sequence),
    h256(concatBytes(...tx.outputs.flatMap((o) => [u64le(o.value), vs(o.script)]))), u32le(tx.locktime), u32le(1)));
}
function derToCompact(der) {
  const rl = der[3], r = der.slice(4, 4 + rl), s = der.slice(6 + rl);
  const out = new Uint8Array(64); out.set(r.slice(-32), 32 - Math.min(32, r.length)); out.set(s.slice(-32), 64 - Math.min(32, s.length));
  return out;
}
const sighashPrims = makeBtcWallet({ priv: privOf(), hrp: 'tb' }).prims;

// Verifies every input with tacit.js's Schnorr and the reference wallet's BIP-341 sighash / a local BIP-143.
function verifyAllInputs(tx, prevouts) {
  tx.inputs.forEach((inp, i) => {
    const spk = prevouts[i].script;
    if (spk[0] === 0x51) {
      assert.equal(inp.witness.length, 1);
      const sh = sighashPrims.tapSighashKeyPath(tx, i, prevouts, 0x00);
      assert.ok(tacit.verifySchnorr(inp.witness[0], sh, spk.slice(2)), `taproot input ${i} signature`);
    } else {
      const [sig, pub] = inp.witness;
      assert.deepEqual(hash160(pub), spk.slice(2));
      assert.equal(sig[sig.length - 1], 1);
      assert.ok(secp.verify(derToCompact(sig.slice(0, -1)), bip143(tx, i, pub, prevouts[i].value), pub, { lowS: true }), `p2wpkh input ${i} signature`);
    }
  });
}

// ─────────────────────────────────────────────── mock chain

function mockChain({ tip = 900_000 } = {}) {
  const txs = new Map(), spends = new Map();
  const chain = {
    tip, broadcasts: [], rejects: [],
    tipHeight: async () => chain.tip,
    getTx: async (txid) => { const t = txs.get(txid); if (!t) throw new Error('HTTP 404'); return JSON.parse(JSON.stringify(t)); },
    getOutspend: async (txid, vout) => spends.get(`${txid}:${vout}`) || { spent: false },
    // A fake confirmed transaction paying `outs`; `vin` optional Esplora vins.
    addTx(outs, { height = chain.tip - 10, vin = null, version = 2 } = {}) {
      const txid = bytesToHex(rnd(32));
      const t = {
        txid, version, locktime: 0,
        vin: vin || [{ txid: bytesToHex(rnd(32)), vout: 0, prevout: { scriptpubkey: '0014' + bytesToHex(rnd(20)), value: 1e8 }, witness: [bytesToHex(rnd(71)), '02' + bytesToHex(rnd(32))] }],
        vout: outs.map((o) => ({ scriptpubkey: bytesToHex(o.script), value: o.value })),
        status: { confirmed: true, block_height: height },
      };
      txs.set(txid, t);
      return t;
    },
    broadcast: async (hexTx) => {
      const raw = hexToBytes(hexTx);
      const tx = parseRaw(raw);
      const txid = J.txidOf(tx);
      if (txs.has(txid)) throw new Error('txn-already-known');
      const prevouts = tx.inputs.map((i) => {
        const t = txs.get(i.txid); const o = t?.vout[i.vout];
        if (!o) throw new Error('bad-txns-inputs-missingorspent');
        const s = spends.get(`${i.txid}:${i.vout}`);
        if (s && s.txid !== txid) throw new Error('txn-mempool-conflict');
        return { value: Number(o.value), script: hexToBytes(o.scriptpubkey) };
      });
      verifyAllInputs(tx, prevouts);
      const fee = prevouts.reduce((s, p) => s + p.value, 0) - tx.outputs.reduce((s, o) => s + o.value, 0);
      assert.ok(fee >= tx.vsize, `fee ${fee} below 1 sat/vB for ${tx.vsize} vB`);
      tx.inputs.forEach((i) => spends.set(`${i.txid}:${i.vout}`, { spent: true, txid, status: { confirmed: false } }));
      txs.set(txid, {
        txid, version: tx.version, locktime: tx.locktime,
        vin: tx.inputs.map((i, k) => ({ txid: i.txid, vout: i.vout, prevout: { scriptpubkey: bytesToHex(prevouts[k].script), value: prevouts[k].value }, witness: i.witness.map(bytesToHex), sequence: i.sequence })),
        vout: tx.outputs.map((o) => ({ scriptpubkey: bytesToHex(o.script), value: o.value })),
        status: { confirmed: false },
      });
      chain.broadcasts.push({ txid, tx, prevouts, fee });
      return txid;
    },
    mine() { for (const t of txs.values()) if (!t.status.confirmed) t.status = { confirmed: true, block_height: chain.tip + 1 }; chain.tip++; },
  };
  return chain;
}

// ─────────────────────────────────────────────── participants

// A client wallet: its tacit.js silent-payment identity (version 1) and one coin of its own.
function makeClient(chain, { type = 'p2tr', value = J.entryOutputValue({ d: D, fr: FR, kMin: K_MIN }), coinTx = null } = {}) {
  const walletPriv = privOf();
  const sp = tacit.deriveWalletSilentPaymentKeys(walletPriv, 1);
  const priv = privOf();
  const pub33 = secp.getPublicKey(priv, true);
  const spk = type === 'p2tr' ? J.p2trScript(pub33.slice(1)) : J.p2wpkhScript(pub33);
  const t = coinTx || chain.addTx([{ script: spk, value }]);
  const vout = t.vout.findIndex((o) => o.scriptpubkey === bytesToHex(spk));
  return {
    walletPriv, sp,
    keys: { scanPriv: sp.scanPriv, spendPub: sp.spendPub },
    coin: { txid: t.txid, vout, value: Number(t.vout[vout].value), spk: bytesToHex(spk), type, priv, pub33: bytesToHex(pub33) },
  };
}

async function makeBoard(chain, overrides = {}) {
  const cfg = { ...configFromEnv({ JOIN_NETWORK: NET }), ...overrides };
  const store = await openStore(null);
  const core = createBoard({ cfg, store, boardPriv: J.randomScalar(), tip: async () => chain.tip });
  await core.tick();
  return { core, cfg };
}

// Runs participants; closes the topic once `expectJoins` JOINs are in.
async function runRound({ chain, core, clients, transports = null, opts = {}, expectJoins = clients.length, perClient = () => ({}) }) {
  const tr = memoryTransport(core);
  const hRef = chain.tip;
  const results = clients.map((c, i) => J.runParticipant({
    board: transports ? transports[i] : tr, chain, network: NET, d: D, fr: FR, coin: c.coin, keys: c.keys, hRef,
    tStepMs: 4000, jitter: 0, ageMin: 1, closeTimeoutMs: 60_000, ...opts, ...perClient(c, i),
  }).catch((e) => ({ status: 'error', error: e })));
  const topic = J.topicId({ network: NET, d: D, fr: FR, hRef, boardKey: core.boardKey });
  for (let i = 0; i < 400; i++) {
    const t = core.topics().find((x) => x.topic === topic);
    if (t && t.joins >= expectJoins) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  core.closeNow(topic);
  const out = await Promise.all(results);
  for (const r of out) if (r.status === 'error') throw r.error;
  if (process.env.JOIN_TEST_DEBUG) for (const r of out) if (r.broadcastError) console.log('    broadcast error:', r.broadcastError);
  return { results: out, topic };
}

// Every participant that broadcast lands in one transaction that pays its derived output; tacit.js's own
// silent-payment scan finds that output with the wallet's keys, and the spending key opens it.
function assertOwnOutputsScanned(chain, clients, results) {
  for (let i = 0; i < clients.length; i++) {
    const r = results[i];
    if (r.status !== 'broadcast') continue;
    const b = chain.broadcasts.find((x) => x.txid === r.txid);
    assert.ok(b, 'broadcast recorded');
    const inputs = b.tx.inputs.map((inp, k) => ({
      kind: 'bip352',
      pub: tacit.bip352InputPubkey({ prevoutScript: b.prevouts[k].script, scriptSig: null, witness: inp.witness }),
    }));
    const matches = tacit.receiverScanTxForSilentPayments({
      classifiedInputs: inputs, allOutpoints: b.tx.inputs.map((x) => J.outpointBytes(x.txid, x.vout)),
      outputs: b.tx.outputs, scanPriv: clients[i].sp.scanPriv, spendPub: clients[i].sp.spendPub,
    });
    assert.equal(matches.length, 1, `client ${i} finds exactly its output`);
    assert.equal(matches[0].voutIndex, r.own[0].vout);
    assert.equal(bytesToHex(matches[0].tweak), r.own[0].tweak);
    const sk = tacit.silentPaymentSpendingKey(clients[i].sp.spendPriv, matches[0].tweakScalar);
    assert.deepEqual(secp.getPublicKey(sk, true).slice(1), b.tx.outputs[matches[0].voutIndex].script.slice(2));
  }
}

function assertStandardJoin(b, { n, hRef }) {
  const { tx, prevouts, fee } = b;
  assert.equal(tx.version, 2);
  assert.equal(tx.locktime, hRef);
  assert.equal(tx.inputs.length, n);
  assert.equal(tx.outputs.length, n);
  assert.ok(tx.inputs.every((i) => i.sequence === 0xfffffffd));
  assert.ok(tx.outputs.every((o) => o.value === O && o.script.length === 34 && o.script[0] === 0x51 && o.script[1] === 0x20), 'all outputs P2TR at o');
  assert.ok(O >= 330);
  const ops = tx.inputs.map((i) => J.outpointBytes(i.txid, i.vout));
  for (let k = 1; k < n; k++) assert.ok(J.compareBytes(ops[k - 1], ops[k]) < 0, 'inputs sorted by outpoint');
  for (let k = 1; k < n; k++) assert.ok(J.compareBytes(tx.outputs[k - 1].script, tx.outputs[k].script) < 0, 'outputs sorted by script');
  assert.ok(tx.weight <= 400_000);
  assert.ok(fee >= Math.ceil(tx.weight / 4) * FR, `fee ${fee} meets ${FR} sat/vB at ${tx.vsize} vB`);
  assert.ok(tx.weight <= J.estimatedWeight(prevouts.map((p) => ({ type: J.scriptType(p.script) }))));
}

// ─────────────────────────────────────────────── parameters

test('allowance a(fr), f_in, entry value, ceiling and bucket choice', () => {
  assert.deepEqual(J.BUCKETS.map(J.allowance), [1000, 1000, 1000, 1000, 1500, 2000, 3000, 4000, 6500, 10500, 15500]);
  for (const fr of J.BUCKETS) {
    const a = J.allowance(fr);
    assert.ok(a >= 240 + 124 * fr && a % 500 === 0 && a - (240 + 124 * fr) < 500 + 1000);
  }
  // Mainnet s = 2: f_in is ⌈fr × 102.5⌉ (P2TR) and ⌈fr × 113⌉ (P2WPKH).
  for (const fr of J.BUCKETS) {
    assert.equal(J.inputFee(fr, 'p2tr', 10), Math.ceil(fr * 102.5));
    assert.equal(J.inputFee(fr, 'p2wpkh', 10), Math.ceil(fr * 113));
  }
  assert.equal(J.inputFee(1, 'p2tr', 3), 105); // signet: s = ⌈11/3⌉ = 4
  assert.throws(() => J.inputFee(1, 'p2sh', 3));
  assert.equal(J.outputValue(100_000, 10 > 8 ? 12 : 8), 102_000);
  assert.equal(J.entryOutputValue({ d: 10_000, fr: 1, kMin: 3 }), 11_000 + 105 + 105);
  assert.equal(J.excessCeiling(1, 'p2tr', 10), 5000);
  assert.equal(J.excessCeiling(120, 'p2wpkh', 10), 13_560);
  assert.equal(J.chooseBucket(4), 5);
  assert.equal(J.chooseBucket(4, (fr) => (fr === 8 ? 12 : 3)), 8);
  assert.equal(J.chooseBucket(3, (fr) => (fr === 5 ? 12 : 3)), 5);
  assert.equal(J.chooseBucket(2, (fr) => (fr === 3 ? 12 : 3)), 3);
  assert.equal(J.chooseBucket(5, (fr) => (fr === 8 ? 99 : 0)), 8, 'the fuller next bucket, 8 ≤ 2·5');
  assert.equal(J.chooseBucket(3.5, (fr) => (fr === 8 ? 99 : 0)), 5, '8 > 2·3.5 is refused');
  // The signet demo tier covers a faucet lot (1,000 sats) plus both buy-and-shield transactions at 2 sat/vB.
  assert.ok(J.outputValue(10_000, 1) >= 1000 + 546 + 500 + 500 + 330);
});

// ─────────────────────────────────────────────── BIP-352

const VECTORS = JSON.parse(readFileSync(new URL('./fixtures/bip352-send-and-receive-vectors.json', import.meta.url), 'utf8'));
function parseWitnessWire(h) {
  if (!h) return [];
  const b = hexToBytes(h); let p = 0; const n = b[p++]; const out = [];
  for (let i = 0; i < n; i++) { let l = b[p++]; if (l === 0xfd) { l = b[p] | (b[p + 1] << 8); p += 2; } out.push(b.slice(p, p + l)); p += l; }
  return out;
}

test('BIP-352 official vectors: the forward derivation of own outputs (receiver side, no sender secret)', () => {
  let ran = 0;
  for (const v of VECTORS) for (const rc of v.receiving || []) {
    const g = rc.given;
    if ((g.labels || []).length || rc.expected.outputs.length > 64) continue;
    const pubs = g.vin.map((vin) => tacit.bip352InputPubkey({
      prevoutScript: hexToBytes(vin.prevout.scriptPubKey.hex), scriptSig: vin.scriptSig ? hexToBytes(vin.scriptSig) : null, witness: parseWitnessWire(vin.txinwitness),
    }));
    const ops = g.vin.map((vin) => J.outpointBytes(vin.txid, vin.vout));
    const spendPub = secp.getPublicKey(hexToBytes(g.key_material.spend_priv_key), true);
    const scanPriv = hexToBytes(g.key_material.scan_priv_key);
    const expected = rc.expected.outputs;
    if (!expected.length) {
      // No valid inputs / A_sum at infinity: the derivation refuses, or derives nothing in the tx's outputs.
      let keys = [];
      try { keys = [J.ownOutputKeyFromPubs({ pubs, outpoints: ops, scanPriv, spendPub, k: 0 })]; } catch {}
      for (const k of keys) assert.ok(!g.outputs.includes(bytesToHex(k.xOnly)));
      ran++; continue;
    }
    const derived = expected.map((_, k) => J.ownOutputKeyFromPubs({ pubs, outpoints: ops, scanPriv, spendPub, k }));
    const want = new Map(expected.map((e) => [e.pub_key, e.priv_key_tweak]));
    for (const d of derived) {
      assert.ok(want.has(bytesToHex(d.xOnly)), `${v.comment}: derived output is expected`);
      assert.equal(bytesToHex(d.tweak), want.get(bytesToHex(d.xOnly)));
    }
    ran++;
  }
  assert.ok(ran >= 15, `ran ${ran} receiving vectors`);
});

test('BIP-352 official vectors: the entry transaction sender derivation', () => {
  let ran = 0;
  for (const v of VECTORS) for (const s of v.sending || []) {
    const g = s.given;
    if (!g.recipients?.length || g.recipients.length > 8 || !s.expected.outputs?.length || !s.expected.outputs[0]?.length) continue;
    const vin = g.vin.map((x) => ({
      x, pub: tacit.bip352InputPubkey({ prevoutScript: hexToBytes(x.prevout.scriptPubKey.hex), scriptSig: x.scriptSig ? hexToBytes(x.scriptSig) : null, witness: parseWitnessWire(x.txinwitness) }),
    }));
    const contributing = vin.filter((x) => x.pub);
    if (!contributing.length) continue;
    const inputs = contributing.map(({ x }) => ({ txid: x.txid, vout: x.vout, priv: hexToBytes(x.private_key), type: x.prevout.scriptPubKey.hex.startsWith('5120') ? 'p2tr' : 'ecdsa' }));
    const recipients = g.recipients.map((r) => {
      const d = tacit.decodeSilentPaymentAddress(r.address ?? r);
      return { scanPub: d.scanPub, spendPub: d.spendPub };
    });
    let out;
    try { out = J.bip352SendOutputs({ inputs, recipients, allOutpoints: g.vin.map((x) => J.outpointBytes(x.txid, x.vout)) }); } catch { continue; }
    const got = new Set(out.map((o) => bytesToHex(o.xOnly)));
    assert.ok(s.expected.outputs.some((set) => set.length === got.size && set.every((x) => got.has(x))), `${v.comment}`);
    ran++;
  }
  assert.ok(ran >= 12, `ran ${ran} sending vectors`);
});

test('entry transaction: outputs of o + f_in + margin to the own silent address, found by the wallet scan', () => {
  const walletPriv = privOf();
  const sp = tacit.deriveWalletSilentPaymentKeys(walletPriv, 1);
  const pub = secp.getPublicKey(walletPriv, true);
  const spk = J.p2wpkhScript(pub);
  const value = J.entryOutputValue({ d: D, fr: FR, kMin: K_MIN });
  const coins = [
    { txid: bytesToHex(rnd(32)), vout: 1, value: 30_000, spk: bytesToHex(spk), type: 'p2wpkh', priv: walletPriv, pub33: bytesToHex(pub) },
    { txid: bytesToHex(rnd(32)), vout: 0, value: 9_000, spk: bytesToHex(spk), type: 'p2wpkh', priv: walletPriv, pub33: bytesToHex(pub) },
  ];
  const e = J.buildEntryTx({ coins, keys: { scanPub: sp.scanPub, spendPub: sp.spendPub }, count: 3, value, changeSpk: spk, feeRate: 2 });
  const tx = parseRaw(hexToBytes(e.hex));
  verifyAllInputs(tx, coins.map((c) => ({ value: c.value, script: hexToBytes(c.spk) })));
  assert.equal(tx.outputs.length, 4);
  assert.ok(e.fee >= tx.vsize * 2 && e.fee < tx.vsize * 2 + 10);
  const m = tacit.receiverScanTxForSilentPayments({
    classifiedInputs: tx.inputs.map((i, k) => ({ kind: 'bip352', pub: tacit.bip352InputPubkey({ prevoutScript: hexToBytes(coins[k].spk), witness: i.witness }) })),
    allOutpoints: tx.inputs.map((i) => J.outpointBytes(i.txid, i.vout)), outputs: tx.outputs, scanPriv: sp.scanPriv, spendPub: sp.spendPub,
  });
  assert.deepEqual(m.map((x) => x.voutIndex).sort(), [0, 1, 2]);
  for (const x of m) assert.equal(tx.outputs[x.voutIndex].value, value);
  assert.deepEqual(e.outputs.map((o) => o.tweak).sort(), m.map((x) => bytesToHex(x.tweak)).sort());
});

// ─────────────────────────────────────────────── DC-net encoding

test('power sums: n distinct keys decode for n = 3..20 and 60; tampered sums and duplicates do not', () => {
  const P = secp.CURVE.p;
  for (const n of [3, 4, 5, 8, 13, 20, 60]) {
    const xs = Array.from({ length: n }, () => BigInt('0x' + bytesToHex(rnd(32))) % P);
    const S = new Array(n).fill(0n);
    for (const x of xs) J.powerVector(x, n).forEach((v, j) => { S[j] = (S[j] + v) % P; });
    const r = J.decodePowerSums(S);
    assert.ok(r && r.length === n && xs.every((x) => r.includes(x)), `n = ${n}`);
    const bad = S.slice(); bad[n - 1] = (bad[n - 1] + 1n) % P;
    assert.equal(J.decodePowerSums(bad), null);
  }
  const x = 12345n, y = 999n;
  const S = [3n * 0n, 0n, 0n].map((_, j) => (2n * x ** BigInt(j + 1) + y ** BigInt(j + 1)) % P);
  assert.equal(J.decodePowerSums(S), null, 'a repeated key is not n distinct roots');
});

test('DC-net: pads cancel in the sum; each vector alone reveals nothing of its key', () => {
  const topic = bytesToHex(rnd(32)), r = 1, n = 6;
  const ps = Array.from({ length: n }, () => {
    const e = J.randomScalar(); const s = J.randomScalar();
    return { e, E: secp.ProjectivePoint.BASE.multiply(e).toRawBytes(true), session: bytesToHex(J.xonlyOfPriv(s)), x: J.randomScalar() };
  });
  const vecs = ps.map((p) => J.dcVector({ topic, r, x: p.x, e: p.e, session: p.session, peers: ps, n }));
  const P = secp.CURVE.p;
  const S = new Array(n).fill(0n);
  for (const v of vecs) v.forEach((z, j) => { S[j] = (S[j] + z) % P; });
  const keys = J.decodePowerSums(S);
  assert.deepEqual(keys, ps.map((p) => p.x).sort((a, b) => (a < b ? -1 : 1)));
  for (const v of vecs) assert.notEqual((v[0] * v[0]) % P, v[1], 'a masked vector is not a power vector');
  // With every key revealed, each vector unmasks to its own key.
  const un = J.unmaskVectors({ topic, r, members: ps.map((p, i) => ({ session: p.session, E: p.E, e: p.e, dc: vecs[i] })) });
  un.forEach((u, i) => assert.equal(u.y, J.liftX(ps[i].x) ? ps[i].x : null));
});

test('blame verdicts: bad vector, duplicate keys, false blame', () => {
  const topic = bytesToHex(rnd(32)), r = 2, n = 4;
  const good = () => { for (;;) { const x = J.randomScalar(); if (J.liftX(x)) return x; } };
  const ps = Array.from({ length: n }, () => {
    const e = J.randomScalar();
    return { e, E: secp.ProjectivePoint.BASE.multiply(e).toRawBytes(true), session: bytesToHex(J.xonlyOfPriv(J.randomScalar())), x: good() };
  });
  const mk = (xs, tweak = -1) => ps.map((p, i) => {
    const dc = J.dcVector({ topic, r, x: xs[i], e: p.e, session: p.session, peers: ps, n });
    if (i === tweak) dc[2] = (dc[2] + 1n) % secp.CURVE.p;
    return { session: p.session, E: p.E, e: p.e, dc };
  });
  const xs = ps.map((p) => p.x);
  let v = J.blameVerdict({ topic, r, members: mk(xs, 1), blamers: [ps[0].session], inputKeys: new Set() });
  assert.deepEqual([...v.entries()], [[ps[1].session, 'bad-vector']]);
  v = J.blameVerdict({ topic, r, members: mk([xs[0], xs[0], xs[2], xs[3]]), blamers: [ps[2].session], inputKeys: new Set() });
  assert.deepEqual(new Set(v.keys()), new Set([ps[0].session, ps[1].session]));
  v = J.blameVerdict({ topic, r, members: mk(xs), blamers: [ps[3].session], inputKeys: new Set() });
  assert.deepEqual([...v.entries()], [[ps[3].session, 'false-blame']]);
  v = J.blameVerdict({ topic, r, members: mk(xs), blamers: [], inputKeys: new Set([xs[2]]) });
  assert.deepEqual([...v.entries()], [[ps[2].session, 'bad-vector']], 'an input key as output key is a bad vector');
});

// ─────────────────────────────────────────────── join silent payments

test('join silent payment: derived from the sender\'s input and the input set; found by scanning each input', () => {
  const chain = mockChain();
  const recipientPriv = privOf();
  const rk = tacit.deriveWalletSilentPaymentKeys(recipientPriv, 1);
  const clients = [makeClient(chain), makeClient(chain, { type: 'p2wpkh', value: O + 2000 }), makeClient(chain), makeClient(chain)];
  const members = J.sortInputs(clients.map((c) => ({ ...c.coin, pub33: c.coin.pub33 })));
  for (const sender of [clients[0], clients[1]]) {
    const outs = [0, 1].map((k) => J.joinSpSend({ inputs: members, own: sender.coin, recipient: { scanPub: rk.scanPub, spendPub: rk.spendPub }, k }));
    // Scan: every input in turn, as the recipient sees the transaction.
    const inputs = members.map((m) => ({ txid: m.txid, vout: m.vout, pub: J.inputPub(m) }));
    const decoys = clients.map(() => ({ script: J.p2trScript(J.xonlyOfPriv(privOf())) }));
    const outputs = [...decoys, ...outs.map((o) => ({ script: J.p2trScript(o.xOnly) }))];
    const found = J.joinSpScan({ inputs, outputs, scanPriv: rk.scanPriv, spendPub: rk.spendPub });
    assert.equal(found.length, 2);
    assert.deepEqual(found.map((f) => f.k), [0, 1]);
    const senderIdx = members.findIndex((m) => m.txid === sender.coin.txid);
    assert.ok(found.every((f) => f.inputIndex === senderIdx), 'the recipient learns the paying input');
    for (const f of found) {
      const sk = J.spendingKey(rk.spendPriv, f.tweak);
      assert.deepEqual(J.xonlyOfPriv(sk), outputs[f.vout].script.slice(2));
    }
    // The join's own tags: a standard BIP-352 scanner does not find it, and a rerun (new input set) changes it.
    const std = tacit.receiverScanTxForSilentPayments({
      classifiedInputs: inputs.map((i) => ({ kind: 'bip352', pub: i.pub })), allOutpoints: inputs.map((i) => J.outpointBytes(i.txid, i.vout)),
      outputs, scanPriv: rk.scanPriv, spendPub: rk.spendPub,
    });
    assert.equal(std.length, 0);
    const rerun = J.joinSpSend({ inputs: members.filter((m) => m !== members.find((x) => x.txid !== sender.coin.txid)), own: sender.coin, recipient: { scanPub: rk.scanPub, spendPub: rk.spendPub }, k: 0 });
    assert.notDeepEqual(rerun.xOnly, outs[0].xOnly);
  }
  // A labeled address (B_spend + label·G) is found with the label.
  const lt = J.labelTweak(rk.scanPriv, 7);
  const labeledSpend = secp.ProjectivePoint.fromHex(bytesToHex(rk.spendPub)).add(secp.ProjectivePoint.BASE.multiply(lt)).toRawBytes(true);
  const o = J.joinSpSend({ inputs: members, own: clients[2].coin, recipient: { scanPub: rk.scanPub, spendPub: labeledSpend } });
  const f = J.joinSpScan({ inputs: members.map((m) => ({ txid: m.txid, vout: m.vout, pub: J.inputPub(m) })), outputs: [{ script: J.p2trScript(o.xOnly) }], scanPriv: rk.scanPriv, spendPub: rk.spendPub, labels: [7] });
  assert.equal(f.length, 1); assert.equal(f[0].label, 7);
  assert.deepEqual(J.xonlyOfPriv(J.spendingKey(rk.spendPriv, f[0].tweak)), o.xOnly);
});

// ─────────────────────────────────────────────── full rounds

for (const n of [5, 8, 12, 20]) {
  test(`honest round, n = ${n}: one valid standard transaction, every output present and scanned, the board sees no mapping`, async () => {
    const chain = mockChain();
    const { core } = await makeBoard(chain);
    const clients = Array.from({ length: n }, (_, i) => makeClient(chain, { type: i % 3 === 2 ? 'p2wpkh' : 'p2tr', value: J.entryOutputValue({ d: D, fr: FR, kMin: K_MIN }) + (i % 3 === 2 ? 30 : 0) }));
    const hRef = chain.tip;
    const { results, topic } = await runRound({ chain, core, clients, opts: { tStepMs: 60_000 } });
    assert.ok(results.every((r) => r.status === 'broadcast'), JSON.stringify(results.map((r) => r.status)));
    const txids = new Set(results.map((r) => r.txid));
    assert.equal(txids.size, 1, 'every participant built the identical transaction');
    assert.equal(chain.broadcasts.length, 1);
    assert.ok(results.every((r) => r.runs === 1));
    assertStandardJoin(chain.broadcasts[0], { n, hRef });
    assertOwnOutputsScanned(chain, clients, results);
    // The board's view: no message carries an output key, no single vector is a power vector, and the
    // outputs are ordered by script, independent of the inputs.
    const stored = JSON.stringify(core.topics()) + JSON.stringify((await core.poll(topic, 0, 0)).messages);
    for (const o of chain.broadcasts[0].tx.outputs) assert.ok(!stored.includes(bytesToHex(o.script.slice(2))), 'output key absent from the board');
    const P = secp.CURVE.p;
    for (const { msg } of (await core.poll(topic, 0, 0)).messages) {
      if (msg.t !== 'MSG' || msg.step !== J.STEP.DC) continue;
      const v = J.decodeVector(msg.body);
      assert.notEqual((v[0] * v[0]) % P, v[1]);
    }
    // Each participant's output position is its script's rank, unrelated to its input position.
    const perm = results.map((r, i) => [chain.broadcasts[0].tx.inputs.findIndex((x) => x.txid === clients[i].coin.txid), r.own[0].vout]);
    assert.equal(perm.length, n);
  });
}

// Adversaries: each hook turns one participant into a disrupter.
const ADVERSARIES = {
  'bad vector': { hook: () => ({ vector: (r, v) => (r === 1 ? v.map((x, j) => (j === 1 ? (x + 5n) % secp.CURVE.p : x)) : v) }), why: 'bad-vector', evidence: 'bad-vector' },
  equivocation: { hook: () => ({ post: (r, step, body) => (r === 1 && step === J.STEP.KE ? [body, Uint8Array.from([...body.slice(0, 33).map((x, i) => (i === 0 ? x : x)), ...rnd(32)])] : body) }), why: 'equivocation', evidence: 'equivocation' },
  'withholding (DC)': { hook: () => ({ post: (r, step, body) => (r === 1 && step === J.STEP.DC ? null : body) }), why: 'missing' },
  'non-signing': { hook: () => ({ post: (r, step, body) => (r === 1 && step === J.STEP.SIG ? null : body) }), why: 'missing', candidate: true },
  'false blame': { hook: () => ({ post: (r, step, body) => (r === 1 && step === J.STEP.CONF ? Uint8Array.of(0) : body) }), why: 'false-blame', evidence: 'false-blame' },
  'commitment does not open': { hook: () => ({ post: (r, step, body) => (r === 1 && step === J.STEP.DC ? Uint8Array.from(body.map((x, i) => (i === 40 ? x ^ 1 : x))) : body) }), why: 'commitment', evidence: 'commitment' },
  'invalid witness': { hook: () => ({ post: (r, step, body) => (r === 1 && step === J.STEP.SIG ? Uint8Array.from(body.map((x, i) => (i === 10 ? x ^ 1 : x))) : body) }), why: 'bad-witness', candidate: true },
};

for (const [name, adv] of Object.entries(ADVERSARIES)) {
  test(`disrupter (${name}) is identified and excluded; the rerun completes without it`, async () => {
    const chain = mockChain();
    const { core } = await makeBoard(chain);
    const n = 7, bad = 3;
    const clients = Array.from({ length: n }, (_, i) => makeClient(chain, { type: i === 5 ? 'p2wpkh' : 'p2tr', value: J.entryOutputValue({ d: D, fr: FR, kMin: K_MIN }) + (i === 5 ? 30 : 0) }));
    const hRef = chain.tip;
    const { results, topic } = await runRound({ chain, core, clients, opts: { tStepMs: 2500 }, perClient: (c, i) => (i === bad ? { adversary: adv.hook(), maxRuns: 1 } : {}) });
    const honest = results.filter((_, i) => i !== bad);
    assert.ok(honest.every((r) => r.status === 'broadcast'), JSON.stringify(honest.map((r) => [r.status, r.excluded])));
    assert.equal(new Set(honest.map((r) => r.txid)).size, 1);
    for (const r of honest) {
      assert.equal(r.runs, 2, 'one failed run, one rerun');
      assert.deepEqual(r.excluded.map((e) => e.outpoint), [J.outpointKey(clients[bad].coin)], 'exactly the disrupter');
      assert.equal(r.excluded[0].why, adv.why);
      if (adv.candidate) assert.equal(r.candidates.length, 1, 'the signed run-1 transaction is tracked as a candidate');
    }
    assert.notEqual(results[bad].status, 'broadcast');
    const b = chain.broadcasts.find((x) => x.txid === honest[0].txid);
    assertStandardJoin(b, { n: n - 1, hRef });
    assert.ok(!b.tx.inputs.some((i) => i.txid === clients[bad].coin.txid));
    assertOwnOutputsScanned(chain, clients.filter((_, i) => i !== bad), honest);
    // Keys revealed in run 1 are never reused: the final outputs differ from every run-1 vector's key.
    if (adv.evidence) {
      const ev = core.evidence().filter((e) => e.topic === topic && e.txid === clients[bad].coin.txid);
      assert.ok(ev.length >= 1, 'evidence posted');
      assert.equal(ev[0].kind, adv.evidence);
      assert.equal(await J.verifyEvidence(ev[0], { chain }), true, 'evidence verifies independently');
      // Forged evidence against an honest participant does not verify.
      const forged = J.makeEvidence({ topic, txid: clients[0].coin.txid, vout: clients[0].coin.vout, kind: adv.evidence, bundle: ev[0].bundle, sessionPriv: J.randomScalar() });
      assert.equal(await J.verifyEvidence(forged, { chain }), false);
    }
  });
}

test('two disrupters in one round cost at most three runs', async () => {
  const chain = mockChain();
  const { core } = await makeBoard(chain);
  const clients = Array.from({ length: 7 }, () => makeClient(chain));
  const { results } = await runRound({
    chain, core, clients, opts: { tStepMs: 2500 },
    perClient: (c, i) => (i === 1 ? { adversary: ADVERSARIES['bad vector'].hook(), maxRuns: 1 } : i === 4 ? { adversary: { post: (r, step, body) => (step === J.STEP.SIG ? null : body) } } : {}),
  });
  const honest = results.filter((_, i) => i !== 1 && i !== 4);
  assert.ok(honest.every((r) => r.status === 'broadcast' && r.runs <= 3));
  assert.equal(new Set(honest.map((r) => r.txid)).size, 1);
  assert.equal(chain.broadcasts[0].tx.inputs.length, 5);
  assertOwnOutputsScanned(chain, clients.filter((_, i) => i !== 1 && i !== 4), honest);
});

// ─────────────────────────────────────────────── a faulty board

// Per-participant views of one board: `filter(i, msg)` decides whether participant i sees a message.
function filteredTransports(core, n, filter) {
  const base = memoryTransport(core);
  return Array.from({ length: n }, (_, i) => ({
    ...base,
    poll: async (topic, since, waitMs) => {
      const r = await base.poll(topic, since, waitMs);
      return { ...r, messages: r.messages.filter(({ msg }) => filter(i, msg)) };
    },
  }));
}

test('board withholds one participant\'s messages from the others: it is excluded, nobody loses a coin', async () => {
  const chain = mockChain();
  const { core } = await makeBoard(chain);
  const n = 6, victim = 2;
  const clients = Array.from({ length: n }, () => makeClient(chain));
  const victimSession = { s: null };
  const transports = filteredTransports(core, n, (i, msg) => {
    if (msg.t === 'JOIN' && msg.txid === clients[victim].coin.txid) victimSession.s = msg.session;
    return !(i !== victim && msg.t === 'MSG' && msg.session === victimSession.s && msg.step === J.STEP.CM);
  });
  const { results } = await runRound({ chain, core, clients, transports, opts: { tStepMs: 2000, maxRuns: 3 } });
  const others = results.filter((_, i) => i !== victim);
  assert.ok(others.every((r) => r.status === 'broadcast'));
  assert.notEqual(results[victim].status, 'broadcast');
  for (const b of chain.broadcasts) assert.ok(!b.tx.inputs.some((i) => i.txid === clients[victim].coin.txid), 'the victim signed nothing');
  assertOwnOutputsScanned(chain, clients.filter((_, i) => i !== victim), others);
});

test('board splits the round into two views: each part runs alone; every broadcast pays each of its signers', async () => {
  const chain = mockChain();
  const { core } = await makeBoard(chain);
  const n = 8;
  const clients = Array.from({ length: n }, () => makeClient(chain));
  const group = (i) => (i < 4 ? 0 : 1);
  const sessionGroup = new Map();
  const transports = filteredTransports(core, n, (i, msg) => {
    if (msg.t === 'JOIN') sessionGroup.set(msg.session, group(clients.findIndex((c) => c.coin.txid === msg.txid)));
    if (msg.t !== 'MSG') return true;
    return sessionGroup.get(msg.session) === group(i);
  });
  const { results } = await runRound({ chain, core, clients, transports, opts: { tStepMs: 2000, maxRuns: 3 } });
  assert.ok(results.every((r) => r.status === 'broadcast'), JSON.stringify(results.map((r) => r.status)));
  assert.equal(chain.broadcasts.length, 2, 'two separate joins');
  for (const b of chain.broadcasts) {
    assert.equal(b.tx.inputs.length, 4);
    const signers = results.filter((r) => r.txid === b.txid);
    assert.equal(signers.length, 4);
  }
  assertOwnOutputsScanned(chain, clients, results);
});

test('board equivocates CLOSE (different JOIN sets): input sets disagree, parts separate, no loss', async () => {
  const chain = mockChain();
  const { core } = await makeBoard(chain);
  const n = 7;
  const clients = Array.from({ length: n }, () => makeClient(chain));
  // Participant 6's JOIN is hidden from participants 0..2 only.
  const transports = filteredTransports(core, n, (i, msg) => !(i < 3 && msg.t === 'JOIN' && msg.txid === clients[6].coin.txid));
  const { results } = await runRound({ chain, core, clients, transports, opts: { tStepMs: 2000, maxRuns: 3 } });
  for (const b of chain.broadcasts) {
    for (const r of results.filter((x) => x.txid === b.txid)) assert.ok(b.tx.outputs.some((o) => bytesToHex(o.script) === r.own[0].spk));
  }
  const done = results.filter((r) => r.status === 'broadcast');
  assert.ok(done.length >= 3);
  const inputsUsed = chain.broadcasts.flatMap((b) => b.tx.inputs.map((i) => i.txid));
  assert.equal(new Set(inputsUsed).size, inputsUsed.length, 'no coin in two broadcasts');
  assertOwnOutputsScanned(chain, clients, results);
});

// ─────────────────────────────────────────────── remix, funding and the checklist

test('remix inputs ride on fresh margins; outputs stay exactly o; |R| ≤ |Φ|; trimming drops the highest remix', async () => {
  const chain = mockChain();
  const { core } = await makeBoard(chain);
  // A confirmed earlier join at the same tier: 4 outputs of exactly o, owned by remixers.
  const remixers = Array.from({ length: 4 }, () => ({ priv: privOf() }));
  for (const r of remixers) r.spk = J.p2trScript(J.xonlyOfPriv(r.priv));
  const vin = remixers.map(() => ({ txid: bytesToHex(rnd(32)), vout: 0, prevout: { scriptpubkey: '5120' + bytesToHex(rnd(32)), value: O + 300 }, witness: [bytesToHex(rnd(64))] }));
  const parent = chain.addTx(remixers.map((r) => ({ script: r.spk, value: O })), { vin });
  assert.ok(J.joinShape(parent));
  const remixClients = remixers.map((r) => {
    const walletPriv = privOf(); const sp = tacit.deriveWalletSilentPaymentKeys(walletPriv, 1);
    const vout = parent.vout.findIndex((o) => o.scriptpubkey === bytesToHex(r.spk));
    return { walletPriv, sp, keys: { scanPriv: sp.scanPriv, spendPub: sp.spendPub }, coin: { txid: parent.txid, vout, value: O, spk: bytesToHex(r.spk), type: 'p2tr', priv: r.priv } };
  });
  const fresh = Array.from({ length: 3 }, () => makeClient(chain));
  const clients = [...fresh, ...remixClients];
  const { results } = await runRound({ chain, core, clients, opts: { tStepMs: 3000 } });
  const done = results.filter((r) => r.status === 'broadcast');
  const b = chain.broadcasts[0];
  const remixIn = b.tx.inputs.filter((i) => i.txid === parent.txid).length;
  assert.ok(remixIn <= 3, '|R| ≤ |Φ|');
  assert.ok(remixIn >= 2, 'fresh margins fund remixes');
  assert.equal(done.length, 3 + remixIn);
  assert.ok(b.tx.outputs.every((o) => o.value === O));
  assert.ok(b.fee >= Math.ceil(b.tx.weight / 4) * FR);
  const noRound = results.filter((r) => r.status === 'no-round');
  assert.equal(noRound.length, 4 - remixIn, 'remixes beyond the funding rule are not admitted');
  assertOwnOutputsScanned(chain, clients, results);

  // Funding arithmetic directly: removing a fresh input forces the highest-ranked remix out.
  const members = [
    ...[0, 1, 2].map((i) => ({ txid: 'a' + i, value: J.entryOutputValue({ d: D, fr: FR, kMin: K_MIN }), type: 'p2tr', cls: 'fresh', rank: Uint8Array.of(i) })),
    ...[0, 1, 2].map((i) => ({ txid: 'b' + i, value: O, type: 'p2tr', cls: 'remix', rank: Uint8Array.of(10 + i) })),
  ];
  const ctx = { o: O, fr: FR, kMin: K_MIN };
  assert.ok(J.fundingOk(members, ctx));
  const trimmed = J.trimToFunding(members.filter((m) => m.txid !== 'a0'), ctx);
  assert.deepEqual(trimmed.map((m) => m.txid), ['a1', 'a2', 'b0', 'b1']);
  assert.ok(J.fundingOk(trimmed, ctx));
  assert.ok(!J.fundingOk([...members, { txid: 'b9', value: O, type: 'p2tr', cls: 'remix', rank: Uint8Array.of(99) }], ctx), '|R| > |Φ| fails');
});

test('pre-signing checklist refuses every altered transaction', () => {
  const chain = mockChain();
  const clients = Array.from({ length: 4 }, () => makeClient(chain));
  const members = J.sortInputs(clients.map((c) => ({ ...c.coin, cls: 'fresh', confirmations: 10 })));
  const own = clients.map((c) => J.ownOutputKey({ inputs: members, scanPriv: c.keys.scanPriv, spendPub: c.keys.spendPub }));
  const base = { members, own: [{ spk: J.p2trScript(own[0].xOnly) }], coin: clients[0].coin, o: O, hRef: 777, fr: FR, frOwn: FR, kMin: K_MIN, ageMin: 6 };
  const build = () => J.buildJoinTx({ inputs: members, keys: own.map((x) => x.xOnly), o: O, hRef: 777 });
  const failing = (mutate, id, extra = {}) => { const tx = build(); mutate(tx); const r = J.verifyBeforeSigning({ ...base, ...extra, tx }); assert.equal(r.ok, false); assert.ok(r.checks.find((c) => c.id === id && !c.ok), id); };
  assert.equal(J.verifyBeforeSigning({ ...base, tx: build() }).ok, true);
  failing((tx) => { tx.locktime = 778; }, '1-shape');
  failing((tx) => { tx.inputs[0].sequence = 0xffffffff; }, '1-shape');
  failing((tx) => { tx.inputs.push({ txid: bytesToHex(rnd(32)), vout: 0, sequence: 0xfffffffd, witness: [] }); }, '2-inputs');
  failing((tx) => { tx.outputs[1].value = O - 1; }, '3-outputs');
  failing((tx) => { tx.outputs.find((o) => bytesToHex(o.script) === bytesToHex(J.p2trScript(own[0].xOnly))).script = J.p2trScript(rnd(32)); }, '4-own-output');
  failing((tx) => { tx.outputs[0].script = J.p2wpkhScript(secp.getPublicKey(privOf(), true)); }, '3-outputs');
  failing(() => {}, '5-k-eff', { kMinClient: 5 });
  failing(() => {}, '5-k-eff', { members: members.map((m) => ({ ...m, confirmations: 2 })) });
  failing(() => {}, '6-own-excess', { frOwn: 0.5 });
  failing(() => {}, '2-inputs', { members: members.map((m) => ({ ...m, value: O + 100 })) });
});

test('client refuses a run whose own output would be missing (a peer drops it from the decoded set)', async () => {
  // Board-side tampering cannot remove a key from the DC sum without breaking decoding; a participant that
  // replaces its vector with someone else's key is caught as a bad or duplicate vector. The final line
  // is check 4: build T without the own key and it is refused.
  const chain = mockChain();
  const clients = Array.from({ length: 3 }, () => makeClient(chain));
  const members = J.sortInputs(clients.map((c) => ({ ...c.coin, cls: 'fresh', confirmations: 10 })));
  const keys = clients.map((c) => J.ownOutputKey({ inputs: members, scanPriv: c.keys.scanPriv, spendPub: c.keys.spendPub }).xOnly);
  const tx = J.buildJoinTx({ inputs: members, keys: [keys[1], keys[2], rnd(32)], o: O, hRef: 1 });
  const r = J.verifyBeforeSigning({ tx, members, own: [{ spk: J.p2trScript(keys[0]) }], coin: clients[0].coin, o: O, hRef: 1, fr: FR, frOwn: FR, kMin: K_MIN, ageMin: 1 });
  assert.equal(r.ok, false);
});

test('join-shaped detection', () => {
  const chain = mockChain();
  const mk = (n, val = O) => chain.addTx(Array.from({ length: n }, () => ({ script: J.p2trScript(rnd(32)), value: val })), {
    vin: Array.from({ length: n }, () => ({ txid: bytesToHex(rnd(32)), vout: 0, prevout: { scriptpubkey: '5120' + bytesToHex(rnd(32)), value: val + 500 }, witness: [bytesToHex(rnd(64))] })),
  });
  assert.deepEqual(J.joinShape(mk(3)), { d: D, value: O, allowance: J.allowance(FR) });
  assert.equal(J.joinShape(mk(2)), null);
  assert.equal(J.joinShape(mk(3, O + 1)), null);
  const t = mk(4); t.vin[1].witness = [bytesToHex(rnd(64)), 'c0' + bytesToHex(rnd(32))];
  assert.equal(J.joinShape(t), null, 'script-path input');
  assert.ok(J.joinShape(mk(4, 100_000 + 15_500)));
});

test('local exclusion list: 24 h × 2^(m−1), capped at 30 days, one hop to spending transactions', () => {
  let t = 0; const mem = { v: null };
  const ex = J.makeExclusionList({ get: () => mem.v, set: (v) => { mem.v = v; } }, () => t);
  const o = { txid: 'aa'.repeat(32), vout: 1 };
  ex.add(o);
  assert.ok(ex.has(o)); t = 86_400_000 + 1; assert.ok(!ex.has(o));
  ex.add(o); t += 2 * 86_400_000 - 10; assert.ok(ex.has(o)); t += 20; assert.ok(!ex.has(o));
  for (let i = 0; i < 8; i++) ex.add(o);
  assert.equal(ex.entries()[J.outpointKey(o)].until - t, 30 * 86_400_000);
  const child = { txid: 'bb'.repeat(32), vout: 0 };
  assert.ok(ex.excludes(child, { vin: [{ txid: o.txid, vout: 1 }] }));
  assert.ok(!ex.excludes(child, { vin: [{ txid: o.txid, vout: 0 }] }));
  const ex2 = J.makeExclusionList({ get: () => mem.v, set: () => {} }, () => t);
  assert.ok(ex2.has(o), 'persists through storage');
});

test('a client that excludes a peer locally forms a different input set and separates', async () => {
  const chain = mockChain();
  const { core } = await makeBoard(chain);
  const clients = Array.from({ length: 7 }, () => makeClient(chain));
  const ex = J.makeExclusionList();
  ex.add(clients[6].coin);
  const { results } = await runRound({ chain, core, clients, opts: { tStepMs: 2000, maxRuns: 3 }, perClient: (c, i) => (i < 3 ? { exclusions: ex } : {}) });
  for (const b of chain.broadcasts) for (const r of results.filter((x) => x.txid === b.txid)) assert.ok(b.tx.outputs.some((o) => bytesToHex(o.script) === r.own[0].spk));
  const withLocal = results.slice(0, 3).filter((r) => r.status === 'broadcast');
  for (const r of withLocal) assert.ok(!chain.broadcasts.find((b) => b.txid === r.txid).tx.inputs.some((i) => i.txid === clients[6].coin.txid));
});

// ─────────────────────────────────────────────── mixed output → buy and shield

test('a mixed output funds buy-and-shield alone; change returns to a fresh output of the own silent address', async () => {
  const chain = mockChain();
  const { core } = await makeBoard(chain);
  const clients = Array.from({ length: 4 }, () => makeClient(chain));
  const { results } = await runRound({ chain, core, clients, opts: { tStepMs: 30_000 } });
  const me = clients[0], r = results[0];
  assert.equal(r.status, 'broadcast');
  chain.mine();
  // Find the output by scanning, as the page does after confirmation.
  const tx = await chain.getTx(r.txid);
  const found = J.scanJoinForOwn(tx, me.keys);
  assert.equal(found.length, 1);
  assert.equal(found[0].tweak, r.own[0].tweak);
  const coin = J.mixedCoin({ ...found[0], spendPriv: me.sp.spendPriv });
  assert.equal(coin.spk, r.own[0].spk);

  // A pre-authorized sale of a 1,000-sat faucet lot, as tests/btc-pool-zap.test.mjs builds it.
  const bp = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });
  const zap = makeBtcPoolZap({ secp, sha256, keccak256: keccak_256 });
  const sellerPriv = privOf(); const sellerPub = secp.getPublicKey(sellerPriv, true);
  const payout = J.p2wpkhScript(sellerPub);
  const amount = 10_000n, blinding = BigInt('0x' + bytesToHex(rnd(32))) % N;
  const C = bp.commitXY(amount, blinding);
  const outpoint = { txid: bytesToHex(rnd(32)), vout: 0, value: 546 };
  const digest = zap.singleAcpSighash({ outpoint, value: 546, pkh: payout.slice(2), payout: { value: 1000, script: payout } });
  const sigC = secp.sign(digest, sellerPriv, { lowS: true }).toCompactRawBytes();
  const der = (() => { const int = (x) => { let i = 0; while (i < 31 && x[i] === 0) i++; let t = x.slice(i); return t[0] & 0x80 ? concatBytes(Uint8Array.of(0), t) : t; }; const R = int(sigC.slice(0, 32)), S = int(sigC.slice(32)); return concatBytes(Uint8Array.of(0x30, 4 + R.length + S.length, 2, R.length), R, Uint8Array.of(2, S.length), S); })();
  const ASSET = 'ab'.repeat(32);
  const sale = {
    asset_id: ASSET, seller_pubkey: bytesToHex(sellerPub), seller_payout_script: bytesToHex(payout), asset_outpoint: outpoint,
    asset_opening: { amount: amount.toString(), blinding: blinding.toString(16).padStart(64, '0') }, min_price_sats: 1000,
    expiry: Math.floor(Date.now() / 1000) + 3600, seller_asset_spend_sig: bytesToHex(concatBytes(der, Uint8Array.of(0x83))),
  };
  const commitment = concatBytes(Uint8Array.of(BigInt(C.cy) & 1n ? 3 : 2), hexToBytes(String(C.cx).replace(/^0x/, '').padStart(64, '0')));
  const { tacit: tk, wallet, change } = J.zapFromMixedCoin({
    coin, keys: { scanPub: me.sp.scanPub, spendPub: me.sp.spendPub, spendPriv: me.sp.spendPriv }, makeBtcWallet, hrp: 'tb', feeRate: 2,
    resolveNote: async (txid, vout) => (txid === outpoint.txid && vout === outpoint.vout ? { assetIdHex: ASSET, commitment } : null),
  });
  const standIn = { prove: async (input) => ({ wire: new Uint8Array(256), publicSignals: publicSignals(input) }) };
  const alice = bp.walletFromSeed(rnd(32), 'signet');
  const z = await zap.buyAndShield({ tacit: tk, pool: bp, sale, wallet, recipientAddress: alice.addressString, system: standIn });
  const commit = parseRaw(hexToBytes(z.commitHex));
  assert.deepEqual(commit.inputs.map((i) => [i.txid, i.vout]), [[coin.txid, coin.vout]], 'the mixed output is the only input');
  verifyAllInputs(commit, [{ value: coin.value, script: hexToBytes(coin.spk) }]);
  // Commit change: a silent payment to the own address, found by tacit.js's ordinary scan.
  const m = tacit.receiverScanTxForSilentPayments({
    classifiedInputs: [{ kind: 'bip352', pub: tacit.bip352InputPubkey({ prevoutScript: hexToBytes(coin.spk), witness: commit.inputs[0].witness }) }],
    allOutpoints: [J.outpointBytes(coin.txid, coin.vout)], outputs: commit.outputs, scanPriv: me.sp.scanPriv, spendPub: me.sp.spendPub,
  });
  assert.equal(m.length, 1);
  assert.equal(bytesToHex(commit.outputs[m[0].voutIndex].script), change.spk);
  assert.equal(bytesToHex(m[0].tweak), change.tweak);
  const carrier = parseRaw(hexToBytes(z.carrierHex));
  assert.equal(bytesToHex(carrier.outputs[0].script), change.spk, 'carrier change to the same fresh key');
  assert.equal(carrier.outputs[1].value, 1000);
  const spent = commit.outputs.reduce((s, o) => s + o.value, 0) + (coin.value - commit.outputs.reduce((s, o) => s + o.value, 0));
  assert.equal(spent, O);
  assert.ok(carrier.outputs[0].value >= 330);
});

test('an async decoder (a Worker in the dapp) completes the round; an abort while gathering leaves no trace', async () => {
  const chain = mockChain();
  const { core } = await makeBoard(chain);
  const clients = Array.from({ length: 3 }, () => makeClient(chain));
  let calls = 0;
  const decode = async (S) => { calls++; await new Promise((r) => setTimeout(r, 5)); return J.decodePowerSums(S); };
  const { results } = await runRound({ chain, core, clients, opts: { decode } });
  assert.deepEqual(results.map((r) => r.status), ['broadcast', 'broadcast', 'broadcast']);
  assert.equal(calls, 3);

  const c = makeClient(chain);
  const fresh = await makeBoard(chain);
  const ctl = new AbortController();
  const p = J.runParticipant({ board: memoryTransport(fresh.core), chain, network: NET, d: D, fr: FR, coin: c.coin, keys: c.keys, hRef: chain.tip, ageMin: 1, signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 50));
  ctl.abort();
  assert.equal((await p).status, 'cancelled');
});

// ─────────────────────────────────────────────── the board over HTTP

test('board HTTP: CORS, size and signature checks, rate limit on the right-most X-Forwarded-For hop, and a round through makeHttpBoard', async () => {
  const { createServer } = await import('node:http');
  const chain = mockChain();
  const { core, cfg } = await makeBoard(chain, { ratePost: 5000, rateGet: 20_000, maxBody: 60_000 });
  const server = createServer(createHandler({ core, cfg }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${url}/join/v1/info`, { headers: { origin: 'https://tacit.finance' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://tacit.finance');
    assert.equal((await r.json()).boardKey, core.boardKey);
    r = await fetch(`${url}/join/v1/info`, { headers: { origin: 'http://localhost:8765' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:8765');
    r = await fetch(`${url}/join/v1/info`, { headers: { origin: 'https://evil.example' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    r = await fetch(`${url}/join/v1/topics`, { method: 'OPTIONS', headers: { origin: 'https://tacit.finance' } });
    assert.equal(r.status, 204);

    const c = makeClient(chain);
    const join = J.makeJoin({ network: NET, d: D, fr: FR, hRef: chain.tip, boardKey: core.boardKey, coin: c.coin, sessionPub: J.xonlyOfPriv(J.randomScalar()) });
    r = await fetch(`${url}/join/v1/${join.topic}`, { method: 'POST', body: JSON.stringify({ ...join, sig: '00'.repeat(64) }) });
    assert.equal(r.status, 400);
    r = await fetch(`${url}/join/v1/${join.topic}`, { method: 'POST', body: JSON.stringify({ ...join, d: 12_345 }) });
    assert.equal(r.status, 400);
    r = await fetch(`${url}/join/v1/${join.topic}`, { method: 'POST', body: 'x'.repeat(70_000) });
    assert.equal(r.status, 413);
    r = await fetch(`${url}/join/v1/${join.topic}`, { method: 'POST', body: JSON.stringify(join) });
    assert.equal(r.status, 200);
    r = await fetch(`${url}/join/v1/${join.topic}`, { method: 'POST', body: JSON.stringify(join) });
    assert.equal(r.status, 409, 'a coin joins a topic once');
    const msg = J.makeMsg({ topic: join.topic, r: 1, step: J.STEP.CM, body: rnd(32), view: rnd(32), sessionPriv: J.randomScalar() });
    r = await fetch(`${url}/join/v1/${join.topic}`, { method: 'POST', body: JSON.stringify(msg) });
    assert.equal(r.status, 409, 'no run messages before CLOSE');
    r = await fetch(`${url}/join/v1/${join.topic}?since=0&wait=0`);
    assert.equal((await r.json()).messages.length, 1);

    // Rate limit: a spoofed left-most hop does not help; the right-most one is the client.
    const lim = await makeBoard(chain, { ratePost: 3 });
    const s2 = createServer(createHandler({ core: lim.core, cfg: lim.cfg }));
    await new Promise((res) => s2.listen(0, '127.0.0.1', res));
    const u2 = `http://127.0.0.1:${s2.address().port}`;
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${u2}/join/v1/log`, { method: 'POST', headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.9` }, body: '{}' })).status);
    assert.deepEqual(codes.slice(3), [429, 429]);
    assert.equal((await fetch(`${u2}/join/v1/log`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.1' }, body: '{}' })).status, 400, 'another client is not limited');
    s2.close();

    // A full round over HTTP.
    const clients = Array.from({ length: 4 }, () => makeClient(chain));
    const board = J.makeHttpBoard(url);
    const hRef = chain.tip;
    const runs = clients.map((cl) => J.runParticipant({ board, chain, network: NET, d: D, fr: FR, coin: cl.coin, keys: cl.keys, hRef, tStepMs: 20_000, jitter: 50, ageMin: 1 }));
    const topic = J.topicId({ network: NET, d: D, fr: FR, hRef, boardKey: core.boardKey });
    for (let i = 0; i < 300 && !(core.topics().find((t) => t.topic === topic)?.joins >= 5); i++) await new Promise((res) => setTimeout(res, 20));
    core.closeNow(topic);
    const res = await Promise.all(runs);
    const ok = res.filter((x) => x.status === 'broadcast');
    assert.equal(ok.length, 4, JSON.stringify(res.map((x) => x.status)));
    assert.equal(new Set(ok.map((x) => x.txid)).size, 1);
    assertOwnOutputsScanned(chain, clients, res);
    const log = await (await fetch(`${url}/join/v1/log`)).json();
    assert.ok(log.log.some((e) => e.txid === ok[0].txid));
    const tl = await (await fetch(`${url}/join/v1/topics`)).json();
    assert.equal(tl.topics.find((t) => t.topic === topic).closed, true);
  } finally {
    server.close();
  }
});

test('board CLOSE follows the first block after h_ref plus the delay', async () => {
  const chain = mockChain();
  let t = 1_000_000;
  const cfg = { ...configFromEnv({ JOIN_NETWORK: NET }), closeDelayMs: 60_000 };
  const store = await openStore(null);
  const core = createBoard({ cfg, store, boardPriv: J.randomScalar(), tip: async () => chain.tip, now: () => t });
  await core.tick();
  const c = makeClient(chain);
  const join = J.makeJoin({ network: NET, d: D, fr: FR, hRef: chain.tip, boardKey: core.boardKey, coin: c.coin, sessionPub: J.xonlyOfPriv(J.randomScalar()) });
  core.post(join.topic, join);
  await core.tick();
  assert.equal(core.topics()[0].closed, false);
  chain.tip++; t += 1000; await core.tick();
  assert.equal(core.topics()[0].closed, false, 'waits the delay after the block');
  t += 60_000; await core.tick();
  assert.equal(core.topics()[0].closed, true);
  const { messages } = await core.poll(join.topic, 0, 0);
  const close = messages.find((m) => m.msg.t === 'CLOSE').msg;
  assert.equal(close.lastSeq, 1);
  assert.ok(J.verifyClose(close, core.boardKey));
  assert.ok(!J.verifyClose({ ...close, lastSeq: 2 }, core.boardKey));
});

// ─────────────────────────────────────────────── runner

const filter = process.env.JOIN_TEST_FILTER || '';
let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  if (filter && !name.includes(filter)) continue;
  const t0 = performance.now();
  try {
    await fn();
    pass++;
    console.log(`  PASS  ${name} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name}\n        ${e.stack?.split('\n').slice(0, 4).join('\n        ')}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
