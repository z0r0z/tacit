// Name lookup for private sends (dapp/confidential-names.js): namehash, the finance.tacit record on WNS / GNS /
// ENS (direct + wildcard, off-chain refused), the strict tacit1… decoder, primary-name forward verification,
// and the publish plan (skip-if-equal, simulate before send). All chain access is a mocked eth_call.
// Run: node tests/confidential-names.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeTacitAddress } from '../dapp/tacit-address.js';
import {
  makeConfidentialNames, makeMainnetCall, NameError, CallRevert, WNS, GNS, ENS_REGISTRY, RECORD_KEY,
} from '../dapp/confidential-names.js';

const hex = (u8) => Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('');
const bytes = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
const w = (h) => String(h).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const nw = (n) => BigInt(n).toString(16).padStart(64, '0');
const pad = (h) => h + '0'.repeat((64 - (h.length % 64)) % 64);
const lc = (a) => String(a).toLowerCase();

const REF = 'tacit1qqps86ymc78aa5v4q03hjlz70hrmq3a2xa4g8zg9exreekzye4h6yw4eqdvy85q973gqj85aa84d25wpex67fpal72yznlej9q85eez9ax0jsqlgn0rclhk3j5p7x7tute7u0vz84gmk4qufqhyc08xcgnxklg36hyl7pvk0';
const REF_KEY = '0x03e89bc78fded19503e3797c5e7dc7b047aa376a838905c9879cd844cd6fa23ab9';
const REF_SCAN = '0x035843d005f450091e9de9ead551c1c9b5e487bff28829ff32280f4ce445e99f28';

const { encodeTacitAddress } = makeTacitAddress({ secp });
const pub = (b) => secp.getPublicKey(Uint8Array.from({ length: 32 }, () => b), true);
const good = (net = 'mainnet') => encodeTacitAddress({ network: net, btcSpendPub: pub(0x11), btcScanPub: pub(0x22), evmOwnerPub: pub(0x33) });

