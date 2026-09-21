// tools/airdrop-snapshot.mjs: replay of Transfer logs to balances, supply/balance verification, log-window bookkeeping,
// ABI helpers, holder rows + summary, error classification and the CLI argument checks. Synthetic data only, no network.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  TRANSFER_TOPIC, TRANSFER_6909_TOPIC, ZERO, TOKENS, ReplayError, parseTransfer, parseTransfer6909, idTopic, logFilter, replayErc20, replayErc721, verifyErc20Supply, verifyErc721Supply,
  diffBalances, candidateAddresses, computeGaps, assembleLogs, normalizeLog, encodeAggregate3, decodeAggregate3, decodeString, decodeUint,
  decodeAddress, addrWord, uintWord, callData, formatUnits, fmtAmount, pctOf, makeRng, sampleN, buildHolderRows, tokenStats, renderSummary,
  classifyError, loadBlacklist, CODESIZE_PROBE,
} from '../tools/airdrop-snapshot.mjs';

const TOOL = fileURLToPath(new URL('../tools/airdrop-snapshot.mjs', import.meta.url));
const BLACKLIST = fileURLToPath(new URL('../tools/airdrop-blacklist.json', import.meta.url));

const A = (n) => '0x' + n.toString(16).padStart(40, '0');
const topic = (a) => '0x' + a.slice(2).padStart(64, '0');
const u256 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let idx = 0;
const e20 = (from, to, v, b = 100) => ({ b, i: idx++, t: [TRANSFER_TOPIC, topic(from), topic(to)], d: u256(v) });
const e721 = (from, to, id, b = 100) => ({ b, i: idx++, t: [TRANSFER_TOPIC, topic(from), topic(to), u256(id)], d: '0x' });
const [X, Y, Z, DEAD] = [A(0xa1), A(0xb2), A(0xc3), '0x000000000000000000000000000000000000dead'];

test('ERC20 replay: mint, transfer and burn to zero; zero address kept apart and never a holder', () => {
  const r = replayErc20([e20(ZERO, X, 100), e20(X, Y, 30), e20(Y, Z, 30), e20(X, ZERO, 20), e20(ZERO, Y, 5)]);
  assert.deepEqual([...r.balances].sort(), [[X, 50n], [Y, 5n], [Z, 30n]].sort());
  assert.equal(r.zeroBalance, 20n);
  assert.equal(r.minted, 105n);
  assert.equal(r.transfers, 5);
  assert.equal(r.anomalies, 0);
});

test('ERC20 replay drops holders that end at zero and treats the dead address as an ordinary holder', () => {
  const r = replayErc20([e20(ZERO, X, 10), e20(X, DEAD, 4), e20(X, Y, 6), e20(Y, X, 6)]);
  assert.equal(r.balances.get(X), 6n);
  assert.equal(r.balances.get(DEAD), 4n);
  assert.ok(!r.balances.has(Y));
  assert.equal(r.zeroBalance, 0n);
});

test('ERC20 replay refuses a transfer that overdraws the sender', () => {
  assert.throws(() => replayErc20([e20(ZERO, X, 10), e20(X, Y, 11)]), (e) => e instanceof ReplayError && /underflow/.test(e.message));
  assert.throws(() => replayErc20([e20(X, Y, 1)]), ReplayError);
});

test('ERC20 supply check without an on-chain zero balance: exact, burns, zero address counted, and a mismatch', () => {
  const exact = verifyErc20Supply(replayErc20([e20(ZERO, X, 100), e20(X, Y, 40)]), 100n);
  assert.deepEqual([exact.ok, exact.semantics], [true, 'exact']);
  const burned = verifyErc20Supply(replayErc20([e20(ZERO, X, 100), e20(X, ZERO, 30)]), 70n);
  assert.deepEqual([burned.ok, burned.semantics, burned.zeroAddressEventBalance], [true, 'burn-reduces-supply', '30']);
  const counted = verifyErc20Supply(replayErc20([e20(ZERO, X, 100), e20(X, ZERO, 30)]), 100n);
  assert.deepEqual([counted.ok, counted.semantics], [true, 'zero-address-counted']);
  const bad = verifyErc20Supply(replayErc20([e20(ZERO, X, 100)]), 101n);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /!= totalSupply 101/);
});

