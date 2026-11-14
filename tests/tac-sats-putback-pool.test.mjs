// Put back (dapp/sats/secret.js shieldFromSaleKey) against the pool's own rules: TAC taken out of the pool to a sale key goes back in,
// the input signed by the sale key and the carrier funded by the wallet. The real pieces: the wallet's pool spend with an exit to a
// sale key (worker/src/btc-shielded-pool.js acceptSpend, which records the exit), the opening recovered from that spend
// (recoverExit), the shield built and proved by the page's code over the real Halo2 prover, the reveal transaction it would
// broadcast, the envelope read back out of that transaction by the page's extractor, and the pool's state machine and the pinned
// verifier judging it, with the shield input resolved by the indexer's own resolver from the pool's exit record. The Bitcoin
// network is stubbed; the funding shield and the exit spend carry placeholder proofs (not under test), the put-back's is real.
//   node tests/tac-sats-putback-pool.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from './_jsdom.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, navigator: dom.window.navigator });
globalThis.location = dom.window.location; globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'mainnet');

const T = await import('../dapp/tacit.js');
const secret = await import('../dapp/sats/secret.js');
const bp = await import('../worker/src/btc-shielded-pool.js');
const { makeShieldInputResolver } = await import('../worker-relay/src/lib/btc-pool-transparent.js');
const { makeHalo2System, HALO2_PROOF_LEN } = await import('../dapp/btc-pool-halo2-prover.js');
const { secp, sha256, ripemd160, bytesToHex, hexToBytes } = await import('../dapp/vendor/tacit-deps.min.js');
const { pool } = secret;

const PIN_DIR = new URL('../dapp/btc-pool/', import.meta.url);
const PIN = JSON.parse(readFileSync(new URL('pin.json', PIN_DIR), 'utf8'));
const art = (n) => new Uint8Array(readFileSync(new URL(n, PIN_DIR)));
const sys = makeHalo2System({ wasm: art(PIN.wasm), params: art(PIN.params), vk: art(PIN.vk), pinnedVkHash: PIN.vk_hash, worker: null });
const realVerify = ({ proof, publics }) => sys.verify(publics, proof);
const accept = async () => true;
const NO_PROOF = new Uint8Array(HALO2_PROOF_LEN);

const ASSET_HEX = secret.TAC_ASSET_MAINNET, A0X = '0x' + ASSET_HEX;
const walletPriv = hexToBytes('a1'.repeat(32));
const pw = secret.poolWalletFor(walletPriv, 'mainnet');
const relay = pool.walletFromSeed(new Uint8Array(32).fill(8), 'mainnet');
const sale = secret.saleKey(pw, 9);                                   // a take-out far along the counters: any sale key serves
const X = 97207564851n, FEE = 1500000000n, CHANGE = 7564851n, V = X + FEE + CHANGE;   // 972.07564851 TAC out, the relay's 15 TAC, 0.07564851 kept
const EXIT_TXID = 'e1'.repeat(32);

// ── the wallet's note in the pool: a transparent TAC note shielded to it ──
const r0 = 12345n, C0 = pool.commitXY(V, r0);
const txin = { txid: 'cd'.repeat(32), vout: 1, value: V, blinding: r0, Cx: C0.cx, Cy: C0.cy };
const sh = pool.buildShieldEnvelope({ asset: A0X, inputs: [txin], recipientAddress: pw.addressString });
const st = new bp.BtcPoolState();
st.beginBlock(100);
const rs = await st.acceptShield(bp.parseEnvelope(pool.assembleShield(sh, NO_PROOF)), {
  txid: 'ee'.repeat(32), inputs: [{ txid: 'aa'.repeat(32), vout: 0 }, { txid: txin.txid, vout: 1 }],
  resolveInput: async (op, a) => (op.txid === txin.txid && op.vout === 1 && a === ASSET_HEX ? { cx: C0.cx, cy: C0.cy } : null), verifyProof: accept,
});
assert.ok(rs.accepted, rs.reason);
st.endBlock();
for (let h = 101; h <= 110; h++) { st.beginBlock(h); st.endBlock(); }
const mine = pool.scan(pw, rs.leaves);
assert.deepEqual(mine.map((x) => x.value), [V]);

