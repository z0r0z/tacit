// A note received at a one-time (stealth) address is counted only once its output validates like any other
// UTXO: discoverStealthFromTxid and the holdings scan's credit rehydration both run validateOutpoint, the
// rehydration reads the commitment, value and script from the transaction itself, and a check that cannot
// finish keeps the credit for a later scan. The burn builder signs such a note with its tweaked key, and
// plain-sats selection holds back UTXOs the scan left unverified or could not read. Mocked chain; no network.
//
// Run (Node 22): node --no-experimental-global-navigator tests/stealth-credit-validation.test.mjs
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { randomBytes } from 'node:crypto';

const dom = new JSDOM('', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, location: dom.window.location, __TACIT_NO_INIT__: true });
if (!globalThis.navigator) globalThis.navigator = dom.window.navigator;
localStorage.setItem('tacit-network-v1', 'mainnet');

const routes = new Map();
const offline = new Set();   // txids whose fetch fails as a network error would
const posted = [];           // bodies of POSTed transactions
let walletUtxos = [];
const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if ((init?.method || 'GET').toUpperCase() === 'POST') {
    const body = typeof init.body === 'string' ? init.body : '';
    if (/^[0-9a-f]+$/i.test(body) && body.length > 120) { posted.push(body); return new Response('ff'.repeat(32), { status: 200 }); }
    throw new Error('offline: ' + url);
  }
  if (/\/address\/[^/]+\/utxo/.test(url)) return json(walletUtxos);
  if (/\/address\/[^/]+\/txs/.test(url)) return json([]);
  for (const t of offline) if (url.includes(`/tx/${t}`)) throw new Error('offline: ' + url);
  for (const [k, f] of routes) if (url.includes(k)) return json(f(url));
  throw new Error('offline: ' + url);
};

const T = await import('../dapp/tacit.js');
const BP = await import('./bulletproofs.mjs');
const { secp } = await import('../dapp/vendor/tacit-deps.min.js');

const hex = (b) => Buffer.from(b).toString('hex');
const u8 = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const rnd = () => BigInt('0x' + hex(randomBytes(32))) % T.SECP_N;
const b32 = (x) => u8(x.toString(16).padStart(64, '0'));
const old = Math.floor(Date.now() / 1000) - 7200;

const V = new Uint8Array(randomBytes(32)); const Vpub = secp.getPublicKey(V, true);
const A = new Uint8Array(randomBytes(32)); const Apub = secp.getPublicKey(A, true);
T.wallet.priv = V; T.wallet.pub = Vpub;

// A CETCH of `supply` held by A, and a stealth CXFER from it paying `amount` to this wallet at vout 0.
function chain(tag, { amount = 400n, supply = 1000n, badKernel = false } = {}) {
  const E = tag + '1'.repeat(62), X = tag + '2'.repeat(62);
  const rE = rnd();
  const pe = BP.bpRangeAggProve([supply], [rE]);
  const etchPayload = T.encodeCEtchPayload({ ticker: 'TST', decimals: 0, commitment: T.pointToBytes(pe.commitments[0]), rangeproof: pe.proof, encryptedAmount: new Uint8Array(8), mintAuthority: null, imageUri: null });
  const etchTx = { txid: E, vin: [{ txid: '03'.repeat(32), vout: 0, witness: ['00'.repeat(64), hex(T.encodeEnvelopeScript(T.wallet.xonly(), etchPayload)), 'c0' + '11'.repeat(32)] }],
    vout: [{ scriptpubkey: hex(T.p2wpkhScript(Apub)), value: 546 }], status: { confirmed: true, block_height: 1, block_time: old } };
  const aid = T.assetIdFor(E, 0);
  const anchor = new Uint8Array([...u8(E).reverse(), 0, 0, 0, 0]);
  const r0 = T.deriveBlinding(A, Vpub, anchor, 0), r1 = rnd();
  const ks = T.deriveAmountKeystreamECDH(A, Vpub, anchor, 0);
  const pp = BP.bpRangeAggProve([amount, supply - amount], [r0, r1]);
  const C0 = T.pointToBytes(pp.commitments[0]), C1 = T.pointToBytes(pp.commitments[1]);
  const kmsg = T.computeKernelMsg(aid, [{ txid: E, vout: 0 }], [C0, C1], 0n);
  const kernelSig = badKernel ? new Uint8Array(64).fill(1) : T.signSchnorr(kmsg, b32(T.modN(r0 + r1 - rE)));
  const payload = T.encodeCXferPayload({ assetId: aid, kernelSig, rangeproof: pp.proof,
    outputs: [{ commitment: C0, encryptedAmount: T.encryptAmount(amount, ks) }, { commitment: C1, encryptedAmount: new Uint8Array(8) }] });
  const head = T.stealthTxAnchorHead(E, 0);
  const b = T.deriveStealthEcdhBlinding({ ourPriv: A, theirPub: Vpub, networkTag: 'mainnet', domain: T.STEALTH_DOMAIN_BY_OPCODE.get(0x23), txAnchor: new Uint8Array([...head, 0, 0, 0, 0]) });
  const commit = T.computeStealthCommit({ underlyingPub: Vpub, blinding: b });
  const tx = { txid: X, version: 2, locktime: 0,
    vin: [
      { txid: tag + '3'.repeat(62), vout: 0, witness: ['00'.repeat(64), hex(T.encodeEnvelopeScript(T.wallet.xonly(), payload)), 'c0' + '11'.repeat(32)], prevout: { scriptpubkey_type: 'v1_p2tr', value: 3000 } },
      { txid: E, vout: 0, witness: ['30'.repeat(71), hex(Apub)], prevout: { scriptpubkey: hex(T.p2wpkhScript(Apub)), scriptpubkey_type: 'v0_p2wpkh', value: 546 } },
    ],
    vout: [
      { scriptpubkey: hex(T.p2wpkhScript(commit)), scriptpubkey_type: 'v0_p2wpkh', value: 777 },
      { scriptpubkey: hex(T.p2wpkhScript(Apub)), scriptpubkey_type: 'v0_p2wpkh', value: 546 },
    ],
    status: { confirmed: true, block_height: 900000, block_time: old } };
  routes.set(`/tx/${X}/outspend`, () => ({ spent: false }));
  routes.set(`/tx/${X}`, () => tx);
  routes.set(`/tx/${E}`, () => etchTx);
  return { E, X, aid: hex(aid), tx, amount, r0, b, commit };
}
const credit = (c, amount = c.amount) => T.recordStealthCredit({ txidHex: c.X, vout: 0, assetIdHex: c.aid, amount, amountBlinding: c.r0, stealthBlinding: c.b, commitmentHex: null, senderPubHex: hex(Apub), blockTime: old });
const scan = async () => { T.invalidateHoldingsCache(); return T.scanHoldings(true); };
const has = (list, c) => (list || []).some((x) => x.utxo.txid === c.X && x.utxo.vout === 0);

