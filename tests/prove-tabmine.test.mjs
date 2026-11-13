// node tests/prove-tabmine.test.mjs -- salt mining in a browser tab: the hashing (plain JavaScript and the WebAssembly module written out in saltcore.js) against
// noble's Keccak and the salt pool's own address check, what waits to be sent, a grinding thread's loop, the miner that sends shares, and the whole way through
// to the pool's own code counting them.
import { register } from 'node:module';
// the page's modules import by site path ("/prove/x.js?cb=..."), which this maps to dapp/
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));
import { randomBytes } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { saltAddress as poolAddress, makeSaltPool, SALT_POOL } from '../worker/src/salt-pool.js';
const C = await import('/prove/saltcore.js');
const T = await import('/prove/tabmine.js');
const G = await import('/prove/saltgpu.js');
let fails = 0; const check = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const hexOf = (b) => '0x' + C.toHex(b);

// ---- hashing
{
  let bad = 0; for (let i = 0; i < 1500; i++) { const m = randomBytes(i % 136); if (C.toHex(C.keccak256(m)) !== C.toHex(keccak_256(m))) bad++; }
  check('Keccak-256 matches noble on 1500 random messages of every length up to a block', bad === 0);
  check('a message over one block is refused, not hashed wrongly', (() => { try { C.keccak256(new Uint8Array(136)); return false; } catch { return true; } })());
  check('the empty message hashes to the known value', C.toHex(C.keccak256(new Uint8Array(0))) === 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
}
const day = C.utcDay(), prefix = Uint8Array.from(randomBytes(5));
{
  const s = C.saltOf(0x5123, Uint8Array.of(1, 2, 3, 4, 5), 0x0a0b0c0d);
  check('a salt is the deployer, a zero byte, the day (big-endian), five bytes of the grinder\'s and its counter', C.toHex(s) === C.DEPLOYER + '00' + '5123' + '0102030405' + '0d0c0b0a' && s.length === 32);
  check('the day the pool reads from a salt is the day it was made for', C.dayOfSalt(hexOf(s)) === 0x5123 && C.dayOfSalt(hexOf(C.saltOf(day, prefix, 7))) === day % 65536);
  check('the UTC day is the number the pool uses', C.utcDay(86400000 * 20770 + 5) === 20770 && C.utcDay(86400000 * 20770 - 1) === 20769);
  let bad = 0; for (let i = 0; i < 300; i++) { const salt = C.saltOf(day, prefix, (Math.random() * 2 ** 32) | 0), a = C.saltAddress(salt), p = poolAddress(hexOf(salt)); if (hexOf(a.address) !== p.address || a.bits !== p.bits) bad++; }
  check('a salt\'s address and zero bits match the pool\'s, on 300 salts', bad === 0);
  check('zero bits are counted from the first byte', C.zeroBits(Uint8Array.of(0, 0, 0x10, 0xff)) === 19 && C.zeroBits(Uint8Array.of(0x80)) === 0 && C.zeroBits(Uint8Array.of(0, 0)) === 16);
}
// ---- the grinders
{
  const js = C.makeGrinder({ day, prefix }), found = js.grind(60000, 10);
  let plain = []; for (let n = 1; n <= 60000; n++) { const b = C.saltAddress(C.saltOf(day, prefix, n)).bits; if (b >= 10) plain.push({ n, bits: b }); }
  check('the word-by-word grinder finds exactly what hashing each salt the plain way finds', JSON.stringify(found) === JSON.stringify(plain) && found.length > 20);
  check('it goes on from where it stopped', js.at() === 60000 && js.grind(1, 0)[0].n === 60001);
  const bytes = C.grinderWasm();
  check('the WebAssembly module is valid and small', WebAssembly.validate(bytes) && bytes.length < 4000);
  const w = C.makeWasmGrinder({ day, prefix }), wf = w.grind(60000, 10);
  check('the WebAssembly grinder finds the same shares as the JavaScript one', JSON.stringify(wf) === JSON.stringify(plain) && w.wasm === true && w.at() === 60000);
  const w16 = C.makeWasmGrinder({ day, prefix: Uint8Array.from(randomBytes(5)) }), f16 = w16.grind(1_200_000, 16);
  check('at the pool\'s smallest share (16 bits) every share it reports is one the pool would count', f16.length >= 5 && f16.every((f) => poolAddress(hexOf(w16.saltOf(f.n))).bits === f.bits && f.bits >= 16));
  const many = C.makeWasmGrinder({ day, prefix: Uint8Array.from(randomBytes(5)) }).grind(200_000, 8);
  check('when one call finds more than its notes hold, none are lost and the count walked is right', many.length > 600 && many.length < 950 && new Set(many.map((f) => f.n)).size === many.length && many.every((f, i) => i === 0 || f.n > many[i - 1].n));
  const k3 = C.makeWasmGrinder({ day, prefix }), j3 = C.makeGrinder({ day, prefix });
  check('a share size that is not a whole number of bytes (12, 20 bits) is filtered exactly', JSON.stringify(k3.grind(150000, 12)) === JSON.stringify(j3.grind(150000, 12)));
  check('under 8 bits is left to the JavaScript grinder', (() => { try { C.makeWasmGrinder({ day, prefix }).grind(10, 4); return false; } catch { return true; } })());
  check('the best grinder here is the WebAssembly one', C.bestGrinder({ day, prefix }).wasm === true);
  const other = C.makeWasmGrinder({ day: day - 1, prefix }).grind(60000, 10);
  check('another day walks other salts', JSON.stringify(other) !== JSON.stringify(plain));
}
// ---- what waits to be sent
{
  const sh = (bits, d = day, n = Math.floor(Math.random() * 1e9)) => ({ salt: hexOf(C.saltOf(d, prefix, n)), bits });
  const a = sh(30), b = sh(26), c = sh(41), old = sh(50, day - 2), yest = sh(27, day - 1);
  const { send, rest } = C.nextBatch([a, b, c, old, yest, { ...a }], day);
  check('the best go first, a salt is sent once, and one older than yesterday is dropped', send.map((s) => s.bits).join() === '41,30,27,26' && rest.length === 0);
  const lots = Array.from({ length: 800 }, (_, i) => sh(26 + (i % 7), day, i));
  const nb = C.nextBatch(lots, day);
  check('a send carries 64 and 640 wait; the weakest beyond that are dropped', nb.send.length === 64 && nb.rest.length === 640 && nb.send.every((s) => s.bits === 32) && Math.min(...nb.rest.map((s) => s.bits)) >= 26);
  check('the day rolls over at 65536 as the salt\'s two bytes do', C.nextBatch([sh(30, 65535)], 65536).send.length === 1 && C.nextBatch([sh(30, 65535)], 65537).send.length === 0);
}

// ---- a grinding thread
const flush = () => new Promise((r) => setTimeout(r, 0));
{
  check('a quarter of the cores by default, and up to all but one', T.defaultThreads(8) === 2 && T.defaultThreads(4) === 1 && T.defaultThreads(2) === 1 && T.defaultThreads(undefined) === 1 && T.defaultThreads(16) === 4 && T.maxThreads(8) === 7 && T.maxThreads(1) === 1 && T.maxThreads(undefined) === 1);
  const posts = [], made = []; let clock = 0, today = 100, tick = 50;
  const grinderOf = (o) => { const g = { day: o.day, prefix: o.prefix, calls: [], wasm: true, grind(count, minBits) { g.calls.push({ count, minBits }); clock += tick; return count >= 1 << 15 ? [{ n: 7, bits: minBits + 1 }] : []; }, saltOf: (n) => C.saltOf(o.day, o.prefix, n) }; made.push(g); return g; };
  let waiting = null; const rest = () => new Promise((r) => { waiting = r; });
  const step = async () => { const r = waiting; waiting = null; r(); await flush(); };
  const loop = T.makeGrindLoop({ post: (m) => posts.push(m), random: (n) => new Uint8Array(n).fill(9), now: () => clock, today: () => today, rest, grinderOf });
  loop.message({ type: 'start', minBits: 20 }); await flush();
  check('a start grinds a chunk at the share size it was given and reports it', posts.length === 1 && posts[0].type === 'work' && posts[0].hashes === 1 << 14 && posts[0].wasm === true && made[0].calls[0].minBits === 20 && made[0].day === 100);
  await step();
  check('a quick chunk doubles the next, and a share is reported as its salt and bits', posts[1].hashes === 1 << 15 && posts[1].shares.length === 1 && posts[1].shares[0].bits === 21 && posts[1].shares[0].salt === hexOf(C.saltOf(100, new Uint8Array(5).fill(9), 7)));
  tick = 900; await step(); await step();
  check('a slow chunk halves the next', posts[3].hashes === posts[2].hashes / 2);
  loop.message({ minBits: 30 }); tick = 200; await step();
  check('a new share size is used from the next chunk', made[0].calls[made[0].calls.length - 1].minBits === 30);
  loop.message({ minBits: 3 }); loop.message({ minBits: 'x' }); loop.message(null); await step();
  check('a share size out of range, or a message that is not one, changes nothing', made[0].calls[made[0].calls.length - 1].minBits === 30);
  today = 101; await step();
  check('a new UTC day starts a new run of salts for that day', made.length === 2 && made[1].day === 101);
  const n0 = posts.length; loop.message({ type: 'start' }); await flush();
  check('a second start does not start a second loop (a second one would grind a chunk at once)', posts.length === n0);
  await step();
  check('and the one loop goes on, a chunk at a time', posts.length === n0 + 1);
  const before = posts.length; loop.message({ type: 'stop' }); await step(); await flush();
  check('a stop is heard between chunks', loop.running() === false && posts.length === before && waiting === null);
  // the counter coming round: a new run before it does
  const made2 = []; let w2 = null; const loop2 = T.makeGrindLoop({ post: () => {}, random: (n) => new Uint8Array(n), now: () => 0, today: () => 5, rest: () => new Promise((r) => { w2 = r; }), grinderOf: (o) => { const g = { day: o.day, grind: () => [], saltOf: () => new Uint8Array(32) }; made2.push(g); return g; } });
  loop2.message({ type: 'start' }); await flush();
  for (let i = 0; i < 12 && made2.length < 2; i++) { for (let k = 0; k < 400; k++) { const r = w2; w2 = null; r(); await flush(); } }
  check('before the four-byte counter comes round, a new run of salts starts', made2.length === 2);
  loop2.message({ type: 'stop' }); w2?.();
  // the real thing for a moment
  const real = []; let rr = null; const loop3 = T.makeGrindLoop({ post: (m) => real.push(m), rest: () => new Promise((r) => { rr = r; }) });
  loop3.message({ type: 'start', minBits: 12 }); await flush(); rr(); await flush(); loop3.message({ type: 'stop' }); rr?.(); await flush();
  const shares = real.flatMap((m) => m.shares);
  check('a real thread\'s shares are salts of today that the pool\'s own check gives the same bits', shares.length > 3 && shares.every((s) => poolAddress(s.salt).bits === s.bits && s.bits >= 12 && C.dayOfSalt(s.salt) === C.utcDay() % 65536) && real[0].wasm === true);
}

// ---- the miner
const ADDR = '0x66F5a1225e6ac772c461f2b4d8028bf9568f3db5';
function rig({ reply = () => ({ status: 200, body: { ok: true, accepted: 0, rejected: [], today: { shares: 0, weight: 0, best: null } } }) } = {}) {
  const workers = [], calls = [], timers = []; let clock = Date.UTC(2026, 10, 13, 12), changes = 0;
  const makeWorker = () => { const w = { sent: [], dead: false, postMessage(m) { w.sent.push(m); }, terminate() { w.dead = true; }, onmessage: null }; workers.push(w); return w; };
  const fetchImpl = async (url, init) => { const body = JSON.parse(init.body); calls.push({ url, init, body }); const r = await reply(body, calls.length); if (r.throw) throw new Error('offline'); return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body }; };
  const m = T.makeTabMiner({ api: 'https://api.example', makeWorker, fetchImpl, now: () => clock, timers: { set: (f, ms) => { const t = { f, ms, on: true }; timers.push(t); return t; }, clear: (t) => { if (t) t.on = false; } }, jitter: () => 0, onChange: () => { changes++; } });
  const fire = async () => { const t = timers.filter((x) => x.on).pop(); if (!t) return null; t.on = false; clock += t.ms; await t.f(); await flush(); return t.ms; };
  const share = (bits, n = Math.floor(Math.random() * 1e9), d = C.utcDay(clock)) => ({ salt: hexOf(C.saltOf(d, prefix, n)), bits });
  const work = (w, hashes, shares = [], wasm = true) => w.onmessage({ data: { type: 'work', hashes, shares, wasm } });
  return { m, workers, calls, timers, fire, share, work, live: () => workers.filter((w) => !w.dead), tick: (ms) => { clock += ms; }, setClock: (t) => { clock = t; }, changes: () => changes, pending: () => timers.filter((x) => x.on) };
}
{
  const r = rig();
  check('it does not start without an address to pay', r.m.start({ miner: '0x12', threads: 2 }) === false && r.m.start({ miner: null }) === false && r.workers.length === 0 && r.m.state().on === false);
  check('it starts as many threads as asked, each told the share size', r.m.start({ miner: ADDR, threads: 3, minBits: 27 }) === true && r.live().length === 3 && r.workers.every((w) => w.sent[0].type === 'start' && w.sent[0].minBits === 27) && r.m.state().on && r.m.state().threads === 3 && r.m.state().miner === ADDR.toLowerCase());
  check('a send is planned about every 21 seconds', r.pending().length === 1 && r.pending()[0].ms === 21000);
  r.work(r.workers[0], 100000); r.tick(1000); r.work(r.workers[0], 100000); r.tick(1000); r.work(r.workers[1], 200000);
  check('the rate is the salts reported over the time they took', Math.round(r.m.state().rate) === 150000 && r.m.state().hashes === 400000 && r.m.state().wasm === true);
  await r.fire();
  check('with nothing found nothing is sent, and the next send is planned', r.calls.length === 0 && r.pending().length === 1);
}
{
  const r = rig({ reply: (b) => ({ status: 200, body: { ok: true, accepted: b.salts.length, weight: 5, rejected: [], today: { shares: 9, weight: 40, best: { address: '0x00', bits: 31 } } } }) });
  r.m.start({ miner: ADDR, threads: 1, minBits: 26 });
  const s1 = r.share(26), s2 = r.share(31), s3 = r.share(28);
  r.work(r.workers[0], 1000, [s1, s2]); r.work(r.workers[0], 1000, [s3]);
  check('shares found wait to be sent', r.m.state().waiting === 3 && r.changes() >= 2);
  await r.fire();
  check('a send goes to the pool for the address, the best first, as this page\'s miner', r.calls.length === 1 && r.calls[0].url === 'https://api.example/prover/salt/share' && r.calls[0].init.method === 'POST' && r.calls[0].init.headers['content-type'] === 'application/json' && r.calls[0].body.miner === ADDR.toLowerCase() && r.calls[0].body.client === 'tacit-prove-tab/1' && r.calls[0].body.salts.join() === [s2.salt, s3.salt, s1.salt].join());
  check('what the pool counted is kept: the shares it took and the address\'s day', r.m.state().accepted === 3 && r.m.state().today.shares === 9 && r.m.state().today.weight === 40 && r.m.state().waiting === 0 && r.m.state().error === null);
  for (let i = 0; i < 70; i++) r.work(r.workers[0], 10, [r.share(26 + (i % 3), 5000 + i)]);
  await r.fire();
  check('a send carries 64 at most, the best of them; the rest wait for the next', r.calls[1].body.salts.length === 64 && r.m.state().waiting === 6);
  await r.fire();
  check('and go then', r.calls[2].body.salts.length === 6 && r.m.state().waiting === 0);
  r.setClock(Date.UTC(2026, 10, 14, 0, 0, 5));
  check('yesterday\'s count is not shown as today\'s', r.m.state().today === null);
}
{
  // the pool's other answers
  let mode = '429';
  const r = rig({ reply: (b) => (mode === '429' ? { status: 429, body: { ok: false, error: 'one send every 20 s', retryMs: 7000 } } : mode === '500' ? { status: 502, body: null } : mode === 'throw' ? { throw: true } : mode === '400' ? { status: 400, body: { ok: false, error: 'miner must be the 0x address the points go to' } } : { status: 200, body: { ok: true, accepted: b.salts.length, rejected: [], today: { shares: 1, weight: 1, best: null } } }) });
  r.m.start({ miner: ADDR, threads: 1 }); r.work(r.workers[0], 10, [r.share(27), r.share(29)]);
  await r.fire();
  check('"too soon" keeps the shares and tries again when the pool says', r.m.state().waiting === 2 && r.pending()[0].ms === 7000 && r.m.state().error === null);
  mode = '500'; await r.fire();
  check('a pool that is down keeps them and says so', r.m.state().waiting === 2 && r.m.state().error === 'the salt pool did not answer' && r.pending()[0].ms === 21000);
  mode = 'throw'; await r.fire();
  check('so does a network that is', r.m.state().waiting === 2 && r.m.state().error === 'the salt pool could not be reached');
  mode = 'ok'; await r.fire();
  check('and they go once it is back, the error cleared', r.m.state().waiting === 0 && r.m.state().accepted === 2 && r.m.state().error === null && r.calls[r.calls.length - 1].body.salts.length === 2);
  mode = '400'; r.work(r.workers[0], 10, [r.share(26)]); await r.fire();
  check('a send the pool refuses outright is not sent again, and its reason is kept', r.m.state().waiting === 0 && r.m.state().error === 'miner must be the 0x address the points go to');
  mode = '429'; const huge = rig({ reply: () => ({ status: 429, body: { retryMs: 999999 } }) }); huge.m.start({ miner: ADDR }); huge.work(huge.workers[0], 1, [huge.share(26)]); await huge.fire();
  check('a wait the pool asks for is at most a minute', huge.pending()[0].ms === 60000);
}
{
  const r = rig({ reply: (b) => ({ status: 200, body: { ok: true, accepted: b.salts.length, rejected: [], today: { shares: 1, weight: 1, best: null } } }) });
  r.m.start({ miner: ADDR, threads: 2, minBits: 26 });
  r.m.setThreads(4);
  check('more threads are started when asked', r.live().length === 4 && r.m.state().threads === 4 && r.m.state().grinding === 4);
  r.m.setThreads(1);
  check('and stopped: told to stop, then ended', r.live().length === 1 && r.workers.filter((w) => w.dead).every((w) => w.sent[w.sent.length - 1].type === 'stop'));
  r.m.setThreads(0); r.m.setThreads(2.5);
  check('a thread count that is not a whole number of one or more changes nothing', r.m.state().threads === 1);
  r.m.setMinBits(28);
  check('a new share size from the pool is passed to the threads', r.live()[0].sent[r.live()[0].sent.length - 1].minBits === 28);
  const told = r.live()[0].sent.length; r.m.setMinBits(28); r.m.setMinBits(4);
  check('the same size, or one out of range, is not', r.live()[0].sent.length === told);
  r.work(r.live()[0], 500, [r.share(30)]);
  r.m.setPaused('battery');
  check('on battery the threads stop and the miner says why', r.live().length === 0 && r.m.state().paused === 'battery' && r.m.state().on === true && r.m.state().rate === 0);
  await r.fire();
  check('a share found before the pause is still sent', r.calls.length === 1 && r.calls[0].body.salts.length === 1);
  r.m.setPaused(null);
  check('back on the charger the threads start again at the share size now', r.live().length === 1 && r.live()[0].sent[0].minBits === 28 && r.m.state().paused === null);
  r.m.setMiner('0x' + '11'.repeat(20)); r.work(r.live()[0], 5, [r.share(27)]); await r.fire();
  check('a new address is the one the next send pays', r.calls[1].body.miner === '0x' + '11'.repeat(20));
  r.m.setMiner('nope');
  check('something that is not an address is not taken', r.m.state().miner === '0x' + '11'.repeat(20));
  const w = r.live()[0]; r.work(w, 5, [r.share(26), r.share(33)]);
  r.m.stop(); await flush();
  check('a stop ends the threads and sends what was found one last time', r.live().length === 0 && r.m.state().on === false && r.calls.length === 3 && r.calls[2].body.salts.length === 2 && r.pending().length === 0);
  w.onmessage({ data: { type: 'work', hashes: 1000, shares: [r.share(40)] } });
  check('a report from a thread after the stop is not counted', r.m.state().waiting === 0);
  check('it starts again', r.m.start({ miner: ADDR, threads: 1 }) === true && r.live().length === 1 && r.pending().length === 1);
  const keep = rig({ reply: (b) => ({ status: 200, body: { ok: true, accepted: 1, rejected: [], today: null } }) }); keep.m.start({ miner: ADDR }); keep.work(keep.workers[0], 1, [keep.share(26)]); keep.m.stop({ keepalive: true }); await flush();
  check('a stop as the page closes asks the browser to finish the send', keep.calls[0].init.keepalive === true);
}

