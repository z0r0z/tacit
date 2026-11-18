// The offers a page makes when the relay is slow ("it is taking longer than usual: send it yourself", dapp/activity.js makeOffers). The page stops waiting when it makes one, but the
// relay keeps the job and the journal follows it: when the job lands, the offer's line has to say so (the harvest on the SPX page kept its "send it from this key's address" button
// after the relay had sent it). Checked with the journal itself, so the landing is the journal's own status change, the way the page hears it.
//   node tests/offer-landing.test.mjs
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const ET = new EventTarget();
globalThis.addEventListener = ET.addEventListener.bind(ET); globalThis.removeEventListener = ET.removeEventListener.bind(ET); globalThis.dispatchEvent = ET.dispatchEvent.bind(ET);
const A = await import('../dapp/activity.js');

const line = {}, spec = (jobs, extra = {}) => ({ run: { jobs }, label: 'Harvest farm rewards', status: () => line, ...extra });
let n = 0;
const ok = (c, s) => { assert.ok(c, s); n++; };

// the journal's own callback is what hears a landing
const heard = [], O = A.makeOffers();
const journal = A.makeJournal({ onStatus: (it) => { if (it.kind === 'job') { const hit = O.landed(it); if (hit) heard.push({ id: it.id, done: hit.done, hash: it.hash }); } } });
const job = (id, status = 'pending') => journal.put(id, { kind: 'job', label: 'Harvest', status });

// 1. an offer made on a pending job: the relay sends it, and the offer is finished once
{
  job('job:a'); const s = spec(['job:a']); O.track(s, s.run.jobs);
  journal.put('job:a', { status: 'proving' });
  ok(heard.length === 0, 'a job that is still being proved finishes nothing');
  journal.put('job:a', { status: 'settled', hash: '0xaa' });
  ok(heard.length === 1 && heard[0].done === true && heard[0].hash === '0xaa', 'the relay sent it: the offer is finished, with the transaction');
  journal.put('job:a', { status: 'settled', hash: '0xaa', note: 'again' });
  ok(heard.length === 1, 'and only once');
  ok(!O.has('job:a'), 'a finished offer is forgotten');
}

// 2. an offer standing in for two jobs is finished by the first to land, and the second finishes nothing
{
  heard.length = 0; job('job:b1'); job('job:b2'); const s = spec(['job:b1', 'job:b2']); O.track(s, s.run.jobs);
  journal.put('job:b2', { status: 'settled' });
  ok(heard.length === 1 && heard[0].id === 'job:b2' && !O.has('job:b1'), 'the first of its jobs to land finishes it, and the others are let go');
  journal.put('job:b1', { status: 'settled' });
  ok(heard.length === 1, 'the other one landing says nothing more');
}

// 3. a job that fails leaves the offer standing (it can still be sent from the account), and one that then goes through after all finishes it
{
  heard.length = 0; job('job:c'); const s = spec(['job:c']); O.track(s, s.run.jobs);
  journal.put('job:c', { status: 'failed', err: 'it did not go' });
  ok(heard.length === 1 && heard[0].done === false && O.has('job:c'), 'a failed job is said, and the offer stands');
  journal.put('job:c', { status: 'settled', hash: '0xcc' });
  ok(heard.length === 2 && heard[1].done === true && !O.has('job:c'), 'and if it went through after all, that finishes it');
}

// 4. sent from the account instead: the landing says nothing while that is under way (it says its own end), and a failed one leaves the offer to finish later
{
  heard.length = 0; job('job:d'); const s = spec(['job:d']); O.track(s, s.run.jobs); s.selfBusy = true;
  journal.put('job:d', { status: 'settled' });
  ok(heard.length === 0 && O.has('job:d'), 'while it is being sent from the account, the relay landing it says nothing');
}
{
  heard.length = 0; job('job:e'); const s = spec(['job:e']); O.track(s, s.run.jobs); s.selfBusy = true; delete s.selfBusy;
  journal.put('job:e', { status: 'settled' });
  ok(heard.length === 1 && heard[0].done === true, 'once that is over (it failed), the offer still finishes when the relay lands the job');
}

// 5. the line it was offered on is gone, or it was dropped (the account sent it, or "keep it in line" was pressed): nothing to finish
{
  heard.length = 0; job('job:f'); const s = spec(['job:f'], { status: () => null }); O.track(s, s.run.jobs);
  journal.put('job:f', { status: 'settled' });
  ok(heard.length === 0, 'no line to say it on: nothing');
  job('job:g'); const t = spec(['job:g']); O.track(t, t.run.jobs); O.drop(t);
  journal.put('job:g', { status: 'settled' });
  ok(heard.length === 0 && !O.has('job:g'), 'a dropped offer is not finished');
}

// 6. a job nothing was offered for, and an offer made with no jobs, finish nothing
{
  heard.length = 0; job('job:h'); journal.put('job:h', { status: 'settled' });
  ok(heard.length === 0, 'a job nothing was offered for');
  const s = spec(undefined); O.track(s, s.run.jobs); O.track(s, null);
  ok(O.landed({ id: 'job:none', status: 'settled' }) === null, 'an offer made with no jobs waits for none');
}

// 7. what counts as having gone through is the page's to say
{
  const P = A.makeOffers({ ok: (s) => s === 'done' }), s = spec(['job:p']); P.track(s, s.run.jobs);
  ok(P.landed({ id: 'job:p', status: 'settled' }) === null && P.landed({ id: 'job:p', status: 'done' })?.done === true, 'a different meaning of "went through" is used as given');
}

console.log(`offer-landing: ${n} checks passed`);
