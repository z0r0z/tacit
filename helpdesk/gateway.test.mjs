// node gateway.test.mjs -- the gateway as a process: CORS, proxy-aware client IP, the credits feed, data dir, community-nodes-only mode
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const PORT = 8792, B = `http://127.0.0.1:${PORT}`, data = mkdtempSync(path.join(tmpdir(), 'gw-')); let fails = 0;
const check = (n, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gw = spawn('node', ['server.mjs', 'serve'], { cwd: path.dirname(new URL(import.meta.url).pathname), stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, EMB: 'off', LLM_URLS: '', DATA_DIR: data, PORT: String(PORT), TRUST_PROXY: '1', DEBUG_WHOAMI: '1', RATE_PER_MIN: '1000', LEASE_HOLD_MS: '500', POINTS_MAX_DAY: '3' } });
let log = ''; gw.stderr.on('data', (d) => (log += d)); gw.stdout.on('data', (d) => (log += d));
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(250); }
  check('the gateway starts with no steady backend configured (community nodes only)', (await fetch(`${B}/health`)).ok);
  check('its data goes where DATA_DIR says', existsSync(data));
  const pre = await fetch(`${B}/ask`, { method: 'OPTIONS', headers: { origin: 'https://tacit.finance', 'access-control-request-method': 'POST' } });
  check('CORS preflight from tacit.finance is allowed', pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://tacit.finance' && /origin/i.test(pre.headers.get('vary') || ''));
  const bad = await fetch(`${B}/ask`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  check('another origin gets no allow-origin header', bad.status === 204 && !bad.headers.get('access-control-allow-origin'));
  const pub = await fetch(`${B}/stats`, { headers: { Origin: 'https://tacit.finance' } }), pubOther = await fetch(`${B}/stats`, { headers: { Origin: 'https://evil.example' } });
  check('the public stats can be read from tacit.finance (the review card on /prove/), and only from there', pub.status === 200 && pub.headers.get('access-control-allow-origin') === 'https://tacit.finance' && !pubOther.headers.get('access-control-allow-origin'));
  const r = await fetch(`${B}/ask`, { method: 'POST', headers: { origin: 'https://tacit.finance', 'content-type': 'application/json' }, body: JSON.stringify({ q: 'How many TAC will ever exist?' }) });
  const j = await r.json(); check('a question with no node and no backend gets the plain "offline" reply, with CORS headers', j.unavailable === true && r.headers.get('access-control-allow-origin') === 'https://tacit.finance');
  const w1 = await (await fetch(`${B}/whoami`, { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } })).json();
  check('behind one trusted proxy the client is the LAST forwarded entry', w1.ip === '2.2.2.2', JSON.stringify(w1));
  const w2 = await (await fetch(`${B}/whoami`, { headers: { 'x-forwarded-for': '9.9.9.9, 3.3.3.3' } })).json();
  check('an address the client invented on the left is ignored', w2.ip === '3.3.3.3');
  const w3 = await (await fetch(`${B}/whoami`)).json(); check('with no forwarded header it falls back to the socket address', /127\.0\.0\.1/.test(w3.ip));
  // Render's edge sets True-Client-IP; it wins over the forwarded list, and a malformed one is ignored
  const w4 = await (await fetch(`${B}/whoami`, { headers: { 'true-client-ip': '8.8.4.4', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } })).json();
  check('True-Client-IP is the client when the proxy sets it', w4.ip === '8.8.4.4', JSON.stringify(w4));
  const w5 = await (await fetch(`${B}/whoami`, { headers: { 'true-client-ip': 'not an ip!', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } })).json();
  check('a malformed True-Client-IP is ignored and the forwarded list is used', w5.ip === '2.2.2.2', JSON.stringify(w5));
  const v6a = await (await fetch(`${B}/whoami`, { headers: { 'true-client-ip': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' } })).json();
  const v6b = await (await fetch(`${B}/whoami`, { headers: { 'true-client-ip': '2001:0db8:0001:0002:1111::4444' } })).json();
  check('an IPv6 client is counted by its /64, so changing the address inside it changes nothing', v6a.ip === '2001:db8:1:2::/64' && v6b.ip === v6a.ip, `${v6a.ip} ${v6b.ip}`);
  // credits feed: the points service's contract
  const day = Math.floor(Date.now() / 86400000) - 1, t0 = day * 86400000 + 5000, A = '0x' + 'a1'.repeat(20);
  writeFileSync(path.join(data, 'ledger.jsonl'), [1, 2, 3, 4, 5].map((i) => JSON.stringify({ t: t0 + i, ev: 'answer', miner: A, points: 1 })).join('\n') + '\n');
  const cr = await (await fetch(`${B}/helpdesk/credits?day=${day}`)).json();
  check('credits: yesterday is over, one miner, capped at POINTS_MAX_DAY', cr.day === day && cr.over === true && cr.miners.length === 1 && cr.miners[0].miner === A && cr.miners[0].points === 3 && cr.miners[0].proofs === 5, JSON.stringify(cr));
  const today = await (await fetch(`${B}/helpdesk/credits?day=${day + 1}`)).json(); check('credits: today is not over', today.over === false);
  const fut = await fetch(`${B}/helpdesk/credits?day=${day + 5}`); check('credits: a future day is refused in the pool feed\'s words', fut.status === 400 && (await fut.json()).error === 'day must be a UTC day number, today or before');
  check('credits: no day is refused', (await fetch(`${B}/helpdesk/credits`)).status === 400);
  // a body that is not an object is refused and the process goes on answering
  for (const bodyText of ['null', '[]', '7', '"x"']) {
    for (const route of ['lease', 'submit']) {
      const r0 = await fetch(`${B}/helpdesk/${route}`, { method: 'POST', body: bodyText });
      check(`${route}: a body of ${bodyText} is refused`, r0.status === 400, `status ${r0.status}`);
    }
  }
  check('the gateway still answers after those', (await fetch(`${B}/health`)).ok);
  // the node API over HTTP
  const lb = await fetch(`${B}/helpdesk/lease`, { method: 'POST', body: JSON.stringify({ miner: 'nope' }) }); check('lease: a bad address is refused', lb.status === 400);
  const t = Date.now(); const lz = await fetch(`${B}/helpdesk/lease`, { method: 'POST', headers: { 'x-forwarded-for': '5.5.5.5' }, body: JSON.stringify({ miner: A, kinds: ['answer'] }) });
  check('lease: with no work the request is held, then answered 204', lz.status === 204 && Date.now() - t >= 400);
  const st = await (await fetch(`${B}/helpdesk/stats`)).json(); check('stats are available locally and show the node that just asked', st.online >= 1);
  // hardware reports over HTTP: counted in /health by tier, junk shrugged off, no client named
  const hwPost = (ip, hw) => fetch(`${B}/helpdesk/lease`, { method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify({ miner: A, kinds: ['answer'], hw }) });
  await Promise.all([hwPost('6.6.6.1', { ram: 64, vram: 24, cores: 16, os: 'linux', arch: 'x64' }), hwPost('6.6.6.2', { ram: 16, vram: 0, cores: 8, os: 'darwin', arch: 'arm64', unified: true }), hwPost('6.6.6.3', { ram: 'lots', os: { x: 1 } })]);
  const hl = await (await fetch(`${B}/health`)).json();
  check('health: shows the nodes online by tier and the memory they have, and nothing that names one', hl.capacity && hl.capacity.tiers.big === 1 && hl.capacity.tiers.small === 2 && hl.capacity.ramGb === 80 && hl.capacity.vramGb === 24 && !/6\.6\.6/.test(JSON.stringify(hl)), JSON.stringify(hl.capacity));
} catch (e) { console.log('FAIL gateway test crashed:', e.message, '\n', log.slice(-400)); fails++; }
finally { gw.kill(); rmSync(data, { recursive: true, force: true }); }
console.log(fails ? `${fails} gateway test(s) failed` : 'gateway: all tests passed'); process.exit(fails ? 1 : 0);
