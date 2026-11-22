// GET /relay/economics and the heartbeat that feeds it, through the worker's own fetch: the settle relay's books are stored from a heartbeat
// (checked, and never shown by /prover-health), the chain facts are read once and kept, and a chain that stops answering leaves the last
// reading in place.
// Run: node tests/relay-economics-route.test.mjs
import worker from '../worker/src/index.js';

let fails = 0;
const ok = (c, m, d = '') => { console.log((c ? 'ok   ' : 'FAIL ') + m + (c || !d ? '' : ` — ${d}`)); if (!c) fails++; };
const kv = () => { const m = new Map(); return { m, async get(k, t) { if (!m.has(k)) return null; return t === 'json' ? JSON.parse(m.get(k)) : m.get(k); }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } }; };
const E = 10n ** 18n;

// A stand-in for Ethereum's JSON-RPC: balances, the PROVE balance, a block number, and no logs.
let rpcCalls = 0, rpcUp = true;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (!opts || opts.method !== 'POST' || !/^https:\/\/(?!api\.tacit)/.test(u)) return realFetch(url, opts);
  const b = JSON.parse(opts.body);
  rpcCalls++;
  const res = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (!rpcUp) return new Response('down', { status: 503 });
  if (b.method === 'eth_blockNumber') return res('0x' + (26_400_000).toString(16));
  if (b.method === 'eth_getBalance') return res('0x' + (E / 100n).toString(16));
  if (b.method === 'eth_call') return res('0x' + (25n * E).toString(16));
  if (b.method === 'eth_getLogs') return res([]);
  return res(null);
};

