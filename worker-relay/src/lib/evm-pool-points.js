// Points for public ETH deposited into the native-ETH EVM pool (contracts/src/TacitEvmPool.sol), one scan per
// chain. A deposit is a pool Transact with extAmount > 0, worth extAmount wei.
//
// Who earns it:
//   - a direct pool call or a router zap: the transaction's signer;
//   - a deposit-box completion or a receive-box sweep (router DepositBoxCompleted / Received in the same tx):
//     never the completer or sweeper. The box's
//     funders are found from its explorer history and each is credited for the share of its funding the
//     completion consumed (FIFO over the box's inflows and outflows). Funding that is itself a hop out of V1 or
//     this pool, a cross-chain system deposit, or from an excluded sender earns nothing.
// Box completions wait in a pending table until the explorer has indexed the completion, so an explorer outage
// holds back only those rows, never the chain's cursor or any other activity.

export const EVM_POOL_ACTIVITY = 'evmpooldeposit';

export const TRANSACT_EVENT = {
  type: 'event',
  name: 'Transact',
  inputs: [
    { name: 'nf0', type: 'bytes32', indexed: true },
    { name: 'nf1', type: 'bytes32', indexed: true },
    { name: 'outLeaf0', type: 'bytes32', indexed: false },
    { name: 'outLeaf1', type: 'bytes32', indexed: false },
    { name: 'firstIndex', type: 'uint256', indexed: false },
    { name: 'newRoot', type: 'bytes32', indexed: false },
    { name: 'recipient', type: 'address', indexed: false },
    { name: 'extAmount', type: 'int256', indexed: false },
    { name: 'relayer', type: 'address', indexed: false },
    { name: 'fee', type: 'uint256', indexed: false },
    { name: 'memo0', type: 'bytes', indexed: false },
    { name: 'memo1', type: 'bytes', indexed: false },
  ],
};

export const DEPOSIT_BOX_COMPLETED_EVENT = {
  type: 'event',
  name: 'DepositBoxCompleted',
  inputs: [
    { name: 'box', type: 'address', indexed: true },
    { name: 'completer', type: 'address', indexed: true },
  ],
};

export const RECEIVED_EVENT = {
  type: 'event',
  name: 'Received',
  inputs: [
    { name: 'box', type: 'address', indexed: true },
    { name: 'n', type: 'uint256', indexed: true },
    { name: 'index', type: 'uint256', indexed: false },
    { name: 'value', type: 'uint256', indexed: false },
    { name: 'rho', type: 'uint256', indexed: false },
    { name: 'fee', type: 'uint256', indexed: false },
  ],
};

export const WRAP_BOX_COMPLETED_EVENT = {
  type: 'event',
  name: 'WrapBoxCompleted',
  inputs: [
    { name: 'box', type: 'address', indexed: true },
    { name: 'completer', type: 'address', indexed: true },
  ],
};

// L2 system deposit transactions (OP-stack 0x7e, Arbitrum 0x64-0x6a). Their sender is a bridge alias or the
// L1 sender, so the value is a cross-chain arrival that cannot be attributed from this chain alone.
export const SYSTEM_TX_TYPES = new Set(['0x7e', '0x64', '0x65', '0x66', '0x68', '0x69', '0x6a']);

const lc = (a) => (a ? String(a).toLowerCase() : '');
const cmpBig = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A V1 Wrap sent through the EVM pool router (withdrawToV1 / completeWrap) moves value that was already
// private or already in a box, so it is never a new public entry. Matching on WrapBoxCompleted as well as
// tx.to also covers a router call made from inside a batched or delegated account.
export function isV1WrapViaEvmRouter(tx, txHash, wrapBoxTxs, router) {
  if (router && lc(tx?.to) === lc(router)) return true;
  return wrapBoxTxs.has(txHash);
}

// Who earns a funding (or a direct deposit), or null. `hops` are tx destinations or immediate senders whose
// value was already inside Tacit.
export function creditFor(tx, { hops, excluded, immediateFrom = null }) {
  const type = lc(tx.typeHex ?? tx.type);
  if (SYSTEM_TX_TYPES.has(type)) return null;
  if (tx.to && hops.has(lc(tx.to))) return null;
  if (immediateFrom && hops.has(lc(immediateFrom))) return null;
  const from = lc(tx.from);
  if (!from || excluded.has(from)) return null;
  return from;
}

