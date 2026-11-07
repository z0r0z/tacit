// The weld stats reading against a fake chain and explorer: every figure it counts, a later reading that starts from
// what an earlier one kept (it must agree with a reading from nothing), the explorer asked only where an RPC can't
// answer, and a part that can't be read reported as such while the rest still is.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeStatsReader, privateEth, A, ID, TOPIC, SEL, toJson, fromJson, mergeReadings, ZERO32 } from '../dapp/weld/stats/read.js';

const lc = (s) => String(s).toLowerCase();
const w = (v) => (BigInt(v) < 0n ? (1n << 256n) + BigInt(v) : BigInt(v)).toString(16).padStart(64, '0');
const h = (n) => '0x' + n.toString(16);
const tx = (n) => '0x' + w(n);
const addr32 = (a) => '0x' + '00'.repeat(12) + lc(a).slice(2);
const str = (s) => { const b = Buffer.from(s); return w(b.length) + b.toString('hex').padEnd(64, '0'); };
const T0 = 1_760_000_000;

// A world: chain 1 from block 26,000,000, Base and Robinhood device pools, the relay, the points API.
function world() {
  let li = 0;
  const logs = { 1: [], 8453: [], 4663: [] };
  const heads = { 1: 26_000_000, 8453: 51_900_000, 4663: 74_000_000 };
  const log = (chain, address, topics, data, block, txh) => {
    const l = { address, topics, data: '0x' + data, blockNumber: h(block), transactionHash: txh, logIndex: h(li++ % 7), blockTimestamp: h(T0 + (block - 26_000_000) * 12) };
    logs[chain].push(l);
    return l;
  };
  const txs = [], internal = [], senders = {}, balances = { [lc(A.pool)]: 0n, [`1:${lc(A.evmPool)}`]: 0n, [`8453:${lc(A.evmPool)}`]: 0n, [`4663:${lc(A.evmPool)}`]: 0n };
  const state = { outstanding: 0n, leafCount: 0, crossOuts: 3, consumed: 1, tip: 969_000, attested: 968_990, anchor: 964_163, supply: 2_500_000n * 10n ** 18n, locks: {} };
  const calls = { explorer: [], rpc: [] };
  const w_ = {
    logs, heads, txs, internal, senders, balances, state, calls,
    deposit(block, amount, from, direct) {
      const t = tx(900 + txs.length + internal.length);
      log(1, A.pool, [TOPIC.wrap, tx(1), ID.ceth], w(amount), block, t);
      senders[t] = from;
      balances[lc(A.pool)] += amount;
      if (direct) txs.push({ hash: t, from, to: lc(A.pool), blockNumber: String(block), timeStamp: String(T0 + (block - 26_000_000) * 12), isError: '0', methodId: '0x8be3ad21', value: String(amount) });
      else internal.push({ transactionHash: t, index: '0', from: '0x000000005da3e3b73726af3c774deeb9472d4992', to: lc(A.pool), value: String(amount), callType: 'call', isError: '0', timeStamp: String(T0 + (block - 26_000_000) * 12), blockNumber: String(block) });
    },
    withdraw(block, amount, to) {
      const t = tx(800 + internal.length);
      internal.push({ transactionHash: t, index: '1', from: lc(A.pool), to, value: String(amount), callType: 'call', isError: '0', timeStamp: String(T0 + (block - 26_000_000) * 12), blockNumber: String(block) });
      internal.push({ transactionHash: t, index: '2', from: lc(A.pool), to: '0x141e653de94438258fdab245896c189f56522554', value: String(amount), callType: 'delegatecall', isError: '0', timeStamp: String(T0), blockNumber: String(block) });
      balances[lc(A.pool)] -= amount;
    },
    settle(block, leaves, spent) {
      const t = tx(700 + logs[1].length);
      if (leaves) {
        log(1, A.pool, [TOPIC.leaves, '0x' + w(state.leafCount)], w(0x40) + w(0x40 + 32 + 32 * leaves) + w(leaves) + Array.from({ length: leaves }, (_, i) => w(0xabc + i)).join('') + w(leaves) + Array.from({ length: leaves }, (_, i) => w(32 * leaves + 32 * i)).join('') + Array.from({ length: leaves }, () => w(0)).join(''), block, t);
        state.leafCount += leaves;
      }
      if (spent) log(1, A.pool, [TOPIC.spent], w(0x20) + w(spent) + Array.from({ length: spent }, (_, i) => w(0x91 + i)).join(''), block, t);
    },
    attest(block, ok = true) { txs.push({ hash: tx(600 + txs.length), from: '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', to: lc(A.pool), blockNumber: String(block), timeStamp: String(T0 + (block - 26_000_000) * 12), isError: ok ? '0' : '1', methodId: SEL.attest, value: '0' }); },
    bond(block, outpoint, amount, lock) { log(1, A.engine, [TOPIC.posted, outpoint, addr32('0x' + '5e'.repeat(20))], w(amount), block, tx(500 + block % 1000)); state.locks[outpoint] = { escrow: amount, ...lock }; },
    borrow(block, debt) { log(1, A.engine, [TOPIC.cdpMinted, tx(400 + block % 1000)], w(debt) + w(0), block, tx(401 + block % 1000)); state.outstanding += BigInt(debt); },
    repay(block, debt) { log(1, A.engine, [TOPIC.cdpClosed, tx(300 + block % 1000)], w(debt), block, tx(301 + block % 1000)); state.outstanding -= BigInt(debt); },
    // The TAC ERC-20: a mint is a Transfer from the zero address (the pool pays a withdrawal or a swap out); a move is not.
    tacWrap(block, amount) { log(1, A.pool, [TOPIC.wrap, tx(1200 + logs[1].length), ID.tac], w(amount), block, tx(1300 + logs[1].length)); },
    tacMint(block, to, amount) { log(1, A.tac, [TOPIC.transfer, ZERO32, addr32(to)], w(amount), block, tx(1000 + logs[1].length)); },
    tacMove(block, from, to, amount) { log(1, A.tac, [TOPIC.transfer, addr32(from), addr32(to)], w(amount), block, tx(1100 + logs[1].length)); },
    claim(block, account, amount) { log(1, A.airdrop, [TOPIC.claimed, '0x' + w(block), addr32(account)], w(amount), block, tx(200 + block % 1000)); },
    device(chain, block, ext, fee = 0n) {
      log(chain, A.evmPool, [TOPIC.transact, tx(1), tx(2)], [w(0), w(0), w(0), w(0), w(0), w(ext), w(0), w(fee), w(0x140), w(0x160), w(0), w(0)].join(''), block, tx(100 + logs[chain].length));
      balances[`${chain}:${lc(A.evmPool)}`] += BigInt(ext) - BigInt(fee);
    },
  };
  // The contracts' reads.
  const read = (to, data) => {
    const sel = data.slice(0, 10), arg = '0x' + data.slice(10);
    const L = state.locks[arg] || {};
    const m = {
      [`${lc(A.relay)}:${SEL.tipHeight}`]: state.tip, [`${lc(A.pool)}:${SEL.attestedTip}`]: '0x' + 'aa'.repeat(32), [`${lc(A.relay)}:${SEL.anchorTip}`]: '0x' + 'bb'.repeat(32),
      [`${lc(A.pool)}:${SEL.crossOuts}`]: state.crossOuts, [`${lc(A.pool)}:${SEL.consumed}`]: state.consumed, [`${lc(A.pool)}:${SEL.nextLeafIndex}`]: state.leafCount,
      [`${lc(A.tacbtc)}:${SEL.totalSupply}`]: 9n * 10n ** 13n, [`${lc(A.tacusd)}:${SEL.totalSupply}`]: 0, [`${lc(A.engine)}:${SEL.outstandingCusd}`]: state.outstanding,
      [`${lc(A.tac)}:${SEL.totalSupply}`]: state.supply, [`${lc(A.points)}:${SEL.totalAllocated}`]: 5555n * 10n ** 18n, [`${lc(A.points)}:${SEL.totalClaimed}`]: 313n * 10n ** 18n,
      [`${lc(A.relay)}:${SEL.blockHeight}`]: arg === '0x' + 'aa'.repeat(32) ? state.attested : state.anchor,
      [`${lc(A.pool)}:${SEL.lockVBtc}`]: L.vBtc || 0, [`${lc(A.pool)}:${SEL.minted}`]: L.minted ? 1 : 0, [`${lc(A.pool)}:${SEL.lockSpent}`]: L.spent ? 1 : 0,
      [`${lc(A.pool)}:${SEL.lockRedeemed}`]: L.redeemed ? 1 : 0, [`${lc(A.engine)}:${SEL.escrowTotal}`]: L.escrow || 0,
    };
    const v = m[`${lc(to)}:${sel}`];
    if (v === undefined) throw new Error(`no read ${to} ${sel}`);
    return typeof v === 'string' ? v : '0x' + w(v);
  };
  const chainOf = (url) => (/base/.test(url) ? 8453 : /robinhood/.test(url) ? 4663 : 1);
  const answer = (chain, { method, params }) => {
    if (method === 'eth_blockNumber') return h(heads[chain]);
    if (method === 'eth_getBalance') return h(balances[chain === 1 && lc(params[0]) === lc(A.pool) ? lc(A.pool) : `${chain}:${lc(params[0])}`] ?? 0n);
    if (method === 'eth_call') return read(params[0].to, params[0].data);
    if (method === 'eth_getTransactionByHash') return senders[params[0]] ? { hash: params[0], from: senders[params[0]] } : null;
    if (method === 'eth_getBlockByNumber') {
      const b = params[0] === 'latest' ? heads[chain] : Number(BigInt(params[0]));
      return { number: h(b), timestamp: h(T0 + (b - 26_000_000) * 12) };
    }
    if (method === 'eth_getLogs') {
      const q = params[0], from = Number(BigInt(q.fromBlock)), to = Number(BigInt(q.toBlock)), as = [].concat(q.address).map(lc);
      if (w_.failTac && as.includes(lc(A.tac))) return { error: 'node refuses the TAC token logs' };
      const topicsOk = (l) => !q.topics || q.topics.every((t, i) => t == null || lc(l.topics[i] || '') === lc(t));
      if (chain === 8453 && to - from + 1 > 2000) return { error: 'eth_getLogs is limited to a 2,000 range' };
      // Robinhood's node gives every log a block time of 0.
      return logs[chain].filter((l) => as.includes(lc(l.address)) && topicsOk(l) && Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to && Number(BigInt(l.blockNumber)) <= heads[chain])
        .map((l) => (w_.zeroTs?.includes(chain) ? { ...l, blockTimestamp: '0x0' } : l));
    }
    return null;
  };
  w_.fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const res = (status, obj) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });
    if (/blockscout|routescan/.test(u.host)) {
      calls.explorer.push(u.host + u.pathname + u.search);
      if (w_.explorerDown === true || (w_.explorerDown instanceof RegExp && w_.explorerDown.test(u.host))) return res(429, { message: 'Too Many Requests' });
      const q = u.searchParams, chain = /base\.|\/evm\/8453\//.test(u.host + u.pathname) ? 8453 : 1;
      let result = [];
      if (q.get('module') === 'logs') { const from = Number(q.get('fromBlock')); result = logs[chain].filter((l) => lc(l.address) === lc(q.get('address')) && Number(BigInt(l.blockNumber)) >= from).map((l) => ({ ...l, timeStamp: l.blockTimestamp })); }
      else { const from = Number(q.get('startblock')), list = q.get('action') === 'txlist' ? txs : internal; result = list.filter((t) => Number(t.blockNumber) >= from); }
      return res(200, { status: result.length ? '1' : '0', message: result.length ? 'OK' : 'No records found', result });
    }
    if (u.host === 'api.tacit.finance') {
      if (u.pathname === '/leaderboard') return res(200, [{ address: '0x1', points: 10 }, { address: '0x2', points: 20.5 }]);
      if (u.pathname === '/reflection/status') return res(200, { foldedCrossoutCount: 2 });
      return res(404, {});
    }
    if (/mempool|blockstream/.test(u.host)) return { ok: true, status: 200, text: async () => String(state.tip + 5) };
    calls.rpc.push(u.host);
    const chain = chainOf(url), body = JSON.parse(opts.body);
    if (Array.isArray(body)) return res(200, body.map((b) => { try { return { jsonrpc: '2.0', id: b.id, result: answer(chain, b) }; } catch (e) { return { jsonrpc: '2.0', id: b.id, error: { message: e.message } }; } }));
    try {
      const r = answer(chain, body);
      return r && r.error ? res(200, { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: r.error } }) : res(200, { jsonrpc: '2.0', id: body.id, result: r });
    } catch (e) { return res(200, { jsonrpc: '2.0', id: body.id, error: { message: e.message } }); }
  };
  return w_;
}

