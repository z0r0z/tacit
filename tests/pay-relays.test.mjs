// dapp/prove/pay-relays.js, the Pay relays card: the roster from the registry, the private route check for each relay, and an owner's controls: what is sent, in what
// order, with what gas, and what is refused before a wallet is asked. The page's own wallet, sends and reads are replaced by recorders; the registry's answers are
// built from the contract's ABI (the real answers are in tests/fixtures/relay-registry-ui.json).
//   node tests/pay-relays.test.mjs
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { secp, keccak_256, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
const { startPayRelays } = await import('../dapp/prove/pay-relays.js');
const { calls, tacText } = await import('../dapp/relay-registry-ui.js');
const { makeDoc } = await import('../dapp/relay-gateway-doc.js');
const { newGatewayKey, gatewayKeys } = await import('../dapp/sealed-request.js');

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const fx = JSON.parse(readFileSync(new URL('./fixtures/relay-registry-ui.json', import.meta.url), 'utf8'));
const E18 = 10n ** 18n;
const word = (x) => BigInt(x).toString(16).padStart(64, '0');
const ME = '0x' + 'ab'.repeat(20), OTHER = '0x' + 'cd'.repeat(20);
const RELAY1 = '0x' + '11'.repeat(20), RELAY2 = '0x' + '22'.repeat(20), RELAY3 = '0x' + '33'.repeat(20);
const encodeRelay = (e) => '0x' + word(BigInt(e.relayer)) + word(e.chainId ?? 1) + word(e.pos ?? 0) + word(BigInt(e.owner)) + word(e.exitAt ?? 0) + word(e.stake);
const encodeString = (s) => { const b = Buffer.from(s).toString('hex'); return '0x' + word(32) + word(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, '0'); };

// the page: elements the card draws into, and the wallet, reads and sends it is given
class El {
  constructor() { this.innerHTML = ''; this.hidden = true; this.listeners = {}; this.fields = new Map(); }
  addEventListener(t, f) { this.listeners[t] = f; }
  insertAdjacentHTML(_, h) { this.innerHTML += h; }
  querySelector(sel) { const m = /\.relay\[data-id="(\d+)"\] \[data-k="(\w+)"\]/.exec(sel); return m ? { value: this.fields.get(`${m[1]}:${m[2]}`) ?? '' } : null; }
}
async function page({ entries, account = ME, allowance = 0n, balance = 10_000n * E18, minStake = 1000n * E18, forwarders = [], docs = {}, failRead = false, receipt = '0x1' } = {}) {
  const els = { '#pay-box': new El(), '#pay-mine': new El(), '#pay-status': new El() };
  const S = { address: account };
  const sent = [], errors = [], toasts = [];
  const state = { entries: entries.map((e) => ({ ...e })), allowance, balance };
  let last = Promise.resolve();
  const rpc = async (method, [c]) => {
    if (failRead) throw new Error('node down');
    const d = c.data, to = c.to.toLowerCase();
    if (to === calls.balanceOf(ME).to.toLowerCase()) {
      if (d.startsWith('0x70a08231')) return '0x' + word(state.balance);
      if (d.startsWith('0xdd62ed3e')) return '0x' + word(state.allowance);
    }
    if (d.startsWith('0x06661abd')) return '0x' + word(state.entries.length);
    if (d.startsWith('0x375b3c0a')) return '0x' + word(minStake);
    if (d.startsWith('0x3222012f')) return '0x' + word(7 * 86400);
    const id = Number(BigInt('0x' + d.slice(10, 74))), e = state.entries[id - 1];
    if (d.startsWith('0xe1137f19')) return e ? encodeRelay(e) : '0x' + '00'.repeat(192);
    if (d.startsWith('0xcf5ad6e6')) return encodeString(e?.url ?? '');
    throw new Error('unexpected call ' + d.slice(0, 10));
  };
  const ctx = {
    $: (s) => els[s], esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), short: (a) => `${a.slice(0, 6)}…${a.slice(-4)}`,
    toast: (m, bad) => toasts.push({ m, bad }), rpc,
    send: async ({ to, data, gas }) => { sent.push({ to, data, gas }); if (to.toLowerCase() === calls.approve(1n).to.toLowerCase() && data.startsWith('0x095ea7b3')) state.allowance = BigInt('0x' + data.slice(74)); return '0x' + String(sent.length).padStart(64, '0'); },
    waitReceipt: async () => ({ status: receipt }), landed: (r) => r.status === '0x1', txLink: (h) => `<a>${h.slice(-4)}</a>`,
    S, connect: async () => { S.address = ME; }, busy: (btn, fn) => { last = Promise.resolve().then(fn).catch((e) => errors.push(e.message)); },
  };
  const fetchImpl = async (url) => { const m = /\/r\/1\/(0x[0-9a-f]{40})\/key$/.exec(url); const d = m && docs[m[1].toLowerCase()]; return d ? { ok: true, json: async () => ({ docs: [d] }) } : { ok: false, json: async () => ({}) }; };
  const card = startPayRelays(ctx, { forwarders, fetchImpl, now: () => 2_000_000_000 });
  await card.first;
  const click = async (act, id, fields = {}) => {
    for (const [k, v] of Object.entries(fields)) els['#pay-mine'].fields.set(`${id}:${k}`, v);
    const btn = { id: '', dataset: { act }, textContent: '', closest(s) { return s === '.relay' ? { dataset: { id: String(id) } } : this; } };
    els['#pay-mine'].listeners.click({ target: btn });
    await last;
    return btn;
  };
  return { els, S, sent, errors, toasts, card, state, click, ctx };
}
const base = (over = {}) => [
  { relayer: RELAY1, owner: ME, stake: 1000n * E18, exitAt: 0, url: 'https://one.example/1/evm-pool/keeper', ...over },
  { relayer: RELAY2, owner: OTHER, stake: 5000n * E18, exitAt: 0, url: 'https://two.example/1/evm-pool/keeper' },
  { relayer: RELAY3, owner: OTHER, stake: 500n * E18, exitAt: 0, url: 'https://three.example/1/evm-pool/keeper' },
];

