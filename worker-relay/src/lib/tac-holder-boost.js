// TAC-holder points boost (src/points-indexer.js). An activity's points are multiplied by the tier of the
// depositor's public TAC balance, where the balance is the LOWEST it has been over the trailing window
// (windowBlocks, ~24h by default) up to and including the activity's block. Buying TAC just before an
// activity and selling it right after therefore earns nothing; only TAC actually held through the window counts.
//
// Deterministic by construction. Balances come from a local replay of the token's Transfer logs, never a live
// balanceOf, so re-scoring the whole program after a disk loss reproduces every multiplier exactly. That is the
// same property settleCycle's knobs guard protects: points are stored per activity at record time, and a
// re-score must not move any account's cumulative.
//
// Coverage is explicit. boostFor() throws for a block past the replayed range instead of guessing, so a caller
// that scores an activity before the transfer scan has caught up stops rather than silently recording it
// unboosted forever.
//
// Only the public ERC-20 is visible here. TAC held privately (cTAC notes, Bitcoin TAC) does not count.

const TRANSFER_EVENT = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: true, name: 'to', type: 'address' },
    { indexed: false, name: 'amount', type: 'uint256' },
  ],
};

const TAC_DECIMALS = 18n;

// "100:1.25,1000:1.5,10000:2" (whole TAC : multiplier) -> [{ minWei, multiplier }] ascending. Rejects anything
// that could lower points or make a larger balance earn less than a smaller one.
export function parseBoostTiers(spec) {
  const tiers = String(spec || '').split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    const [amount, mult] = part.split(':').map((s) => s.trim());
    if (!/^\d+$/.test(amount || '')) throw new Error(`boost tier "${part}": threshold must be whole TAC`);
    const multiplier = Number(mult);
    if (!(multiplier >= 1) || !Number.isFinite(multiplier)) throw new Error(`boost tier "${part}": multiplier must be >= 1`);
    const minWei = BigInt(amount) * 10n ** TAC_DECIMALS;
    if (minWei === 0n) throw new Error(`boost tier "${part}": threshold must be > 0`);
    return { minWei, multiplier };
  });
  tiers.sort((a, b) => (a.minWei < b.minWei ? -1 : a.minWei > b.minWei ? 1 : 0));
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].minWei === tiers[i - 1].minWei) throw new Error('boost tiers: duplicate threshold');
    if (tiers[i].multiplier < tiers[i - 1].multiplier) throw new Error('boost tiers: multiplier must not fall as the threshold rises');
  }
  return tiers;
}

export function multiplierFor(balanceWei, tiers) {
  let m = 1;
  for (const t of tiers) if (balanceWei >= t.minWei) m = t.multiplier;
  return m;
}

// Lowest balance `address` held over [fromBlock, throughBlock], from its transfer rows sorted by
// (block_number, log_index). The balance entering the window counts, then every intermediate balance inside it.
export function minBalanceOver(rows, address, fromBlock, throughBlock) {
  const a = address.toLowerCase();
  let bal = 0n;
  let min = null;
  for (const r of rows) {
    if (r.block_number > throughBlock) break;
    if (min === null && r.block_number >= fromBlock) min = bal;
    const v = BigInt(r.value_wei);
    if (r.to_addr === a) bal += v;
    if (r.from_addr === a) bal -= v;
    if (min !== null && bal < min) min = bal;
  }
  if (min === null) min = bal; // no transfer inside the window: the balance held throughout
  return min < 0n ? 0n : min;
}

