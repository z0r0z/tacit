#!/usr/bin/env node
// tools/tac-vault-keeper.mjs when its RPC endpoint fails, against a local anvil behind small proxies that drop a connection, answer 503 or say
// "Internal error" on cue. The chain is anvil's; the proxies answer for a made-up vault, pair oracle and venues (a vault's ORACLE(), the pair's A() and B(),
// the venues' STEP(), MAX_WINDOW() and POOL()), so no contract needs deploying. One-shot runs (ONCE=1).
//
//   [KEEPER_SCRIPT=<path of an older keeper>] node tests/tac-vault-keeper-rpc.mjs
//
// What it holds the keeper to: a read that fails the way a provider does goes to the next endpoint (RPC_FALLBACKS, else SEND_RPC), and a dead endpoint costs one
// call and not every call; a read that failed is never taken for "this oracle has no venues" (that was an ALERT that the vault prices from venues the keeper does not
// record, raised while the vault's oracle was in order); a revert is the chain's answer and goes nowhere else; the start check waits out a provider's trouble and
// exits only when the endpoint says it cannot serve the proof.
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = new URL('../', import.meta.url).pathname;
const KEEPER = process.env.KEEPER_SCRIPT || join(REPO, 'tools/tac-vault-keeper.mjs');
const PORT = 25000 + Math.floor(Math.random() * 900), ANVIL = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--hardfork', 'prague', '--silent'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
const rpc = async (method, params = []) => (await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 60) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 250)); } }

await rpc('anvil_mine', ['0x12c']);   // the start check proves a block at least 1 deep, and an oracle's interval (100 blocks here) has to have ended for there to be one to look at

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const addr = (k) => '0x' + k.toString(16).padStart(40, '0');
const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const VAULT = addr(0xa1), PAIR = addr(0xa2), VA = addr(0xa3), VB = addr(0xa4), POOL = addr(0xa5);
const sel = (sig) => cast('sig', sig).toLowerCase();
const key = (to, sig) => `${to.toLowerCase()}:${sel(sig)}`;
const OK = (v) => ({ result: word(v) });
const REVERT = { error: { code: 3, message: 'execution reverted', data: '0x' } };
const FAKE = {
  [key(VAULT, 'ORACLE()')]: OK(PAIR),
  [key(VAULT, 'pendingOracle()')]: OK(0),
  [key(PAIR, 'A()')]: OK(VA),
  [key(PAIR, 'B()')]: OK(VB),
  [key(VA, 'STEP()')]: OK(100), [key(VB, 'STEP()')]: OK(100),
  [key(VA, 'MAX_WINDOW()')]: OK(28800), [key(VB, 'MAX_WINDOW()')]: OK(28800),
  [key(VA, 'POOL()')]: OK(POOL), [key(VB, 'POOL()')]: OK(POOL),
};

// A JSON-RPC endpoint in front of anvil. `fail(request, nth)` may answer 'drop' (the connection closes), '503' (an HTML error page), 'internal' (the node's
// "Internal error"), or an { error } object; `fake` overrides eth_call answers by `to:selector`. `hits` lists what it was asked.
function endpoint({ fake = FAKE, fail = () => null } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const j = JSON.parse(body);
      const call = j.method === 'eth_call' ? j.params[0] : null;
      const tag = call ? `eth_call ${(call.to || '').toLowerCase()}:${(call.data || call.input || '').slice(0, 10).toLowerCase()}` : j.method;
      hits.push(tag);
      const reply = (x) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, ...x })); };
      const f = fail(j, tag, hits.length);
      if (f === 'drop') return req.socket.destroy();
      if (f === '503') { res.writeHead(503, { 'content-type': 'text/html' }); return res.end('<!doctype html><html><body>Service Unavailable</body></html>'); }
      if (f === 'internal') return reply({ error: { code: -32603, message: 'Internal error' } });
      if (f) return reply(f);
      if (call) {
        const k = `${(call.to || '').toLowerCase()}:${(call.data || call.input || '').slice(0, 10).toLowerCase()}`;
        if (fake[k]) return reply(fake[k]);
      }
      const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(await r.text());
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, hits, server })));
}

