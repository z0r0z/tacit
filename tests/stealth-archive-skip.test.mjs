// The scan for shielded payments does not ask an explorer for a transfer the API's archive proves holds nothing for this key. The archive hands over each transaction as raw bytes checked
// against its txid, with no inputs' previous outputs; the sender's funding input's previous output is read from the archive's own copy of the transaction it spends from (also checked), and
// the credits are worked out by the code discoverStealthFromTxid uses. So the check must never disagree with an explorer read: a transfer it clears holds nothing for this key when read
// from an explorer too, a transfer that pays this key is never cleared, and anything the archive cannot show (a transfer or a parent it lacks, bytes that do not hash to the txid) is read
// from an explorer as always. A txid does not cover witnesses, so bytes that hash to the txid but lost or changed a witness are not cleared either. Mocked chain and archive; no network.
//   node --no-experimental-global-navigator tests/stealth-archive-skip.test.mjs      (Node 22)
import assert from 'node:assert/strict';
import { JSDOM } from './_jsdom.mjs';
import { randomBytes, createHash } from 'node:crypto';

const dom = new JSDOM('', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, location: dom.window.location, __TACIT_NO_INIT__: true });
if (!globalThis.navigator) globalThis.navigator = dom.window.navigator;
localStorage.setItem('tacit-network-v1', 'mainnet');
globalThis.__TACIT_TX_ARCHIVE_BURST__ = 1e9;      // the API's pace for the archive is tested in tx-archive.test.mjs; this mocked archive has no limit

// ── a chain served two ways: as esplora serves a transaction (an explorer read) and as raw bytes (the archive) ──
const explorer = new Map();            // txid -> esplora-shaped transaction
const archive = { txs: new Map(), asked: [], lacks: new Set(), bad: new Set(), plain: new Map(), noFund: false };   // plain: the ordinary funding transactions the API keeps apart
const reads = [];                      // txids asked of an explorer
const INDEX = {};
const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input?.url ?? input));
  const post = (init?.method || 'GET').toUpperCase() === 'POST';
  if (post && url.pathname.endsWith('/chain/tac/ancestry')) {
    const body = JSON.parse(init.body); archive.asked.push(body);
    const out = {};
    const give = (id) => { const r = archive.txs.get(id); if (r && !archive.lacks.has(id)) out[id] = { hex: archive.bad.has(id) ? r.hex.slice(0, 100) + (r.hex[100] === '0' ? '1' : '0') + r.hex.slice(101) : r.hex, h: 900000 }; };
    for (const root of body.roots) { give(root); if (body.depth >= 1) for (const v of (explorer.get(root)?.vin || [])) give(v.txid); }
    // `fund: true` also brings the ordinary transactions that fund the roots' key-spend inputs (a witness of one or two items) from the API's second store, as the real API does
    let fund = null;
    if (body.fund === true && !archive.noFund) {
      fund = {};
      for (const root of body.roots) for (const v of (explorer.get(root)?.vin || [])) {
        const items = (v.witness || []).length, r = archive.plain.get(v.txid);
        if ((items === 1 || items === 2) && !out[v.txid] && r && !archive.lacks.has(v.txid)) fund[v.txid] = { hex: archive.bad.has(v.txid) ? r.hex.slice(0, 100) + (r.hex[100] === '0' ? '1' : '0') + r.hex.slice(101) : r.hex, h: 2 };
      }
    }
    return json({ txs: out, truncated: false, ...(fund ? { fund } : {}) });
  }
  const listed = /\/assets\/([0-9a-f]{64})\/recent-xfer-txids$/.exec(url.pathname);
  if (listed && INDEX[listed[1]]) return json({ asset_id: listed[1], txids: INDEX[listed[1]], next_cursor: null, done: true });
  const m = /\/tx\/([0-9a-f]{64})$/.exec(url.pathname);
  if (m && explorer.has(m[1])) { reads.push(m[1]); return json(explorer.get(m[1])); }
  if (/\/tx\/[0-9a-f]{64}\/outspend$/.test(url.pathname)) return json({ spent: false });
  if (/\/address\/[^/]+\/(utxo|txs)/.test(url.pathname) || url.pathname.includes('/scripthash/')) return json([]);
  throw new Error('offline: ' + url);
};