export function openEvmPoolPointsState(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evm_pool_cursor (
      chain_id           INTEGER PRIMARY KEY,
      last_scanned_block INTEGER NOT NULL
    );
    -- Box completions whose funders are not resolved yet. ordinal = how many earlier completions of the same
    -- box the same tx holds; row_key = the deposits.tx_hash key base for this deposit's rows.
    CREATE TABLE IF NOT EXISTS evm_pool_pending (
      chain_id     INTEGER NOT NULL,
      tx_hash      TEXT NOT NULL,
      log_index    INTEGER NOT NULL,
      box          TEXT NOT NULL,
      completer    TEXT NOT NULL,
      ordinal      INTEGER NOT NULL,
      row_key      TEXT NOT NULL,
      amount_wei   TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      block_time   INTEGER NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chain_id, tx_hash, log_index)
    );
  `);
  const loadCursorStmt = db.prepare('SELECT last_scanned_block FROM evm_pool_cursor WHERE chain_id = ?');
  const saveCursorStmt = db.prepare(`
    INSERT INTO evm_pool_cursor (chain_id, last_scanned_block) VALUES (@chainId, @block)
    ON CONFLICT(chain_id) DO UPDATE SET last_scanned_block = excluded.last_scanned_block
  `);
  const addPendingStmt = db.prepare(`
    INSERT OR IGNORE INTO evm_pool_pending
      (chain_id, tx_hash, log_index, box, completer, ordinal, row_key, amount_wei, block_number, block_time)
    VALUES (@chainId, @txHash, @logIndex, @box, @completer, @ordinal, @rowKey, @amountWei, @blockNumber, @blockTime)
  `);
  const listPendingStmt = db.prepare(`
    SELECT * FROM evm_pool_pending WHERE chain_id = ? ORDER BY attempts, block_number, log_index LIMIT ?
  `);
  const countPendingStmt = db.prepare('SELECT COUNT(*) AS n FROM evm_pool_pending WHERE chain_id = ?');
  const bumpAttemptStmt = db.prepare('UPDATE evm_pool_pending SET attempts = attempts + 1 WHERE chain_id = ? AND tx_hash = ? AND log_index = ?');
  const deletePendingStmt = db.prepare('DELETE FROM evm_pool_pending WHERE chain_id = ? AND tx_hash = ? AND log_index = ?');
  return {
    loadCursor(chainId) {
      const row = loadCursorStmt.get(chainId);
      return row ? BigInt(row.last_scanned_block) : null;
    },
    saveCursor(chainId, block) { saveCursorStmt.run({ chainId, block: block.toString() }); },
    addPending(p) { addPendingStmt.run(p); },
    listPending(chainId, limit) { return listPendingStmt.all(chainId, limit); },
    countPending(chainId) { return countPendingStmt.get(chainId).n; },
    bumpAttempt(p) { bumpAttemptStmt.run(p.chain_id, p.tx_hash, p.log_index); },
    deletePending(p) { deletePendingStmt.run(p.chain_id, p.tx_hash, p.log_index); },
  };
}

export async function explorerGet(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; tacit-points)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`explorer ${res.status} ${url}`);
  return res.json();
}

async function paged(get, url, maxPages) {
  const items = [];
  let params = '';
  for (let page = 0; page < maxPages; page++) {
    const data = await get(`${url}${params}`);
    items.push(...(data.items || []));
    if (!data.next_page_params) return items;
    params = '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)])),
    ).toString();
  }
  throw new Error(`explorer history longer than ${maxPages} pages: ${url}`);
}

// Every successful value movement into or out of `box`: top-level transfers to it (index -1) and internal
// ones in either direction. Internal index 0 is the top-level call itself and comes from the first list.
export async function fetchBoxHistory(get, apiBase, box, maxPages = 20) {
  const b = lc(box);
  const [txs, internals] = await Promise.all([
    paged(get, `${apiBase}/addresses/${box}/transactions`, maxPages),
    paged(get, `${apiBase}/addresses/${box}/internal-transactions`, maxPages),
  ]);
  const out = [];
  for (const t of txs) {
    if (lc(t.to?.hash) !== b || BigInt(t.value || 0) === 0n) continue;
    if (t.status !== 'ok' && t.result !== 'success') continue;
    out.push({
      txHash: t.hash, block: BigInt(t.block_number), txIndex: Number(t.position ?? 0), index: -1,
      from: lc(t.from?.hash), to: b, value: BigInt(t.value),
    });
  }
  for (const it of internals) {
    if (Number(it.index) === 0 || it.success === false || it.error) continue;
    const value = BigInt(it.value || 0);
    if (value === 0n) continue;
    const from = lc(it.from?.hash);
    const to = lc(it.to?.hash);
    if (from !== b && to !== b) continue;
    out.push({
      txHash: it.transaction_hash, block: BigInt(it.block_number), txIndex: Number(it.transaction_index ?? 0),
      index: Number(it.index), from, to, value,
    });
  }
  return out;
}

// Replays the box's balance FIFO. Each outflow records which inflows it consumed; an outflow larger than what
// the history shows coming in leaves a shortfall that nobody is credited for.
export function allocateBoxFunding(history, box) {
  const b = lc(box);
  const events = [...history].sort((x, y) => cmpBig(x.block, y.block) || x.txIndex - y.txIndex || x.index - y.index);
  const queue = [];
  const outflows = [];
  for (const ev of events) {
    if (ev.to === b && ev.from !== b) {
      queue.push({ txHash: ev.txHash, index: ev.index, from: ev.from, remaining: ev.value });
    } else if (ev.from === b && ev.to !== b) {
      let need = ev.value;
      const consumed = [];
      while (need > 0n && queue.length) {
        const head = queue[0];
        const take = head.remaining < need ? head.remaining : need;
        consumed.push({ txHash: head.txHash, index: head.index, from: head.from, amount: take });
        head.remaining -= take;
        need -= take;
        if (head.remaining === 0n) queue.shift();
      }
      outflows.push({ txHash: ev.txHash, index: ev.index, to: ev.to, value: ev.value, consumed, shortfall: need });
    }
  }
  return outflows;
}

function rowKey(base, n) {
  return n === 0 ? base : `${base}:${n}`;
}

// ctx: { store, state, chainId, client, apiBase, startBlock, pool, router, v1Pool, v1Router, excluded (Set),
//        confirmations, chunk, maxChunks, resolvePerCycle, capTip?(tip), explorerGet, pointsFor(amountWei, prior),
//        evalBlock(chainId, blockNumber, blockTime), covered(evalBlock), multipliers(address, evalBlock) →
//        { tacB, zShareB, ppB }, log }
function hopsFor(ctx) {
  return {
    direct: new Set([lc(ctx.v1Pool), lc(ctx.v1Router)].filter(Boolean)),
    funding: new Set([lc(ctx.v1Pool), lc(ctx.v1Router), lc(ctx.pool), lc(ctx.router)].filter(Boolean)),
  };
}

async function credit(ctx, { key, blockNumber, blockTime, depositor, amountWei }) {
  const evalBlock = await ctx.evalBlock(ctx.chainId, blockNumber, blockTime);
  const { tacB, zShareB, ppB = 1 } = ctx.multipliers(depositor, evalBlock);
  const prior = ctx.store.countByActivity(EVM_POOL_ACTIVITY);
  return ctx.store.recordDeposit({
    txHash: key, blockNumber: Number(blockNumber), blockTime: Number(blockTime),
    depositor, amountWei: amountWei.toString(), priorDepositCount: prior,
    points: ctx.pointsFor(amountWei, prior) * ppB * tacB * zShareB, activity: EVM_POOL_ACTIVITY,
    ppBoosted: ppB > 1 ? 1 : 0, tacBoost: tacB, zShareBoost: zShareB, chainId: ctx.chainId,
  });
}

// The narrowest getLogs span the scan will fall back to before it gives up on a failing call, and how many calls must
// succeed at a reduced span before it is widened again: a cap met once must not pin a chain at the floor for ever.
const MIN_LOG_SPAN = 50n, SPAN_REGROW_AFTER = 20;
const textOf = (err) => [err?.shortMessage, err?.message, err?.details, err?.data, err?.cause?.message, err?.cause?.details,
  err?.code, err?.cause?.code, err?.status].filter((x) => x != null).join(' ');
// What a node refused for. 'span': this query covers too many blocks, so a narrower one would be answered. 'rate': this
// caller is asking too often, and a narrower query only asks more often — the cure for the one is the poison for the other,
// and reading a throttle as a cap is what drives a scan to the floor and keeps it there. 'other': anything else (an archive
// depth it will not serve, a missing key, a network failure), where the span is not the problem either.
export function rpcRefusal(err) {
  const t = textOf(err);
  if (/\brate.?limit|request limit|limit reached|too many requests|throttl|quota|\b429\b|-32005|-32011|-32016|-32029/i.test(t)) return 'rate';
  if (/block range|range (?:over|of)|ranges over|limited to a? ?\d* ?(?:block )?range|up to a \d+ block|too (?:large|many blocks)|exceeds? .*blocks?|-32614/i.test(t)) return 'span';
  return 'other';
}
// Kept for callers that only ask whether a refusal was a throttle.
export const rateLimited = (err) => rpcRefusal(err) === 'rate';

export async function scanEvmPoolChain(ctx) {
  const { state, chainId, client } = ctx;
  if (ctx.startBlock == null || ctx.startBlock === '') return;
  const code = await client.getCode({ address: ctx.pool });
  if (!code || code === '0x') return;

  let tip = (await client.getBlockNumber()) - BigInt(ctx.confirmations);
  if (ctx.capTip) tip = ctx.capTip(tip);
  let cursor = state.loadCursor(chainId) ?? BigInt(ctx.startBlock) - 1n;
  const hops = hopsFor(ctx);
  const blockTimes = new Map();
  const blockTime = async (n) => {
    if (!blockTimes.has(n)) blockTimes.set(n, BigInt((await client.getBlock({ blockNumber: n })).timestamp));
    return blockTimes.get(n);
  };

  // The block span of one getLogs call. A node can cap it below the configured chunk (a public RPC that limits a query to a few
  // hundred blocks answers a wider one with a bare error), so a failing call is retried at half the span, down to a floor, and the
  // span that worked is kept for the next cycle: the cursor then moves in smaller steps instead of never moving at all.
  let span = BigInt(ctx.spans?.get(chainId) ?? ctx.chunk);
  for (let chunks = 0; cursor < tip && chunks < ctx.maxChunks; chunks++) {
    const from = cursor + 1n;
    const to = from + span - 1n < tip ? from + span - 1n : tip;
    let txLogs, completedLogs, receivedLogs;
    try {
      [txLogs, completedLogs, receivedLogs] = await Promise.all([
        client.getLogs({ address: ctx.pool, event: TRANSACT_EVENT, fromBlock: from, toBlock: to }),
        client.getLogs({ address: ctx.router, event: DEPOSIT_BOX_COMPLETED_EVENT, fromBlock: from, toBlock: to }),
        client.getLogs({ address: ctx.router, event: RECEIVED_EVENT, fromBlock: from, toBlock: to }),
      ]);
    } catch (err) {
      const why = rpcRefusal(err);
      // Only a span cap is answered by asking for less. A throttle or anything else keeps the span and the cursor, and the
      // next cycle resumes from here; shrinking for those would multiply the calls that are already being refused.
      if (why !== 'span') {
        (ctx.log || (() => {}))(`EVM pool getLogs on chain ${chainId} at block ${from}: ${why === 'rate' ? 'rate limited' : 'refused'} (${(err && (err.shortMessage || err.message)) || err}); resuming next cycle`);
        return;
      }
      if (to - from + 1n <= MIN_LOG_SPAN) throw err;
      span = (to - from + 1n) / 2n < MIN_LOG_SPAN ? MIN_LOG_SPAN : (to - from + 1n) / 2n;
      ctx.spans?.set(chainId, Number(span));
      ctx.wins?.set(chainId, 0);
      (ctx.log || (() => {}))(`EVM pool getLogs failed on chain ${chainId} over ${to - from + 1n} blocks (${(err && (err.shortMessage || err.message)) || err}); trying ${span} per call`);
      chunks--;
      continue;
    }
    // A span narrowed for a cap that has since been lifted (or that another endpoint never had) is widened again, so one
    // refusal does not leave a chain crawling for ever.
    if (span < BigInt(ctx.chunk)) {
      const wins = (ctx.wins?.get(chainId) ?? 0) + 1;
      ctx.wins?.set(chainId, wins);
      if (wins >= SPAN_REGROW_AFTER) {
        span = span * 2n > BigInt(ctx.chunk) ? BigInt(ctx.chunk) : span * 2n;
        ctx.spans?.set(chainId, Number(span));
        ctx.wins?.set(chainId, 0);
        (ctx.log || (() => {}))(`EVM pool getLogs on chain ${chainId} is answering again; trying ${span} per call`);
      }
    }
    const boxLogs = [...completedLogs, ...receivedLogs];
    const deposits = txLogs
      .filter((l) => l.args.extAmount > 0n)
      .sort((a, b) => cmpBig(a.blockNumber, b.blockNumber) || a.logIndex - b.logIndex);

    if (deposits.length) {
      const last = deposits[deposits.length - 1];
      const gate = await ctx.evalBlock(chainId, last.blockNumber, await blockTime(last.blockNumber));
      if (!ctx.covered(gate)) return; // boost replay behind; retry this chunk next cycle
    }

    // Pair each completion or sweep with the nearest earlier unpaired deposit in its tx: the pool's Transact is
    // emitted inside completeDeposit / sweepReceive, before the router's own event.
    const byTx = new Map();
    for (const d of deposits) {
      if (!byTx.has(d.transactionHash)) byTx.set(d.transactionHash, { deposits: [], boxes: [] });
      byTx.get(d.transactionHash).deposits.push(d);
    }
    for (const b of boxLogs) byTx.get(b.transactionHash)?.boxes.push(b);
    const completionOf = new Map(); // deposit log -> { box, completer, ordinal }
    for (const { deposits: ds, boxes } of byTx.values()) {
      boxes.sort((a, b) => a.logIndex - b.logIndex);
      const seenPerBox = new Map();
      for (const b of boxes) {
        const d = [...ds].reverse().find((x) => x.logIndex < b.logIndex && !completionOf.has(x));
        if (!d) continue;
        const box = lc(b.args.box);
        const ordinal = seenPerBox.get(box) ?? 0;
        seenPerBox.set(box, ordinal + 1);
        completionOf.set(d, { box, completer: lc(b.args.completer ?? ''), ordinal });
      }
    }

    for (const d of deposits) {
      const group = byTx.get(d.transactionHash).deposits;
      const base = group.length === 1 ? d.transactionHash : `${d.transactionHash}:${d.logIndex}`;
      const time = await blockTime(d.blockNumber);
      const completion = completionOf.get(d);
      if (completion) {
        state.addPending({
          chainId, txHash: d.transactionHash, logIndex: d.logIndex, box: completion.box, completer: completion.completer,
          ordinal: completion.ordinal, rowKey: base, amountWei: d.args.extAmount.toString(),
          blockNumber: Number(d.blockNumber), blockTime: Number(time),
        });
        continue;
      }
      const tx = await client.getTransaction({ hash: d.transactionHash });
      const depositor = creditFor(tx, { hops: hops.direct, excluded: ctx.excluded });
      if (!depositor) continue;
      await credit(ctx, { key: base, blockNumber: d.blockNumber, blockTime: time, depositor, amountWei: d.args.extAmount });
    }

    cursor = to;
    state.saveCursor(chainId, to);
    if (ctx.pauseMs && cursor < tip) await new Promise((r) => setTimeout(r, ctx.pauseMs));   // spaced, so a catch-up stays under a public node's rate
  }
}

// ETH bridged from Ethereum through an OP Stack chain's native bridge (Base) reaches a box from L2StandardBridge, inside a
// system deposit transaction whose own sender is the messenger's alias, not a person. The bridge's ETHBridgeFinalized event
// names the Ethereum address that sent it, which is who deposited.
const L2_STANDARD_BRIDGE = '0x4200000000000000000000000000000000000010';
const ETH_BRIDGE_FINALIZED = '0x31b2166ff604fc5672ea5df08a78081d2bc6d746cadce880747f3643d819e83d'; // ETHBridgeFinalized(address,address,uint256,bytes)
async function bridgedSender(ctx, txHash, box, hops) {
  const r = await ctx.client.getTransactionReceipt({ hash: txHash });
  for (const l of r?.logs || []) {
    if (lc(l.address) !== L2_STANDARD_BRIDGE || lc(l.topics?.[0]) !== ETH_BRIDGE_FINALIZED || !l.topics[2]) continue;
    if (lc('0x' + l.topics[2].slice(26)) !== lc(box)) continue;
    const from = lc('0x' + l.topics[1].slice(26));
    return ctx.excluded.has(from) || hops.funding.has(from) ? null : from;
  }
  return null;
}

// An explorer can leave a sweep's own transfer out of a box unindexed (Base's Blockscout has left whole block ranges of
// internal transfers unprocessed), and the release then never shows in the box's history. Once the sweep is old enough that
// the explorer has had its chance, the release is read from the chain instead: what left the box is the drop in its balance
// at the sweep's block, and since a box spends its inflows oldest first, what it held just before was its latest inflows,
// which that drop consumed oldest first. While the inflows the explorer shows do not account for that balance, it waits a
// few days longer for them before crediting only what they do account for.
const CHAIN_RELEASE_AFTER_SECS = 6 * 3600, INFLOWS_WAIT_SECS = 3 * 86400;
async function releaseFromChain(ctx, p, history) {
  const age = Math.floor((ctx.nowSec ? ctx.nowSec() : Date.now() / 1000)) - Number(p.block_time);
  if (age < CHAIN_RELEASE_AFTER_SECS || typeof ctx.client.getBalance !== 'function') return null;
  const block = BigInt(p.block_number), b = lc(p.box);
  const [before, after] = await Promise.all([
    ctx.client.getBalance({ address: p.box, blockNumber: block - 1n }),
    ctx.client.getBalance({ address: p.box, blockNumber: block }),
  ]);
  const out = BigInt(before) - BigInt(after);
  if (out <= 0n) return null;
  const ins = history.filter((e) => e.to === b && e.from !== b && e.block < block)
    .sort((x, y) => cmpBig(x.block, y.block) || x.txIndex - y.txIndex || x.index - y.index);
  const held = [];
  let unaccounted = BigInt(before);
  for (let i = ins.length - 1; i >= 0 && unaccounted > 0n; i--) {
    const take = ins[i].value < unaccounted ? ins[i].value : unaccounted;
    held.unshift({ txHash: ins[i].txHash, index: ins[i].index, from: ins[i].from, amount: take });
    unaccounted -= take;
  }
  if (unaccounted > 0n && age < INFLOWS_WAIT_SECS) return null;
  const consumed = [];
  let need = out;
  for (const h of held) {
    if (need === 0n) break;
    const take = h.amount < need ? h.amount : need;
    consumed.push({ ...h, amount: take });
    need -= take;
  }
  return { txHash: p.tx_hash, index: -1, to: lc(ctx.router), value: out, consumed, shortfall: need };
}

// Resolves pending box completions. A row stays pending (and is retried next cycle) while the explorer is
// unreachable or has not indexed the completion's release from the box yet; rows that keep failing sort last so
// they cannot starve newer ones.
export async function resolvePendingBoxes(ctx) {
  const { state, chainId, client } = ctx;
  const hops = hopsFor(ctx);
  const txCache = new Map();
  const getTx = async (hash) => {
    if (!txCache.has(hash)) txCache.set(hash, await client.getTransaction({ hash }));
    return txCache.get(hash);
  };

  for (const p of state.listPending(chainId, ctx.resolvePerCycle)) {
    try {
      const evalBlock = await ctx.evalBlock(chainId, BigInt(p.block_number), BigInt(p.block_time));
      if (!ctx.covered(evalBlock)) continue;
      const history = await fetchBoxHistory(ctx.explorerGet, ctx.apiBase, p.box);
      const releases = allocateBoxFunding(history, p.box)
        .filter((o) => lc(o.txHash) === lc(p.tx_hash) && o.to === lc(ctx.router));
      const release = releases[p.ordinal] ?? (p.ordinal === 0 ? await releaseFromChain(ctx, p, history) : null);
      if (!release) { state.bumpAttempt(p); continue; }

      let budget = BigInt(p.amount_wei);
      const credited = new Map(); // address -> wei, in first-funding order
      for (const c of release.consumed) {
        if (budget === 0n) break;
        const take = c.amount < budget ? c.amount : budget;
        budget -= take;
        const funder = lc(c.from) === L2_STANDARD_BRIDGE
          ? await bridgedSender(ctx, c.txHash, p.box, hops)
          : creditFor(await getTx(c.txHash), { hops: hops.funding, excluded: ctx.excluded, immediateFrom: c.from });
        if (funder) credited.set(funder, (credited.get(funder) ?? 0n) + take);
      }
      let n = 0;
      for (const [depositor, amountWei] of credited) {
        await credit(ctx, {
          key: rowKey(p.row_key, n++), blockNumber: BigInt(p.block_number), blockTime: BigInt(p.block_time), depositor, amountWei,
        });
      }
      state.deletePending(p);
    } catch (err) {
      state.bumpAttempt(p);
      ctx.log?.(`evm pool box ${p.box} (chain ${chainId}) not resolved yet:`, err?.message || err);
    }
  }
}
