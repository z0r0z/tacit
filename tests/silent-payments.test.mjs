// BIP-352 silent payments: every official send-and-receive vector through dapp/tacit.js.
//
// Vectors: tests/vectors/bip352-send-and-receive.json, a verbatim copy of
//   https://raw.githubusercontent.com/bitcoin/bips/master/bip-0352/send_and_receive_test_vectors.json
//   (BIP-352 v1.1.1, sha256 f5f9ed4afd76a1b76f3c70b1cbe67532f89abbe559f8e02d7fc3d8ecb93af4a1).
//
// Sending: input keys come from the dapp's bip352InputPubkey (eligibility), outputs from
// senderComputeSilentPaymentOutputs; a P2TR private key is normalized to even y the way the wallet's send path
// does (bip352SenderInputPrivs). Receiving: bip352InputPubkey + receiverScanTxForSilentPayments with the vector's
// labels, then each found output is spent with silentPaymentSpendingKey and a BIP-340 signature is checked.
// Also covers the address codec, network separation, the Esplora input adapter and a signed spend of a credit.
//
// Run: node tests/silent-payments.test.mjs
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const g = globalThis;
const set = (k, v) => { try { g[k] = v; } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); } };
set('window', dom.window);
set('document', dom.window.document);
set('localStorage', dom.window.localStorage);
set('location', dom.window.location);
if (!g.navigator) set('navigator', dom.window.navigator);
g.prompt = () => null; g.alert = () => {}; g.confirm = () => false;
g.__TACIT_NO_INIT__ = true;
dom.window.localStorage.setItem('tacit-network-v1', 'mainnet');

const T = await import('../dapp/tacit.js');
const VECTORS = JSON.parse(readFileSync(new URL('./vectors/bip352-send-and-receive.json', import.meta.url), 'utf8'));

const N = secp.CURVE.n;
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => { const b = new Uint8Array(h.length >> 1); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16); return b; };
const big = (b) => BigInt('0x' + (hex(b) || '0'));
const b32 = (n) => unhex(n.toString(16).padStart(64, '0'));

function parseWitness(h) {
  if (!h) return [];
  const buf = unhex(h);
  let i = 0;
  const varint = () => {
    const b = buf[i++];
    if (b < 0xfd) return b;
    if (b === 0xfd) { const v = buf[i] | (buf[i + 1] << 8); i += 2; return v; }
    if (b === 0xfe) { const v = (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16)) + buf[i + 3] * 2 ** 24; i += 4; return v; }
    throw new Error('varint too large');
  };
  const n = varint();
  const items = [];
  for (let k = 0; k < n; k++) { const len = varint(); items.push(buf.slice(i, i + len)); i += len; }
  return items;
}

const inputFromVin = (vin) => ({
  prevoutScript: unhex(vin.prevout.scriptPubKey.hex),
  scriptSig: unhex(vin.scriptSig || ''),
  witness: parseWitness(vin.txinwitness),
});
const isP2tr = (spk) => spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20;
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
}

// ---------------------------------------------------------------- sending
console.log('Sending vectors:');
VECTORS.forEach((v, vi) => v.sending.forEach((s, si) => {
  const label = `send ${vi}.${si} ${v.comment}`;
  try {
    const privs = [], pubs = [], eligibleOps = [];
    for (const vin of s.given.vin) {
      const inp = inputFromVin(vin);
      const pub = T.bip352InputPubkey(inp);
      if (!pub) continue;
      pubs.push(hex(pub));
      const u = isP2tr(inp.prevoutScript) ? { _sp: true, _spPriv: unhex(vin.private_key) } : { _sp: false };
      privs.push(T.bip352SenderInputPrivs([u], unhex(vin.private_key))[0]);
      eligibleOps.push(T.bip352OutpointBytes(vin.txid, vin.vout));
    }
    if (s.expected.input_pub_keys && JSON.stringify(pubs) !== JSON.stringify(s.expected.input_pub_keys)) {
      return check(label, false, `input keys ${JSON.stringify(pubs)} != ${JSON.stringify(s.expected.input_pub_keys)}`);
    }
    const recipients = [];
    for (const r of s.given.recipients) {
      const d = T.decodeSilentPaymentAddress(r.address);
      if (!d || hex(d.scanPub) !== r.scan_pub_key || hex(d.spendPub) !== r.spend_pub_key) return check(label, false, `address decode ${r.address}`);
      for (let c = 0; c < (r.count || 1); c++) recipients.push({ scanPub: d.scanPub, spendPub: d.spendPub });
    }
    let got = [];
    if (privs.length) {
      try {
        got = T.senderComputeSilentPaymentOutputs({
          inputPrivs: privs, inputOutpoints: eligibleOps,
          allInputOutpoints: s.given.vin.map((x) => T.bip352OutpointBytes(x.txid, x.vout)),
          recipients,
        }).map((o) => hex(o.xOnly));
      } catch (e) { got = []; if (!/zero|K_max|more than/.test(e.message)) throw e; }
    }
    const ok = s.expected.outputs.some((set) => sameSet(got, set));
    check(label, ok, ok ? '' : `got ${got.length} outputs`);
  } catch (e) { check(label, false, e.message); }
}));

