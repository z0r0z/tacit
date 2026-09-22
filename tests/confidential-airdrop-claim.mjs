// The TAC airdrop claim UI (dapp/confidential-airdrop-claim.js) driven end to end against a hand-made
// DOM and a wallet/client whose chain, wallet bridge and clock are doubles — except for one test, which
// wires the real dapp/tac-airdrop.js client against a real fixture entry to prove the calldata this UI
// sends is exactly what the client's own buildClaim/buildClaimTo produce. No jsdom, no network.
// Run: node --test tests/confidential-airdrop-claim.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeTacAirdrop, AIRDROP_DEPLOYMENTS } from '../dapp/tac-airdrop.js';
import {
  makeAirdropState, wireAirdropAnnouncement, wireAirdropTab, bannerTemplateHtml, tabTemplateHtml, BANNER_ID,
} from '../dapp/confidential-airdrop-claim.js';

const lc = (s) => String(s).toLowerCase();
const D = AIRDROP_DEPLOYMENTS[1];

// ── a DOM small enough to write by hand (same convention as tests/confidential-payout-panel.mjs) ──
class El {
  constructor(id) {
    Object.assign(this, { id, value: '', checked: false, disabled: false, textContent: '', innerHTML: '', className: '', style: {}, dataset: {} });
  }
  removeAttribute(name) {
    if (name === 'data-tone') delete this.dataset.tone;
  }
}
function domFrom(ids) {
  const map = new Map(ids.map((id) => [id, new El(id)]));
  return { el: (id) => map.get(id) || null, at: (id) => map.get(id) };
}
const bannerIds = () => [...bannerTemplateHtml().matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const tabIds = () => [...tabTemplateHtml().matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const makeBannerDom = () => domFrom([BANNER_ID, ...bannerIds()]);
const makeTabDom = () => domFrom(['airdrop-body', ...tabIds()]);

// A tiny in-memory {getItem,setItem} — real localStorage isn't a global in this Node version, and the
// dismissal behaviour is worth testing for real rather than exercising a silent no-op.
function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } };
}

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

// ── fake status objects, shaped exactly like dapp/tac-airdrop.js's status() (see its own tests) ──
const ADDR = '0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20';
const OTHER = '0x' + '77'.repeat(20);
const head = (address) => ({ address: lc(address), contract: D.address, chainId: 1, deployed: true, root: D.root, deadline: D.deadline, claimByISO: D.claimByISO || '2026-12-20T21:50:49Z' });
const notListed = (address) => ({ ...head(address), eligible: false, claimable: false, reason: 'not-listed', message: 'This address is not in the airdrop.' });
const errored = (address) => ({ ...head(address), eligible: false, claimable: false, reason: 'error', message: 'could not reach Ethereum', error: { code: 'rpc', message: 'could not reach Ethereum' } });
const claimable = (address, over = {}) => ({
  ...head(address), eligible: true, claimable: true, index: 978, amountWei: '216176408192580000000000',
  amountTac: '216176.40819258', claimed: false, paused: false, open: true, funded: true, canShield: true,
  secondsLeft: 5_000_000, proof: [], reason: null, message: null, ...over,
});
const claimed = (address) => claimable(address, { claimed: true, claimable: false, reason: 'claimed', message: 'This allocation has already been claimed.' });
const paused = (address) => claimable(address, { paused: true, claimable: false, reason: 'paused', message: 'Claims are paused.' });
const unfunded = (address) => claimable(address, { funded: false, claimable: false, reason: 'unfunded', message: 'The airdrop contract does not hold enough TAC to pay this claim.' });
const closed = (address) => claimable(address, { open: false, claimable: false, reason: 'closed', message: 'The claim window has closed.', secondsLeft: 0 });

