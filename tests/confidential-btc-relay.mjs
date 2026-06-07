#!/usr/bin/env node
// Validates the Bitcoin-root relay (dapp/confidential-btc-relay.js) — the trust
// root for bridge_mint. Three things:
//   1. the relay computes the SAME Bitcoin pool root the guest verified membership
//      against (read from the real bridge_mint witness) — so attesting it makes
//      that exact mint settle; a mismatch would mean the gate rejects honest mints
//   2. attestBitcoinRoot calldata is correctly ABI-encoded (selector + root)
//   3. the operator can sign the attestation from a Tacit seed (no MetaMask): the
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

// ── 2. attestBitcoinRoot calldata ──
assert.strictEqual(relay.SELECTOR, '0x' + Buffer.from(keccak_256(new TextEncoder().encode('attestBitcoinRoot(bytes32)'))).slice(0, 4).toString('hex'), 'selector');
const cd = relay.attestCalldata(relayRoot);
assert.strictEqual(hexToBytes(cd).length, 36, 'calldata = 4-byte selector + 32-byte root');
assert.strictEqual(cd.slice(0, 10), relay.SELECTOR, 'selector prefix');
assert.strictEqual('0x' + cd.slice(10), relayRoot, 'root packed into calldata');
ok('attestBitcoinRoot calldata = selector ‖ root (ABI-encoded)');

// ── 3. operator signs the attestation from a Tacit seed (no MetaMask) ──
const op = acct.deriveEvmAccount('0x' + '42'.repeat(32), 'mainnet');
const POOL = '0x' + 'cc'.repeat(20);
const { raw, hash } = relay.buildAttestTx(op.priv, POOL, relayRoot, {
  chainId: 11155111n, nonce: 7n, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 30_000_000_000n, gasLimit: 80_000n,
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
ok('operator signs attestBitcoinRoot from a Tacit seed; tx recovers to the operator EVM address');

console.log(`\n${n}/3 confidential-btc-relay checks passed`);
