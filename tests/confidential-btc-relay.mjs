#!/usr/bin/env node
// Validates the Bitcoin-state relay (dapp/confidential-btc-relay.js) — the
// submission toolkit for the trustless attestBitcoinStateProven path. Six things:
//   1. the relay computes the SAME Bitcoin pool root the guest verified membership
//      against (read from the real bridge_mint witness) — so attesting it makes
//      that exact mint settle; a mismatch would mean the gate rejects honest mints
//   1b. the relay computes the spent-set IMT root + a non-zero empty sentinel,
//      matching cxfer-core::imt_root / imt_empty_root (the cross-lane spent root)
//   2. BitcoinRelayPublicValues{poolRoot, spentRoot, height} encodes to the exact
//      struct layout ConfidentialPool.abi.decode expects, and round-trips
//   3. the spent root can NEVER be zero (the cross-lane invariant) — encoding 0 throws
//   4. attestBitcoinStateProven(bytes,bytes) calldata round-trips publicValues + proof
//   5. the operator can sign the attestation from a Tacit seed (no MetaMask): the
//      signed tx recovers to the operator's derived EVM address
//
// Run: node tests/confidential-btc-relay.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));

import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialMemo } from '../dapp/confidential-memo.js';
import { makeBtcRelay } from '../dapp/confidential-btc-relay.js';
import { makeEvmAccount } from '../dapp/evm-account.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const deps = { secp, keccak256, sha256 };
const pool = makeConfidentialPool(deps);
const memo = makeConfidentialMemo({ secp, sha256, keccak256 });
const relay = makeBtcRelay(deps);
const acct = makeEvmAccount({ secp, keccak256, sha256 });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const beBig = (b) => (b.length ? BigInt('0x' + Buffer.from(b).toString('hex')) : 0n);

// ── 1. relay computes the SAME root the guest verified membership against ──
const wit = JSON.parse(readFileSync(new URL('../contracts/sp1/confidential/fixtures/bridgemint_op.json', import.meta.url)));
const inLeaf = pool.leaf(wit.asset, wit.input.cx, wit.input.cy, wit.input.owner);
const relayRoot = relay.computeRoot([inLeaf]);
assert.strictEqual(relayRoot, wit.poolRoot, 'relay root == witness Bitcoin pool root');
ok('relay computes the exact Bitcoin pool root the bridge_mint guest proved membership against');

// ── 1b. relay computes the spent-set IMT root + the non-zero empty sentinel ──
const imt = JSON.parse(readFileSync(new URL('../contracts/sp1/confidential/fixtures/imt.json', import.meta.url)));
assert.strictEqual(relay.computeSpentRoot(imt.links), imt.root, 'relay spent-set root == IMT fixture root');
const SENTINEL = relay.emptySpentRoot();
assert.strictEqual(SENTINEL, imt.emptyRoot, 'empty sentinel == IMT fixture emptyRoot (matches cxfer-core)');
assert.notStrictEqual(SENTINEL, '0x' + '00'.repeat(32), 'empty sentinel is non-zero');
ok('relay computes the spent-set IMT root + a non-zero empty sentinel (cxfer-core parity)');

// ── 2. BitcoinRelayPublicValues encode + round-trip ──
const pv = relay.encodeRelayPublicValues({ poolRoot: relayRoot, spentRoot: SENTINEL, height: 850000n });
assert.strictEqual(hexToBytes(pv).length, 96, 'publicValues = 3 static words (poolRoot, spentRoot, height)');
const dec = relay.decodeRelayPublicValues(pv);
assert.strictEqual(dec.poolRoot, relayRoot, 'decoded poolRoot');
assert.strictEqual(dec.spentRoot, SENTINEL, 'decoded spentRoot');
assert.strictEqual(dec.height, 850000n, 'decoded height');
ok('BitcoinRelayPublicValues encodes to the contract struct layout and round-trips');