const T = await import('../dapp/tacit.js');
const BP = await import('./bulletproofs.mjs');
const { secp } = await import('../dapp/vendor/tacit-deps.min.js');
T.setTxReadSpacingMs(0);

const hex = (b) => Buffer.from(b).toString('hex');
const u8 = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const rnd = () => BigInt('0x' + hex(randomBytes(32))) % T.SECP_N;
const b32 = (x) => u8(x.toString(16).padStart(64, '0'));
const old = Math.floor(Date.now() / 1000) - 7200;

// a segwit serialisation of an esplora-shaped transaction, and the txid its bytes hash to
const sha = (b) => createHash('sha256').update(b).digest();
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const vi = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 255, n >> 8]));
function serialise(tx) {
  const ins = tx.vin.map((v) => { const ss = Buffer.from(v.scriptsig || '', 'hex'); return Buffer.concat([Buffer.from(v.txid, 'hex').reverse(), le32(v.vout), vi(ss.length), ss, le32(0xffffffff)]); });
  const outs = tx.vout.map((o) => { const s = Buffer.from(o.scriptpubkey, 'hex'); return Buffer.concat([le64(o.value), vi(s.length), s]); });
  const noWit = Buffer.concat([le32(2), vi(tx.vin.length), ...ins, vi(tx.vout.length), ...outs, le32(0)]);
  const wit = tx.vin.map((v) => { const items = (v.witness || []).map((h) => Buffer.from(h, 'hex')); return Buffer.concat([vi(items.length), ...items.map((i) => Buffer.concat([vi(i.length), i]))]); });
  const full = Buffer.concat([le32(2), Buffer.from([0, 1]), vi(tx.vin.length), ...ins, vi(tx.vout.length), ...outs, ...wit, le32(0)]);
  return { hex: full.toString('hex'), txid: sha(sha(noWit)).reverse().toString('hex') };
}
// put a transaction on the chain: its txid is what its bytes hash to
function land(tx) {
  const { hex: raw, txid } = serialise(tx);
  tx.txid = txid; tx.version = 2; tx.locktime = 0;
  explorer.set(txid, tx); archive.txs.set(txid, { hex: raw });
  return txid;
}

// An ordinary transaction (no envelope) the API keeps in its second store, not among the Tacit ones.
function landPlain(tx) {
  const { hex: raw, txid } = serialise(tx);
  tx.txid = txid; tx.version = 2; tx.locktime = 0;
  explorer.set(txid, tx); archive.plain.set(txid, { hex: raw });
  return txid;
}

// The bytes of an esplora-shaped transaction with the witness of some inputs removed (and no segwit marker when every input is) or replaced: they hash to the same txid.
function tampered(tx, { strip = new Set(), swap = {} } = {}) {
  const ins = tx.vin.map((v) => { const ss = Buffer.from(v.scriptsig || '', 'hex'); return Buffer.concat([Buffer.from(v.txid, 'hex').reverse(), le32(v.vout), vi(ss.length), ss, le32(0xffffffff)]); });
  const outs = tx.vout.map((o) => { const s = Buffer.from(o.scriptpubkey, 'hex'); return Buffer.concat([le64(o.value), vi(s.length), s]); });
  const noWit = Buffer.concat([le32(2), vi(tx.vin.length), ...ins, vi(tx.vout.length), ...outs, le32(0)]);
  const txid = sha(sha(noWit)).reverse().toString('hex');
  if (tx.vin.every((_, i) => strip.has(i))) return { hex: noWit.toString('hex'), txid };
  const wit = tx.vin.map((v, i) => { const items = (strip.has(i) ? [] : (swap[i] || v.witness || [])).map((h) => Buffer.from(h, 'hex')); return Buffer.concat([vi(items.length), ...items.map((it) => Buffer.concat([vi(it.length), it]))]); });
  return { hex: Buffer.concat([le32(2), Buffer.from([0, 1]), vi(tx.vin.length), ...ins, vi(tx.vout.length), ...outs, ...wit, le32(0)]).toString('hex'), txid };
}
const tamper = (X, opts) => { const t = tampered(explorer.get(X), opts); assert.equal(t.txid, X, 'the changed bytes still hash to the txid'); archive.txs.set(X, { hex: t.hex }); };

