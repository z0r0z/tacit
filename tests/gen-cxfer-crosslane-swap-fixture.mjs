#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/crosslane_swap_op.json — the acceptance witness for the
// ONE-SETTLE ATOMIC fast-lane SWAP (a Bitcoin-homed note spent directly INTO an Ethereum AMM swap, in
// one settle). It is the OP_SWAP witness (gen-confidential-swap-fixture.mjs) put in CROSS-LANE mode:
//   • bitcoinSpentRoot != 0  → the guest runs check_btc_nonmembership per spent input
//   • per intent: a `nonMember` indexed-Merkle witness (ν absent from the reflected Bitcoin spent set)
//   • `expected.consumed` = the input ν the contract records in bitcoinConsumed (spendRoot-bound),
//     so the reverse reflection folds each into the Bitcoin spent set (Ethereum-senior void).
// The swap math + opening sigs are IDENTICAL to the value-conserving swap fixture; the only additions
// are the cross-lane bits, mirroring gen-cxfer-crosslane-fixture.mjs (which does the same for a
// transfer). This is the per-op (G2) binding made concrete: a btcHomed input may fund a swap, and its
// ν is consumed-and-reflected exactly like a leaf exit.
//
// Scope: this validates the SETTLE-side binding (PROGRAM_VKEY). It is INDEPENDENT of the reflection-side
// freshness set-anchoring (the eth-accumulator prior; a separate reflection-guest item). The swap guest
// already READS the per-intent nonMember in the swap loop (right after the input's membership + nullifier,
// before amount_in — main.rs:455, op-agnostic), so no settle-guest change is needed; this fixture just
// validates that path against the box re-prove. See ops/PLAN-fast-lane-trading.md.
//
// Run: node tests/gen-cxfer-crosslane-swap-fixture.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialSwap } from '../dapp/confidential-swap.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const swap = makeConfidentialSwap({ keccak256, pool });

const ASSET_A = '0x' + 'aa'.repeat(32);
const ASSET_B = '0x' + 'bb'.repeat(32);
const OWNER = '0x' + '00'.repeat(31) + '01';
const OWNER_OUT = '0x' + '00'.repeat(31) + '02';
const CHAIN_BINDING = '0x' + '11'.repeat(32);

const det = (tag) => '0x' + keccak256(new TextEncoder().encode('cxfer-crosslane-swap-' + tag)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');

// ── the swap, identical in shape to the value-conserving swap fixture ──
const intent = swap.buildIntent({
  direction: 'A->B', amountIn: 100, priceNum: 90, priceDen: 100, minOut: 90,
  rInSecp: BigInt(det('in-secp')), rOutSecp: BigInt(det('out-secp')),
  nonceIn: BigInt(det('in-nonce')), nonceOut: BigInt(det('out-nonce')),
  inNote: { owner: OWNER, leafIndex: 0, path: pool.zeros }, outOwner: OWNER_OUT,
});

// `spendRoot` here is a reflected BITCOIN pool root (the input note is btcHomed — a member of Bitcoin's
// confidential-pool tree); the membership construction is identical to the Ethereum-homed case.
const tree = new pool.Tree();
const idx = tree.insert(pool.leaf(ASSET_A, intent.in.cx, intent.in.cy, intent.in.owner));
const { root, path } = tree.rootAndPath(idx);
intent.in.leafIndex = idx; intent.in.path = path;

const batch = swap.buildBatch({ assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: 30, reserveAPre: 1000, reserveBPre: 1000, priceNum: 90, priceDen: 100, intents: [intent], spendRoot: root });
const { settlement, nullifiers, leaves } = swap.verifyBatch(batch, { merkleRootFrom: pool.merkleRootFrom });

// ── cross-lane: an empty reflected Bitcoin spent set (one sentinel leaf {0 → MAX}); every ν is a
//    non-member through it. A populated set is the same primitive (cxfer-core imt_non_membership). ──
const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const ZERO = beHex(0n), MAX = '0x' + 'ff'.repeat(32);
const imtLeaf = (v, n) => '0x' + Buffer.from(keccak_256(cat([bytes(v), bytes(n)]))).toString('hex');

const spentTree = new pool.Tree();
spentTree.insert(imtLeaf(ZERO, MAX));
const bitcoinSpentRoot = spentTree.root();
const nonMember = { lowValue: ZERO, lowNext: MAX, lowIndex: 0, path: spentTree.rootAndPath(0).path };

// every consumed ν must sit strictly inside the sentinel gap (0 < ν < MAX) for the non-membership to hold
const big = (h) => BigInt(h.startsWith('0x') ? h : '0x' + h);
for (const nu of nullifiers) {
  if (!(big(nu) > 0n && big(nu) < big(MAX))) throw new Error('nullifier outside the sentinel non-membership gap: ' + nu);
}

// the ν the contract records in bitcoinConsumed[ν] = spendRoot (the reverse reflection folds each)
const consumed = nullifiers.map((nu) => ({ nullifier: nu, spendRoot: root }));

const fixture = {
  note: 'one-settle atomic fast-lane SWAP — btcHomed input funds an Ethereum OP_SWAP + per-intent cross-lane non-membership + consumed-ν',
  chainBinding: CHAIN_BINDING,
  spendRoot: root,            // a reflected Bitcoin pool root (btcHomed input membership)
  bitcoinSpentRoot,           // != 0 → guest runs check_btc_nonmembership per input
  assetA: ASSET_A, assetB: ASSET_B,
  feeBps: 30,
  reserveAPre: 1000, reserveBPre: 1000, priceNum: 90, priceDen: 100,
  intents: [{
    direction: intent.dirByte,
    inCx: intent.in.cx, inCy: intent.in.cy, inOwner: intent.in.owner,
    inLeafIndex: intent.in.leafIndex, inPath: intent.in.path,
    amountIn: Number(intent.amountIn), amountOut: Number(intent.amountOut), rem: Number(intent.rem),
    inSigR: intent.inSig.R, inSigZ: intent.inSig.z, minOut: Number(intent.minOut),
    deadline: Number(intent.deadline ?? 0),
    outCx: intent.out.cx, outCy: intent.out.cy, outOwner: intent.out.owner,
    outSigR: intent.outSig.R, outSigZ: intent.outSig.z,
    nonMember, // cross-lane: read after the input's membership + nullifier, before amount_in (main.rs:455)
  }],
  expected: {
    poolId: settlement.poolId,
    reserveAPost: Number(settlement.reserveAPost), reserveBPost: Number(settlement.reserveBPost),
    nullifiers, leaves,
    consumed, // contract records these in bitcoinConsumed + advances bitcoinConsumedCount by consumed.length
  },
};

const out = 'contracts/sp1/confidential/fixtures/crosslane_swap_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out, '— cross-lane A→B 100→90, reserves 1000/1000 →',
  fixture.expected.reserveAPost + '/' + fixture.expected.reserveBPost,
  '· consumed ν:', consumed.length, '· bitcoinSpentRoot set');