await check('the roster: each listed relay with its host, stake and state, and what it takes to list one', async () => {
  const p = await page({ entries: base({ exitAt: 2_000_000_000 + 3600 }) });
  const t = p.els['#pay-box'].innerHTML;
  assert.match(t, /one\.example/); assert.match(t, /1,000 TAC · leaving, ready/); assert.match(t, /two\.example/); assert.match(t, /5,000 TAC · listed/);
  assert.match(t, /three\.example[\s\S]*500 TAC · under the minimum: not shown to wallets/);
  assert.match(t, /1,000 TAC, 7-day wait to leave/);
});
await check('a relay whose private route key a forwarder shows, signed by it, is marked reachable; one with no key is marked unusable', async () => {
  const priv = hexToBytes('21'.repeat(32));
  const addr = `0x${bytesToHex(keccak_256(secp.getPublicKey(priv, false).slice(1)).slice(12))}`;
  const key = bytesToHex(gatewayKeys(newGatewayKey()).pub);
  const doc = await makeDoc({ relayer: addr, key, sign: async (h) => { const s = await secp.signAsync(h, priv); return bytesToHex(s.toCompactRawBytes()) + (s.recovery + 27).toString(16); } });
  const entries = [{ relayer: addr, owner: OTHER, stake: 2000n * E18, exitAt: 0, url: 'https://good.example/1/evm-pool/keeper' }, { relayer: RELAY2, owner: OTHER, stake: 2000n * E18, exitAt: 0, url: 'https://nokey.example/1/evm-pool/keeper' }];
  const p = await page({ entries, forwarders: ['https://f1.test'], docs: { [addr.toLowerCase()]: doc } });
  await new Promise((r) => setTimeout(r, 30));
  const t = p.els['#pay-box'].innerHTML;
  assert.match(t, /good\.example[\s\S]*reached through the private route/);
  assert.match(t, /nokey\.example[\s\S]*no private route key: wallets cannot use it/);
});
await check('no wallet: a button to connect; connected, only the relays that wallet owns, each with its controls', async () => {
  const p = await page({ entries: base(), account: null });
  assert.match(p.els['#pay-mine'].innerHTML, /Connect your wallet to manage a relay you listed/);
  p.S.address = ME; p.card.paint();
  const m = p.els['#pay-mine'].innerHTML;
  assert.match(m, /data-id="1"/); assert.doesNotMatch(m, /data-id="2"/); assert.doesNotMatch(m, /data-id="3"/);
  for (const a of ['topup', 'url', 'exit']) assert.ok(m.includes(`data-act="${a}"`), a);
  p.S.address = '0x' + 'ee'.repeat(20); p.card.paint();
  assert.match(p.els['#pay-mine'].innerHTML, /No relay is listed with 0xeeee…eeee as its owner/);
});
await check('adding stake approves the amount first when the allowance is short, then tops up: two sends, exactly these calls and gas', async () => {
  const p = await page({ entries: base() });
  await p.click('topup', 1, { amount: '500' });
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.sent.map((s) => [s.to.toLowerCase(), s.data, s.gas]), [
    [calls.approve(500n * E18).to.toLowerCase(), calls.approve(500n * E18).data, 70_000n],
    [calls.topUp(1, 500n * E18).to.toLowerCase(), calls.topUp(1, 500n * E18).data, 160_000n],
  ]);
});
await check('with the allowance already there it is one send; with too little TAC, or no amount, or a bad one, nothing is sent and the reason is shown', async () => {
  const a = await page({ entries: base(), allowance: 10_000n * E18 });
  await a.click('topup', 1, { amount: '1,250.5' });
  assert.equal(a.sent.length, 1); assert.equal(a.sent[0].data, calls.topUp(1, 12505n * E18 / 10n).data);
  const b = await page({ entries: base(), balance: 100n * E18 });
  await b.click('topup', 1, { amount: '500' });
  assert.deepEqual(b.sent, []); assert.match(b.errors[0], /holds 100 TAC, not 500/);
  const c = await page({ entries: base() });
  for (const bad of ['', 'abc', '0', '-5']) { await c.click('topup', 1, { amount: bad }); assert.match(c.errors.at(-1), /how much TAC to add/); }
  assert.deepEqual(c.sent, []);
});
await check('changing the address checks the contract\'s rule first, refuses the same address, and otherwise sends setUrl with the new one', async () => {
  const p = await page({ entries: base() });
  await p.click('url', 1, { url: 'http://one.example/1/evm-pool/keeper' });
  assert.match(p.errors.at(-1), /start with https/);
  await p.click('url', 1, { url: 'https://one.example/1/evm-pool/keeper' });
  assert.match(p.errors.at(-1), /already/);
  assert.deepEqual(p.sent, []);
  await p.click('url', 1, { url: 'https://new.example/1/evm-pool/keeper' });
  assert.deepEqual(p.sent.map((s) => [s.data, s.gas]), [[calls.setUrl(1, 'https://new.example/1/evm-pool/keeper').data, 170_000n]]);
});
await check('leaving takes a second press to confirm and then sends startExit; the first press sends nothing', async () => {
  const p = await page({ entries: base() });
  const first = await p.click('exit', 1);
  assert.deepEqual(p.sent, []); assert.match(first.textContent, /Press again to leave/);
  await p.click('exit', 1);
  assert.deepEqual(p.sent.map((s) => [s.data, s.gas]), [[calls.startExit(1).data, 110_000n]]);
});
await check('taking the stake out is offered only when the wait is over, and sends finishExit; during the wait there is no button, only the date', async () => {
  const waiting = await page({ entries: base({ exitAt: 2_000_000_000 + 7200 }) });
  assert.doesNotMatch(waiting.els['#pay-mine'].innerHTML, /data-act="finish"/); assert.match(waiting.els['#pay-mine'].innerHTML, /can be taken out from/);
  await assert.rejects(waiting.card.act({ closest: () => ({ dataset: { id: '1' } }), dataset: { act: 'finish' } }), /wait is not over/);
  const ready = await page({ entries: base({ exitAt: 2_000_000_000 - 5 }) });
  assert.match(ready.els['#pay-mine'].innerHTML, /data-act="finish"/); assert.doesNotMatch(ready.els['#pay-mine'].innerHTML, /data-act="topup"/, 'no top up for a relay that is leaving');
  await ready.click('finish', 1);
  assert.deepEqual(ready.sent.map((s) => [s.data, s.gas]), [[calls.finishExit(1).data, 130_000n]]);
});
await check('a relay the connected wallet does not own cannot be acted on, and nothing is sent', async () => {
  const p = await page({ entries: base() });
  await assert.rejects(p.card.act({ closest: () => ({ dataset: { id: '2' } }), dataset: { act: 'exit' } }), /not owned by the connected wallet/);
  await assert.rejects(p.card.act({ closest: () => ({ dataset: { id: '99' } }), dataset: { act: 'exit' } }), /not owned/);
  assert.deepEqual(p.sent, []);
});
await check('a registry that cannot be read says so, and a failed send is reported and sends nothing more', async () => {
  const p = await page({ entries: base(), failRead: true });
  assert.match(p.els['#pay-box'].innerHTML, /could not be read/);
  const q = await page({ entries: base(), allowance: 10_000n * E18, receipt: '0x0' });
  await q.click('topup', 1, { amount: '10' });
  assert.match(q.errors.at(-1), /did not go through/);
});
console.log(`\n${n} passed`);
process.exit(0);
