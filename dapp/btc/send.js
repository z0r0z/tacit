// Sending the Tacit wallet's own bitcoin from its bc1q address to any address (the "Your Bitcoin" panel of /btc/): what an address is, which coins may be spent,
// what a send costs, and the transaction itself, signed by the key's P2WPKH signer (bitcoin-taproot-wallet.js prims.signP2wpkhInput). No network here: the page
// reads the coins and the fee rates, and broadcasts, through the pair opener's `bitcoin` (fast/pair-wire.js).
//
// Every amount is an integer number of sats (BigInt) from the coins to the signed transaction: a fee is a whole vsize times a whole rate, never a float.
//
//   parseAddress(text)                                  -> { ok, type, script, address } | { ok: false, why }
//   spendable(coins, { held, holdings })                -> the coins a send may take (no dust, no coin of a swap under way, no coin a note may ride on)
//   planSend({ coins, amount | max, rate, script })     -> { inputs, send, fee, change, vsize, rate, total, extra } | { error, need?, have? }
//   signSend({ prims, plan, script })                   -> { hex, txid, tx }
import { sha256, base58, bytesToHex, hexToBytes } from '../vendor/tacit-deps.min.js';

export const DUST = 546n;                                  // no output under this, and no coin under or at it is spent (a coin of dust size may carry a note)
export const RBF_SEQ = 0xfffffffd;                         // every input signals replacement (BIP 125): a send that sits too long can be sped up
export const MAX_INPUTS = 400;                             // one transaction stays well under the standard size

