// dapp/confidential-relay.js with other relays (confidential-deployments.js `relays`): a new job goes to the base relay while it proves
// and sends, else to the first other one that does; a job another relay took carries its address, so its status and landing go back to it.
// And every listed relay is in the connect-src of each page that talks to the relay, or the browser would refuse it.
// Run: node --test tests/relay-list.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeConfidentialRelay } from '../dapp/confidential-relay.js';
import { CONFIDENTIAL_DEPLOYMENTS } from '../dapp/confidential-deployments.js';

const HOME = 'https://api.tacit.finance', ALT = 'https://relay.example.org', ALT2 = 'https://relay2.example.org';

function net(states) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    const u = new URL(url), at = u.origin, reply = (b, s = 200) => ({ ok: s < 400, status: s, text: async () => JSON.stringify(b) });
    if (u.pathname === '/confidential/relay') return states[at] ? reply({ state: states[at], proving: states[at] !== 'paused', settling: states[at] === 'ok' }) : reply({}, 502);
    if (u.pathname === '/confidential/submit') return reply({ ok: true, jobId: 'j1', status: 'pending' });
    if (u.pathname === '/confidential/status') return reply({ jobId: u.searchParams.get('id'), status: 'settled', txHash: '0xab' });
    if (u.pathname === '/confidential/landed') return reply({ ok: true, status: 'settled' });
    return reply({}, 404);
  };
  return { calls, fetchImpl };
}

test('the base relay takes a new job while it proves and sends', async () => {
  const n = net({ [HOME]: 'ok', [ALT]: 'ok' });
  const r = makeConfidentialRelay({ base: HOME, others: [ALT], fetchImpl: n.fetchImpl });
  const s = await r.submitOp({ type: 'transfer', op: {}, mode: 'prove' });
  assert.equal(s.jobId, 'j1');
  assert.ok(n.calls.some((c) => c.url === `${HOME}/confidential/submit`));
  assert.ok(!n.calls.some((c) => c.url.startsWith(ALT + '/confidential/submit')));
});

test('with the base relay paused or down, the first other relay that works takes it, and what follows the job goes back to it', async () => {
  for (const home of ['paused', null, 'held']) {
    const n = net({ [HOME]: home, [ALT]: 'down', [ALT2]: 'ok' });
    const r = makeConfidentialRelay({ base: HOME, others: [ALT, ALT2], fetchImpl: n.fetchImpl });
    const st = await r.state();
    assert.equal(st.state, 'ok', `${home}: the state said is the working relay's`);
    assert.equal(r.relayNow(), ALT2);
    const s = await r.submitOp({ type: 'transfer', op: {}, mode: 'prove' });
    assert.equal(s.jobId, `j1@${ALT2}`);
    assert.ok(n.calls.some((c) => c.url === `${ALT2}/confidential/submit`));
    const got = await r.status(s.jobId);
    assert.equal(got.jobId, s.jobId);
    assert.ok(n.calls.some((c) => c.url === `${ALT2}/confidential/status?id=j1`), 'asked of that relay, by the id it knows');
    await r.landed(s.jobId, '0xab');
    const land = n.calls.find((c) => c.url === `${ALT2}/confidential/landed`);
    assert.equal(land?.body?.jobId, 'j1');
  }
});

test('with none working, the base relay is the one said, and takes the job', async () => {
  const n = net({ [HOME]: 'paused', [ALT]: 'paused' });
  const r = makeConfidentialRelay({ base: HOME, others: [ALT], fetchImpl: n.fetchImpl });
  assert.equal((await r.state()).state, 'paused');
  assert.equal(r.relayNow(), HOME);
});

test('a relay that is not a bare https origin is not used, and an id naming an unknown relay is the base relay\'s', async () => {
  const n = net({ [HOME]: 'paused' });
  const r = makeConfidentialRelay({ base: HOME, others: ['http://relay.example.org', 'https://relay.example.org/path', 'https://a@b.org', HOME], fetchImpl: n.fetchImpl });
  assert.deepEqual(r.relays(), [HOME]);
  await r.status('x@https://evil.example');
  assert.ok(n.calls.some((c) => c.url === `${HOME}/confidential/status?id=${encodeURIComponent('x@https://evil.example')}`));
});

test('every listed relay is in the connect-src of each page that talks to the relay', () => {
  const listed = Object.values(CONFIDENTIAL_DEPLOYMENTS).flatMap((d) => d?.relays || []);
  const dapp = join(dirname(fileURLToPath(import.meta.url)), '..', 'dapp');
  const pages = [];
  const walk = (d) => { for (const x of readdirSync(d)) { const p = join(d, x); if (statSync(p).isDirectory()) { if (x !== 'node_modules') walk(p); } else if (x.endsWith('.html')) pages.push(p); } };
  walk(dapp);
  for (const p of pages) {
    const csp = readFileSync(p, 'utf8').match(/connect-src([^;"]*)/)?.[1] || '';
    if (!csp.includes('https://api.tacit.finance')) continue;
    for (const at of listed) assert.ok(csp.split(/\s+/).includes(at), `${p.slice(dapp.length + 1)} lets the page reach ${at}`);
  }
});
