// The tacit1… address's pool lane (flag 0x04): additive to every address already in use. Vectors are pinned so
// other parsers (zSwap) can check against them.
//   node tests/tacit-address-pool.mjs
import assert from 'node:assert/strict';
import { secp, sha256, hmac, keccak_256, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
import { makeTacitAddress, poolKeysOf, poolAddressOf, decodeBech32m, TACIT_LANE_POOL, TACIT_EVM_IS_SPEND } from '../dapp/tacit-address.js';
import { makeConfidentialNames } from '../dapp/confidential-names.js';
import { bip352TaggedHash } from '../dapp/bip352.js';
import { makeBtcShieldedPool } from '../dapp/btc-shielded-pool.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const { encodeTacitAddress, decodeTacitAddress } = makeTacitAddress({ secp });
const names = makeConfidentialNames({ call: async () => { throw new Error('no network in this test'); }, secp, keccak256: keccak_256 });

// A real record, published to a .wei name through the dapp (tx 0x96076eea…9db7300): the address as every app reads it today.
const REAL_RECORD = 'tacit1qqpsxr8grjvk4asyvlk4aguyd0suvtmg3cevxxcznec82u70rrxps7hjqgedd68hq0su4dzzvcsl482xhz8put8p5fv7qctmg7k9twznf6lngqcvaqwfj6hkq3n76h4rs347r330dz8r9scmq208qatneuvvcxr67gpe2s29';

// The key 0x0707…07: its address today, its pool (bp1) address, and its unified address: the Bitcoin lane and the pool
// lane, with 0x80 saying the Ethereum-side key is the spend key rather than repeating it (flags 0x85).
const V0 = 'tacit1qqps9xyupdmvk43ew87un0hnrmqxcdtq7vjf6mhfuhvrc4mz2ktwqhm0qdk5lnmv6yyy73yd0mccau2em5n66y5a0pyh3xfuhzwmf8g39kctxq5cns9hdj6k89clmjd77v0vqmp4vrejf8twa8jas0zhvf2edczlduk6e0c7';
const BP = 'bp1qf5rdn2trtk94rqya5637yeqyvp5qllkeztth8dfesrc5x9tvqluqlahm5yyv7km9tq9s9spmdqqukkw46zudgxu7aawem8fyey0kseqh6xr40k26x7ew8zqujenn45kk2kh47aqzxxj3pp8q2rukjss02vszf7eaa';
const UNIFIED = 'tacit1qzzs9xyupdmvk43ew87un0hnrmqxcdtq7vjf6mhfuhvrc4mz2ktwqhm0qdk5lnmv6yyy73yd0mccau2em5n66y5a0pyh3xfuhzwmf8g39kctxqngxmx5kxhvt2xqfmf4rufjqgcrgplldjykhww6nnq83gv2kcplcplm0hgggeadk2kqtqtqrk6qpedvat59c6sdeam6ankwjfjgldpjp05v82lv45dajuwype9n88tfdv4d0ta6qyvd9zzzwq58ed9pq75emyyf75';
// The same keys with the Ethereum-side key written out (flags 0x07): valid, never produced by a Tacit app.
const EXPLICIT = 'tacit1qqrs9xyupdmvk43ew87un0hnrmqxcdtq7vjf6mhfuhvrc4mz2ktwqhm0qdk5lnmv6yyy73yd0mccau2em5n66y5a0pyh3xfuhzwmf8g39kctxq5cns9hdj6k89clmjd77v0vqmp4vrejf8twa8jas0zhvf2edczldupxsdkdfvdwck5vqnkn28cnyq3sxsrl7myfdwua48xq0zsc4dsrlsrlklwss3n6mv4vqkqkq8d5qrj6e6hgt34qmnmh4m8vayny376ryzlgcw47etgmm9cugrjtxwwkj6e267hm5qgc62yyyupg0j62zpafjgjz2hf';

const priv = new Uint8Array(32).fill(7);
const spend = secp.getPublicKey(priv, true);
const scanK = BigInt('0x' + bytesToHex(bip352TaggedHash('BIP0352/ScanKey', priv))) % secp.CURVE.n;
const scan = secp.getPublicKey(scanK.toString(16).padStart(64, '0'), true);
const bp = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 }).walletFromSeed(hmac(sha256, priv, new TextEncoder().encode('tacit-btc-pool-seed-v1')), 'mainnet').addressString;
const hex = (u) => bytesToHex(u);
// bech32m of an arbitrary payload under the tacit HRP, for layouts the encoder does not produce.
const bech = (bytes) => {
  const A = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l', hrp = 'tacit';
  const pm = (v) => { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const t = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >>> i) & 1) c ^= G[i]; } return c; };
  const d5 = []; let acc = 0, bits = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; d5.push((acc >>> bits) & 31); } }
  if (bits) d5.push((acc << (5 - bits)) & 31);
  const e = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const p = pm(e.concat(d5, [0, 0, 0, 0, 0, 0])) ^ 0x2bc830a3;
  return hrp + '1' + d5.concat([0, 1, 2, 3, 4, 5].map((i) => (p >>> (5 * (5 - i))) & 31)).map((x) => A[x]).join('');
};