// ---------------------------------------------------------------- receiving
console.log('\nReceiving vectors:');
const MSG = sha256(new TextEncoder().encode('message'));
VECTORS.forEach((v, vi) => v.receiving.forEach((r, ri) => {
  const label = `recv ${vi}.${ri} ${v.comment}`;
  try {
    const scanPriv = unhex(r.given.key_material.scan_priv_key);
    const spendPriv = unhex(r.given.key_material.spend_priv_key);
    const scanPub = secp.getPublicKey(scanPriv, true);
    const spendPub = secp.getPublicKey(spendPriv, true);
    const addrs = [T.encodeSilentPaymentAddress({ scanPub, spendPub, network: 'mainnet' })];
    for (const m of r.given.labels) {
      const Bm = secp.ProjectivePoint.fromHex(hex(spendPub)).add(secp.ProjectivePoint.BASE.multiply(T.bip352LabelTweak(scanPriv, m)));
      addrs.push(T.encodeSilentPaymentAddress({ scanPub, spendPub: Bm.toRawBytes(true), network: 'mainnet' }));
    }
    if (JSON.stringify(addrs) !== JSON.stringify(r.expected.addresses)) return check(label, false, 'address mismatch');

    const classifiedInputs = r.given.vin.map((vin) => ({ kind: 'bip352', pub: T.bip352InputPubkey(inputFromVin(vin)) }));
    const allOutpoints = r.given.vin.map((x) => T.bip352OutpointBytes(x.txid, x.vout));
    const outputs = r.given.outputs.map((x) => ({ script: unhex('5120' + x) }));
    const matches = T.receiverScanTxForSilentPayments({ classifiedInputs, allOutpoints, outputs, scanPriv, spendPub, labels: r.given.labels });

    for (const m of matches) {
      const sk = T.silentPaymentSpendingKey(spendPriv, m.tweakScalar);
      if (hex(secp.getPublicKey(sk, true).slice(1)) !== hex(m.outputXonly)) return check(label, false, 'spending key does not open output');
      const sig = T.signSchnorr(MSG, sk);
      if (!T.verifySchnorr(sig, MSG, m.outputXonly)) return check(label, false, 'signature does not verify');
    }
    let ok;
    if (r.expected.outputs) {
      const got = matches.map((m) => `${hex(m.outputXonly)}:${hex(m.tweak)}`);
      const want = r.expected.outputs.map((o) => `${o.pub_key}:${o.priv_key_tweak}`);
      ok = sameSet(got, want);
      for (const o of r.expected.outputs) ok = ok && T.verifySchnorr(unhex(o.signature), MSG, unhex(o.pub_key));
    } else {
      ok = matches.length === r.expected.n_outputs;
    }
    check(label, ok, ok ? '' : `found ${matches.length}`);
  } catch (e) { check(label, false, e.message); }
}));

