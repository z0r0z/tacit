// The notes a key holds on Bitcoin because a cross-out minted them, found from the key and public data alone.
//
// A cross-out (dapp/crossout-ux.js) ends with a T_CROSSOUT_MINT reveal whose vout 0 pays P2TR(this key's x-only form):
// the note's output, and that key is its auth key. The Bitcoin holdings scan lists only the key's P2WPKH address, so these
// notes are found here instead:
//   1. the UTXOs at the key's own Taproot address;
//   2. each one's creating transaction, read for a 0x65 envelope (asset, claim id, commitment) and a vout 0 at that address;
//   3. the Ethereum CrossOutRecorded event for the claim, which names the spent note's nullifier, and so fixes the
//      destination blinding (HMAC of the key and that nullifier, the derivation crossOut() uses);
//   4. the amount, which the commitment hides: it is solved from C - r*G = amount*H over a bounded range (baby-step
//      giant-step), so nothing needs the journal. The solved opening is checked against the commitment and against the
//      event's destination before it is returned.
// Whether the worker has credited the mint (GET /crossout/minted) is reported, not required: a note is sent back on the
// reflection's own state.
import { extractTaprootEnvelope } from './burn-deposit-bitcoin.js';
import { decodeCrossoutMint } from './confidential-crossout-consumer.js';
import { pedersenCommit, G } from './bulletproofs-plus.js';