await test('the key derives the pinned pool address and addresses', () => {
  assert.equal(bp, BP);
  assert.equal(encodeTacitAddress({ network: 'mainnet', btcSpendPub: spend, btcScanPub: scan, evmOwnerPub: spend }), V0);
  assert.equal(encodeTacitAddress({ network: 'mainnet', btcSpendPub: spend, btcScanPub: scan, evmOwnerPub: spend, poolKeys: poolKeysOf(BP) }), UNIFIED);
  assert.equal(UNIFIED.length, 276);
  assert.equal(EXPLICIT.length, 329);
});

await test('addresses in use today decode exactly as before', () => {
  for (const a of [REAL_RECORD, V0]) {
    const d = decodeTacitAddress(a);
    assert.equal(d.flags, 3);
    assert.deepEqual(Object.keys(d.lanes), ['btc', 'evm']);
    const r = names.decodeTacitAddress(a);
    assert.equal(r.key, '0x' + hex(d.lanes.evm.ownerPub));
    assert.ok(!('pool' in r), 'an old record has no pool field at all');
  }
});

await test('the unified address carries the same keys plus the pool lane, the Ethereum-side key once', () => {
  const d = decodeTacitAddress(UNIFIED), old = decodeTacitAddress(V0);
  assert.equal(d.flags, 1 | TACIT_LANE_POOL | TACIT_EVM_IS_SPEND);
  assert.equal(hex(d.lanes.btc.spendPub), hex(old.lanes.btc.spendPub));
  assert.equal(hex(d.lanes.btc.scanPub), hex(old.lanes.btc.scanPub));
  assert.equal(hex(d.lanes.evm.ownerPub), hex(old.lanes.evm.ownerPub));
  assert.equal(d.lanes.pool.poolAddress, BP);
  assert.equal(hex(d.lanes.pool.keys), hex(poolKeysOf(BP)));
  const r = names.decodeTacitAddress(UNIFIED);
  assert.equal(r.key, names.decodeTacitAddress(V0).key, 'a name that upgrades still pays the same Ethereum-side key');
  assert.equal(r.pool, BP);
  for (const e of [decodeTacitAddress(EXPLICIT)]) {                       // the written-out form reads the same
    assert.deepEqual(Object.keys(e.lanes), Object.keys(d.lanes));
    for (const k of ['btc', 'evm', 'pool']) assert.deepEqual(e.lanes[k], d.lanes[k]);
  }
  assert.deepEqual({ ...names.decodeTacitAddress(EXPLICIT), address: 0, flags: 0 }, { ...r, address: 0, flags: 0 });
});

await test('the Ethereum-side key is named once: written out or marked, never both', () => {
  const v0 = decodeBech32m(V0).payloadBytes, u = decodeBech32m(UNIFIED).payloadBytes;
  const both = Uint8Array.from(v0); both[1] = 0x83;
  assert.throws(() => decodeTacitAddress(bech(both)), /once/);
  assert.throws(() => names.decodeTacitAddress(bech(both)), /twice/);
  // Marked with no pool lane (flags 0x81, 121 characters): a Bitcoin address whose Ethereum-side key is its spend key.
  const short = bech(Uint8Array.from([0x00, 0x81, ...v0.slice(2, 68)]));
  assert.equal(short.length, 121);
  assert.equal(hex(decodeTacitAddress(short).lanes.evm.ownerPub), hex(spend));
  assert.equal(names.decodeTacitAddress(short).key, names.decodeTacitAddress(V0).key);
  // A different Ethereum-side key is written out even beside the pool lane.
  const other = secp.getPublicKey(new Uint8Array(32).fill(9), true);
  const d = decodeTacitAddress(encodeTacitAddress({ network: 'mainnet', btcSpendPub: spend, btcScanPub: scan, evmOwnerPub: other, poolKeys: poolKeysOf(BP) }));
  assert.equal(d.flags, 0x07);
  assert.equal(hex(d.lanes.evm.ownerPub), hex(other));
  assert.equal(u.length, 165);
});