test('ERC20 supply check with the token-reported zero balance: a burn() and a plain transfer to zero emit the same log', () => {
  // 1000 minted, 200 leave through burn() (supply drops), 30 are sent to the zero address as an ordinary transfer (still in supply)
  const r = replayErc20([e20(ZERO, X, 1000), e20(X, ZERO, 200), e20(X, ZERO, 30)]);
  assert.equal(r.zeroBalance, 230n);
  assert.equal(verifyErc20Supply(r, 800n).ok, false); // neither extreme reading fits without the chain value
  const held = verifyErc20Supply(r, 800n, 30n);
  assert.deepEqual([held.ok, held.semantics, held.zeroAddressChainBalance], [true, 'zero-address-holds', '30']);
  const none = verifyErc20Supply(replayErc20([e20(ZERO, X, 1000), e20(X, ZERO, 200)]), 800n, 0n);
  assert.deepEqual([none.ok, none.semantics], [true, 'burn-reduces-supply']);
  const bad = verifyErc20Supply(r, 800n, 31n);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /balanceOf\(zero address\) 31/);
  // tokens missing from every holder (created without an event) fail the identity whatever the zero balance is
  assert.equal(verifyErc20Supply(replayErc20([e20(ZERO, X, 100)]), 150n, 0n).ok, false);
});

test('a dropped transfer between two holders keeps the supply identity but fails the per-holder balance comparison', () => {
  const full = [e20(ZERO, X, 100), e20(X, Y, 40), e20(Y, Z, 10)];
  const dropped = full.filter((_, k) => k !== 2);
  const r = replayErc20(dropped);
  assert.ok(verifyErc20Supply(r, 100n).ok);
  const onChain = new Map([[X, 60n], [Y, 30n], [Z, 10n]]);
  const diff = diffBalances(onChain, (a) => r.balances.get(a) ?? 0n);
  assert.deepEqual(diff.map((d) => d.holder).sort(), [Y, Z].sort());
  assert.deepEqual(diffBalances(onChain, (a) => replayErc20(full).balances.get(a) ?? 0n), []);
});

test('ERC721 replay: mint, transfer, burn; counted per owner; zero address excluded', () => {
  const r = replayErc721([e721(ZERO, X, 1), e721(ZERO, X, 2), e721(ZERO, Y, 3), e721(X, Y, 2), e721(Y, ZERO, 3), e721(Y, DEAD, 2)]);
  assert.equal(r.owned, 2);
  assert.deepEqual([...r.counts].sort(), [[X, 1], [DEAD, 1]].sort());
  assert.equal(r.owners.get('1'), X);
  assert.equal(r.owners.get('2'), DEAD);
  assert.ok(!r.owners.has('3'));
});

test('ERC721 replay lets a burned id be minted again but refuses inconsistent histories', () => {
  const again = replayErc721([e721(ZERO, X, 7), e721(X, ZERO, 7), e721(ZERO, Y, 7)]);
  assert.equal(again.owners.get('7'), Y);
  assert.equal(again.counts.has(X), false);
  assert.throws(() => replayErc721([e721(ZERO, X, 1), e721(Y, Z, 1)]), /owned by/);
  assert.throws(() => replayErc721([e721(X, Y, 9)]), /no owner/);
  assert.throws(() => replayErc721([e721(ZERO, X, 1), e721(ZERO, Y, 1)]), /already owned/);
});

test('ERC721 supply check: match, mismatch, and no totalSupply (left to the ownerOf sample)', () => {
  const r = replayErc721([e721(ZERO, X, 1), e721(ZERO, X, 2)]);
  assert.equal(verifyErc721Supply(r, 2n).ok, true);
  const bad = verifyErc721Supply(r, 3n);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /owned tokens 2 != totalSupply 3/);
  assert.equal(verifyErc721Supply(r, null).ok, null);
});

