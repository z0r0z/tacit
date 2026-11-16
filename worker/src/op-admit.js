// Whether an op of a type the relay sponsors carries the fields its prover reads, checked at the door before it takes a place in the queue or a
// free settle. The prover's harness unwraps each of them, so an op missing one fails after the relay has already started on it; and the relay's
// pre-prove gates (lib/cbtc-mint-precheck.js, lib/cdp-precheck.js) pass an op that lacks the fields they read, because they cannot judge it.
// This closes that gap and nothing else: it judges the shape, never the chain (the gates and the guest do that), and it is lenient about form
// (a number may arrive as an integer, a decimal string or hex) so no real op is refused for how it was written.
//   admitOpShape(type, op) → { ok: true } | { ok: false, code: 'bad_op', error }
const hex = (bytes) => (v) => typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v);
const h32 = hex(32), h20 = hex(20), h33 = hex(33);
const sig = (v) => typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2}){64,66}$/.test(v);
const sig64 = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{128}$/.test(v);              // a BIP-340 signature, R then s
const uint = (v) => (typeof v === 'number' ? Number.isInteger(v) && v >= 0 : typeof v === 'bigint' ? v >= 0n : typeof v === 'string' && (/^\d{1,78}$/.test(v) || /^0x[0-9a-fA-F]{1,64}$/.test(v)));
const path = (v) => Array.isArray(v) && v.length === 32 && v.every(h32);
const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A leg of a basket that is spent into a position: the note's opening, its place in the tree, and its authorization.
const spentLeg = (l) => obj(l) && h32(l.asset) && h32(l.cx) && h32(l.cy) && h32(l.owner) && h32(l.nk) && uint(l.value) && uint(l.index) && path(l.path) && h33(l.sigR) && h32(l.sigZ);
const heldLeg = (l) => obj(l) && h32(l.asset) && uint(l.value);
const legs = (v, ok, max = 8) => Array.isArray(v) && v.length >= 1 && v.length <= max && v.every(ok);

const SHAPES = {
  cbtcmint: { what: 'cBTC mint', fields: { chainBinding: h32, outpoint: h32, vBtc: uint, cx: h32, cy: h32, sigR: h33, sigZ: h32 } },
  cdpmint: { what: 'cUSD loan', fields: { chainBinding: h32, spendRoot: h32, controller: h20, owner: h32, debtValue: uint, nonce: h32, rateSnapshot: uint, legs: (v) => legs(v, spentLeg) },
    extra: (o) => (o.fee == null || uint(o.fee)) && (o.debtOwner == null || h32(o.debtOwner)) && (o.debt == null || (obj(o.debt) && h32(o.debt.cx) && h32(o.debt.cy) && h33(o.debt.sigR) && h32(o.debt.sigZ))) },
  cdptopup: { what: 'collateral top-up', fields: { chainBinding: h32, spendRoot: h32, cdpPositionRoot: h32, controller: h20, owner: h32, debtValue: uint, oldNonce: h32, newNonce: h32, rateSnapshot: uint,
    positionIndex: uint, positionPath: path, oldLegs: (v) => legs(v, heldLeg), addedLegs: (v) => legs(v, spentLeg), ownerSig: sig } },
  // The fields the farmunbond prover input reads (worker-relay/src/lib/spn/sp1-stdin.js farmunbond): an op without one costs the relay minutes before the binary says so
  // (a burst of such jobs held the settle relay for 35 minutes on 2026-11-16, prove-only ones included: this check covers both modes).
  farmunbond: { what: 'farm unbond', fields: { chainBinding: h32, spendRoot: h32, controller: h20, owner: h32, lpOwner: h32, shares: uint, nonce: h32, lpAsset: h32, oldIndex: uint,
    oldPath: path, releaseCx: h32, releaseCy: h32, sigR: h33, sigZ: h32, ownerSig: sig64 }, extra: (o) => o.fee == null || uint(o.fee) },
};

export function admitOpShape(type, op) {
  const spec = SHAPES[type];
  if (!spec) return { ok: true };                                                // a type this does not judge
  const bad = (what) => ({ ok: false, code: 'bad_op', error: `this is not a ${spec.what} the relay can read (${what})` });
  if (!obj(op)) return bad('no op');
  for (const [k, ok] of Object.entries(spec.fields)) if (!ok(op[k])) return bad(`${k} is missing or malformed`);
  if (spec.extra && !spec.extra(op)) return bad('a field is malformed');
  return { ok: true };
}
export const SHAPED_TYPES = Object.keys(SHAPES);