await test('a reader from before the marker reads the pool lane and finds no Ethereum-side key to guess', () => {
  // The rules as they stood: lanes 0x01, 0x02, 0x04 in bit order; an unknown bit allows trailing bytes.
  const before = (a) => {
    const p = decodeBech32m(a).payloadBytes, f = p[1], want = 68 + (f & 2 ? 33 : 0) + (f & 4 ? 97 : 0);
    if (f & ~7 ? p.length < want : p.length !== want) throw new Error('length');
    return { evm: f & 2 ? p.slice(68, 101) : null, pool: f & 4 ? poolAddressOf(p.slice(68 + (f & 2 ? 33 : 0), 68 + (f & 2 ? 33 : 0) + 97)) : null };
  };
  const r = before(UNIFIED);
  assert.equal(r.pool, BP);
  assert.equal(r.evm, null);
});

await test('poolKeysOf and poolAddressOf are inverses; the pool lane is a bp1 payload verbatim', () => {
  assert.equal(poolAddressOf(poolKeysOf(BP)), BP);
  assert.equal(hex(poolKeysOf(BP)), hex(decodeBech32m(BP).payloadBytes));
  assert.throws(() => poolKeysOf(V0), /not a pool address/);
});

await test('the chain lane is a 32-byte hash after every other lane', () => {
  const base = decodeBech32m(UNIFIED).payloadBytes;
  const h = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const c = Uint8Array.from([...base, ...h]); c[1] |= 0x08;
  const d = decodeTacitAddress(bech(c));
  assert.equal(hex(d.lanes.chain.hash), hex(h));
  assert.equal(d.lanes.pool.poolAddress, BP, 'the pool lane is read as before');
  const short = Uint8Array.from([...base, ...h.slice(1)]); short[1] |= 0x08;
  assert.throws(() => decodeTacitAddress(bech(short)), /payload length/);
});

await test('lanes a reader does not know are ignored; with none, the length is exact', () => {
  const base = decodeBech32m(UNIFIED).payloadBytes, v0 = decodeBech32m(V0).payloadBytes;
  const withFlags = (p, flags, extra = []) => { const c = Uint8Array.from([...p, ...extra]); c[1] = flags; return bech(c); };
  const later = withFlags(base, 0x95, Array(40).fill(9));
  assert.equal(decodeTacitAddress(later).lanes.pool.poolAddress, BP);
  assert.equal(names.decodeTacitAddress(later).pool, BP);
  assert.equal(names.decodeTacitAddress(later).key, names.decodeTacitAddress(V0).key);
  const laterExplicit = withFlags(decodeBech32m(EXPLICIT).payloadBytes, 0x17, Array(40).fill(9));
  assert.equal(decodeTacitAddress(laterExplicit).lanes.pool.poolAddress, BP);
  const laterNoPool = withFlags(v0, 0x13, Array(12).fill(1));
  assert.deepEqual(Object.keys(decodeTacitAddress(laterNoPool).lanes), ['btc', 'evm']);
  assert.equal(names.decodeTacitAddress(laterNoPool).key, names.decodeTacitAddress(V0).key);
  assert.throws(() => decodeTacitAddress(withFlags(base, 0x85, [1])), /payload length/);
  assert.throws(() => names.decodeTacitAddress(withFlags(base, 0x85, [1])), /payload/);
  assert.throws(() => decodeTacitAddress(withFlags(v0, 0x07)), /payload length/, 'a pool flag without its 97 bytes');
  assert.throws(() => decodeTacitAddress(withFlags(base.slice(0, 150), 0x8d)), /payload length/, 'an unknown lane never excuses a short known one');
});

await test('a bad pool view key is refused', () => {
  for (const [a, at] of [[UNIFIED, 68], [EXPLICIT, 101]]) {
    const p = decodeBech32m(a).payloadBytes.slice();
    p[at] = 0x05;
    assert.throws(() => decodeTacitAddress(bech(p)));
  }
});

console.log(`\n${n} passed`);