test('mixed topic counts are read for either declared type and counted as anomalies', () => {
  const indexedValue = e721(ZERO, X, 50); // 4 topics on an ERC20 token: value is in the third indexed slot
  const dataId = { b: 1, i: idx++, t: [TRANSFER_TOPIC, topic(ZERO), topic(Y)], d: u256(8) }; // 3 topics on an ERC721: id is in data
  const r20 = replayErc20([indexedValue, e20(X, Y, 20)]);
  assert.deepEqual([r20.balances.get(X), r20.balances.get(Y), r20.anomalies], [30n, 20n, 1]);
  const r721 = replayErc721([dataId, e721(ZERO, X, 9)]);
  assert.deepEqual([r721.owners.get('8'), r721.owners.get('9'), r721.anomalies], [Y, X, 1]);
  assert.equal(parseTransfer(e20(X, Y, 3), 'erc20').anomalous, false);
  assert.equal(parseTransfer(e721(X, Y, 3), 'erc721').anomalous, false);
});

test('malformed Transfer logs are refused, not guessed at', () => {
  const ok = e20(X, Y, 1);
  assert.throws(() => parseTransfer({ ...ok, t: ok.t.slice(0, 2) }, 'erc20'), /unexpected Transfer log shape/);
  assert.throws(() => parseTransfer({ ...ok, t: [...ok.t, ok.t[2], ok.t[2]] }, 'erc20'), /unexpected Transfer log shape/);
  assert.throws(() => parseTransfer({ ...ok, t: ['0x' + '11'.repeat(32), ...ok.t.slice(1)] }, 'erc20'), /unexpected Transfer log shape/);
  assert.throws(() => parseTransfer({ ...ok, d: '0x1234' }, 'erc20'), /expected 32/);
  assert.throws(() => parseTransfer({ ...ok, t: [ok.t[0], '0x' + '11'.repeat(32), ok.t[2]] }, 'erc20'), /bad address topic/);
});

test('candidate addresses are every sender and receiver, zero address excluded, sorted, unique', () => {
  const c = candidateAddresses([e20(ZERO, Z, 5), e20(Z, X, 2), e20(X, ZERO, 1), e721(Y, X, 4)]);
  assert.deepEqual(c, [X, Y, Z]);
});

test('log windows: gaps are found and refused; overlap, duplicates and stray logs are refused', () => {
  const w = (from, to, logs = []) => ({ from, to, logs });
  assert.deepEqual(computeGaps([], 10, 20), [{ from: 10, to: 20 }]);
  assert.deepEqual(computeGaps([w(10, 12), w(16, 20)], 10, 20), [{ from: 13, to: 15 }]);
  assert.deepEqual(computeGaps([w(5, 30)], 10, 20), []);
  assert.deepEqual(computeGaps([w(10, 14)], 10, 20), [{ from: 15, to: 20 }]);
  assert.throws(() => assembleLogs([w(10, 12), w(16, 20)], 10, 20), /gaps/);
  assert.throws(() => assembleLogs([w(10, 15), w(15, 20)], 10, 20), /overlapping/);
  const l = (b, i) => ({ b, i, t: [], d: '0x' });
  assert.throws(() => assembleLogs([w(10, 20, [l(11, 1), l(11, 1)])], 10, 20), /duplicate log/);
  assert.throws(() => assembleLogs([w(10, 12, [l(13, 0)]), w(13, 20)], 10, 20), /outside its window/);
  const out = assembleLogs([w(13, 20, [l(15, 2), l(14, 9)]), w(10, 12, [l(12, 0)])], 10, 20);
  assert.deepEqual(out.map((x) => [x.b, x.i]), [[12, 0], [14, 9], [15, 2]]);
  // a cached window that runs past the pinned block is trimmed to it
  assert.deepEqual(assembleLogs([w(10, 30, [l(15, 0), l(25, 0)])], 10, 20).map((x) => x.b), [15]);
});

test('provider log rows normalise: hex fields, missing index, lowercase topics', () => {
  const n = normalizeLog({ blockNumber: '0x10', logIndex: '0x', topics: [TRANSFER_TOPIC.toUpperCase().replace('0X', '0x')], data: '0x' });
  assert.deepEqual([n.b, n.i, n.t[0]], [16, 0, TRANSFER_TOPIC]);
});