function populate(x, stage) {
  const at = (n) => 26_000_000 - 1_900 + n;   // every contract is deployed by 25,998,000
  if (stage === 1) {
    x.deposit(at(10), 10n ** 18n, '0x' + '1a'.repeat(20), false);
    x.deposit(at(500), 5n * 10n ** 17n, '0x' + '2b'.repeat(20), true);
    x.deposit(at(900), 3n * 10n ** 17n, '0x' + '1a'.repeat(20), false);
    x.withdraw(at(1200), 2n * 10n ** 17n, '0x' + '3c'.repeat(20));
    x.settle(at(1200), 2, 1); x.settle(at(1500), 1, 2); x.settle(at(1800), 0, 1);
    x.attest(at(1300)); x.attest(at(1600)); x.attest(at(1700), false);
    x.bond(at(100), '0x' + 'b1'.repeat(32), 10n ** 15n, { vBtc: 700, minted: true });
    x.bond(at(200), '0x' + 'b2'.repeat(32), 2n * 10n ** 15n, { vBtc: 2000, minted: true, spent: true });
    x.bond(at(300), '0x' + 'b3'.repeat(32), 3n * 10n ** 15n, {});
    x.borrow(at(400), 200_000_000); x.borrow(at(600), 150_000_000); x.repay(at(700), 100_000_000);
    x.claim(at(50), '0x' + '4d'.repeat(20), 10n * 10n ** 18n); x.claim(at(60), '0x' + '4d'.repeat(20), 20n * 10n ** 18n); x.claim(at(70), '0x' + '5e'.repeat(20), 30n * 10n ** 18n);
    // TAC leaving the pool: two accounts mint three times (one of them a swap payout, indistinguishable by its log), the settle wallet
    // is paid a fee mint, and an ordinary transfer is not a mint at all.
    x.tacMint(at(1300), '0x' + 'a1'.repeat(20), 40n * 10n ** 18n); x.tacMint(at(1310), '0x' + 'a1'.repeat(20), 10n * 10n ** 18n); x.tacMint(at(1320), '0x' + 'b2'.repeat(20), 25n * 10n ** 18n);
    x.tacMint(at(1330), '0x7a0f0511e1dcf399c2f7bbe8414b6a0d1abc4331', 2n * 10n ** 18n); x.tacMove(at(1340), '0x' + 'a1'.repeat(20), '0x' + 'c3'.repeat(20), 5n * 10n ** 18n); x.tacWrap(at(1345), 100n * 10n ** 18n);
    // The founding bridge of the treasury: minted to the ops multisig and to the airdrop contract. Not something an account did.
    x.tacMint(at(1350), '0x006cd14f36f65ecbb29b2519ccbe63a0dc8549f2', 1_000_000n * 10n ** 18n); x.tacMint(at(1360), A.airdrop, 500_000n * 10n ** 18n);
    x.device(1, at(1000), 3n * 10n ** 17n); x.device(1, at(1100), -(10n ** 17n), 10n ** 16n);
    x.device(8453, 51_900_000 - 30_000, 5n * 10n ** 17n); x.device(4663, 74_000_000 - 5_000, 2n * 10n ** 17n);
  }
  if (stage === 2) {
    // Later: more of everything, some of it in the blocks right behind the old head.
    for (const c of Object.keys(x.heads)) x.heads[c] += 400;
    x.deposit(26_000_000 - 30, 7n * 10n ** 17n, '0x' + '6f'.repeat(20), true);
    x.deposit(26_000_000 + 350, 10n ** 17n, '0x' + '1a'.repeat(20), false);
    x.withdraw(26_000_000 + 360, 10n ** 17n, '0x' + '3c'.repeat(20));
    x.settle(26_000_000 + 360, 1, 1); x.attest(26_000_000 + 380);
    x.borrow(26_000_000 + 100, 50_000_000);
    x.tacMint(26_000_000 + 370, '0x' + 'd4'.repeat(20), 8n * 10n ** 18n);
    x.device(8453, 51_900_000 + 200, 10n ** 17n, 10n ** 15n);
  }
}
const figures = (r) => fromJson(toJson({ ...r, at: 0, block: 0 }));

