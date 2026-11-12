// The review channel: a digest posted with the one secret becomes one bot message per finding (buttons, no pings, no previews), a retried digest posts
// nothing twice, a click in the channel stores a label and edits the message, and the labels read back. The worker runs for real over an in-memory store;
// Discord's REST API is the only thing stood in.
//
// Run: `node tests/nudger-api.test.mjs`

import { generateKeyPairSync, sign } from 'node:crypto';
import { createMemDriver } from '../server/driver-mem.mjs';
import { createCacheStorage } from '../server/cache-mem.mjs';
import { parseDigest, renderFinding, clean } from '../worker/src/nudger.js';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

globalThis.caches = createCacheStorage({ maxBytes: 8 * 1024 * 1024 });
const { buildEnv, createCtxFactory, createTacitServer } = await import('../server/harness.mjs');
const workerModule = (await import('../worker/src/index.js')).default;

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const driver = createMemDriver();
const env = buildEnv(driver);
env.DISCORD_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const server = createTacitServer({ workerModule, env, driver, ctxFactory: createCtxFactory() });
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const SECRET = 's'.repeat(40), CH = '323456789012345678', OTHER = '423456789012345678', REVIEWER = '523456789012345678';
const post = (path, body, secret = SECRET) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (path, secret = SECRET) => fetch(`${base}${path}`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
function click(custom_id, { channel = CH, user = { id: REVIEWER, username: 'z', global_name: 'Z' }, message } = {}) {
  const body = JSON.stringify({ type: 3, channel_id: channel, member: { user }, data: { component_type: 2, custom_id }, message });
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${base}/discord/interaction`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': sign(null, Buffer.from(ts + body), privateKey).toString('hex'), 'X-Signature-Timestamp': ts }, body });
}

const realFetch = globalThis.fetch;
const sent = []; let nextId = 1, script = [];
globalThis.fetch = (url, init) => {
  if (!String(url).startsWith('https://discord.com/')) return realFetch(url, init);
  sent.push({ url: String(url), init, body: JSON.parse(init.body) });
  const r = script.shift();
  if (r) return Promise.resolve(new Response(JSON.stringify(r.body || {}), { status: r.status }));
  return Promise.resolve(new Response(JSON.stringify({ id: `9${String(nextId++).padStart(17, '0')}` }), { status: 200 }));
};

const finding = (n, over = {}) => ({ id: `n261112-${n}`, file: 'dapp/confidential-relay.js', line: 46, commit: 'cb30f7f5b1234', subject: 'relay client: poll a job', claim: 'status() is not retried, so one failed read ends the poll.', evidence: 'confidential-relay.js:34-38 has no try/catch.', severity: 'med', status: 'real', ...over });
const digest = (findings, over = {}) => ({ day: '2026-11-12', reviewed: 4, findings, ...over });

// ---- the pure parts
ok('clean turns control characters and runs of space into one space, backticks into quotes, and keeps an @ from naming anyone', clean('a\n\n b`c` @everyone @here', 80) === "a b'c' @​everyone @​here");
ok('a link or an invite code in a finding is replaced, so pasted text cannot carry one into the channel', clean('see https://evil.example/x?a=1 and HTTP://x.io and discord.gg/abc or discord.com/invite/zzz', 120) === 'see [link] and [link] and [link] or [link]');
ok('a digest is refused for a bad day, a bad id, a repeated id, too many findings, a finding with no claim', [
  parseDigest({ day: 'tomorrow', findings: [] }), parseDigest(digest([finding(1, { id: 'x-1' })])), parseDigest(digest([finding(1), finding(1)])),
  parseDigest(digest(Array.from({ length: 9 }, (_, i) => finding(i + 1)))), parseDigest(digest([finding(1, { claim: '  ' })])), parseDigest(digest([finding(1, { id: 'n261111-1' })])),
].every((r) => r.error));
const p = parseDigest(digest([finding(1, { severity: 'huge', status: 'maybe', line: -3, commit: 'nothex' })]));
ok('odd severity, status, line and commit fall back to safe values', p.digest?.findings[0].severity === 'low' && p.digest.findings[0].status === 'real' && p.digest.findings[0].line === 0 && p.digest.findings[0].commit === '');
const m = renderFinding(parseDigest(digest([finding(1, { claim: 'x'.repeat(900), evidence: 'y'.repeat(900) })])).digest.findings[0]);
ok('a message stays under Discord\'s limit, pings nobody, shows no previews, and has three buttons with the finding in each id', m.content.length <= 1900 && m.allowed_mentions.parse.length === 0 && m.flags === 4
  && m.components[0].components.length === 3 && m.components[0].components.every((b) => b.custom_id.endsWith(':n261112-1') && b.custom_id.length < 100));

// ---- the routes
ok('without NUDGER_SECRET configured the digest route refuses', (await post('/nudger/digest', digest([]))).status === 500);
env.NUDGER_SECRET = SECRET;
ok('no token and a wrong token are refused', (await post('/nudger/digest', digest([]), null)).status === 401 && (await post('/nudger/digest', digest([]), 'w'.repeat(40))).status === 401);
ok('the labels route is refused without the token too', (await get('/nudger/labels', null)).status === 401);
ok('a digest with the secret but no channel configured is refused and posts nothing', (await post('/nudger/digest', digest([finding(1)]))).status === 500 && sent.length === 0);
env.NUDGER_CHANNEL_ID = CH; env.DISCORD_BOT_TOKEN = 'bot-token';
ok('a bad body is a 400 and posts nothing', (await post('/nudger/digest', '{nope')).status === 400 && (await post('/nudger/digest', digest([finding(1, { id: 'bad' })]))).status === 400 && sent.length === 0);
ok('an oversized body is refused', (await post('/nudger/digest', 'x'.repeat(50_000))).status === 413);

const first = await post('/nudger/digest', digest([finding(1), finding(2, { status: 'outside', claim: 'It @everyone depends on `server` behaviour.' })]));
const fj = await first.json();
ok('a digest posts one bot message per finding to the review channel, as the bot', first.status === 200 && fj.posted.join() === 'n261112-1,n261112-2' && sent.length === 2
  && sent.every((s) => s.url === `https://discord.com/api/v10/channels/${CH}/messages` && s.init.headers.Authorization === 'Bot bot-token'), { status: first.status, n: sent.length });
ok('the second message says it needs an outside fact, and no pasted @ can ping', sent[1].body.content.includes('needs a fact from outside the code') && !/@everyone/.test(sent[1].body.content) && sent[1].body.allowed_mentions.parse.length === 0);
const again = await (await post('/nudger/digest', digest([finding(1), finding(2)]))).json();
ok('the same digest posted again posts nothing more', again.duplicate === true && sent.length === 2);

// a partial failure completes on retry without repeating what was posted
script = [{ status: 200, body: { id: '900000000000000091' } }, { status: 500, body: { message: 'boom' } }];
const partial = await post('/nudger/digest', { day: '2026-11-11', reviewed: 2, findings: [finding(1, { id: 'n261111-1' }), finding(2, { id: 'n261111-2' })] });
const pj = await partial.json();
ok('when Discord fails midway the route says so and names what was posted', partial.status === 502 && pj.posted.join() === 'n261111-1', pj);
const before = sent.length;
const retry = await (await post('/nudger/digest', { day: '2026-11-11', reviewed: 2, findings: [finding(1, { id: 'n261111-1' }), finding(2, { id: 'n261111-2' })] })).json();
ok('a retry posts only the finding that was missing', retry.ok === true && sent.length === before + 1 && sent[sent.length - 1].body.content.includes('n261111-2'), retry);

// a rate limit is waited out once
script = [{ status: 429, body: { retry_after: 0 } }];
const limited = await post('/nudger/digest', { day: '2026-11-10', reviewed: 1, findings: [finding(1, { id: 'n261110-1' })] });
ok('a rate-limited post is retried once and succeeds', limited.status === 200 && (await limited.json()).posted.join() === 'n261110-1');

// nothing to report
const quiet = await post('/nudger/digest', { day: '2026-11-09', reviewed: 3, findings: [] });
ok('no findings posts one short line, with no buttons', quiet.status === 200 && sent[sent.length - 1].body.content.includes('Nothing worth a look today: 3 commits') && !sent[sent.length - 1].body.components);

// ---- clicks
const msg = { content: sent[0].body.content, components: sent[0].body.components };
const c1 = await (await click('nudge:useful:n261112-1', { message: msg })).json();
ok('a click in the channel edits the message in place, to say who marked it', c1.type === 7 && /_marked useful by Z_$/.test(c1.data.content) && c1.data.allowed_mentions.parse.length === 0 && c1.data.components.length === 1, c1);
const c2 = await (await click('nudge:noise:n261112-1', { message: { content: c1.data.content, components: c1.data.components } })).json();
ok('another click replaces the mark instead of stacking', /_marked noise by Z_$/.test(c2.data.content) && (c2.data.content.match(/_marked/g) || []).length === 1);
ok('a click in any other channel is refused and stores nothing', (await (await click('nudge:useful:n261112-2', { channel: OTHER })).json()).data.content.includes('only work in the review channel'));
ok('an unknown finding and a malformed id are answered, not stored', (await (await click('nudge:useful:n261112-9')).json()).data.content.includes('no longer stored') && (await (await click('nudge:useful:../x')).json()).data.content.includes('Unknown action'));
env.NUDGER_USER_IDS = '999999999999999999';
ok('when reviewers are named, anyone else is refused', (await (await click('nudge:useful:n261112-2')).json()).data.content.includes('Only the reviewers'));
env.NUDGER_USER_IDS = `${REVIEWER}, 999999999999999999`;
ok('and a named reviewer is accepted', (await (await click('nudge:known:n261112-2', { message: { content: sent[1].body.content, components: sent[1].body.components } })).json()).type === 7);
delete env.NUDGER_USER_IDS;
ok('the verification button still reaches its own handler', (await click('tacit:verify:v1')).status === 200);

// ---- reading it back
const rep = await (await get('/nudger/labels?since=2026-11-09')).json();
ok('the labels route lists what was posted with each label, and the totals', rep.totals.posted === 5 && rep.totals.labelled === 2 && rep.totals.noise === 1 && rep.totals.known === 1 && rep.totals.useful === 0, rep.totals);
ok('a finding reads back whole', (await (await get('/nudger/finding/n261112-1')).json()).label === 'noise' && (await get('/nudger/finding/n261112-77')).status === 404);

globalThis.fetch = realFetch;
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