// A funding transaction paying `senderPub`, and a stealth CXFER that spends it and pays `amount` to `recipientPub` at vout 0, both on the chain with their real txids.
function transfer(tag, { senderPriv, recipientPub, amount = 400n, supply = 1000n, plainParent = false }) {
  const senderPub = secp.getPublicKey(senderPriv, true);
  const rE = rnd();
  const pe = BP.bpRangeAggProve([supply], [rE]);
  const etchPayload = T.encodeCEtchPayload({ ticker: 'TST', decimals: 0, commitment: T.pointToBytes(pe.commitments[0]), rangeproof: pe.proof, encryptedAmount: new Uint8Array(8), mintAuthority: null, imageUri: null });
  const funding = { vin: [{ txid: tag + '03'.repeat(31), vout: 0, witness: ['00'.repeat(64), hex(T.encodeEnvelopeScript(T.wallet.xonly(), etchPayload)), 'c0' + '11'.repeat(32)] }],
    vout: [{ scriptpubkey: hex(T.p2wpkhScript(senderPub)), scriptpubkey_type: 'v0_p2wpkh', value: 546 }], status: { confirmed: true, block_height: 1, block_time: old } };
  const E = land(funding);
  // the sender's key-spend input spends E (a Tacit transaction), or with `plainParent` an ordinary transaction F that only the second store holds
  const F = plainParent ? landPlain({ vin: [{ txid: tag + '0a'.repeat(31), vout: 0, witness: ['30'.repeat(71), '02' + '55'.repeat(32)] }], vout: [{ scriptpubkey: hex(T.p2wpkhScript(senderPub)), scriptpubkey_type: 'v0_p2wpkh', value: 546 }], status: { confirmed: true, block_height: 2, block_time: old } }) : E;
  const aid = T.assetIdFor(E, 0);
  const anchor = new Uint8Array([...u8(F).reverse(), 0, 0, 0, 0]);       // the amount's keystream is anchored to the sender's key-spend input, as the scan derives it
  const r0 = T.deriveBlinding(senderPriv, recipientPub, anchor, 0), r1 = rnd();
  const ks = T.deriveAmountKeystreamECDH(senderPriv, recipientPub, anchor, 0);
  const pp = BP.bpRangeAggProve([amount, supply - amount], [r0, r1]);
  const C0 = T.pointToBytes(pp.commitments[0]), C1 = T.pointToBytes(pp.commitments[1]);
  const kernelSig = T.signSchnorr(T.computeKernelMsg(aid, [{ txid: E, vout: 0 }], [C0, C1], 0n), b32(T.modN(r0 + r1 - rE)));
  const payload = T.encodeCXferPayload({ assetId: aid, kernelSig, rangeproof: pp.proof, outputs: [{ commitment: C0, encryptedAmount: T.encryptAmount(amount, ks) }, { commitment: C1, encryptedAmount: new Uint8Array(8) }] });
  const b = T.deriveStealthEcdhBlinding({ ourPriv: senderPriv, theirPub: recipientPub, networkTag: 'mainnet', domain: T.STEALTH_DOMAIN_BY_OPCODE.get(0x23), txAnchor: new Uint8Array([...T.stealthTxAnchorHead(F, 0), 0, 0, 0, 0]) });
  const commit = T.computeStealthCommit({ underlyingPub: recipientPub, blinding: b });
  const tx = { vin: [
      { txid: tag + '33'.repeat(31), vout: 0, witness: ['00'.repeat(64), hex(T.encodeEnvelopeScript(T.wallet.xonly(), payload)), 'c0' + '11'.repeat(32)], prevout: { scriptpubkey: '5120' + '44'.repeat(32), scriptpubkey_type: 'v1_p2tr', value: 3000 } },
      { txid: F, vout: 0, witness: ['30'.repeat(71), hex(senderPub)], prevout: { scriptpubkey: hex(T.p2wpkhScript(senderPub)), scriptpubkey_type: 'v0_p2wpkh', value: 546 } },
    ],
    vout: [{ scriptpubkey: hex(T.p2wpkhScript(commit)), scriptpubkey_type: 'v0_p2wpkh', value: 777 }, { scriptpubkey: hex(T.p2wpkhScript(senderPub)), scriptpubkey_type: 'v0_p2wpkh', value: 546 }],
    status: { confirmed: true, block_height: 900000, block_time: old } };
  const X = land(tx);
  return { X, E, F, aid: hex(aid), amount };
}

