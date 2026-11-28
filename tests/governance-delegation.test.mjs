// Delegation on the governance page (worker/src/governance.js): an Ethereum wallet hands the TAC it holds to another address, and the delegate's
// vote carries it. Real Ethereum signatures and the real worker module; only the chain reads and storage are stubbed.
//   - what a delegation must be (signed, fresh, not to yourself, from an address that holds TAC, once per five minutes)
//   - the delegate's vote counts its own TAC plus the delegators it carried when the proposal opened, at the snapshot block
//   - a delegator who votes takes their TAC back from the delegate on that proposal; later changes do not touch an open proposal
//   - delegation is one hop; 'all' also lets the delegate open proposals with it, 'vote' does not
//   - a balance that cannot be read fails the vote instead of counting some holders and not others

import test from 'node:test';
import assert from 'node:assert/strict';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';
import { buildGovernance, govDelegateMessage, govEthProposeMessage } from '../worker/src/governance.js';

const enc = (s) => new TextEncoder().encode(s);
const TAC = 100_000_000n;
const E18 = 10n ** 18n;
const NET = 'mainnet';
const TOKEN = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279';

// ---- people ----------------------------------------------------------------
const people = {};
const person = (name) => {
  if (people[name]) return people[name];
  const priv = sha256(enc(`gov-delegation-${name}`));
  const addr = '0x' + bytesToHex(keccak_256(secp.getPublicKey(priv, false).slice(1)).slice(12));
  return (people[name] = { name, priv, addr });
};
const signFor = async (who, msg) => {
  const m = enc(msg);
  const digest = keccak_256(concatBytes(enc(`\x19Ethereum Signed Message:\n${m.length}`), m));
  const sig = await secp.signAsync(digest, who.priv);
  return '0x' + sig.toCompactHex() + (27 + sig.recovery).toString(16);
};

// ---- stubs -------------------------------------------------------------------
function kv() {
  const m = new Map();
  return {
    _m: m,
    async get(k, type) { const v = m.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, typeof v === 'string' ? v : String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix, limit } = {}) { return { keys: [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)).slice(0, limit || 1000).map((name) => ({ name })) }; },
  };
}
const env = { REGISTRY_KV: kv(), UPLOAD_KV: kv(), PINATA_JWT: 'x', DAILY_LIMIT: '1000', GOV_TAC_ERC20_MAINNET: TOKEN };
const HEAD = 5000, SNAP = HEAD - 12, snapTag = '0x' + SNAP.toString(16);
const snap = {};     // address -> TAC held at the snapshot block (whole TAC)
const latest = {};   // address -> TAC held now
let unreadable = new Set();   // addresses whose snapshot balance cannot be read
const hex32 = (tac) => '0x' + (BigInt(tac) * E18).toString(16).padStart(64, '0');
const addrOf = (data) => '0x' + data.slice(-40);
const pinned = [];

const gov = buildGovernance({
  jsonResponse: (obj, status = 200) => ({ status, body: obj }),
  safeInt: (v, fb, { min = -Infinity, max = Infinity } = {}) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb; },
  secp, PEDERSEN_H: null, PEDERSEN_ZERO: null,
  verifySchnorr: () => false, decodeCeremonyEligibilityEnvelope: () => ({ ok: false, reason: 'not used' }), bpRangeAggVerify: () => false,
  commitmentForUtxo: async () => { throw new Error('not used'); }, verifyTacAncestry: async () => ({ ok: false }),
  apiJson: async () => ({}), chainOutspendProbe: async () => ({ spent: false }),
  fetchTipHeight: async () => 1000, hash160: () => new Uint8Array(20),
  ethCall: async (_n, _to, data) => (addrOf(data) in latest ? hex32(latest[addrOf(data)]) : hex32(0)),
  keccak256: keccak_256,
  ethBlockNumber: async () => HEAD,
  ethRpc: async () => null,
  ethCallAt: async (_e, _n, _to, data, tag) => {
    if (tag !== snapTag || unreadable.has(addrOf(data))) return null;
    return addrOf(data) in snap ? hex32(snap[addrOf(data)]) : hex32(0);
  },
  pinFileToIpfs: async (_e, bytes) => { pinned.push(JSON.parse(new TextDecoder().decode(bytes))); return { cid: 'bafyfake' }; },
  filebaseConfigured: () => true,
  CANONICAL_TAC_ASSET_ID_HEX: '00'.repeat(32),
});