// A hand-written double of ux.tacAirdrop: everything the module actually calls, nothing else.
function fakeAir({ statusByAddress, waitClaimedImpl, deployed = true } = {}) {
  const calls = { status: [], buildClaim: [], buildClaimTo: [], claim: [], claimTo: [], waitClaimed: [] };
  const air = {
    config: { deployed, chainId: 1, address: D.address, token: D.token, pool: D.pool, root: D.root, deadline: D.deadline, decimals: 18, unitScale: D.unitScale, claimByISO: '2026-12-20T21:50:49Z', proofsBase: [] },
    async status(address) {
      calls.status.push(address);
      return typeof statusByAddress === 'function' ? statusByAddress(address) : statusByAddress;
    },
    async buildClaim(address) { calls.buildClaim.push(address); return { from: lc(address), to: D.address, data: '0xaaclaim', value: '0x0' }; },
    async buildClaimTo(address, to) { calls.buildClaimTo.push([address, to]); return { from: lc(address), to: D.address, data: '0xaaclaimto', value: '0x0' }; },
    async claim(address, opts) {
      calls.claim.push({ address, opts });
      const tx = await air.buildClaim(address);
      const txHash = await opts.send(tx);
      return { txHash, tx, index: 978, amountWei: '216176408192580000000000' };
    },
    async claimTo(address, to, opts) {
      calls.claimTo.push({ address, to, opts });
      const tx = await air.buildClaimTo(address, to);
      const txHash = await opts.send(tx);
      return { txHash, tx, index: 978, amountWei: '216176408192580000000000' };
    },
    async waitClaimed(address, opts) {
      calls.waitClaimed.push({ address, opts });
      return waitClaimedImpl ? waitClaimedImpl(address, opts) : { claimed: true };
    },
    formatTac: (w) => (Number(w) / 1e18).toString(),
  };
  return { air, calls };
}
function fakeUx(air) { return { tacAirdrop: air, rpc: async () => '0x5b8d80' }; }
function fakeEth({ connectAddress = ADDR, sendImpl } = {}) {
  const sent = [];
  return {
    sent,
    connect: async () => ({ address: connectAddress }),
    sendTx: async (tx) => { sent.push(tx); return sendImpl ? sendImpl(tx) : '0x' + 'cd'.repeat(32); },
  };
}

// ═══════════════════════════ makeAirdropState ═══════════════════════════

test('makeAirdropState: no address means no status and no chain read', async () => {
  const { air, calls } = fakeAir({ statusByAddress: () => notListed(ADDR) });
  const state = makeAirdropState();
  assert.equal(state.address, null);
  assert.equal(state.status, null);
  assert.equal(state.checking, false);
  await state.refresh(air);
  assert.equal(calls.status.length, 0, 'no address, no read');
});

test('makeAirdropState: setAddress fetches once, caches, and force bypasses the cache', async () => {
  const { air, calls } = fakeAir({ statusByAddress: (a) => claimable(a) });
  const state = makeAirdropState();
  let notified = 0;
  state.onChange(() => { notified++; });
  await state.setAddress(ADDR, air);
  assert.equal(state.address, ADDR.toLowerCase());
  assert.equal(calls.status.length, 1);
  assert.equal(state.status.eligible, true);
  assert.ok(notified > 0, 'listeners fire on the fetch');

  await state.refresh(air);
  assert.equal(calls.status.length, 1, 'a plain refresh reuses the cached status');

  await state.refresh(air, { force: true });
  assert.equal(calls.status.length, 2, 'force bypasses the cache');
});

test('makeAirdropState: a rejecting status() becomes reason: "error", never a throw', async () => {
  const air = { async status() { throw new Error('rpc down'); } };
  const state = makeAirdropState();
  await state.setAddress(ADDR, air);
  assert.equal(state.status.reason, 'error');
  assert.match(state.status.message, /rpc down/);
});

test('makeAirdropState: setAddress(null) clears address and status without reading the chain', async () => {
  const { air, calls } = fakeAir({ statusByAddress: () => claimable(ADDR) });
  const state = makeAirdropState();
  await state.setAddress(ADDR, air);
  await state.setAddress(null, air);
  assert.equal(state.address, null);
  assert.equal(state.status, null);
  assert.equal(calls.status.length, 1, 'only the first setAddress read the chain');
});

// ═══════════════════════════ banner ═══════════════════════════

test('banner: not eligible renders nothing', async () => {
  const { air } = fakeAir({ statusByAddress: () => notListed(ADDR) });
  const dom = makeBannerDom();
  const state = makeAirdropState();
  wireAirdropAnnouncement({ ux: fakeUx(air), eth: fakeEth(), state, el: dom.el, storage: memStorage() });
  await state.setAddress(ADDR, air);
  assert.equal(dom.at(BANNER_ID).style.display, 'none');
});

