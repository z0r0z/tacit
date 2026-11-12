// The page's side of the buyer opening: the blob it publishes is signed with the buyer's key over the one shared message (so the API can tell the owner's write
// from anyone else's), and a transaction the API cannot see yet (a 503) is tried again, while any other refusal is not.
//   node tests/buyer-opening-client.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../dapp/tacit.js', import.meta.url), 'utf8');
const a = src.indexOf('async function publishBuyerOpening('), b = src.indexOf('\nasync function fetchBuyerOpening(', a);
const fn = src.slice(a, b);
let n = 0; const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };

ok(/import \{ buyerOpeningMsg \} from '\.\/buyer-opening-msg\.js';/.test(src), 'the page takes the signed message from the module the API uses');
ok(a > 0 && b > a, 'the publish function is found');
ok(/signSchnorr\(buyerOpeningMsg\(NET\.name, txidHex, vout, ciphertext, declared\), wallet\.priv\)/.test(fn), 'it signs the message for this network, output, blob and key with the wallet key');
ok(/declared_pubkey: declared,\s*ciphertext,\s*sig:/.test(fn), 'and sends the signature with the key and the blob');
ok(/const declared = bytesToHex\(wallet\.pub\)/.test(fn), 'the key it declares is the wallet key the buyer\'s output pays');
ok(/for \(const wait of \[0, 4000, 12000, 30000, 60000\]\)/.test(fn) && /if \(r\.status !== 503\) return false;/.test(fn), 'a 503 is retried after a growing wait, and any other refusal ends it');
ok((fn.match(/fetch\(/g) || []).length === 1 && /JSON\.stringify\(\{/.test(fn) && fn.indexOf('JSON.stringify') < fn.indexOf('for (const wait'), 'the body is built once, so a retry sends the same signed blob');
ok(/buyer-opening\?network=\$\{encodeURIComponent\(NET\.name\)\}/.test(fn), 'the network it names in the address is the one it signed for');
console.log(`all ${n} ok`);