test('stats reading: every figure, counted as the stats page shows it', async () => {
  const x = world();
  populate(x, 1);
  const { reading: r, keep } = await makeStatsReader({ fetchImpl: x.fetchImpl, gapMs: 0 }).read({});
  assert.deepEqual(r.errors, {});
  assert.equal(r.eth.inWei, 18n * 10n ** 17n, 'shielded: the ETH wraps');
  assert.equal(r.eth.deposits, 3);
  assert.equal(r.eth.outWei, 2n * 10n ** 17n, 'withdrawn: calls out of the pool, not the delegatecall frame');
  assert.equal(r.eth.held, 16n * 10n ** 17n);
  assert.equal(r.eth.wallets, 2, 'wallets: distinct senders');
  assert.equal(r.btc.locked, 700n, 'BTC locked leaves out the spent lock');
  assert.equal(r.btc.nLocked, 1); assert.equal(r.btc.unlocked, 1); assert.equal(r.btc.mint, 2700n); assert.equal(r.btc.nMint, 2);
  assert.equal(r.btc.nBonds, 3, 'bonds on the locks holding one'); assert.equal(r.btc.waiting, 1, 'a bond on a lock not yet proven');
  assert.equal(r.btc.borrowed, 350_000_000n); assert.equal(r.btc.repaid, 100_000_000n); assert.equal(r.btc.out, 250_000_000n); assert.equal(r.btc.open, 1);
  assert.equal(r.tac.claimed, 60n * 10n ** 18n); assert.equal(r.tac.claimers, 2);
  assert.deepEqual(r.tac.tacOut, { n: 3, v: 75n * 10n ** 18n, who: 2 }, 'TAC made public: the mints to accounts, not the settle wallet\'s fee mint, not the treasury minted to the multisig and the airdrop contract, and not an ordinary transfer');
  assert.equal(r.pts.participants, 2); assert.equal(r.pts.points, 30.5); assert.equal(r.pts.full, false);
  assert.equal(r.link.settles, 3); assert.equal(r.link.notes, 3); assert.equal(r.link.spent, 4); assert.equal(r.link.attests, 2, 'only attestations that went through');
  assert.equal(r.link.tip - r.link.anchorHeight, 969_000 - 964_163);
  const dev = Object.fromEntries(r.dev.map((d) => [d.chain, d]));
  assert.equal(dev[1].dep, 3n * 10n ** 17n); assert.equal(dev[1].wd, 11n * 10n ** 16n, 'out includes the relayer fee');
  assert.equal(dev[1].bal, dev[1].dep - dev[1].wd, 'so in less out is what the pool holds');
  assert.equal(dev[8453].dep, 5n * 10n ** 17n, 'Base read in spite of its 2,000-block RPC cap');
  assert.equal(dev[4663].dep, 2n * 10n ** 17n);
  assert.ok(x.calls.explorer.every((q) => /txlist|base\.blockscout/.test(q)), `the explorer is asked only for transaction lists, and for Base's first read (${x.calls.explorer.join(' | ')})`);
  assert.equal(x.calls.explorer.length, 3);
  assert.ok(keep.logs['1'].to === x.heads[1] - 75 && keep.logs['1'].items.every((l) => l.b <= keep.logs['1'].to), 'only what is final is kept');
});

