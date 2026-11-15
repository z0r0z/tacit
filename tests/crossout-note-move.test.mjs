// A note bridged to Bitcoin sits at the key's own Taproot address (a key-path output with an untweaked key). The transfer builder spends such an input
// with a BIP341 key-path signature, and signs and checks the reveal before it broadcasts the commit.
//
//   - the reveal's Taproot input carries one 64-byte Schnorr signature that verifies against a sighash computed here from the BIP341 text, under the
//     key's x-only public key, over prevouts that name the note's Taproot script
//   - the commit is broadcast first and the reveal second, and a Taproot input that cannot be signed (another key's script, a signer the note does
//     not take) fails with nothing broadcast
//   - a transfer from an ordinary P2WPKH note is unchanged: two witness items, a valid BIP143 signature
//
// Run: node tests/crossout-note-move.test.mjs

const store = new Map();
const el = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : el()), apply: () => el(), set: () => true });
globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), addEventListener() {}, body: el(), head: el(), documentElement: el(), readyState: 'complete' };
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear(), key: i => [...store.keys()][i] ?? null, get length() { return store.size; } };
globalThis.location = { href: 'http://localhost/', origin: 'http://localhost', hash: '', search: '', pathname: '/', protocol: 'http:', host: 'localhost', hostname: 'localhost' };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true, language: 'en' }, configurable: true }); } catch {}
globalThis.addEventListener = () => {};
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
store.set('tacit-network-v1', 'signet');

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';

const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; } };

const SK = hexToBytes('0c'.repeat(32));
dapp.wallet.priv = SK; dapp.wallet.pub = secp.getPublicKey(SK, true); dapp.wallet.mode = 'passkey';
const ADDR = dapp.wallet.address(), PUB_HEX = bytesToHex(dapp.wallet.pub), XONLY = dapp.wallet.pub.slice(1);
const ASSET = bytesToHex(sha256(new TextEncoder().encode('test-asset')));
const NOTE_TXID = 'aa'.repeat(32), NOTE_SATS = 546, AMOUNT = 700n, BLINDING = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn;

// The wallet's own holdings are not what is under test: the notes are handed to the builder.
dapp._testSetScanHoldingsOverride(() => new Map());

// ── the chain, as the builder sees it ──
let broadcasts = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), method = (opts.method || 'GET').toUpperCase();
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (method === 'POST' && typeof opts.body === 'string' && opts.body.includes('"jsonrpc"')) {
    const rpc = JSON.parse(opts.body);
    if (rpc.method === 'eth_getStorageAt') return json({ jsonrpc: '2.0', id: rpc.id, result: '0x' + '00'.repeat(32) });
    return json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'mock' } });
  }
  if (u.endsWith('/v1/fees/recommended')) return json({ fastestFee: 10, halfHourFee: 5, hourFee: 2, economyFee: 1, minimumFee: 1 });
  if (u.includes('/scripthash/')) return json([]);
  if (u.includes(`/address/${ADDR}/utxo`)) { dapp._testClearRecentSpends(); return json([{ txid: 'ee'.repeat(32), vout: 0, value: 5_000_000, status: { confirmed: true } }]); }  // this chain never remembers a spend
  if (method === 'POST' && u.endsWith('/tx')) { if (!broadcasts.includes(opts.body)) broadcasts.push(opts.body); return new Response('0'.repeat(64), { status: 200 }); }
  if (/\/tx\/[0-9a-f]{64}\/outspend\/\d+$/.test(u)) return json({ spent: false });
  if (method === 'GET' && /\/tx\/[0-9a-f]{64}$/.test(u)) return broadcasts.length ? json({ txid: u.slice(-64), status: { confirmed: false } }) : json({ error: 'Not found' }, 404);
  if (u.includes('/blocks/tip/height')) return new Response('0', { status: 200 });
  if (u.includes('/assets/hint')) return json({ ok: true });
  return json({ error: 'mock: no handler for ' + u }, 404);
};

