// node lease.test.mjs -- the lease side of the help desk: queueing, long-poll, canaries, vetting, strikes, interruptions, hijack attempts
import { makeLeases, makeVet, isAddr, creditsFor } from './lease.mjs';
let fails = 0; const check = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fails++; };
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), msgs = [{ role: 'user', content: 'q' }];
const mk = (extra = {}) => makeLeases({ waitMs: 300, sweepMs: 50, leaseMs: 400, canaryEvery: 1000, ...extra });

{ const L = mk(); const p = L.enqueue('answer', msgs, { timeoutMs: 2000 }); const job = await L.lease({ miner: A, ip: '1.1.1.1' });
  check('a waiting question is leased to a node', job && job.messages === msgs && job.lease);
  const r = await L.submit({ id: job.id, lease: job.lease, miner: A, ip: '1.1.1.1', text: 'It is 21,000,000.' }); const got = await p;
  check('the answer reaches the visitor, with who answered', got.text.includes('21,000,000') && got.miner === A && r.points === 1); L.close(); }

{ const L = mk({ waitMs: 1000 }); const pl = L.lease({ miner: A, ip: '2.2.2.2' }); await new Promise((r) => setTimeout(r, 100));
  const p = L.enqueue('answer', msgs, { timeoutMs: 2000 }); const job = await pl; check('a node that was already waiting gets the next question at once', job && job.id);
  await L.submit({ id: job.id, lease: job.lease, miner: A, ip: '2.2.2.2', text: 'ok' }); await p; L.close(); }

{ const L = mk(); let threw = false; try { await L.enqueue('answer', msgs, { timeoutMs: 150 }); } catch { threw = true; } check('a question nobody takes times out (the gateway then falls back)', threw && L.stats().queued === 0); L.close(); }

{ const L = mk({ canaryEvery: 2, strikeLimit: 3, canary: async () => ({ messages: msgs, check: (t) => /21,000,000/.test(t) }) });
  const real = async (ip) => { const p = L.enqueue('answer', msgs, { timeoutMs: 2000 }); const j = await L.lease({ miner: A, ip }); await L.submit({ id: j.id, lease: j.lease, miner: A, ip, text: 'ok' }); await p; };
  const ip = '3.3.3.3'; const idle = await L.lease({ miner: A, ip }); check('an idle node is not woken for a test', idle === null);
  await real(ip); await real(ip); const c = await L.lease({ miner: A, ip });
  check('after canaryEvery real jobs the next lease is a canary, indistinguishable by shape', c && c.kind === 'answer' && c.messages === msgs);
  const bad = await L.submit({ id: c.id, lease: c.lease, miner: A, ip, text: 'There are 100,000 TAC.' }); check('a wrong canary answer earns nothing and a strike', bad.points === 0 && L.stats().miners[0].canaryFail === 1);
  for (let i = 0; i < 2; i++) { await real(ip); await real(ip); const c2 = await L.lease({ miner: A, ip }); if (c2?.lease) await L.submit({ id: c2.id, lease: c2.lease, miner: A, ip, text: 'nope' }); }
  const banned = await L.lease({ miner: A, ip }); check('three failed canaries pause the client', banned && banned.banned === true);
  const other = await L.lease({ miner: A, ip: '9.9.9.9' }); check('a different client is unaffected (strikes key on the client, not the address)', !(other && other.banned));
  const L2 = mk({ canaryEvery: 1, canary: async () => ({ messages: msgs, check: (t) => /21,000,000/.test(t) }) });
  const p2 = L2.enqueue('answer', msgs, { timeoutMs: 2000 }); const r2 = await L2.lease({ miner: B, ip: '4.4.4.4' }); await L2.submit({ id: r2.id, lease: r2.lease, miner: B, ip: '4.4.4.4', text: 'ok' }); await p2;
  const g = await L2.lease({ miner: B, ip: '4.4.4.4' }); const ok = await L2.submit({ id: g.id, lease: g.lease, miner: B, ip: '4.4.4.4', text: 'Exactly 21,000,000.' }); check('a right canary answer is credited', ok.points === 1 && L2.stats().miners[0].canaryPass === 1);
  const L3 = mk({ canaryMaxAgeMs: 50, canary: async () => ({ messages: msgs, check: () => true }) }); await L3.lease({ miner: A, ip: '5.5.5.1' }); await new Promise((r) => setTimeout(r, 120));
  const old = await L3.lease({ miner: A, ip: '5.5.5.1' }); check('a node that has been quiet for a day is tested once, so it cannot hide', old && old.messages === msgs); L.close(); L2.close(); L3.close(); }