// a clock the tests can move (the module reads Date.now for 'issued', the change gap and proposal times)
const REAL_NOW = Date.now.bind(Date);
let off = 0;
Date.now = () => REAL_NOW() + off * 1000;
const advance = (s) => { off += s; };

const mkReq = (method, body) => ({ method, headers: { get: () => null }, json: async () => body });
const mkUrl = (p) => new URL('https://w' + p);
const call = (method, path, body) => gov.handle(mkReq(method, body), env, mkUrl(path), NET, {});
const issuedNow = () => Math.floor(Date.now() / 1000);

async function delegate(who, to, rights = 'vote', over = {}) {
  const c = { network: NET, delegate: to ? person(to).addr : '', rights, issued: issuedNow(), ...over };
  const sigFrom = over.signer ? person(over.signer) : person(who);
  return call('POST', '/governance/delegate', { delegate: c.delegate, rights: c.rights, issued: c.issued, eth_sig: over.sig || await signFor(sigFrom, govDelegateMessage(c)) });
}
async function open(proposer, title) {
  const c = { network: NET, title, body: 'b', choices: ['Yes', 'No'], category: 'general', voting_ends_at: issuedNow() + 3 * 86400, quorum: '0', exec_target: '', exec_note: '' };
  const r = await call('POST', '/governance/proposals', { ...c, kind: 'public', eth_sig: await signFor(person(proposer), govEthProposeMessage(c)) });
  return r;
}
async function vote(who, id, choice, label = choice === 0 ? 'Yes' : 'No') {
  const msg = `Tacit governance vote\nProposal: ${id}\nChoice: ${choice} — ${label}\nThis casts a vote weighted by your public TAC balance. No funds move.`;
  return call('POST', `/governance/proposal/${id}/vote`, { kind: 'public', choice, eth_sig: await signFor(person(who), msg) });
}
const proposal = async (id) => (await call('GET', `/governance/proposal/${id}`, undefined)).body.proposal;
const withVotes = async (id) => {
  const u = mkUrl(`/governance/proposal/${id}?votes=1`);
  return (await gov.handle(mkReq('GET'), env, u, NET, {})).body.proposal;
};

// holdings (whole TAC), at the snapshot and now
const hold = (name, tac) => { snap[person(name).addr] = tac; latest[person(name).addr] = tac; };
hold('alice', 500); hold('bob', 100); hold('carol', 50); hold('dave', 30); hold('erin', 400); hold('frank', 200); hold('gina', 20); hold('zed', 0);

test('the message names the delegate, the rights and the time, and a take-back has no rights line', () => {
  const to = '0x' + 'ab'.repeat(20);
  const m = govDelegateMessage({ network: NET, delegate: to.toUpperCase().replace('0X', '0x'), rights: 'all', issued: 1700000000 });
  assert.match(m, /^Tacit governance delegation\nNetwork: mainnet\nDelegate: 0xabab/);
  assert.match(m, /Rights: vote and propose\nIssued: 1700000000\n/);
  assert.match(govDelegateMessage({ network: NET, delegate: to, rights: 'vote', issued: 1 }), /Rights: vote\n/);
  assert.doesNotMatch(govDelegateMessage({ network: NET, delegate: '', issued: 1 }), /Rights/);
  assert.match(govDelegateMessage({ network: NET, delegate: '', issued: 1 }), /Delegate: none/);
});

