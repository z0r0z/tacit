// A chain just big enough for the replaced-transaction tests: a mempool (the hashes this node has heard of), mined transactions, a head, and state kept for
// the last 128 blocks. `c.read(method, params)` is what a page's rpc is.
export function chain() {
  const c = { head: 1000, mempool: new Set(), mined: [], calls: [], down: false };
  const hex = (n) => '0x' + BigInt(n).toString(16);
  const obj = (t) => ({ hash: t.hash, from: t.from, nonce: hex(t.nonce), to: t.to, value: hex(t.value || 0), input: t.input || '0x', blockNumber: t.block == null ? null : hex(t.block) });
  c.all = [];
  c.send = (t) => { const x = { ...t }; c.mempool.add(x.hash); c.all.push(x); return x; };            // (a copy: the chain's records are its own, whatever a test does to its fixtures)
  c.mine = (t, block) => { const x = c.all.find((y) => y.hash === t.hash) || c.send(t); Object.assign(x, t, { block }); c.mined.push(x); c.mempool.delete(x.hash); };
  c.read = async (method, params) => {
    c.calls.push(method);
    if (c.down) throw new Error('Ethereum is unreachable');
    if (method === 'eth_blockNumber') return hex(c.head);
    if (method === 'eth_getTransactionReceipt') { const t = c.mined.find((y) => y.hash === params[0]); return t ? { status: t.status || '0x1', transactionHash: t.hash, blockNumber: hex(t.block), logs: t.logs || [] } : null; }
    if (method === 'eth_getTransactionByHash') {
      const t = (c.all || []).find((y) => y.hash === params[0]);
      return t && (t.block != null || c.mempool.has(t.hash)) ? obj(t) : null;
    }
    if (method === 'eth_getTransactionCount') {
      const at = params[1] === 'latest' ? c.head : Number(params[1]);
      if (c.head - at > 128) throw new Error('missing trie node');
      return hex(c.mined.filter((t) => t.from === params[0].toLowerCase() && t.block <= at).length);
    }
    if (method === 'eth_getBlockByNumber') return { transactions: c.mined.filter((t) => t.block === Number(params[0])).map(obj) };
    throw new Error('no ' + method);
  };
  return c;
}

// Runs `f` once a wait has looked at a transaction while it was held, a moment after: a test's speed-up then never comes before the look it depends on, however busy the machine is
// (a fixed delay did, now and then, and the wait then learned nothing of the transaction and ran out). Gives up after `give` ms, so a wait that never looks lets the process end.
export function whenLooked(c, f, { after = 5, give = 4000 } = {}) {
  const t = setInterval(() => { if (c.calls.includes('eth_getTransactionByHash')) { clearInterval(t); clearTimeout(g); setTimeout(f, after); } }, 2), g = setTimeout(() => clearInterval(t), give);
}