const { RPC: _a, SEND_RPC: _b, RPC_FALLBACKS: _c, KEEPER_ACCOUNT: _d, ...BASE_ENV } = process.env;
const keeper = (env, ms = 90000) => new Promise((resolve) => {
  const p = spawn('node', [KEEPER], {
    env: { ...BASE_ENV, KEEPER_PRIV: DEPLOYER, ORACLE: `${VA},${VB}`, VAULTS: VAULT, FROM_BLOCK: '0', ONCE: '1', ALERT_WEBHOOK: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const t = setTimeout(() => p.kill('SIGKILL'), ms);
  p.on('close', (code) => {
    clearTimeout(t);
    if (process.env.SHOW) console.log(out.split('\n').filter(Boolean).map((l) => `        | ${l.slice(0, 260)}`).join('\n'));
    resolve({ code, out });
  });
});
const alerts = (out) => out.split('\n').filter((l) => / ALERT /.test(l));
const count = (hits, tag) => hits.filter((h) => h === tag).length;
const A_CALL = `eth_call ${PAIR.toLowerCase()}:${sel('A()')}`;
const isA = (_, tag) => tag === A_CALL;

// 1. Nothing wrong: the vault's oracle prices from the venues the keeper records, and it has nothing to say.
{
  const p = await endpoint();
  const r = await keeper({ RPC: p.url });
  ok(r.code === 0 && !alerts(r.out).length, `a healthy endpoint: no alert, a clean exit (${alerts(r.out).join(' | ') || `exit ${r.code}`})`);
  ok(!/is failing|oracle check failed/.test(r.out), 'and nothing about the endpoint');
  p.server.close();
}

// 2. A() cannot be read once (the connection drops), with no other endpoint: the keeper must not conclude that the oracle has no venues.
{
  const p = await endpoint({ fail: (j, tag) => (isA(j, tag) ? 'drop' : null) });
  const r = await keeper({ RPC: p.url, RPC_FALLBACKS: '' });
  ok(!alerts(r.out).length, `a dropped A() read raises no "not recorded here" alert (${alerts(r.out).join(' | ') || 'no alerts'})`);
  ok(/oracle check failed: Error: error sending request/.test(r.out), 'it says the check failed, and tries again at the next scan');
  p.server.close();
}

// 3. The same, with a second endpoint: the read goes there, the answer is the right one, and the first endpoint is named once.
{
  const p = await endpoint({ fail: (j, tag) => (isA(j, tag) ? 'drop' : null) });
  const f = await endpoint();
  const r = await keeper({ RPC: p.url, RPC_FALLBACKS: f.url });
  ok(!alerts(r.out).length && !/oracle check failed/.test(r.out), `a dropped read is made again on the fallback and the check goes through (${alerts(r.out).join(' | ') || 'no alerts'})`);
  ok(count(f.hits, A_CALL) >= 1 && /is failing/.test(r.out) && !r.out.includes(p.url), 'the fallback was asked, the log says the endpoint is failing, and shows no URL');
  p.server.close(); f.server.close();
}

// 4. The endpoint is dead: the send endpoint (the default fallback) serves every read, and the dead one is asked once, not on every call.
{
  const p = await endpoint({ fail: () => 'drop' });
  const f = await endpoint();
  const r = await keeper({ RPC: p.url, SEND_RPC: f.url });
  ok(r.code === 0 && !alerts(r.out).length, `a dead RPC: the run completes on SEND_RPC with no alert (exit ${r.code}; ${alerts(r.out).join(' | ') || 'no alerts'})`);
  ok(p.hits.length <= 2 && f.hits.length > 10, `the dead endpoint was asked ${p.hits.length} time(s) and the other ${f.hits.length}`);
  ok((r.out.match(/is failing/g) || []).length === 1, 'the log says it once');
  p.server.close(); f.server.close();
}

// 5. A rate limit or error page (cast gives up with "Max retries exceeded HTTP error 503") is a provider's trouble too, and so is "Internal error".
{
  const p = await endpoint({ fail: (j, tag) => (isA(j, tag) ? '503' : null) });
  const f = await endpoint();
  const r = await keeper({ RPC: p.url, RPC_FALLBACKS: f.url });
  ok(!alerts(r.out).length && /Max retries exceeded HTTP error 503/.test(r.out) && count(f.hits, A_CALL) >= 1, `an HTML 503 fails over (${alerts(r.out).join(' | ') || 'no alerts'})`);
  p.server.close();
  const q = await endpoint({ fail: (j, tag) => (isA(j, tag) ? 'internal' : null) });
  const r2 = await keeper({ RPC: q.url, RPC_FALLBACKS: f.url });
  ok(!alerts(r2.out).length && /Internal error/.test(r2.out) && count(f.hits, A_CALL) >= 2, `a node's "Internal error" fails over (${alerts(r2.out).join(' | ') || 'no alerts'})`);
  q.server.close(); f.server.close();
}

// 6. A revert is the chain's answer: the oracle has no A(), so it is its own venue (still an alert, when the keeper does not record it), and the fallback is not asked.
{
  const fake = { ...FAKE, [key(PAIR, 'A()')]: REVERT };
  const p = await endpoint({ fake });
  const f = await endpoint({ fake });
  const r = await keeper({ RPC: p.url, RPC_FALLBACKS: f.url });
  const a = alerts(r.out).find((l) => l.includes('not recorded here'));
  ok(a && a.toLowerCase().includes(PAIR.toLowerCase()), `an oracle that reverts on A() is its own venue, and not being recorded is still said (${a || 'no alert'})`);
  ok(count(f.hits, A_CALL) === 0 && !/is failing/.test(r.out), 'a revert is not repeated on the fallback and does not count as the endpoint failing');
  p.server.close(); f.server.close();
}

// 7. The start check waits out a provider's trouble (the first requests are dropped) and goes on; it exits when the endpoint says it cannot serve the proof.
{
  const p = await endpoint({ fail: (j, tag, nth) => (nth <= 4 ? 'drop' : null) });
  const r = await keeper({ RPC: p.url, RPC_FALLBACKS: '', START_RETRY_SECONDS: '1' });
  ok(r.code === 0 && /start check: the endpoint is failing/.test(r.out) && !/does not serve eth_getProof/.test(r.out), `a start that meets dropped connections waits and goes on (exit ${r.code})`);
  p.server.close();
  // Nodes that disagree on the proof window: the first proofs come back as error 4444 and a later one is served, so the start waits and goes on.
  let asked = 0;
  const w = await endpoint({ fail: (j) => (j.method === 'eth_getProof' && ++asked <= 3 ? { error: { code: 4444, message: 'distance to target block exceeds maximum proof window' } } : null) });
  const rw = await keeper({ RPC: w.url, RPC_FALLBACKS: '', START_RETRY_SECONDS: '1' });
  ok(rw.code === 0 && /start check: the endpoint is failing[^\n]*maximum proof window/.test(rw.out) && !/does not serve eth_getProof/.test(rw.out), `a proof window that one node refuses and the next serves does not end the start (exit ${rw.code})`);
  w.server.close();
  // A window that stays shorter than the oldest proof asked for: the start goes on with the depth it is served and says so, and ends only when no depth is served.
  const tip = Number(BigInt(await rpc('eth_blockNumber')));
  const WINDOW_ERR = { error: { code: 4444, message: 'distance to target block exceeds maximum proof window' } };
  const s = await endpoint({ fail: (j) => (j.method === 'eth_getProof' && Number(BigInt(j.params[2])) < tip - 100 ? WINDOW_ERR : null) });
  const rs = await keeper({ RPC: s.url, RPC_FALLBACKS: '', START_RETRY_SECONDS: '1', PROOF_WINDOW_TRIES: '2' });
  ok(rs.code === 0 && alerts(rs.out).some((l) => /RPC proves \d+ of the \d+ blocks back/.test(l)) && !/does not serve eth_getProof/.test(rs.out), `a window shorter than the oldest proof goes on with the depth it serves and says how far (exit ${rs.code}; ${alerts(rs.out).join(' | ') || 'no alert'})`);
  s.server.close();
  const z = await endpoint({ fail: (j) => (j.method === 'eth_getProof' ? WINDOW_ERR : null) });
  const rz = await keeper({ RPC: z.url, RPC_FALLBACKS: '', START_RETRY_SECONDS: '1', PROOF_WINDOW_TRIES: '2' });
  ok(rz.code === 2 && /does not serve eth_getProof for old blocks/.test(rz.out), `a window that serves no depth still ends the start (exit ${rz.code})`);
  z.server.close();
  const q = await endpoint({ fail: (j) => (j.method === 'eth_getProof' ? { error: { code: -32000, message: 'missing trie node' } } : null) });
  const r2 = await keeper({ RPC: q.url, RPC_FALLBACKS: '', START_RETRY_SECONDS: '1' });
  ok(r2.code === 2 && /does not serve eth_getProof for old blocks/.test(r2.out) && !/start check: the endpoint is failing/.test(r2.out), `an endpoint that cannot serve the proof still ends the start (exit ${r2.code})`);
  q.server.close();
}

// 8. An oracle that takes a proof (no slots(): TacProvenOracle) is named in ORACLE: the keeper says it only watches it and still goes on to the oracle it records (listed after
// it, so that an abort at the first would never reach it). A slots() read that merely failed is not taken for that.
{
  const VP = addr(0xa6);
  const two = (a, b) => ({ result: word(a) + word(b).slice(2) });
  const fake = {
    ...FAKE,
    [key(PAIR, 'A()')]: OK(VP), [key(PAIR, 'B()')]: OK(VA),
    [key(VP, 'STEP()')]: OK(50), [key(VP, 'MAX_WINDOW()')]: OK(28800), [key(VP, 'POOL()')]: OK(POOL), [key(VP, 'slots()')]: REVERT,
    [key(VA, 'slots()')]: two(1, 2), [key(VA, 'sampleOf(uint256)')]: two(1, 1),
  };
  const sampleVA = `eth_call ${VA.toLowerCase()}:${sel('sampleOf(uint256)')}`;
  const p = await endpoint({ fake });
  const r = await keeper({ RPC: p.url, RPC_FALLBACKS: '', ORACLE: `${VP},${VA}` });
  ok(r.code === 0 && !alerts(r.out).length && !/oracle read failed/.test(r.out), `a proven oracle in ORACLE raises no alert and no read failure (exit ${r.code}; ${alerts(r.out).join(' | ') || 'no alerts'})`);
  ok(new RegExp(`${VP} takes proofs and not records`).test(r.out) && (r.out.match(/takes proofs and not records/g) || []).length === 1, 'the keeper says once that it only watches it');
  ok(count(p.hits, sampleVA) >= 1, `and it went on to record-check the other oracle (${count(p.hits, sampleVA)} sampleOf reads)`);
  p.server.close();
  const q = await endpoint({ fake, fail: (j, tag) => (tag === `eth_call ${VA.toLowerCase()}:${sel('slots()')}` ? 'drop' : null) });
  const r2 = await keeper({ RPC: q.url, RPC_FALLBACKS: '', ORACLE: `${VP},${VA}` });
  ok(new RegExp(`${VA} oracle read failed`, 'i').test(r2.out) && !new RegExp(`${VA} takes proofs`, 'i').test(r2.out), 'a slots() read that dropped is a failed read, not a proven oracle');
  q.server.close();
}

console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