// ── addresses ──
// BIP 173 and BIP 350 (segwit, bech32 and bech32m) and base58check (P2PKH, P2SH): mainnet only, each checksum checked.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32 = 1, BECH32M = 0x2bc830a3;
const polymod = (values) => {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
};
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
function bech32Decode(s) {
  if (s.length > 90 || (s !== s.toLowerCase() && s !== s.toUpperCase())) return null;
  const a = s.toLowerCase(), pos = a.lastIndexOf('1');
  if (pos < 1 || pos + 7 > a.length) return null;
  const hrp = a.slice(0, pos);
  if ([...hrp].some((c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126)) return null;
  const data = [];
  for (const c of a.slice(pos + 1)) { const d = CHARSET.indexOf(c); if (d < 0) return null; data.push(d); }
  const c = polymod([...hrpExpand(hrp), ...data]);
  const spec = c === BECH32 ? 'bech32' : c === BECH32M ? 'bech32m' : null;
  return { hrp, data: data.slice(0, -6), spec };
}
function fromWords(words) {
  let acc = 0, bits = 0;
  const out = [];
  for (const v of words) {
    acc = (acc << 5) | v; bits += 5;
    while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
    acc &= (1 << bits) - 1;
  }
  if (bits >= 5 || acc) return null;                       // padding of more than four bits, or not zero, is not a valid program
  return Uint8Array.from(out);
}
const TEST_HRP = new Set(['tb', 'bcrt', 'sb']);
const TYPES = {
  p2wpkh: (p) => Uint8Array.of(0x00, 0x14, ...p),
  p2wsh: (p) => Uint8Array.of(0x00, 0x20, ...p),
  p2tr: (p) => Uint8Array.of(0x51, 0x20, ...p),
  p2pkh: (h) => Uint8Array.of(0x76, 0xa9, 0x14, ...h, 0x88, 0xac),
  p2sh: (h) => Uint8Array.of(0xa9, 0x14, ...h, 0x87),
};
const no = (why) => ({ ok: false, why });
const TYPO = 'That address has a mistake in it: its checksum does not match. Copy it again.';
const TESTNET = 'That is a test-network address. Bitcoin sent here is real: use a mainnet address (bc1…, 1… or 3…).';

export function parseAddress(text) {
  const s = String(text ?? '').trim();
  if (!s) return no('Enter a Bitcoin address.');
  if (/^bitcoin:/i.test(s)) return parseAddress(s.slice(8).split('?')[0]);
  if (/^0x[0-9a-f]{40}$/i.test(s)) return no('That is an Ethereum address. Enter a Bitcoin address.');
  if (/^ln(bc|tb)/i.test(s)) return no('That is a Lightning invoice. Enter a Bitcoin address.');
  if (/^(sp|tsp)1/i.test(s)) return no('Silent-payment addresses are not sent to from this page. Use a bc1… address.');
  if (/^(tb|bcrt|sb)1/i.test(s)) return no(TESTNET);
  if (/^bc1/i.test(s)) {
    const d = bech32Decode(s);
    if (!d || !d.spec || d.hrp !== 'bc' || !d.data.length) return no(TYPO);
    const version = d.data[0], prog = fromWords(d.data.slice(1));
    if (!prog || prog.length < 2 || prog.length > 40 || version > 16) return no(TYPO);
    if ((version === 0 && d.spec !== 'bech32') || (version !== 0 && d.spec !== 'bech32m')) return no(TYPO);
    if (version === 0 && prog.length === 20) return { ok: true, type: 'p2wpkh', script: TYPES.p2wpkh(prog), address: s.toLowerCase() };
    if (version === 0 && prog.length === 32) return { ok: true, type: 'p2wsh', script: TYPES.p2wsh(prog), address: s.toLowerCase() };
    if (version === 0) return no(TYPO);
    if (version === 1 && prog.length === 32) return { ok: true, type: 'p2tr', script: TYPES.p2tr(prog), address: s.toLowerCase() };
    // (a later segwit version can be spent by anyone until a soft fork gives it meaning: bitcoin sent to one could be lost)
    return no('This page does not send to that kind of address. Use a bc1q…, bc1p…, 1… or 3… address.');
  }
  if (/^[123mn][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s)) {
    let raw;
    try { raw = base58.decode(s); } catch { return no(TYPO); }
    if (raw.length !== 25) return no(TYPO);
    const body = raw.slice(0, 21), sum = sha256(sha256(body)).slice(0, 4);
    if (sum.some((b, i) => b !== raw[21 + i])) return no(TYPO);
    const v = body[0], h = body.slice(1);
    if (v === 0x00) return { ok: true, type: 'p2pkh', script: TYPES.p2pkh(h), address: s };
    if (v === 0x05) return { ok: true, type: 'p2sh', script: TYPES.p2sh(h), address: s };
    if (v === 0x6f || v === 0xc4) return no(TESTNET);
    return no(TYPO);
  }
  return no('That is not a Bitcoin address. A mainnet address starts with bc1, 1 or 3.');
}
export const scriptHex = (script) => bytesToHex(script);

// ── coins ──
// The coins a send may take: confirmed plain-sat coins (what the pair's chain lists, already over dust), none that a swap under way holds (`held`: "txid:vout"), and,
// when the wallet's holdings could be read, none that carries a note or could not be told (`holdings`: tacit.js scanHoldings, as its own sats send excludes them).
export function holdingOutpoints(holdings) {
  const out = new Set();
  if (!(holdings instanceof Map)) return out;
  for (const h of holdings.values()) {
    for (const k of ['utxos', 'ghosts', 'inflated', 'pending', 'unverified']) for (const x of (h && h[k]) || []) {
      const t = (x && x.utxo && x.utxo.txid) || (x && x.txid), v = x && x.utxo && x.utxo.vout != null ? x.utxo.vout : x && x.vout;
      if (t != null && v != null) out.add(`${t}:${v}`);
    }
  }
  for (const k of holdings.unclassified || []) out.add(k);
  return out;
}
export function spendable(coins, { held = new Set(), holdings = new Set() } = {}) {
  return (coins || [])
    .filter((c) => c && /^[0-9a-f]{64}$/.test(String(c.txid)) && Number.isSafeInteger(c.vout) && c.vout >= 0 && Number.isSafeInteger(c.value) && BigInt(c.value) > DUST)
    .filter((c) => !held.has(`${c.txid}:${c.vout}`) && !holdings.has(`${c.txid}:${c.vout}`))
    .sort((a, b) => b.value - a.value || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout));
}

// ── what a send weighs ──
// Each input is the wallet's own P2WPKH (41 bytes, and a witness of a signature of at most 72 bytes with its sighash byte and the 33-byte key); each output 8 + 1 + its script.
// The vsize is the transaction's weight over four, rounded up: the signed transaction is never heavier (a signature is 71 or 72 bytes), so its rate is never under the one asked.
const varint = (n) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);
export function vsizeOf(nInputs, outScriptLens) {
  const base = 4 + varint(nInputs) + nInputs * 41 + varint(outScriptLens.length) + outScriptLens.reduce((s, l) => s + 8 + varint(l) + l, 0) + 4;
  const wit = 2 + nInputs * (1 + 1 + 72 + 1 + 33);
  return Math.ceil((base * 4 + wit) / 4);
}
const OWN_LEN = 22;                                        // the change goes back to the wallet's own P2WPKH address
const feeAt = (n, lens, rate) => BigInt(vsizeOf(n, lens)) * BigInt(rate);
const sum = (cs) => cs.reduce((s, c) => s + BigInt(c.value), 0n);

