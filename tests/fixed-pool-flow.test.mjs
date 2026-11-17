// dapp/fixed-pool-flow.js against a stand-in wallet and stand-in pools: the first nonce is found, every
// signature is asked for before any transaction goes out, a batch is used where the wallet offers one, a pool
// that is not the pool it is listed as stops the deposit before anything is signed or sent, and a wallet whose
// signature changes between requests is refused.
//
// Run: node tests/fixed-pool-flow.test.mjs

import { register } from 'node:module';
// the page's modules import each other by site path ("/x.js?cb="); this maps those to dapp/
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));

const { makeFlow, newSession, parseEther, formatEther } = await import('../dapp/fixed-pool-flow.js');
const { planSplit, FIXED_POOLS, parseNoteString, deriveSecrets, commitmentBytes32 } = await import('../dapp/fixed-pool-notes.js');
import { keccak_256, secp, hexToBytes, bytesToHex, concatBytes } from '../dapp/vendor/tacit-deps.min.js';

let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`); };
const rejects = async (p, re) => {
  try { await p; } catch (e) { if (!re.test(e.message)) throw new Error(`wrong error: ${e.message}`); return e; }
  throw new Error('did not throw');
};
const assert = (c, m = 'assertion failed') => { if (!c) throw new Error(m); };
const E = 10n ** 18n;
const enc = new TextEncoder();
const sel = (s) => bytesToHex(keccak_256(enc.encode(s)).slice(0, 4));

// ---- a wallet that signs for real, over stand-in pools ---------------------------------------------------
const KEY = hexToBytes('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
const ACCOUNT = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const word = (n) => hexToBytes(BigInt(n).toString(16).padStart(64, '0'));
function digestOf(td) {
  const d = td.domain;
  const sep = keccak_256(concatBytes(keccak_256(enc.encode('EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)')),
    keccak_256(enc.encode(d.name)), keccak_256(enc.encode(d.version)), word(d.chainId), hexToBytes(d.salt.slice(2))));
  const st = keccak_256(concatBytes(keccak_256(enc.encode('TornadoCashNote(uint64 nonce)')), word(td.message.nonce)));
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), sep, st));
}
const signReal = async (json) => {
  const sig = await secp.signAsync(digestOf(JSON.parse(json)), KEY);
  return '0x' + bytesToHex(sig.toCompactRawBytes()) + (sig.recovery + 27).toString(16);
};

function world({ chainId = 11155111, atomic = false, flaky = false, wrongDenomination = null, noCode = null, failSendAt = null, flakyReceipts = 0, flakyCommitments = 0 } = {}) {
  const pools = new Map(FIXED_POOLS[chainId].map((p) => [p.address.toLowerCase(), { ...p, seen: new Set(), spent: new Set() }]));
  const log = { signs: 0, sends: [], batches: [], calls: 0, rc: 0, cm: 0 };
  let flip = 0;
  const provider = {
    async request({ method, params = [] }) {
      switch (method) {
        case 'eth_signTypedData_v4': {
          log.signs++;
          const sig = await signReal(params[1]);
          if (!flaky) return sig;
          // a different but valid-looking signature on every call
          return sig.slice(0, 66 + 62) + (flip++ % 2 ? '01' : '02') + sig.slice(66 + 64);
        }
        case 'eth_getCode': return noCode && params[0].toLowerCase() === noCode.toLowerCase() ? '0x' : '0x6080';
        case 'eth_call': {
          log.calls++;
          const { to, data } = params[0];
          const p = pools.get(to.toLowerCase());
          if (!p) return '0x';
          const s = data.slice(2, 10), arg = data.slice(10);
          if (s === sel('denomination()')) {
            const d = wrongDenomination && wrongDenomination.toLowerCase() === to.toLowerCase() ? p.denomination * 2n : p.denomination;
            return '0x' + d.toString(16).padStart(64, '0');
          }
          if (s === sel('commitments(bytes32)')) { if (log.sends.length && log.cm++ < flakyCommitments) throw new Error('rpc busy'); return '0x' + (p.seen.has(arg) ? '1' : '0').padStart(64, '0'); }
          if (s === sel('isSpent(bytes32)')) return '0x' + (p.spent.has(arg) ? '1' : '0').padStart(64, '0');
          throw new Error('unknown call ' + s);
        }
        case 'wallet_getCapabilities':
          if (!atomic) throw new Error('method not supported');
          return { ['0x' + chainId.toString(16)]: { atomic: { status: 'supported' } } };
        case 'wallet_sendCalls': {
          const req = params[0];
          if (req.atomicRequired !== true || req.version !== '2.0.0') throw new Error('batch request malformed');
          log.batches.push(req);
          for (const c of req.calls) land(c);
          return { id: '0xbatch' };
        }
        case 'wallet_getCallsStatus': return { status: 200 };
        case 'eth_sendTransaction': {
          const tx = params[0];
          if (failSendAt !== null && log.sends.length === failSendAt) throw new Error('User rejected the request.');
          log.sends.push(tx);
          land(tx);
          return '0x' + String(log.sends.length).padStart(64, '0');
        }
        case 'eth_getTransactionReceipt': if (log.rc++ < flakyReceipts) throw new Error('rpc busy'); return { status: '0x1' };
        default: throw new Error('unexpected ' + method);
      }
    },
  };
  function land(c) {
    const p = pools.get(c.to.toLowerCase());
    if (!p) throw new Error('deposit to an unknown pool');
    if (BigInt(c.value) !== p.denomination) throw new Error('wrong value');
    if (c.data.slice(0, 10) !== '0xb214faa5') throw new Error('not a deposit');
    p.seen.add(c.data.slice(10));
  }
  return { provider, pools, log };
}
const flow = (w, chainId = 11155111, extra = {}) => makeFlow({ provider: w.provider, account: ACCOUNT, chainId, poll: 1, timeout: 2000, ...extra });
const planFor = (eth, chainId = 11155111, o = { minDenominationWei: E / 10n }) => planSplit(parseEther(eth), chainId, o);

console.log('notes made without sending');
await test('prepareNotes signs for each number and returns the calls, and sends nothing', async () => {
  const w = world(); const f = flow(w);
  const notes = await f.prepareNotes(planFor('0.3'));
  eq(notes.length, 3); eq(w.log.sends.length, 0, 'nothing sent'); eq(w.log.batches.length, 0);
  eq(notes.map((n) => n.nonce).join(), '0,1,2');
  for (const n of notes) {
    eq(n.call.to, n.pool.address); eq(n.call.value, n.pool.denomination);
    eq(n.call.data, '0xb214faa5' + commitmentBytes32(n.secrets.commitment).slice(2), 'the deposit call carries this note\'s commitment');
    eq(w.pools.get(n.pool.address.toLowerCase()).seen.size, 0, 'no pool has it yet');
  }
});
await test('landedNotes keeps the notes whose commitment is in the pool, and the next deposit starts after them', async () => {
  const w = world(); const store = new Map(); const st = { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v) };
  const f = flow(w, 11155111, { store: st });
  const notes = await f.prepareNotes(planFor('0.3'));
  // only the first two reach their pool
  for (const n of notes.slice(0, 2)) w.pools.get(n.pool.address.toLowerCase()).seen.add(commitmentBytes32(n.secrets.commitment).slice(2));
  const ok = await f.landedNotes(notes, { wait: false });
  eq(ok.length, 2); eq(ok.map((n) => n.nonce).join(), '0,1');
  const out = await flow(w, 11155111, { store: st }).deposit(planFor('0.1'));
  eq(out.notes[0].nonce, 2, 'numbering continues after the notes that landed');
});
await test('a note that never lands is not counted, and does not move the hint', async () => {
  const w = world(); const f = flow(w);
  const notes = await f.prepareNotes(planFor('0.1'));
  eq((await f.landedNotes(notes, { wait: false })).length, 0);
});

console.log('amounts');
await test('parseEther and formatEther', () => {
  eq(parseEther('100.001234'), 100n * E + 1234n * 10n ** 12n);
  eq(parseEther('0.1'), E / 10n); eq(parseEther('.5'), E / 2n); eq(parseEther('5.'), 5n * E);
  for (const bad of ['', '.', 'abc', '1e3', '-1', '1.0000000000000000001', '1 2']) eq(parseEther(bad), null, bad);
  eq(formatEther(100n * E + 1234n * 10n ** 12n), '100.001234'); eq(formatEther(E / 10n), '0.1'); eq(formatEther(0n), '0');
});

await test('commas are read as the Pay page reads them: a decimal comma is a decimal point, thousands separators are taken out, an ambiguous one is not an amount', () => {
  eq(parseEther('1,5'), E * 3n / 2n, '1,5 is 1.5, not 15'); eq(parseEther('12,5'), E * 25n / 2n); eq(parseEther('0,5'), E / 2n);
  eq(parseEther('1,000.5'), 1000n * E + E / 2n); eq(parseEther('1,000,000'), 1000000n * E); eq(parseEther('12,345.67'), 12345n * E + 67n * E / 100n);
  for (const amb of ['1,000', '1,500', '1,2,3', '1,5,', ',,', '1,00,000', '1.000,5']) eq(parseEther(amb), null, amb + ' is ambiguous or malformed');
});

console.log('deposit');
await test('three 0.1 notes in order, one transaction each, from nonce 0', async () => {
  const w = world(); const f = flow(w);
  const out = await f.deposit(planFor('0.3'));
  eq(out.sent, 'sequential'); eq(w.log.sends.length, 3); eq(out.notes.length, 3);
  eq(out.notes.map((n) => n.nonce).join(), '0,1,2');
  for (const n of out.notes) {
    const pool = w.pools.get(n.pool.address.toLowerCase());
    eq(pool.seen.has(commitmentBytes32(n.secrets.commitment).slice(2)), true, 'commitment landed');
    const back = parseNoteString(n.text);
    eq(back.commitment, n.secrets.commitment); eq(back.amount, '0.1'); eq(back.chainId, 11155111);
  }
});
await test('every signature is asked for before the first transaction', async () => {
  const w = world(); let signsAtFirstSend = null;
  const orig = w.provider.request;
  w.provider.request = async (r) => { if (r.method === 'eth_sendTransaction' && signsAtFirstSend === null) signsAtFirstSend = w.log.signs; return orig(r); };
  await flow(w).deposit(planFor('0.3'));
  eq(signsAtFirstSend, 4, 'three notes plus the one repeated check'); // nonce 0 twice, nonces 1 and 2 once; the scan's own probes reuse them
});
await test('the next deposit starts after the last: nonces continue from the earlier notes', async () => {
  const w = world();
  await flow(w).deposit(planFor('0.2'));
  const out = await flow(w).deposit(planFor('0.1'));
  eq(out.notes[0].nonce, 2);
});
await test('a wallet that batches sends one atomic batch', async () => {
  const w = world({ atomic: true });
  const out = await flow(w).deposit(planFor('0.3'));
  eq(out.sent, 'batch'); eq(w.log.batches.length, 1); eq(w.log.batches[0].calls.length, 3); eq(w.log.sends.length, 0);
});
await test('a single note is a plain transaction even where batches exist', async () => {
  const w = world({ atomic: true });
  const out = await flow(w).deposit(planFor('0.1'));
  eq(out.sent, 'sequential'); eq(w.log.sends.length, 1);
});
await test('an amount with no whole notes sends nothing', async () => {
  const w = world();
  const out = await flow(w).deposit(planSplit(E / 2n, 11155111));
  eq(out.notes.length, 0); eq(w.log.signs, 0); eq(w.log.sends.length, 0);
});

console.log('refusals');
await test('a pool that takes another amount stops everything before a signature', async () => {
  const w = world({ wrongDenomination: FIXED_POOLS[11155111][0].address });
  await rejects(flow(w).deposit(planFor('0.1')), /takes 0\.2 ETH, not 0\.1 ETH/);
  eq(w.log.signs, 0); eq(w.log.sends.length, 0);
});
await test('an address with no code stops everything before a signature', async () => {
  const w = world({ noCode: FIXED_POOLS[11155111][0].address });
  await rejects(flow(w).deposit(planFor('0.1')), /No pool at/);
  eq(w.log.signs, 0); eq(w.log.sends.length, 0);
});
await test('a wallet whose signature changes is refused, and nothing is sent', async () => {
  const w = world({ flaky: true });
  await rejects(flow(w).deposit(planFor('0.1')), /signs the same request differently/);
  eq(w.log.sends.length, 0);
});
await test('flows given one session sign each note number once and check the wallet once; flows with none do both again', async () => {
  const w = world(); const session = newSession();
  const out = await flow(w, 11155111, { session }).deposit(planFor('0.1'));
  eq(w.log.signs, 3, 'nonce 0 twice (the check), nonce 1 once (the gap)');
  const note = { nonce: out.notes[0].nonce, pool: out.notes[0].pool.address };
  const after = w.log.signs;
  const text = await flow(w, 11155111, { session }).noteText(note);
  eq(w.log.signs, after, 'taking the note out after depositing it asks for nothing');
  eq(text, out.notes[0].text, 'and gives the same note');
  eq(await flow(w).noteText(note), text, 'a flow without the session gets the same note'); eq(w.log.signs, after + 2, 'but signs it twice');
  await flow(w, 11155111, { session }).noteText({ nonce: 7, pool: note.pool });
  eq(w.log.signs, after + 3, 'a number not signed before is asked for once, with no second check');
});
await test('a wallet refused for signing differently is refused again through the same session, and nothing is kept as checked', async () => {
  const w = world({ flaky: true }); const session = newSession();
  await rejects(flow(w, 11155111, { session }).deposit(planFor('0.1')), /signs the same request differently/);
  eq(session.checked, false); eq(session.sigs.size, 0, 'no signature of a wallet that failed the check is kept');
  await rejects(flow(w, 11155111, { session }).deposit(planFor('0.1')), /signs the same request differently/);
});
await test('a step says it signs only where the wallet will be asked', async () => {
  const w = world(); const session = newSession(), seen = [];
  const run = () => flow(w, 11155111, { session }).deposit(planFor('0.1'), { onStep: (s) => seen.push(s) });
  await run();
  const first = seen.splice(0).filter((s) => s.step === 'probe' || s.step === 'sign');
  assert(first.length >= 3); eq(first[0].step, 'probe'); eq(first[0].signs, true, 'the first number is new'); eq(first.find((s) => s.step === 'sign').signs, false, 'the note itself was signed for in the scan');
  await run();
  const again = seen.filter((s) => s.step === 'probe');
  eq(again.find((s) => s.n === 0).signs, false, 'number 0 was signed for already'); eq(again.some((s) => s.signs === true), true, 'a number past the last one is new');
});
await test('a receipt read that fails once after the transaction was sent does not make the deposit a failure (a retry would deposit it again)', async () => {
  const w = world({ flakyReceipts: 2 }); const f = flow(w);
  const out = await f.deposit(planFor('0.2'));
  eq(out.notes.length, 2); eq(w.log.sends.length, 2, 'each note was sent once');
});
await test('commitment reads that fail after the deposits were sent are asked again, and the notes are returned', async () => {
  const w = world({ flakyCommitments: 3 }); const f = flow(w);
  const out = await f.deposit(planFor('0.1'));
  eq(out.notes.length, 1); eq(w.log.sends.length, 1);
});
await test('a rejected second transaction keeps the first, and says so', async () => {
  const w = world({ failSendAt: 1 });
  const e = await rejects(flow(w).deposit(planFor('0.3')), /rejected/);
  eq(e.done.length, 1); eq(e.notes.length, 3);
  const found = await flow(w).scan();
  eq(found.found.length, 1); eq(found.found[0].nonce, 0);
});

console.log('find');
await test('scan finds every earlier note, with its pool and nonce', async () => {
  const w = world();
  await flow(w).deposit(planFor('0.1'));
  await flow(w).deposit(planFor('1', 11155111, { minDenominationWei: E }));
  const { found, next } = await flow(w).scan();
  eq(found.length, 2); eq(next, 2);
  eq(found.map((n) => n.pool.denomination).join(), `${E / 10n},${E}`);
  eq(found.every((n) => n.spent === false), true);
});
await test('a spent note is marked spent', async () => {
  const w = world();
  const out = await flow(w).deposit(planFor('0.1'));
  const pool = w.pools.get(out.notes[0].pool.address.toLowerCase());
  pool.spent.add(commitmentBytes32(out.notes[0].secrets.nullifierHash).slice(2));
  const { found } = await flow(w).scan();
  eq(found[0].spent, true);
});
await test('a gap of one empty number does not hide a later note', async () => {
  const w = world(); const f = flow(w);
  // a deposit under nonce 1 only, as if nonce 0 was never sent
  const sig = await f.signNonce(1);
  const pool = FIXED_POOLS[11155111][0];
  w.pools.get(pool.address.toLowerCase()).seen.add(commitmentBytes32(deriveSecrets({ signature: sig, pool: pool.address }).commitment).slice(2));
  const { found, next } = await flow(w).scan({ gap: 2 });
  eq(found.length, 1); eq(found[0].nonce, 1); eq(next, 2);
});
await test('a chain with no pools has nothing to find', async () => {
  const w = world(); const f = flow(w, 8453);
  const { found } = await f.scan({ gap: 1 });
  eq(found.length, 0);
});

console.log('the split as one transaction with one sender (depositWith)');
const landAll = (w, notes) => { for (const n of notes) w.pools.get(n.pool.address.toLowerCase()).seen.add(commitmentBytes32(n.secrets.commitment).slice(2)); };
const memStore = () => { const m = new Map(); return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v) }; };
await test('every note is signed for, one sender is called with all of them, and the notes it landed are returned with the hash', async () => {
  const w = world(); const f = flow(w);
  let got = null;
  const out = await f.depositWith(planFor('0.3'), async (notes) => { got = notes; landAll(w, notes); return '0xabc'; });
  eq(w.log.signs, 4, 'one signature a note, and one to find the next free number'); eq(got.length, 3, 'the sender got all three'); eq(w.log.sends.length, 0, 'the flow sent nothing itself');
  eq(out.hash, '0xabc'); eq(out.sent, 'one transaction'); eq(out.notes.length, 3);
  eq(out.notes.every((n) => typeof n.text === 'string' && n.text.length > 10), true, 'each note has its text');
});
await test('the next deposit starts after the notes that landed', async () => {
  const w = world(); const f = flow(w, 11155111, { store: memStore() });
  await f.depositWith(planFor('0.2'), async (notes) => { landAll(w, notes); return '0x1'; });
  const notes = await f.prepareNotes(planFor('0.1'));
  eq(notes[0].nonce, 2, 'numbers 0 and 1 are used');
});
await test('a sender that throws with nothing landed is an error that kept nothing, and the numbers are free again', async () => {
  const w = world(); const f = flow(w, 11155111, { store: memStore() });
  const e = await rejects(f.depositWith(planFor('0.2'), async () => { throw new Error('User rejected the request.'); }), /rejected/);
  eq(e.done.length, 0, 'nothing was placed'); eq(e.notes.length, 2);
  const again = await f.prepareNotes(planFor('0.1'));
  eq(again[0].nonce, 0, 'the first number is still free');
});
await test('a sender that throws after the transaction landed is not a failure: the notes are in their pools', async () => {
  const w = world(); const f = flow(w);
  const out = await f.depositWith(planFor('0.2'), async (notes) => { landAll(w, notes); throw new Error('the wallet lost its wait'); });
  eq(out.notes.length, 2); eq(out.hash, null, 'its hash is not known');
});
await test('a sender that returns a hash with a note still missing says the note is not in the pool yet, and names the notes', async () => {
  const w = world(); const f = flow(w);
  const e = await rejects(f.depositWith(planFor('0.2'), async (notes) => { landAll(w, notes.slice(0, 1)); return '0x2'; }), /not in the pool yet/);
  eq(e.done.length, 2, 'the notes are named so the caller can keep them');
});
await test('sendOne sends one call as a transaction from the account and returns its hash', async () => {
  const w = world(); const f = flow(w);
  const [n] = await f.prepareNotes(planFor('0.1'));
  const r = await f.sendOne(n.call);
  eq(w.log.sends.length, 1); eq(w.log.sends[0].from, ACCOUNT); eq(typeof r.hash, 'string');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
