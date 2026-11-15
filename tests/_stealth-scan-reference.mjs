// The stealth scan functions exactly as dapp/tacit.js had them before they moved into dapp/stealth-scan-core.js (cut out of it verbatim, only `export` added), kept so
// tests/stealth-scan-core.test.mjs can hold the shared module, whose recipientScanTxForStealth does the same work with two savings, to what tacit.js did. Test use only.
import { secp, sha256, hmac, ripemd160, concatBytes, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = secp.ProjectivePoint.BASE;
const ZERO = secp.ProjectivePoint.ZERO;
const hash160 = b => ripemd160(sha256(b));
const p2wpkhScript = pubkey => concatBytes(new Uint8Array([0x00, 0x14]), hash160(pubkey));
const p2trScript = (Q_xonly) => concatBytes(new Uint8Array([0x51, 0x20]), Q_xonly);

export function _stealthNetworkTagByte(net) {
  if (net === 'mainnet') return 0x00;
  if (net === 'signet')  return 0x01;
  if (net === 'regtest') return 0x02;
  if (typeof net === 'number') return net & 0xff;
  throw new Error(`unknown network: ${net}`);
}

export function isStealthEligibleKind(kind) {
  return kind === 'p2wpkh' || kind === 'p2tr-keypath';
}

export function aggregateStealthEligibleInputPubkeys(inputs) {
  let acc = ZERO, count = 0;
  for (const inp of inputs) {
    if (!isStealthEligibleKind(inp.kind)) continue;
    if (!inp.pub || inp.pub.length !== 33) continue;
    const Pt = secp.ProjectivePoint.fromHex(bytesToHex(inp.pub));
    acc = acc.add(Pt); count += 1;
  }
  if (count === 0 || acc.equals(ZERO)) return { aggregatePub: null, eligibleCount: 0 };
  return { aggregatePub: acc.toRawBytes(true), eligibleCount: count };
}

export function deriveStealthEcdhSharedSecret({ ourPriv, theirPub }) {
  if (ourPriv.length !== 32) throw new Error('ourPriv must be 32 bytes');
  if (theirPub.length !== 33) throw new Error('theirPub must be 33 bytes compressed');
  const ourPrivBig = BigInt('0x' + bytesToHex(ourPriv));
  const theirPt = secp.ProjectivePoint.fromHex(bytesToHex(theirPub));
  const sharedPt = theirPt.multiply(ourPrivBig);
  const sharedXonly = sharedPt.toRawBytes(true).slice(1);
  return sha256(sharedXonly);
}

export function deriveStealthBlindingFromShared({ shared, networkTag, domain, txAnchor }) {
  const tag = new Uint8Array([_stealthNetworkTagByte(networkTag) & 0xff]);
  const mac = hmac(sha256, shared, concatBytes(domain, tag, txAnchor));
  const b = BigInt('0x' + bytesToHex(mac)) % SECP_N;
  if (b === 0n) throw new Error('ECDH blinding derived zero (statistically impossible)');
  return b;
}

export function computeStealthCommit({ underlyingPub, blinding }) {
  if (underlyingPub.length !== 33) throw new Error('underlyingPub must be 33 bytes compressed');
  const Pt = secp.ProjectivePoint.fromHex(bytesToHex(underlyingPub));
  const commitPt = Pt.add(G.multiply(blinding));
  if (commitPt.equals(ZERO)) throw new Error('stealth commit equals point at infinity');
  return commitPt.toRawBytes(true);
}

export function computeStealthTweakedSk({ underlyingPriv, blinding }) {
  if (underlyingPriv.length !== 32) throw new Error('underlyingPriv must be 32 bytes');
  const d = BigInt('0x' + bytesToHex(underlyingPriv));
  if (d <= 0n || d >= SECP_N) throw new Error('underlyingPriv scalar out of range');
  const tweaked = (d + blinding) % SECP_N;
  if (tweaked === 0n) throw new Error('tweaked secret derived zero (statistically impossible)');
  let hex = tweaked.toString(16); while (hex.length < 64) hex = '0' + hex;
  return hexToBytes(hex);
}

export function _stealthU32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

export function recipientScanTxForStealth({
  classifiedInputs, outputs, walletPriv, walletPub, networkTag, domain, txAnchorHead,
}) {
  const { aggregatePub } = aggregateStealthEligibleInputPubkeys(classifiedInputs);
  if (!aggregatePub) return [];
  let shared;
  try {
    shared = deriveStealthEcdhSharedSecret({ ourPriv: walletPriv, theirPub: aggregatePub });
  } catch { return []; }
  const credits = [];
  for (let v = 0; v < outputs.length; v++) {
    const txAnchor = concatBytes(txAnchorHead, _stealthU32le(v));
    let b;
    try {
      b = deriveStealthBlindingFromShared({ shared, networkTag, domain, txAnchor });
    } catch { continue; }
    let commit;
    try { commit = computeStealthCommit({ underlyingPub: walletPub, blinding: b }); }
    catch { continue; }
    const wpkh = p2wpkhScript(commit);
    const tr = p2trScript(commit.slice(1));
    const out = outputs[v].script;
    let scriptKind = null;
    if (out.length === wpkh.length && out.every((x, i) => x === wpkh[i])) scriptKind = 'p2wpkh';
    else if (out.length === tr.length && out.every((x, i) => x === tr[i])) scriptKind = 'p2tr';
    if (scriptKind) {
      const tweakedSk = computeStealthTweakedSk({ underlyingPriv: walletPriv, blinding: b });
      credits.push({
        voutIndex: v, scriptKind, tweakedSk, commit, blinding: b, senderAggregatePub: aggregatePub,
      });
    }
  }
  return credits;
}

