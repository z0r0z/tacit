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
      points           REAL NOT NULL,
      tip_wei          TEXT,
      tip_recipient    TEXT
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

    -- Reward ledger (src/points-indexer.js's settleCycle): each address's cumulative TAC-wei entitlement,
    -- the mirror of what the current on-chain PointsDistributor root should declare for that leaf. Kept as
    -- TEXT and only ever updated by reading+adding as a JS BigInt (see applyDayRewards) — SQLite's INTEGER
    -- affinity is 64-bit and this program's 100,000 TAC budget (1e23 wei) is already ~10,000x past that, so
    -- any CAST(...AS INTEGER) arithmetic on this column (the way totals.amount_wei above does it for much
    -- smaller ETH amounts) would silently wrap.
    CREATE TABLE IF NOT EXISTS reward_ledger (
      address        TEXT PRIMARY KEY,
      cumulative_wei TEXT NOT NULL
    );

    -- Which UTC day-epochs (floor(unixSec/86400)) have been folded into reward_ledger, and the last root this
    -- process successfully got onto PointsDistributor. A day can be settled locally (advancing
    -- last_settled_day) well before its reward is actually claimable on-chain — see settleCycle's comment on
    -- why those two things deliberately don't have to happen together.
    CREATE TABLE IF NOT EXISTS settle_state (
      id                  INTEGER PRIMARY KEY CHECK (id = 1),
      last_settled_day    INTEGER NOT NULL,
      published_root      TEXT,
      published_total_wei TEXT
    );

    -- The full claim set (address, cumulativeAmount, merkle proof) for whichever tree's root was LAST
    -- successfully published on-chain — never for a newer locally-computed tree still waiting on funding, since
    -- a proof for a root the contract doesn't hold yet would just revert with BadProof. Rebuilt wholesale each
    -- successful publish (see savePublishedClaims).
    CREATE TABLE IF NOT EXISTS published_claims (
      address            TEXT PRIMARY KEY,
      cumulative_amount  TEXT NOT NULL,
      proof_json         TEXT NOT NULL
    );
  `);

  // Migration for a store created before tip tracking existed — CREATE TABLE IF NOT EXISTS above only
  // covers a fresh database. SQLite has no ADD COLUMN IF NOT EXISTS on the version better-sqlite3 bundles,
  // so this just swallows the "duplicate column" error a second run throws.
  for (const col of ['tip_wei TEXT', 'tip_recipient TEXT']) {
    try { db.exec(`ALTER TABLE deposits ADD COLUMN ${col}`); } catch {}
  }

  const insertDeposit = db.prepare(`
    INSERT OR IGNORE INTO deposits
      (tx_hash, block_number, block_time, depositor, amount_wei, prior_deposit_count, points, tip_wei, tip_recipient)
    VALUES (@txHash, @blockNumber, @blockTime, @depositor, @amountWei, @priorDepositCount, @points, @tipWei, @tipRecipient)
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
    SELECT tx_hash, block_number, block_time, amount_wei, prior_deposit_count, points, tip_wei, tip_recipient
    FROM deposits WHERE depositor = ? ORDER BY block_number DESC LIMIT ?
  `);
  const dayPointsStmt = db.prepare(`
    SELECT depositor AS address, SUM(points) AS dayPoints
    FROM deposits WHERE block_time >= ? AND block_time < ?
    GROUP BY depositor
  `);
  const getRewardStmt = db.prepare(`SELECT cumulative_wei FROM reward_ledger WHERE address = ?`);
  const upsertRewardStmt = db.prepare(`
    INSERT INTO reward_ledger (address, cumulative_wei) VALUES (@address, @cumulativeWei)
    ON CONFLICT(address) DO UPDATE SET cumulative_wei = excluded.cumulative_wei
  `);
  const allRewardsStmt = db.prepare(`SELECT address, cumulative_wei AS cumulativeWei FROM reward_ledger WHERE cumulative_wei != '0'`);
  const loadSettleStateStmt = db.prepare(`SELECT last_settled_day, published_root, published_total_wei FROM settle_state WHERE id = 1`);
  const saveSettleStateStmt = db.prepare(`
    INSERT INTO settle_state (id, last_settled_day, published_root, published_total_wei)
    VALUES (1, @lastSettledDay, @publishedRoot, @publishedTotalWei)
    ON CONFLICT(id) DO UPDATE SET
      last_settled_day = excluded.last_settled_day,
      published_root = excluded.published_root,
      published_total_wei = excluded.published_total_wei
  `);
  const clearPublishedClaimsStmt = db.prepare(`DELETE FROM published_claims`);
  const insertPublishedClaimStmt = db.prepare(`
    INSERT INTO published_claims (address, cumulative_amount, proof_json) VALUES (@address, @cumulativeAmount, @proofJson)
  `);
  const claimForStmt = db.prepare(`SELECT cumulative_amount AS cumulativeAmount, proof_json AS proofJson FROM published_claims WHERE address = ?`);

  // amount_wei stays a TEXT decimal string throughout (SQLite integers are 64-bit and wei amounts for a
  // single ETH wrap never approach that, so CAST...AS INTEGER above is safe; this is not meant to survive
  // a value near 2^63 wei, which is not a real deposit size).
  //
  // tipWei/tipRecipient default null here (not in the SQL) so every existing caller — including a direct
  // wrap with no WrapTipForwarder involved at all — stays valid without knowing these fields exist; points-
  // indexer.js only fills them in when it found a matching WrappedWithTip log for this same tx hash. Either
  // way `depositor` (tx.from, the transaction's own signer) is what earns points — a forwarder tip never
  // changes who that is.
  const recordDeposit = db.transaction((dep) => {
    const wrote = insertDeposit.run({ tipWei: null, tipRecipient: null, ...dep });
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

  function dayPointsByAddress(dayStartSec, dayEndSec) {
    return dayPointsStmt.all(dayStartSec, dayEndSec);
  }

  // deltas: Map<lowercaseAddress, bigint wei>. Read-add-write per address, in one transaction, so a crash
  // mid-batch can't leave some addresses credited for a day and others not.
  const applyDayRewards = db.transaction((deltas) => {
    for (const [address, deltaWei] of deltas) {
      if (deltaWei <= 0n) continue;
      const row = getRewardStmt.get(address);
      const prior = row ? BigInt(row.cumulative_wei) : 0n;
      upsertRewardStmt.run({ address, cumulativeWei: (prior + deltaWei).toString() });
    }
  });

  function allRewards() {
    return allRewardsStmt.all();
  }

  function rewardFor(address) {
    const row = getRewardStmt.get(address.toLowerCase());
    return row ? row.cumulative_wei : '0';
  }

  function loadSettleState() {
    const row = loadSettleStateStmt.get();
    return row
      ? { lastSettledDay: row.last_settled_day, publishedRoot: row.published_root, publishedTotalWei: row.published_total_wei }
      : null;
  }

  function saveSettleState({ lastSettledDay, publishedRoot, publishedTotalWei }) {
    saveSettleStateStmt.run({
      lastSettledDay,
      publishedRoot: publishedRoot ?? null,
      publishedTotalWei: publishedTotalWei ?? null,
    });
  }

  // Replaces the whole published-claims set atomically — it always describes exactly one tree (the one whose
  // root currently lives on PointsDistributor), never a mix of two.
  const savePublishedClaims = db.transaction((claims) => {
    clearPublishedClaimsStmt.run();
    for (const [address, c] of Object.entries(claims)) {
      insertPublishedClaimStmt.run({
        address: address.toLowerCase(),
        cumulativeAmount: c.cumulativeAmount,
        proofJson: JSON.stringify(c.proof),
      });
    }
  });

  function claimFor(address) {
    const row = claimForStmt.get(address.toLowerCase());
    if (!row) return null;
    return { cumulativeAmount: row.cumulativeAmount, proof: JSON.parse(row.proofJson) };
  }

  return {
    db, recordDeposit, loadCursor, saveCursor, leaderboard, totalFor, depositsFor,
    dayPointsByAddress, applyDayRewards, allRewards, rewardFor,
    loadSettleState, saveSettleState, savePublishedClaims, claimFor,
  };
}