test('stats reading: a later reading from what an earlier one kept agrees with one from nothing, and asks only for what is new', async () => {
  const x = world();
  populate(x, 1);
  const first = await makeStatsReader({ fetchImpl: x.fetchImpl, gapMs: 0 }).read({});
  const kept = fromJson(toJson(first.keep));
  populate(x, 2);
  x.calls.explorer.length = 0; x.calls.rpc.length = 0;
  const warm = await makeStatsReader({ fetchImpl: x.fetchImpl, gapMs: 0 }).read(kept);
  const warmExplorer = [...x.calls.explorer];
  const cold = await makeStatsReader({ fetchImpl: x.fetchImpl, gapMs: 0 }).read({});
  assert.deepEqual(warm.reading.errors, {});
  assert.deepEqual(figures(warm.reading), figures(cold.reading), 'the same figures either way');
  assert.equal(warm.reading.eth.deposits, 5, 'including a deposit in the blocks just behind the old head');
  assert.equal(warm.reading.btc.out, 300_000_000n);
  assert.equal(warmExplorer.length, 2, `two explorer requests: the transaction lists (${warmExplorer.join(' | ')})`);
  assert.ok(warmExplorer.every((q) => Number(new URLSearchParams(q.split('?')[1]).get('startblock')) > 0), 'each from where the kept list ends');
});

