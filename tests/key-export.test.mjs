#!/usr/bin/env node
// dapp/key-export.js: a Tacit key as a Bitcoin WIF, against published vectors, and against the address the wallet itself derives
// (tacit.js: p2wpkhAddress = bech32 v0 of hash160 of the compressed public key), plus the Ethereum key evm-account.js derives.
import { secp, sha256, ripemd160, bech32, keccak_256, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { wifFromPriv, privFromWif } from '../dapp/key-export.js';
import { makeEvmAccount } from '../dapp/evm-account.js';

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const hash160 = (b) => ripemd160(sha256(b));
const p2wpkh = (priv, hrp = 'bc') => bech32.encode(hrp, [0, ...bech32.toWords(hash160(secp.getPublicKey(hexToBytes(priv), true)))]);
const ONE = '00'.repeat(31) + '01';

// the well-known vectors for the key 1: its compressed WIF and its native segwit address
ok(wifFromPriv(ONE) === 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn', 'the key 1 makes the well-known compressed WIF');
ok(p2wpkh(ONE) === 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'and that key is the one behind the well-known bc1q address');
ok(wifFromPriv('0x' + ONE.toUpperCase()) === wifFromPriv(ONE), 'a 0x prefix and capitals make the same WIF');
ok(wifFromPriv(hexToBytes(ONE)) === wifFromPriv(ONE), 'bytes make the same WIF as hex');
ok(wifFromPriv(ONE, { testnet: true }).startsWith('c'), 'a test network key starts with c');

// a spread of keys: every WIF reads back to its key, compressed, and a changed character is refused
let round = true, refused = true;
for (let i = 0; i < 200; i++) {
  const k = bytesToHex(secp.utils.randomPrivateKey()), w = wifFromPriv(k);
  round &&= bytesToHex(privFromWif(w)) === k && /^[KL][1-9A-HJ-NP-Za-km-z]{51}$/.test(w);
  const at = 1 + (i % 50), swap = w[at] === 'z' ? 'y' : 'z';
  try { privFromWif(w.slice(0, at) + swap + w.slice(at + 1)); refused = false; } catch { }
}
ok(round, '200 random keys: each WIF is 52 characters starting K or L, and reads back to its key');
ok(refused, '200 altered WIFs are each refused by the check');
for (const bad of ['', '0x' + ONE, 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWm']) {
  let threw = false; try { privFromWif(bad); } catch { threw = true; }
  ok(threw, `a bad WIF is refused: ${bad.slice(0, 18) || '(empty)'}`);
}
for (const bad of ['', '12', '00'.repeat(33)]) {
  let threw = false; try { wifFromPriv(bad); } catch { threw = true; }
  ok(threw, `a key that is not 32 bytes is refused: ${bad.slice(0, 12) || '(empty)'}`);
}

// the Ethereum side: the derived key opens the derived address, and differs from the Tacit key (so pasting the Tacit key elsewhere would not)
const evm = makeEvmAccount({ secp, keccak256: keccak_256, sha256 });
const tacit = bytesToHex(sha256(new TextEncoder().encode('a tacit key for the test')));
const acct = evm.deriveEvmAccount(hexToBytes(tacit), 'mainnet');
ok(/^0x[0-9a-f]{64}$/.test(acct.priv) && acct.priv.slice(2) !== tacit, 'the Ethereum key is 0x and 64 hex characters, and is not the Tacit key');
ok(evm.addressFromPriv(hexToBytes(acct.priv.slice(2))) === acct.address, 'and it opens the address the wallet shows');
ok(evm.addressFromPriv(hexToBytes(tacit)) !== acct.address, 'while the Tacit key itself would open a different Ethereum address');

console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