test('banner: no wallet connected shows the general invite, gated on the airdrop being deployed on this network', async () => {
  const { air } = fakeAir({ deployed: true });
  const dom = makeBannerDom();
  wireAirdropAnnouncement({ ux: fakeUx(air), eth: fakeEth(), state: makeAirdropState(), el: dom.el, storage: memStorage() });
  assert.notEqual(dom.at(BANNER_ID).style.display, 'none');
  assert.match(dom.at('tac-airdrop-banner-headline').innerHTML, /airdrop is live/i);
  assert.notEqual(dom.at('tac-airdrop-banner-connect').style.display, 'none');

  const { air: notDeployed } = fakeAir({ deployed: false });
  const dom2 = makeBannerDom();
  wireAirdropAnnouncement({ ux: fakeUx(notDeployed), eth: fakeEth(), state: makeAirdropState(), el: dom2.el, storage: memStorage() });
  assert.equal(dom2.at(BANNER_ID).style.display, 'none', 'not deployed on this network — no invite either');
});

test('banner: eligible renders the exact claimable amount and a real claim-by countdown', async () => {
  const { air } = fakeAir({ statusByAddress: (a) => claimable(a) });
  const dom = makeBannerDom();
  const state = makeAirdropState();
  wireAirdropAnnouncement({ ux: fakeUx(air), eth: fakeEth(), state, el: dom.el, storage: memStorage() });
  await state.setAddress(ADDR, air);
  const html = dom.at('tac-airdrop-banner-headline').innerHTML;
  assert.match(html, /216176\.40819258 TAC/);
  assert.match(html, /57 days left/); // secondsLeft: 5_000_000 -> floor(5_000_000/86400) = 57
  assert.notEqual(dom.at(BANNER_ID).style.display, 'none');
  assert.notEqual(dom.at('tac-airdrop-banner-claim').style.display, 'none');
});

test('banner: claimed and closed go quiet — never keep advertising once it no longer applies', async () => {
  for (const build of [claimed, closed]) {
    const { air } = fakeAir({ statusByAddress: (a) => build(a) });
    const dom = makeBannerDom();
    const state = makeAirdropState();
    wireAirdropAnnouncement({ ux: fakeUx(air), eth: fakeEth(), state, el: dom.el, storage: memStorage() });
    await state.setAddress(ADDR, air);
    assert.equal(dom.at(BANNER_ID).style.display, 'none');
  }
});

test('banner: paused and unfunded still show a calm, dismissible note (the allocation is real, just not payable yet)', async () => {
  for (const build of [paused, unfunded]) {
    const { air } = fakeAir({ statusByAddress: (a) => build(a) });
    const dom = makeBannerDom();
    const state = makeAirdropState();
    wireAirdropAnnouncement({ ux: fakeUx(air), eth: fakeEth(), state, el: dom.el, storage: memStorage() });
    await state.setAddress(ADDR, air);
    assert.notEqual(dom.at(BANNER_ID).style.display, 'none');
    assert.match(dom.at('tac-airdrop-banner-headline').innerHTML, /temporarily/);
    assert.equal(dom.at('tac-airdrop-banner-claim').style.display, 'none', 'no claim button while it cannot go through');
  }
});

test('banner: dismiss persists in the injected storage and suppresses that address; a different address is unaffected', async () => {
  const { air } = fakeAir({ statusByAddress: (a) => claimable(a) });
  const storage = memStorage();
  const dom = makeBannerDom();
  const state = makeAirdropState();
  wireAirdropAnnouncement({ ux: fakeUx(air), eth: fakeEth(), state, el: dom.el, storage });
  await state.setAddress(ADDR, air);
  assert.notEqual(dom.at(BANNER_ID).style.display, 'none');

  dom.at('tac-airdrop-banner-close').onclick();
  assert.equal(dom.at(BANNER_ID).style.display, 'none', 'dismissed immediately');

  // A forced refresh (e.g. a later poll) must not resurrect it — dismissal is real UI state, not a
  // one-off skip. Re-wiring against a fresh dom simulates a reload with the same storage.
  const dom2 = makeBannerDom();
  const state2 = makeAirdropState();
  wireAirdropAnnouncement({ ux: fakeUx(air), eth: fakeEth(), state: state2, el: dom2.el, storage });
  await state2.setAddress(ADDR, air);
  assert.equal(dom2.at(BANNER_ID).style.display, 'none', 'stays dismissed for this address across a fresh mount');

  const dom3 = makeBannerDom();
  const state3 = makeAirdropState();
  wireAirdropAnnouncement({ ux: fakeUx(air), eth: fakeEth(), state: state3, el: dom3.el, storage });
  await state3.setAddress(OTHER, air);
  assert.notEqual(dom3.at(BANNER_ID).style.display, 'none', 'a different address is not silenced by someone else\'s dismissal');
});