test('a delegation must be signed by the holder, fresh, to someone else, from an address that holds TAC', async () => {
  const bad = (r, status, re) => { assert.equal(r.status, status, JSON.stringify(r.body)); assert.match(r.body.error, re); };
  // someone else's signature recovers a different address: it is a delegation from THAT address (which holds nothing here), not from alice
  bad(await delegate('alice', 'bob', 'vote', { signer: 'zed' }), 403, /holds less than 1 TAC/);
  bad(await delegate('alice', 'bob', 'vote', { issued: issuedNow() - 3600 }), 400, /clock/);
  bad(await delegate('alice', 'bob', 'bogus'), 400, /rights/);
  bad(await call('POST', '/governance/delegate', { delegate: 'bob', rights: 'vote', issued: issuedNow(), eth_sig: '0x' + '00'.repeat(65) }), 400, /Ethereum address/);
  bad(await call('POST', '/governance/delegate', { delegate: '0x' + '0'.repeat(40), rights: 'vote', issued: issuedNow(), eth_sig: '0x' + '00'.repeat(65) }), 400, /Ethereum address/);
  // yourself
  bad(await delegate('alice', 'alice'), 400, /your own address/);
  // no TAC to hand over
  bad(await delegate('zed', 'bob'), 403, /less than 1 TAC/);
  // with the token not live the route says so
  const saved = env.GOV_TAC_ERC20_MAINNET; delete env.GOV_TAC_ERC20_MAINNET;
  assert.equal((await delegate('alice', 'bob')).status, 501);
  env.GOV_TAC_ERC20_MAINNET = saved;
});

test('delegating, changing and taking back: replays, rapid changes and no-ops', async () => {
  const ok = await delegate('alice', 'bob', 'vote');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual({ to: ok.body.delegation.to, rights: ok.body.delegation.rights }, { to: person('bob').addr, rights: 'vote' });
  // the same choice again changes nothing
  const again = await delegate('alice', 'bob', 'vote', { issued: issuedNow() + 1 });
  assert.equal(again.body.unchanged, true);
  // another choice straight away waits
  const quick = await delegate('alice', 'carol', 'vote', { issued: issuedNow() + 2 });
  assert.equal(quick.status, 429, JSON.stringify(quick.body));
  advance(301);
  // a signature older than the one on record is refused (replay of the first message)
  const replay = await delegate('alice', 'carol', 'vote', { issued: issuedNow() - 400 });
  assert.equal(replay.status, 409, JSON.stringify(replay.body));
  // taking it back, then a take-back with nothing to take back
  const back = await delegate('alice', '');
  assert.equal(back.status, 200); assert.equal(back.body.delegation, null);
  advance(301);
  assert.equal((await delegate('alice', '')).body.unchanged, true);
  const read = await call('GET', `/governance/delegation?address=${person('alice').addr}`);
  assert.equal(read.body.delegate, null);
  assert.equal((await call('GET', '/governance/delegation?address=nope')).status, 400);
});

