// node backend.test.mjs -- gateway client logic against fake OpenAI-compatible servers (no models, no network beyond loopback)
import http from 'node:http';
import { makeBackend, BusyError } from './backend.mjs';
const servers = [];
const fake = (handler) => new Promise((res) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => { servers.push(s); res(`http://127.0.0.1:${s.address().port}`); }); });
const json = (res, o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const ok = (text, seen) => (req, res) => {
  if (req.url === '/v1/models') return json(res, { data: [{ id: 'mesh' }, { id: 'local-gguf/sha256-abc' }] });
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { const body = JSON.parse(b); seen?.push(body); json(res, { choices: [{ message: { content: text } }] }); });
};
const hang = () => (req, res) => { if (req.url === '/v1/models') return json(res, { data: [{ id: 'local-gguf/sha256-abc' }] }); /* never answers a chat */ };
const msgs = [{ role: 'user', content: 'hi' }];
let fails = 0; const check = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fails++; };

// 1. picks the mesh model id (not the virtual "mesh" one) and turns thinking off
{ const seen = []; const u = await fake(ok('hello', seen)); const b = makeBackend({ urls: [u] });
  const r = await b.chat(msgs); check('returns text', r.text === 'hello' && r.attempts === 1);
  check('uses the local-gguf model id', seen[0].model === 'local-gguf/sha256-abc');
  check('sends enable_thinking:false', seen[0].chat_template_kwargs?.enable_thinking === false); }

// 2. a hanging backend times out and the next backend answers
{ const dead = await fake(hang()); const live = await fake(ok('fallback')); const b = makeBackend({ urls: [dead, live], timeoutMs: 400 });
  const t = Date.now(); const r = await b.chat(msgs);
  check('falls back after a timeout', r.text === 'fallback' && r.backend === live && r.attempts === 2);
  check('does not wait for the hung backend', Date.now() - t < 1500); }

// 3. circuit breaker: after two failures the dead backend is tried last, so the next request is fast
{ const dead = await fake(hang()); const live = await fake(ok('x')); const b = makeBackend({ urls: [dead, live], timeoutMs: 300, maxAttempts: 3 });
  await b.chat(msgs); await b.chat(msgs); const t = Date.now(); const r = await b.chat(msgs);
  check('dead backend deprioritised after failures', r.attempts === 1 && r.backend === live && Date.now() - t < 200); }

// 4. an empty answer (all tokens spent on reasoning) counts as a failure and retries
{ let n = 0; const flaky = await fake((req, res) => { if (req.url === '/v1/models') return json(res, { data: [{ id: 'local-gguf/s' }] }); req.resume(); req.on('end', () => json(res, { choices: [{ message: { content: n++ === 0 ? null : 'second try' } }] })); });
  const b = makeBackend({ urls: [flaky] }); const r = await b.chat(msgs); check('retries an empty answer', r.text === 'second try' && r.attempts === 2); }

// 5. everything down -> throws; in-flight cap -> BusyError
{ const dead = await fake(hang()); const b = makeBackend({ urls: [dead], timeoutMs: 200, maxAttempts: 2 });
  let threw = false; try { await b.chat(msgs); } catch (e) { threw = /all backends failed/.test(e.message); } check('throws when every attempt fails', threw);
  const slow = await fake(hang()); const c = makeBackend({ urls: [slow], timeoutMs: 600, maxAttempts: 1, maxInflight: 2 });
  const p = [c.chat(msgs).catch(() => {}), c.chat(msgs).catch(() => {})]; let busy = false; try { await c.chat(msgs); } catch (e) { busy = e instanceof BusyError; }
  check('rejects with BusyError above the in-flight cap', busy); await Promise.all(p); }

// 6. no backend configured at all (community nodes only): a plain error, not a crash
{ const b = makeBackend({ urls: [] }); let msg = ''; try { await b.chat(msgs); } catch (e) { msg = e.message; } check('no backend configured fails cleanly', /no backends configured/.test(msg)); }

servers.forEach((s) => s.closeAllConnections?.() || s.close()); servers.forEach((s) => s.close());
console.log(fails ? `${fails} test(s) failed` : 'backend: all tests passed'); process.exit(fails ? 1 : 0);
