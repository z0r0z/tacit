#!/usr/bin/env node
// Is our own node fit for the jobs we want to give it? Not "is it up": each check is something one of our consumers does,
// compared with public nodes where there is a right answer (own-nodes/README.md says which consumer needs which role).
//
//   node tools/node-check.mjs --eth https://node.tacit.finance/eth --btc https://node.tacit.finance/btc/api \
//        [--origin https://tacit.finance] [--btc-rpc http://user:pass@127.0.0.1:8332] [--broadcast-path]
//        [--from-block 25998736] [--eth-ref url,url] [--btc-ref url,url] [--json]
//        [--light]        the Ethereum node is a LIGHT client (Nethermind): state history 32 blocks, getLogs 512 blocks. The depths are scaled to
//                         that, and what it cannot give (old proofs, wide logs) is reported "NOT PROVIDED" instead of failed, so nobody reads a
//                         pass as covering the keeper's 8-hour-old proofs.
//        [--btc-pruned]   the --btc-rpc node is a PRUNED bitcoind: judged on headers, fees, mempool, broadcast and recent blocks, not on history.
//        [--eth-key https://<host>/k/<KEY>/eth]   the keyed path our services use: role eth-trace traces a recent pool transaction and one ~2 days old
//                         (the fast-bridge providers' FB_LP_TRACE_RPCS) with the dapp's own tracer, and compares the pool calls with public tracers
//        [--btc-index]    the --btc base is bitcoind + electrs behind the gateway's esplora reads (own-nodes/btc-index.mjs): role btc-index compares
//                         every read shape the pages use with a public esplora; /mempool/recent is NOT PROVIDED there
//
// Exit 0 when every role that could be checked passed; 1 when one failed. A role whose references all failed to answer is
// "unverified", never "pass".
import process from 'node:process';

