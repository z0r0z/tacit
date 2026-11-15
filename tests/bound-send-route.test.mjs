// The front page's Bitcoin send route for a token bridged from Ethereum: such a token moves by a transfer bound to the pool, which pays a
// key the receiver's wallet reads, so a tacit1 address resolves to its Bitcoin spend key (never a stealth address), a shielded tcs1
// address is refused with a reason, and TAC keeps its stealth route.
import { readFileSync } from 'node:fs';
import { secp, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { makeTacitAddress } from '../dapp/tacit-address.js';

let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };

const html = readFileSync(new URL('../dapp/index.html', import.meta.url), 'utf8');
const src = html.slice(html.indexOf('async function btcRoute('), html.indexOf('const btcRouteM = memoRoute(btcRoute);'));
ok(src.length > 200, 'btcRoute found in the page');

const { encodeTacitAddress, decodeTacitAddress } = makeTacitAddress({ secp });
const SPX = '45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48', TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const priv = hexToBytes('11'.repeat(32)), spendPub = secp.getPublicKey(priv, true), scanPub = secp.getPublicKey(hexToBytes('22'.repeat(32)), true);
const addr = encodeTacitAddress({ network: 'mainnet', btcSpendPub: spendPub, btcScanPub: scanPub, evmOwnerPub: spendPub });
const t = {
  boundAssetTicker: (id) => (String(id).replace(/^0x/, '') === SPX ? 'SPX' : null),
  encodeStealthAddress: ({ recipientPub }) => 'tcs1stealth' + bytesToHex(recipientPub).slice(0, 8),
  encodeSilentPaymentAddress: () => 'sp1x',
  decodeSilentPaymentAddress: () => null, decodeP2wpkhAddress: () => null, decodeP2trAddress: () => null,
  parseRecipientInput: (s) => (/^tcs1/.test(s) ? { kind: 'stealth', stealthAddress: s } : { kind: 'error', message: 'unknown' }),
};
const btcRoute = new Function('getNames', 'loadTacit', 'short', 'decodeTacitAddress', 'bytesToHex', `return (${src.trim()});`)(
  async () => ({}), async () => t, (s) => s.slice(0, 10), decodeTacitAddress, bytesToHex);

const spx = { id: '0x' + SPX, ticker: 'SPX' }, tac = { id: TAC, ticker: 'TAC' };
const r1 = await btcRoute(addr, spx);
ok(r1.kind === 'pubkey' && r1.pubHex === bytesToHex(spendPub), 'SPX to a tacit1 address pays its Bitcoin spend key');
const r2 = await btcRoute(addr, tac);
ok(r2.kind === 'stealth', 'TAC to a tacit1 address keeps its stealth route');
const r3 = await btcRoute(addr, null);
ok(r3.kind === 'sp', 'BTC to a tacit1 address is a silent payment');
let msg = '';
try { await btcRoute('tcs1abcdef', spx); } catch (e) { msg = e.message; }
ok(/SPX on Bitcoin goes to a Tacit address/.test(msg), `SPX to a shielded tcs1 address is refused with a reason (${msg})`);
const r5 = await btcRoute('tcs1abcdef', tac);
ok(r5.kind === 'stealth', 'TAC to a tcs1 address still goes');

console.log(`\n${n} bound-send-route checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