{ const vet = makeVet('official docs mention 0x' + 'cd'.repeat(20) + ' and etherscan.io and tacit.finance');
  const L = mk({ vet }); const p = L.enqueue('answer', msgs, { timeoutMs: 3000 }); const j1 = await L.lease({ miner: A, ip: '5.5.5.5' });
  const r1 = await L.submit({ id: j1.id, lease: j1.lease, miner: A, ip: '5.5.5.5', text: 'Send funds to 0x' + 'ee'.repeat(20) });
  check('an answer with an address from nowhere is rejected, no credit', r1.points === 0);
  const j2 = await L.lease({ miner: B, ip: '6.6.6.6' }); check('and the question goes to another node', j2 && j2.id === j1.id);
  await L.submit({ id: j2.id, lease: j2.lease, miner: B, ip: '6.6.6.6', text: 'See tacit.finance.' }); check('which can answer it', (await p).miner === B); L.close();
  check('vet: a link outside the docs is refused', vet('go to https://tacit-finance.xyz/claim') === 'link not in the docs');
  check('vet: a look-alike domain is refused', vet('visit tacit-finance.xyz') === 'domain not in the docs');
  check('vet: docs links and addresses pass', vet('see https://etherscan.io/address/0x' + 'cd'.repeat(20) + ' and tacit.finance') === null);
  check('vet: asking for a seed phrase is refused', vet('To recover, enter your seed phrase on the site.') === 'asks for secrets');
  check('vet: warning against sharing it is fine', vet('Never share your seed phrase with anyone.') === null); }

{ const L = mk({ maxTries: 2 }); const p = L.enqueue('answer', msgs, { timeoutMs: 3000 }); p.catch(() => {}); const j = await L.lease({ miner: A, ip: '7.7.7.7' });
  const e = await L.submit({ id: j.id, lease: j.lease, miner: A, ip: '7.7.7.7', error: 'a proof started' }); check('a proof interrupting a job is not misbehaviour', e.ok && L.stats().banned === 0 && L._clients.size === 1 && [...L._clients.values()][0].strikes.length === 0);
  const j2 = await L.lease({ miner: B, ip: '8.8.8.8' }); check('the job is re-served to another node', j2 && j2.id === j.id);
  await L.submit({ id: j2.id, lease: j2.lease, miner: B, ip: '8.8.8.8', error: 'no model' }); let rejected = false; try { await p; } catch { rejected = true; } check('after the second failure the visitor request is released to the fallback', rejected); L.close(); }

{ const L = mk(); L.enqueue('answer', msgs, { timeoutMs: 3000 }).catch(() => {}); const j = await L.lease({ miner: A, ip: '10.0.0.1' });
  check('a different IP cannot submit someone else\'s lease', (await L.submit({ id: j.id, lease: j.lease, miner: A, ip: '10.0.0.2', text: 'x' })).error);
  check('a wrong token cannot', (await L.submit({ id: j.id, lease: 'zz', miner: A, ip: '10.0.0.1', text: 'x' })).error);
  check('a different address cannot', (await L.submit({ id: j.id, lease: j.lease, miner: B, ip: '10.0.0.1', text: 'x' })).error);
  check('a bad address is refused at lease', (await L.lease({ miner: 'nope', ip: '1.2.3.4' })).error); L.close(); }