// ── the take-out: the relay's fee, the change and a zero note go to pool outputs, the TAC to the sale key's script ──
const hA = 102;
const { root, path } = st.tree.rootAndPathAt(mine[0].leafIndex, st.leafCountAt(hA));
const sp = pool.buildSpendBody({
  asset: A0X, hAnchor: hA, root, inputs: [{ ...mine[0], path }], wallet: pw,
  outputs: [{ address: relay.addressString, value: FEE }, { address: pw.internalAddress, network: 'mainnet', value: CHANGE }, { address: pw.internalAddress, network: 'mainnet', value: 0n }],
  exit: { exitVout: 0, scriptPubKey: '0x' + sale.scriptPubKey, value: X },
});
const spPayload = pool.assembleSpendEnvelope(sp.body, NO_PROOF);
st.beginBlock(111);
const r2 = await st.acceptSpend(bp.parseEnvelope(spPayload), { txid: EXIT_TXID, inputs: [], outputs: [{ value: 546n, scriptPubKey: hexToBytes(sale.scriptPubKey) }], vin0TacitOp: false, verifyProof: accept });
assert.ok(r2.accepted, r2.reason);
st.endBlock();
for (let h = 112; h <= 125; h++) { st.beginBlock(h); st.endBlock(); }
const exitRec = st.exits.get(`${EXIT_TXID}:0`);
assert.ok(exitRec, 'the pool recorded the exit');

// ── the page reads the lot back as saleKeys does: the opening from the spend, the relay's address opening the fee note ──
const own = pool.scan(pw, [...rs.leaves, ...r2.leaves]);
const rec = pool.recoverExit(pw, spPayload, own, { addresses: [relay.addressString] });
assert.equal(BigInt(rec.value), X, 'the amount is rebuilt from the spend');