const stripHex = (h) => String(h).replace(/^0x/, '');
const withHex = (h) => '0x' + stripHex(h);
const lc = (h) => String(h).toLowerCase();
const hexToBytes = (h) => { const s = stripHex(h); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; };
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// ---- bech32m (BIP-350) for the P2TR address of an x-only key ----
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) { const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]; }
  return chk >>> 0;
}
const hrpExpand = (hrp) => [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
function convertBits(data, from, to) {
  let acc = 0, bits = 0; const out = [], max = (1 << to) - 1;
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & max); } }
  if (bits > 0) out.push((acc << (to - bits)) & max);
  return out;
}
// Segwit v1 address of a 32-byte x-only key under `hrp` ('bc', 'tb').
export function p2trAddress(xonly, hrp = 'bc') {
  const prog = typeof xonly === 'string' ? hexToBytes(xonly) : xonly;
  if (prog.length !== 32) throw new Error('crossout-notes: a Taproot output key is 32 bytes');
  const data = [1, ...convertBits(prog, 8, 5)];
  const values = hrpExpand(hrp).concat(data);
  const mod = polymod(values.concat([0, 0, 0, 0, 0, 0])) ^ 0x2bc830a3;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${data.concat(checksum).map((d) => CHARSET[d]).join('')}`;
}

// ---- amount from a commitment: C - r*G = amount*H, amount in [1, m*m] with m = 2^ceil(bits/2) ----
// Baby steps j*H for 1 <= j <= m, giant steps P - i*(m*H); a match at (i, j) gives amount = i*m + j. Null when none.
// The baby-step table depends only on `bits`, so it is built once and kept.
const BABY = new Map();
function babySteps(bits) {
  const m = 1 << Math.ceil(bits / 2);
  if (!BABY.has(bits)) {
    const H = pedersenCommit(1n, 0n), baby = new Map();
    let mH = H;
    for (let j = 1; j <= m; j++) { baby.set(bytesToHex(mH.toRawBytes(true)), j); if (j < m) mH = mH.add(H); }
    BABY.set(bits, { baby, step: mH.negate() });
  }
  return { m, ...BABY.get(bits) };
}
export function solveAmount(P, bits = 26) {
  const { m, baby, step } = babySteps(bits);
  const ZERO = step.constructor.ZERO;
  const key = (Q) => bytesToHex(Q.toRawBytes(true));
  let Q = P;
  for (let i = 0; i <= m; i++) {
    if (Q.equals(ZERO)) return i === 0 ? null : BigInt(i) * BigInt(m);
    const hit = baby.get(key(Q));
    if (hit != null) return BigInt(i) * BigInt(m) + BigInt(hit);
    Q = Q.add(step);
  }
  return null;
}

// deps: chainJson(path) / chainHex(path) read the Bitcoin explorer behind the worker ('/address/..', '/tx/..'); workerJson(path)
// reads the worker itself ('/crossout/minted?..'); rpc(method, params) is the Ethereum node the pool is read through.
export function makeCrossoutNotes({ secp, hmac, sha256, pool, evmLog, rpc, poolAddress, deployBlock = 0, chainJson, chainHex, workerJson, hrp = 'bc', maxAmountBits = 26 } = {}) {
  for (const [k, v] of Object.entries({ secp, hmac, sha256, pool, evmLog, rpc, chainJson, chainHex, workerJson })) if (v == null) throw new Error(`crossout-notes: deps.${k} required`);

  // The destination blinding crossOut() derives: HMAC(key, 'tacit-crossout-blinding-v1' || nullifier) mod n, never zero.
  function destBlinding(walletPriv, nullifier) {
    const domain = new TextEncoder().encode('tacit-crossout-blinding-v1');
    const nb = hexToBytes(nullifier);
    const msg = new Uint8Array(domain.length + nb.length); msg.set(domain); msg.set(nb, domain.length);
    const raw = hmac(sha256, walletPriv, msg);
    let b = 0n; for (const x of raw) b = (b << 8n) | BigInt(x);
    b %= secp.CURVE.n;
    return b === 0n ? 1n : b;
  }

  // The CrossOutRecorded event of a claim: its claim id is the first indexed topic. Paged so a node that caps a log range still answers.
  async function eventOf(claimId) {
    if (!poolAddress) return null;
    const head = Number(BigInt(await rpc('eth_blockNumber', [])));
    for (let to = head; to >= deployBlock; to -= 50000) {
      const from = Math.max(deployBlock, to - 49999);
      const logs = await rpc('eth_getLogs', [{ address: poolAddress, topics: [evmLog.TOPIC0.CrossOutRecorded, withHex(claimId)], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
      for (const l of logs || []) { const ev = evmLog.decodeLog(l); if (ev && ev.type === 'CrossOutRecorded' && lc(ev.claimId) === lc(claimId)) return ev; }
    }
    return null;
  }

  // The opening of the note a mint reveal made: from what the journal knows if it knows it, else from the chain and the key.
  // Returns { amount, blinding, nullifier } or null when the amount is out of range.
  async function openMint({ walletPriv, asset, claimId, cx, cy, ownerXonly, known = null }) {
    const leafOf = (cxx, cyy) => pool.btcNoteLeaf(withHex(asset), cxx, cyy, withHex(ownerXonly));
    let nullifier = known && known.nullifier, destCommitment = leafOf(cx, cy);
    if (!nullifier) {
      const ev = await eventOf(claimId);
      if (!ev) return null;
      if (lc(ev.destCommitment) !== lc(destCommitment) || lc(ev.assetId) !== lc(withHex(asset))) return null;   // not a settle that made this note
      nullifier = ev.nullifier;
    }
    const r = destBlinding(walletPriv, nullifier);
    let amount = known && known.amount != null ? BigInt(known.amount) : null;
    if (amount == null) {
      const C = G.constructor.fromAffine({ x: BigInt(withHex(cx)), y: BigInt(withHex(cy)) });          // the same point class as G and H
      const P = C.add(G.multiply(r).negate());
      amount = solveAmount(P, maxAmountBits);
      if (amount == null || amount <= 0n) return null;
    }
    const { cx: c2x, cy: c2y } = pool.commitXY(amount, r);
    if (lc(c2x) !== lc(withHex(cx)) || lc(c2y) !== lc(withHex(cy))) return null;                       // the opening must reproduce the commitment
    return { amount, blinding: r, nullifier };
  }

  // Every cross-out note this key holds at its own Taproot address, for the assets named. `known` maps a claim id to what the
  // journal remembers ({ amount, nullifier }), which spares the log lookup and the search.
  async function discover({ walletPriv, assetIds, known = {} }) {
    const pub = secp.getPublicKey(walletPriv, true), xonly = bytesToHex(pub.slice(1));
    const addr = p2trAddress(xonly, hrp), spk = '5120' + xonly;
    const wanted = new Set((assetIds || []).map((a) => lc(withHex(a))));
    const utxos = await chainJson(`/address/${addr}/utxo`);
    const out = [];
    out.unread = 0;                                                                  // outputs that could not be read: the list is not complete
    for (const u of Array.isArray(utxos) ? utxos : []) {
      if (Number(u.vout) !== 0 || Number(u.value) > 2000) continue;                  // a cross-out mint's note is vout 0, at dust
      let hex, tx;
      try { [hex, tx] = await Promise.all([chainHex(`/tx/${u.txid}/hex`), chainJson(`/tx/${u.txid}`)]); } catch { out.unread++; continue; }
      const env = hex && extractTaprootEnvelope(stripHex(hex));
      const cm = env && decodeCrossoutMint(stripHex(env));
      if (!cm || !wanted.has(lc(cm.assetId))) continue;
      if (!tx || !tx.vout || !tx.vout[0] || lc(tx.vout[0].scriptpubkey) !== spk) continue;
      const k = known[lc(cm.claimId)] || null;
      let opening = null, openErr = null;
      try { opening = await openMint({ walletPriv, asset: cm.assetId, claimId: cm.claimId, cx: cm.cx, cy: cm.cy, ownerXonly: xonly, known: k }); }
      catch (e) { openErr = String((e && e.message) || e); }
      let credited = null;
      try {
        const c = await workerJson(`/crossout/minted?asset=${stripHex(cm.assetId)}&claim=${stripHex(cm.claimId)}&txid=${stripHex(u.txid)}`);
        credited = c && c.decided === true ? (c.minted === true || !!c.mintedTxid) : null;
      } catch { /* unread: unknown */ }
      out.push({
        txid: stripHex(u.txid).toLowerCase(), vout: 0, sats: Number(u.value), assetId: lc(withHex(cm.assetId)), claimId: cm.claimId, cx: cm.cx, cy: cm.cy,
        confirmed: !!(u.status && u.status.confirmed), amount: opening ? opening.amount : null, blinding: opening ? opening.blinding : null,
        nullifier: opening ? opening.nullifier : null, credited, openErr,
      });
    }
    return out;
  }

  // The opening of one output this key's cross-out made (spent or not): the transaction is read for a mint reveal whose vout 0 is
  // this key's Taproot output, and opened as discover() does. Null when the output is not such a note, or is not this key's.
  async function openOutpoint({ walletPriv, txid, vout, known = null }) {
    if (Number(vout) !== 0) return null;
    const xonly = bytesToHex(secp.getPublicKey(walletPriv, true).slice(1));
    const [hex, tx] = await Promise.all([chainHex(`/tx/${stripHex(txid)}/hex`), chainJson(`/tx/${stripHex(txid)}`)]);
    const env = hex && extractTaprootEnvelope(stripHex(hex));
    const cm = env && decodeCrossoutMint(stripHex(env));
    if (!cm || !tx || !tx.vout || !tx.vout[0] || lc(tx.vout[0].scriptpubkey) !== '5120' + xonly) return null;
    const o = await openMint({ walletPriv, asset: cm.assetId, claimId: cm.claimId, cx: cm.cx, cy: cm.cy, ownerXonly: xonly, known });
    return o ? { assetId: lc(withHex(cm.assetId)), amount: o.amount, blinding: o.blinding, nullifier: o.nullifier, owner: withHex(xonly), claimId: cm.claimId } : null;
  }

  return { destBlinding, eventOf, openMint, openOutpoint, discover, p2trAddress: (x) => p2trAddress(x, hrp) };
}