// ---- the GPU: the shader's source, a thread on the GPU, and the miner's GPU thread (the shader itself runs in tests/prove-page.mjs, where there is a GPU)
{
  const w = G.grinderWgsl();
  check('the shader is a compute shader of 64 counters a group, with the permutation, the 24 round constants and a counted list of notes', w.includes('@compute @workgroup_size(64)') && w.includes('fn keccakf(') && ((w.split('\n').find((l) => l.startsWith('const RC')) || '').match(/vec2<u32>\(\d+u, \d+u\)/g) || []).length === 24 && w.includes('atomicAdd(&O.count, 1u)') && w.includes('array<u32, 255>') && w.includes('for (var r = 0u; r < 24u; r++)'));
  check('its round constants are the ones the JavaScript grinder uses (the first and the last)', w.includes('vec2<u32>(1u, 0u)') && w.includes('vec2<u32>(2147516424u, 2147483648u)'));
  check('the size of the notes is a setting, and the source is the same every time', G.grinderWgsl({ notes: 63 }).includes('array<u32, 63>') && G.grinderWgsl() === w);
  check('with no WebGPU, or no adapter, there is no GPU grinder', (await G.makeGpuGrinder({ day, prefix, gpu: undefined })) === null && (await G.makeGpuGrinder({ day, prefix, gpu: { requestAdapter: async () => null } })) === null);
}
{
  const posts = [], naps = [], made = []; let clock = 0, today = 200, tick = 20, waiting = null, fail = false, none = false;
  const gpuGrinderOf = async (o) => { if (none) return null; const g = { day: o.day, gpu: true, maxChunk: 1 << 22, n: 0, closed: false, calls: [], at: () => g.n, async grind(count, minBits) { if (fail) throw new Error('lost'); g.calls.push({ count, minBits }); const rows = Math.max(1, Math.round(count / 100000)); g.n += rows * 100000; clock += tick; return count >= 1 << 19 ? [{ n: 5, bits: minBits }] : []; }, saltOf: (n) => C.saltOf(o.day, o.prefix, n), close() { g.closed = true; } }; made.push(g); return g; };
  const rest = () => new Promise((r) => { waiting = r; });
  const step = async () => { const r = waiting; waiting = null; r?.(); await flush(); await flush(); };
  const cpuMade = []; const mk = () => T.makeGrindLoop({ post: (m) => posts.push(m), random: (n) => new Uint8Array(n).fill(3), now: () => clock, today: () => today, rest, sleep: async (ms) => { naps.push(ms); }, gpuGrinderOf, grinderOf: (o) => { cpuMade.push(o); return C.makeGrinder(o); } });
  const loop = mk();
  loop.message({ type: 'start', minBits: 26, gpu: true, duty: 0.5 }); await flush(); await flush();
  check('started with gpu, the thread grinds on the GPU and not on a core', made.length === 1 && cpuMade.length === 0 && posts.length === 1 && posts[0].gpu === true && posts[0].wasm === false);
  check('a GPU chunk starts at a quarter of a million salts, and what it reports is what the grinder walked (whole rows), not what was asked', made[0].calls[0].count === 1 << 18 && posts[0].hashes === 300000);
  check('at half, it rests as long as the chunk took', naps.length === 1 && naps[0] === 20);
  await step();
  check('a chunk well under a twentieth of a second doubles the next', made[0].calls[1].count === 1 << 19 && posts[1].shares.length === 1 && posts[1].shares[0].bits === 26);
  tick = 150; await step(); await step();
  check('one over a tenth halves it', made[0].calls[3].count === made[0].calls[2].count / 2);
  loop.message({ duty: 1 }); const napsBefore = naps.length; tick = 40; await step();
  check('at full it does not rest', naps.length === napsBefore);
  loop.message({ duty: 0.25 }); loop.message({ duty: 0 }); loop.message({ duty: 3 }); loop.message({ duty: -1 }); loop.message({ duty: 'x' }); await step();
  check('a quarter rests three times the work, and a share of the time out of range after it is not taken', naps[naps.length - 1] === 120 && naps.length === napsBefore + 1);
  tick = 20; for (let i = 0; i < 12; i++) await step();
  check('a GPU chunk stops growing at what the grinder can take in one go', Math.max(...made[0].calls.map((c) => c.count)) <= 1 << 22);
  today = 201; await step();
  check('a new day closes the GPU grinder and makes one for that day', made.length === 2 && made[0].closed === true && made[1].day === 201);
  loop.message({ type: 'stop' }); await step(); await flush();
  check('a stop lets go of the GPU', made[1].closed === true && loop.running() === false);
  // a GPU that is lost while grinding
  const before = posts.length; const loop2 = mk(); loop2.message({ type: 'start', gpu: true }); await flush(); await flush();
  fail = true; await step();
  check('a GPU lost while grinding: the thread says so, lets go of it and stops', posts[posts.length - 1].type === 'gpu' && posts[posts.length - 1].ok === false && loop2.running() === false && made[made.length - 1].closed === true && posts.length > before);
  // no GPU to be had
  fail = false; none = true; const n0 = posts.length; const loop3 = mk(); loop3.message({ type: 'start', gpu: true }); await flush(); await flush();
  check('where no GPU can be had the thread says so and grinds nothing', posts.length === n0 + 1 && posts[n0].type === 'gpu' && posts[n0].ok === false && loop3.running() === false && cpuMade.length === 0);
  const loop4 = T.makeGrindLoop({ post: (m) => posts.push(m), rest, gpuGrinderOf: async () => { throw new Error('no device'); } }); const n1 = posts.length; loop4.message({ type: 'start', gpu: true }); await flush(); await flush();
  check('so does one whose GPU fails to start', posts.length === n1 + 1 && posts[n1].type === 'gpu' && loop4.running() === false);
  const loop5 = T.makeGrindLoop({ post: (m) => posts.push(m), rest }); const n2 = posts.length; loop5.message({ type: 'start', gpu: true }); await flush(); await flush();
  check('and a thread with no GPU grinder at all', posts[n2]?.type === 'gpu' && loop5.running() === false);
}
{
  check('the GPU is off, half or full', T.GPU_LEVELS.join() === 'off,half,full');
  const r = rig({ reply: (b) => ({ status: 200, body: { ok: true, accepted: b.salts.length, rejected: [], today: { shares: 1, weight: 1, best: null } } }) });
  r.m.start({ miner: ADDR, threads: 2, minBits: 26, gpu: 'half' });
  const gw = () => r.live().find((w) => w.sent[0].gpu === true), cw = () => r.live().filter((w) => !w.sent[0].gpu);
  check('with the GPU asked for, one more thread is started for it, at half', r.live().length === 3 && cw().length === 2 && gw() && gw().sent[0].type === 'start' && gw().sent[0].duty === 0.5 && gw().sent[0].minBits === 26 && r.m.state().gpu.level === 'half' && r.m.state().gpu.on === true && r.m.state().threads === 2);
  r.work(cw()[0], 100000); r.tick(1000); r.work(cw()[0], 100000);
  gw().onmessage({ data: { type: 'work', hashes: 4_000_000, shares: [], gpu: true } }); r.tick(1000); gw().onmessage({ data: { type: 'work', hashes: 9_000_000, shares: [r.share(33)], gpu: true } });
  const st = r.m.state();
  check('what the GPU walks is counted with what the cores walk, and told apart', Math.round(st.gpu.rate) === 9_000_000 && Math.round(st.rate) === 9_000_000 + 100000 && st.waiting === 1 && st.hashes === 13_200_000);
  await r.fire();
  check('while the GPU thread runs, the pool is told so in the miner\'s name', r.calls.length === 1 && r.calls[0].body.client === 'tacit-prove-tab/1+gpu');
  r.m.setGpu('full');
  check('full is passed to the GPU thread, which goes on', gw().sent[gw().sent.length - 1].duty === 1 && r.live().length === 3 && r.m.state().gpu.level === 'full');
  r.m.setMinBits(27);
  check('a new share size reaches the GPU thread too', gw().sent[gw().sent.length - 1].minBits === 27);
  r.m.setGpu('sideways');
  check('a level that is not one changes nothing', r.m.state().gpu.level === 'full' && r.live().length === 3);
  const g1 = gw(); r.m.setGpu('off');
  check('off ends the GPU thread and leaves the cores grinding', g1.dead && g1.sent[g1.sent.length - 1].type === 'stop' && r.live().length === 2 && r.m.state().gpu.on === false && r.m.state().gpu.rate === 0);
  r.work(cw()[0], 10, [r.share(28)]); await r.fire();
  check('and without it, plainly', r.calls[r.calls.length - 1].body.client === 'tacit-prove-tab/1');
  r.m.setGpu('half'); const g2 = gw();
  check('and half starts it again', g2 && g2 !== g1 && r.live().length === 3);
  g2.onmessage({ data: { type: 'gpu', ok: false } });
  check('a GPU that cannot be had is noted, its thread ended, and the cores go on', r.m.state().gpu.failed === true && r.m.state().gpu.on === false && g2.dead && cw().length === 2 && r.changes() > 0);
  r.m.setPaused('battery'); r.m.setPaused(null);
  check('it is not tried again by itself', r.live().length === 2 && r.live().every((w) => !w.sent[0].gpu));
  r.m.setGpu('half');
  check('choosing it again tries it again', r.m.state().gpu.failed === false && r.live().length === 3);
  g1.onmessage({ data: { type: 'gpu', ok: false } }); g2.onmessage({ data: { type: 'gpu', ok: false } });
  check('a word from a GPU thread long ended does not end the one running now', r.m.state().gpu.failed === false && r.m.state().gpu.on === true && r.live().length === 3);
  r.m.setPaused('battery');
  check('on battery the GPU thread stops with the others', r.live().length === 0 && r.m.state().gpu.on === false);
  r.m.setPaused(null);
  check('and starts again with them', r.live().length === 3 && gw().sent[0].duty === 0.5);
  r.m.stop(); await flush();
  check('a stop ends it', r.live().length === 0 && r.m.state().gpu.on === false);
  const plain = rig(); plain.m.start({ miner: ADDR, threads: 1 });
  check('with nothing said about the GPU it is off', plain.live().length === 1 && plain.m.state().gpu.level === 'off' && !plain.live()[0].sent[0].gpu);
  const err = rig(); err.m.start({ miner: ADDR, threads: 1, gpu: 'full' }); const ge = err.live().find((w) => w.sent[0].gpu); ge.onerror();
  check('a GPU thread that fails to load is treated the same', err.m.state().gpu.failed === true && ge.dead && err.live().length === 1);
}