test('stats reading: the explorers are taken in turn, and one that is busy hands its requests to the other', async () => {
  const x = world();
  populate(x, 1);
  x.explorerDown = /blockscout/;
  const { reading: r } = await makeStatsReader({ fetchImpl: x.fetchImpl, gapMs: 0 }).read({});
  assert.deepEqual(r.errors, {}, 'every part read');
  assert.equal(r.link.attests, 2);
  assert.equal(r.eth.outWei, 2n * 10n ** 17n);
  const eth = x.calls.explorer.filter((q) => !/base|8453/.test(q));
  assert.equal(eth.filter((q) => /blockscout/.test(q)).length, 1, `a busy explorer is asked once, then set aside (${eth.join(' | ')})`);
  assert.equal(eth.filter((q) => /routescan/.test(q)).length, 2, 'the other answers both lists');
});

test('stats reading: with the explorers down, what the chains alone answer is still read', async () => {
  const x = world();
  populate(x, 1);
  x.explorerDown = true;
  const { reading: r } = await makeStatsReader({ fetchImpl: x.fetchImpl, gapMs: 0 }).read({});
  assert.ok(r.errors.eth && r.errors.link, 'the parts that need a transaction list say so');
  assert.equal(r.eth, null);
  for (const part of ['btc', 'tac', 'pts']) assert.ok(r[part], `${part} is read from the chain`);
  assert.equal(r.btc.out, 250_000_000n);
  const dev = Object.fromEntries(r.dev.map((d) => [d.chain, d]));
  assert.equal(dev[1].dep, 3n * 10n ** 17n, 'device pools on chains whose RPCs serve the range are read');
  assert.equal(dev[8453].dep, null, 'and one that needs the explorer shows as unread');
  // Carried over from an earlier reading, and marked as such.
  const merged = mergeReadings({ eth: { inWei: 1n }, link: { tip: 1 } }, r);
  assert.deepEqual(merged.stale.sort(), ['eth', 'link']);
  assert.equal(merged.eth.inWei, 1n);
});