test('multicall aggregate3 encoding is well-formed and its decoder reads a Result[]', () => {
  const t1 = A(0x11); const t2 = A(0x22);
  const c1 = callData('70a08231', addrWord(X));
  const c2 = '0x18160ddd';
  const enc = encodeAggregate3([{ target: t1, data: c1 }, { target: t2, data: c2 }]).slice(2);
  const w = (p) => BigInt('0x' + enc.slice(8 + p * 2, 8 + p * 2 + 64));
  assert.equal(enc.slice(0, 8), '82ad56cb');
  assert.equal(w(0), 32n);
  assert.equal(w(32), 2n);
  const e0 = 64 + Number(w(64));
  const e1 = 64 + Number(w(96));
  assert.deepEqual([w(e0) === BigInt(t1), w(e0 + 32), w(e0 + 64), w(e0 + 96)], [true, 1n, 96n, 36n]);
  assert.equal(enc.slice(8 + (e0 + 128) * 2, 8 + (e0 + 128) * 2 + 72), c1.slice(2));
  assert.deepEqual([w(e1) === BigInt(t2), w(e1 + 96)], [true, 4n]);
  assert.equal(enc.slice(8 + (e1 + 128) * 2, 8 + (e1 + 128) * 2 + 8), '18160ddd');
  // Result[]: [(true, 32-byte value), (false, empty)]
  const ret = '0x' + [32, 2, 64, 64 + 128, 1, 64, 32, 7, 0, 64, 0].map((n) => uintWord(n)).join('');
  const dec = decodeAggregate3(ret);
  assert.deepEqual(dec.map((d) => d.success), [true, false]);
  assert.equal(decodeUint(dec[0].data), 7n);
  assert.equal(dec[1].data, '0x');
});

test('return decoders: uint, address, string and bytes32-string', () => {
  assert.equal(decodeUint(u256(5)), 5n);
  assert.equal(decodeUint('0x'), null);
  assert.equal(decodeAddress('0x' + '00'.repeat(12) + 'ab'.repeat(20)), '0x' + 'ab'.repeat(20));
  const str = '0x' + uintWord(32) + uintWord(4) + Buffer.from('Test').toString('hex').padEnd(64, '0');
  assert.equal(decodeString(str), 'Test');
  assert.equal(decodeString('0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0')), 'MKR');
  assert.equal(decodeString('0x'), null);
});

test('the bytecode probe is the expected runtime code', () => {
  assert.match(CODESIZE_PROBE, /^0x5f5b36/);
  assert.equal((CODESIZE_PROBE.length - 2) % 2, 0);
});

test('amount formatting and shares use exact integer arithmetic', () => {
  assert.equal(formatUnits(1234500000000000000n, 18), '1.2345');
  assert.equal(formatUnits(5n, 18), '0.000000000000000005');
  assert.equal(formatUnits(42n, 0), '42');
  assert.equal(formatUnits(0n, 18), '0');
  assert.equal(fmtAmount(1234567000000000000000000n, 18), '1,234,567');
  assert.equal(pctOf(1n, 3n), '33.3333%');
  assert.equal(pctOf(0n, 5n), '0.0000%');
  assert.equal(pctOf(5n, 5n), '100.0000%');
  assert.equal(pctOf(1n, 0n), '0.0000%');
});

test('sampling is deterministic per seed and returns distinct items', () => {
  const seed = '0xb88b988668823d36ebc40369591f6aad7f77116f32681a1996aad2a6b44d1bef';
  const arr = Array.from({ length: 500 }, (_, k) => k);
  const s1 = sampleN(arr, 100, makeRng(seed));
  const s2 = sampleN(arr, 100, makeRng(seed));
  assert.deepEqual(s1, s2);
  assert.equal(new Set(s1).size, 100);
  assert.notDeepEqual(s1, sampleN(arr, 100, makeRng('0x' + '12'.repeat(32))));
  assert.equal(sampleN([1, 2, 3], 10, makeRng(seed)).length, 3);
});

