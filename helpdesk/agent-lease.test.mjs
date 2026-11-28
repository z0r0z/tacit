// node agent-lease.test.mjs -- the `agent` job: a model turn (messages + tools) leased to a node that holds a big model, returned as an assistant message
import { makeLeases, agentMessage } from './lease.mjs';
let fails = 0; const check = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fails++; };
const sl = (ms) => new Promise((r) => setTimeout(r, ms));
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const BIG = { ram: 96, vram: 6, cores: 16, os: 'windows', arch: 'x64', unified: false };      // a big node: 6 GB GPU + 96 GB RAM (tierOf: big)
const SMALL = { ram: 16, vram: 0, cores: 8, os: 'darwin', arch: 'arm64', unified: true };
const MODEL = 'qwen3.6-35b-a3b-q4';
const mk = (extra = {}) => makeLeases({ waitMs: 200, sweepMs: 40, leaseMs: 150, agentLeaseMs: 700, agentModels: ['qwen3.6-35b-a3b', 'qwen3-coder-next'], canaryEvery: 1000, ...extra });
const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'fix it' }];
const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const reply = (o) => JSON.stringify(o);
const call = (name, args, id = 'call_1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

{ // who is handed an agent turn
  const L = mk(); const p = L.enqueue('agent', msgs, { tools, max_tokens: 1024, timeoutMs: 3000 }).catch((e) => e);
  check('a small node that asks for agent work gets none', (await L.lease({ miner: A, ip: '1.1.1.1', kinds: ['agent'], hw: SMALL, model: MODEL })) === null);
  check('a big node that did not ask for it gets none', (await L.lease({ miner: B, ip: '2.2.2.2', kinds: ['answer', 'scan'], hw: BIG, model: MODEL })) === null);
  check('a big node running a model that is not allowed gets none', (await L.lease({ miner: B, ip: '2.2.2.3', kinds: ['agent'], hw: BIG, model: 'qwen3.5-4b-q4_k_m' })) === null);
  check('a node that never said what it runs gets none', (await L.lease({ miner: B, ip: '2.2.2.4', kinds: ['agent'], hw: BIG })) === null);
  const job = await L.lease({ miner: C, ip: '3.3.3.3', kinds: ['agent'], hw: BIG, model: MODEL });
  check('a big node on an allowed model that asked gets the turn, with its tools', job && job.kind === 'agent' && job.messages === msgs && job.tools === tools && job.max_tokens === 1024);
  const r = await L.submit({ id: job.id, lease: job.lease, miner: C, ip: '3.3.3.3', text: reply({ content: '', tool_calls: [call('read_file', { path: 'a.js' })] }) });
  const got = await p;
  check('the caller gets the assistant message back, with who and what answered', got.message && got.message.tool_calls[0].function.name === 'read_file' && got.miner === C && got.node.model === MODEL && got.node.tier === 'big');
  check('an agent turn pays nothing by default (nothing to farm)', r.points === 0 && L.stats().agentNodes >= 0);
  L.close();
}

{ // agent turns are off unless the operator names models
  const L = mk({ agentModels: [] }); const p = L.enqueue('agent', msgs, { tools, timeoutMs: 300 }).catch(() => 'timed out');
  check('with no allowed models no node is handed an agent turn', (await L.lease({ miner: A, ip: '4.4.4.4', kinds: ['agent'], hw: BIG, model: MODEL })) === null);
  check('and the turn times out for the caller', (await p) === 'timed out'); L.close();
}

{ // shape of the reply
  const L = mk(); const p = L.enqueue('agent', msgs, { tools, timeoutMs: 3000 }).catch((e) => e);
  const ip = '5.5.5.5'; const j1 = await L.lease({ miner: A, ip, kinds: ['agent'], hw: BIG, model: MODEL });
  const bad = await L.submit({ id: j1.id, lease: j1.lease, miner: A, ip, text: 'sure, I will do that' });
  check('a reply that is not an assistant message earns nothing and the turn is offered again', bad.points === 0 && L.stats().queued === 1);
  const j2 = await L.lease({ miner: B, ip: '5.5.5.6', kinds: ['agent'], hw: BIG, model: MODEL });
  check('another node gets the same turn', j2 && j2.id === j1.id);
  await L.submit({ id: j2.id, lease: j2.lease, miner: B, ip: '5.5.5.6', text: reply({ content: 'Done.' }) });
  const got = await p; check('and its answer is what the caller receives', got.message.content === 'Done.' && got.miner === B); L.close();
}

{ // a turn nobody can answer fails after maxTries
  const L = mk({ maxTries: 2 }); const p = L.enqueue('agent', msgs, { tools, timeoutMs: 3000 }).catch((e) => e.message);
  for (const [i, who] of [[1, A], [2, B]]) { const j = await L.lease({ miner: who, ip: `6.6.6.${i}`, kinds: ['agent'], hw: BIG, model: MODEL }); await L.submit({ id: j.id, lease: j.lease, miner: who, ip: `6.6.6.${i}`, error: 'the model did not answer' }); }
  check('after maxTries the caller is told no node could answer', /no node could answer/.test(await p)); L.close();
}

{ // long replies are kept (a visitor's answer is cut at 4,000 characters; a model turn is not), and a long lease is honoured
  const L = mk(); const p = L.enqueue('agent', msgs, { tools, timeoutMs: 5000 }).catch((e) => e);
  const ip = '7.7.7.7'; const j = await L.lease({ miner: A, ip, kinds: ['agent'], hw: BIG, model: MODEL });
  await sl(300);   // longer than leaseMs (150) but shorter than agentLeaseMs (700): the lease must still be good
  check('an agent lease outlives the short visitor lease', L.stats().leased === 1);
  const long = 'x'.repeat(9000);
  await L.submit({ id: j.id, lease: j.lease, miner: A, ip, text: reply({ content: long }) });
  const got = await p; check('a 9,000-character reply is not cut', got.message && got.message.content.length === 9000); L.close();
}

{ // a lease that runs out is offered again
  const L = mk({ agentLeaseMs: 120 }); const p = L.enqueue('agent', msgs, { tools, timeoutMs: 3000 }).catch((e) => e);
  const j = await L.lease({ miner: A, ip: '8.8.8.1', kinds: ['agent'], hw: BIG, model: MODEL }); await sl(260);
  check('a turn whose node vanished goes back in the line', L.stats().queued === 1 && L.stats().leased === 0);
  const j2 = await L.lease({ miner: B, ip: '8.8.8.2', kinds: ['agent'], hw: BIG, model: MODEL }); check('and a second node can take it', j2 && j2.id === j.id);
  await L.submit({ id: j2.id, lease: j2.lease, miner: B, ip: '8.8.8.2', text: reply({ content: 'ok' }) }); await p; L.close();
}

{ // hijacks and routing
  const L = mk(); const p = L.enqueue('agent', msgs, { tools, timeoutMs: 2000 }).catch((e) => e);
  const j = await L.lease({ miner: A, ip: '9.9.9.1', kinds: ['agent'], hw: BIG, model: MODEL });
  check('another client cannot submit a lease it was not given', (await L.submit({ id: j.id, lease: j.lease, miner: A, ip: '9.9.9.2', text: reply({ content: 'x' }) })).error === 'no such lease');
  check('a wrong token is refused', (await L.submit({ id: j.id, lease: 'nope', miner: A, ip: '9.9.9.1', text: reply({ content: 'x' }) })).error === 'no such lease');
  await L.submit({ id: j.id, lease: j.lease, miner: A, ip: '9.9.9.1', text: reply({ content: 'fine' }) }); await p;
  // a visitor question still goes to a node that takes answers, whatever else is queued
  const q = L.enqueue('answer', [{ role: 'user', content: 'q' }], { timeoutMs: 1000 }); const a = L.enqueue('agent', msgs, { tools, timeoutMs: 2000 }).catch((e) => e);
  const node = await L.lease({ miner: B, ip: '9.9.9.3', kinds: ['answer'], hw: BIG, model: MODEL });
  check('an answer-only node is given the visitor question, not the agent turn', node && node.kind === 'answer');
  await L.submit({ id: node.id, lease: node.lease, miner: B, ip: '9.9.9.3', text: 'It is 21,000,000.' }); await q;
  const ag = await L.lease({ miner: C, ip: '9.9.9.4', kinds: ['agent'], hw: BIG, model: MODEL }); await L.submit({ id: ag.id, lease: ag.lease, miner: C, ip: '9.9.9.4', text: reply({ content: 'k' }) }); await a; L.close();
}

{ // the message validator
  check('words only is a valid turn', agentMessage('{"content":"hello"}')?.content === 'hello');
  check('tool arguments given as an object are kept as a JSON string', agentMessage('{"tool_calls":[{"function":{"name":"search","arguments":{"pattern":"x"}}}]}')?.tool_calls[0].function.arguments === '{"pattern":"x"}');
  check('a missing call id is filled in', /^call_/.test(agentMessage('{"tool_calls":[{"function":{"name":"search","arguments":"{}"}}]}')?.tool_calls[0].id));
  check('an empty reply is not a turn', agentMessage('{"content":"  "}') === null && agentMessage('{}') === null);
  check('not JSON is not a turn', agentMessage('hello there') === null && agentMessage('[1]') === null && agentMessage(null) === null);
  check('a tool name with odd characters is refused', agentMessage('{"tool_calls":[{"function":{"name":"rm -rf /","arguments":"{}"}}]}') === null);
  check('more than four tool calls is refused', agentMessage(JSON.stringify({ tool_calls: Array.from({ length: 5 }, () => ({ function: { name: 'search', arguments: '{}' } })) })) === null);
  check('oversized arguments are refused', agentMessage(JSON.stringify({ tool_calls: [{ function: { name: 'replace', arguments: 'x'.repeat(13000) } }] })) === null);
  check('unknown fields do not pass through', !('extra' in (agentMessage('{"content":"a","extra":1}') || {})));
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