{ const L = mk({ leaseMs: 100 }); const p = L.enqueue('answer', msgs, { timeoutMs: 3000 }); await L.lease({ miner: A, ip: '11.1.1.1' }); await new Promise((r) => setTimeout(r, 250));
  const j = await L.lease({ miner: B, ip: '12.2.2.2' }); check('a lease that is never submitted expires and the job is re-served', j && j.messages === msgs); p.catch(() => {}); L.close(); }


// points: configurable, capped per client per day, nothing for answering your own question
{ const L = mk({ points: { answer: 5, canary: 1, scan: 1 }, clientMaxPerDay: 7 }); const serve = async (ip, askerIp) => { const p = L.enqueue('answer', msgs, { timeoutMs: 2000, askerIp }); const j = await L.lease({ miner: A, ip }); const r = await L.submit({ id: j.id, lease: j.lease, miner: A, ip, text: 'ok' }); await p; return r.points; };
  check('the configured points are credited', (await serve('20.0.0.1')) === 5);
  check('a client stops earning at its daily cap, and is still served', (await serve('20.0.0.1')) === 2 && (await serve('20.0.0.1')) === 0);
  check('a different client earns in full', (await serve('20.0.0.2')) === 5);
  check('answering a question you asked yourself earns nothing', (await serve('20.0.0.3', '20.0.0.3')) === 0); L.close(); }
// state survives a restart: a banned client stays banned
{ const f = '/tmp/lease-state-test.json'; try { (await import('node:fs')).unlinkSync(f); } catch {}
  const L = mk({ persist: f, canaryEvery: 1, strikeLimit: 1, canary: async () => ({ messages: msgs, check: () => false }) }); const p = L.enqueue('answer', msgs, { timeoutMs: 1000 }); const j = await L.lease({ miner: A, ip: '30.0.0.1' }); await L.submit({ id: j.id, lease: j.lease, miner: A, ip: '30.0.0.1', text: 'x' }); await p;
  const c = await L.lease({ miner: A, ip: '30.0.0.1' }); await L.submit({ id: c.id, lease: c.lease, miner: A, ip: '30.0.0.1', text: 'wrong' }); L.close();
  const L2 = mk({ persist: f }); const again = await L2.lease({ miner: A, ip: '30.0.0.1' }); check('a ban survives a restart', again && again.banned === true && L2.stats().miners[0].canaryFail === 1); L2.close(); (await import('node:fs')).unlinkSync(f); }
// the credits feed, in the points service's format
{ const fs = await import('node:fs'); const f = '/tmp/ledger-test.jsonl'; const day = 20800, t0 = day * 86400000 + 1000;
  fs.writeFileSync(f, [{ t: t0, ev: 'answer', miner: A, points: 1 }, { t: t0 + 5, ev: 'canary', miner: A, pass: true, points: 1 }, { t: t0 + 9, ev: 'answer', miner: B, points: 1 }, { t: t0 + 9, ev: 'rejected', miner: B }, { t: t0 - 90000000, ev: 'answer', miner: B, points: 1 }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const c = creditsFor(f, day, { now: (day + 1) * 86400000 + 5 }); check('credits: the day tally per address, only that UTC day, and over once the day has ended', c.over === true && c.miners.length === 2 && c.miners.find((m) => m.miner === A.toLowerCase()).points === 2 && c.miners.find((m) => m.miner === B.toLowerCase()).points === 1);
  check('credits: the day in progress is not over', creditsFor(f, day, { now: day * 86400000 + 100 }).over === false);
  check('credits: an address is capped per day', creditsFor(f, day, { maxPerDay: 1, now: (day + 1) * 86400000 }).miners.every((m) => m.points === 1)); fs.unlinkSync(f); }

check('isAddr', isAddr(A) && !isAddr('0x12') && !isAddr(null));
console.log(fails ? `${fails} lease test(s) failed` : 'lease: all tests passed'); process.exit(fails ? 1 : 0);