const DEPOSIT = '0x00000000219ab540356cBB839Cbe05303d7705Fa';   // few logs, a balance that moves every block: an anchor to compare
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const OLD_TX = { id: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16', height: 170 };   // block 170, the first transfer between people
const OLD_ADDR = '1Q2TWHE3GMdB6BZKafqwxXtWAWgFt5Jvm3';          // the block-170 recipient: ~60 transactions, three pages, spent and unspent outputs
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';     // the confidential pool: its claims are what the trace path reads
const TRACE_REFS = ['https://eth.drpc.org', 'https://ethereum-json-rpc.stakely.io', 'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7'];
const noAsm = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k.endsWith('_asm') ? undefined : v)));
const mask = (s) => String(s).replace(/\/k\/[^/]+\//g, '/k/***/');
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
      const stateBack = o.light ? 16 : 500, logSpan = o.light ? 500 : 9999;
      const at = hex(head - stateBack);
      try {
        const mine = await rpc(o.eth, 'eth_getBalance', [DEPOSIT, at]);
        const ref = await firstRef(o.ethRefs || ETH_REFS, (u) => rpc(u, 'eth_getBalance', [DEPOSIT, at]));
        add(R, `old state (${stateBack} blocks back)`, !ref ? 'warn' : ref.v === mine ? 'pass' : 'fail', ref ? `${num(mine)} vs ${new URL(ref.u).host}` : 'no reference served it');
      } catch (e) { add(R, `old state (${stateBack} blocks back)`, 'fail', e.message); }

      try {
        const mine = await rpc(o.eth, 'eth_getLogs', [{ fromBlock: hex(head - logSpan), toBlock: hex(head), address: DEPOSIT }]);
        const ref = await firstRef(o.ethRefs || ETH_REFS, (u) => rpc(u, 'eth_getLogs', [{ fromBlock: hex(head - logSpan), toBlock: hex(head), address: DEPOSIT }]));
        add(R, `logs, last ${(logSpan + 1).toLocaleString('en-US')} blocks`, !ref ? 'warn' : ref.v.length === mine.length ? 'pass' : 'fail', `${mine.length} logs${ref ? ` (${new URL(ref.u).host}: ${ref.v.length})` : ''}`);
      } catch (e) { add(R, `logs, last ${(logSpan + 1).toLocaleString('en-US')} blocks`, 'fail', e.message); }

      try {
        const batch = await f(o.eth, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_getBalance', params: [DEPOSIT, 'latest'] }))), signal: AbortSignal.timeout(timeout) });
        const j = await batch.json();
        add(R, 'batch of 10', Array.isArray(j) && j.length === 10 && j.every((x) => x.result) ? 'pass' : 'fail', Array.isArray(j) ? `${j.length} answers` : 'not an array');
      } catch (e) { add(R, 'batch of 10', 'fail', e.message); }

      // the keeper checks ~8 h back (2,400 blocks); eth_prove asks at a recent block; public nodes mostly serve neither
      if (o.light) add('eth-proofs', 'eth_getProof 2,400 blocks back', 'skip', 'a light client keeps 32 blocks of state: the keeper must keep a node that serves old proofs');
      for (const back of o.light ? [2] : [2400, 2]) {
        const id = `eth_getProof ${back === 2400 ? '2,400' : back} blocks back`;
        try {
          const p = await rpc(o.eth, 'eth_getProof', [WETH, [], hex(head - back)]);
          add(o.light ? 'eth-proofs-head' : 'eth-proofs', id, Array.isArray(p?.accountProof) && p.accountProof.length && /^0x[0-9a-f]{64}$/.test(p.storageHash || '') ? 'pass' : 'fail', `${p?.accountProof?.length ?? 0} proof nodes`);
        } catch (e) { add(o.light ? 'eth-proofs-head' : 'eth-proofs', id, 'fail', e.message); }
      }

      // the pool scans start at its deploy block, so receipts must reach that far, and match what an archive says
      const from = o.fromBlock ?? 25_998_736;
      if (o.light) add('eth-wide-logs', `logs from the pool's deploy block (${from})`, 'skip', 'a light client answers 512 blocks a query: history scans keep using an archive-capable node');
      else if (head - from > 0) {
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
        for (const m of ['admin_nodeInfo', 'debug_traceBlockByNumber', 'debug_traceTransaction', 'txpool_content']) { try { await rpc(o.eth, m, m === 'debug_traceBlockByNumber' ? ['latest'] : m === 'debug_traceTransaction' ? ['0x' + '00'.repeat(32), { tracer: 'callTracer' }] : []); } catch (e) { if (e.rpc) refused++; } }
        add(B, 'no admin/debug/txpool API (tracing only on the keyed path)', refused === 4 ? 'pass' : 'fail', `${refused} of 4 refused`);
      } catch (e) { add(B, 'no admin/debug/txpool API', 'fail', e.message); }
      try {
        const t = []; for (let i = 0; i < 10; i++) { const a = Date.now(); await rpc(o.eth, 'eth_getBalance', [DEPOSIT, 'latest']); t.push(Date.now() - a); }
        const m = median(t);
        add(B, 'latency (median of 10 reads, from here)', m <= 1500 ? 'pass' : 'warn', `${m} ms`);
      } catch (e) { add(B, 'latency', 'fail', e.message); }
    }
  }

  if (o.ethKey) {
    const T = 'eth-trace';
    try {
      const { poolCallsTracer, makeTxTracer } = await import('../dapp/fastbridge-evm.js');
      const k = o.ethKey, head = num(await rpc(k, 'eth_blockNumber'));
      // the newest pool transaction at or below `to`, looking back up to 10,000 blocks
      const poolTx = async (to) => {
        for (let hi = to; hi > to - 10_000; hi -= 2000) {
          const logs = await rpc(k, 'eth_getLogs', [{ address: POOL, fromBlock: hex(hi - 1999), toBlock: hex(hi) }]);
          if (logs.length) return logs[logs.length - 1].transactionHash;
        }
        return null;
      };
      const norm = (calls) => JSON.stringify((calls || []).map((c) => ({ to: String(c.to).toLowerCase(), input: String(c.input).toLowerCase() })));
      for (const [label, back] of [['a recent pool transaction', 0], ['a pool transaction ~2 days old', 14_400]]) {
        const tx = await poolTx(head - back);
        if (!tx) { add(T, label, 'warn', 'no pool transaction found in 10,000 blocks'); continue; }
        try {
          const mine = await rpc(k, 'debug_traceTransaction', [tx, { tracer: poolCallsTracer(POOL), timeout: '20s' }]);
          const tree = await rpc(k, 'debug_traceTransaction', [tx, { tracer: 'callTracer', timeout: '20s', tracerConfig: { onlyTopCall: false, withLog: false } }]);
          const ref = await makeTxTracer({ nodes: o.traceRefs || TRACE_REFS, pool: POOL, fetchImpl: f, timeoutMs: timeout })(tx).catch(() => null);
          const ok = Array.isArray(mine) && mine.length > 0 && tree && typeof tree.type === 'string';
          add(T, label, !ok ? 'fail' : !ref ? 'warn' : norm(mine) === norm(ref) ? 'pass' : 'fail', `${tx.slice(0, 12)}…: ${Array.isArray(mine) ? mine.length : 0} pool calls${ref ? ` (public: ${ref.length})` : ', no public tracer answered'}`);
        } catch (e) { add(T, label, 'fail', mask(e.message)); }
      }
      try { await rpc(o.eth || k.replace(/\/k\/[^/]+\//, '/'), 'debug_traceTransaction', ['0x' + '00'.repeat(32), { tracer: poolCallsTracer(POOL) }]); add(T, 'the visitors\' path refuses tracing', 'fail', 'it traced'); }
      catch (e) { add(T, 'the visitors\' path refuses tracing', e.rpc ? 'pass' : 'fail', mask(e.message)); }
    } catch (e) { add(T, 'keyed path', 'fail', mask(e.message)); }
  }

  if (o.btc && o.btcIndex) {
    const X = 'btc-index', base = o.btc.replace(/\/$/, '');
    const refs = o.btcRefs || BTC_REFS;
    const getJ = async (u) => { const r = await f(u, { signal: AbortSignal.timeout(timeout) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
    const same = async (id, path, norm = (x) => x) => {
      try {
        const mine = norm(await getJ(base + path));
        const ref = await firstRef(refs, async (u) => norm(await getJ(u + path)));
        add(X, id, !ref ? 'warn' : JSON.stringify(ref.v) === JSON.stringify(mine) ? 'pass' : 'fail', ref ? `vs ${new URL(ref.u).host}` : 'no reference answered');
      } catch (e) { add(X, id, 'fail', e.message); }
    };
    await same('a transaction, whole (fee, prevouts, status)', `/tx/${OLD_TX.id}`, noAsm);
    await same('its outspends', `/tx/${OLD_TX.id}/outspends`);
    await same('its merkle proof', `/tx/${OLD_TX.id}/merkle-proof`);
    await same('address stats', `/address/${OLD_ADDR}`, (j) => j.chain_stats);
    await same('address utxo', `/address/${OLD_ADDR}/utxo`, (j) => j.map((u) => `${u.txid}:${u.vout}:${u.value}`).sort());
    try {
      const all = []; let page = await getJ(`${base}/address/${OLD_ADDR}/txs/chain`);
      for (let i = 0; i < 20 && page.length; i++) { all.push(...page); if (page.length < 25) break; page = await getJ(`${base}/address/${OLD_ADDR}/txs/chain/${page[page.length - 1].txid}`); }
      const ref = await firstRef(refs, async (u) => (await getJ(`${u}/address/${OLD_ADDR}`)).chain_stats.tx_count);
      add(X, 'every history page, to the end', !ref ? 'warn' : ref.v === all.length && new Set(all.map((t) => t.txid)).size === all.length ? 'pass' : 'fail', `${all.length} transactions${ref ? ` (${ref.v} public)` : ''}`);
    } catch (e) { add(X, 'every history page, to the end', 'fail', e.message); }
    try {
      const fr = await getJ(base + '/v1/fees/recommended');
      const ok = ['fastestFee', 'halfHourFee', 'hourFee', 'economyFee', 'minimumFee'].every((k2) => Number(fr[k2]) >= 1) && fr.fastestFee >= fr.hourFee && fr.hourFee >= fr.economyFee;
      add(X, 'recommended fees (mempool.space shape)', ok ? 'pass' : 'fail', JSON.stringify(fr));
      const mp = await getJ(base + '/mempool');
      add(X, 'mempool summary', mp.count > 0 && Array.isArray(mp.fee_histogram) ? 'pass' : 'fail', `${mp.count} transactions`);
    } catch (e) { add(X, 'fees/mempool', 'fail', e.message); }
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
    } catch (e) { add(R, 'fee estimates', 'fail', e.message); }
    if (o.btcIndex) add(R, 'mempool/recent', 'skip', 'not served by bitcoind + electrs; the pages keep a public explorer for it');
    else {
      try { const mp = await (await get(`${base}/mempool/recent`)).json(); add(R, 'mempool/recent', Array.isArray(mp) ? 'pass' : 'fail', `${mp.length} entries`); }
      catch (e) { add(R, 'mempool/recent', 'fail', e.message); }
    }
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

  if (o.btcRpc && o.btcPruned) {
    const R = 'btc-pruned-node';
    try {
      const u = new URL(o.btcRpc); const auth = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64'); u.username = ''; u.password = '';
      const call = async (method, params = []) => { const r = await f(u.toString(), { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }), signal: AbortSignal.timeout(timeout) }); const j = await r.json(); if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code }); return j.result; };
      const info = await call('getblockchaininfo');
      add(R, 'mainnet, synced', info.chain === 'main' && !info.initialblockdownload && info.verificationprogress > 0.9999 ? 'pass' : 'fail', `${info.chain}, ${info.blocks} blocks, ${(info.verificationprogress * 100).toFixed(3)}%`);
      add(R, 'pruned, with the recent blocks kept', info.pruned === true && info.blocks - info.pruneheight > 1000 ? 'pass' : 'fail', `pruneheight ${info.pruneheight}, tip ${info.blocks}`);
      const refs = o.btcRefs || BTC_REFS;
      try {
        const mine = await call('getblockhash', [info.blocks - 10]);
        const ref = await firstRef(refs, async (b) => { const r = await f(`${b}/block-height/${info.blocks - 10}`, { signal: AbortSignal.timeout(timeout) }); if (!r.ok) throw new Error('x'); return (await r.text()).trim(); });
        add(R, 'block hash 10 back equals the public one', !ref ? 'warn' : ref.v === mine ? 'pass' : 'fail', mine.slice(0, 16) + '…');
      } catch (e) { add(R, 'block hash 10 back equals the public one', 'fail', e.message); }
      try {
        const blk = await call('getblock', [info.bestblockhash, 3]);
        const spend = blk.tx.find((t, i) => i > 0 && t.vin?.length);
        add(R, 'recent block with prevouts (getblock verbosity 3)', spend && spend.vin[0].prevout?.scriptPubKey ? 'pass' : 'fail', spend ? 'prevout present' : 'block had no spend');
      } catch (e) { add(R, 'recent block with prevouts (getblock verbosity 3)', 'fail', e.message); }
      try {
        const fee = await call('estimatesmartfee', [2]);
        add(R, 'fee estimate', fee.feerate > 0 ? 'pass' : 'fail', fee.feerate ? `${(fee.feerate * 1e5).toFixed(2)} sat/vB for 2 blocks` : (fee.errors || []).join('; '));
      } catch (e) { add(R, 'fee estimate', 'fail', e.message); }
      try {
        const mp = await call('getmempoolinfo');
        add(R, 'mempool loaded', mp.loaded ? 'pass' : 'fail', `${mp.size} transactions`);
      } catch (e) { add(R, 'mempool loaded', 'fail', e.message); }
      try {
        let code = null; try { await call('testmempoolaccept', [['00'.repeat(60)]]); } catch (e) { code = e.code; }
        add(R, 'broadcast path answers a malformed transaction with the node\'s reason', code === -22 ? 'pass' : 'fail', `rpc code ${code}`);
      } catch (e) { add(R, 'broadcast path', 'fail', e.message); }
    } catch (e) { add(R, 'bitcoind rpc', 'fail', e.message.replace(/\/\/[^@/]*@/, '//***@')); }
  } else if (o.btcRpc) {
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
  for (const c of out) { const r = roles[c.role] ||= { pass: 0, fail: 0, warn: 0, skip: 0 }; r[c.status]++; }
  const summary = Object.entries(roles).map(([role, n]) => ({ role, verdict: n.fail ? 'FAIL' : n.warn ? 'UNVERIFIED' : n.pass ? 'PASS' : 'NOT PROVIDED', ...n }));
  return { checks: out, summary, ok: summary.every((s) => s.verdict !== 'FAIL') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const list = (k) => (val(k) ? val(k).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
  const o = {
    eth: val('--eth'), btc: val('--btc'), origin: val('--origin'), btcRpc: val('--btc-rpc') || process.env.BTC_RPC,
    broadcastPath: a.includes('--broadcast-path'), fromBlock: val('--from-block') ? Number(val('--from-block')) : undefined,
    ethRefs: list('--eth-ref'), btcRefs: list('--btc-ref'), light: a.includes('--light'), btcPruned: a.includes('--btc-pruned'),
    ethKey: val('--eth-key'), traceRefs: list('--trace-ref'), btcIndex: a.includes('--btc-index'),
  };
  if (!o.eth && !o.btc && !o.btcRpc && !o.ethKey) { console.error('give --eth <url> and/or --btc <esplora base> and/or --btc-rpc <url> (see the header of this file)'); process.exit(2); }
  const res = await runChecks(o);
  if (a.includes('--json')) console.log(JSON.stringify(res, null, 2));
  else {
    const mark = { pass: '✓', fail: '✗', warn: '?', skip: '–' };
    let role = '';
    for (const c of res.checks) { if (c.role !== role) { role = c.role; console.log(`\n${role}`); } console.log(`  ${mark[c.status]} ${c.id}${c.note ? ' — ' + c.note : ''}`); }
    console.log('\n' + res.summary.map((s) => `${s.verdict.padEnd(12)} ${s.role}`).join('\n'));
  }
  process.exit(res.ok ? 0 : 1);
}