test('holder rows: balance descending, ties by address, contract and blacklist flags, delegation stub noted', () => {
  const bal = new Map([[X, 10n], [Y, 30n], [Z, 10n], [DEAD, 5n]]);
  const rows = buildHolderRows(bal, {
    blacklist: new Set([DEAD, Y]),
    codeInfo: new Map([[X, { contract: true, delegated: false }], [Z, { contract: false, delegated: true }], [Y, { contract: false, delegated: false }]]),
  });
  assert.deepEqual(rows.map((r) => r.address), [Y, X, Z, DEAD]);
  assert.deepEqual(rows.map((r) => r.balance), ['30', '10', '10', '5']);
  assert.deepEqual(rows.map((r) => r.isContract), [false, true, false, false]);
  assert.deepEqual(rows.map((r) => r.blacklisted), [true, false, false, true]);
  assert.equal(rows[2].delegated, true);
  assert.equal('delegated' in rows[0], false);
});

test('summary reports contract, blacklisted and self balances and lists non-blacklisted contract holders', () => {
  const TOK = A(0x99);
  const bal = new Map([[X, 400n], [Y, 300n], [TOK, 200n], [Z, 100n]]);
  const rows = buildHolderRows(bal, {
    blacklist: new Set([TOK, X]),
    codeInfo: new Map([[X, { contract: true }], [Y, { contract: true }], [TOK, { contract: true }]]),
  });
  const file = { n: 6, address: TOK, type: 'erc20', name: 'Tok', symbol: 'TK', decimals: 2, snapshotBlock: 5, snapshotBlockHash: '0x' + 'ab'.repeat(32), totalSupply: '1000', method: 'replay', holderCount: rows.length, holders: rows };
  const st = tokenStats(file, TOK);
  assert.deepEqual([st.contractSum, st.blSum, st.self, st.contractNonBlSum, st.contractNonBlCount], [900n, 600n, 200n, 300n, 1]);
  const md = renderSummary([file], { snapshotBlock: 5, snapshotBlockHash: file.snapshotBlockHash, snapshotTimeIso: '2026-01-01T00:00:00.000Z', blacklistCount: 2 });
  assert.match(md, /held by blacklisted addresses: 6 \(60\.0000%\)/);
  assert.match(md, /balance of the token contract itself: 2 \(20\.0000%\)/);
  assert.match(md, /held by contracts: 9 \(90\.0000%\)/);
  const cand = md.split('Largest non-blacklisted contract holders')[1];
  assert.ok(cand.includes(Y) && !cand.includes(X) && !cand.includes(TOK));
});

test('error classification of the messages the public nodes and the explorer actually return', () => {
  assert.deepEqual(classifyError('ranges over 10000 blocks are not supported on free plan', 35), { kind: 'big', hint: 10000 });
  assert.deepEqual(classifyError('query exceeds max block range 100000', -32602), { kind: 'big', hint: 100000 });
  assert.equal(classifyError('query returned more than 10000 results', -32005).kind, 'big');
  assert.equal(classifyError('Query Timeout occured. Please select a smaller result dataset').kind, 'big');
  assert.equal(classifyError('Result window is too large, PageNo x Offset size must be less than or equal to 10000').kind, 'big');
  assert.equal(classifyError('Archive requests require a personal token.', -32602).kind, 'noarchive');
  assert.equal(classifyError("Can't route your request to suitable provider", 12).kind, 'noarchive');
  assert.equal(classifyError('rpc method is not whitelisted').kind, 'unsupported');
  assert.equal(classifyError('Method not found', -32601).kind, 'unsupported');
  assert.equal(classifyError('Max calls per sec rate limit reached (5/sec)').kind, 'rate');
  assert.equal(classifyError('error code: 1015').kind, 'rate');
  assert.equal(classifyError('execution reverted', 3).kind, 'revert');
  assert.equal(classifyError('Invalid API Key').kind, 'fatal');
  assert.equal(classifyError('something else entirely').kind, 'other');
});

test('the blacklist file is 65 unique lowercase addresses and carries the pinned entries', () => {
  const set = loadBlacklist(BLACKLIST);
  assert.equal(set.size, 65);
  for (const a of [
    '0x000000000000000000000000000000000000dead', '0xe9b1cfea55baa219e34301f2f31b9fd0921664ed', '0xf142cfa6ca3dfa4a131f12aacef4890e390d70d6',
    '0x00000000000007c8612ba63df8ddefd9e6077c97', '0x147cf09e7373b8fda6f12021f1b0f98d6da1a566', '0xa6d2351d519c0f5576c18628eed5c69d9943dcd8',
  ]) assert.ok(set.has(a), a);
  const raw = JSON.parse(readFileSync(BLACKLIST, 'utf8'));
  assert.equal(raw.length, new Set(raw).size);
});