// A send of `amount` sats (or all that can be sent, `max`) to a script of `scriptLen` bytes at `rate` sat/vB. The coins are taken largest first, the fewest that pay
// the amount and the fee; change of dust size or less is not made (it goes to the fee, said as `extra`). Max leaves out a coin that costs more to spend than it holds.
export function planSend({ coins, amount = null, max = false, rate, scriptLen }) {
  const r = Number(rate);
  if (!Number.isSafeInteger(r) || r < 1 || r > 5000) return { error: 'rate' };
  if (!Number.isSafeInteger(scriptLen) || scriptLen < 1) return { error: 'script' };
  const list = (coins || []).slice(0, MAX_INPUTS);
  if (!list.length) return { error: 'empty', have: 0n };
  if (max) {
    let n = list.length;
    while (n > 0 && BigInt(list[n - 1].value) <= feeAt(n, [scriptLen], r) - feeAt(n - 1, [scriptLen], r)) n--;
    const inputs = list.slice(0, n), total = sum(inputs), fee = n ? feeAt(n, [scriptLen], r) : 0n, send = total - fee;
    if (!n || send < DUST) return { error: 'short', need: DUST + (n ? fee : feeAt(1, [scriptLen], r)), have: sum(list) };
    return { inputs, send, fee, change: 0n, extra: 0n, vsize: vsizeOf(n, [scriptLen]), rate: r, total };
  }
  const want = BigInt(amount ?? 0);
  if (want < DUST) return { error: 'dust' };
  const inputs = [];
  let total = 0n;
  for (const c of list) {
    inputs.push(c); total += BigInt(c.value);
    const n = inputs.length, withChange = feeAt(n, [scriptLen, OWN_LEN], r), bare = feeAt(n, [scriptLen], r);
    if (total >= want + withChange + DUST + 1n) return { inputs: inputs.slice(), send: want, fee: withChange, change: total - want - withChange, extra: 0n, vsize: vsizeOf(n, [scriptLen, OWN_LEN]), rate: r, total };
    if (total >= want + bare) return { inputs: inputs.slice(), send: want, fee: total - want, change: 0n, extra: total - want - bare, vsize: vsizeOf(n, [scriptLen]), rate: r, total };
  }
  return { error: 'short', need: want + feeAt(list.length, [scriptLen], r), have: total };
}

// ── the transaction ──
// Version 2, no lock time, every input RBF; the recipient first, then any change to the wallet's own address. Checked before it is handed back: what goes in is what
// comes out plus the fee the plan named, no output is dust, and the signed transaction weighs no more than the plan's vsize.
export function signSend({ prims, plan, script }) {
  if (!plan || plan.error) throw new Error('There is no send to sign.');
  const own = prims.p2wpkhScript(prims.wallet.pub);
  const outs = [{ value: plan.send, script }, ...(plan.change > 0n ? [{ value: plan.change, script: own }] : [])];
  if (outs.some((o) => o.value < DUST)) throw new Error('An output would be under the dust limit. Nothing was signed.');
  if (sum(plan.inputs) !== outs.reduce((s, o) => s + o.value, 0n) + plan.fee) throw new Error('The amounts do not add up. Nothing was signed.');
  const tx = {
    version: 2, locktime: 0,
    inputs: plan.inputs.map((c) => ({ txid: c.txid, vout: c.vout, sequence: RBF_SEQ, witness: [] })),
    outputs: outs.map((o) => ({ value: Number(o.value), script: o.script })),
  };
  tx.inputs.forEach((i, k) => { i.witness = prims.signP2wpkhInput(tx, k, Number(plan.inputs[k].value)); });
  const raw = prims.serializeTx(tx, true), bare = prims.serializeTx(tx, false);
  const vsize = Math.ceil((bare.length * 3 + raw.length) / 4);
  if (vsize > plan.vsize) throw new Error('The signed transaction is larger than planned. Nothing was sent.');
  return { hex: bytesToHex(raw), txid: prims.txid(tx), tx, vsize };
}

// The script of output `vout` of a transaction in hex (segwit or not), or null: how a page knows its own swap locks' addresses from the records that keep their bytes.
export function outputScript(hex, vout = 0) {
  try {
    const b = hexToBytes(String(hex).replace(/^0x/, ''));
    let i = 4;
    const vi = () => { const f = b[i++]; if (f < 0xfd) return f; const n = f === 0xfd ? 2 : f === 0xfe ? 4 : 8; let v = 0; for (let k = 0; k < n; k++) v += b[i++] * 2 ** (8 * k); return v; };
    if (b[i] === 0 && b[i + 1] === 1) i += 2;
    const nin = vi();
    for (let k = 0; k < nin; k++) { i += 36; const l = vi(); i += l + 4; }
    const nout = vi();
    for (let k = 0; k < nout; k++) { i += 8; const l = vi(); if (k === Number(vout)) return i + l <= b.length ? bytesToHex(b.slice(i, i + l)) : null; i += l; }
    return null;
  } catch { return null; }
}
