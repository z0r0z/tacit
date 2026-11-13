import { extractTaprootEnvelope } from './burn-deposit-bitcoin.js';
import { decodeCrossoutMint } from './confidential-crossout-consumer.js';
import { pedersenCommit, G } from './bulletproofs-plus.js';

const stripHex = (h) => String(h).replace(/^0x/, '');
const withHex = (h) => '0x' + stripHex(h);
const lc = (h) => String(h).toLowerCase();
const hexToBytes = (h) => { const s = stripHex(h); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; };
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

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
export function p2trAddress(xonly, hrp = 'bc') {
  const prog = typeof xonly === 'string' ? hexToBytes(xonly) : xonly;
  if (prog.length !== 32) throw new Error('crossout-notes: a Taproot output key is 32 bytes');
  const data = [1, ...convertBits(prog, 8, 5)];
  const values = hrpExpand(hrp).concat(data);
  const mod = polymod(values.concat([0, 0, 0, 0, 0, 0])) ^ 0x2bc830a3;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${data.concat(checksum).map((d) => CHARSET[d]).join('')}`;
}

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

export function amountFromSpent(P, value) {
  const v = BigInt(value);
  if (v <= 0n) return null;
  const H = pedersenCommit(1n, 0n), ZERO = H.constructor.ZERO;
  const D = H.multiply(v).add(P.negate());
  if (D.equals(ZERO)) return v;
  for (let scale = 1n; scale < v; scale *= 10n) {
    const Hs = scale === 1n ? H : H.multiply(scale);
    let d = scale === 1n ? 1n : 10n, T = d === 1n ? Hs : Hs.multiply(d);
    for (; d <= 99n; d++, T = T.add(Hs)) {
      if (d * scale >= v) return null;
      if (T.equals(D)) return v - d * scale;
    }
  }
  return null;
}

const MAX_LOOKUPS = 8;
export function makeCrossoutNotes({ secp, hmac, sha256, pool, evmLog, rpc, poolAddress, deployBlock = 0, chainJson, chainHex, workerJson, hrp = 'bc', maxAmountBits = 26, spentValues = null } = {}) {
  for (const [k, v] of Object.entries({ secp, hmac, sha256, pool, evmLog, rpc, chainJson, chainHex, workerJson })) if (v == null) throw new Error(`crossout-notes: deps.${k} required`);

  function destBlinding(walletPriv, nullifier) {
    const domain = new TextEncoder().encode('tacit-crossout-blinding-v1');
    const nb = hexToBytes(nullifier);
    const msg = new Uint8Array(domain.length + nb.length); msg.set(domain); msg.set(nb, domain.length);
    const raw = hmac(sha256, walletPriv, msg);
    let b = 0n; for (const x of raw) b = (b << 8n) | BigInt(x);
    b %= secp.CURVE.n;
    return b === 0n ? 1n : b;
  }

  const eventMemo = new Map();
  async function eventOf(claimId) {
    const k = lc(claimId), hit = eventMemo.get(k);
    if (hit && Date.now() - hit.at < 5 * 60e3) return hit.ev;
    const ev = await eventOfUncached(claimId);
    eventMemo.set(k, { at: Date.now(), ev });
    return ev;
  }
  async function eventOfUncached(claimId) {
    if (!poolAddress) return null;
    const head = Number(BigInt(await rpc('eth_blockNumber', [])));
    for (let to = head; to >= deployBlock; to -= 50000) {
      const from = Math.max(deployBlock, to - 49999);
      const logs = await rpc('eth_getLogs', [{ address: poolAddress, topics: [evmLog.TOPIC0.CrossOutRecorded, withHex(claimId)], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
      for (const l of logs || []) { const ev = evmLog.decodeLog(l); if (ev && ev.type === 'CrossOutRecorded' && lc(ev.claimId) === lc(claimId)) return ev; }
    }
    return null;
  }

  async function openMint({ walletPriv, asset, claimId, cx, cy, ownerXonly, known = null, spentValue = null }) {
    const leafOf = (cxx, cyy) => pool.btcNoteLeaf(withHex(asset), cxx, cyy, withHex(ownerXonly));
    let nullifier = known && known.nullifier, destCommitment = leafOf(cx, cy);
    if (!nullifier) {
      const ev = await eventOf(claimId);
      if (!ev) return null;
      if (lc(ev.destCommitment) !== lc(destCommitment) || lc(ev.assetId) !== lc(withHex(asset))) return null;
      nullifier = ev.nullifier;
    }
    const r = destBlinding(walletPriv, nullifier);
    let amount = known && known.amount != null ? BigInt(known.amount) : null;
    if (amount == null) {
      const C = G.constructor.fromAffine({ x: BigInt(withHex(cx)), y: BigInt(withHex(cy)) });
      const P = C.add(G.multiply(r).negate());
      const held = spentValue ? spentValue(nullifier) : null;
      amount = held != null ? amountFromSpent(P, held) : null;
      if (amount == null) amount = solveAmount(P, maxAmountBits);
      if (amount == null && spentValues) {
        const fresh = (await spentValues(walletPriv))(nullifier);
        amount = fresh != null ? amountFromSpent(P, fresh) : null;
      }
      if (amount == null || amount <= 0n) return null;
    }
    const { cx: c2x, cy: c2y } = pool.commitXY(amount, r);
    if (lc(c2x) !== lc(withHex(cx)) || lc(c2y) !== lc(withHex(cy))) return null;
    return { amount, blinding: r, nullifier };
  }

  async function discover({ walletPriv, assetIds, known = {}, spentValue = null }) {
    const pub = secp.getPublicKey(walletPriv, true), xonly = bytesToHex(pub.slice(1));
    const addr = p2trAddress(xonly, hrp), spk = '5120' + xonly;
    const wanted = new Set((assetIds || []).map((a) => lc(withHex(a))));
    const utxos = await chainJson(`/address/${addr}/utxo`);
    const out = [];
    out.unread = 0;
    let lookups = 0;
    for (const u of Array.isArray(utxos) ? utxos : []) {
      if (Number(u.vout) !== 0 || Number(u.value) > 2000) continue;
      let hex, tx;
      try { [hex, tx] = await Promise.all([chainHex(`/tx/${u.txid}/hex`), chainJson(`/tx/${u.txid}`)]); } catch { out.unread++; continue; }
      const env = hex && extractTaprootEnvelope(stripHex(hex));
      const cm = env && decodeCrossoutMint(stripHex(env));
      if (!cm || !wanted.has(lc(cm.assetId))) continue;
      if (!tx || !tx.vout || !tx.vout[0] || lc(tx.vout[0].scriptpubkey) !== spk) continue;
      const k = known[lc(cm.claimId)] || null;
      let opening = null, openErr = null;
      const fresh = !k && !eventMemo.has(lc(cm.claimId));
      if (fresh && lookups >= MAX_LOOKUPS) openErr = 'not opened: many outputs to look up';
      else try { if (fresh) lookups++; opening = await openMint({ walletPriv, asset: cm.assetId, claimId: cm.claimId, cx: cm.cx, cy: cm.cy, ownerXonly: xonly, known: k, spentValue }); }
      catch (e) { openErr = String((e && e.message) || e); }
      let credited = null;
      try {
        const c = await workerJson(`/crossout/minted?asset=${stripHex(cm.assetId)}&claim=${stripHex(cm.claimId)}&txid=${stripHex(u.txid)}`);
        credited = c && c.decided === true ? c.minted === true : null;
      } catch { }
      out.push({
        txid: stripHex(u.txid).toLowerCase(), vout: 0, sats: Number(u.value), assetId: lc(withHex(cm.assetId)), claimId: cm.claimId, cx: cm.cx, cy: cm.cy,
        confirmed: !!(u.status && u.status.confirmed), amount: opening ? opening.amount : null, blinding: opening ? opening.blinding : null,
        nullifier: opening ? opening.nullifier : null, credited, openErr,
      });
    }
    return out;
  }

  async function openOutpoint({ walletPriv, txid, vout, known = null, spentValue = null }) {
    if (Number(vout) !== 0) return null;
    const xonly = bytesToHex(secp.getPublicKey(walletPriv, true).slice(1));
    const [hex, tx] = await Promise.all([chainHex(`/tx/${stripHex(txid)}/hex`), chainJson(`/tx/${stripHex(txid)}`)]);
    const env = hex && extractTaprootEnvelope(stripHex(hex));
    const cm = env && decodeCrossoutMint(stripHex(env));
    if (!cm || !tx || !tx.vout || !tx.vout[0] || lc(tx.vout[0].scriptpubkey) !== '5120' + xonly) return null;
    const o = await openMint({ walletPriv, asset: cm.assetId, claimId: cm.claimId, cx: cm.cx, cy: cm.cy, ownerXonly: xonly, known, spentValue });
    return o ? { assetId: lc(withHex(cm.assetId)), amount: o.amount, blinding: o.blinding, nullifier: o.nullifier, owner: withHex(xonly), claimId: cm.claimId } : null;
  }

  return { destBlinding, eventOf, openMint, openOutpoint, discover, p2trAddress: (x) => p2trAddress(x, hrp) };
}
