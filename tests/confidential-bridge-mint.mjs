#!/usr/bin/env node
// BTC → ETH bridge-mint, modeled end-to-end in Node. bridge-mint is the MIRROR of
// bridge-burn: a Bitcoin confidential burn destined for Ethereum is a bridge-burn
// with destChain = ETHEREUM, producing a crossOut whose destCommitment IS the
// Ethereum leaf to mint. The Ethereum guest verifies that Bitcoin burn (in-guest,
// reusing the tETH bitcoin.rs primitives — the one box-gated piece) and inserts
// the leaf, gating one-mint-per-claimId via bitcoinBurnsConsumed/bridgeMinted.
//
// This test validates everything that does NOT need the Bitcoin-state proof:
//   - conservation across the boundary (value carried verbatim → v_mint == v_burn)
//   - claimId binds the mint to exactly that burn (same derivation both sides)
//   - the Ethereum recipient RECOVERS the minted note from chain + seed alone,
//     via the same indexer used for native notes (the minted note is byte-identical)
// so the box work reduces to wiring the Bitcoin verification onto a proven flow.
//
// Run: node tests/confidential-bridge-mint.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar, G } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialMemo } from '../dapp/confidential-memo.js';
import { makeConfidentialIndexer } from '../dapp/confidential-indexer.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const deps = { secp, keccak256, sha256 };
const ct = makeConfidentialTransfer({ keccak256 });
const memo = makeConfidentialMemo({ secp, sha256, keccak256 });
const idx = makeConfidentialIndexer(deps);
const pool = makeConfidentialPool(deps);
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const pubHex = (priv) => '0x' + Buffer.from(G.multiply(priv).toRawBytes(true)).toString('hex');
const ASSET = '0x' + 'a5'.repeat(32);     // a two-sided (bridged) asset, e.g. tETH
const ETHEREUM = 2;                        // destChain selector (1=bitcoin, 2=ethereum)

// The Ethereum recipient: a scan key + their owner field.
const rPriv = randomScalar(), rPub = pubHex(rPriv);
const OWNER_ETH = '0x' + '00'.repeat(31) + 'e7';

// ── 1. Bitcoin side: burn 1500 of confidential value, destined for one Ethereum note ──
const btcInputs = [
  { value: 1000n, blinding: randomScalar(), secret: '0x' + '11'.repeat(32) },
  { value: 500n, blinding: randomScalar(), secret: '0x' + '22'.repeat(32) },
];
const mintValue = 1500n;
const mintBlinding = randomScalar();
const mintSecret = '0x' + 'c5'.repeat(32);
// The burn's canonical ν is NOTE-BOUND (spec B3): keccak(Cx ‖ Cy ‖ "spent") of the first
// burned input — exactly what the guest derives (main.rs OP_BRIDGE_BURN), not keccak(secret).
const c0 = memo.commitXY(btcInputs[0].value, btcInputs[0].blinding);
const bindNullifier = pool.nullifier(c0.cx, c0.cy);

const burn = ct.buildBridgeBurn({
  inputs: btcInputs,
  outputs: [{ value: mintValue, blinding: mintBlinding, owner: OWNER_ETH }],
  assetId: ASSET, destChain: ETHEREUM, bindNullifier,
});
assert.ok(ct.verifyBridgeBurn(burn), 'Bitcoin-side burn verifies (conservation + range + claim binding)');
const crossOut = burn.crossOuts[0];
ok('Bitcoin burns 1500 of confidential value with an Ethereum destination (conserved)');

// destCommitment IS the Ethereum leaf the mint will insert — carried verbatim.
const ethLeaf = crossOut.destCommitment;
assert.strictEqual(ethLeaf, pool.leaf(ASSET, crossOut.cx, crossOut.cy, OWNER_ETH), 'destCommitment == Ethereum leaf');
ok('the crossOut destCommitment is exactly the Ethereum leaf to mint (value commitment carried, no re-commit)');

// ── 2. claimId binds the mint to this burn; both sides derive it identically ──
const claimId = ct.claimId(ETHEREUM, ethLeaf, bindNullifier, ASSET);
assert.strictEqual(claimId, crossOut.claimId, 'claimId matches the burn-side derivation');
assert.strictEqual(crossOut.nullifier, pool.nullifier(c0.cx, c0.cy), 'burn ν is note-bound (B3), guest-matching');
ok('claimId binds (destChain=ETH, ethLeaf, burn ν, asset) — one mintable destination, non-malleable');

// ── 3. Ethereum bridge_mint: insert the leaf + a memo sealed to the recipient ──
// (The guest verifies the Bitcoin burn, marks bitcoinBurnsConsumed[claimId], and
//  inserts ethLeaf. Here we model the resulting on-chain event stream.)
const mintedNote = { value: mintValue, blinding: mintBlinding, secret: mintSecret, asset: ASSET, owner: OWNER_ETH };
const sealed = memo.encodeMemo(memo.sealMemo(rPub, mintedNote, randomScalar));
const events = [
  { type: 'LeavesInserted', firstLeafIndex: 0, leaves: [ethLeaf], memos: [sealed] },
  // no NullifiersSpent on Ethereum: the burn's ν lives in Bitcoin's set
];

// ── 4. recipient recovers the minted note from the event stream + seed alone ──
const recovered = idx.recover(events, rPriv);
assert.strictEqual(recovered.length, 1, 'recipient recovers exactly the minted note');
const r = recovered[0];
assert.strictEqual(r.value, mintValue, 'minted value == burned value (conserved)');
assert.strictEqual(r.secret, mintSecret, 'minted note secret recovered (spendable on Ethereum)');
assert.strictEqual(r.leaf, ethLeaf, 'recovered the cross-minted leaf');
assert.ok(pool.verifyPath(r.leaf, r.leafIndex, r.path, r.root), 'minted note has a spendable membership path');
ok('Ethereum recipient recovers the cross-minted note from chain + seed (byte-identical to a native note)');

// ── 5. conservation is total: the only way to mint more would be a second claim ──
// (the contract's bridgeMinted gates that; see Forge test_bridge_mint_double_claim_reverts)
assert.strictEqual(btcInputs.reduce((s, i) => s + i.value, 0n), r.value, 'Σ burned on Bitcoin == minted on Ethereum');
ok('total conservation: Σ value burned on Bitcoin equals the value minted on Ethereum');

console.log(`\n${n}/5 confidential-bridge-mint checks passed`);
