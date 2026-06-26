// Unified Tacit address (tacit1… / tactt1… / tacrt1…) — one handle, two chains.
//
// Bundles the receive material for both lanes so a counterparty can pay the
// holder on whichever chain they're transacting from:
//   - BTC spend pubkey  → CXFER pubkey sends + stealth one-time derivation
//   - BTC scan pubkey   → BIP-352 silent payments + stealth scan
//   - EVM owner pubkey   → confidential-pool note transfer (== compressed wallet
//                          pubkey; carried explicitly so it survives any future
//                          divergence from the BTC spend key)
//
// All three derive deterministically from one wallet root — no new key material.
// Sharing the address links the holder's OWN two lanes to whoever receives it
// (inherent to a "pay me anywhere" handle); it does not weaken on-chain
// unlinkability for anyone who lacks the address. Per-lane legacy addresses
// remain fully supported for users who want lane isolation.
//
// Self-contained bech32m (BIP-350) so this module is importable in node tests
// without the dapp monolith. `secp` is injected (same shape as the other
// confidential-* factories).

const _ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const _CONST = 0x2bc830a3;

function _polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function _expandHrp(hrp) {
  const r = [];
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) >>> 5);
  r.push(0);
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) & 31);
  return r;
}
function _checksum(hrp, data) {
  const v = _expandHrp(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const pm = _polymod(v) ^ _CONST;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((pm >>> (5 * (5 - i))) & 31);
  return out;
}
function _convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (const v of data) {
    if (v < 0 || (v >>> fromBits) !== 0) throw new Error('convertBits: invalid input');
    acc = (acc << fromBits) | v;
    bits += fromBits;
    while (bits >= toBits) { bits -= toBits; ret.push((acc >>> bits) & maxv); }
  }
  if (pad) {
    if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    throw new Error('convertBits: invalid padding');
  }
  return ret;
}
function _encode(hrp, dataBytes) {
  const d5 = _convertBits(Array.from(dataBytes), 8, 5, true);
  const cs = _checksum(hrp, d5);
  let out = hrp + '1';
  for (const v of d5.concat(cs)) out += _ALPHABET[v];
  return out;
}
function _decode(addr) {
  const lower = addr.toLowerCase();
  const upper = addr.toUpperCase();
  if (lower !== addr && upper !== addr) throw new Error('mixed case');
  addr = lower;
  const sep = addr.lastIndexOf('1');
  if (sep < 1 || sep + 7 > addr.length) throw new Error('invalid separator position');
  const hrp = addr.slice(0, sep);
  const d5 = [];
  for (let i = sep + 1; i < addr.length; i++) {
    const idx = _ALPHABET.indexOf(addr[i]);
    if (idx === -1) throw new Error(`invalid char ${addr[i]}`);
    d5.push(idx);
  }
  if (_polymod(_expandHrp(hrp).concat(d5)) !== _CONST) throw new Error('checksum');
  const payload5 = d5.slice(0, d5.length - 6);
  return { hrp, payloadBytes: new Uint8Array(_convertBits(payload5, 5, 8, false)) };
}

export const TACIT_HRP_BY_NETWORK = { mainnet: 'tacit', signet: 'tactt', regtest: 'tacrt' };
export const TACIT_ADDR_VERSION = 0x00;
export const TACIT_LANE_BTC = 0x01;
export const TACIT_LANE_EVM = 0x02;

function _concat(...arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

export function makeTacitAddress({ secp }) {
  const assertPoint = (u8, label) => {
    if (!(u8 instanceof Uint8Array) || u8.length !== 33) throw new Error(`${label} must be 33-byte compressed`);
    secp.ProjectivePoint.fromHex(Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join(''));
  };

  function encodeTacitAddress({ network, btcSpendPub, btcScanPub, evmOwnerPub }) {
    const hrp = TACIT_HRP_BY_NETWORK[network];
    if (!hrp) throw new Error(`unknown network: ${network}`);
    assertPoint(btcSpendPub, 'btcSpendPub');
    assertPoint(btcScanPub, 'btcScanPub');
    let flags = TACIT_LANE_BTC;
    let payload = _concat(btcSpendPub, btcScanPub);
    if (evmOwnerPub) {
      assertPoint(evmOwnerPub, 'evmOwnerPub');
      flags |= TACIT_LANE_EVM;
      payload = _concat(payload, evmOwnerPub);
    }
    return _encode(hrp, _concat(new Uint8Array([TACIT_ADDR_VERSION, flags]), payload));
  }

  function decodeTacitAddress(addr) {
    const { hrp, payloadBytes } = _decode(addr);
    let network = null;
    for (const [k, v] of Object.entries(TACIT_HRP_BY_NETWORK)) if (hrp === v) network = k;
    if (!network) throw new Error(`HRP ${hrp} is not a tacit unified HRP`);
    if (payloadBytes.length < 2) throw new Error('payload too short');
    const version = payloadBytes[0], flags = payloadBytes[1];
    if (version !== TACIT_ADDR_VERSION) throw new Error(`unsupported version ${version}`);
    if (!(flags & TACIT_LANE_BTC)) throw new Error('unified address must carry the Bitcoin lane');
    const wantLen = 2 + 33 + 33 + ((flags & TACIT_LANE_EVM) ? 33 : 0);
    if (payloadBytes.length !== wantLen) throw new Error(`payload length ${payloadBytes.length} != ${wantLen}`);
    const btcSpendPub = payloadBytes.slice(2, 35);
    const btcScanPub = payloadBytes.slice(35, 68);
    assertPoint(btcSpendPub, 'btcSpendPub');
    assertPoint(btcScanPub, 'btcScanPub');
    const lanes = { btc: { spendPub: btcSpendPub, scanPub: btcScanPub } };
    if (flags & TACIT_LANE_EVM) {
      const evmOwnerPub = payloadBytes.slice(68, 101);
      assertPoint(evmOwnerPub, 'evmOwnerPub');
      lanes.evm = { ownerPub: evmOwnerPub };
    }
    return { network, flags, lanes };
  }

  return { encodeTacitAddress, decodeTacitAddress };
}