test('stats reading: parts the newer reading already carries over stay marked when it is merged over a local one', () => {
  // The API's shared reading: its own `btc` is carried over from an earlier read of its own.
  const snap = { at: 3000, errors: {}, eth: { inWei: 5n }, btc: { out: 7n }, stale: ['btc'], staleAt: 1000 };
  const local = { at: 2000, errors: {}, eth: { inWei: 4n }, btc: { out: 6n } };
  const m = mergeReadings(local, snap);
  assert.deepEqual(m.stale, ['btc'], 'the API\'s carried-over part is still named');
  assert.equal(m.staleAt, 1000, 'and still dated');
  assert.equal(m.btc.out, 7n);
  // A part the snapshot lacks is carried over from the local reading too; the oldest date wins.
  const m2 = mergeReadings({ ...local, at: 500, link: { tip: 9 } }, snap);
  assert.deepEqual(m2.stale.sort(), ['btc', 'link']);
  assert.equal(m2.staleAt, 500);
  // A clean snapshot carries no marks.
  const clean = mergeReadings(local, { at: 3000, errors: {}, eth: { inWei: 5n }, btc: { out: 7n } });
  assert.deepEqual(clean.stale, []);
  assert.equal(clean.staleAt, null);
});

test('stats reading: private ETH is the V1 pool and the device pools on every chain together', async () => {
  const x = world();
  populate(x, 1);
  const { reading: r } = await makeStatsReader({ fetchImpl: x.fetchImpl, gapMs: 0 }).read({});
  const t = privateEth(r.eth, r.dev);
  assert.equal(t.inWei, (18n + 3n + 5n + 2n) * 10n ** 17n, 'shielded: V1 wraps plus each device pool\'s deposits');
  assert.equal(t.held, 16n * 10n ** 17n + 19n * 10n ** 16n + 5n * 10n ** 17n + 2n * 10n ** 17n, 'held: V1\'s balance plus each device pool\'s');
  assert.equal(t.outWei, 2n * 10n ** 17n + 11n * 10n ** 16n, 'withdrawn: V1\'s, and the device pool\'s withdrawal with its relayer fee');
  assert.equal(t.deposits, 6);
  assert.deepEqual(t.pools.map((p) => p.id), ['v1', 1, 8453, 4663]);
  assert.deepEqual(t.unread, { held: [], flow: [] });
  assert.equal(t.series.ins.length, 6); assert.equal(t.series.flows.length, 8);
  assert.equal(t.series.flows.reduce((s, [, v]) => s + v, 0n), t.held, 'every move in time adds up to what is held');
  assert.equal(t.series.ins.reduce((s, [, v]) => s + v, 0n), t.inWei);
  assert.ok(t.series.flows.every(([ts]) => ts > T0 - 1e5), 'every move is dated, none in 1970');
  assert.equal(t.lastAt, Math.max(...t.series.ins.map(([ts]) => ts)));
  // A device pool whose logs couldn't be read is left out of what was moved, named, and its balance still counts.
  const part = privateEth(r.eth, r.dev.map((d) => (d.chain === 8453 ? { ...d, dep: null, wd: null, series: { ins: [], flows: [] } } : d)));
  assert.deepEqual(part.unread, { held: [], flow: [8453] });
  assert.equal(part.inWei, t.inWei - 5n * 10n ** 17n); assert.equal(part.held, t.held);
  // Without the V1 reading only the device pools are summed; with an older reading that had no series, nothing breaks.
  assert.deepEqual(privateEth(null, r.dev).pools.map((p) => p.id), [1, 8453, 4663]);
  assert.equal(privateEth(r.eth, r.dev.map(({ series, ...d }) => d)).series.ins.length, 3);
});

