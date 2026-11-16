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

// the Send picker offers a bridged token held at the wallet's Bitcoin address, on the front page as on /spx/
const sl = html.slice(html.indexOf('const xtSends = '), html.indexOf('const xtDec = '));
ok(sl.length > 50, 'xtSends found in the page');
const ADDR_SPX = '0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c', ADDR_X = '0x1111111111111111111111111111111111111111';
const XT = { by: new Map([[ADDR_SPX, { addr: ADDR_SPX, sym: 'SPX', tdec: 8, bridge: { hex: SPX } }], [ADDR_X, { addr: ADDR_X, sym: 'XX', tdec: 18, bridge: { hex: 'ab'.repeat(32) } }]]) };
const sends = (SPXP, held) => new Function('XT', 'SPXP', 'SPX_A', 'BTC', 'xtIco', `${sl}; return xtSends();`)(XT, SPXP, ADDR_SPX, { held }, () => '').map(([k]) => k);
ok(sends(false, [{ id: SPX }]).join() === `xb${ADDR_SPX}`, 'front page: SPX held on Bitcoin is in the Send picker, a token not held is not');
ok(sends(false, []).length === 0, 'front page: nothing held on Bitcoin, no Bitcoin entries');
ok(sends(true, []).join() === `xb${ADDR_SPX}`, '/spx/: SPX on Bitcoin is always offered');
// the Send tab reads the wallet's Bitcoin address itself (no Bitcoin coin need be picked first) and paints again when that adds an entry
const sendTab = html.slice(html.indexOf("if (m === 'send') {"), html.indexOf("if (sa) sa.onchange"));
ok(/BTC\.pub !== S\.key\.pubHex/.test(sendTab) && /loadBtc\(\)\.then\(\(\) => \{ if \(HX\.tab === 'send' && xbs\(\) !== was\) paintHx\(\)/.test(sendTab), 'the Send tab reads the Bitcoin address once per key and repaints when a Bitcoin entry appears');

console.log(`\n${n} bound-send-route checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