// ── 3. the spent root can never be zero (cross-lane invariant, matches the contract) ──
assert.throws(() => relay.encodeRelayPublicValues({ poolRoot: relayRoot, spentRoot: '0x' + '00'.repeat(32), height: 1n }), /non-zero/, 'zero spent root rejected');
ok('encodeRelayPublicValues refuses a zero spent root (the cross-lane bypass guard)');

// ── 4. attestBitcoinStateProven(bytes,bytes) calldata round-trips pv + proof ──
assert.strictEqual(relay.SELECTOR, '0x' + Buffer.from(keccak_256(new TextEncoder().encode('attestBitcoinStateProven(bytes,bytes)'))).slice(0, 4).toString('hex'), 'selector');
const PROOF = '0x' + 'ab'.repeat(260); // mock reflection proof (length not a multiple of 32 → tests padding)
const cd = relay.attestCalldata(pv, PROOF);
assert.strictEqual(cd.slice(0, 10), relay.SELECTOR, 'selector prefix');
function decodeTwoBytes(cdHex) {
  const b = hexToBytes('0x' + cdHex.slice(10));
  const rd = (o) => Number(beBig(b.slice(o, o + 32)));
  const offA = rd(0), offB = rd(32);
  const a = b.slice(offA + 32, offA + 32 + rd(offA));
  const c = b.slice(offB + 32, offB + 32 + rd(offB));
  return ['0x' + Buffer.from(a).toString('hex'), '0x' + Buffer.from(c).toString('hex')];
}
const [gotPv, gotProof] = decodeTwoBytes(cd);
assert.strictEqual(gotPv, pv, 'publicValues round-trips through calldata');
assert.strictEqual(gotProof, PROOF, 'proofBytes round-trips through calldata');
ok('attestBitcoinStateProven calldata ABI-encodes (publicValues, proofBytes)');

// ── 5. operator signs the attestation from a Tacit seed (no MetaMask) ──
const op = acct.deriveEvmAccount('0x' + '42'.repeat(32), 'mainnet');
const POOL = '0x' + 'cc'.repeat(20);
const { raw, hash } = relay.buildAttestTx(op.priv, POOL, pv, PROOF, {
  chainId: 11155111n, nonce: 7n, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 30_000_000_000n, gasLimit: 120_000n,
});
// minimal RLP decode of the signed type-2 body to recover sender + check fields
function decode(b, i) {
  const p = b[i];
  if (p < 0x80) return [b.slice(i, i + 1), i + 1];
  if (p < 0xb8) { const len = p - 0x80; return [b.slice(i + 1, i + 1 + len), i + 1 + len]; }
  if (p < 0xc0) { const ll = p - 0xb7; const len = Number(beBig(b.slice(i + 1, i + 1 + ll))); const s = i + 1 + ll; return [b.slice(s, s + len), s + len]; }
  let len, start;
  if (p < 0xf8) { len = p - 0xc0; start = i + 1; } else { const ll = p - 0xf7; len = Number(beBig(b.slice(i + 1, i + 1 + ll))); start = i + 1 + ll; }
  const end = start + len; const items = []; let j = start;
  while (j < end) { const [it, nj] = decode(b, j); items.push(it); j = nj; }
  return [items, end];
}
const f = decode(hexToBytes(raw).slice(1), 0)[0];
assert.strictEqual('0x' + Buffer.from(f[5]).toString('hex'), POOL, 'to == ConfidentialPool');
assert.strictEqual('0x' + Buffer.from(f[7]).toString('hex'), cd, 'data == attest calldata');
const sig = new secp.Signature(beBig(f[10]), beBig(f[11]), Number(beBig(f[9])));
const pub = sig.recoverPublicKey(hexToBytes(hash)).toRawBytes(false);
const sender = '0x' + Buffer.from(keccak_256(pub.slice(1)).slice(12)).toString('hex');
assert.strictEqual(sender, op.address, 'attestation recovers to the operator address');
ok('operator signs attestBitcoinStateProven from a Tacit seed; tx recovers to the operator EVM address');

console.log(`\n${n}/6 confidential-btc-relay checks passed`);
