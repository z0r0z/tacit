// SQLite ledger for the points program (src/points-indexer.js). One file on the service's
// persistent disk; losing it means re-scanning from pointsStartBlock, not a soundness issue —
// every row here is re-derivable from the chain, this is just a cache with a leaderboard view on top.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export function openStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS deposits (
      tx_hash          TEXT PRIMARY KEY,
      block_number     INTEGER NOT NULL,
      block_time       INTEGER NOT NULL,
      depositor        TEXT NOT NULL,
      amount_wei       TEXT NOT NULL,
      prior_deposit_count INTEGER NOT NULL,
      points           REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deposits_depositor ON deposits(depositor);

    CREATE TABLE IF NOT EXISTS totals (
      address       TEXT PRIMARY KEY,
      points        REAL NOT NULL,
      deposit_count INTEGER NOT NULL,
      amount_wei    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cursor (
      id                 INTEGER PRIMARY KEY CHECK (id = 1),
      last_scanned_block INTEGER NOT NULL,
      eth_deposit_count  INTEGER NOT NULL
    );
  `);

  const insertDeposit = db.prepare(`
    INSERT OR IGNORE INTO deposits
      (tx_hash, block_number, block_time, depositor, amount_wei, prior_deposit_count, points)
    VALUES (@txHash, @blockNumber, @blockTime, @depositor, @amountWei, @priorDepositCount, @points)
  `);
  const bumpTotals = db.prepare(`
    INSERT INTO totals (address, points, deposit_count, amount_wei)
    VALUES (@address, @points, 1, @amountWei)
    ON CONFLICT(address) DO UPDATE SET
      points = points + excluded.points,
      deposit_count = deposit_count + 1,
      amount_wei = CAST(CAST(amount_wei AS INTEGER) + CAST(excluded.amount_wei AS INTEGER) AS TEXT)
  `);
  const saveCursorStmt = db.prepare(`
    INSERT INTO cursor (id, last_scanned_block, eth_deposit_count)
    VALUES (1, @lastScannedBlock, @ethDepositCount)
    ON CONFLICT(id) DO UPDATE SET
      last_scanned_block = excluded.last_scanned_block,
      eth_deposit_count = excluded.eth_deposit_count
  `);
  const loadCursorStmt = db.prepare(`SELECT last_scanned_block, eth_deposit_count FROM cursor WHERE id = 1`);
  const leaderboardStmt = db.prepare(`
    SELECT address, points, deposit_count, amount_wei FROM totals ORDER BY points DESC LIMIT ?
  `);
  const totalForStmt = db.prepare(`SELECT address, points, deposit_count, amount_wei FROM totals WHERE address = ?`);
  const depositsForStmt = db.prepare(`
    SELECT tx_hash, block_number, block_time, amount_wei, prior_deposit_count, points
    FROM deposits WHERE depositor = ? ORDER BY block_number DESC LIMIT ?
  `);

  // amount_wei stays a TEXT decimal string throughout (SQLite integers are 64-bit and wei amounts for a
  // single ETH wrap never approach that, so CAST...AS INTEGER above is safe; this is not meant to survive
  // a value near 2^63 wei, which is not a real deposit size).
  const recordDeposit = db.transaction((dep) => {
    const wrote = insertDeposit.run(dep);
    if (wrote.changes === 0) return false; // already recorded (safe to re-scan a chunk after a crash)
    bumpTotals.run({ address: dep.depositor, points: dep.points, amountWei: dep.amountWei });
    return true;
  });

  function loadCursor() {
    const row = loadCursorStmt.get();
    return row
      ? { lastScannedBlock: BigInt(row.last_scanned_block), ethDepositCount: row.eth_deposit_count }
      : null;
  }

  function saveCursor({ lastScannedBlock, ethDepositCount }) {
    saveCursorStmt.run({ lastScannedBlock: lastScannedBlock.toString(), ethDepositCount });
  }

  function leaderboard(limit) {
    return leaderboardStmt.all(limit);
  }

  function totalFor(address) {
    return totalForStmt.get(address.toLowerCase()) || null;
  }

  function depositsFor(address, limit) {
    return depositsForStmt.all(address.toLowerCase(), limit);
  }

  return { db, recordDeposit, loadCursor, saveCursor, leaderboard, totalFor, depositsFor };
}