test('banner: connecting from the invite reuses helpers.eth.connect() and checks that exact address', async () => {
  const { air, calls } = fakeAir({ statusByAddress: (a) => claimable(a) });
  const eth = fakeEth({ connectAddress: ADDR });
  const dom = makeBannerDom();
  const state = makeAirdropState();
  wireAirdropAnnouncement({ ux: fakeUx(air), eth, state, el: dom.el, storage: memStorage() });
  await dom.at('tac-airdrop-banner-connect').onclick();
  assert.equal(state.address, lc(ADDR));
  assert.deepEqual(calls.status, [lc(ADDR)]);
  assert.match(dom.at('tac-airdrop-banner-headline').innerHTML, /216176\.40819258 TAC/);
});

test('banner: no error surfaces to the user on a network failure — it just stays quiet', async () => {
  const { air } = fakeAir({ statusByAddress: () => errored(ADDR) });
  const dom = makeBannerDom();
  const state = makeAirdropState();
  wireAirdropAnnouncement({ ux: fakeUx(air), eth: fakeEth(), state, el: dom.el, storage: memStorage() });
  await state.setAddress(ADDR, air);
  assert.equal(dom.at(BANNER_ID).style.display, 'none');
});

test('banner claim: the status line says "waiting" (not "Claimed") until waitClaimed confirms on-chain, never from send() alone', async () => {
  const gate = deferred();
  const { air } = fakeAir({ statusByAddress: (a) => claimable(a), waitClaimedImpl: async () => { await gate.promise; return { claimed: true }; } });
  const eth = fakeEth();
  const dom = makeBannerDom();
  const state = makeAirdropState();
  wireAirdropAnnouncement({ ux: fakeUx(air), eth, state, el: dom.el, storage: memStorage() });
  await state.setAddress(ADDR, air);

  const clickPromise = dom.at('tac-airdrop-banner-claim').onclick();
  await flush();
  assert.equal(eth.sent.length, 1, 'the transaction was already sent');
  assert.match(dom.at('tac-airdrop-banner-status').textContent, /waiting for it to confirm/);
  assert.notEqual(dom.at(BANNER_ID).style.display, 'none', 'still shows claimable — not claimed yet');

  gate.resolve();
  await clickPromise;
  assert.equal(dom.at('tac-airdrop-banner-status').textContent, 'Claimed.');
});

test('banner claim: a send that never confirms says so plainly, and does not claim "Claimed"', async () => {
  const { air } = fakeAir({ statusByAddress: (a) => claimable(a), waitClaimedImpl: async () => ({ claimed: false, timedOut: true }) });
  const eth = fakeEth();
  const dom = makeBannerDom();
  const state = makeAirdropState();
  wireAirdropAnnouncement({ ux: fakeUx(air), eth, state, el: dom.el, storage: memStorage() });
  await state.setAddress(ADDR, air);
  await dom.at('tac-airdrop-banner-claim').onclick();
  assert.match(dom.at('tac-airdrop-banner-status').textContent, /not yet confirmed/);
  assert.doesNotMatch(dom.at('tac-airdrop-banner-status').textContent, /^Claimed/);
});

test('banner: Claim to… reveals the row, and sends to the typed address once confirmed', async () => {
  const { air } = fakeAir({ statusByAddress: (a) => claimable(a) });
  const eth = fakeEth();
  const dom = makeBannerDom();
  const state = makeAirdropState();
  wireAirdropAnnouncement({ ux: fakeUx(air), eth, state, el: dom.el, storage: memStorage() });
  await state.setAddress(ADDR, air);

  assert.equal(dom.at('tac-airdrop-banner-claimto-row').style.display, 'none');
  dom.at('tac-airdrop-banner-claimto-toggle').onclick();
  assert.notEqual(dom.at('tac-airdrop-banner-claimto-row').style.display, 'none');

  dom.at('tac-airdrop-banner-claimto-addr').value = OTHER;
  await dom.at('tac-airdrop-banner-claimto-go').onclick();
  assert.equal(eth.sent.length, 1);
  assert.equal(eth.sent[0].data, '0xaaclaimto');
  assert.match(dom.at('tac-airdrop-banner-status').textContent, /Claimed/);
});