// ── a transaction parser and a BIP341 key-path sighash, written here from the specifications ──
function parseTx(hex) {
  const b = hexToBytes(hex); let p = 0;
  const rd = (n) => { const r = b.slice(p, p + n); p += n; return r; };
  const varint = () => { const f = b[p++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b[p] | (b[p + 1] << 8); p += 2; return v; } throw new Error('varint too large for this test'); };
  const le = (n) => { let v = 0n; for (let i = 0; i < n; i++) v |= BigInt(b[p + i]) << BigInt(8 * i); p += n; return v; };
  const version = Number(le(4));
  let segwit = false;
  if (b[p] === 0x00 && b[p + 1] === 0x01) { segwit = true; p += 2; }
  const inputs = [], outputs = [];
  for (let n = varint(), i = 0; i < n; i++) { const txid = bytesToHex(rd(32).reverse()), vout = Number(le(4)), sl = varint(); rd(sl); inputs.push({ txid, vout, sequence: Number(le(4)), witness: [] }); }
  for (let n = varint(), i = 0; i < n; i++) { const value = le(8), sl = varint(); outputs.push({ value: Number(value), script: rd(sl) }); }
  if (segwit) for (const inp of inputs) for (let n = varint(), i = 0; i < n; i++) inp.witness.push(rd(varint()));
  const locktime = Number(le(4));
  return { version, locktime, inputs, outputs };
}
const N = secp.CURVE.n, FIELD = secp.CURVE.p;
const bytesToInt = (b) => BigInt('0x' + bytesToHex(b));
// BIP340 verification, from the specification: s*G - e*P must be a point with an even y whose x is r.
const schnorr = {
  verify(sig, msg, pk) {
    try {
      if (sig.length !== 64 || msg.length !== 32 || pk.length !== 32) return false;
      const P = secp.ProjectivePoint.fromHex('02' + bytesToHex(pk));
      const r = bytesToInt(sig.slice(0, 32)), s = bytesToInt(sig.slice(32));
      if (r >= FIELD || s >= N) return false;
      const e = bytesToInt(taggedHash('BIP0340/challenge', sig.slice(0, 32), pk, msg)) % N;
      const R = secp.ProjectivePoint.BASE.multiply(s).add(P.multiply(e).negate()).toAffine();
      return R.y % 2n === 0n && R.x === r;
    } catch { return false; }
  },
};
const taggedHash = (tag, ...parts) => { const t = sha256(new TextEncoder().encode(tag)); return sha256(concatBytes(t, t, ...parts)); };
const u32 = (v) => { const x = new Uint8Array(4); new DataView(x.buffer).setUint32(0, v >>> 0, true); return x; };
const u64 = (v) => { const x = new Uint8Array(8); new DataView(x.buffer).setBigUint64(0, BigInt(v), true); return x; };
const cs = (n) => (n < 0xfd ? Uint8Array.of(n) : Uint8Array.of(0xfd, n & 0xff, n >> 8));
// BIP341 SigMsg for SIGHASH_DEFAULT, key path, no annex: 0x00 (epoch) | hash_type | nVersion | nLockTime | sha_prevouts | sha_amounts | sha_scriptpubkeys | sha_sequences | sha_outputs | spend_type | input_index
function keyPathSighash(tx, idx, prevouts) {
  const shaPrevouts = sha256(concatBytes(...tx.inputs.flatMap((i) => [hexToBytes(i.txid).reverse(), u32(i.vout)])));
  const shaAmounts = sha256(concatBytes(...prevouts.map((o) => u64(o.value))));
  const shaSpks = sha256(concatBytes(...prevouts.flatMap((o) => [cs(o.script.length), o.script])));
  const shaSeqs = sha256(concatBytes(...tx.inputs.map((i) => u32(i.sequence))));
  const shaOuts = sha256(concatBytes(...tx.outputs.flatMap((o) => [u64(o.value), cs(o.script.length), o.script])));
  return taggedHash('TapSighash', Uint8Array.of(0x00), Uint8Array.of(0x00), u32(tx.version), u32(tx.locktime), shaPrevouts, shaAmounts, shaSpks, shaSeqs, shaOuts, Uint8Array.of(0x00), u32(idx));
}