// ---- the whole way: real grinding threads, the miner, and the pool's own code counting the shares
{
  const kv = new Map(), cfg = { ...SALT_POOL, minBits: 16, house: [] }; let clock = Date.now();
  const pool = makeSaltPool({ kv: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => { kv.set(k, v); } }, cfg, now: () => clock });
  const fetchImpl = async (url, init) => { const b = JSON.parse(init.body), r = await pool.submit({ miner: b.miner, salts: b.salts, client: 'ip1', software: b.client }); return { status: r.status, ok: r.status === 200, json: async () => r.body }; };
  const timers = []; const loops = [];
  // a "worker" that runs the thread's loop here
  const makeWorker = () => { const w = { onmessage: null, terminate() { loop.message({ type: 'stop' }); } }; let rr = null; const loop = T.makeGrindLoop({ post: (m) => w.onmessage?.({ data: m }), rest: () => new Promise((r) => { rr = r; setTimeout(r, 0); }) }); w.postMessage = (m) => loop.message(m); loops.push(loop); return w; };
  const m = T.makeTabMiner({ api: '', makeWorker, fetchImpl, now: () => clock, timers: { set: (f, ms) => { const t = { f, ms, on: true }; timers.push(t); return t; }, clear: (t) => { if (t) t.on = false; } }, jitter: () => 0 });
  m.start({ miner: ADDR, threads: 2, minBits: 16 });
  const t0 = Date.now(); while (m.state().waiting < 6 && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 20));
  const waiting = m.state().waiting;
  clock += 21000; const t = timers.filter((x) => x.on).pop(); t.on = false; await t.f();
  const st = m.state();
  check(`two real threads found shares (${waiting}) and the pool's own code counted every one for the address`, waiting >= 6 && st.accepted === Math.min(64, waiting) && st.today.shares === st.accepted && st.today.weight >= st.accepted && st.error === null);
  const rec = JSON.parse(kv.get(`sl:m:${Math.floor(clock / 86400000)}:${ADDR.toLowerCase()}`));
  check('and the pool\'s record for the address says so, with this page as the miner', rec.shares === st.accepted && JSON.parse(kv.get('sl:live'))[ADDR.toLowerCase()].sw === 'tacit-prove-tab/1');
  m.stop(); await flush();
  check('the threads stopped', loops.every((l) => l.running() === false));
}
console.log(fails ? `${fails} tab miner test(s) failed` : 'tab miner: all tests passed'); process.exit(fails ? 1 : 0);
