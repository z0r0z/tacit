// The keeper's send path against an anvil fork of Ethereum: one signed transaction goes to every private endpoint (the
// same hash at each), the public node is not used while a private endpoint takes it, and it is used when none does.
// Usage: node tests/evm-pool-keeper-send.test.mjs        (anvil on PATH; FORK_URL to fork from another node)
import { spawn } from 'node:child_process';
import http from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { makeKeeperChain } from '../src/lib/evm-pool-keeper-chain.js';

let failures = 0, passed = 0;
const ok = (c, m, x = '') => { console.log(`${c ? 'ok' : 'not ok'} - ${m}${x ? '  ' + x : ''}`); c ? passed++ : failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 21545 + Math.floor(Math.random() * 2000), fork = `http://127.0.0.1:${port}`;
const anvil = spawn('anvil', ['--port', String(port), '--fork-url', process.env.FORK_URL || 'https://ethereum-rpc.publicnode.com', '--silent'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
const rpc = async (method, params = []) => (await (await fetch(fork, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
for (let i = 0; ; i++) { try { if ((await rpc('eth_chainId')).result) break; } catch {} if (i > 240) throw new Error('anvil did not start'); await sleep(500); }

// A private endpoint: records each raw transaction; `mode` 'take' forwards it to the fork, 'known' answers as a node that
// already has it, 'refuse' fails it.
const endpoint = (mode) => {
  const seen = [];
  const srv = http.createServer(async (q, r) => {
    let body = ''; for await (const c of q) body += c;
    const req = JSON.parse(body), one = async (x) => {
      if (x.method !== 'eth_sendRawTransaction') return (await rpc(x.method, x.params)).result !== undefined ? { jsonrpc: '2.0', id: x.id, result: (await rpc(x.method, x.params)).result } : { jsonrpc: '2.0', id: x.id, error: { code: -32000, message: 'fork error' } };
      seen.push(x.params[0]);
      if (mode === 'refuse') return { jsonrpc: '2.0', id: x.id, error: { code: -32000, message: 'endpoint unavailable' } };
      if (mode === 'known') return { jsonrpc: '2.0', id: x.id, error: { code: -32000, message: 'already known' } };
      const f = await rpc('eth_sendRawTransaction', x.params);
      return { jsonrpc: '2.0', id: x.id, ...(f.error ? { error: f.error } : { result: f.result }) };
    };
    const out = Array.isArray(req) ? await Promise.all(req.map(one)) : await one(req);
    r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(out));
  }).listen(0);
  return { url: `http://127.0.0.1:${srv.address().port}/`, seen, close: () => srv.close() };
};
// The public node: the fork itself, through a counter.
const pubSeen = [];
const pubSrv = http.createServer(async (q, r) => {
  let body = ''; for await (const c of q) body += c;
  const req = JSON.parse(body), one = async (x) => { if (x.method === 'eth_sendRawTransaction') pubSeen.push(x.params[0]); const f = await rpc(x.method, x.params); return { jsonrpc: '2.0', id: x.id, ...(f.error ? { error: f.error } : { result: f.result }) }; };
  const out = Array.isArray(req) ? await Promise.all(req.map(one)) : await one(req);
  r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(out));
}).listen(0);
const pubUrl = `http://127.0.0.1:${pubSrv.address().port}/`;

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', account = privateKeyToAccount(KEY);
await rpc('anvil_setBalance', [account.address, '0x' + (10n ** 18n).toString(16)]);
const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const base = { pool: POOL, router: ROUTER, chainId: 1, minPriorityFee: 50_000_000n, pipeline: false, allowPublicSend: true };
// A transaction to send: the router's sweepReceive of an empty box reverts on chain, which a send without simulation
// does not care about; what is tested is where it goes.
const args = [1n, 25, [[0n, 0n], [[0n, 0n], [0n, 0n]], [0n, 0n], Array(11).fill(0n), '0x0000000000000000000000000000000000000000', 0n, '0x0000000000000000000000000000000000000000', 0n, '0x', '0x']];

{
  const a = endpoint('take'), b = endpoint('known');
  const chain = await makeKeeperChain({ cfg: { ...base, rpcUrls: [pubUrl], sendRpcUrls: [a.url, b.url] }, account });
  const hash = await chain.send('sweepReceive', args, { gas: 300_000n, simulate: false }).catch((e) => e);
  ok(typeof hash === 'string' && /^0x[0-9a-f]{64}$/.test(hash), 'a send returns the hash', String(hash?.message || hash).slice(0, 80));
  for (let i = 0; i < 40 && !(a.seen.length && b.seen.length); i++) await new Promise((r) => setTimeout(r, 25));   // the endpoints are sent to at once: the slower may answer after the send returned
  ok(a.seen.length === 1 && b.seen.length === 1 && a.seen[0] === b.seen[0], 'the same signed transaction reached both private endpoints', `${a.seen.length} + ${b.seen.length}`);
  ok(pubSeen.length === 0, 'and the public node got nothing');
  a.close(); b.close();
}
{
  // one private endpoint takes the request and never answers: the other's answer is the send's, in a moment, not after the first's timeout
  const hungSeen = [];
  const hung = http.createServer(async (q, r) => { let body = ''; for await (const c of q) body += c; hungSeen.push(JSON.parse(body).method); });
  hung.listen(0);
  const a = { url: `http://127.0.0.1:${hung.address().port}/` }, b = endpoint('take');
  const chain = await makeKeeperChain({ cfg: { ...base, rpcUrls: [pubUrl], sendRpcUrls: [a.url, b.url], sendTimeoutMs: 4000 }, account });
  const t0 = Date.now(), hash = await chain.send('sweepReceive', args, { gas: 300_000n, simulate: false }).catch((e) => e);
  const took = Date.now() - t0;
  ok(typeof hash === 'string' && /^0x[0-9a-f]{64}$/.test(hash) && b.seen.length === 1, 'a hung private endpoint does not stop the other from taking it', String(hash?.message || hash).slice(0, 80));
  ok(took < 3000, `and the send does not wait for the hung one's timeout (${took} ms)`);
  ok(hungSeen.length > 0, 'which was asked as well (and never answered)');
  hung.closeAllConnections?.(); hung.close(); b.close();
}
{
  const a = endpoint('refuse'), b = endpoint('take');
  const chain = await makeKeeperChain({ cfg: { ...base, rpcUrls: [pubUrl], sendRpcUrls: [a.url, b.url] }, account });
  const hash = await chain.send('sweepReceive', args, { gas: 300_000n, simulate: false }).catch((e) => e);
  ok(typeof hash === 'string' && b.seen.length === 1 && pubSeen.length === 0, 'one private endpoint refusing does not stop the other, nor send it publicly');
  a.close(); b.close();
}
{
  const a = endpoint('refuse'), b = endpoint('refuse');
  const chain = await makeKeeperChain({ cfg: { ...base, rpcUrls: [pubUrl], sendRpcUrls: [a.url, b.url] }, account });
  const before = pubSeen.length, hash = await chain.send('sweepReceive', args, { gas: 300_000n, simulate: false }).catch((e) => e);
  ok(typeof hash === 'string' && pubSeen.length === before + 1, 'with every private endpoint refusing, the public node takes it (public sends allowed)');
  const c = endpoint('refuse');
  const strict = await makeKeeperChain({ cfg: { ...base, allowPublicSend: false, rpcUrls: [pubUrl], sendRpcUrls: [c.url] }, account });
  const before2 = pubSeen.length, err = await strict.send('sweepReceive', args, { gas: 300_000n, simulate: false }).catch((e) => e);
  ok(err instanceof Error && pubSeen.length === before2, 'and with public sends off, it fails instead', String(err?.message || err).slice(0, 60));
  a.close(); b.close(); c.close();
}
// A chain with no private endpoint (an L2): the read nodes are tried in turn, and the first to take it ends the pass, so a node that is
// rate-limiting does not fail a relay while another would take it, and the one that took it is the only one sent to.
{
  const a = endpoint('refuse'), b = endpoint('take'), c = endpoint('take');
  const chain = await makeKeeperChain({ cfg: { ...base, rpcUrls: [a.url, b.url, c.url], sendRpcUrls: [] }, account });
  const hash = await chain.send('sweepReceive', args, { gas: 300_000n, simulate: false }).catch((e) => e);
  ok(typeof hash === 'string' && /^0x[0-9a-f]{64}$/.test(hash), 'with no private endpoint, a refusing first node is passed over', String(hash?.message || hash).slice(0, 80));
  ok(a.seen.length === 1 && b.seen.length === 1 && c.seen.length === 0, 'the second node took it and the third was not asked', `${a.seen.length}/${b.seen.length}/${c.seen.length}`);
  a.close(); b.close(); c.close();
}
{
  const a = endpoint('refuse'), b = endpoint('refuse');
  const chain = await makeKeeperChain({ cfg: { ...base, rpcUrls: [a.url, b.url], sendRpcUrls: [] }, account });
  const err = await chain.send('sweepReceive', args, { gas: 300_000n, simulate: false }).catch((e) => e);
  ok(err instanceof Error && a.seen.length >= 1 && b.seen.length >= 1, 'and when every read node refuses, the send fails', String(err?.message || err).slice(0, 60));
  a.close(); b.close();
}
// Two pools on one chain with one key (the TAC pool and the TACD pool): their keepers' sends go through one queue, so sends made at the
// same moment by both never read the nonce together: each read comes after the last send went out, and every send has a nonce of its own.
{
  const order = [];
  const relay = (target, tag) => http.createServer(async (q, r) => {
    let body = ''; for await (const c of q) body += c;
    const req = JSON.parse(body), one = async (x) => {
      if (x.method === 'eth_getTransactionCount') order.push('nonce');
      if (x.method === 'eth_sendRawTransaction') order.push('send');
      const f = await rpc(x.method, x.params); return { jsonrpc: '2.0', id: x.id, ...(f.error ? { error: f.error } : { result: f.result }) };
    };
    const out = Array.isArray(req) ? await Promise.all(req.map(one)) : await one(req);
    r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(out));
  }).listen(0);
  const readSrv = relay(), sendSrv = relay();
  const urlOf = (srv) => `http://127.0.0.1:${srv.address().port}/`;
  const TAC_POOL = '0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe', TAC_ROUTER = '0x000000fA029Eaf69840C1490Bf9AA6C094794D5a';
  const TACD_POOL = '0x0000007bDb91d1aa0b5D3106Fd1c44C784b33DBA', TACD_ROUTER = '0x000000e96fcFf90F220fa65F8b82C6114Cd1Cc30';
  const KEY2 = '0x' + '6e'.repeat(32), acct2 = privateKeyToAccount(KEY2);
  await rpc('anvil_setBalance', [acct2.address, '0x' + (10n ** 18n).toString(16)]);
  const cfgOf = (pool, router) => ({ ...base, pool, router, rpcUrls: [urlOf(readSrv)], sendRpcUrls: [urlOf(sendSrv)] });
  const tac = await makeKeeperChain({ cfg: cfgOf(TAC_POOL, TAC_ROUTER), account: acct2 });
  const tacd = await makeKeeperChain({ cfg: cfgOf(TACD_POOL, TACD_ROUTER), account: acct2 });
  order.length = 0;
  const hashes = await Promise.all([tac, tacd, tac, tacd].map((c) => c.send('sweepReceive', args, { gas: 300_000n, simulate: false }).catch((e) => e)));
  const txs = await Promise.all(hashes.map((h) => (typeof h === 'string' ? rpc('eth_getTransactionByHash', [h]).then((r) => r.result) : null)));
  const seq = order.join(' ');
  ok(!/nonce nonce/.test(seq) && (seq.match(/nonce/g) || []).length === 4, 'four sends made at once by two pools\' keepers with one key: each reads the nonce only after the last send went out', seq);
  ok(hashes.every((h) => typeof h === 'string') && new Set(txs.map((x) => x?.nonce)).size === 4, 'and each has a nonce of its own', txs.map((x) => (x ? Number(x.nonce) : '?')).join());
  ok(txs.filter((x) => x?.to?.toLowerCase() === TAC_ROUTER.toLowerCase()).length === 2 && txs.filter((x) => x?.to?.toLowerCase() === TACD_ROUTER.toLowerCase()).length === 2, "each to its own pool's router");
  readSrv.close(); sendSrv.close();
}
// The same two pools behind a private endpoint that keeps what it is sent out of sight until it is mined (as Flashbots does): the read
// node's pending count does not move between the sends, so a key two keepers share counts on from its own last nonce, and both land.
{
  const { keccak256 } = await import('viem');
  const held = [];
  const hold = http.createServer(async (q, r) => {
    let body = ''; for await (const c of q) body += c;
    const req = JSON.parse(body), one = async (x) => {
      if (x.method !== 'eth_sendRawTransaction') { const f = await rpc(x.method, x.params); return { jsonrpc: '2.0', id: x.id, ...(f.error ? { error: f.error } : { result: f.result }) }; }
      held.push(x.params[0]);
      return { jsonrpc: '2.0', id: x.id, result: keccak256(x.params[0]) };
    };
    const out = Array.isArray(req) ? await Promise.all(req.map(one)) : await one(req);
    r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(out));
  }).listen(0);
  const holdUrl = `http://127.0.0.1:${hold.address().port}/`;
  const TAC_POOL = '0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe', TAC_ROUTER = '0x000000fA029Eaf69840C1490Bf9AA6C094794D5a';
  const TACE_POOL = '0x00000091974fB81e7eBA4cF2Cb24869c00a9A1a1', TACE_ROUTER = '0x000000e66C32bEC739180A5eDeeB40A8225c5223';
  const KEY3 = '0x' + '7f'.repeat(32), acct3 = privateKeyToAccount(KEY3);
  await rpc('anvil_setBalance', [acct3.address, '0x' + (10n ** 18n).toString(16)]);
  const cfgOf = (pool, router) => ({ ...base, pool, router, rpcUrls: [pubUrl], sendRpcUrls: [holdUrl], allowPublicSend: false });
  const tac = await makeKeeperChain({ cfg: cfgOf(TAC_POOL, TAC_ROUTER), account: acct3 });
  const tace = await makeKeeperChain({ cfg: cfgOf(TACE_POOL, TACE_ROUTER), account: acct3 });
  const n0 = Number((await rpc('eth_getTransactionCount', [acct3.address, 'pending'])).result);
  const h1 = await tac.send('sweepReceive', args, { gas: 300_000n, simulate: false }).catch((e) => e);
  const h2 = await tace.send('sweepReceive', args, { gas: 300_000n, simulate: false }).catch((e) => e);
  const pendingSeen = Number((await rpc('eth_getTransactionCount', [acct3.address, 'pending'])).result);
  const { parseTransaction } = await import('viem');
  const nonces = held.map((raw) => parseTransaction(raw).nonce);
  ok(typeof h1 === 'string' && typeof h2 === 'string' && pendingSeen === n0, 'two pools\' keepers send one after the other through an endpoint that keeps both out of the read node\'s sight', `pending ${pendingSeen}`);
  ok(nonces.join() === `${n0},${n0 + 1}`, 'and the shared key counts on from its own last nonce, not the read node\'s count', nonces.join());
  for (const raw of held) await rpc('eth_sendRawTransaction', [raw]);
  const landed = await Promise.all([h1, h2].map((h) => rpc('eth_getTransactionReceipt', [h]).then((x) => x.result)));
  ok(landed.every((x) => x && x.status === '0x1' || x?.status === '0x0'), 'both are mined once the endpoint lets them go', landed.map((x) => x?.status).join());
  hold.close();
}
// A private endpoint that takes a transaction and never mines it (the case that left a relayed payment unmined): with no receipt after
// `resendSecs`, the keeper sends the same signed transaction again to the private endpoint (and to the read node as well, when the call
// simulates; an unsimulated send never goes to the read nodes). A mined transaction is left alone, and with public sends off the read node
// is not used.
{
  const { keccak256, parseTransaction } = await import('viem');
  const swallow = () => {
    const held = [];
    const srv = http.createServer(async (q, r) => {
      let body = ''; for await (const c of q) body += c;
      const req = JSON.parse(body), one = async (x) => {
        if (x.method !== 'eth_sendRawTransaction') { const f = await rpc(x.method, x.params); return { jsonrpc: '2.0', id: x.id, ...(f.error ? { error: f.error } : { result: f.result }) }; }
        held.push(x.params[0]);
        return { jsonrpc: '2.0', id: x.id, result: keccak256(x.params[0]) };
      };
      const out = Array.isArray(req) ? await Promise.all(req.map(one)) : await one(req);
      r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(out));
    }).listen(0);
    return { url: `http://127.0.0.1:${srv.address().port}/`, held, close: () => srv.close() };
  };
  const fresh = async (byte) => { const a = privateKeyToAccount('0x' + byte.repeat(32)); await rpc('anvil_setBalance', [a.address, '0x' + (10n ** 18n).toString(16)]); return a; };
  const receiptOf = (h) => rpc('eth_getTransactionReceipt', [h]).then((x) => x.result);

  const acct = await fresh('8a'), s = swallow();
  const chain = await makeKeeperChain({ cfg: { ...base, rpcUrls: [pubUrl], sendRpcUrls: [s.url], resendSecs: 0.6, resendTries: 2 }, account: acct });
  const before = pubSeen.length;
  const hash = await chain.send('sweepReceive', args, { gas: 300_000n, simulate: false });
  ok(s.held.length === 1 && pubSeen.length === before && !(await receiptOf(hash)), 'the private endpoint takes it and nothing mines it', `held ${s.held.length}`);
  // (a send made unsimulated, behind the keeper's own unmined ones, is sent again to the private endpoints only: it cannot be checked
  // against the chain just now, so it is not put on the read nodes)
  for (let i = 0; i < 80 && s.held.length < 3; i++) await sleep(100);
  ok(s.held.length >= 2 && s.held.every((r) => r === s.held[0]), 'with no receipt, it is sent again to the private endpoint, as the same signed transaction', `${s.held.length}`);
  ok(pubSeen.length === before, 'an unsimulated send is not put on the read node', `${pubSeen.length - before}`);
  ok(keccak256(s.held[0]) === hash, 'it is the transaction first sent: the same hash');
  // the endpoint lets it go: it mines, and a mined one is left alone
  await rpc('eth_sendRawTransaction', [s.held[0]]);
  const rc = await receiptOf(hash);
  ok(!!rc && parseTransaction(s.held[0]).nonce === Number((await rpc('eth_getTransactionByHash', [hash])).result.nonce), 'once the endpoint lets it go it mines at the nonce first used', rc ? `block ${Number(rc.blockNumber)}` : 'no receipt');
  ok(await chain.resend(hash) === false, 'asking to send a mined one again does nothing');
  s.close();
}
{
  const a = privateKeyToAccount('0x' + '8b'.repeat(32));
  await rpc('anvil_setBalance', [a.address, '0x' + (10n ** 18n).toString(16)]);
  const { keccak256 } = await import('viem');
  const held = [];
  const srv = http.createServer(async (q, r) => {
    let body = ''; for await (const c of q) body += c;
    const req = JSON.parse(body), one = async (x) => {
      if (x.method !== 'eth_sendRawTransaction') { const f = await rpc(x.method, x.params); return { jsonrpc: '2.0', id: x.id, ...(f.error ? { error: f.error } : { result: f.result }) }; }
      held.push(x.params[0]);
      return { jsonrpc: '2.0', id: x.id, result: keccak256(x.params[0]) };
    };
    const out = Array.isArray(req) ? await Promise.all(req.map(one)) : await one(req);
    r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(out));
  }).listen(0);
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const before = pubSeen.length;
  const strict = await makeKeeperChain({ cfg: { ...base, allowPublicSend: false, rpcUrls: [pubUrl], sendRpcUrls: [url], resendSecs: 0.5, resendTries: 2 }, account: a });
  await strict.send('sweepReceive', args, { gas: 300_000n, simulate: false });
  for (let i = 0; i < 200 && held.length < 3; i++) await sleep(100);   // (the fork looks an unknown receipt up upstream, so each look takes a moment)
  await sleep(1500);
  ok(held.length === 3 && pubSeen.length === before, 'with public sends off it is sent to the private endpoint again, never the read node', `${held.length} private, ${pubSeen.length - before} public`);
  const b2 = privateKeyToAccount('0x' + '8c'.repeat(32));
  await rpc('anvil_setBalance', [b2.address, '0x' + (10n ** 18n).toString(16)]);
  const off = await makeKeeperChain({ cfg: { ...base, rpcUrls: [pubUrl], sendRpcUrls: [url], resendSecs: 0 }, account: b2 });
  held.length = 0;
  await off.send('sweepReceive', args, { gas: 300_000n, simulate: false });
  await sleep(1500);
  ok(held.length === 1, 'and with resendSecs 0 it is never sent again', `${held.length}`);
  srv.close();
}
// A transaction whose nonce another service has taken (the older per-chain keeper signs with the same key and picked the same nonce, its own
// send out of sight of the read nodes): sending the first again can never mine it, so the keeper signs the same call again with a nonce of
// its own. That one mines; the first never does; the call is not signed a third time; a send nobody took the nonce from is left alone.
{
  const { keccak256, parseTransaction } = await import('viem');
  const held = [];
  const srv = http.createServer(async (q, r) => {
    let body = ''; for await (const c of q) body += c;
    const req = JSON.parse(body), one = async (x) => {
      if (x.method !== 'eth_sendRawTransaction') { const f = await rpc(x.method, x.params); return { jsonrpc: '2.0', id: x.id, ...(f.error ? { error: f.error } : { result: f.result }) }; }
      held.push(x.params[0]);
      return { jsonrpc: '2.0', id: x.id, result: keccak256(x.params[0]) };
    };
    const out = Array.isArray(req) ? await Promise.all(req.map(one)) : await one(req);
    r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(out));
  }).listen(0);
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const acct = privateKeyToAccount('0x' + '8d'.repeat(32));
  await rpc('anvil_setBalance', [acct.address, '0x' + (10n ** 18n).toString(16)]);
  const logs = [];
  const chain = await makeKeeperChain({ cfg: { ...base, allowPublicSend: false, rpcUrls: [pubUrl], sendRpcUrls: [url], resendSecs: 0.5, resendTries: 4, nonceGraceSecs: 0.3 }, account: acct, log: (l) => logs.push(l) });
  const hash = await chain.send('sweepReceive', args, { gas: 300_000n, simulate: false });
  const n = parseTransaction(held[0]).nonce;
  // the other service's transaction takes that nonce and mines
  const theirs = await acct.signTransaction({ chainId: 1, type: 'eip1559', to: acct.address, value: 1n, nonce: n, gas: 21_000n, maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 10n ** 9n });
  const took = await rpc('eth_sendRawTransaction', [theirs]);
  ok(!took.error && Number((await rpc('eth_getTransactionCount', [acct.address, 'latest'])).result) === n + 1, "another transaction from the key takes the send's nonce", took.error?.message || `nonce ${n}`);
  for (let i = 0; i < 200 && new Set(held).size < 2; i++) await sleep(100);
  const raws = [...new Set(held)];
  ok(raws.length === 2 && parseTransaction(raws[1]).nonce === n + 1 && keccak256(raws[1]) !== hash, 'the keeper signs the call again with the next nonce, a new hash', raws.map((r) => parseTransaction(r).nonce).join());
  ok(logs.some((l) => l.includes('lost its nonce') && l.includes(hash) && l.includes(keccak256(raws[1]))), 'and says which hash took its place', logs.find((l) => l.includes('lost its nonce'))?.slice(0, 120) || 'no log');
  await rpc('eth_sendRawTransaction', [raws[1]]);
  const mined = (await rpc('eth_getTransactionReceipt', [keccak256(raws[1])])).result;
  ok(!!mined && !(await rpc('eth_getTransactionReceipt', [hash])).result, 'the new one mines, the first never does', mined ? `block ${Number(mined.blockNumber)}` : 'no receipt');
  await sleep(4000);
  ok(new Set(held).size === 2, 'and the call is not signed again once the new one has mined', `${new Set(held).size} distinct`);
  // a send whose nonce nobody took is only sent again unchanged, never signed again
  const acct2 = privateKeyToAccount('0x' + '8e'.repeat(32));
  await rpc('anvil_setBalance', [acct2.address, '0x' + (10n ** 18n).toString(16)]);
  held.length = 0;
  const calm = await makeKeeperChain({ cfg: { ...base, allowPublicSend: false, rpcUrls: [pubUrl], sendRpcUrls: [url], resendSecs: 0.5, resendTries: 3, nonceGraceSecs: 0.3 }, account: acct2 });
  await calm.send('sweepReceive', args, { gas: 300_000n, simulate: false });
  for (let i = 0; i < 200 && held.length < 3; i++) await sleep(100);
  ok(held.length >= 3 && new Set(held).size === 1, 'a swallowed send whose nonce is still free is sent again unchanged, not signed again', `${held.length} sends, ${new Set(held).size} distinct`);
  srv.close();
}
pubSrv.close();
console.log(`\n${passed} passed${failures ? `, ${failures} failed` : ''}`);
process.exit(failures ? 1 : 0);