test('a delegate votes with its own TAC and what was pointed at it when the proposal opened; a delegator who votes takes theirs back', async () => {
  advance(400);
  // alice (500) and carol (50) point at bob (100): alice with the vote only, carol too. erin (400) points at bob AFTER the proposal opens
  assert.equal((await delegate('alice', 'bob', 'vote')).status, 200);
  assert.equal((await delegate('carol', 'bob', 'vote')).status, 200);
  const opened = await open('frank', 'Delegated tally');
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const id = opened.body.id;
  advance(2);
  assert.equal((await delegate('erin', 'bob', 'vote')).status, 200);       // after the proposal: not counted on it
  advance(1);

  const v = await vote('bob', id, 0);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.weight, String((100n + 500n + 50n) * TAC), 'own 100 + alice 500 + carol 50, erin is not in it');
  assert.equal(v.body.own_weight, String(100n * TAC));
  assert.equal(v.body.delegated_weight, String(550n * TAC));
  assert.equal(v.body.delegators, 2);
  let p = await proposal(id);
  assert.equal(p.tally.total_weight, String(650n * TAC));
  assert.equal(p.tally.delegated_weight, String(550n * TAC));
  assert.equal(p.tally.voters, 1, 'one vote, carrying three holders');

  // alice votes for herself, the other way: her 500 leaves bob's vote and is her own
  const mine = await vote('alice', id, 1);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.weight, String(500n * TAC));
  p = await proposal(id);
  assert.deepEqual(p.tally.totals, [String(150n * TAC), String(500n * TAC)], 'Yes: bob 100 + carol 50; No: alice 500');
  assert.equal(p.tally.total_weight, String(650n * TAC), 'the same TAC, counted once');
  assert.equal(p.tally.voters, 2);
  assert.equal(p.tally.delegated_weight, String(50n * TAC));

  // the vote list says who each delegate carried and who has since voted
  const full = await withVotes(id);
  const bobV = full.votes.find((x) => x.voter === person('bob').addr);
  assert.equal(bobV.weight, String(150n * TAC)); assert.equal(bobV.own_weight, String(100n * TAC));
  assert.deepEqual(bobV.delegators.map((d) => [d.a === person('alice').addr ? 'alice' : 'carol', d.counted]).sort(), [['alice', false], ['carol', true]]);

  // bob changing his vote keeps the same holders; the delegator's own vote still wins
  const re = await vote('bob', id, 1);
  assert.equal(re.body.revote, true);
  assert.equal((await proposal(id)).tally.totals[1], String(650n * TAC));

  // closing it pins the votes WITH the holders each carried
  const rec = JSON.parse(env.REGISTRY_KV._m.get(`gov:p:${NET}:${id}`));
  rec.voting_ends_at = issuedNow() - 5;
  env.REGISTRY_KV._m.set(`gov:p:${NET}:${id}`, JSON.stringify(rec));
  const fin = await call('POST', `/governance/proposal/${id}/finalize`);
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  const blob = pinned.find((b) => b.schema === 'tacit-governance-result-v1' && b.id === id);
  const carried = blob.votes.find((x) => x.voter === person('bob').addr);
  assert.equal(carried.delegators.length, 2);
  assert.equal(blob.tally.delegated_weight, String(50n * TAC));
});

test('changes made after a proposal opened do not touch it, and a take-back before it opened is honoured', async () => {
  advance(400);
  // alice points at bob (set above, still in force); dave (30) pointed at bob and took it back BEFORE this proposal opens
  assert.equal((await delegate('dave', 'bob', 'vote')).status, 200);
  advance(301);
  assert.equal((await delegate('dave', '')).status, 200);
  advance(1);
  const id = (await open('frank', 'Frozen at the opening')).body.id;
  // alice takes hers back after it opened: bob's vote on this proposal still carries her
  advance(301);
  assert.equal((await delegate('alice', '')).status, 200);
  advance(1);
  const v = await vote('bob', id, 0);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  // bob's own 100, alice 500, carol 50 (still pointing at bob); not dave (took it back before), not erin (after the earlier proposal only)
  assert.equal(v.body.weight, String((100n + 500n + 50n + 400n) * TAC), 'erin pointed at bob before this one opened, so she is in it');
  assert.equal(v.body.delegators, 3);
  // and alice voting herself on it still takes her 500 back
  await vote('alice', id, 1);
  assert.equal((await proposal(id)).tally.totals[0], String((100n + 50n + 400n) * TAC));
});

