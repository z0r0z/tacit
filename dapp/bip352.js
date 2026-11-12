
import { secp, sha256, ripemd160, hexToBytes, concatBytes } from './vendor/tacit-deps.min.js';

const SECP_N = secp.CURVE.n;
const ZERO = secp.ProjectivePoint.ZERO;
const TAP_NUMS = hexToBytes('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');

const hash160 = (b) => ripemd160(sha256(b));
const bytesToHexLocal = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytes32ToBigint = (b) => BigInt('0x' + bytesToHexLocal(b));
const reverseBytes = (b) => { const r = new Uint8Array(b); r.reverse(); return r; };
const bytesToPoint = (b) => {
  if (!b || b.length !== 33) throw new Error('point must be 33 bytes (compressed)');
  if (b[0] !== 0x02 && b[0] !== 0x03) throw new Error('point prefix must be 0x02/0x03');
  return secp.ProjectivePoint.fromHex(bytesToHexLocal(b));
};

export function bip352TaggedHash(tag, ...msgs) {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(tagHash, tagHash, ...msgs));
}

export function bip352U32be(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

export function bip352OutpointBytes(txidHexDisplay, vout) {
  const txidLE = reverseBytes(hexToBytes(txidHexDisplay));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, vout >>> 0, true);
  return concatBytes(txidLE, voutLE);
}

export function bip352SmallestOutpoint(outpoints) {
  if (!outpoints.length) throw new Error('no outpoints');
  let best = outpoints[0];
  for (let i = 1; i < outpoints.length; i++) {
    const o = outpoints[i];
    for (let j = 0; j < 36; j++) {
      if (o[j] < best[j]) { best = o; break; }
      if (o[j] > best[j]) break;
    }
  }
  return best;
}

export function bip352InputPubkey({ prevoutScript, scriptSig, witness }) {
  const spk = prevoutScript || new Uint8Array(0);
  const ss = scriptSig || new Uint8Array(0);
  const wit = witness || [];
  const compressed = (b) => {
    if (!b || b.length !== 33 || (b[0] !== 0x02 && b[0] !== 0x03)) return null;
    try { bytesToPoint(b); return b; } catch { return null; }
  };
  const isP2wpkh = (s) => s.length === 22 && s[0] === 0x00 && s[1] === 0x14;
  if (spk.length === 25 && spk[0] === 0x76 && spk[1] === 0xa9 && spk[2] === 0x14 && spk[23] === 0x88 && spk[24] === 0xac) {
    const h = spk.slice(3, 23);
    for (let i = ss.length; i >= 33; i--) {
      const cand = ss.slice(i - 33, i);
      const ch = hash160(cand);
      let eq = true;
      for (let j = 0; j < 20; j++) if (ch[j] !== h[j]) { eq = false; break; }
      if (eq) { const pk = compressed(cand); if (pk) return pk; }
    }
  }
  if (spk.length === 23 && spk[0] === 0xa9 && spk[1] === 0x14 && spk[22] === 0x87) {
    if (isP2wpkh(ss.slice(1)) && wit.length > 0) {
      const pk = compressed(wit[wit.length - 1]);
      if (pk) return pk;
    }
  }
  if (isP2wpkh(spk) && wit.length > 0) {
    const pk = compressed(wit[wit.length - 1]);
    if (pk) return pk;
  }
  if (spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20 && wit.length >= 1) {
    let stack = wit;
    if (stack.length > 1 && stack[stack.length - 1].length > 0 && stack[stack.length - 1][0] === 0x50) {
      stack = stack.slice(0, -1);
    }
    if (stack.length > 1) {
      const internal = stack[stack.length - 1].slice(1, 33);
      if (internal.length === 32 && internal.every((b, i) => b === TAP_NUMS[i])) return null;
    }
    return compressed(concatBytes(new Uint8Array([0x02]), spk.slice(2, 34)));
  }
  return null;
}

export function bip352IsUnknownSegwit(spk) {
  if (!spk || spk.length < 4 || spk.length > 42) return false;
  return spk[0] >= 0x52 && spk[0] <= 0x60 && spk[1] >= 2 && spk[1] <= 40 && spk[1] === spk.length - 2;
}

export function bip352ReceiverInputsFromEsploraTx(tx) {
  if (!tx || !Array.isArray(tx.vin) || tx.vin.length === 0) return null;
  const classifiedInputs = [];
  for (const vin of tx.vin) {
    if (vin.is_coinbase) return null;
    const prevoutScript = vin.prevout?.scriptpubkey ? hexToBytes(vin.prevout.scriptpubkey) : null;
    if (bip352IsUnknownSegwit(prevoutScript)) return null;
    const scriptSig = vin.scriptsig ? hexToBytes(vin.scriptsig) : null;
    const witness = (vin.witness || []).map(h => { try { return hexToBytes(h); } catch { return new Uint8Array(0); } });
    classifiedInputs.push({ kind: 'bip352', pub: bip352InputPubkey({ prevoutScript, scriptSig, witness }) });
  }
  const allOutpoints = tx.vin.map(vin => bip352OutpointBytes(vin.txid, vin.vout));
  return { classifiedInputs, allOutpoints };
}

export function bip352PublicTweakPoint(pubs, allOutpoints) {
  let A_sum = ZERO, count = 0;
  for (const p of pubs || []) {
    if (!p || p.length !== 33) continue;
    A_sum = A_sum.add(bytesToPoint(p));
    count++;
  }
  if (count === 0 || A_sum.equals(ZERO)) return null;
  const op_L = bip352SmallestOutpoint(allOutpoints);
  const ih = bytes32ToBigint(bip352TaggedHash('BIP0352/Inputs', op_L, A_sum.toRawBytes(true)));
  if (ih === 0n || ih >= SECP_N) return null;
  return A_sum.multiply(ih);
}

export function bip352PublicTweakFromEsploraTx(tx) {
  const inp = bip352ReceiverInputsFromEsploraTx(tx);
  if (!inp) return null;
  const P = bip352PublicTweakPoint(inp.classifiedInputs.map((c) => c.pub), inp.allOutpoints);
  return P ? P.toRawBytes(true) : null;
}