const P2TR_SPK = concatBytes(Uint8Array.of(0x51, 0x20), XONLY);
let noteSeq = 0;
const noteInput = (extra = {}) => ({ utxo: { txid: String(++noteSeq).padStart(2, '0').repeat(32).slice(0, 64), vout: 0, value: NOTE_SATS }, amount: AMOUNT, blinding: BLINDING, scriptpubkey: bytesToHex(P2TR_SPK), taprootKeyPath: true, ...extra });

console.log('A note at the key\'s Taproot address:');
{
  broadcasts = [];
  await dapp.buildAndBroadcastCXferMulti({ assetIdHex: ASSET, recipients: [{ pubHex: PUB_HEX, amount: AMOUNT }], forceUtxos: [noteInput()], useBpp: true });
  ok('the commit and then the reveal are broadcast', broadcasts.length === 2, `${broadcasts.length} broadcasts`);
  const commit = parseTx(broadcasts[0]), reveal = parseTx(broadcasts[1]);
  ok('the reveal spends the commit and then the note', reveal.inputs.length === 2 && reveal.inputs[1].txid === '01'.repeat(32) && reveal.inputs[1].vout === 0);
  const w = reveal.inputs[1].witness;
  ok('the note input carries one 64-byte signature and nothing else', w.length === 1 && w[0].length === 64, `${w.length} items`);
  const prevouts = [{ value: commit.outputs[0].value, script: commit.outputs[0].script }, { value: NOTE_SATS, script: P2TR_SPK }];
  const sh = keyPathSighash(reveal, 1, prevouts);
  ok('it verifies under the key\'s x-only public key against a BIP341 key-path sighash computed from the specification', schnorr.verify(w[0], sh, XONLY));
  const wrong = keyPathSighash(reveal, 1, [prevouts[0], { value: NOTE_SATS, script: concatBytes(Uint8Array.of(0x00, 0x14), new Uint8Array(20)) }]);
  ok('and not against a sighash over a different prevout script', !schnorr.verify(w[0], wrong, XONLY));
  ok('the TAC goes to the key\'s own trading address (a P2WPKH output)', reveal.outputs[0].script.length === 22 && reveal.outputs[0].script[0] === 0x00 && reveal.outputs[0].script[1] === 0x14);
  const inp0 = reveal.inputs[0].witness;
  ok('the commit\'s output is spent through its script path (script, control block and signature)', inp0.length === 3 && inp0[0].length === 64);
}
{
  broadcasts = [];
  let err = null;
  try { await dapp.buildAndBroadcastCXferMulti({ assetIdHex: ASSET, recipients: [{ pubHex: PUB_HEX, amount: AMOUNT }], forceUtxos: [noteInput({ scriptpubkey: '5120' + 'ab'.repeat(32) })], useBpp: true }); } catch (e) { err = e; }
  ok('a note at another Taproot script is refused with nothing broadcast', /not at this key's own Taproot address/.test(String(err?.message)) && broadcasts.length === 0, `${broadcasts.length} broadcasts; ${err?.message}`);
}
{
  broadcasts = [];
  let err = null;
  try { await dapp.buildAndBroadcastCXferMulti({ assetIdHex: ASSET, recipients: [{ pubHex: PUB_HEX, amount: AMOUNT }], forceUtxos: [noteInput()], assetSigner: { priv: hexToBytes('0d'.repeat(32)), pub: secp.getPublicKey(hexToBytes('0d'.repeat(32)), true) }, useBpp: true }); } catch (e) { err = e; }
  ok('a signer other than the key itself is refused with nothing broadcast', /signed by the key itself/.test(String(err?.message)) && broadcasts.length === 0, `${broadcasts.length} broadcasts; ${err?.message}`);
}

console.log('\nThe move itself:');
{
  let err = null;
  try { await dapp.moveBridgedNote({ txid: 'cc'.repeat(32) }); } catch (e) { err = e; }
  ok('it is for mainnet only, and says so before reading anything', /for mainnet/.test(String(err?.message)), String(err?.message));
}

console.log('\nWhich assets move:');
{
  const TAC_ID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', TETH_ID = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
  const msg = async (fn) => { try { await fn(); return ''; } catch (e) { return String(e?.message); } };
  const move = (assetIdHex) => msg(() => dapp.moveBridgedNote({ txid: 'cc'.repeat(32), assetIdHex }));
  ok('an asset the bridge does not carry is refused before anything is read', /only a token bridged to Bitcoin/.test(await move(ASSET)));
  ok('and its notes are not listed', /only a token bridged to Bitcoin/.test(await msg(() => dapp.bridgedNotes(ASSET))));
  ok('tETH passes the asset check, and then meets the mainnet check', /for mainnet/.test(await move(TETH_ID)));
  ok('so does tETH written with its 0x prefix and in capitals', /for mainnet/.test(await move('0x' + TETH_ID.toUpperCase())));
  ok('a move that names no asset is TAC, as before', /for mainnet/.test(await move(undefined)) && /for mainnet/.test(await move(TAC_ID)));

  // The swap panel says where a bridged token is when it finds nothing to spend.
  ok('the hint is empty for an asset the bridge does not carry', (await dapp._bridgedSwapHint(ASSET, 'XYZ')) === '');
  // Each key reads its own Taproot address (the API read is kept for a while per address), so the two cases use two keys.
  const prior = globalThis.fetch, myPub = dapp.wallet.pub;
  for (const [label, pub, utxos, named] of [
    ['dust at the Taproot address', myPub, [{ txid: 'dd'.repeat(32), vout: 0, value: 546, status: { confirmed: true } }], true],
    ['nothing at it', secp.getPublicKey(hexToBytes('0f'.repeat(32)), true), [], false],
  ]) {
    dapp.wallet.pub = pub;
    globalThis.fetch = async (url, opts) => (/\/address\/(bc1p|tb1p)[0-9a-z]+\/utxo/.test(String(url)) ? new Response(JSON.stringify(utxos), { status: 200, headers: { 'content-type': 'application/json' } }) : prior(url, opts));
    await dapp.bridgedAtTaproot({ force: true });
    const hint = await dapp._bridgedSwapHint(TETH_ID, 'tETH');
    ok(`the hint for tETH with ${label} ${named ? 'names the Taproot address and the move on the Sell side' : 'is empty'}`, named ? /tETH you bridged to Bitcoin sits at your Taproot address.*"Move it here to sell"/.test(hint) : hint === '', hint);
  }
  globalThis.fetch = prior; dapp.wallet.pub = myPub;
}

console.log('\nA moved note is opened again from the key alone:');
{
  // The scan of a browser that never built the move has no kept opening. The reveal's note input is a Taproot key-path spend, whose witness is one
  // signature: no sender key to read, the sender being this key. Each output is asked for with the second input, as the scan does.
  broadcasts = [];
  await dapp.buildAndBroadcastCXferMulti({ assetIdHex: ASSET, recipients: [{ pubHex: PUB_HEX, amount: AMOUNT }], forceUtxos: [noteInput()], useBpp: true });
  const reveal = parseTx(broadcasts[1]);
  const env = dapp.decodeEnvelopeScript(reveal.inputs[0].witness[1]);
  const dec = dapp.decodeCXferBppPayload(env.payload);
  const note = reveal.inputs[1];
  const anchor = concatBytes(hexToBytes(note.txid).reverse(), u32(note.vout));
  const open = (o) => dapp.openTransferOutput({ priv: SK, pub: dapp.wallet.pub, senderPubHex: null, anchorBytes: anchor, vout: 0, ct: dec.outputs[0].encryptedAmount, commitment: dec.outputs[0].commitment, ...o });
  ok('the note input shows no public key', note.witness.length === 1);
  const got = open({});
  ok('the amount and blinding of the note moved to the trading address come back from the key and the chain', !!got && got.amount === AMOUNT && got.path === 'ecdh' && got.blinding === dapp.deriveBlinding(SK, dapp.wallet.pub, anchor, 0), `${got && got.amount} via ${got && got.path}`);
  ok('and the sender is named as this key, as the browser that built it keeps it', got && got.senderPubHex === PUB_HEX);
  ok('without the sender being tried as this key the self channel does not open it (what a fresh browser used to see)', open({ pub: null }) === null);
  const other = hexToBytes('0d'.repeat(32));
  ok('another key cannot open it', dapp.openTransferOutput({ priv: other, pub: secp.getPublicKey(other, true), senderPubHex: null, anchorBytes: anchor, vout: 0, ct: dec.outputs[0].encryptedAmount, commitment: dec.outputs[0].commitment }) === null);
  const viaWitness = open({ senderPubHex: PUB_HEX });
  ok('a sender key that the witness does show is read as before', !!viaWitness && viaWitness.amount === AMOUNT && viaWitness.path === 'ecdh' && viaWitness.senderPubHex === null);
  ok('a move of the whole note is one output: no change note of 0 TAC is left behind', dec.outputs.length === 1);
  // A move of part of the note leaves change, and the change comes back by the self channel.
  broadcasts = [];
  await dapp.buildAndBroadcastCXferMulti({ assetIdHex: ASSET, recipients: [{ pubHex: PUB_HEX, amount: AMOUNT - 100n }], forceUtxos: [noteInput()], useBpp: true });
  const reveal2 = parseTx(broadcasts[1]);
  const dec2 = dapp.decodeCXferBppPayload(dapp.decodeEnvelopeScript(reveal2.inputs[0].witness[1]).payload);
  const anchor2 = concatBytes(hexToBytes(reveal2.inputs[1].txid).reverse(), u32(reveal2.inputs[1].vout));
  const change = dapp.openTransferOutput({ priv: SK, pub: dapp.wallet.pub, senderPubHex: null, anchorBytes: anchor2, vout: 1, ct: dec2.outputs[1].encryptedAmount, commitment: dec2.outputs[1].commitment });
  ok('the change of a part moved still comes by the self channel', dec2.outputs.length === 2 && !!change && change.path === 'self' && change.amount === 100n, `${change && change.path} ${change && change.amount}`);
  ok('a commitment that is not the output\'s is never accepted', open({ commitment: dec2.outputs[1].commitment }) === null);
}

console.log('\nAn ordinary P2WPKH note:');
{
  broadcasts = [];
  const spk = concatBytes(Uint8Array.of(0x00, 0x14), dapp.hash160 ? dapp.hash160(dapp.wallet.pub) : (await import('@noble/hashes/ripemd160')).ripemd160(sha256(dapp.wallet.pub)));
  await dapp.buildAndBroadcastCXferMulti({ assetIdHex: ASSET, recipients: [{ pubHex: bytesToHex(secp.getPublicKey(hexToBytes('0e'.repeat(32)), true)), amount: 300n }], forceUtxos: [{ utxo: { txid: 'bb'.repeat(32), vout: 1, value: NOTE_SATS }, amount: AMOUNT, blinding: BLINDING }], useBpp: true });
  const reveal = parseTx(broadcasts[1]);
  const w = reveal.inputs[1].witness;
  ok('it is still two broadcasts, commit first', broadcasts.length === 2);
  ok('and the note input is signed as before: a DER signature and the public key', w.length === 2 && w[1].length === 33 && w[0][0] === 0x30 && bytesToHex(w[1]) === PUB_HEX);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
