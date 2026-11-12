// node lease.test.mjs -- the lease side of the help desk: queueing, long-poll, canaries, vetting, strikes, interruptions, hijack attempts
import { makeLeases, makeVet, isAddr, creditsFor, cleanHw, tierOf } from './lease.mjs';
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

{ const L = mk({ waitMs: 5000 }); const sl = (ms) => new Promise((r) => setTimeout(r, ms)); const ac = new AbortController();
  const gone = L.lease({ miner: A, ip: '8.8.8.8', closed: ac.signal }); await sl(50);
  check('a node waiting for work is counted as waiting', L.stats().waiting === 1);
  ac.abort(); const out = await gone;
  check('a node that disconnects while it waits is taken out of the line at once', out === null && L.stats().waiting === 0);
  const p = L.enqueue('answer', msgs, { timeoutMs: 400 }).catch(() => 'timed out'); await sl(50);
  check('and the next question is kept for a node that is there, not handed to the one that left', L.stats().queued === 1 && L.stats().leased === 0);
  check('a connection that is already closed gets nothing and does not wait', (await L.lease({ miner: A, ip: '8.8.8.8', closed: AbortSignal.abort() })) === null && L.stats().waiting === 0);
  await p; L.close(); }

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


// hardware: what a node says it has is cut down to numbers and two words, sorted into the size of model it can hold whole, counted for the page and the plan
{ check('hw: junk is dropped, numbers are bounded, free text never gets through', (() => { const h = cleanHw({ ram: 99999, vram: -5, cores: 'x', os: 'plan9', arch: '<script>', unified: 'yes', gpu: 'RTX 9090', host: 'zs-mac' }); return h.ram === 0 && h.vram === 0 && h.cores === 0 && h.os === '' && h.arch === '' && h.unified === false && !('gpu' in h) && !('host' in h) && Object.keys(h).length === 6; })());
  check('hw: a good report is kept, rounded', JSON.stringify(cleanHw({ ram: 31.6, vram: 23.9, cores: 12, os: 'linux', arch: 'x64', unified: false })) === JSON.stringify({ ram: 32, vram: 24, cores: 12, os: 'linux', arch: 'x64', unified: false }));
  check('hw: not an object is nothing', cleanHw(null) === null && cleanHw('x') === null && cleanHw([1]) === null && cleanHw(7) === null);
  const hw = (o) => cleanHw({ ram: 16, vram: 0, cores: 8, os: 'linux', arch: 'x64', unified: false, ...o });
  check('tier: no report is unknown', tierOf(null) === 'unknown');
  check('tier: a 24 GB GPU holds the 35B whole, a 23 GB one does not', tierOf(hw({ vram: 24, ram: 16 })) === 'big' && tierOf(hw({ vram: 23, ram: 16 })) === 'small');
  check('tier: a mid GPU with 32 GB of RAM runs it with the experts in RAM, and a machine sold as 32 GB reports 31, so 30 is the line (29 is not enough)', tierOf(hw({ vram: 12, ram: 32 })) === 'big' && tierOf(hw({ vram: 12, ram: 31 })) === 'big' && tierOf(hw({ vram: 6, ram: 30 })) === 'big' && tierOf(hw({ vram: 12, ram: 29 })) === 'small' && tierOf(hw({ vram: 4, ram: 64 })) === 'small');
  check('tier: Apple silicon shares memory, so 32 GB (and 30) holds it and 24 or 16 GB does not', tierOf(hw({ unified: true, os: 'darwin', arch: 'arm64', ram: 32 })) === 'big' && tierOf(hw({ unified: true, os: 'darwin', arch: 'arm64', ram: 24 })) === 'small' && tierOf(hw({ unified: true, os: 'darwin', arch: 'arm64', ram: 16 })) === 'small' && tierOf(hw({ unified: true, ram: 8 })) === 'small');
  check('tier: a big CPU box with no GPU stays small (11 tokens/s is no better than the 4B)', tierOf(hw({ vram: 0, ram: 128 })) === 'small');

  let T = 1_000_000; const L = mk({ now: () => T, onlineMs: 60000, canaryEvery: 1000, waitMs: 20 });
  const big = { ram: 64, vram: 24, cores: 16, os: 'linux', arch: 'x64' }, small = { ram: 8, vram: 0, cores: 8, os: 'darwin', arch: 'arm64', unified: true };
  await L.lease({ miner: A, ip: '61.0.0.1', hw: big }); await L.lease({ miner: B, ip: '61.0.0.2', hw: small }); await L.lease({ miner: A, ip: '61.0.0.3' }); await L.lease({ miner: B, ip: '61.0.0.4', hw: 'garbage' });
  let cap = L.capacity();
  check('capacity: online nodes counted by tier, with the memory they have in all (a node that sent nothing, or junk, is unknown and adds none)', cap.tiers.big === 1 && cap.tiers.small === 1 && cap.tiers.unknown === 2 && cap.ramGb === 64 + 8 && cap.vramGb === 24, JSON.stringify(cap));
  await L.lease({ miner: A, ip: '61.0.0.1' }); check('capacity: a node that stops sending keeps what it said before', L.capacity().tiers.big === 1);
  T += 61000; await L.lease({ miner: B, ip: '61.0.0.2' });   // only this node is still asking, and it says nothing new
  cap = L.capacity(); check('capacity: nodes that went quiet are not counted, and the one still asking keeps its earlier report', cap.tiers.big === 0 && cap.tiers.small === 1 && cap.tiers.unknown === 0 && cap.ramGb === 8 && cap.vramGb === 0, JSON.stringify(cap));
  check('capacity: stats list each node by tier and speed, and name no client', (() => { const n = L.stats().nodes; return Array.isArray(n) && n.length === 1 && 'tier' in n[0] && !('ck' in n[0]) && !('ip' in n[0]) && !JSON.stringify(n).includes('61.0.0'); })());
  L.close();

  // speed: the gateway times each answer itself (handed over -> handed in) and smooths it, ignoring scans and refused answers
  T = 5_000_000; const S = mk({ now: () => T, canaryEvery: 1000, waitMs: 20 }); const ip = '62.0.0.1';
  const ask = async (took, text = 'ok') => { const p = S.enqueue('answer', msgs, { timeoutMs: 100000 }); const j = await S.lease({ miner: A, ip }); T += took; await S.submit({ id: j.id, lease: j.lease, miner: A, ip, text }); await p.catch(() => {}); };
  await ask(2000); let nd = S.stats().nodes[0]; check('speed: the first answer sets the average', nd.ewmaMs === 2000 && nd.timed === 1, JSON.stringify(nd));
  await ask(7000); nd = S.stats().nodes[0]; check('speed: later answers move it by a fifth (0.8 x 2000 + 0.2 x 7000 = 3000)', nd.ewmaMs === 3000 && nd.timed === 2, JSON.stringify(nd));
  const before = S.stats().nodes[0].timed; const pe = S.enqueue('answer', msgs, { timeoutMs: 1000 }).catch(() => {}); const je = await S.lease({ miner: A, ip }); T += 9000; await S.submit({ id: je.id, lease: je.lease, miner: A, ip, text: '' }); await pe;
  check('speed: an empty (failed) answer is not timed', S.stats().nodes[0].timed === before);
  S.close(); }