const V = new Uint8Array(randomBytes(32)), Vpub = secp.getPublicKey(V, true);      // the wallet that scans
const W = new Uint8Array(randomBytes(32)), Wpub = secp.getPublicKey(W, true);      // someone else
const A = new Uint8Array(randomBytes(32));                                         // the sender
const asWallet = (priv, pub) => { T.wallet.priv = priv; T.wallet.pub = pub; };
asWallet(V, Vpub);

let n = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok ${++n} - ${name}`); } catch (e) { failed++; console.log(`not ok ${++n} - ${name}\n  ${e?.stack || e}`); }
}
// an explorer read of a transfer: with the archive turned off nothing is cleared from it
const viaExplorer = async (fn) => { localStorage.setItem('tacit-tx-archive', 'off'); try { return await fn(); } finally { localStorage.removeItem('tacit-tx-archive'); } };
const prefetch = async (...ids) => { archive.asked.length = 0; await T._txArchiveForTests().prefetch(ids, { depth: 1, fund: true }); };      // as the scan asks

const toV = transfer('a1', { senderPriv: A, recipientPub: Vpub });       // pays the scanning wallet
const toW = transfer('b2', { senderPriv: A, recipientPub: Wpub });       // pays someone else
// a transaction with a single input, and one that carries no envelope
const single = land({ vin: [{ txid: 'c3'.repeat(32), vout: 0, witness: ['30'.repeat(71), hex(Vpub)] }], vout: [{ scriptpubkey: hex(T.p2wpkhScript(Vpub)), value: 600 }], status: { confirmed: true, block_height: 5, block_time: old } });
const plain = land({ vin: [{ txid: 'c4'.repeat(32), vout: 0, witness: ['30'.repeat(71), hex(Vpub)] }, { txid: 'c5'.repeat(32), vout: 1, witness: ['30'.repeat(71), hex(Vpub)] }],
  vout: [{ scriptpubkey: hex(T.p2wpkhScript(Vpub)), value: 600 }], status: { confirmed: true, block_height: 5, block_time: old } });

await test('the fixtures hash to their txids, so the archive accepts them', async () => {
  await prefetch(toV.X);
  assert.ok(T._txArchiveForTests().get(toV.X) && T._txArchiveForTests().get(toV.E), 'the transfer and the transaction it spends from were handed over and kept');
});

await test('a transfer that pays this key is never cleared: it is read from an explorer, where its credit is found', async () => {
  asWallet(V, Vpub);
  await prefetch(toV.X, toW.X);
  assert.equal(T._stealthNothingFromArchive(toV.X), false);
  const found = await viaExplorer(() => T.discoverStealthFromTxid(toV.X));
  assert.deepEqual(found.map((d) => [d.vout, d.amount]), [[0, 400n]], 'an explorer read finds the credit');
});

await test('a transfer that pays someone else is cleared, and an explorer read of it finds nothing too', async () => {
  asWallet(V, Vpub);
  await prefetch(toV.X, toW.X);
  assert.equal(T._stealthNothingFromArchive(toW.X), true, 'cleared from the archive');
  assert.deepEqual(await viaExplorer(() => T.discoverStealthFromTxid(toW.X)), [], 'and an explorer read agrees');
  // and the other way round: the wallet the transfer pays is not cleared of it, the one it does not pay is
  asWallet(W, Wpub);
  assert.equal(T._stealthNothingFromArchive(toW.X), false, 'the recipient is not cleared');
  assert.equal(T._stealthNothingFromArchive(toV.X), true, 'the other wallet is');
  assert.deepEqual(await viaExplorer(() => T.discoverStealthFromTxid(toV.X)), [], 'as an explorer read says');
  asWallet(V, Vpub);
});

await test('a transaction with one input is cleared without any previous output, and one whose first input holds no envelope is read from an explorer', async () => {
  await prefetch(single, plain);
  assert.equal(T._stealthNothingFromArchive(single), true);
  assert.equal(T._stealthNothingFromArchive(plain), false, 'the archive holds Tacit transactions, so a first input without an envelope is bytes that lost its witness');
  assert.deepEqual(await viaExplorer(() => T.discoverStealthFromTxid(plain)), [], 'and an explorer read finds nothing in it');
});

await test('what the archive cannot show is not cleared: a transfer it lacks, a parent it lacks, bytes that do not hash to the txid', async () => {
  asWallet(V, Vpub);
  const fresh = (tag) => transfer(tag, { senderPriv: A, recipientPub: Wpub });
  const lacksSelf = fresh('d4'), lacksParent = fresh('e5'), badParent = fresh('f6'), badSelf = fresh('a7');
  archive.lacks.add(lacksSelf.X); archive.lacks.add(lacksParent.E); archive.bad.add(badParent.E); archive.bad.add(badSelf.X);
  await prefetch(lacksSelf.X, lacksParent.X, badParent.X, badSelf.X);
  assert.equal(T._stealthNothingFromArchive(lacksSelf.X), false, 'a transfer the archive lacks');
  assert.equal(T._stealthNothingFromArchive(lacksParent.X), false, 'a transfer whose funding parent the archive lacks');
  assert.equal(T._stealthNothingFromArchive(badParent.X), false, 'a funding parent whose bytes were changed');
  assert.equal(T._stealthNothingFromArchive(badSelf.X), false, 'a transfer whose bytes were changed');
  assert.equal(T._stealthNothingFromArchive('99'.repeat(32)), false, 'a transaction nothing is known of');
  archive.lacks.clear(); archive.bad.clear();
});

await test('discoverStealthFromTxid itself asks no explorer for a transfer the archive clears, and asks as ever for one it does not', async () => {
  asWallet(V, Vpub);
  const clear = transfer('21', { senderPriv: A, recipientPub: Wpub }), pays = transfer('22', { senderPriv: A, recipientPub: Vpub });
  await prefetch(clear.X, pays.X);
  reads.length = 0;
  assert.deepEqual(await T.discoverStealthFromTxid(clear.X), []);
  assert.deepEqual(reads, [], 'a transfer the archive clears was not read from an explorer');
  const found = await T.discoverStealthFromTxid(pays.X);
  assert.deepEqual(found.map((d) => d.amount), [400n], 'one that pays this key is read, and its credit found');
  assert.ok(reads.includes(pays.X), 'from an explorer');
});

await test('a scan reads from an explorer only the transfers the archive does not clear, and finds the same as a scan that reads them all', async () => {
  asWallet(V, Vpub);
  const ASSET = 'ab'.repeat(32);
  const mine = transfer('11', { senderPriv: A, recipientPub: Vpub }), others = [transfer('12', { senderPriv: A, recipientPub: Wpub }), transfer('13', { senderPriv: A, recipientPub: Wpub })];
  INDEX[ASSET] = [mine.X, others[0].X, single, others[1].X, plain];
  reads.length = 0; archive.asked.length = 0;
  const viaArchive = await T.scanAssetForStealthReceipts(ASSET, { pageLimit: 50, maxPages: 1, gapMs: 0 });
  assert.deepEqual(reads.filter((id) => INDEX[ASSET].includes(id) && id !== plain), [mine.X], 'bar the transfer without an envelope (not cleared, and an earlier read of it is kept by the page), only the transfer that pays this key was read from an explorer');
  assert.equal(viaArchive.txsFromArchive, 3, 'the three others were cleared from the archive, the transfer without an envelope was not');
  assert.equal(viaArchive.txsScanned, 5);
  assert.deepEqual(viaArchive.discovered.map((d) => [d.txid === mine.X, d.amount]), [[true, 400n]]);
  assert.ok(archive.asked.length >= 1 && archive.asked.every((b) => b.depth === 1), 'the archive was asked for the transfers with the transactions they spend from');
  // the same scan with the archive turned off reads all five from an explorer and finds the same
  localStorage.setItem('tacit-tx-archive', 'off');
  reads.length = 0;
  const viaExplorer = await T.scanAssetForStealthReceipts(ASSET, { pageLimit: 50, maxPages: 1, gapMs: 0, useSeenCache: false });
  const readNow = reads.filter((id) => INDEX[ASSET].includes(id));
  assert.deepEqual([...readNow].filter((id) => id !== plain).sort(), [others[0].X, single, others[1].X].sort(), 'with the archive off every transfer is read from an explorer, bar the one the page already held from the first scan (and the one an earlier test read, which the page keeps)');
  assert.equal(viaExplorer.txsFromArchive, 0);
  assert.deepEqual(viaExplorer.discovered.map((d) => [d.txid === mine.X, d.amount]), viaArchive.discovered.map((d) => [d.txid === mine.X, d.amount]), 'and finds exactly what the other scan found');
  localStorage.removeItem('tacit-tx-archive');
});


await test('a transfer funded by an ordinary transaction only the API\'s second store holds is cleared from the archive, with no explorer read, and never when it pays this key', async () => {
  asWallet(V, Vpub);
  const toOther = transfer('31', { senderPriv: A, recipientPub: Wpub, plainParent: true }), toMe = transfer('32', { senderPriv: A, recipientPub: Vpub, plainParent: true });
  assert.ok(archive.plain.has(toOther.F) && !archive.txs.has(toOther.F), 'the funding transaction is ordinary: the Tacit store lacks it');
  await prefetch(toOther.X, toMe.X);
  assert.ok(archive.asked.every((b) => b.fund === true && b.depth === 1), 'the scan asks for the funding transactions');
  assert.equal(T._txArchiveForTests().get(toOther.F), null, 'a general read never finds it (get() holds only the Tacit transactions)');
  assert.ok(T._txArchiveForTests().getFunding(toOther.F), 'the scan\'s own lookup does');
  assert.equal(T._stealthNothingFromArchive(toOther.X), true, 'cleared: the previous output of its key-spend input came from the second store');
  assert.deepEqual(await viaExplorer(() => T.discoverStealthFromTxid(toOther.X)), [], 'and an explorer read agrees it holds nothing for this key');
  assert.equal(T._stealthNothingFromArchive(toMe.X), false, 'a transfer that pays this key is not cleared (its credit is found from the second store\'s previous output, so it goes on to be read and validated as always)');
  reads.length = 0;
  assert.deepEqual(await T.discoverStealthFromTxid(toOther.X), []);
  assert.deepEqual(reads, [], 'discoverStealthFromTxid asked no explorer for the cleared one');
});

await test('when the second store lacks the funding transaction, or its bytes are wrong, or the API predates it, the transfer is read from an explorer as always', async () => {
  asWallet(V, Vpub);
  const lacks = transfer('41', { senderPriv: A, recipientPub: Wpub, plainParent: true }), bad = transfer('42', { senderPriv: A, recipientPub: Wpub, plainParent: true }), old = transfer('43', { senderPriv: A, recipientPub: Wpub, plainParent: true });
  archive.lacks.add(lacks.F); archive.bad.add(bad.F);
  await prefetch(lacks.X, bad.X);
  assert.equal(T._stealthNothingFromArchive(lacks.X), false, 'the second store lacks it');
  assert.equal(T._stealthNothingFromArchive(bad.X), false, 'its bytes do not hash to its txid');
  archive.lacks.clear(); archive.bad.clear();
  archive.noFund = true;
  await prefetch(old.X);
  assert.equal(T._stealthNothingFromArchive(old.X), false, 'an API that does not know `fund` gives none');
  archive.noFund = false;
});

await test('a scan over transfers with ordinary funding parents reads from an explorer only the one that pays this key', async () => {
  asWallet(V, Vpub);
  const ASSET = 'cd'.repeat(32);
  const mine = transfer('51', { senderPriv: A, recipientPub: Vpub, plainParent: true }), others = [transfer('52', { senderPriv: A, recipientPub: Wpub, plainParent: true }), transfer('53', { senderPriv: A, recipientPub: Wpub, plainParent: true })];
  INDEX[ASSET] = [mine.X, others[0].X, others[1].X];
  reads.length = 0;
  const viaArchive = await T.scanAssetForStealthReceipts(ASSET, { pageLimit: 50, maxPages: 1, gapMs: 0 });
  assert.deepEqual(reads.filter((id) => INDEX[ASSET].includes(id)), [mine.X], 'only the transfer that pays this key was read from an explorer');
  assert.equal(viaArchive.txsFromArchive, 2, 'the two that pay someone else were cleared from the archive');
});

await test('bytes that hash to the txid but lost or changed a witness are never cleared: the transfer is read from an explorer, where its credit is found', async () => {
  asWallet(V, Vpub);
  const cases = [
    ['every witness removed (no segwit marker)', () => ({ strip: new Set([0, 1]) })],
    ['the first input\'s witness removed', () => ({ strip: new Set([0]) })],
    ['the sender\'s key-spend witness removed, the envelope kept', () => ({ strip: new Set([1]) })],
    ['the sender\'s key in its witness replaced by another key', () => ({ swap: { 1: ['30'.repeat(71), hex(Wpub)] } })],
  ];
  let k = 0;
  for (const [name, mk] of cases) {
    const t = transfer((0x70 + k++).toString(16), { senderPriv: A, recipientPub: Vpub });
    tamper(t.X, mk());
    await prefetch(t.X);
    assert.equal(T._stealthNothingFromArchive(t.X), false, name);
    reads.length = 0;
    const found = await T.discoverStealthFromTxid(t.X);
    assert.deepEqual(found.map((d) => d.amount), [400n], `${name}: the explorer read finds the credit`);
    assert.ok(reads.includes(t.X), `${name}: it was read from an explorer`);
    // a transfer that pays someone else is not cleared from such bytes either (an explorer read says what it holds)
    const o = transfer((0x80 + k).toString(16), { senderPriv: A, recipientPub: Wpub });
    tamper(o.X, mk());
    await prefetch(o.X);
    assert.equal(T._stealthNothingFromArchive(o.X), false, `${name}: not cleared when it pays someone else`);
  }
});

await test('a scan over such bytes reads the transfer from an explorer and marks it seen only once it has', async () => {
  asWallet(V, Vpub);
  const ASSET = 'ef'.repeat(32);
  const mine = transfer('91', { senderPriv: A, recipientPub: Vpub }), other = transfer('92', { senderPriv: A, recipientPub: Wpub });
  tamper(mine.X, { strip: new Set([0, 1]) });
  INDEX[ASSET] = [mine.X, other.X];
  reads.length = 0;
  const r = await T.scanAssetForStealthReceipts(ASSET, { pageLimit: 50, maxPages: 1, gapMs: 0 });
  assert.equal(r.txsFromArchive, 1, 'only the untouched transfer was cleared from the archive');
  assert.deepEqual(r.discovered.map((d) => [d.txid === mine.X, d.amount]), [[true, 400n]], 'the credit in the changed bytes was found through an explorer');
  assert.ok(reads.includes(mine.X) && !reads.includes(other.X));
});

await test('witnesses that are present and agree do not send a transfer to an explorer: a native segwit key matches its previous output, a scriptSig input counts as a spend', async () => {
  asWallet(V, Vpub);
  const t = transfer('a9', { senderPriv: A, recipientPub: Wpub, plainParent: true });
  await prefetch(t.X);
  assert.equal(T._stealthNothingFromArchive(t.X), true, 'a transfer paying someone else, whose witnesses agree with its previous outputs, is cleared');
  // an input with no witness but a scriptSig is a legacy spend: it is not mistaken for a stripped one
  const base = explorer.get(t.X);
  const legacy = land({ vin: [...base.vin, { txid: 'ee'.repeat(32), vout: 0, scriptsig: '4830' + '11'.repeat(70) }], vout: base.vout, status: base.status });
  await prefetch(legacy);
  assert.equal(T._stealthNothingFromArchive(legacy), true, 'a transfer with a legacy input is cleared');
  assert.deepEqual(await viaExplorer(() => T.discoverStealthFromTxid(legacy)), [], 'and an explorer read agrees');
});

console.log(`\n${n - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