// `db` is a better-sqlite3 handle (the points store's file is fine; the tables are separate).
// fromBlock: the token's deploy block, where the replay starts. startBlock: activities before it get no boost,
// so days scored before the boost existed are unchanged. `namespace` picks the table pair (default 'tac', the
// original TAC boost's tables) so a second token (e.g. a partner's own share token) can hold its own instance
// side by side without its transfer history colliding with TAC's.
export function openTacBoost(db, { tiers, windowBlocks, startBlock, fromBlock, namespace = 'tac' }) {
  if (!(windowBlocks > 0)) throw new Error('tac boost: windowBlocks must be > 0');
  if (!/^[a-z][a-z0-9_]*$/.test(namespace)) throw new Error(`tac boost: invalid namespace "${namespace}"`);
  const transfersTable = `${namespace}_transfers`;
  const cursorTable = `${namespace}_boost_cursor`;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${transfersTable} (
      tx_hash      TEXT NOT NULL,
      log_index    INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      from_addr    TEXT NOT NULL,
      to_addr      TEXT NOT NULL,
      value_wei    TEXT NOT NULL,
      PRIMARY KEY (tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_${transfersTable}_from ON ${transfersTable}(from_addr, block_number);
    CREATE INDEX IF NOT EXISTS idx_${transfersTable}_to ON ${transfersTable}(to_addr, block_number);
    CREATE TABLE IF NOT EXISTS ${cursorTable} (
      id                 INTEGER PRIMARY KEY CHECK (id = 1),
      last_scanned_block INTEGER NOT NULL
    );
  `);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO ${transfersTable} (tx_hash, log_index, block_number, from_addr, to_addr, value_wei)
    VALUES (@txHash, @logIndex, @blockNumber, @from, @to, @valueWei)`);
  const saveCursor = db.prepare(`
    INSERT INTO ${cursorTable} (id, last_scanned_block) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET last_scanned_block = excluded.last_scanned_block`);
  const loadCursor = db.prepare(`SELECT last_scanned_block FROM ${cursorTable} WHERE id = 1`);
  const rowsFor = db.prepare(`
    SELECT block_number, log_index, from_addr, to_addr, value_wei FROM ${transfersTable}
    WHERE (from_addr = @a OR to_addr = @a) AND block_number <= @through
    ORDER BY block_number, log_index`);

  const recordTransfers = db.transaction((transfers, throughBlock) => {
    for (const t of transfers) {
      insert.run({ ...t, from: t.from.toLowerCase(), to: t.to.toLowerCase(), valueWei: String(t.valueWei) });
    }
    saveCursor.run(throughBlock);
  });

  function coveredThrough() {
    const row = loadCursor.get();
    return row ? row.last_scanned_block : fromBlock - 1;
  }

  function boostFor(address, blockNumber) {
    if (blockNumber < startBlock) return { multiplier: 1, minBalanceWei: null };
    const covered = coveredThrough();
    if (blockNumber > covered) {
      throw new Error(`tac boost: block ${blockNumber} is past the replayed transfers (through ${covered})`);
    }
    const a = address.toLowerCase();
    const rows = rowsFor.all({ a, through: blockNumber });
    const minBalanceWei = minBalanceOver(rows, a, blockNumber - windowBlocks + 1, blockNumber);
    return { multiplier: multiplierFor(minBalanceWei, tiers), minBalanceWei };
  }

  return { coveredThrough, recordTransfers, boostFor };
}

// Replays the token's Transfer logs forward from the cursor to `confirmations` behind head, chunked like
// scanCycle. Each chunk commits its rows and the cursor together, so a crash mid-scan never leaves the cursor
// ahead of the rows it claims to cover.
//
// Some RPCs cap eth_getLogs by response size, not a fixed block count — a busy token's Transfer volume can
// fail a range a quieter contract handles fine at the same `chunk`. On such an error this shrinks just that
// range and retries, then grows back toward `chunk` once ranges start succeeding again, rather than adopting
// a permanently tiny chunk (which would turn a large backfill into tens of thousands of round trips).
export async function scanTacTransfers(boost, client, { token, confirmations, chunk }) {
  const latest = await client.getBlockNumber();
  const confirmedTip = Number(latest) - confirmations;
  let from = boost.coveredThrough() + 1;
  let size = chunk;
  while (from <= confirmedTip) {
    const to = Math.min(from + size - 1, confirmedTip);
    let logs;
    try {
      logs = await client.getLogs({ address: token, event: TRANSFER_EVENT, fromBlock: BigInt(from), toBlock: BigInt(to) });
    } catch (err) {
      if (size > 1) { size = Math.max(1, Math.floor(size / 4)); continue; }
      throw err;
    }
    boost.recordTransfers(logs.map((l) => ({
      txHash: l.transactionHash,
      logIndex: Number(l.logIndex),
      blockNumber: Number(l.blockNumber),
      from: l.args.from,
      to: l.args.to,
      valueWei: l.args.amount.toString(),
    })), to);
    from = to + 1;
    size = Math.min(chunk, size * 4);
  }
  return boost.coveredThrough();
}
