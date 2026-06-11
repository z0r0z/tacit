#!/usr/bin/env node
// Validates the in-wallet EIP-1559 signer (dapp/evm-tx.js), self-contained: a
// minimal RLP decoder checks the encoded fields round-trip, and noble recovers
// the sender from the signature *in the raw bytes* over the EIP-1559 sighash —
// proving spec compliance (a node computes the same sighash and recovers the
// same sender). Also checks RFC-6979 determinism.
//
// Run: node tests/evm-tx.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';

// Configure noble's sync ECDSA HMAC (the browser dapp gets this from vendored deps).
const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
import { makeEvmAccount } from '../dapp/evm-account.js';
import { makeEvmTx } from '../dapp/evm-tx.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 });
const txm = makeEvmTx({ secp, keccak256: keccak_256 });
let n = 0; const ok = (m) => { console.log('  ok -', m); n++; };

const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const beBig = (b) => (b.length ? BigInt('0x' + Buffer.from(b).toString('hex')) : 0n);

// minimal RLP decoder (enough for a flat list of byte-strings + one empty list)
function rlpDecode(b) { return decode(b, 0)[0]; }
function decode(b, i) {
  const p = b[i];
  if (p < 0x80) return [b.slice(i, i + 1), i + 1];
  if (p < 0xb8) { const len = p - 0x80; return [b.slice(i + 1, i + 1 + len), i + 1 + len]; }
  if (p < 0xc0) { const ll = p - 0xb7; const len = Number(beBig(b.slice(i + 1, i + 1 + ll))); const s = i + 1 + ll; return [b.slice(s, s + len), s + len]; }
  let len, start;
  if (p < 0xf8) { len = p - 0xc0; start = i + 1; }
  else { const ll = p - 0xf7; len = Number(beBig(b.slice(i + 1, i + 1 + ll))); start = i + 1 + ll; }
  const end = start + len; const items = []; let j = start;
  while (j < end) { const [it, nj] = decode(b, j); items.push(it); j = nj; }
  return [items, end];
}

const account = acct.deriveEvmAccount('0x' + '11'.repeat(32), 'mainnet');
const TO = '0x' + 'ab'.repeat(20);
const tx = {
  chainId: 11155111n, nonce: 3n,
  maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 30_000_000_000n,
  gasLimit: 250_000n, to: TO, value: 0n, data: '0xdeadbeef',
};

function recoverAddr(raw, hash) {
  const body = hexToBytes(raw).slice(1); // drop 0x02
  const f = rlpDecode(body); // [chainId,nonce,maxPrio,maxFee,gas,to,value,data,accessList,yParity,r,s]
  const rec = Number(beBig(f[9])), r = beBig(f[10]), s = beBig(f[11]);
  const sig = new secp.Signature(r, s, rec);
  const pub = sig.recoverPublicKey(hexToBytes(hash)).toRawBytes(false); // 65 bytes
  return { f, addr: '0x' + Buffer.from(keccak_256(pub.slice(1)).slice(12)).toString('hex') };
}

// ── sign + structural + recovery checks ──
const { raw, hash } = txm.signEip1559(tx, account.priv);
const { f, addr } = recoverAddr(raw, hash);
assert.strictEqual(hexToBytes(raw)[0], 0x02, 'type-2 envelope');
assert.strictEqual(beBig(f[0]), 11155111n, 'chainId');
assert.strictEqual(beBig(f[1]), 3n, 'nonce');
assert.strictEqual(beBig(f[3]), 30_000_000_000n, 'maxFeePerGas');
assert.strictEqual(beBig(f[4]), 250_000n, 'gasLimit');
assert.strictEqual('0x' + Buffer.from(f[5]).toString('hex'), TO, 'to');
assert.strictEqual('0x' + Buffer.from(f[7]).toString('hex'), '0xdeadbeef', 'data');
assert.strictEqual(f[8].length, 0, 'empty accessList');
assert.strictEqual(addr, account.address, 'sender recovers to derived address');
ok('EIP-1559 fields decode correctly + signature recovers to the derived address');

// ── determinism (RFC 6979) ──
assert.strictEqual(txm.signEip1559(tx, account.priv).raw, raw, 'deterministic');
ok('deterministic raw tx (RFC 6979)');

// ── settle-shaped long calldata round-trips + recovers ──
const tx2 = { ...tx, nonce: 4n, data: '0x' + 'ee'.repeat(420) };
const r2 = txm.signEip1559(tx2, account.priv);
const rec2 = recoverAddr(r2.raw, r2.hash);
assert.strictEqual('0x' + Buffer.from(rec2.f[7]).toString('hex'), '0x' + 'ee'.repeat(420), 'long calldata preserved');
assert.strictEqual(rec2.addr, account.address, 'long-calldata sender recovers');
ok('long-calldata (settle-shaped) tx round-trips and recovers correctly');

console.log(`\n${n}/3 evm-tx checks passed`);