// ═══════════════════════════ tab ═══════════════════════════

test('tab: not connected explains itself and offers to connect — never a dead end', () => {
  const { air } = fakeAir({});
  const dom = makeTabDom();
  wireAirdropTab({ ux: fakeUx(air), eth: fakeEth(), state: makeAirdropState(), el: dom.el });
  assert.notEqual(dom.at('airdrop-connect-row').style.display, 'none');
  assert.equal(dom.at('airdrop-head').style.display, 'none');
  assert.equal(dom.at('airdrop-claim-card').style.display, 'none');
});

test('tab: not eligible is a short, calm message — not an error', async () => {
  const { air } = fakeAir({ statusByAddress: (a) => notListed(a) });
  const dom = makeTabDom();
  const state = makeAirdropState();
  wireAirdropTab({ ux: fakeUx(air), eth: fakeEth(), state, el: dom.el });
  await state.setAddress(ADDR, air);
  assert.match(dom.at('airdrop-message').innerHTML, /not on the airdrop list/);
  assert.equal(dom.at('airdrop-claim-card').style.display, 'none');
});

test('tab: eligible shows the exact amount, the allocation index and a real countdown', async () => {
  const { air } = fakeAir({ statusByAddress: (a) => claimable(a) });
  const dom = makeTabDom();
  const state = makeAirdropState();
  wireAirdropTab({ ux: fakeUx(air), eth: fakeEth(), state, el: dom.el });
  await state.setAddress(ADDR, air);
  assert.equal(dom.at('airdrop-amount').textContent, '216176.40819258 TAC');
  assert.match(dom.at('airdrop-claim-meta').textContent, /allocation #978/);
  assert.match(dom.at('airdrop-claim-meta').textContent, /57 days left/);
  assert.notEqual(dom.at('airdrop-claim-card').style.display, 'none');
});

test('tab: claimed and paused read as distinct, honest states (past-tense vs temporary)', async () => {
  const { air: airClaimed } = fakeAir({ statusByAddress: (a) => claimed(a) });
  const dom1 = makeTabDom();
  const state1 = makeAirdropState();
  wireAirdropTab({ ux: fakeUx(airClaimed), eth: fakeEth(), state: state1, el: dom1.el });
  await state1.setAddress(ADDR, airClaimed);
  assert.match(dom1.at('airdrop-message').innerHTML, /already been claimed/);
  assert.equal(dom1.at('airdrop-claim-card').style.display, 'none');

  const { air: airPaused } = fakeAir({ statusByAddress: (a) => paused(a) });
  const dom2 = makeTabDom();
  const state2 = makeAirdropState();
  wireAirdropTab({ ux: fakeUx(airPaused), eth: fakeEth(), state: state2, el: dom2.el });
  await state2.setAddress(ADDR, airPaused);
  assert.match(dom2.at('airdrop-message').innerHTML, /temporarily paused/);
  assert.doesNotMatch(dom2.at('airdrop-message').innerHTML, /already been claimed/);
});

test('tab: refresh forces a fresh chain read', async () => {
  const { air, calls } = fakeAir({ statusByAddress: (a) => claimable(a) });
  const dom = makeTabDom();
  const state = makeAirdropState();
  wireAirdropTab({ ux: fakeUx(air), eth: fakeEth(), state, el: dom.el });
  await state.setAddress(ADDR, air);
  assert.equal(calls.status.length, 1);
  await dom.at('airdrop-refresh-btn').onclick();
  assert.equal(calls.status.length, 2);
});

test('tab claimTo: validates a recipient was entered before sending anything', async () => {
  const { air } = fakeAir({ statusByAddress: (a) => claimable(a) });
  const eth = fakeEth();
  const dom = makeTabDom();
  const state = makeAirdropState();
  wireAirdropTab({ ux: fakeUx(air), eth, state, el: dom.el });
  await state.setAddress(ADDR, air);
  await dom.at('airdrop-claimto-go-btn').onclick();
  assert.equal(eth.sent.length, 0);
  assert.match(dom.at('airdrop-status').textContent, /Enter a recipient/);
});

// ═══════════════════════════ calldata matches the client's own builders ═══════════════════════════
// Wires the REAL dapp/tac-airdrop.js client (not a fake) against a real, root-matching fixture entry, so
// this proves the transaction the UI actually sends is byte-identical to buildClaim/buildClaimTo — not
// just that the UI's own idea of "the tx" agrees with itself.

const FX = JSON.parse(readFileSync(new URL('./fixtures/tac-airdrop.json', import.meta.url), 'utf8'));
const REAL = FX.entries[0]; // index 978 — the same allocation exercised above, for real

const SEL = { isClaimed: '9e34070f', paused: '5c975abb', verify: '6cc1a533', balanceOf: '70a08231' };
function realChainCall() {
  return async ({ to, data }) => {
    const sel = data.slice(2, 10);
    const toL = lc(to);
    if (toL === lc(D.token) && sel === SEL.balanceOf) return '0x' + (10n ** 30n).toString(16).padStart(64, '0');
    if (toL !== lc(D.address)) return '0x';
    if (sel === SEL.isClaimed || sel === SEL.paused) return '0x' + '0'.repeat(64);
    if (sel === SEL.verify) return '0x' + '0'.repeat(63) + '1';
    return '0x'; // claim/claimTo simulate: no revert
  };
}
function realAirdrop() {
  return makeTacAirdrop({
    call: realChainCall(), keccak256: keccak_256, multicall: false, sleep: async () => {},
    fetchImpl: async (url) => {
      if (url.endsWith(`${REAL.address.slice(2, 4)}.json`)) {
        return { ok: true, status: 200, json: async () => ({ root: FX.root, claims: { [REAL.address]: { index: REAL.index, amount: REAL.amount, proof: REAL.proof } } }) };
      }
      return { ok: false, status: 404, json: async () => { throw new Error('no body'); } };
    },
    proofsBase: '/x',
  });
}

test('claim/claimTo: the transaction sent through the wallet bridge is byte-identical to the real client\'s buildClaim/buildClaimTo', async () => {
  assert.equal(FX.root, D.root, 'fixture and deployed root must match for this to mean anything');
  const air = realAirdrop();
  const eth = fakeEth({ connectAddress: '0x' + REAL.address.slice(2) });
  const dom = makeBannerDom();
  const state = makeAirdropState();
  wireAirdropAnnouncement({ ux: fakeUx(air), eth, state, el: dom.el, storage: memStorage() });
  await state.setAddress(REAL.address, air);
  assert.equal(state.status.eligible, true, 'the real proof must verify against the real root');
  assert.equal(state.status.amountTac, '216176.40819258');

  // Compare `to` + `data` — the calldata in the strict sense. `from`/`value` aren't part of that
  // comparison on purpose: helpers.eth.sendTx({from,to,data}) (the real bridge, ethNamesBridge in
  // tacit.js) never takes `value` (always '0x0' here anyway), and buildClaim() alone — unlike the
  // claim() this UI actually calls — never sets `from` because "anyone may send claim() for anyone".
  const sameCalldata = (sent, built) => { assert.equal(sent.to, built.to); assert.equal(sent.data, built.data); };

  await dom.at('tac-airdrop-banner-claim').onclick();
  const expectedClaim = await air.buildClaim(REAL.address);
  sameCalldata(eth.sent[0], expectedClaim);
  assert.equal(eth.sent[0].from, lc(REAL.address), 'this UI always claims for the connected/eligible account');

  dom.at('tac-airdrop-banner-claimto-toggle').onclick();
  dom.at('tac-airdrop-banner-claimto-addr').value = OTHER;
  await dom.at('tac-airdrop-banner-claimto-go').onclick();
  const expectedClaimTo = await air.buildClaimTo(REAL.address, OTHER);
  sameCalldata(eth.sent[1], expectedClaimTo);
  assert.equal(eth.sent[1].from, expectedClaimTo.from, 'claimTo must be sent by the recipient itself');
});