test('token table keeps the owner priority order and types', () => {
  assert.deepEqual(TOKENS.map((t) => t.n), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(TOKENS.map((t) => t.type), ['erc20', 'erc20', 'erc721', 'erc20', 'erc721', 'erc20', 'erc20']);
  assert.deepEqual(TOKENS.map((t) => t.address.slice(0, 9)), ['0x00a6ba9', '0xe9b1cfe', '0x0000000', '0x0000000', '0x0000000', '0xf142cfa', '0x883d646']);
  assert.ok(TOKENS.every((t) => /^0x[0-9a-f]{40}$/.test(t.address)));
  assert.equal(new Set(TOKENS.map((t) => t.address)).size, 7);
});

const ID = A(0xe9b1cfea);
const IDT = idTopic(ID);
const e6909 = (from, to, amount, id = IDT, b = 100) => ({ b, i: idx++, t: [TRANSFER_6909_TOPIC, topic(from), topic(to), id], d: '0x' + topic(A(0xca11)).slice(2) + u256(amount).slice(2) });

test('singleton stream: replays one id (mint via create, transfers, burn) and refuses other ids and shapes', () => {
  const parse = (l) => parseTransfer6909(l, IDT);
  const r = replayErc20([e6909(ZERO, X, 1000), e6909(X, Y, 300), e6909(Y, Z, 100), e6909(Z, ZERO, 40)], parse);
  assert.deepEqual([...r.balances].sort(), [[X, 700n], [Y, 200n], [Z, 60n]].sort());
  assert.equal(r.zeroBalance, 40n);
  assert.equal(r.minted, 1000n);
  assert.throws(() => replayErc20([e6909(ZERO, X, 5, idTopic(A(0x77)))], parse), /another id/);
  assert.throws(() => replayErc20([e20(ZERO, X, 5)], parse), /unexpected singleton Transfer log shape/);
  assert.throws(() => replayErc20([{ ...e6909(ZERO, X, 5), d: u256(5) }], parse), /expected 64/);
  assert.throws(() => replayErc20([e6909(X, Y, 1)], parse), /underflow/);
});

test('the 4-topic singleton event is not mistaken for an ERC721 Transfer, and the id topic is the left-padded token address', () => {
  assert.notEqual(TRANSFER_6909_TOPIC, TRANSFER_TOPIC);
  assert.match(TRANSFER_6909_TOPIC, /^0x1b3d7edb2e9c0b0e/);
  assert.equal(IDT, '0x' + '00'.repeat(12) + ID.slice(2));
  assert.throws(() => parseTransfer(e6909(ZERO, X, 5), 'erc721'), /unexpected Transfer log shape/);
});

test('log filters: the token itself, or the singleton restricted to the token id', () => {
  const plain = logFilter(TOKENS[0]);
  assert.deepEqual([plain.address, plain.topic0, plain.topic3], [TOKENS[0].address, TRANSFER_TOPIC, null]);
  const single = logFilter(TOKENS[1]);
  assert.deepEqual([single.address, single.topic0, single.topic3], [TOKENS[1].singleton, TRANSFER_6909_TOPIC, idTopic(TOKENS[1].address)]);
  assert.notEqual(plain.key, single.key);
  assert.equal(TOKENS.filter((t) => t.singleton).length, 1);
});

test('CLI rejects bad arguments before touching the network', () => {
  const run = (...args) => { try { execFileSync('node', [TOOL, ...args], { stdio: 'pipe', env: { ...process.env, ETHERSCAN_KEY: '' } }); return { code: 0 }; } catch (e) { return { code: e.status, err: String(e.stderr) }; } };
  assert.equal(run('--only', '9').code, 2);
  assert.equal(run('--block', 'abc').code, 2);
  assert.equal(run('--nope').code, 2);
  assert.match(run('--only', '0').err, /token numbers/);
});