test('stats reading: a deposit the explorer lists leave out is in what is held over time, once, from its Wrap log', async () => {
  const sum = (r) => r.eth.series.flows.reduce((s, [, v]) => s + v, 0n);
  const whole = world(); populate(whole, 1);
  const full = (await makeStatsReader({ fetchImpl: whole.fetchImpl, gapMs: 0 }).read({})).reading;
  assert.equal(sum(full), full.eth.held, 'with complete lists the moves add up to the balance');
  // One direct deposit and one forwarded deposit are missing from the lists (the nodes still have both logs).
  const gap = world(); populate(gap, 1);
  gap.txs.splice(gap.txs.findIndex((t) => BigInt(t.value) === 5n * 10n ** 17n), 1);
  gap.internal.splice(gap.internal.findIndex((t) => BigInt(t.value) === 10n ** 18n && t.to === lc(A.pool)), 1);
  const { reading: r, keep } = await makeStatsReader({ fetchImpl: gap.fetchImpl, gapMs: 0 }).read({});
  assert.equal(sum(r), r.eth.held, 'the deposits the lists missed are added, and the moves still add up to the balance');
  assert.equal(r.eth.series.flows.length, full.eth.series.flows.length, 'each is there once');
  assert.equal(r.eth.inWei, full.eth.inWei);
  // A later reading from what this one kept gives the same history.
  populate(gap, 2);
  const next = (await makeStatsReader({ fetchImpl: gap.fetchImpl, gapMs: 0 }).read(keep)).reading;
  assert.equal(sum(next), next.eth.held);
});

test('stats reading: a node that dates every log 0 gets its logs dated from their blocks', async () => {
  const x = world(); populate(x, 1);
  const normal = await makeStatsReader({ fetchImpl: x.fetchImpl, gapMs: 0 }).read({});
  const z = world(); populate(z, 1); z.zeroTs = [4663];
  const { reading: r, keep } = await makeStatsReader({ fetchImpl: z.fetchImpl, gapMs: 0 }).read({});
  const rh = r.dev.find((d) => d.chain === 4663);
  assert.deepEqual(rh.series.ins, [[T0 + (74_000_000 - 5_000 - 26_000_000) * 12, 2n * 10n ** 17n]], 'dated by its block, not 1970');
  assert.deepEqual(figures(r), figures(normal.reading), 'the same figures as from a node that gives the time');
  assert.ok(keep.logs['4663'].items.every((l) => l.ts > T0), 'and kept dated');
  // A kept log that was undated (an earlier reading kept it as 0) is dated on the next reading.
  const stale = fromJson(toJson(keep));
  stale.logs['4663'].items.forEach((l) => { l.ts = 0; });
  const again = await makeStatsReader({ fetchImpl: z.fetchImpl, gapMs: 0 }).read(stale);
  assert.deepEqual(again.reading.dev.find((d) => d.chain === 4663).series, rh.series);
});

