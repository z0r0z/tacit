// The API's mailbox for pre-signed takes (worker/src/take-presig.js), through the real fetch handler over the in-memory KV the Render server uses: a valid
// pre-signature is kept and listed, garbage and altered ones are refused, the size, the per-lock and the per-client limits hold, and the off switch stops
// the POST and leaves the reads.
//   node tests/worker-take-presig.test.mjs
import { createMemDriver } from '../server/driver-mem.mjs';
import { createCacheStorage } from '../server/cache-mem.mjs';
import { buildEnv } from '../server/harness.mjs';
import { sha256, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
import { G, SECP_N, bigintToBytes32 } from '../dapp/bulletproofs.js';
import * as TP from '../dapp/take-presig.js';

globalThis.caches = createCacheStorage({ maxBytes: 32 * 1024 * 1024 });
const worker = (await import('../worker/src/index.js')).default;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; console.log(`  FAIL - ${m}`); } };
const ctx = { waitUntil: () => {} };
const te = (s) => new TextEncoder().encode(s);
const scalar = (tag) => (BigInt('0x' + bytesToHex(sha256(te(tag)))) % (SECP_N - 1n)) + 1n;
async function call(env, method, path, body, ip = '1.1.1.1') {
  const init = { method, headers: { 'CF-Connecting-IP': ip } };
  if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const resp = await worker.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  let json; try { json = JSON.parse(await resp.text()); } catch { json = {}; }
  return { status: resp.status, json };
}
const NOW = Math.floor(Date.now() / 1000);
const lockerXonly = G.multiply(scalar('locker')).toRawBytes(true).slice(1);
function presig(label, { vout = 0, fee = 1500, deadline = NOW + 4 * 3600 } = {}) {
  const base = label.split('#')[0], d = scalar('d/' + base), t = scalar('t/' + base);
  return TP.makePresig({
    dUser: d, claimerPub: G.multiply(d).toRawBytes(true), T: G.multiply(t), lockerXonly, csvBlocks: 144,
    lockOut: { txid: bytesToHex(sha256(te('lock/' + base))), vout, value: 200_000 }, dest: '0014' + 'ab'.repeat(20), fee,
    sTilde: bytesToHex(bigintToBytes32(scalar('s/' + label))), lockNu: bytesToHex(sha256(te('nu/' + label))), deadline,
  });
}
const env = () => buildEnv(createMemDriver(), { extra: {} });

{
  const e = env(), p = presig('one');
  const r = await call(e, 'POST', '/take-presig', { presig: p });
  ok(r.status === 200 && r.json.ok === true, 'a valid pre-signature is taken');
  const again = await call(e, 'POST', '/take-presig', { presig: p });
  ok(again.status === 200 && again.json.known === true, 'the same one again is kept once');
  const byLock = await call(e, 'GET', `/take-presig?lock=${p.lock.txid}:${p.lock.vout}`);
  ok(byLock.status === 200 && byLock.json.count === 1 && byLock.json.presigs[0].R === p.R, 'listed by its lock output');
  const all = await call(e, 'GET', '/take-presig');
  ok(all.json.count === 1 && TP.verifyPresig(all.json.presigs[0]).ok, 'listed for a watcher, and it still verifies');
  ok(!JSON.stringify(all.json).includes(bytesToHex(bigintToBytes32(scalar('d/one')))) && !JSON.stringify(all.json).includes(bytesToHex(bigintToBytes32(scalar('t/one')))), 'it holds no secret');
  ok((await call(e, 'GET', '/take-presig?lock=zz')).status === 400, 'a bad lock filter is refused');
}
{
  const e = env(), p = presig('two');
  for (const [name, bad] of [['a changed destination', { ...p, dest: '0014' + 'cd'.repeat(20) }], ['a changed fee', { ...p, fee: p.fee + 1 }], ['a made-up signature', { ...p, sPre: bytesToHex(bigintToBytes32(scalar('junk'))) }], ['an expired one', { ...p, expiresAt: NOW - 10 }], ['no body', undefined]]) {
    const r = await call(e, 'POST', '/take-presig', name === 'no body' ? { nothing: 1 } : { presig: bad });
    ok(r.status === 400, `${name} is refused`);
  }
  ok((await call(e, 'POST', '/take-presig', '{not json')).status === 400, 'a body that is not JSON is refused');
  ok((await call(e, 'POST', '/take-presig', 'x'.repeat(5000))).status === 413, 'a large body is refused');
  ok((await call(e, 'GET', '/take-presig')).json.count === 0, 'nothing was kept');
}
{
  const e = env();
  for (let i = 0; i < 4; i++) ok((await call(e, 'POST', '/take-presig', { presig: presig('same#' + i, { fee: 1500 + i }) }, '2.2.2.' + i)).status === 200, `pre-signature ${i + 1} of one lock output`);
  ok((await call(e, 'POST', '/take-presig', { presig: presig('same#9', { fee: 1599 }) }, '2.2.2.9')).status === 409, 'a fifth for the same lock output is refused');
}
{
  const e = env();
  let last;
  for (let i = 0; i < 21; i++) last = await call(e, 'POST', '/take-presig', { presig: presig('rl' + i, { vout: i }) }, '3.3.3.3');
  ok(last.status === 429, 'a client past its hourly limit is limited');
  ok((await call(e, 'POST', '/take-presig', { presig: presig('rl-other') }, '4.4.4.4')).status === 200, 'another client is not');
}
{
  const e = buildEnv(createMemDriver(), { extra: { TAKE_PRESIG_ENABLED: 'false' } });
  ok((await call(e, 'POST', '/take-presig', { presig: presig('off') })).status === 410, 'off: the POST is refused');
  ok((await call(e, 'GET', '/take-presig')).status === 200, 'off: reads stay');
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
