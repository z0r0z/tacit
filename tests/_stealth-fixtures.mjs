// Random stealth transfers for the scan tests (stealth-scan-core.test.mjs, stealth-scan-workers.test.mjs): a wallet key, and transfers whose inputs are of assorted kinds and whose outputs
// pay the wallet, pay others, or carry odd scripts. Seeded, so a failing run is the same run.
import { secp, sha256, ripemd160, concatBytes, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import * as core from '../dapp/stealth-scan-core.js';

const N = secp.CURVE.n;
let seed = 0x1234abcd;
const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
export const bytes = (n) => Uint8Array.from({ length: n }, () => rnd(256));
const scalar = () => { let d = BigInt('0x' + bytesToHex(bytes(32))) % N; return d === 0n ? 1n : d; };
const be32 = (d) => hexToBytes(d.toString(16).padStart(64, '0'));
const pubOf = (d) => secp.getPublicKey(be32(d), true);
export const json = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? bytesToHex(v) : v));
const DOMAIN = new TextEncoder().encode('tacit-stealth-test-v1');

const walletD = scalar();
export const walletPriv = be32(walletD), walletPub = pubOf(walletD);
export const DOMAIN_FIXTURE = DOMAIN;
const kinds = ['p2wpkh', 'p2tr-keypath', 'p2wsh', 'p2tr-scriptpath', 'unknown', 'mixer-derived'];

// a transfer: inputs of assorted kinds (the eligible ones carry a key whose private part the "sender" knows), and outputs of which some pay the wallet
export function transfer({ pay = true, junk = true } = {}) {
  const nIn = 1 + rnd(4), privs = [], classifiedInputs = [];
  for (let i = 0; i < nIn; i++) {
    const kind = kinds[rnd(kinds.length)];
    if (kind === 'p2wpkh' || kind === 'p2tr-keypath') { const d = scalar(); privs.push(d); classifiedInputs.push({ kind, pub: kind === 'p2wpkh' ? pubOf(d) : concatBytes(new Uint8Array([2]), pubOf(d).slice(1)) }); }
    else classifiedInputs.push({ kind, pub: null });
  }
  const txAnchorHead = bytes(36), networkTag = ['mainnet', 'signet'][rnd(2)];
  const outputs = [];
  const sum = privs.reduce((a, d) => a + d, 0n) % N;
  // the keys a sender would use are the eligible inputs' full keys, whose parity decides the point the recipient adds up (an x-only input counts with an even y)
  const eligible = classifiedInputs.filter((c) => c.pub);
  let aggregate = null;
  try { aggregate = core.aggregateStealthEligibleInputPubkeys(classifiedInputs).aggregatePub; } catch { aggregate = null; }
  const shared = aggregate ? core.deriveStealthEcdhSharedSecret({ ourPriv: walletPriv, theirPub: aggregate }) : null;
  const nOut = 1 + rnd(6);
  for (let v = 0; v < nOut; v++) {
    const pick = rnd(8);
    if (pay && shared && pick < 3) {
      const b = core.deriveStealthBlindingFromShared({ shared, networkTag, domain: DOMAIN, txAnchor: concatBytes(txAnchorHead, core._stealthU32le(v)) });
      const commit = core.computeStealthCommit({ underlyingPub: walletPub, blinding: b });
      const wpkh = concatBytes(new Uint8Array([0, 0x14]), sha256ripemd(commit));
      outputs.push({ script: pick === 0 ? wpkh : concatBytes(new Uint8Array([0x51, 0x20]), commit.slice(1)) });
    } else if (junk && pick === 3) outputs.push({ script: concatBytes(new Uint8Array([0x6a, 0x20]), bytes(32)) });             // an OP_RETURN
    else if (junk && pick === 4) outputs.push({ script: new Uint8Array(0) });
    else if (junk && pick === 5) outputs.push({ script: bytes(rnd(60)) });
    else if (pick === 6) outputs.push({ script: concatBytes(new Uint8Array([0, 0x14]), bytes(20)) });                          // another's p2wpkh
    else outputs.push({ script: concatBytes(new Uint8Array([0x51, 0x20]), bytes(32)) });                                        // another's p2tr
  }
  return { classifiedInputs, outputs, txAnchorHead, networkTag, sum, eligible: eligible.length };
}
const sha256ripemd = (b) => ripemd160(sha256(b));