// ── Put back: the page's own code, the real prover, the Bitcoin side stubbed ──
const p2wpkh = (pub) => Uint8Array.from([0x00, 0x14, ...ripemd160(sha256(pub))]);
const salePub = hexToBytes(sale.pub);
T.wallet.priv = walletPriv; T.wallet.pub = secp.getPublicKey(walletPriv, true);
const coin = { txid: 'c1'.repeat(32), vout: 1, value: 20000 };
const commitment = secp.ProjectivePoint.fromAffine({ x: BigInt('0x' + bytesToHex(exitRec.cx)), y: BigInt('0x' + bytesToHex(exitRec.cy)) }).toRawBytes(true);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url), json = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (u.endsWith(`/tx/${EXIT_TXID}`)) return json({ txid: EXIT_TXID, vout: [{ value: 546, scriptpubkey: bytesToHex(p2wpkh(salePub)) }], status: { confirmed: true } });
  if (u.endsWith(`/tx/${EXIT_TXID}/outspend/0`)) return json({ spent: false });
  throw new Error('unexpected fetch ' + u);
};
secret.poolClient.artifactBytes = async () => 0;
secret.poolClient.system = async () => sys;
const sent = {};
const t = Object.assign(Object.create(T), {
  getFeeRate: async () => 3,
  getUtxos: async () => [coin],
  scanHoldings: async () => new Map(),
  broadcast: async (hex) => { sent.commit = hex; return 'x'; },
  broadcastWithRetry: async (hex) => { sent.reveal = hex; return 'x'; },
  txOutputEnvelope: () => ({ opcode: 0x6d, payload: new Uint8Array(0) }),      // the take-out's carrier, as onChainNote reads it
  getParentEnvelopeData: async () => ({ assetIdHex: ASSET_HEX, commitment }),   // the commitment the pool recorded for the exit
});
const t0 = performance.now();
const res = await secret.shieldFromSaleKey(t, { key: sale, note: { txid: EXIT_TXID, vout: 0, value: BigInt(rec.value), blinding: BigInt(rec.blinding) }, asset: ASSET_HEX, poolWallet: pw, say: () => {} });
globalThis.fetch = realFetch;
console.log(`  put-back proved and built in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
assert.ok(sent.commit && sent.reveal, 'a commit and a reveal were produced');

// ── the reveal, read the way the indexer reads a transaction ──
const dsha = (b) => sha256(sha256(b));
function parse(hex) {
  const b = hexToBytes(hex); let p = 0;
  const rd = (n) => { const s = b.slice(p, p + n); p += n; return s; };
  const vi = () => { const f = b[p++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b[p] | (b[p + 1] << 8); p += 2; return v; } throw new Error('big varint'); };
  const tx = { ins: [], outs: [] }; tx.version = rd(4);
  const seg = b[p] === 0 && b[p + 1] === 1; if (seg) p += 2;
  for (let i = 0, n = vi(); i < n; i++) tx.ins.push({ prev: rd(36), script: rd(vi()), seq: rd(4) });
  for (let i = 0, n = vi(); i < n; i++) tx.outs.push({ value: new DataView(rd(8).buffer).getBigUint64(0, true), script: rd(vi()) });
  if (seg) for (const inp of tx.ins) { inp.wit = []; for (let k = 0, n = vi(); k < n; k++) inp.wit.push(rd(vi())); }
  tx.lock = rd(4);
  return tx;
}
const reveal = parse(sent.reveal), commit = parse(sent.commit);

// ── who signs what, checked with an independent BIP-143 (not the page's): the wallet signs only the commit's coin, the sale key signs the note ──
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let q = 0; for (const x of a) { o.set(x, q); q += x.length; } return o; };
const outBytes = (o) => cat(u64(o.value), Uint8Array.of(o.script.length), o.script);
function bip143(tx, idx, pub, value) {
  const hp = dsha(cat(...tx.ins.map((x) => x.prev))), hs = dsha(cat(...tx.ins.map((x) => x.seq))), ho = dsha(cat(...tx.outs.map(outBytes)));
  const code = cat(Uint8Array.of(0x19, 0x76, 0xa9, 0x14), ripemd160(sha256(pub)), Uint8Array.of(0x88, 0xac));
  return dsha(cat(tx.version, hp, hs, tx.ins[idx].prev, code, u64(value), tx.ins[idx].seq, ho, tx.lock, u32(1)));
}
function signedBy(tx, idx, pub, value) {
  const [sigFull, wpub] = tx.ins[idx].wit || [];
  if (!sigFull || bytesToHex(wpub) !== bytesToHex(pub) || sigFull[sigFull.length - 1] !== 0x01) return false;   // the key's own witness, SIGHASH_ALL
  const der = sigFull.slice(0, -1), rl = der[3], r = der.slice(4, 4 + rl), sl = der[5 + rl], sg = der.slice(6 + rl, 6 + rl + sl);
  const pad = (x) => { const y = x[0] === 0 ? x.slice(1) : x; const o = new Uint8Array(32); o.set(y, 32 - y.length); return o; };
  return secp.verify(cat(pad(r), pad(sg)), bip143(tx, 0 + idx, pub, value), pub, { lowS: false });
}
assert.ok(signedBy(commit, 0, T.wallet.pub, coin.value), 'the commit’s coin is signed by the wallet');
assert.ok(signedBy(reveal, 1, salePub, 546), 'the note is signed by the sale key, over its 546 sats');
assert.ok(!signedBy(reveal, 1, T.wallet.pub, 546), 'and not by the wallet');
assert.equal(reveal.outs.length, 1);
assert.equal(bytesToHex(reveal.outs[0].script), bytesToHex(p2wpkh(T.wallet.pub)), 'the reveal pays its 546 sats back to the wallet');
const outpoint = (x) => ({ txid: bytesToHex(x.prev.slice(0, 32).reverse()), vout: new DataView(x.prev.slice(32).buffer).getUint32(0, true) });
const revealTx = {
  txid: res.revealTxid,
  vin: reveal.ins.map((x) => ({ ...outpoint(x), witness: (x.wit || []).map(bytesToHex) })),
  vout: reveal.outs.map((o) => ({ value: Number(o.value), scriptpubkey: bytesToHex(o.script) })),
};
assert.deepEqual(revealTx.vin[1].txid + ':' + revealTx.vin[1].vout, `${EXIT_TXID}:0`, 'the note at the sale key is the reveal’s second input, after the commit');
const env = T.txOutputEnvelope(revealTx);
assert.ok(env && env.opcode === 0x6c, 'the page’s extractor reads a shield envelope out of the reveal');
const parsed = bp.parseEnvelope(env.payload);
assert.equal(parsed.kind, 'shield');
assert.equal(parsed.proof.length, HALO2_PROOF_LEN);

// ── the pool: its resolver finds the exit note by outpoint in the exit record, then its state machine and the pinned verifier decide ──
const resolveNote = makeShieldInputResolver({ esplora: null, network: 'mainnet', exits: () => st.exits });
const resolveInput = async (op, assetHex) => { const n = await resolveNote(op.txid, op.vout, { height: 126 }); return n && n.asset === assetHex && !n.bound ? { cx: n.Cx, cy: n.Cy } : null; };
st.beginBlock(126);
const ctx = { txid: res.revealTxid, inputs: revealTx.vin, resolveInput, verifyProof: realVerify };
const badProof = env.payload.slice(); badProof[badProof.length - HALO2_PROOF_LEN + 40] ^= 1;
assert.match((await st.acceptShield(bp.parseEnvelope(badProof), ctx)).reason, /proof does not verify/, 'the verifier is the real one: a flipped proof byte is refused');
const back = await st.acceptShield(parsed, ctx);
assert.ok(back.accepted, `the pool accepts the put-back: ${back.reason}`);
st.endBlock();
const credited = pool.scan(pw, back.leaves);
assert.deepEqual(credited.map((x) => x.value), [X], 'and credits the wallet with the whole amount');
assert.ok(!credited[0].internal, 'at the wallet’s own pool address');
console.log('tac-sats-putback-pool: all checks passed');
process.exit(0);