test('stats reading: a node that names its own block limit is asked for that many blocks at a time', async () => {
  for (const [cap, message, data] of [
    [10_000, 'query spans 30000 blocks (1 to 30000), but only 10000 are allowed for this request; narrow the block range'],   // Robinhood's node
    [1_000, 'invalid params', 'Block range too large for public access: maximum 1000 blocks. Try with this block range [0x1, 0x3e8]'],   // Tenderly's public gateway: the why is in `data`
  ]) {
    let asked = 0;
    const fetchImpl = async (url, opts) => {
      asked++;
      const q = JSON.parse(opts.body).params[0], from = Number(BigInt(q.fromBlock)), to = Number(BigInt(q.toBlock));
      const body = to - from + 1 > cap ? { jsonrpc: '2.0', id: 1, error: { code: -32602, message, ...(data ? { data } : {}) } } : { jsonrpc: '2.0', id: 1, result: [{ blockNumber: q.fromBlock }] };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
    const logs = await makeStatsReader({ fetchImpl, gapMs: 0 }).getLogs(4663, A.evmPool, 1, 3 * cap);
    assert.strictEqual(logs.length, 3, `the whole range, ${cap} blocks at a time`);
    assert.strictEqual(asked, 4, `one refusal, then ${cap} blocks a request`);
  }
});

test('stats reading: a log history too long for one reading is read on across readings, and comes out the same', async () => {
  const x = world();
  populate(x, 1);
  x.explorerDown = /base\.blockscout|routescan/;            // no explorer for Base's logs, as now; Ethereum's lists still answer
  const one = async (keep, logBudget) => makeStatsReader({ fetchImpl: x.fetchImpl, gapMs: 0, logBudget }).read(keep);
  const base = (r) => r.dev?.find((d) => d.chain === 8453 && d.dep != null);
  // Base's pool runs about 36,000 blocks from its first, at 2,000 a request: more than a reading of five requests reads.
  let keep = {}, r, n = 0;
  const reached = [];
  do { ({ reading: r, keep } = await one(keep, 5)); reached.push(keep.logs?.['8453']?.to ?? null); n++; } while (!base(r) && n < 12);
  assert.ok(base(r), `read in the end (${n} readings)`);
  assert.ok(n > 2, `across ${n} readings`);
  assert.ok(reached.every((t, i) => t != null && (i === 0 || t > reached[i - 1])), `each reading read on from the last (${reached.join(', ')})`);
  const whole = (await one({}, 100)).reading;
  assert.deepStrictEqual(figures(base(r)), figures(base(whole)), 'the same figures as one reading that could read it all');
});

test('stats reading: a node that refuses a long read without naming a span is left out for the rest of it', async () => {
  const asked = {};
  const fetchImpl = async (url, opts) => {
    const host = new URL(url).host; asked[host] = (asked[host] || 0) + 1;
    const q = JSON.parse(opts.body).params[0], n = Number(BigInt(q.toBlock)) - Number(BigInt(q.fromBlock)) + 1;
    const error = /publicnode/.test(host) ? 'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode'
      : /mainnet\.base\.org/.test(host) && n > 500 ? 'eth_getLogs is limited to a 500 range'
      : /base\.drpc/.test(host) && n > 1000 ? 'Block range too large for public access: maximum 1000 blocks' : null;
    const body = !error ? { jsonrpc: '2.0', id: 1, result: [] }
      : /base\.drpc/.test(host) ? { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid params', data: error } }
      : { jsonrpc: '2.0', id: 1, error: { code: -32602, message: error } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  await makeStatsReader({ fetchImpl, gapMs: 0 }).getLogs(8453, A.evmPool, 1, 10_000, 40);
  assert.strictEqual(asked['base-rpc.publicnode.com'], 1, 'publicnode asked once');
  assert.strictEqual(asked['base.drpc.org'], 11, 'then the widest node that answers: one refusal and ten thousand-block pieces');
});

test('stats reading: TAC made public is read with a mint filter, so the token\'s ordinary transfers are never pulled or kept', async () => {
  const x = world();
  populate(x, 1);
  const asked = [];
  const inner = x.fetchImpl;
  x.fetchImpl = async (url, opts = {}) => {
    try { const b = JSON.parse(opts.body || 'null'); if (b && b.method === 'eth_getLogs' && [].concat(b.params[0].address).map(lc).includes(lc(A.tac))) asked.push(b.params[0]); } catch { /* not JSON */ }
    return inner(url, opts);
  };
  const { reading: r, keep } = await makeStatsReader({ fetchImpl: x.fetchImpl, gapMs: 0 }).read({});
  assert.ok(asked.length > 0 && asked.every((q) => Array.isArray(q.topics) && lc(q.topics[0]) === TOPIC.transfer && lc(q.topics[1]) === ZERO32), 'every request for the token\'s logs names the Transfer topic and the zero address as sender');
  const kept = keep.logs.tacmint.items;
  assert.equal(kept.length, 6, 'every mint is kept (the three user mints, the fee mint and the two treasury mints); the count is taken from them');
  assert.ok(kept.every((l) => l.t[0] === TOPIC.transfer && l.t[1] === ZERO32), 'and the ordinary transfer is not among them');
  assert.equal(r.tac.tacOut.n, 3);
});

test('stats reading: when the TAC mint stream cannot be read, TAC made public is absent and every other TAC figure stands', async () => {
  const x = world();
  populate(x, 1);
  x.failTac = true; x.explorerDown = true;
  const { reading: r } = await makeStatsReader({ fetchImpl: x.fetchImpl, gapMs: 0 }).read({});
  assert.equal(r.tac.tacOut, null, 'absent, not zero');
  assert.ok(!('tac' in r.errors), 'the TAC part is still read: one stream failing does not fail it (the explorer being down is what fails the ETH and link parts here)');
  assert.equal(r.tac.claimed, 60n * 10n ** 18n, 'its other figures stand');
  assert.equal(r.tac.supply, 2_500_000n * 10n ** 18n);
});

test('stats reading: TAC carries the times it went each way and nothing else of the flows, the treasury and the fee mints left out', async () => {
  const x = world();
  populate(x, 1);
  const { reading: r } = await makeStatsReader({ fetchImpl: x.fetchImpl, gapMs: 0 }).read({});
  assert.equal(r.tac.times.out.length, 3, 'the three mints to accounts');
  assert.equal(r.tac.times.in.length, 1, 'the one TAC wrap');
  assert.ok([...r.tac.times.out, ...r.tac.times.in].every((v) => Number.isFinite(v) && v > 0), 'times only');
  assert.deepEqual(r.tac.times.out, [...r.tac.times.out].sort((a, b) => a - b), 'oldest first');
  assert.ok(!JSON.stringify(Object.keys(r.tac.times)).includes('0x'), 'no address among the keys');
});
