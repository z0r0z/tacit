#!/usr/bin/env node
// ABI-layout parity for the Create→Asset factory calldata (dapp/confidential-factory-tab.js
// etchCanonicalCalldata). The tab imports the browser vendor bundle, so this test re-implements the same
// encoder and pins the wire format: correct 4-byte selector, the single dynamic `string` at head offset
// 0xc0, and a round-trippable (symbol, decimals) payload for
//   etchCanonical(address etcher, bytes32 salt, address minter, string symbol_, uint8 decimals_, bytes32 cid)
//
// Run: node tests/confidential-factory-calldata.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import assert from 'node:assert';

const _hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const _word = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const _addrWord = (a) => _word(String(a).replace(/^0x/, '').padStart(40, '0'));
const _selector = (sig) => _hex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);

function etchCanonicalCalldata({ etcher, salt, minter, symbol, decimals, cid }) {
  const sym = new TextEncoder().encode(String(symbol));
  const symHex = _hex(sym);
  const padded = symHex + '0'.repeat((64 - (symHex.length % 64)) % 64);
  const headWords = 6;
  const strOffset = headWords * 32;
  const head = _addrWord(etcher) + _word(salt) + _addrWord(minter) + _word(BigInt(strOffset).toString(16))
    + _word(BigInt(decimals).toString(16)) + _word(cid || ('0x' + '00'.repeat(32)));
  const tail = _word(BigInt(sym.length).toString(16)) + padded;
  return '0x' + _selector('etchCanonical(address,bytes32,address,string,uint8,bytes32)') + head + tail;
}

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const etcher = '0x' + '11'.repeat(20);
const minter = '0x' + '22'.repeat(20);
const salt = '0x' + '33'.repeat(32);
const cd = etchCanonicalCalldata({ etcher, salt, minter, symbol: 'MYA', decimals: 8, cid: null });
const body = cd.slice(10); // strip 0x + 4-byte selector

// selector matches the canonical signature
assert.equal(cd.slice(2, 10), _selector('etchCanonical(address,bytes32,address,string,uint8,bytes32)'), 'selector');
ok('selector == keccak(signature)[:4]');

// head words
const wordAt = (i) => body.slice(i * 64, i * 64 + 64);
assert.equal(wordAt(0), _addrWord(etcher), 'etcher');
assert.equal(wordAt(1), _word(salt), 'salt');
assert.equal(wordAt(2), _addrWord(minter), 'minter');
assert.equal(BigInt('0x' + wordAt(3)), 0xc0n, 'string head offset = 0xc0 (6 head words)');
assert.equal(BigInt('0x' + wordAt(4)), 8n, 'decimals');
assert.equal(wordAt(5), _word('0x' + '00'.repeat(32)), 'cid = 0');
ok('head layout: etcher, salt, minter, strOffset=0xc0, decimals, cid');

// dynamic string tail: length then right-padded utf8
assert.equal(BigInt('0x' + wordAt(6)), 3n, 'string length = 3 (MYA)');
assert.equal(wordAt(7).slice(0, 6), _hex(new TextEncoder().encode('MYA')), 'utf8 "MYA" left-aligned');
assert.equal(wordAt(7).slice(6), '0'.repeat(58), 'right-padded to a full word');
ok('string tail: length word + right-padded utf8');

console.log(`\n${n}/3 factory calldata checks passed`);
