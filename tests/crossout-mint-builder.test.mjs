// tools/build-crossout-mint.mjs: the transactions it builds must pay the right places.
//
// A cross-out mint has two outputs that fail SILENTLY if they are wrong:
//   - the reveal's vout 0 must be P2TR of the destination key named at burn (otherwise the guest folds nothing);
//   - the commit's change must pay the WALLET's own P2WPKH (otherwise the sats go to an address no key controls).
// The change script was once built by passing an already-hashed value into p2wpkhScript(pubkey), which hashes again,
// so every change output went to hash160(hash160(pubkey)). This test runs the real builder with a throwaway key and
// parses the serialized transactions.
//
// Run: node tests/crossout-mint-builder.test.mjs   (offline: FEE_RATE is pinned, nothing is fetched or broadcast)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bytesToHex } from '@noble/hashes/utils';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'crossout-mint-'));
let pass = 0;
const ok = (n) => { console.log('  PASS  ' + n); pass++; };

// minimal segwit tx reader: returns the outputs [{ value, script }]
function outputsOf(hex) {
  const b = Buffer.from(hex, 'hex'); let p = 4;
  if (b[p] === 0x00 && b[p + 1] === 0x01) p += 2;
  const varint = () => { const v = b[p++]; if (v < 0xfd) return v; if (v === 0xfd) { const n = b.readUInt16LE(p); p += 2; return n; } throw new Error('varint too large for this test'); };
  const nin = varint();
  for (let i = 0; i < nin; i++) { p += 36; const sl = varint(); p += sl + 4; }
  const nout = varint(); const outs = [];
  for (let i = 0; i < nout; i++) { const value = Number(b.readBigUInt64LE(p)); p += 8; const sl = varint(); outs.push({ value, script: b.subarray(p, p + sl).toString('hex') }); p += sl; }
  return outs;
}

try {
  const priv = secp.utils.randomPrivateKey();
  const pub = secp.getPublicKey(priv, true);
  const wallet = path.join(tmp, 'wallet.json');
  writeFileSync(wallet, JSON.stringify({ priv_hex: '0x' + bytesToHex(priv) }), { mode: 0o600 });
  const destPriv = secp.utils.randomPrivateKey();
  const destX = bytesToHex(secp.getPublicKey(destPriv, true).slice(1));
  const out = path.join(tmp, 'txs.json');
  const word = (n) => '0x' + n.toString(16).padStart(64, '0');
  const r = spawnSync('node', [path.join(ROOT, 'tools/build-crossout-mint.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, WALLET_JSON: wallet, CLAIM_ID: word(0xabc123n), CX: word(0x1111n), CY: word(0x2222n), DEST_XONLY: '0x' + destX,
      FEE_TXID: 'aa'.repeat(32), FEE_VOUT: '1', FEE_VALUE: '5000', FEE_RATE: '2', OUT_FILE: out },
  });
  assert.equal(r.status, 0, 'the builder exits cleanly on its own (status ' + r.status + ', ' + (r.signal || '') + ')\n' + r.stderr);
  ok('the builder finishes and exits by itself');
  const t = JSON.parse(readFileSync(out, 'utf8'));

  const wantChange = '0014' + bytesToHex(ripemd160(sha256(pub)));
  const commitOuts = outputsOf(t.commitHex);
  assert.equal(commitOuts.length, 2, 'commit has the envelope output and a change output');
  assert.equal(commitOuts[1].script, wantChange, 'commit change pays the wallet own P2WPKH');
  assert.ok(commitOuts[1].value > 4000 && commitOuts[1].value < 5000, 'change is the fee coin minus the commit value and fee');
  ok('the commit change pays the wallet P2WPKH (hash160 of its own public key)');

  const doubleHashed = '0014' + bytesToHex(ripemd160(sha256(ripemd160(sha256(pub)))));
  assert.notEqual(commitOuts[1].script, doubleHashed);
  ok('and is not the double-hashed address the old builder used');

  const revealOuts = outputsOf(t.revealHex);
  assert.equal(revealOuts.length, 1, 'reveal has exactly one output');
  assert.equal(revealOuts[0].script, '5120' + destX, 'reveal vout 0 is P2TR of the destination key');
  assert.equal(revealOuts[0].value, 330);
  ok('the reveal has one 330-sat output paying P2TR of the destination key');
} finally { rmSync(tmp, { recursive: true, force: true }); }

console.log(`\n${pass} passed`);