// ---------------------------------------------------------------- addresses
console.log('\nAddress codec:');
{
  const spendPriv = unhex('9d6ad855ce3417ef84e836892e5a56392bfba05fa5d97ccea30e266f540e08b3');
  const k = T.deriveSilentPaymentKeys(spendPriv);
  const main = T.encodeSilentPaymentAddress({ scanPub: k.scanPub, spendPub: k.spendPub, network: 'mainnet' });
  const sig = T.encodeSilentPaymentAddress({ scanPub: k.scanPub, spendPub: k.spendPub, network: 'signet' });
  check('mainnet address is sp1q…, 116 chars', main.startsWith('sp1q') && main.length === 116);
  check('signet address is tsp1q…, 117 chars', sig.startsWith('tsp1q') && sig.length === 117);
  check('mainnet decodes as mainnet', T.decodeSilentPaymentAddress(main)?.network === 'mainnet');
  check('signet decodes as signet', T.decodeSilentPaymentAddress(sig)?.network === 'signet');
  check('upper case accepted', T.decodeSilentPaymentAddress(main.toUpperCase())?.network === 'mainnet');
  check('mixed case rejected', T.decodeSilentPaymentAddress(main.slice(0, 10) + main.slice(10).toUpperCase()) === null);
  check('flipped checksum char rejected', T.decodeSilentPaymentAddress(main.slice(0, -1) + (main.endsWith('q') ? 'p' : 'q')) === null);
  check('unknown hrp rejected', T.decodeSilentPaymentAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4') === null);

  // Re-encode a raw 5-bit payload under a chosen version.
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const polymod = (values) => {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const x of values) { const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]; }
    return chk;
  };
  const enc = (hrp, version, bytes) => {
    const d5 = []; let acc = 0, bits = 0;
    for (const x of bytes) { acc = (acc << 8) | x; bits += 8; while (bits >= 5) { bits -= 5; d5.push((acc >>> bits) & 31); } }
    if (bits) d5.push((acc << (5 - bits)) & 31);
    const data = [version, ...d5];
    const exp = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
    const pm = polymod([...exp, ...data, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
    const cs = [0, 1, 2, 3, 4, 5].map((i) => (pm >>> (5 * (5 - i))) & 31);
    return hrp + '1' + [...data, ...cs].map((x) => alphabet[x]).join('');
  };
  const payload = new Uint8Array([...k.scanPub, ...k.spendPub]);
  const longer = new Uint8Array([...payload, 1, 2, 3, 4]);
  check('v0 re-encode matches', enc('sp', 0, payload) === main);
  check('v0 with extra bytes rejected', T.decodeSilentPaymentAddress(enc('sp', 0, longer)) === null);
  const v1 = T.decodeSilentPaymentAddress(enc('sp', 1, longer));
  check('v1 with extra bytes read as first 66 bytes', !!v1 && hex(v1.scanPub) === hex(k.scanPub) && hex(v1.spendPub) === hex(k.spendPub));
  check('v31 rejected', T.decodeSilentPaymentAddress(enc('sp', 31, payload)) === null);
  check('short payload rejected', T.decodeSilentPaymentAddress(enc('sp', 0, payload.slice(0, 65))) === null);
  const badPoint = new Uint8Array(payload); badPoint[0] = 0x04;
  check('invalid scan point rejected', T.decodeSilentPaymentAddress(enc('sp', 0, badPoint)) === null);
  check('over 1023 chars rejected', T.decodeSilentPaymentAddress(enc('sp', 1, new Uint8Array(700).fill(2))) === null);
  let threw = false;
  try { T.encodeSilentPaymentAddress({ scanPub: k.scanPub, spendPub: k.spendPub, network: 'testnet4' }); } catch { threw = true; }
  check('encoder refuses an unknown network', threw);
  const { encodeSilentPayment } = await import('../dapp/tacit-address.js');
  check('tacit-address encoder matches the wallet encoder', encodeSilentPayment({ network: 'signet', scanPub: k.scanPub, spendPub: k.spendPub }) === sig);
  threw = false;
  try { encodeSilentPayment({ network: 'nosuchnet', scanPub: k.scanPub, spendPub: k.spendPub }); } catch { threw = true; }
  check('tacit-address encoder refuses an unknown network', threw);
}

// ---------------------------------------------------------------- Esplora adapter
console.log('\nEsplora input adapter:');
{
  const v = VECTORS[8].receiving[0].given; // taproot + non-taproot inputs
  const esploraTx = {
    vin: v.vin.map((x) => ({
      txid: x.txid, vout: x.vout, scriptsig: x.scriptSig,
      witness: parseWitness(x.txinwitness).map(hex),
      prevout: { scriptpubkey: x.prevout.scriptPubKey.hex },
    })),
  };
  const a = T.bip352ReceiverInputsFromEsploraTx(esploraTx);
  const want = v.vin.map((x) => { const p = T.bip352InputPubkey(inputFromVin(x)); return p ? hex(p) : null; });
  check('adapter keys match the vector parser', !!a && JSON.stringify(a.classifiedInputs.map((c) => (c.pub ? hex(c.pub) : null))) === JSON.stringify(want));
  const withV2 = { vin: [...esploraTx.vin, { txid: 'aa'.repeat(32), vout: 0, witness: [], prevout: { scriptpubkey: '5220' + '11'.repeat(32) } }] };
  check('tx spending witness v2 is not scanned', T.bip352ReceiverInputsFromEsploraTx(withV2) === null);
  const anchor = { vin: [...esploraTx.vin, { txid: 'aa'.repeat(32), vout: 0, witness: [], prevout: { scriptpubkey: '51024e73' } }] };
  check('tx spending a v1 anchor is still scanned', T.bip352ReceiverInputsFromEsploraTx(anchor) !== null);
  check('coinbase is not scanned', T.bip352ReceiverInputsFromEsploraTx({ vin: [{ is_coinbase: true, txid: '00'.repeat(32), vout: 0xffffffff }] }) === null);
}

// ---------------------------------------------------------------- wallet round trip
console.log('\nWallet round trip (P2WPKH + odd-y credit inputs → receiver → signed spend):');
{
  const recvSpend = unhex('0f694e068028a717f8af6b9411f9a133dd356525f44fd2d1e2b0d4b4b4b2a1c1');
  const recv = T.deriveSilentPaymentKeys(recvSpend);
  const walletPriv = unhex('eadc78165ff1f8ea94ad7cfdc54990738a4c53f6e0507b42154201b8e5dff3b1');
  const walletPub = secp.getPublicKey(walletPriv, true);
  // A spent silent-payment credit whose key has an odd-y point.
  let creditPriv; for (let i = 1n; ; i++) { creditPriv = b32((big(sha256(new TextEncoder().encode('credit'))) + i) % N); if (secp.getPublicKey(creditPriv, true)[0] === 0x03) break; }
  const creditX = secp.getPublicKey(creditPriv, true).slice(1);
  const picked = [
    { txid: 'bb'.repeat(32), vout: 1, _sp: false },
    { txid: '11'.repeat(32), vout: 0, _sp: true, _spPriv: creditPriv },
  ];
  const [out] = T.senderComputeSilentPaymentOutputs({
    inputPrivs: T.bip352SenderInputPrivs(picked, walletPriv),
    inputOutpoints: picked.map((u) => T.bip352OutpointBytes(u.txid, u.vout)),
    recipients: [{ scanPub: recv.scanPub, spendPub: recv.spendPub }],
  });
  const single = T.senderComputeSilentPaymentOutput({
    inputPrivs: T.bip352SenderInputPrivs(picked, walletPriv),
    inputOutpoints: picked.map((u) => T.bip352OutpointBytes(u.txid, u.vout)),
    scanPub: recv.scanPub, spendPub: recv.spendPub, k: 0,
  });
  check('single-output and grouped sender agree', hex(single.xOnly) === hex(out.xOnly));
  // The chain view of that tx: P2WPKH witness and a P2TR key-path witness.
  const tx = {
    vin: [
      { txid: picked[0].txid, vout: 1, witness: ['30'.repeat(71), hex(walletPub)], prevout: { scriptpubkey: hex(T.p2wpkhScript(walletPub)) } },
      { txid: picked[1].txid, vout: 0, witness: ['22'.repeat(64)], prevout: { scriptpubkey: '5120' + hex(creditX) } },
    ],
  };
  const inp = T.bip352ReceiverInputsFromEsploraTx(tx);
  const outputs = [{ script: unhex('0014' + '00'.repeat(20)) }, { script: T.p2trScript(out.xOnly) }];
  const matches = T.receiverScanTxForSilentPayments({ ...inp, outputs, scanPriv: recv.scanPriv, spendPub: recv.spendPub });
  check('receiver finds the payment at vout 1', matches.length === 1 && matches[0].voutIndex === 1);
  // Spend the found credit the way buildAndBroadcastSatsSend does.
  const sk = T.silentPaymentSpendingKey(recvSpend, big(unhex(hex(matches[0].tweak))) % N);
  const script = T.p2trScript(secp.getPublicKey(sk, true).slice(1));
  check('credit script equals the paid output', hex(script) === hex(outputs[1].script));
  const spendTx = { version: 2, locktime: 0, inputs: [{ txid: 'cc'.repeat(32), vout: 1, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: 1000, script: unhex('0014' + '00'.repeat(20)) }] };
  const prevouts = [{ value: 5000, script }];
  const [sigBytes] = T.signTaprootKeypathInput(spendTx, 0, prevouts, sk);
  const sh = T.tapSighashKeyPath(spendTx, 0, prevouts, 0x00);
  check('key-path signature over the credit verifies', T.verifySchnorr(sigBytes, sh, out.xOnly));
  // The change label is always scanned: an output to B_spend + label(0) is found and spendable.
  const L0 = secp.ProjectivePoint.BASE.multiply(T.bip352LabelTweak(recv.scanPriv, 0));
  const change = secp.ProjectivePoint.fromHex(hex(recv.spendPub)).add(L0).toRawBytes(true);
  const [chg] = T.senderComputeSilentPaymentOutputs({
    inputPrivs: T.bip352SenderInputPrivs(picked, walletPriv),
    inputOutpoints: picked.map((u) => T.bip352OutpointBytes(u.txid, u.vout)),
    recipients: [{ scanPub: recv.scanPub, spendPub: change }],
  });
  const cm = T.receiverScanTxForSilentPayments({ ...inp, outputs: [{ script: T.p2trScript(chg.xOnly) }], scanPriv: recv.scanPriv, spendPub: recv.spendPub });
  const csk = cm.length === 1 ? T.silentPaymentSpendingKey(recvSpend, cm[0].tweakScalar) : null;
  check('change-label output found and its key opens it', !!csk && hex(secp.getPublicKey(csk, true).slice(1)) === hex(chg.xOnly) && cm[0].label === 0);
}

// ---------------------------------------------------------------- wallet key versions
console.log('\nWallet key versions (v1 separate spend key, v0 legacy still received):');
{
  const walletPriv = sha256(new TextEncoder().encode('sp key versions wallet'));
  const tagged = (tag, m) => { const t = sha256(new TextEncoder().encode(tag)); return sha256(new Uint8Array([...t, ...t, ...m])); };
  const walletPub = secp.getPublicKey(walletPriv, true);
  T.wallet.priv = walletPriv; T.wallet.pub = walletPub;
  const v1 = T.deriveWalletSilentPaymentKeys(walletPriv, 1);
  const v0 = T.deriveWalletSilentPaymentKeys(walletPriv, 0);
  const addrNew = T.walletSilentPaymentAddress();
  const addrOld = T.walletSilentPaymentAddress(0);
  check('shown address is version 1', T.SP_KEY_VERSION === 1 && addrNew === T.encodeSilentPaymentAddress({ scanPub: v1.scanPub, spendPub: v1.spendPub, network: 'mainnet' }));
  check('new address differs from the legacy one', addrNew !== addrOld);
  check('legacy spend key is the wallet key', hex(v0.spendPub) === hex(walletPub) && hex(v0.spendPriv) === hex(walletPriv));
  const d = T.decodeSilentPaymentAddress(addrNew);
  const walletProg = hex(T.p2wpkhScript(walletPub).slice(2));
  check('new address carries neither the wallet key nor anything hashing to its bc1q',
    hex(d.spendPub) !== hex(walletPub) && hex(d.scanPub) !== hex(walletPub)
    && hex(T.p2wpkhScript(d.spendPub).slice(2)) !== walletProg && hex(T.p2wpkhScript(d.scanPub).slice(2)) !== walletProg
    && !hex(d.scanPub).includes(hex(walletPub).slice(2)) && hex(v1.scanPub) !== hex(v0.scanPub));
  check('v1 keys are hardened: tagged hashes of the wallet key', hex(v1.spendPriv) === hex(b32(big(tagged('tacit/bip352/spend', walletPriv)) % N))
    && hex(v1.scanPriv) === hex(b32(big(tagged('tacit/bip352/scan', walletPriv)) % N)));
  // One payment to each address; both are found under their own version and spend with that version's key.
  const senderPriv = unhex('22'.repeat(32));
  const senderPub = secp.getPublicKey(senderPriv, true);
  for (const [keys, ver] of [[v1, 1], [v0, 0]]) {
    const inTxid = hex(sha256(new TextEncoder().encode(`in${ver}`)));
    const [out] = T.senderComputeSilentPaymentOutputs({
      inputPrivs: [senderPriv], inputOutpoints: [T.bip352OutpointBytes(inTxid, 3)],
      recipients: [{ scanPub: T.decodeSilentPaymentAddress(ver ? addrNew : addrOld).scanPub, spendPub: T.decodeSilentPaymentAddress(ver ? addrNew : addrOld).spendPub }],
    });
    const tx = { vin: [{ txid: inTxid, vout: 3, witness: ['30'.repeat(71), hex(senderPub)], prevout: { scriptpubkey: hex(T.p2wpkhScript(senderPub)) } }] };
    const inp = T.bip352ReceiverInputsFromEsploraTx(tx);
    const outputs = [{ script: T.p2trScript(out.xOnly) }];
    const hits = T.SP_KEY_VERSIONS.map((v) => {
      const k = T.deriveWalletSilentPaymentKeys(walletPriv, v);
      return [v, T.receiverScanTxForSilentPayments({ ...inp, outputs, scanPriv: k.scanPriv, spendPub: k.spendPub })];
    }).filter(([, m]) => m.length);
    const txid = hex(sha256(new TextEncoder().encode(`pay${ver}`)));
    const ok1 = hits.length === 1 && hits[0][0] === ver;
    if (ok1) T.recordSpCredit({ txidHex: txid, vout: 0, sats: 5000, tweakHex: hex(hits[0][1][0].tweak), keyVersion: ver });
    const sk = ok1 ? T.spCreditSpendingKey(T.getSpCredit(txid, 0)) : null;
    const opens = !!sk && hex(secp.getPublicKey(sk, true).slice(1)) === hex(out.xOnly);
    const spendTx = { version: 2, locktime: 0, inputs: [{ txid, vout: 0, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: 4000, script: T.p2wpkhScript(walletPub) }] };
    const prevouts = [{ value: 5000, script: outputs[0].script }];
    const verified = opens && T.verifySchnorr(T.signTaprootKeypathInput(spendTx, 0, prevouts, sk)[0], T.tapSighashKeyPath(spendTx, 0, prevouts, 0x00), out.xOnly);
    check(`payment to the ${ver ? 'new' : 'legacy'} address found only as v${ver}, spent with a verifying key-path signature`, ok1 && verified);
    check(`v${ver} output key is not the wallet key`, hex(out.xOnly) !== hex(walletPub.slice(1)) && (ver === 0 || hex(out.xOnly) !== hex(v1.spendPub.slice(1))));
  }
  // A credit recorded before versioning (no keyVersion) spends with the legacy key.
  const legacyCredit = { sats: '5000', tweakHex: '00'.repeat(31) + '05' };
  check('unversioned credit uses the legacy spend key', hex(T.spCreditSpendingKey(legacyCredit)) === hex(T.silentPaymentSpendingKey(walletPriv, 5n)));
  // A mixed coin keeps its class when a later scan records the same output again.
  const mixTxid = 'cd'.repeat(32);
  T.recordSpCredit({ txidHex: mixTxid, vout: 2, sats: 11000, tweakHex: '00'.repeat(31) + '07', keyVersion: 1, coinClass: 'mixed' });
  T.recordSpCredit({ txidHex: mixTxid, vout: 2, sats: 11000, tweakHex: '00'.repeat(31) + '07', keyVersion: 1 });
  check('a classed credit keeps its class across a rescan', T.getSpCredit(mixTxid, 2)?.coinClass === 'mixed');
  T.removeSpCredit(mixTxid, 2);
  T.wallet.priv = null; T.wallet.pub = null;
}

console.log(`\nFinal: ${pass} passed · ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
