// Before a proof is paid for, look on chain for inputs the settle would consume that are already gone: a note whose
// nullifier is recorded as spent (a bridged Bitcoin note and a farm receipt included), a wrap deposit that was
// already consumed, or a swap lock that a claim or refund already spent. Such a settle can only revert (the usual cause is a job served again after its first settle
// landed), so it is failed without proving.
//
// Every id is recomputed from the job's own witness fields with the guest's formulas (cxfer-core leaf, native_nu,
// deposit id). Anything unrecognised or unreadable lets the job through, so the check only ever skips work that
// cannot succeed.
import { keccak256, concat, pad, toHex, numberToHex } from 'viem';

const NATIVE_NULLIFIER_DOM = toHex('tacit-native-nullifier-v1');
const SPENT = toHex('spent');
const NULLIFIER_SPENT_SLOT = pad('0x46', { size: 32 }); // ConfidentialPool.nullifierSpent, declaration slot 70
export const LOCK_SPENT_SLOT = pad('0x77', { size: 32 }); // ConfidentialPool.lockSpent, declaration slot 119 (the slot the pages read it at)
const MAX_READS = 64;
const DEPOSIT_STATUS_ABI = [{ type: 'function', name: 'depositStatus', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint8' }] }];
const DEPOSIT_CONSUMED = 2;

const isHex32 = (v) => typeof v === 'string' && /^(0x)?[0-9a-fA-F]{1,64}$/.test(v);
const b32 = (v) => pad(String(v).startsWith('0x') ? String(v) : `0x${v}`, { size: 32 });

export const noteLeaf = (asset, cx, cy, owner) => keccak256(concat([b32(asset), b32(cx), b32(cy), b32(owner)]));
export const noteNullifier = ({ asset, cx, cy, owner, nk }) => {
  const leaf = noteLeaf(asset, cx, cy, owner);
  return BigInt(b32(owner)) === 0n ? keccak256(concat([leaf, SPENT])) : keccak256(concat([b32(nk), leaf, NATIVE_NULLIFIER_DOM]));
};
export const depositIdOf = ({ asset, value, cx, cy, owner }) =>
  keccak256(concat([b32(asset), numberToHex(BigInt(value), { size: 32 }), keccak256(concat([b32(cx), b32(cy), b32(owner)]))]));

const BTC_NOTE_DOM = toHex('tacit-btc-note-v1');
const BTC_NOTE_DOM_BOUND = toHex('tacit-btc-note-bound');
const FARM_RECEIPT_DOM = toHex('tacit-farm-receipt-v3');
const FARM_RECEIPT_NULL_DOM = toHex('tacit-farm-receipt-null-v1');
const le8 = (n) => { const b = []; let v = BigInt(n); for (let i = 0; i < 8; i++) { b.push(Number(v & 0xffn)); v >>= 8n; } return toHex(new Uint8Array(b)); };

// The nullifier a bridge mint records for the Bitcoin note it burns: the leaf-bound ν of the source leaf, whose form
// follows the op's source class (0 burn-deposit note owned by its outpoint, 1 reflected note, 2 reflected note bound to
// the deployment). The op carries no secret for it, so it is not among the spent inputs found by walking the witness.
export function bridgeMintNullifier(op) {
  const i = op && op.input;
  if (!i || !isHex32(op.asset) || !isHex32(i.cx) || !isHex32(i.cy) || !isHex32(i.owner)) return null;
  const parts = [b32(op.asset), b32(i.cx), b32(i.cy), b32(i.owner)];
  switch (Number(op.sourceClass)) {
    case 0: return keccak256(concat([keccak256(concat(parts)), SPENT]));
    case 1: return keccak256(concat([keccak256(concat([...parts, BTC_NOTE_DOM])), SPENT]));
    case 2: return isHex32(op.chainBinding) ? keccak256(concat([keccak256(concat([...parts, b32(op.chainBinding), BTC_NOTE_DOM_BOUND])), SPENT])) : null;
    default: return null;
  }
}

// The nullifier of the farm receipt an unbond spends (cxfer-core farm_receipt_leaf / farm_receipt_nullifier): the receipt
// names the farm's controller, the staked asset, the shares, its owner and its nonce. A harvest keeps the receipt staked
// and records no nullifier, so it has none here.
export function farmReceiptNullifier(op) {
  if (!op || !isHex32(op.controller) || !isHex32(op.lpAsset) || !isHex32(op.owner) || !isHex32(op.nonce) || op.shares == null) return null;
  const leaf = keccak256(concat([FARM_RECEIPT_DOM, b32(op.controller), b32(op.lpAsset), le8(op.shares), b32(op.owner), b32(op.nonce)]));
  return keccak256(concat([FARM_RECEIPT_NULL_DOM, leaf]));
}

// The lock nullifier an adaptor claim or refund records for the lock it spends (cxfer-core adaptor_lock_leaf, then the spent-once nullifier);
// the pool refuses a second spend of it (LockAlreadySpent). A lock op spends none.
const ADAPTOR_LOCK_DOM = toHex('tacit-adaptor-lock-v1');
export function adaptorLockNullifier(op) {
  if (!op || !['asset', 'lCx', 'lCy', 'tx', 'ty', 'recipient', 'locker'].every((k) => isHex32(op[k])) || op.deadline == null) return null;
  const leaf = keccak256(concat([ADAPTOR_LOCK_DOM, b32(op.asset), b32(op.lCx), b32(op.lCy), b32(op.tx), b32(op.ty), numberToHex(BigInt(op.deadline), { size: 8 }), b32(op.recipient), b32(op.locker)]));
  return keccak256(concat([leaf, SPENT]));
}
export function lockNullifiersOf(type, op) {
  try {
    if (type === 'adaptorclaim' || type === 'adaptorrefund') { const n = adaptorLockNullifier(op); return n ? [n] : []; }
  } catch { /* an op in a shape this formula does not read is let through */ }
  return [];
}

// The nullifiers of the spent notes in a witness. A note whose fields do not read as 32-byte words (a longer value cannot be padded into one)
// has no nullifier here and is left out, so one odd job never throws for the batch it sits in.
export function spentNullifiersOf(op) {
  const out = [];
  for (const n of spentInputsOf(op)) { try { out.push(noteNullifier(n)); } catch { /* unreadable: let the job through */ } }
  return out;
}

// Every nullifier the settle would record for this job that the witness fixes: the spent notes' own, plus the ones
// whose types carry them another way.
export function nullifiersOf(type, op) {
  const out = spentNullifiersOf(op);
  try {
    if (type === 'bridgemint') out.push(bridgeMintNullifier(op));
    else if (type === 'farmunbond') out.push(farmReceiptNullifier(op));
  } catch { /* an op in a shape these formulas do not read is let through */ }
  return [...new Set(out.filter(Boolean))];
}

// The public deposits a wrap-family op consumes, in the fields its prover harness reads (harnesses/exec-<type>.rs).
export function depositsOf(type, op) {
  const d = (asset, value, n) => (n && isHex32(asset) && value != null && n.cx && n.cy && n.owner ? [{ asset, value, cx: n.cx, cy: n.cy, owner: n.owner }] : []);
  switch (type) {
    case 'wrap': return d(op.asset, op.value, op);
    case 'wraptransfer': return d(op.asset, op.value, op.deposit);
    case 'wraplp': return [...d(op.assetA, op.a && op.a.value, op.a), ...d(op.assetB, op.b && op.b.value, op.b)];
    case 'wrapswap': return d(Number(op.direction) === 0 ? op.assetA : op.assetB, op.amountIn, op.deposit);
    default: return [];
  }
}

// Every spent note in the witness: an object carrying the note's secret key (`nk`, or `secret` in the transfer wire)
// next to its commitment and owner. Output notes never carry a secret. The asset is the note's own when the wire
// states it, the matching side of a pair for the `a`/`b` legs, else each asset the op names.
export function spentInputsOf(op) {
  const out = [];
  const walk = (node, key, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) { for (const x of node) walk(x, key, depth + 1); return; }
    const nk = node.nk ?? node.secret;
    if (typeof nk === 'string' && node.cx && node.cy && node.owner) {
      const assets = node.asset ? [node.asset] : key === 'a' ? [op.assetA] : key === 'b' ? [op.assetB] : [op.asset, op.assetA, op.assetB];
      for (const asset of new Set(assets.filter(isHex32))) out.push({ asset, cx: node.cx, cy: node.cy, owner: node.owner, nk });
    }
    for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') walk(v, k, depth + 1);
  };
  walk(op, '', 0);
  return out;
}

// The first input the job's settle would consume that is already gone, as { kind: 'deposit' | 'nullifier' | 'lock', id,
// reason }, else null.
export async function consumedInput({ type, op }, { client, pool }) {
  try {
    if (!op || typeof op !== 'object') return null;
    let reads = 0;
    for (const dep of depositsOf(type, op)) {
      if (++reads > MAX_READS) return null;
      const id = depositIdOf(dep);
      const status = await client.readContract({ address: pool, abi: DEPOSIT_STATUS_ABI, functionName: 'depositStatus', args: [id] });
      if (Number(status) === DEPOSIT_CONSUMED) return { kind: 'deposit', id, reason: `deposit ${id} was already consumed` };
    }
    for (const nu of nullifiersOf(type, op)) {
      if (++reads > MAX_READS) return null;
      const word = await client.getStorageAt({ address: pool, slot: keccak256(concat([nu, NULLIFIER_SPENT_SLOT])) });
      if (word && word !== '0x' && BigInt(word) !== 0n) return { kind: 'nullifier', id: nu, reason: `input nullifier ${nu} is already spent` };
    }
    for (const lu of lockNullifiersOf(type, op)) {
      if (++reads > MAX_READS) return null;
      const word = await client.getStorageAt({ address: pool, slot: keccak256(concat([lu, LOCK_SPENT_SLOT])) });
      if (word && word !== '0x' && BigInt(word) !== 0n) return { kind: 'lock', id: lu, reason: `swap lock ${lu} is already spent` };
    }
  } catch { return null; }
  return null;
}

// How a job whose input is already gone is acked, given the transaction found carrying its own memos (`own`) or else
// the one that consumed the input (`by`). Its own settle landing is the job settled. So is a plain wrap's deposit
// consumed by any settle: a deposit's id commits to the note it becomes and only its owner can open it, so whoever
// sent that settle (the page itself, another settler), a wrap is done. A job that was to do more with its deposit
// (send, swap, add liquidity) is not: the deposit went into a plain note instead, which the error says. A spent note
// is another matter too: a different op may have spent it.
export function consumedAck(gone, { own = null, by = null, type = null } = {}) {
  if (own) return { txHash: own };
  if (gone.kind === 'deposit' && by && type === 'wrap') return { txHash: by, settledBy: by };
  const where = by ? ` in ${by}` : '';
  return { error: gone.kind === 'deposit' ? `this deposit was already settled into a private note${where}`
    : gone.kind === 'lock' ? `this swap lock was already spent${where}; if that was this same claim, it went through`
    : `this note was already spent${where}; if that was this same request, it went through` };
}

// A reason string when the job's settle can only revert, else null.
export async function consumedInputs(job, ctx) {
  const gone = await consumedInput(job, ctx);
  return gone ? gone.reason : null;
}

// The deposits a relayed wrap-family op consumes that the pool has not recorded at all. Unreadable reads count as
// present, so this only ever names a deposit the chain says is not there.
export async function unlandedDeposits({ type, op }, { client, pool }) {
  const out = [];
  try {
    if (!op || typeof op !== 'object') return out;
    for (const dep of depositsOf(type, op).slice(0, MAX_READS)) {
      const id = depositIdOf(dep);
      const status = await client.readContract({ address: pool, abi: DEPOSIT_STATUS_ABI, functionName: 'depositStatus', args: [id] });
      if (Number(status) === 0) out.push(id);
    }
  } catch { return []; }
  return out;
}

