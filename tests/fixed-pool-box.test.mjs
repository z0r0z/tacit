// dapp/fixed-pool-box.js and the deposit-address record of dapp/confidential-names.js: a name's deposit address is checked
// against the pool address the name points to before anything is paid to it.
//
// Run: node tests/fixed-pool-box.test.mjs

import { register } from 'node:module';
// the page's modules import each other by site path ("/x.js?cb="); this maps those to dapp/
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));

import { keccak_256, secp, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
const B = await import('../dapp/fixed-pool-box.js');
const { makeConfidentialNames, parseBoxRecord, BOX_KEY, RECORD_KEY, NameError } = await import('../dapp/confidential-names.js');
const { makeTacitAddress, poolAddressOf } = await import('../dapp/tacit-address.js');
const { receiveBoxAddress, RECEIVE_FEE_BPS, EVM_POOL_ROUTER } = await import('../dapp/evm-pool-gateway.js');

let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`); };
const rejects = async (p, code) => {
  try { await p; } catch (e) { if (e.code !== code) throw new Error(`wrong error (${e.code}): ${e.message}`); return e; }
  throw new Error('did not throw');
};

// a payee: a view scalar, the pool address that carries its view key, and a box key
const V_SCALAR = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn;
const keys97 = (vScalar) => { const k = new Uint8Array(97); k.set(secp.getPublicKey(hexToBytes(vScalar.toString(16).padStart(64, '0')), true), 0); k.fill(7, 33); return k; };
const POOL = poolAddressOf(keys97(V_SCALAR));
const OTHER_POOL = poolAddressOf(keys97(0x0badc0ffee0badc0ffee0badc0ffee0badc0ffee0badc0ffee0badc0ffee0bn));
const N = 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefn % (21888242871839275222246405745257275088548364400416034343698204186575808495617n);
const hex64 = (x) => x.toString(16).padStart(64, '0');
const sigOf = (v, n) => B.signBox(v, n);

console.log('signature');
await test('a box key signed by the view key checks against the pool address, and nothing else does', async () => {
  const ns = await sigOf(V_SCALAR, N);
  eq(ns.length, 128, 'compact signature');
  const V = hexToBytes(bytesToHex(keys97(V_SCALAR).slice(0, 33)));
  eq(B.boxSigOk(V, hex64(N), ns), true, 'the owner');
  eq(B.boxSigOk(V, hex64(N + 1n), ns), false, 'another box key');
  eq(B.boxSigOk(keys97(0x0badc0ffee0badc0ffee0badc0ffee0badc0ffee0badc0ffee0badc0ffee0bn).slice(0, 33), hex64(N), ns), false, 'another owner');
  eq(B.boxSigOk(V, hex64(N), ns.slice(0, 126) + '00'), false, 'a damaged signature');
  eq(B.boxSigOk(V, hex64(N), 'zz'), false, 'junk');
});
await test('the digest is what the Pay page signs for a payment link: keccak256("tacit-pay-box-v1" || be32(n))', () => {
  const want = bytesToHex(keccak_256(Uint8Array.from([...new TextEncoder().encode('tacit-pay-box-v1'), ...hexToBytes(hex64(N))])));
  eq(bytesToHex(B.boxDigest(N)), want);
});

console.log('the record');
await test('the record is "<64 hex>:<128 hex>"; anything else is refused', async () => {
  const ns = await sigOf(V_SCALAR, N);
  const text = B.boxValue(N, ns);
  eq(text, `${hex64(N)}:${ns}`);
  const p = parseBoxRecord(text.toUpperCase());
  eq(p.n, hex64(N)); eq(p.ns, ns);
  for (const bad of ['', 'hello', hex64(N), `${hex64(N)}:${ns.slice(2)}`, `0x${hex64(N)}:${ns}`, `${hex64(N)}:${ns}:x`]) {
    let threw = false; try { parseBoxRecord(bad); } catch (e) { threw = e instanceof NameError; }
    if (!threw) throw new Error('accepted ' + JSON.stringify(bad.slice(0, 20)));
  }
});

console.log('a name\'s deposit address');
const stub = (over = {}) => ({ resolveName: async (n) => ({ name: n, pool: POOL }), readBox: async () => null, ...over });
await test('a name with a published, signed record gives the router\'s box for that key', async () => {
  const ns = await sigOf(V_SCALAR, N);
  const r = await B.depositAddressOfName(stub({ readBox: async () => ({ n: hex64(N), ns }) }), 'ross.wei');
  eq(r.box, receiveBoxAddress(N, RECEIVE_FEE_BPS, EVM_POOL_ROUTER)); eq(r.name, 'ross.wei'); eq(r.n, hex64(N));
  eq(r.pool, POOL, 'the pool address the name points to comes back, so a payer can hold it against the address it resolved');
});
await test('a name that has published none says so', async () => {
  const e = await rejects(B.depositAddressOfName(stub(), 'ross.wei'), 'no-box');
  if (!/has not published a deposit address/.test(e.message)) throw new Error(e.message);
});
await test('a record signed by someone else\'s key is refused: copied from another name, or made up', async () => {
  const ns = await sigOf(0x0badc0ffee0badc0ffee0badc0ffee0badc0ffee0badc0ffee0badc0ffee0bn, N);
  await rejects(B.depositAddressOfName(stub({ readBox: async () => ({ n: hex64(N), ns }) }), 'ross.wei'), 'bad-sig');
  await rejects(B.depositAddressOfName(stub({ readBox: async () => ({ n: hex64(N), ns: '00'.repeat(64) }) }), 'ross.wei'), 'bad-sig');
});
await test('a record whose key was swapped for another is refused even with a real signature of the first', async () => {
  const ns = await sigOf(V_SCALAR, N);
  await rejects(B.depositAddressOfName(stub({ readBox: async () => ({ n: hex64(N + 1n), ns }) }), 'ross.wei'), 'bad-sig');
});
await test('a name pointing at another pool address cannot borrow this one\'s record', async () => {
  const ns = await sigOf(V_SCALAR, N);
  await rejects(B.depositAddressOfName(stub({ resolveName: async (n) => ({ name: n, pool: OTHER_POOL }), readBox: async () => ({ n: hex64(N), ns }) }), 'mallory.wei'), 'bad-sig');
});
await test('a name with no pool key has nothing to check against', async () => {
  const ns = await sigOf(V_SCALAR, N);
  await rejects(B.depositAddressOfName(stub({ resolveName: async (n) => ({ name: n }), readBox: async () => ({ n: hex64(N), ns }) }), 'old.wei'), 'no-pool');
});

console.log('through the names module and a chain stand-in');
// a minimal WNS: text records by node and key, a primary name, and setText
const WNS = '0x0000000000696760E15f265e828DB644A0c242EB';
const enc = new TextEncoder(), dec = new TextDecoder();
const word = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const numW = (n) => BigInt(n).toString(16).padStart(64, '0');
const padTo = (h) => h + '0'.repeat((64 - (h.length % 64)) % 64);
const encString = (s) => '0x' + numW(32) + numW(enc.encode(s).length) + padTo(bytesToHex(enc.encode(s)));
const encAddr = (a) => '0x' + word(a);
function dyn(body, at) { const off = Number(BigInt('0x' + body.slice(at * 64, at * 64 + 64))) * 2; const len = Number(BigInt('0x' + body.slice(off, off + 64))); return body.slice(off + 64, off + 64 + len * 2); }
const OWNER = '0x' + 'ab'.repeat(20);
function chain({ tacit, box }) {
  const names = makeConfidentialNames({ call: async () => '0x', secp, keccak256: keccak_256 });
  const node = word(names.namehash('ross.wei').toString(16));
  const texts = { [`${node}|${RECORD_KEY}`]: tacit, ...(box ? { [`${node}|${BOX_KEY}`]: box } : {}) };
  const sets = [];
  const call = async ({ to, data, from }) => {
    if (String(to).toLowerCase() !== WNS.toLowerCase()) return '0x';
    const d = data.replace(/^0x/, ''), sel = d.slice(0, 8), body = d.slice(8);
    if (sel === '59d1d43c') { const key = dec.decode(hexToBytes(dyn(body, 1))); const v = texts[`${body.slice(0, 64)}|${key}`]; return encString(v ?? ''); }
    if (sel === '9af8b7aa') return body.slice(24, 64) === OWNER.slice(2) ? encString('ross.wei') : encString('');
    if (sel === '4f896d4f') return body.slice(0, 64) === node ? encAddr(OWNER) : encAddr('0x' + '00'.repeat(20));
    if (sel === '3fb24782') { sets.push({ id: body.slice(0, 64), key: dec.decode(hexToBytes(dyn(body, 1))), value: dec.decode(hexToBytes(dyn(body, 2))), from }); return '0x'; }
    throw new Error('call ' + sel);
  };
  return { sets, names: (send) => makeConfidentialNames({ call, send, secp, keccak256: keccak_256 }), node };
}
const unified = (keys) => makeTacitAddress({ secp }).encodeTacitAddress({ network: 'mainnet', btcSpendPub: secp.getPublicKey(Uint8Array.from({ length: 32 }, () => 0x11), true), btcScanPub: secp.getPublicKey(Uint8Array.from({ length: 32 }, () => 0x22), true), evmOwnerPub: secp.getPublicKey(Uint8Array.from({ length: 32 }, () => 0x33), true), poolKeys: keys });
await test('end to end: ross.wei\'s Tacit address and deposit address records give the verified box', async () => {
  const ns = await sigOf(V_SCALAR, N);
  const w = chain({ tacit: unified(keys97(V_SCALAR)), box: B.boxValue(N, ns) });
  const r = await B.depositAddressOfName(w.names(null), 'ross.wei');
  eq(r.box, receiveBoxAddress(N, RECEIVE_FEE_BPS, EVM_POOL_ROUTER));
});
await test('end to end: a name whose deposit record is signed by another key is refused, and with no record it says so', async () => {
  const bad = await sigOf(0x0badc0ffee0badc0ffee0badc0ffee0badc0ffee0badc0ffee0badc0ffee0bn, N);
  await rejects(B.depositAddressOfName(chain({ tacit: unified(keys97(V_SCALAR)), box: B.boxValue(N, bad) }).names(null), 'ross.wei'), 'bad-sig');
  await rejects(B.depositAddressOfName(chain({ tacit: unified(keys97(V_SCALAR)) }).names(null), 'ross.wei'), 'no-box');
});
await test('end to end: a record that is not in the format is an error from the names module, not a payment', async () => {
  const w = chain({ tacit: unified(keys97(V_SCALAR)), box: 'send it to my cousin' });
  let threw = null; try { await B.depositAddressOfName(w.names(null), 'ross.wei'); } catch (e) { threw = e; }
  if (!(threw instanceof NameError) || threw.code !== 'bad-record') throw new Error('wrong: ' + threw?.message);
});
await test('publishing: the plan writes the record under finance.tacit.box on the owner\'s primary name, simulated before it is sent, skipped when already there', async () => {
  const ns = await sigOf(V_SCALAR, N);
  const w = chain({ tacit: unified(keys97(V_SCALAR)) });
  const sent = [];
  const n = w.names(async (tx) => { sent.push({ tx, simulated: w.sets.length }); return '0xabc'; });
  const plan = await n.planPublishBox({ owner: OWNER, n: N, ns });
  eq(plan.name, 'ross.wei'); eq(plan.current, null); eq(plan.changed, true); eq(plan.next, B.boxValue(N, ns));
  const r = await n.publish(plan);
  eq(r.txHash, '0xabc'); eq(sent.length, 1); eq(sent[0].simulated, 1, 'simulated before the wallet was asked');
  eq(w.sets[0].key, BOX_KEY); eq(w.sets[0].value, B.boxValue(N, ns)); eq(w.sets[0].from, OWNER);
  // already published: nothing to do
  const w2 = chain({ tacit: unified(keys97(V_SCALAR)), box: B.boxValue(N, ns) });
  const p2 = await w2.names(async () => { throw new Error('sent'); }).planPublishBox({ owner: OWNER, n: N, ns });
  eq(p2.changed, false); eq((await w2.names(null).publish(p2)).skipped, true);
});
await test('publishing a malformed record is refused before any chain call', async () => {
  const w = chain({ tacit: unified(keys97(V_SCALAR)) });
  let threw = false; try { await w.names(null).planPublishBox({ owner: OWNER, n: N, ns: 'abc' }); } catch (e) { threw = e instanceof NameError; }
  eq(threw, true);
});

console.log('with a real wallet\'s keys');
const { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } = await import('poseidon-lite');
const { makeEvmPoolZk } = await import('../dapp/evm-pool-zk.js');
const { evmPoolKeys } = await import('../dapp/evm-pool-wallet.js');
const { receiveKeys, RECEIVE_INDEX } = await import('../dapp/evm-pool-gateway.js');
const { poolKeysOf } = await import('../dapp/tacit-address.js');
const PO = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => PO[xs.length](xs) });
const wallet = evmPoolKeys(zk, new Uint8Array(32).fill(9));
await test('the first 33 bytes of a wallet\'s pool address are its view key', () => {
  eq(bytesToHex(poolKeysOf(wallet.address).slice(0, 33)), bytesToHex(wallet.V.toRawBytes(true)));
});
await test('a deposit address record signed with the wallet\'s own view scalar verifies against the wallet\'s own pool address', async () => {
  const k = receiveKeys(zk, wallet.zkWallet, RECEIVE_INDEX);
  const ns = await B.signBox(wallet.v, k.npk);
  const r = await B.depositAddressOfName(stub({ resolveName: async (n) => ({ name: n, pool: wallet.address }), readBox: async () => ({ n: hex64(k.npk), ns }) }), 'ross.wei');
  eq(r.box, receiveBoxAddress(k.npk, RECEIVE_FEE_BPS, EVM_POOL_ROUTER));
  // and not against anyone else's pool address
  const other = evmPoolKeys(zk, new Uint8Array(32).fill(10));
  await rejects(B.depositAddressOfName(stub({ resolveName: async (n) => ({ name: n, pool: other.address }), readBox: async () => ({ n: hex64(k.npk), ns }) }), 'mallory.wei'), 'bad-sig');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
