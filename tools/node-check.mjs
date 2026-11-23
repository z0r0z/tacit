#!/usr/bin/env node
// Is our own node fit for the jobs we want to give it? Not "is it up": each check is something one of our consumers does,
// compared with public nodes where there is a right answer (own-nodes/README.md says which consumer needs which role).
//
//   node tools/node-check.mjs --eth https://node.tacit.finance/eth --btc https://node.tacit.finance/btc/api \
//        [--origin https://tacit.finance] [--btc-rpc http://user:pass@127.0.0.1:8332] [--broadcast-path]
//        [--from-block 25998736] [--eth-ref url,url] [--btc-ref url,url] [--json]
//
// Exit 0 when every role that could be checked passed; 1 when one failed. A role whose references all failed to answer is
// "unverified", never "pass".
import process from 'node:process';

const DEPOSIT = '0x00000000219ab540356cBB839Cbe05303d7705Fa';   // few logs, a balance that moves every block: an anchor to compare
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const OLD_TX = { id: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16', height: 170 };   // block 170, the first transfer between people
const OLD_ADDR = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';          // thousands of transactions: pages and old history
const ETH_REFS = ['https://ethereum-rpc.publicnode.com', 'https://rpc.mevblocker.io', 'https://mainnet.rpc.buidlguidl.com'];
const BTC_REFS = ['https://mempool.space/api', 'https://blockstream.info/api', 'https://mempool.emzy.de/api'];
const hex = (n) => '0x' + n.toString(16);
const num = (h) => (typeof h === 'string' && /^0x[0-9a-f]+$/i.test(h) ? parseInt(h, 16) : null);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

export async function runChecks(o) {
  const origin = o.origin || 'https://tacit.finance';
  const timeout = o.timeoutMs || 45_000;
  const f = o.fetchImpl || fetch;
  const out = [];
  const add = (role, id, status, note) => out.push({ role, id, status, note });
  const rpc = async (url, method, params = [], type = 'application/json', headers = {}) => {
    const r = await f(url, { method: 'POST', headers: { 'content-type': type, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeout) });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(j.error.message || 'rpc error'), { rpc: j.error });
    return j.result;
  };
  const firstRef = async (refs, fn) => { for (const u of refs) { try { const v = await fn(u); if (v !== undefined) return { u, v }; } catch { /* next */ } } return null; };

  if (o.eth) {
    const R = 'eth-reads';
    let head = null;
    try {
      const id = await rpc(o.eth, 'eth_chainId');
      add(R, 'chain id', id === '0x1' ? 'pass' : 'fail', id);
      head = num(await rpc(o.eth, 'eth_blockNumber'));
      const heads = (await Promise.all((o.ethRefs || ETH_REFS).map((u) => rpc(u, 'eth_blockNumber').then(num).catch(() => null)))).filter((x) => x != null);
      if (!heads.length) add(R, 'head in step', 'warn', `ours ${head}; no reference answered`);
      else { const m = median(heads); add(R, 'head in step', Math.abs(head - m) <= 3 ? 'pass' : 'fail', `ours ${head}, public median ${m} (${heads.length} answered)`); }
    } catch (e) { add(R, 'reachable', 'fail', e.message); }

    if (head != null) {
      const at = hex(head - 500);
      try {
        const mine = await rpc(o.eth, 'eth_getBalance', [DEPOSIT, at]);
        const ref = await firstRef(o.ethRefs || ETH_REFS, (u) => rpc(u, 'eth_getBalance', [DEPOSIT, at]));
        add(R, 'old state (500 blocks back)', !ref ? 'warn' : ref.v === mine ? 'pass' : 'fail', ref ? `${num(mine)} vs ${new URL(ref.u).host}` : 'no reference served it');
      } catch (e) { add(R, 'old state (500 blocks back)', 'fail', e.message); }

      try {
        const mine = await rpc(o.eth, 'eth_getLogs', [{ fromBlock: hex(head - 9999), toBlock: hex(head), address: DEPOSIT }]);
        const ref = await firstRef(o.ethRefs || ETH_REFS, (u) => rpc(u, 'eth_getLogs', [{ fromBlock: hex(head - 9999), toBlock: hex(head), address: DEPOSIT }]));
        add(R, 'logs, last 10,000 blocks', !ref ? 'warn' : ref.v.length === mine.length ? 'pass' : 'fail', `${mine.length} logs${ref ? ` (${new URL(ref.u).host}: ${ref.v.length})` : ''}`);
      } catch (e) { add(R, 'logs, last 10,000 blocks', 'fail', e.message); }

      try {
        const batch = await f(o.eth, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_getBalance', params: [DEPOSIT, 'latest'] }))), signal: AbortSignal.timeout(timeout) });
        const j = await batch.json();
        add(R, 'batch of 10', Array.isArray(j) && j.length === 10 && j.every((x) => x.result) ? 'pass' : 'fail', Array.isArray(j) ? `${j.length} answers` : 'not an array');
      } catch (e) { add(R, 'batch of 10', 'fail', e.message); }

      // the keeper checks ~8 h back (2,400 blocks); eth_prove asks at a recent block; public nodes mostly serve neither
      for (const back of [2400, 2]) {
        const id = `eth_getProof ${back === 2400 ? '2,400' : back} blocks back`;
        try {
          const p = await rpc(o.eth, 'eth_getProof', [WETH, [], hex(head - back)]);
          add('eth-proofs', id, Array.isArray(p?.accountProof) && p.accountProof.length && /^0x[0-9a-f]{64}$/.test(p.storageHash || '') ? 'pass' : 'fail', `${p?.accountProof?.length ?? 0} proof nodes`);
        } catch (e) { add('eth-proofs', id, 'fail', e.message); }
      }

      // the pool scans start at its deploy block, so receipts must reach that far, and match what an archive says
      const from = o.fromBlock ?? 25_998_736;
      if (head - from > 0) {
        try {
          const q = { fromBlock: hex(from), toBlock: hex(from + 44_999), address: DEPOSIT };
          const mine = await rpc(o.eth, 'eth_getLogs', [q]);
          const ref = await firstRef(o.ethRefs || ETH_REFS, (u) => rpc(u, 'eth_getLogs', [q]));
          const same = ref && ref.v.length === mine.length && (!mine.length || ref.v[0].transactionHash === mine[0].transactionHash);
          add('eth-wide-logs', `logs from the pool's deploy block (${from})`, !ref ? 'warn' : same ? 'pass' : 'fail', `${mine.length} logs${ref ? ` (${new URL(ref.u).host}: ${ref.v.length})` : ', no reference answered'}`);
        } catch (e) { add('eth-wide-logs', `logs from the pool's deploy block (${from})`, 'fail', e.message); }
      }

      // the browser's way in
      const B = 'eth-browser';
      try {
        const pre = await f(o.eth, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }, signal: AbortSignal.timeout(timeout) });
        const ao = pre.headers.get('access-control-allow-origin');
        add(B, 'CORS preflight', pre.status < 300 && (ao === origin || ao === '*') && /content-type/i.test(pre.headers.get('access-control-allow-headers') || '') ? 'pass' : 'fail', `${pre.status}, allow-origin ${ao}`);
        const r = await f(o.eth, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8', origin }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), signal: AbortSignal.timeout(timeout) });
        const ao2 = r.headers.get('access-control-allow-origin');
        add(B, 'text/plain body + CORS on the answer', (await r.json()).result && (ao2 === origin || ao2 === '*') ? 'pass' : 'fail', `allow-origin ${ao2}`);
      } catch (e) { add(B, 'CORS', 'fail', e.message); }
      try {
        let refused = 0;
        for (const m of ['admin_nodeInfo', 'debug_traceBlockByNumber', 'txpool_content']) { try { await rpc(o.eth, m, m.startsWith('debug') ? ['latest'] : []); } catch (e) { if (e.rpc) refused++; } }
        add(B, 'no admin/debug/txpool API', refused === 3 ? 'pass' : 'fail', `${refused} of 3 refused`);
      } catch (e) { add(B, 'no admin/debug/txpool API', 'fail', e.message); }
      try {
        const t = []; for (let i = 0; i < 10; i++) { const a = Date.now(); await rpc(o.eth, 'eth_getBalance', [DEPOSIT, 'latest']); t.push(Date.now() - a); }
        const m = median(t);
        add(B, 'latency (median of 10 reads, from here)', m <= 1500 ? 'pass' : 'warn', `${m} ms`);
      } catch (e) { add(B, 'latency', 'fail', e.message); }
    }
  }

  if (o.btc) {
    const R = 'btc-reads', base = o.btc.replace(/\/$/, '');
    const get = (u, h = {}) => f(u, { headers: h, signal: AbortSignal.timeout(timeout) });
    const refs = o.btcRefs || BTC_REFS;
    try {
      const tip = Number(await (await get(base + '/blocks/tip/height')).text());
      const tips = (await Promise.all(refs.map((u) => get(u + '/blocks/tip/height').then((r) => r.text()).then(Number).catch(() => null)))).filter((x) => Number.isInteger(x));
      if (!Number.isInteger(tip)) throw new Error('tip is not a number');
      if (!tips.length) add(R, 'tip in step', 'warn', `ours ${tip}; no reference answered`);
      else { const m = median(tips); add(R, 'tip in step', Math.abs(tip - m) <= 1 ? 'pass' : 'fail', `ours ${tip}, public median ${m}`); }
      const mine = await (await get(`${base}/block-height/${tip - 10}`)).text();
      const ref = await firstRef(refs, async (u) => { const r = await get(`${u}/block-height/${tip - 10}`); if (!r.ok) throw new Error('x'); return r.text(); });
      add(R, 'block hash 10 back', !ref ? 'warn' : ref.v === mine ? 'pass' : 'fail', mine.slice(0, 16) + '…');
    } catch (e) { add(R, 'tip in step', 'fail', e.message); }
    try {
      const r = await get(`${base}/tx/${OLD_TX.id}`);
      const t = r.ok ? await r.json() : null;
      add(R, 'a block-170 transaction (history is not pruned)', t?.status?.confirmed && t.status.block_height === OLD_TX.height ? 'pass' : 'fail', t ? `height ${t.status?.block_height}` : `HTTP ${r.status}`);
    } catch (e) { add(R, 'a block-170 transaction (history is not pruned)', 'fail', e.message); }
    try {
      const r = await get(`${base}/tx/${OLD_TX.id}/hex`);
      const hexTx = r.ok ? await r.text() : '';
      add(R, 'raw bytes of it', /^[0-9a-f]{200,}$/.test(hexTx.trim()) ? 'pass' : 'fail', r.ok ? `${hexTx.trim().length / 2} bytes` : `HTTP ${r.status}`);
    } catch (e) { add(R, 'raw bytes of it', 'fail', e.message); }
    try {
      const p1 = await (await get(`${base}/address/${OLD_ADDR}/txs/chain`)).json();
      const last = p1[p1.length - 1]?.txid;
      const p2 = last ? await (await get(`${base}/address/${OLD_ADDR}/txs/chain/${last}`)).json() : [];
      const utxo = await (await get(`${base}/address/${OLD_ADDR}/utxo`)).json();
      add(R, 'address history pages + utxo', Array.isArray(p1) && p1.length >= 25 && Array.isArray(p2) && p2.length > 0 && p2[0].txid !== p1[0].txid && Array.isArray(utxo) ? 'pass' : 'fail', `page 1: ${p1.length}, page 2: ${p2.length}, utxos ${utxo.length}`);
    } catch (e) { add(R, 'address history pages + utxo', 'fail', e.message); }
    try {
      const fe = await (await get(`${base}/fee-estimates`)).json();
      const v = Number(fe['1'] ?? fe['2']);
      add(R, 'fee estimates', Number.isFinite(v) && v > 0 && v < 10_000 ? 'pass' : 'fail', `next-block ${v} sat/vB`);
      const mp = await (await get(`${base}/mempool/recent`)).json();
      add(R, 'mempool/recent', Array.isArray(mp) ? 'pass' : 'fail', `${mp.length} entries`);
    } catch (e) { add(R, 'fees/mempool', 'fail', e.message); }
    if (o.broadcastPath) {
      try {
        const r = await f(base + '/tx', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '02000000' + '00'.repeat(120), signal: AbortSignal.timeout(timeout) });
        const t = await r.text();
        add(R, 'broadcast path refuses garbage with the node\'s reason', r.status === 400 && /decode|RPC error|invalid|deserial/i.test(t) ? 'pass' : 'fail', `${r.status} ${t.slice(0, 70)}`);
      } catch (e) { add(R, 'broadcast path', 'fail', e.message); }
    }
    try {
      const pre = await f(base + '/blocks/tip/height', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' }, signal: AbortSignal.timeout(timeout) });
      const g = await get(base + '/blocks/tip/height', { origin });
      const ao = g.headers.get('access-control-allow-origin');
      add('btc-browser', 'CORS on a read', (ao === origin || ao === '*') && pre.status < 400 ? 'pass' : 'fail', `allow-origin ${ao}, preflight ${pre.status}`);
    } catch (e) { add('btc-browser', 'CORS on a read', 'fail', e.message); }
  }

  if (o.btcRpc) {
    const R = 'btc-tweak-index';
    try {
      const u = new URL(o.btcRpc); const auth = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64'); u.username = ''; u.password = '';
      const call = async (method, params = []) => { const r = await f(u.toString(), { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }), signal: AbortSignal.timeout(timeout) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
      const info = await call('getblockchaininfo');
      add(R, 'mainnet, synced', info.chain === 'main' && !info.initialblockdownload && info.verificationprogress > 0.9999 ? 'pass' : 'fail', `${info.chain}, ${info.blocks} blocks, ${(info.verificationprogress * 100).toFixed(3)}%`);
      add(R, 'unpruned (undo data for every block)', info.pruned === false ? 'pass' : 'fail', `pruned=${info.pruned}`);
      const blk = await call('getblock', [info.bestblockhash, 3]);
      const spend = blk.tx.find((t, i) => i > 0 && t.vin?.length);
      add(R, 'getblock verbosity 3 carries prevouts', spend && spend.vin[0].prevout?.scriptPubKey ? 'pass' : 'fail', spend ? 'prevout present' : 'block had no spend');
    } catch (e) { add(R, 'bitcoind rpc', 'fail', e.message.replace(/\/\/[^@/]*@/, '//***@')); }
  }

  const roles = {};
  for (const c of out) { const r = roles[c.role] ||= { pass: 0, fail: 0, warn: 0 }; r[c.status]++; }
  const summary = Object.entries(roles).map(([role, n]) => ({ role, verdict: n.fail ? 'FAIL' : n.warn ? 'UNVERIFIED' : 'PASS', ...n }));
  return { checks: out, summary, ok: summary.every((s) => s.verdict !== 'FAIL') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const list = (k) => (val(k) ? val(k).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
  const o = {
    eth: val('--eth'), btc: val('--btc'), origin: val('--origin'), btcRpc: val('--btc-rpc') || process.env.BTC_RPC,
    broadcastPath: a.includes('--broadcast-path'), fromBlock: val('--from-block') ? Number(val('--from-block')) : undefined,
    ethRefs: list('--eth-ref'), btcRefs: list('--btc-ref'),
  };
  if (!o.eth && !o.btc && !o.btcRpc) { console.error('give --eth <url> and/or --btc <esplora base> and/or --btc-rpc <url> (see the header of this file)'); process.exit(2); }
  const res = await runChecks(o);
  if (a.includes('--json')) console.log(JSON.stringify(res, null, 2));
  else {
    const mark = { pass: '✓', fail: '✗', warn: '?' };
    let role = '';
    for (const c of res.checks) { if (c.role !== role) { role = c.role; console.log(`\n${role}`); } console.log(`  ${mark[c.status]} ${c.id}${c.note ? ' — ' + c.note : ''}`); }
    console.log('\n' + res.summary.map((s) => `${s.verdict.padEnd(10)} ${s.role}`).join('\n'));
  }
  process.exit(res.ok ? 0 : 1);
}