const BOX = 'box-token-0123456789abcdef';
const env = { REGISTRY_KV: kv(), PROVER_HEARTBEAT_TOKEN: 'tok', CONFIDENTIAL_BOX_TOKEN: BOX, FREE_RELAY_CAP_FARM: '8', FREE_RELAY_CAP_ONBOARD: '12' };
const today = new Date().toISOString().slice(0, 10);
env.REGISTRY_KV.m.set(`cps:budget:free:${today}`, '14'); env.REGISTRY_KV.m.set(`cps:budget:free:farm:${today}`, '8'); env.REGISTRY_KV.m.set(`cps:budget:free:onboard:${today}`, '3');
const call = (path, init) => worker.fetch(new Request(`https://api.tacit.finance${path}`, { headers: { Origin: 'https://tacit.finance' }, ...init }), env, { waitUntil() {} });
const beat = (extra = {}) => call('/prover-heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'tok', network: 'mainnet', kind: 'settle', prover_alive: true, note: 'settle: idle', ...extra }) });

const ledger = {
  since: new Date().toISOString(), cfg: { buybackBps: 1000, evil: 'x' }, owedEth: 0.001, junk: 'dropped',
  days: { [new Date().toISOString().slice(0, 10)]: { settled: 12, priced: 8, unpriced: 3, proveOnly: 1, gasEth: 0.004, proveIn: 12.5, buybackEth: 0.001, splitterSends: 0, feeUsd: { eth: 6, converted: 1, tac: 2, other: 0.5 }, junk: 1 } },
};

let r = await call('/relay/economics');
let j = await r.json();
ok(r.status === 200 && j.ledger === null && j.chain && j.chain.wallets.settle.eth === 0.01, 'with no heartbeat yet the page still gets the chain facts, and a null ledger');
ok(j.chain.wallets.relay.prove === 25 && j.chain.buyback.complete === true && j.chain.tips === null, 'the relay wallet\'s PROVE and the buyback are in the chain facts, and the tips, read in the background, are not there yet');
await new Promise((x) => setTimeout(x, 150));
r = await call('/relay/economics'); j = await r.json();
ok(j.chain.tips && j.chain.tips.wraps === 0 && j.chain.tips.complete === true, 'a moment later the thirty days of tips are');

r = await beat({ ledger });
ok(r.status === 200, 'a heartbeat carrying the books is accepted');
r = await call('/relay/economics'); j = await r.json();
ok(j.ledger && j.ledger.stale === false && j.ledger.cfg.buybackBps === 1000 && j.ledger.cfg.evil === undefined && j.ledger.junk === undefined, 'its books are served, checked, with unknown fields gone');
ok(j.ledger.week.settled === 12 && j.ledger.week.feeUsd.convertible === 7 && j.ledger.recent.length === 1 && j.ledger.owedEth === 0.001, 'with the week summed and the recent days listed');
ok(j.ledger.week.feeUsd.tac === undefined && j.ledger.recent[0].feeUsd.tac === undefined && j.ledger.recent[0].feeUsd.other === undefined, 'and nothing priced from the private TAC reference leaves the API');

const h = await (await call('/prover-health?network=mainnet')).json();
ok(!JSON.stringify(h).includes('buybackBps') && !JSON.stringify(h).includes('feeUsd'), '/prover-health does not carry the books');

r = await beat({ ledger: 'not an object' });
ok(r.status === 200, 'a heartbeat with a malformed ledger is still a heartbeat');
r = await call('/relay/economics'); j = await r.json();
ok(j.ledger === null || j.ledger.stale === false, 'and does not break the endpoint');

const before = rpcCalls;
await call('/relay/economics'); await call('/relay/economics');
ok(rpcCalls === before, 'a second read inside five minutes costs no chain reads');
const cached = JSON.parse(env.REGISTRY_KV.m.get('relay:economics:chain:v1'));
cached.at -= 10 * 60e3; env.REGISTRY_KV.m.set('relay:economics:chain:v1', JSON.stringify(cached));
rpcUp = false;
r = await call('/relay/economics'); j = await r.json();
ok(r.status === 200 && j.chain && j.chain.wallets.settle.eth === 0.01, 'when the chain stops answering the last reading stays');
rpcUp = true;
const realNow = Date.now; Date.now = () => realNow() + 60e3;
r = await call('/relay/economics'); j = await r.json();
Date.now = realNow;
ok(r.status === 200 && rpcCalls > before && j.chain.wallets.settle.eth === 0.01, 'and it is read again, after a short wait, once it answers');
ok((await call('/relay/economics', { method: 'POST' })).status !== 200, 'it is a read-only route');
ok(r.headers.get('access-control-allow-origin') === 'https://tacit.finance' || r.headers.get('access-control-allow-origin') === '*', 'it answers the site\'s origin');

r = await call('/relay/economics'); j = await r.json();
const spo = j.sponsorship;
ok(spo && spo.day === today && spo.total.used === 14 && spo.total.cap === 300, 'the route reports the day\'s sponsored settles against the total allowance');
ok(spo.classes.farm.used === 8 && spo.classes.farm.cap === 8 && spo.classes.onboard.used === 3 && spo.classes.onboard.cap === 12, 'and each class against the allowance set for it');
ok(spo.classes.wrap.used === 0 && spo.classes.wrap.cap === null && spo.classes.other.cap === null, 'a class with no allowance set shows no limit');

// The books a restarted relay takes back: kept apart from the heartbeat record, never public, and not erased by a beat that leaves the ledger out.
const asBox = (path) => call(path, { headers: { Authorization: `Bearer ${BOX}`, Origin: 'https://tacit.finance' } });
r = await beat({ ledger: { ...ledger, owedWei: '1234567890123456', pendingUsd: 2.5 } });
ok((await call('/confidential/ledger')).status === 404, 'the books are not served without the relay\'s token');
r = await asBox('/confidential/ledger'); j = await r.json();
ok(r.status === 200 && j.ledger && j.ledger.owedWei === '1234567890123456' && j.ledger.pendingUsd === 2.5 && j.ledger.days[today].settled === 12 && j.ledger.junk === undefined, 'with the token, the last books come back, checked, with the exact owed and the income not yet taxed');
ok(j.ledger.days[today].feeUsd.tac === 2, 'and the operator\'s own figures (TAC fees) are in them');
r = await beat({}); // a beat that leaves the ledger out (the relay has not taken its books back yet)
r = await asBox('/confidential/ledger'); j = await r.json();
ok(j.ledger && j.ledger.owedWei === '1234567890123456', 'a beat with no ledger leaves the stored books alone');
r = await beat({ ledger: { ...ledger, owedWei: 'not a number', pendingUsd: -4 } });
r = await asBox('/confidential/ledger'); j = await r.json();
ok(j.ledger.owedWei === '0' && j.ledger.pendingUsd === 0, 'an owed or pending figure that is not a plain number is read as nothing');
r = await call('/relay/economics'); j = await r.json();
ok(j.ledger && j.ledger.owedWei === undefined && j.ledger.pendingUsd === undefined, 'and neither reaches the public page');
ok(!JSON.stringify(await (await call('/prover-health?network=mainnet')).json()).includes('owedWei'), 'or /prover-health');
// the note anyone reads keeps its words and leaves out the job it names; a box-token caller reads it whole
{
  const id = '0x' + 'e8'.repeat(32);
  await beat({ note: `settle: proving ${id} route` });
  const pub = await (await call('/prover-health?network=mainnet&kind=settle')).json();
  ok(pub.note === 'settle: proving route', 'the public note names the work, not the job', pub.note);
  const box = await (await call('/prover-health?network=mainnet&kind=settle', { headers: { Origin: 'https://tacit.finance', Authorization: `Bearer ${BOX}` } })).json();
  ok(box.note === `settle: proving ${id} route`, 'a box-token caller reads the note whole', box.note);
}
r = await beat({ ledger: { ...ledger, owedEth: 0.0123 } });   // posted by a relay from before the exact figure
r = await asBox('/confidential/ledger'); j = await r.json();
ok(j.ledger.owedWei === '12300000000000000', 'a relay that only posted owedEth has it taken back as wei');
const reflect = await beat({ kind: 'reflection', ledger: { ...ledger, owedWei: '999' } });
r = await asBox('/confidential/ledger'); j = await r.json();
ok(j.ledger.owedWei === '12300000000000000', 'only the settle relay\'s beat writes the books');

globalThis.fetch = realFetch;
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