let n = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok ${++n} - ${name}`); }
  catch (e) { failed++; console.log(`not ok ${++n} - ${name}\n  ${e?.stack || e}`); }
}

const good = chain('a1');

await test('a stealth note that validates is counted, with the value and script of its output', async () => {
  const found = await T.discoverStealthFromTxid(good.X);
  assert.deepEqual(found.map((d) => [d.vout, d.amount]), [[0, 400n]]);
  const h = (await scan()).get(good.aid);
  assert.equal(h?.balance, 400n);
  assert.equal(h.utxos.length, 1);
  assert.equal(h.utxos[0].utxo.value, 777, 'value read from tx.vout');
  const pub = secp.getPublicKey(u8(h.utxos[0].stealthTweakedSk), true);
  assert.equal(hex(T.p2wpkhScript(pub)), good.tx.vout[0].scriptpubkey, 'spending key pays the output');
});

await test('a stored credit that does not open the on-chain commitment is not counted', async () => {
  credit(good, 401n);
  const h = (await scan()).get(good.aid);
  assert.equal(h.balance, 0n);
  assert.ok(has(h.ghosts, good) && !has(h.utxos, good));
  credit(good);
  assert.equal((await scan()).get(good.aid).balance, 400n);
});

await test('a transfer that fails Tacit validation is never counted', async () => {
  const bad = chain('b1', { amount: 5_000_000n, supply: 6_000_000n, badKernel: true });
  assert.equal(await T.validateOutpoint(bad.X, 0, new Map(), T.getTx), false);
  assert.deepEqual(await T.discoverStealthFromTxid(bad.X), []);
  assert.equal(T.getStealthCredit(bad.X, 0), null, 'not stored');
  credit(bad);   // a credit stored before this check existed
  const h = (await scan()).get(bad.aid);
  assert.equal(h?.balance, 0n);
  assert.ok(has(h.inflated, bad) && !has(h.utxos, bad));
});

await test('a note whose check cannot finish is kept, held back, and counted once it validates', async () => {
  const late = chain('c1');
  offline.add(late.E);
  await assert.rejects(T.discoverStealthFromTxid(late.X), (e) => e.again === true);
  assert.ok(T.getStealthCredit(late.X, 0), 'credit kept for the next scan');
  let h = (await scan()).get(late.aid);
  assert.equal(h.balance, 0n);
  assert.ok(has(h.unverified, late));
  const all = [{ txid: late.X, vout: 0, value: 777, status: { confirmed: true } }];
  assert.deepEqual(T.selectSatsUtxosSafe(all, await T.scanHoldings()), [], 'an unverified note is not plain sats');
  offline.delete(late.E);
  h = (await scan()).get(late.aid);
  assert.equal(h.balance, 400n);
  assert.ok(has(h.utxos, late));
});

await test('plain-sats selection holds back UTXOs the scan could not read', () => {
  const holdings = new Map();
  holdings.unclassified = new Set(['dd'.repeat(32) + ':1']);
  const all = [{ txid: 'dd'.repeat(32), vout: 1, value: 6000 }, { txid: 'ee'.repeat(32), vout: 0, value: 7000 }];
  assert.deepEqual(T.selectSatsUtxosSafe(all, holdings).map((u) => u.value), [7000]);
});

await test('the burn builder signs a stealth note with its tweaked key', async () => {
  const h = (await scan()).get(good.aid);
  const note = h.utxos.find((x) => x.utxo.txid === good.X);
  assert.ok(note?.stealthTweakedSk);
  walletUtxos = [{ txid: 'ab'.repeat(32), vout: 0, value: 200_000, status: { confirmed: true, block_height: 899000 } }];
  T.invalidateHoldingsCache();
  T._testInjectHoldingsCache({ fetchedAt: Date.now(), holdings: new Map([[good.aid, { ...h, utxos: [note], balance: note.amount }]]) });
  posted.length = 0;
  await T.buildAndBroadcastCBurn({ assetIdHex: good.aid, amount: 100n });
  const reveal = posted.find((p) => p.includes(hex(u8(good.X).reverse())));
  assert.ok(reveal, 'reveal broadcast');
  const tweakedPub = hex(secp.getPublicKey(u8(note.stealthTweakedSk), true));
  assert.ok(reveal.includes(tweakedPub), 'witness carries the tweaked key');
  assert.ok(!reveal.includes(hex(Vpub)), 'not the wallet key');
});

console.log(failed ? `${failed} failed` : 'done');
process.exit(failed ? 1 : 0);