test('delegation is one hop: a delegate who points elsewhere keeps what was pointed at them, and gives away only their own', async () => {
  advance(400);
  // frank (200) points at gina (20); gina points at zed (0). Gina's vote carries frank, not what gina's own delegate would carry
  assert.equal((await delegate('frank', 'gina', 'vote')).status, 200);
  assert.equal((await delegate('gina', 'zed', 'vote')).status, 200);
  advance(1);
  const id = (await open('erin', 'One hop')).body.id;
  const g = await vote('gina', id, 0);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.weight, String((20n + 200n) * TAC), 'gina: her own 20 and frank 200');
  // zed holds nothing and carries gina's 20 only if zed votes: zed's vote counts gina
  const z = await vote('zed', id, 1);
  assert.equal(z.status, 200, JSON.stringify(z.body));
  assert.equal(z.body.own_weight, '0');
  assert.equal(z.body.weight, '0', 'gina voted, so zed carries nothing: it is not counted a second time');
  // an address with no TAC and nobody pointing at it has no vote
  const nobody = await vote('dave', id, 1);
  assert.equal(nobody.status, 200, 'dave holds 30 TAC');
  hold('ivy', 0);
  const none = await vote('ivy', id, 0);
  assert.equal(none.status, 403, JSON.stringify(none.body));
});

test("'all' lets a delegate open proposals with delegated TAC toward the 100 TAC floor; 'vote' does not", async () => {
  advance(400);
  hold('lena', 10); hold('mia', 90); hold('nick', 500);
  // lena (10) is under the floor on her own
  assert.equal((await open('lena', 'Under the floor')).status, 403);
  // mia hands lena her 90 with the vote only: lena has 10 + 0 toward the floor, still short
  assert.equal((await delegate('mia', 'lena', 'vote')).status, 200);
  assert.equal((await open('lena', 'Vote only does not count')).status, 403);
  // nick hands lena 500 with the right to open proposals: now she can
  assert.equal((await delegate('nick', 'lena', 'all')).status, 200);
  const r = await open('lena', 'Opened with delegated TAC');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.proposal.proposer_pubkey, person('lena').addr);
  // upgrading mia to 'all' after a wait adds her too, and her take-back removes nick's effect only when nick takes it back
  advance(301);
  assert.equal((await delegate('nick', '')).status, 200);
  advance(1);
  assert.equal((await open('lena', 'Nick took it back')).status, 403);
  advance(301);
  assert.equal((await delegate('mia', 'lena', 'all')).status, 200);
  assert.equal((await open('lena', 'Mia and lena are 100')).status, 200, '10 own + 90 from mia is the 100 floor');
});

test('a delegator whose balance cannot be read at the snapshot fails the vote instead of being left out', async () => {
  advance(400);
  hold('opal', 300); hold('pia', 100);
  assert.equal((await delegate('opal', 'pia', 'vote')).status, 200);
  advance(1);
  const id = (await open('frank', 'Unreadable')).body.id;
  unreadable = new Set([person('opal').addr]);
  const v = await vote('pia', id, 0);
  assert.equal(v.status, 502, JSON.stringify(v.body));
  assert.match(v.body.error, /could not be read/);
  assert.equal((await proposal(id)).tally.voters, 0, 'nothing was recorded');
  unreadable = new Set();
  assert.equal((await vote('pia', id, 0)).status, 200);
});

test('the read of an address: who it points at, and who points at it with what they hold now', async () => {
  advance(400);
  hold('rae', 80); hold('sam', 20);
  assert.equal((await delegate('rae', 'sam', 'all')).status, 200);
  const sam = (await call('GET', `/governance/delegation?address=${person('sam').addr}`)).body;
  assert.equal(sam.delegate, null);
  assert.equal(sam.delegated_to_you.count, 1);
  assert.equal(sam.delegated_to_you.weight, String(80n * TAC));
  assert.deepEqual(sam.delegated_to_you.delegators.map((d) => [d.address, d.rights]), [[person('rae').addr, 'all']]);
  const rae = (await call('GET', `/governance/delegation?address=${person('rae').addr}`)).body;
  assert.equal(rae.delegate.to, person('sam').addr); assert.equal(rae.delegate.rights, 'all');
  // rae moving her TAC away leaves the delegation in place but it carries nothing now
  latest[person('rae').addr] = 0;
  assert.equal((await call('GET', `/governance/delegation?address=${person('sam').addr}`)).body.delegated_to_you.count, 0);
});