// Independent bech32m encoder so malformed payloads can be crafted (the module's codec only builds valid ones).
const ALPHA = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const polymod = (v) => {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const x of v) { const t = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >>> i) & 1) c ^= G[i]; }
  return c;
};
function bech32m(hrp, payload) {
  const d5 = []; let acc = 0, bits = 0;
  for (const b of payload) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; d5.push((acc >>> bits) & 31); } }
  if (bits) d5.push((acc << (5 - bits)) & 31);
  const exp = [...[...hrp].map((c) => c.charCodeAt(0) >>> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const pm = polymod([...exp, ...d5, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
  const cs = Array.from({ length: 6 }, (_, i) => (pm >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...d5, ...cs].map((v) => ALPHA[v]).join('');
}
const payload = ({ version = 0, flags = 3, evm = pub(0x33), len = 101 } = {}) => {
  const p = new Uint8Array(len);
  p[0] = version; p[1] = flags;
  p.set(pub(0x11), 2); p.set(pub(0x22), 35);
  if (len >= 101) p.set(evm, 68);
  return p;
};

// ── a small fake chain: WNS / GNS text + reverse + forward, the ENS registry, and resolvers ──
const encString = (s) => '0x' + nw(32) + nw(new TextEncoder().encode(s).length) + pad(hex(new TextEncoder().encode(s)));
const encBytes = (h) => '0x' + nw(32) + nw(bytes(h).length) + pad(h.replace(/^0x/, ''));
const encAddr = (a) => '0x' + w(a);

function decodeDyn(h, at) {
  const off = Number(BigInt('0x' + h.slice(64 * at, 64 * at + 64))) * 2;
  const len = Number(BigInt('0x' + h.slice(off, off + 64)));
  return h.slice(off + 64, off + 64 + len * 2);
}
const str = (h) => new TextDecoder().decode(bytes(h));

function world() {
  const t = {
    log: [],
    wns: { text: {}, reverse: {}, forward: {}, setText: [] },
    gns: { text: {}, reverse: {}, forward: {}, setText: [] },
    reg: {},                // ens node -> resolver address
    res: {},                // resolver address -> { text:{}, addr:{}, name:{}, wild:bool, offchain:bool, setText:[] }
  };
  const revert = (d) => { throw new CallRevert('execution reverted', d || null); };
  const OFFCHAIN = '0x556f1830' + '00'.repeat(32);

  function resolverCall(r, sel, body) {
    if (r.offchain) revert(OFFCHAIN);
    if (sel === '59d1d43c') { const v = r.text[body.slice(0, 64)]; return v === undefined ? encString('') : encString(v); }
    if (sel === '3b3b57de') { const v = r.addr[body.slice(0, 64)]; return v ? encAddr(v) : encAddr('0x' + '00'.repeat(20)); }
    if (sel === '691f3431') { const v = r.name[body.slice(0, 64)]; return v ? encString(v) : encString(''); }
    if (sel === '10f13a8c') { r.setText.push({ node: body.slice(0, 64), key: str(decodeDyn(body, 1)), value: str(decodeDyn(body, 2)) }); return '0x'; }
    return revert();
  }

  t.call = async ({ to, data, from }) => {
    const target = lc(to); const d = data.replace(/^0x/, ''); const sel = d.slice(0, 8); const body = d.slice(8);
    t.log.push({ to: target, sel, from });
    for (const [svc, addr] of [['wns', WNS], ['gns', GNS]]) {
      if (target !== lc(addr)) continue;
      const s = t[svc];
      if (sel === '59d1d43c') { const v = s.text[body.slice(0, 64)]; return v === undefined ? encString('') : encString(v); }
      if (sel === '9af8b7aa') { const v = s.reverse[body.slice(24, 64)]; return v ? encString(v) : encString(''); }
      if (sel === '4f896d4f') { const v = s.forward[body.slice(0, 64)]; return v ? encAddr(v) : encAddr('0x' + '00'.repeat(20)); }
      if (sel === '3fb24782') { s.setText.push({ id: body.slice(0, 64), key: str(decodeDyn(body, 1)), value: str(decodeDyn(body, 2)) }); return '0x'; }
      return revert();
    }
    if (target === lc(ENS_REGISTRY)) {
      if (sel !== '0178b8bf') return revert();
      const r = t.reg[body.slice(0, 64)];
      return r ? encAddr(r) : encAddr('0x' + '00'.repeat(20));
    }
    const r = t.res[target];
    if (!r) return '0x';
    if (sel === '9061b923') {
      if (!r.wild) return revert();
      if (r.offchain) revert(OFFCHAIN);
      const inner = decodeDyn(body, 1);
      const out = resolverCall(r, inner.slice(0, 8), inner.slice(8)).replace(/^0x/, '');
      // wildcard reply wraps the inner ABI-encoded answer in `bytes`
      return encBytes(out);
    }
    return resolverCall(r, sel, body);
  };
  return t;
}

const OWNER = '0x' + 'ab'.repeat(20);
const OTHER = '0x' + 'cd'.repeat(20);
const RES = '0x' + '11'.repeat(20);
const RES2 = '0x' + '22'.repeat(20);
function names(wd, { send = null } = {}) { return makeConfidentialNames({ call: wd.call, send, secp, keccak256: keccak_256 }); }
const rejects = async (p, code) => assert.rejects(p, (e) => e instanceof NameError && e.code === code, `expected NameError ${code}`);

// ── namehash / name rules ──
test('namehash matches the standard vectors', () => {
  const n = names(world());
  assert.strictEqual(n.namehash('eth'), '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae');
  assert.strictEqual(n.namehash('foo.eth'), '0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f');
  assert.strictEqual(n.namehash('vitalik.eth'), '0xee6c4522aab0003e8d14cd40a6af439055fd2577951148c14b6cea9a53475835');
  assert.strictEqual(n.namehash('FOO.eth'), n.namehash('foo.eth'), 'lowercased');
});

test('name validation and service routing', () => {
  const n = names(world());
  for (const bad of ['bad_name.eth', 'a b.eth', 'ünï.eth', '.eth', 'a..eth', 'a.eth.', '']) {
    assert.throws(() => n.classify(bad), (e) => e.code === 'bad-name', bad);
  }
  assert.strictEqual(n.classify('alice.wei').source, 'WNS');
  assert.strictEqual(n.classify('alice.gwei').source, 'GNS');
  assert.strictEqual(n.classify('Alice.ETH').source, 'ENS');
  assert.strictEqual(n.classify('sub.alice.eth').source, 'ENS');
  for (const bad of ['alice.com', 'alice.base.eth', 'base.eth', 'eth', 'wei']) {
    assert.throws(() => n.classify(bad), (e) => e.code === 'unsupported-name', bad);
  }
  assert.ok(n.looksLikeName('alice.wei') && !n.looksLikeName('tacit1qqq') && !n.looksLikeName('0x' + '02'.repeat(33)));
});

test('dns wire format', () => {
  const n = names(world());
  assert.strictEqual(hex(n.dnsName('foo.bar.eth')), '03666f6f036261720365746800');
});

// ── WNS / GNS ──
test('WNS and GNS text read: exact calldata, whitespace trimmed, nothing else changed', async () => {
  const wd = world(); const n = names(wd);
  wd.wns.text[w(n.namehash('alice.wei'))] = `  ${REF}\n`;
  wd.gns.text[w(n.namehash('bob.gwei'))] = REF;
  const r = await n.resolveName('Alice.wei');
  assert.deepStrictEqual({ ...r }, { name: 'alice.wei', address: REF, key: REF_KEY, source: 'WNS', node: n.namehash('alice.wei') });
  const g = await n.resolveName('bob.gwei');
  assert.strictEqual(g.source, 'GNS');
  assert.strictEqual(g.key, REF_KEY);
  const keyHex = hex(new TextEncoder().encode(RECORD_KEY));
  const expected = '59d1d43c' + w(n.namehash('alice.wei')) + nw(64) + nw(RECORD_KEY.length) + pad(keyHex);
  let seen;
  const n2 = makeConfidentialNames({ call: async (req) => { seen = req; return wd.call(req); }, secp, keccak256: keccak_256 });
  await n2.readRecord('alice.wei');
  assert.strictEqual(seen.data, '0x' + expected);
  assert.strictEqual(lc(seen.to), lc(WNS));
});

test('a name with no record, or an empty one, is a typed "no-record" error; a junk record is "bad-record"', async () => {
  const wd = world(); const n = names(wd);
  await rejects(n.resolveName('nobody.wei'), 'no-record');
  wd.wns.text[w(n.namehash('blank.wei'))] = '   ';
  await rejects(n.resolveName('blank.wei'), 'no-record');
  wd.wns.text[w(n.namehash('junk.wei'))] = 'hello world';
  await rejects(n.resolveName('junk.wei'), 'bad-record');
  await rejects(n.resolveName('alice.com'), 'unsupported-name');
});

test('no caching: each call reads the chain again', async () => {
  const wd = world(); const n = names(wd);
  const node = w(n.namehash('alice.wei'));
  wd.wns.text[node] = REF;
  assert.strictEqual((await n.resolveName('alice.wei')).address, REF);
  wd.wns.text[node] = good();
  assert.strictEqual((await n.resolveName('alice.wei')).address, good());
});

// ── ENS ──
test('ENS: resolver on the name’s own node is queried directly', async () => {
  const wd = world(); const n = names(wd);
  const node = w(n.namehash('alice.eth'));
  wd.reg[node] = RES;
  wd.res[lc(RES)] = { text: { [node]: REF }, addr: {}, name: {}, setText: [] };
  const r = await n.resolveName('alice.eth');
  assert.strictEqual(r.source, 'ENS');
  assert.strictEqual(r.key, REF_KEY);
  assert.ok(wd.log.every((l) => l.sel !== '9061b923'), 'no wildcard entry point for an own-node resolver');
});

test('ENS: an ancestor’s wildcard resolver is asked through resolve(bytes,bytes)', async () => {
  const wd = world(); const n = names(wd);
  wd.reg[w(n.namehash('parent.eth'))] = RES2;
  const child = w(n.namehash('kid.parent.eth'));
  wd.res[lc(RES2)] = { text: { [child]: REF }, addr: {}, name: {}, wild: true, setText: [] };
  const r = await n.resolveName('kid.parent.eth');
  assert.strictEqual(r.address, REF);
  const wild = wd.log.find((l) => l.sel === '9061b923');
  assert.ok(wild && wild.to === lc(RES2));
  // registry was asked for the name first, then its parent
  const regCalls = wd.log.filter((l) => l.to === lc(ENS_REGISTRY));
  assert.strictEqual(regCalls.length, 2);
});

test('ENS: nothing on the chain of ancestors is "no record"', async () => {
  const n = names(world());
  await rejects(n.resolveName('ghost.eth'), 'no-record');
});

test('ENS: an off-chain lookup is refused, direct and wildcard', async () => {
  const wd = world(); const n = names(wd);
  const node = w(n.namehash('cc.eth'));
  wd.reg[node] = RES;
  wd.res[lc(RES)] = { text: {}, addr: {}, name: {}, offchain: true, setText: [] };
  await rejects(n.resolveName('cc.eth'), 'offchain');
  wd.reg[w(n.namehash('wild.eth'))] = RES2;
  wd.res[lc(RES2)] = { text: {}, addr: {}, name: {}, wild: true, offchain: true, setText: [] };
  await rejects(n.resolveName('x.wild.eth'), 'offchain');
});

// ── decoder ──
test('decoder: the reference address decodes to its Ethereum-lane key and re-encodes byte-identically', () => {
  const n = names(world());
  const d = n.decodeTacitAddress(REF);
  assert.strictEqual(d.key, REF_KEY);
  assert.strictEqual(d.scanKey, REF_SCAN);
  assert.strictEqual(d.flags, 3);
  assert.strictEqual(d.spendKey, REF_KEY, 'spend key equals the Ethereum-lane key in this layout');
  const { decodeTacitAddress: unified } = makeTacitAddress({ secp });
  const u = unified(REF);
  assert.strictEqual('0x' + hex(u.lanes.evm.ownerPub), d.key, 'strict decoder agrees with the unified decoder');
  const again = encodeTacitAddress({ network: 'mainnet', btcSpendPub: u.lanes.btc.spendPub, btcScanPub: u.lanes.btc.scanPub, evmOwnerPub: u.lanes.evm.ownerPub });
  assert.strictEqual(again, REF);
});

test('decoder: a freshly built address round-trips and surrounding whitespace is ignored', () => {
  const n = names(world());
  const a = good();
  assert.strictEqual(n.decodeTacitAddress(`  ${a}\n`).key, '0x' + hex(pub(0x33)));
  assert.strictEqual(n.decodeTacitAddress(bech32m('tacit', payload())).key, '0x' + hex(pub(0x33)));
});

test('decoder strictness', () => {
  const n = names(world());
  const bad = (s, re) => assert.throws(() => n.decodeTacitAddress(s), (e) => e instanceof NameError && e.code === 'bad-address' && re.test(e.message), s.slice(0, 20));
  bad(good('signet'), /prefix "tactt"/);
  bad(good('regtest'), /prefix "tacrt"/);
  bad(bech32m('bc', payload()), /prefix "bc"/);
  bad(bech32m('tacit', payload({ len: 68 })), /68 bytes/);
  bad(bech32m('tacit', payload({ len: 102 })), /102 bytes/);
  bad(bech32m('tacit', payload({ version: 1 })), /version 1/);
  bad(bech32m('tacit', payload({ flags: 1 })), /Ethereum lane/);
  bad(bech32m('tacit', payload({ evm: Uint8Array.from([2, ...new Array(32).fill(0xff)]) })), /valid point/);
  bad(bech32m('tacit', payload({ evm: new Uint8Array(33) })), /valid point/);
  const a = good();
  bad(a.slice(0, -1) + (a.endsWith('q') ? 'p' : 'q'), /checksum/);
  bad(a.toUpperCase().slice(0, 10) + a.slice(10), /mixed case/);
  bad('', /./);
  bad('not an address', /./);
  // flags with the Ethereum bit but not the Bitcoin bit is still a 101-byte layout and is accepted
  assert.strictEqual(n.decodeTacitAddress(bech32m('tacit', payload({ flags: 2 }))).flags, 2);
});

// ── primary name ──
function primaryWorld() {
  const wd = world(); const n = names(wd);
  const tokenId = (name) => w(n.namehash(name));
  return { wd, n, tokenId };
}

test('primary name: WNS first, then GNS, then ENS', async () => {
  const { wd, n, tokenId } = primaryWorld();
  const o = lc(OWNER).slice(2);
  wd.gns.reverse[o] = 'g.gwei'; wd.gns.forward[tokenId('g.gwei')] = OWNER;
  const ensNode = w(n.namehash('e.eth'));
  wd.reg[w(n.namehash(`${o}.addr.reverse`))] = RES;
  wd.res[lc(RES)] = { text: {}, addr: {}, name: { [w(n.namehash(`${o}.addr.reverse`))]: 'e.eth' }, setText: [] };
  wd.reg[ensNode] = RES2;
  wd.res[lc(RES2)] = { text: {}, addr: { [ensNode]: OWNER }, name: {}, setText: [] };
  assert.strictEqual((await n.primaryName(OWNER)).name, 'g.gwei', 'GNS beats ENS');
  wd.wns.reverse[o] = 'w.wei'; wd.wns.forward[tokenId('w.wei')] = OWNER;
  const p = await n.primaryName(OWNER);
  assert.deepStrictEqual({ ...p }, { name: 'w.wei', source: 'WNS', node: n.namehash('w.wei') });
  delete wd.wns.reverse[o]; delete wd.gns.reverse[o];
  const e = await n.primaryName(OWNER);
  assert.strictEqual(e.name, 'e.eth');
  assert.strictEqual(e.source, 'ENS');
});

test('primary name: a reverse record that does not forward-resolve back is skipped', async () => {
  const { wd, n, tokenId } = primaryWorld();
  const o = lc(OWNER).slice(2);
  wd.wns.reverse[o] = 'liar.wei'; wd.wns.forward[tokenId('liar.wei')] = OTHER;
  wd.gns.reverse[o] = 'gone.gwei';                       // no forward record at all
  const r = await n.findPrimary(OWNER);
  assert.strictEqual(r.primary, null);
  assert.deepStrictEqual(r.skipped.map((s) => [s.source, s.name, s.reason]), [['WNS', 'liar.wei', 'forward-mismatch'], ['GNS', 'gone.gwei', 'forward-mismatch']]);
  wd.gns.reverse[o] = 'real.gwei'; wd.gns.forward[tokenId('real.gwei')] = OWNER;
  assert.strictEqual((await n.primaryName(OWNER)).name, 'real.gwei', 'falls through to the next verified candidate');
});

test('primary name: ENS forward check through a wildcard resolver, and a mismatch there is skipped', async () => {
  const { wd, n } = primaryWorld();
  const o = lc(OWNER).slice(2);
  const rnode = w(n.namehash(`${o}.addr.reverse`));
  wd.reg[rnode] = RES;
  wd.res[lc(RES)] = { text: {}, addr: {}, name: { [rnode]: 'kid.parent.eth' }, setText: [] };
  wd.reg[w(n.namehash('parent.eth'))] = RES2;
  const kid = w(n.namehash('kid.parent.eth'));
  wd.res[lc(RES2)] = { text: {}, addr: { [kid]: OWNER }, name: {}, wild: true, setText: [] };
  assert.strictEqual((await n.primaryName(OWNER)).name, 'kid.parent.eth');
  wd.res[lc(RES2)].addr[kid] = OTHER;
  assert.strictEqual(await n.primaryName(OWNER), null);
});

test('primary name: an unusable reverse name (other TLD, .base.eth) is skipped', async () => {
  const { wd, n } = primaryWorld();
  const o = lc(OWNER).slice(2);
  wd.wns.reverse[o] = 'x.eth';                            // wrong service for WNS
  const rnode = w(n.namehash(`${o}.addr.reverse`));
  wd.reg[rnode] = RES;
  wd.res[lc(RES)] = { text: {}, addr: {}, name: { [rnode]: 'me.base.eth' }, setText: [] };
  const r = await n.findPrimary(OWNER);
  assert.strictEqual(r.primary, null);
  assert.deepStrictEqual(r.skipped.map((s) => s.reason), ['unusable-name', 'unusable-name']);
});

// ── publish ──
test('publish: WNS setText calldata is (uint256 tokenId, key, value); simulate precedes send', async () => {
  const { wd, n, tokenId } = primaryWorld();
  const o = lc(OWNER).slice(2);
  wd.wns.reverse[o] = 'w.wei'; wd.wns.forward[tokenId('w.wei')] = OWNER;
  const sent = [];
  const nn = names(wd, { send: async (tx) => { sent.push({ tx, simulated: wd.wns.setText.length }); return '0xabc'; } });
  const plan = await nn.planPublish({ owner: OWNER, tacitAddress: REF });
  assert.strictEqual(plan.name, 'w.wei');
  assert.strictEqual(plan.current, null);
  assert.strictEqual(plan.next, REF);
  assert.strictEqual(plan.changed, true);
  assert.strictEqual(lc(plan.tx.to), lc(WNS));
  assert.strictEqual(plan.tx.from, OWNER);
  assert.ok(plan.tx.data.startsWith('0x3fb24782' + tokenId('w.wei')));
  const r = await nn.publish(plan);
  assert.deepStrictEqual(r, { skipped: false, txHash: '0xabc' });
  // the simulation (an eth_call carrying `from`) ran and hit the contract before the wallet was asked to send
  const simCalls = wd.log.filter((l) => l.sel === '3fb24782');
  assert.strictEqual(simCalls.length, 1);
  assert.strictEqual(simCalls[0].from, OWNER);
  assert.strictEqual(wd.wns.setText[0].key, RECORD_KEY);
  assert.strictEqual(wd.wns.setText[0].value, REF);
  assert.strictEqual(wd.wns.setText[0].id, tokenId('w.wei'));
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].simulated, 1, 'setText was simulated before the wallet send');
  assert.strictEqual(sent[0].tx, plan.tx);
});

test('publish: skipped when the record already equals the address (no simulation, no send)', async () => {
  const { wd, tokenId } = primaryWorld();
  const o = lc(OWNER).slice(2);
  wd.gns.reverse[o] = 'g.gwei'; wd.gns.forward[tokenId('g.gwei')] = OWNER;
  wd.gns.text[tokenId('g.gwei')] = `${REF} `;
  let sends = 0;
  const n = names(wd, { send: async () => { sends++; return '0x1'; } });
  const before = wd.log.length;
  const plan = await n.planPublish({ owner: OWNER, tacitAddress: REF });
  assert.strictEqual(plan.current, REF);
  assert.strictEqual(plan.changed, false);
  const r = await n.publish(plan);
  assert.deepStrictEqual(r, { skipped: true, txHash: null });
  assert.strictEqual(sends, 0);
  assert.ok(wd.log.slice(before).every((l) => l.sel !== '3fb24782'), 'no setText simulation');
});

test('publish: a rejected simulation stops before the wallet is asked', async () => {
  const { wd, tokenId } = primaryWorld();
  const o = lc(OWNER).slice(2);
  wd.wns.reverse[o] = 'w.wei'; wd.wns.forward[tokenId('w.wei')] = OWNER;
  let sends = 0;
  const failing = { ...wd, call: async (req) => { if (req.from && req.data.startsWith('0x3fb24782')) throw new CallRevert('execution reverted', '0x08c379a0' + nw(32) + nw(9) + pad(hex(new TextEncoder().encode('not owner')))); return wd.call(req); } };
  const n = makeConfidentialNames({ call: failing.call, send: async () => { sends++; return '0x1'; }, secp, keccak256: keccak_256 });
  const plan = await n.planPublish({ owner: OWNER, tacitAddress: REF });
  await assert.rejects(n.publish(plan), (e) => e.code === 'simulation-failed' && /not owner/.test(e.message));
  assert.strictEqual(sends, 0);
});

test('publish: ENS writes to the resolver on the name’s own node; a wildcard/ancestor resolver is refused', async () => {
  const { wd, n } = primaryWorld();
  const o = lc(OWNER).slice(2);
  const rnode = w(n.namehash(`${o}.addr.reverse`));
  const node = w(n.namehash('e.eth'));
  wd.reg[rnode] = RES;
  wd.res[lc(RES)] = { text: {}, addr: {}, name: { [rnode]: 'e.eth' }, setText: [] };
  wd.reg[node] = RES2;
  wd.res[lc(RES2)] = { text: {}, addr: { [node]: OWNER }, name: {}, setText: [] };
  const sent = [];
  const nn = names(wd, { send: async (tx) => { sent.push(tx); return '0xdef'; } });
  const plan = await nn.planPublish({ owner: OWNER, tacitAddress: REF });
  assert.strictEqual(plan.source, 'ENS');
  assert.strictEqual(lc(plan.tx.to), lc(RES2));
  assert.ok(plan.tx.data.startsWith('0x10f13a8c' + node));
  await nn.publish(plan);
  assert.deepStrictEqual(wd.res[lc(RES2)].setText, [{ node, key: RECORD_KEY, value: REF }]);
  assert.strictEqual(sent.length, 1);

  // the same primary name, but its resolver is an ancestor's wildcard resolver
  delete wd.reg[node];
  wd.reg[w(n.namehash('eth'))] = RES2;
  wd.res[lc(RES2)].wild = true;
  await rejects(nn.planPublish({ owner: OWNER, tacitAddress: REF }), 'resolver-cannot-hold');
});

test('publish: no verified primary name, and an unusable address, are typed errors', async () => {
  const { wd } = primaryWorld();
  const n = names(wd);
  await rejects(n.planPublish({ owner: OWNER, tacitAddress: REF }), 'no-primary-name');
  await rejects(n.planPublish({ owner: OWNER, tacitAddress: 'tacit1nope' }), 'bad-address');
  await rejects(n.planPublish({ owner: '0x1234', tacitAddress: REF }), 'bad-address');
  await assert.rejects(n.publish({ changed: true, tx: {} }), (e) => e.code === 'no-sender');
});

// ── recipient field ──
test('recipient field: names resolve and pin the key; a bare account address is refused with guidance', async () => {
  const wd = world(); const n = names(wd);
  wd.wns.text[w(n.namehash('alice.wei'))] = REF;
  const local = (s) => (/^0x0[23][0-9a-f]{64}$/i.test(s) ? { pubHex: s } : { error: 'nope' });
  const r = await n.resolveRecipient('  alice.wei ', { local });
  assert.deepStrictEqual({ ...r }, { pubHex: REF_KEY, name: 'alice.wei', address: REF, source: 'WNS', node: n.namehash('alice.wei') });
  assert.deepStrictEqual({ ...(await n.resolveRecipient(REF_KEY, { local })) }, { pubHex: REF_KEY });
  await assert.rejects(n.resolveRecipient(OWNER, { local }), (e) => e.code === 'account-address' && /publish their Tacit address/.test(e.message) && /public unwrap/.test(e.message));
  await rejects(n.resolveRecipient('gibberish', { local }), 'bad-recipient');
  await rejects(n.resolveRecipient('alice.com', { local }), 'unsupported-name');
  await rejects(n.resolveRecipient('ghost.gwei', { local }), 'no-record');
  assert.strictEqual(wd.log.filter((l) => l.to === lc(WNS)).length, 1, 'the address form never touches the chain');
});

// ── mainnet eth_call helper ──
test('makeMainnetCall: falls through failing endpoints, treats a revert as final', async () => {
  const seen = [];
  const mk = (handler) => async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return handler(url); };
  const ok = (result) => ({ ok: true, json: async () => ({ result }) });
  const call = makeMainnetCall({ rpcs: ['https://a', 'https://b'], fetchImpl: mk((u) => (u === 'https://a' ? { ok: false, status: 500 } : ok('0x01'))) });
  assert.strictEqual(await call({ to: WNS, data: '0x00', from: OWNER }), '0x01');
  assert.strictEqual(seen[0].body.method, 'eth_call');
  assert.strictEqual(seen[0].body.params[0].to, lc(WNS));
  assert.strictEqual(seen[0].body.params[0].from, lc(OWNER));
  assert.strictEqual(seen[0].body.params[1], 'latest');

  seen.length = 0;
  const reverting = makeMainnetCall({ rpcs: ['https://a', 'https://b'], fetchImpl: mk(() => ({ ok: true, json: async () => ({ error: { code: 3, message: 'execution reverted', data: '0xdeadbeef' } }) })) });
  await assert.rejects(reverting({ to: WNS, data: '0x' }), (e) => e instanceof CallRevert && e.data === '0xdeadbeef');
  assert.strictEqual(seen.length, 1, 'a revert is not retried on the next endpoint');

  const down = makeMainnetCall({ rpcs: ['https://a', 'https://b'], fetchImpl: mk(() => { throw new Error('boom'); }) });
  await assert.rejects(down({ to: WNS, data: '0x' }), (e) => e instanceof NameError && e.code === 'rpc');
});

test('a transport failure is surfaced, never read as "no record"', async () => {
  const n = makeConfidentialNames({ call: async () => { throw new NameError('rpc', 'down'); }, secp, keccak256: keccak_256 });
  await rejects(n.resolveName('alice.wei'), 'rpc');
  await rejects(n.primaryName(OWNER), 'rpc');
});