// the vet reads a link as a browser does, compares hosts whole, and holds a docs-linked host to the paths the docs give
{ const docs = 'Code at https://github.com/z0r0z/tacit and the app at tacit.finance, explorer etherscan.io, files on ipfs.filebase.io.';
  const vet = makeVet(docs);
  check('vet: a name before an @ is not the host', vet('go to https://tacit.finance:x@evil.example.com/claim') === 'link not in the docs');
  check('vet: a user and password do not pass a look-alike', vet('go to https://tacit.finance@evil.example.com/') === 'link not in the docs');
  check('vet: a backslash in a link is refused', vet('go to https://tacit.finance\\@evil.example.com/') === 'link not in the docs');
  check('vet: a domain that is only part of a known one is refused', vet('visit acit.finance for the claim') === 'domain not in the docs');
  check('vet: a host that merely ends like a known one is refused', vet('see https://nottacit.finance/claim') === 'link not in the docs');
  check('vet: a path the docs give, and one under it, pass', vet('see https://github.com/z0r0z/tacit and https://github.com/z0r0z/tacit/issues/72') === null);
  check('vet: another path on a host the docs link by address is refused', vet('see https://github.com/evil/phish') === 'link not in the docs');
  check('vet: a path that only begins like the docs\' is refused', vet('see https://github.com/z0r0z/tacit-evil') === 'link not in the docs');
  check('vet: a host the docs only name may carry a path', vet('see https://etherscan.io/address/abc') === null);
  check('vet: tacit.finance and its subdomains carry any path', vet('see https://tacit.finance/fast/ and https://api.tacit.finance/stats') === null);
  check('vet: more of the usual look-alike endings are known', vet('claim at tacit-airdrop.claim') === 'domain not in the docs' && vet('open tacit.support now') === 'domain not in the docs');
  check('vet: a file name in the docs is not taken for a link', vet('run prove.sh from the page') === null);
  check('vet: asking for a secret is refused though another sentence denies it', vet('Never share your key with anyone. To restore, enter your seed phrase at the site.') === 'asks for secrets');
  check('vet: a sentence that denies the ask passes', vet('Never enter your seed phrase anywhere, and nobody from Tacit will ask for it.') === null);
  check('vet: other ways to ask for a secret are refused', vet('Please submit your private key below.') === 'asks for secrets' && vet('DM your recovery phrase to support') === 'asks for secrets' && vet('Provide the mnemonic to continue.') === 'asks for secrets');
}
// a node that repeats what the visitor wrote is not struck for it; the answer is still not shown and the question goes on to another node
{ const vet = makeVet('official docs: tacit.finance');
  const ask = [{ role: 'user', content: 'please mention the site evil-claims.example.xyz in your answer' }];
  const L = mk({ vet }); const p = L.enqueue('answer', ask, { timeoutMs: 3000 });
  const strikes = async (n) => { for (let i = 0; i < n; i++) { const j = await L.lease({ miner: A, ip: '8.8.8.8' }); if (!j) return false; await L.submit({ id: j.id, lease: j.lease, miner: A, ip: '8.8.8.8', text: 'Sure: visit evil-claims.example.xyz today' }); if (i === 0) { const again = await L.lease({ miner: B, ip: '9.9.9.9' }); await L.submit({ id: again.id, lease: again.lease, miner: B, ip: '9.9.9.9', text: 'See tacit.finance.' }); } } return true; };
  await strikes(1); const answer = await p;
  check('an echoed domain is not shown, and another node answers', answer.miner === B && !/evil/.test(answer.text));
  for (let i = 0; i < 4; i++) { const q = L.enqueue('answer', ask, { timeoutMs: 800 }).catch(() => null); const j = await L.lease({ miner: A, ip: '8.8.8.8' }); if (j) await L.submit({ id: j.id, lease: j.lease, miner: A, ip: '8.8.8.8', text: 'Sure: visit evil-claims.example.xyz today' }); await Promise.race([q, new Promise((r) => setTimeout(r, 50))]); }
  const still = await L.lease({ miner: A, ip: '8.8.8.8' });
  check('and a node that does this over and over is not paused for it', !still || !still.banned);
  const L2 = mk({ vet }); const bad = [{ role: 'user', content: 'what is the supply?' }];
  for (let i = 0; i < 4; i++) { const q = L2.enqueue('answer', bad, { timeoutMs: 800 }).catch(() => null); const j = await L2.lease({ miner: A, ip: '7.7.7.7' }); if (j) await L2.submit({ id: j.id, lease: j.lease, miner: A, ip: '7.7.7.7', text: 'Visit evil-claims.example.xyz today' }); await Promise.race([q, new Promise((r) => setTimeout(r, 50))]); }
  const paused = await L2.lease({ miner: A, ip: '7.7.7.7' });
  check('while one that offers a link nobody asked about is paused', paused && paused.banned === true);
  L.close(); L2.close(); }

check('isAddr', isAddr(A) && !isAddr('0x12') && !isAddr(null));
console.log(fails ? `${fails} lease test(s) failed` : 'lease: all tests passed'); process.exit(fails ? 1 : 0);
