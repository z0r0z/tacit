// The order board for TacitGasRelay (contracts/src/TacitGasRelay.sol, dapp/gas-relay.js): a holder with no ETH signs an ORDER (a public swap or a
// pool entry paid for in TAC or the token spent) and posts it; the settle relay sends it and is paid the fee. An order is
// { order, signature, data, inPermit, feePermit, p2 }. It holds no secret: the signature authorises exactly this call, from this payer, once.
// The board checks what it can cheaply so the relay does not spend gas on junk: the shape, the deadline, that the call goes to an allowed
// target, that `data` is the signed call, and that the signature recovers to the payer (a contract wallet is not listed: the relay would have
// to simulate to know). The contract is the authority: the relay simulates before it sends.
//
// Storage (KV): gr:order:<digest> (the order, expiring with its deadline) and gr:index (a list of { id, at, until } newest last, capped).
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';

// The address that signed `digest`: a 65-byte r, s, v signature, v as 0/1 or 27/28.
function recoverSigner(digest, sigHex) {
  const sig = sigHex.replace(/^0x/, '');
  let v = parseInt(sig.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error('bad recovery id');
  const pub = secp.Signature.fromCompact(sig.slice(0, 128)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false).slice(1);
  return '0x' + bytesToHex(keccak_256(pub).slice(12));
}

export const GAS_RELAY = { maxOrders: 200, maxData: 16384, minTtlSecs: 60, maxTtlSecs: 3600, perClientPerHour: 30 };
export const GAS_RELAY_ADDR = '0x000000197E8f0B64463B2010e568fF42090Af88d';
export const GAS_TARGETS = [
  '0x000000000000FB114709235f1ccBFfb925F600e4', '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', '0x000000fA029Eaf69840C1490Bf9AA6C094794D5a',
  '0x000000e96fcFf90F220fa65F8b82C6114Cd1Cc30', '0x000000e66C32bEC739180A5eDeeB40A8225c5223', '0xe77D82b9A7B686ADc5F31F4cb83286981AC55FE4',
  '0x5650c850872bc89FC6E22CBB7a51b0e0DAC97198', '0x000000005dA3E3B73726af3c774Deeb9472D4992',
].map((a) => a.toLowerCase());
const TAC = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279';

const H = /^0x[0-9a-fA-F]{64}$/, A = /^0x[0-9a-fA-F]{40}$/, S = /^0x[0-9a-fA-F]{130}$/, NUM = /^\d{1,78}$/, HEX = /^0x([0-9a-fA-F]{2})*$/;
const k = (...p) => keccak_256(concatBytes(...p));
const enc = (s) => new TextEncoder().encode(s);
const word = (x) => { const b = new Uint8Array(32); let n = BigInt(x); for (let i = 31; i >= 0; i--) { b[i] = Number(n & 0xffn); n >>= 8n; } return b; };
const addrWord = (a) => { const b = new Uint8Array(32); b.set(hexToBytes(a.slice(2)), 12); return b; };
const lc = (x) => String(x).toLowerCase();

const ORDER_TYPEHASH = k(enc('Order(address payer,address tokenIn,uint256 amountIn,address feeToken,uint256 fee,address tokenOut,uint256 minOut,address recipient,address target,bytes32 dataHash,uint64 deadline,uint256 nonce)'));
const DOMAIN_TYPEHASH = k(enc('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
export const orderDigest = (o, relay = GAS_RELAY_ADDR, chainId = 1) => {
  const ds = k(DOMAIN_TYPEHASH, k(enc('TacitGasRelay')), k(enc('1')), word(chainId), addrWord(relay));
  const sh = k(ORDER_TYPEHASH, addrWord(o.payer), addrWord(o.tokenIn), word(o.amountIn), addrWord(o.feeToken), word(o.fee), addrWord(o.tokenOut), word(o.minOut), addrWord(o.recipient), addrWord(o.target), hexToBytes(o.dataHash.slice(2)), word(o.deadline), word(o.nonce));
  return k(new Uint8Array([0x19, 0x01]), ds, sh);
};

// The reason an order is refused, or null when the board will list it.
export function checkGasOrder(x, { relay = GAS_RELAY_ADDR, chainId = 1, now = Math.floor(Date.now() / 1000), cfg = GAS_RELAY } = {}) {
  try {
    if (!x || typeof x !== 'object') return 'not an order';
    const { order: o, signature, data, inPermit: ip, feePermit: fp, p2 } = x;
    if (!o || !A.test(o.payer) || !A.test(o.tokenIn) || !A.test(o.feeToken) || !A.test(o.tokenOut) || !A.test(o.recipient) || !A.test(o.target) || !H.test(o.dataHash)) return 'the order is malformed';
    for (const f of ['amountIn', 'fee', 'minOut', 'deadline', 'nonce']) if (!NUM.test(String(o[f]))) return 'the order is malformed';
    if (!S.test(signature || '')) return 'the signature is malformed';
    if (!HEX.test(data || '') || data.length > 2 + 2 * cfg.maxData) return 'the call is malformed or too large';
    for (const p of [ip, fp]) if (!p || !NUM.test(String(p.value)) || !NUM.test(String(p.deadline)) || (BigInt(p.deadline) !== 0n && (!/^\d+$/.test(String(p.v)) || !H.test(p.r) || !H.test(p.s)))) return 'a permit is malformed';
    if (p2 && p2.use && (!HEX.test(p2.sig || '') || !p2.batch || !Array.isArray(p2.batch.details) || p2.batch.details.length > 2)) return 'the Permit2 batch is malformed';
    if (BigInt(o.amountIn) === 0n || lc(o.tokenIn) === lc(o.tokenOut)) return 'the swap is empty';
    if (lc(o.feeToken) !== lc(o.tokenIn) && lc(o.feeToken) !== TAC) return 'the fee must be paid in TAC or the token spent';
    if (!GAS_TARGETS.includes(lc(o.target))) return 'the call does not go to an allowed contract';
    const dl = Number(o.deadline);
    if (dl < now + cfg.minTtlSecs) return 'the deadline is too near';
    if (dl > now + cfg.maxTtlSecs) return 'the deadline is too far';
    if ('0x' + bytesToHex(keccak_256(hexToBytes(data.slice(2)))) !== lc(o.dataHash)) return 'the call is not the one signed';
    if (lc(recoverSigner(orderDigest(o, relay, chainId), signature)) !== lc(o.payer)) return 'the order is not signed by its payer';
    return null;
  } catch (e) { return `the order could not be read: ${e.message}`; }
}

export function makeGasBoard({ kv, relay = GAS_RELAY_ADDR, chainId = 1, cfg = GAS_RELAY, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const readIndex = async () => { const s = await kv.get('gr:index'); try { return JSON.parse(s || '[]') || []; } catch { return []; } };
  const writeIndex = (list) => kv.put('gr:index', JSON.stringify(list.slice(-cfg.maxOrders)));
  return {
    async post(x) {
      const why = checkGasOrder(x, { relay, chainId, now: now(), cfg });
      if (why) return { ok: false, error: why };
      const id = '0x' + bytesToHex(orderDigest(x.order, relay, chainId)), until = Number(x.order.deadline);
      if (await kv.get(`gr:order:${id}`)) return { ok: true, id, existing: true };
      const idx = (await readIndex()).filter((e) => e.until > now());
      if (idx.length >= cfg.maxOrders) return { ok: false, error: 'the board is full, try again shortly' };
      // what the board keeps is the order's own fields, not whatever else the request carried
      const stored = JSON.stringify({ order: x.order, signature: x.signature, data: x.data, inPermit: x.inPermit, feePermit: x.feePermit, p2: x.p2 });
      if (stored.length > 2 * cfg.maxData + 8192) return { ok: false, error: 'the order is too large' };
      await kv.put(`gr:order:${id}`, stored, { expirationTtl: Math.max(60, until - now() + 60) });
      idx.push({ id, at: now(), until });
      await writeIndex(idx);
      return { ok: true, id };
    },
    async list(limit = 20) {
      const idx = (await readIndex()).filter((e) => e.until > now()).slice(0, limit), out = [];
      for (const e of idx) { const s = await kv.get(`gr:order:${e.id}`); if (s) { try { out.push({ id: e.id, ...JSON.parse(s) }); } catch { /* skip */ } } }
      return out;
    },
    // `by` ({ payer, nonce }), when given, is the order the relay reports used: the stored order has to be that one.
    async remove(id, by = null) {
      id = lc(id);
      if (by) {
        const s = await kv.get(`gr:order:${id}`);
        if (s) {
          let o = null; try { o = JSON.parse(s).order; } catch { o = null; }
          if (!o || lc(o.payer) !== lc(by.payer) || String(o.nonce) !== String(by.nonce)) return { ok: false, error: 'that order is not the one the relay reports used' };
        }
      }
      await kv.delete(`gr:order:${id}`);
      await writeIndex((await readIndex()).filter((e) => e.id !== id));
      return { ok: true };
    },
  };
}
