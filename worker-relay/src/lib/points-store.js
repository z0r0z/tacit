// SQLite ledger for the points program (src/points-indexer.js). One file on the service's
// persistent disk. Rows of activity are re-derivable from the chain, but not everything here is: the reward ledger, the
// days already settled and each cBTC bond's answer (bond_checks) record what was read at the time, and a rebuild would read
// today's chain instead. Keep the disk backed up; a rebuilt ledger can differ from what was published and claimed.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

// excluded: addresses never credited for any activity (the shared relay EOA that settles relayed operations, and any
// keeper); a row naming one is not recorded.
export function openStore(dbPath, { excluded = [] } = {}) {
  const never = new Set(excluded.map((a) => String(a).toLowerCase()));
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // zrouter_cursor started as a single mainnet-only row (id=1). Multichain scanning (Base, Robinhood — same
  // zRouter address, different chains) needs one row per chain, so this migrates that shape to a chain_id
  // primary key before the schema below (re-)creates the table. A fresh database never hits this: it only
  // fires when an existing store still has the old single-row shape.
  const zrouterCursorCols = db.prepare(`PRAGMA table_info(zrouter_cursor)`).all().map((c) => c.name);
  if (zrouterCursorCols.length > 0 && !zrouterCursorCols.includes('chain_id')) {
    db.exec(`
      ALTER TABLE zrouter_cursor RENAME TO zrouter_cursor_old;
      CREATE TABLE zrouter_cursor (
        chain_id           INTEGER PRIMARY KEY,
        last_scanned_block INTEGER NOT NULL
      );
      INSERT INTO zrouter_cursor (chain_id, last_scanned_block)
        SELECT 1, last_scanned_block FROM zrouter_cursor_old WHERE id = 1;
      DROP TABLE zrouter_cursor_old;
    `);
  }

  // pm_markets shipped first with just (market_id, is_eth); creator + created_tx_hash (needed to defer the
  // creator reward to the market's first non-creator bet) were added right after, before any real market
  // existed — CREATE TABLE IF NOT EXISTS below is a no-op on an already-existing table regardless of its
  // column set, so this adds them explicitly. Safe even on a table with rows: both are NOT NULL with no
  // default, but no market could exist yet without them already being known at that point in the rollout.
  const pmMarketsInfo = db.prepare(`PRAGMA table_info(pm_markets)`).all();
  const pmMarketsCols = pmMarketsInfo.map((c) => c.name);
  if (pmMarketsCols.length > 0 && !pmMarketsCols.includes('creator')) {
    db.exec(`
      ALTER TABLE pm_markets ADD COLUMN creator TEXT NOT NULL DEFAULT '';
      ALTER TABLE pm_markets ADD COLUMN created_tx_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE pm_markets ADD COLUMN creator_awarded INTEGER NOT NULL DEFAULT 0;
    `);
  }
  // market_id shipped as INTEGER PRIMARY KEY, which SQLite treats as a rowid alias -- real PM market ids are
  // full uint256s (hash-derived), nowhere near fitting in a 64-bit rowid, so every insert against a real
  // market failed at bind time ("datatype mismatch") and nothing was ever actually stored. Safe to drop and
  // recreate as plain TEXT: this table has never held a row for a market with a real (huge) id.
  const marketIdCol = db.prepare(`PRAGMA table_info(pm_markets)`).all().find((c) => c.name === 'market_id');
  if (marketIdCol && marketIdCol.type.toUpperCase() !== 'TEXT') {
    db.exec(`DROP TABLE pm_markets;`);
  }

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

    -- One-off add-only credits already folded into reward_ledger (see lib/points-adjustments.js); the id is what
    -- makes applying one idempotent.
    -- The ETH each pool held on the first cycle of a UTC day (lib/points-tvl.js); the first reading of a day stands.
    CREATE TABLE IF NOT EXISTS pool_snapshots (
      day      INTEGER NOT NULL,
      chain_id INTEGER NOT NULL,
      pool     TEXT NOT NULL,
      eth_wei  TEXT NOT NULL,
      taken_at INTEGER NOT NULL,
      PRIMARY KEY (day, chain_id, pool)
    );

    -- A cBTC bond's lock outpoint and the funder its escrow share sits under, kept from the event so a bond can be
    -- checked still posted when its day settles (lib/points-bond-hold.js); and what that check found, kept so a
    -- settled day always re-splits to the same rows.
    CREATE TABLE IF NOT EXISTS bond_refs (
      tx_hash  TEXT PRIMARY KEY,
      outpoint TEXT NOT NULL,
      funder   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bond_checks (
      tx_hash    TEXT PRIMARY KEY,
      held       INTEGER NOT NULL,
      checked_at INTEGER NOT NULL
    );

    -- A holding reward (lib/holding-*.js): each EVM pool's Transact events as read from its chain, the snapshot drawn for each
    -- day on each chain (the first one drawn stands), and the claims credited (one per tag per day).
    CREATE TABLE IF NOT EXISTS holding_events (
      chain_id    INTEGER NOT NULL,
      block       INTEGER NOT NULL,
      log_index   INTEGER NOT NULL,
      first_index TEXT NOT NULL,
      out_leaf0   TEXT NOT NULL,
      out_leaf1   TEXT NOT NULL,
      nf0         TEXT NOT NULL,
      nf1         TEXT NOT NULL,
      new_root    TEXT NOT NULL,
      PRIMARY KEY (chain_id, block, log_index)
    );
    CREATE TABLE IF NOT EXISTS holding_cursor (chain_id INTEGER PRIMARY KEY, block INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS holding_snapshots (
      epoch      INTEGER NOT NULL,
      chain_id   INTEGER NOT NULL,
      block      INTEGER NOT NULL,
      moment     INTEGER NOT NULL,
      root       TEXT NOT NULL,
      nf_root    TEXT NOT NULL,
      size       INTEGER NOT NULL,
      nullifiers INTEGER NOT NULL,
      taken_at   INTEGER NOT NULL,
      PRIMARY KEY (epoch, chain_id)
    );
    CREATE TABLE IF NOT EXISTS holding_claims (
      epoch         INTEGER NOT NULL,
      chain_id      INTEGER NOT NULL,
      ret_nf        TEXT NOT NULL,
      claim_address TEXT NOT NULL,
      bucket_wei    TEXT NOT NULL,
      points        REAL NOT NULL,
      claimed_at    INTEGER NOT NULL,
      PRIMARY KEY (epoch, ret_nf)
    );

    -- One-off markers (a backfill that has been done), by name.
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reward_adjustments (
      id         TEXT PRIMARY KEY,
      address    TEXT NOT NULL,
      wei        TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );

    -- Which UTC day-epochs (floor(unixSec/86400)) have been folded into reward_ledger, and the last root this
    -- process successfully got onto PointsDistributor. A day can be settled locally (advancing
    -- last_settled_day) well before its reward is actually claimable on-chain — see settleCycle's comment on
    -- why those two things deliberately don't have to happen together.
    CREATE TABLE IF NOT EXISTS settle_state (
      id                  INTEGER PRIMARY KEY CHECK (id = 1),
      last_settled_day    INTEGER NOT NULL,
      published_root      TEXT,
      published_total_wei TEXT,
      -- The scoring knobs the settled history was computed under, as a stable JSON string.
      --
      -- The knobs are documented as safe to retune because past rows keep the points they were awarded --
      -- true only while this file survives. On disk loss the scan restarts from POINTS_START_BLOCK and
      -- re-scores EVERY historical deposit at whatever the knobs currently say, producing a different
      -- cumulative root for the same history. The contract only refuses a decrease in the AGGREGATE
      -- (TotalDecreased), not in an individual account's cumulative, so an account that already claimed
      -- keeps its tokens while the recomputed total sits lower -- and later honest claimants then hit
      -- OverAllocated and cannot claim at all until the guardian re-funds. Recording the knobs lets a
      -- rebuild refuse rather than silently re-price.
      knobs               TEXT
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

    -- Every Privacy Pools (privacypools.com) ETH WithdrawalRelayed this service has seen, address-indexed —
    -- an append-only log, not deduplicated by address, so more than one qualifying withdrawal per address is
    -- fine and auditable. See points-indexer.js's ppBoostMultiplier for how this gates a wrap's boost.
    CREATE TABLE IF NOT EXISTS pp_recipients (
      tx_hash      TEXT PRIMARY KEY,
      address      TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      block_time   INTEGER NOT NULL,
      amount_wei   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pp_recipients_address ON pp_recipients(address);

    -- Separate cursor from the wrap-event scan above: a different contract, a different starting block
    -- (Privacy Pools' Entrypoint deploy block, not pointsStartBlock), scanned on its own schedule.
    CREATE TABLE IF NOT EXISTS pp_cursor (
      id                 INTEGER PRIMARY KEY CHECK (id = 1),
      last_scanned_block INTEGER NOT NULL
    );

    -- CollateralEngine scan cursor (EscrowPosted + CdpMinted — see scanCollateralEngineCycle). One shared
    -- cursor: both events live on the same contract and are scanned in the same block range each cycle.
    CREATE TABLE IF NOT EXISTS ce_cursor (
      id                 INTEGER PRIMARY KEY CHECK (id = 1),
      last_scanned_block INTEGER NOT NULL
    );

    -- zRouter ETH-swap scan cursor (see scanZRouterCycle), one row per chain (1 = mainnet, 8453 = Base,
    -- 4663 = Robinhood — zRouter is the same address on all three). Forward-only per chain — no deploy-block
    -- floor, since this activity deliberately starts counting from whenever the service first scanned that
    -- chain, not from history.
    CREATE TABLE IF NOT EXISTS zrouter_cursor (
      chain_id           INTEGER PRIMARY KEY,
      last_scanned_block INTEGER NOT NULL
    );

    -- PM (parimutuel prediction markets, src/PM.sol) scan cursor — see scanPmCycle.
    CREATE TABLE IF NOT EXISTS pm_cursor (
      id                 INTEGER PRIMARY KEY CHECK (id = 1),
      last_scanned_block INTEGER NOT NULL
    );

    -- Which markets are ETH-denominated (asset == address(0) at Created), recorded once so a later Bet can be
    -- filtered without re-fetching that market's Created event or calling the contract. Every market gets a
    -- row, not just ETH ones, so "not eth" and "not yet scanned" are never confused. creator_awarded gates the
    -- flat creator reward on the market's first bet from a DIFFERENT address (see scanPmCycle) — otherwise
    -- creating a market costs nothing (no collateral, no bet required, any resolver including yourself), so a
    -- flat reward at Created alone would be free-to-farm at gas cost only, a strictly worse hole than the
    -- bet-then-Exit tradeoff this program already accepts (that one at least costs real capital + a fee).
    -- market_id is TEXT, not INTEGER: PM's real ids are full uint256s (hash-derived, not small sequential
    -- numbers) -- well past Number.MAX_SAFE_INTEGER, so anything that ran it through Number() would silently
    -- corrupt it and fail to bind ("datatype mismatch"), a real bug this shape avoids by construction.
    CREATE TABLE IF NOT EXISTS pm_markets (
      market_id       TEXT PRIMARY KEY,
      is_eth          INTEGER NOT NULL,
      creator         TEXT NOT NULL,
      -- Its own Created tx hash — a real, unique-per-market identifier the deferred creator reward can key
      -- its deposits row on (the triggering bet's own tx hash isn't usable there: it already keys the
      -- bettor's own row, and deposits.tx_hash is a primary key).
      created_tx_hash TEXT NOT NULL,
      creator_awarded INTEGER NOT NULL DEFAULT 0
    );

    -- .wei name registrations through zRouter (NameNFT) — see scanWeinameCycle. Mainnet only.
    CREATE TABLE IF NOT EXISTS weiname_cursor (
      id                 INTEGER PRIMARY KEY CHECK (id = 1),
      last_scanned_block INTEGER NOT NULL
    );
  `);

  // Migration for a store created before tip tracking / the Privacy Pools boost / cBTC+cUSD mint activity
  // existed — CREATE TABLE IF NOT EXISTS above only covers a fresh database. SQLite has no ADD COLUMN IF NOT
  // EXISTS on the version better-sqlite3 bundles, so this just swallows the "duplicate column" error a
  // second run throws.
  for (const col of [
    'tip_wei TEXT', 'tip_recipient TEXT', 'pp_boosted INTEGER NOT NULL DEFAULT 0',
    // What earned these points: 'wrap' (the original ETH-wrap program), 'cbtcmint' (wstETH escrow posted
    // toward a cBTC mint), 'cusdmint' (a cUSD CDP loan opened). amount_wei's UNITS depend on this: ETH wei
    // for 'wrap'/'cbtcmint' (wstETH, 18 decimals), tacitDecimals=8-scaled dollars for 'cusdmint'.
    "activity TEXT NOT NULL DEFAULT 'wrap'",
    // The TAC-holder multiplier already folded into `points` (1 when the depositor held no tier).
    'tac_boost REAL NOT NULL DEFAULT 1',
    // Same, for the Z Shares holder multiplier — kept as its own column alongside tac_boost so either can be
    // audited independently even though both are already folded into `points`.
    'z_share_boost REAL NOT NULL DEFAULT 1',
    // Which chain this deposit happened on (1 = mainnet, 8453 = Base, 4663 = Robinhood — see
    // scanZRouterCycle). Every activity before this column existed was mainnet-only.
    'chain_id INTEGER NOT NULL DEFAULT 1',
    // 1 when the row was recorded after its UTC day had already settled (a scanner that was behind past the settle
    // gate's maximum wait). Such a row earned nothing at settlement; lib/points-late-credit.js makes it whole.
    'late INTEGER NOT NULL DEFAULT 0',
  ]) {
    try { db.exec(`ALTER TABLE deposits ADD COLUMN ${col}`); } catch {}
  }

  const insertDeposit = db.prepare(`
    INSERT OR IGNORE INTO deposits
      (tx_hash, block_number, block_time, depositor, amount_wei, prior_deposit_count, points, tip_wei, tip_recipient, pp_boosted, activity, tac_boost, z_share_boost, chain_id, late)
    VALUES (@txHash, @blockNumber, @blockTime, @depositor, @amountWei, @priorDepositCount, @points, @tipWei, @tipRecipient, @ppBoosted, @activity, @tacBoost, @zShareBoost, @chainId, @late)
  `);
  // `amountWei` here is the address's NEW cumulative total, summed as a BigInt by the caller: SQLite's INTEGER
  // is 64-bit (about 9.2 ETH in wei), which one busy address's running total can pass.
  const bumpTotals = db.prepare(`
    INSERT INTO totals (address, points, deposit_count, amount_wei)
    VALUES (@address, @points, 1, @amountWei)
    ON CONFLICT(address) DO UPDATE SET
      points = points + excluded.points,
      deposit_count = deposit_count + 1,
      amount_wei = excluded.amount_wei
  `);
  const totalAmountStmt = db.prepare(`SELECT amount_wei FROM totals WHERE address = ?`);
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
  const countByActivityStmt = db.prepare(`SELECT COUNT(*) AS n FROM deposits WHERE activity = ?`);
  const depositsForStmt = db.prepare(`
    SELECT tx_hash, block_number, block_time, amount_wei, prior_deposit_count, points, tip_wei, tip_recipient, pp_boosted, activity, tac_boost, z_share_boost, chain_id
    FROM deposits WHERE depositor = ? ORDER BY block_time DESC, block_number DESC LIMIT ?
  `);
  const dayPointsStmt = db.prepare(`
    SELECT depositor AS address, SUM(points) AS dayPoints
    FROM deposits WHERE block_time >= ? AND block_time < ?
    GROUP BY depositor
  `);
  // The same rows by activity, with a bond that was checked and found released left out. dayPointsByAddress above is
  // the whole of a day before any of that applies.
  const dayActivityStmt = db.prepare(`
    SELECT d.depositor AS address, d.activity AS activity, SUM(d.points) AS points
    FROM deposits d LEFT JOIN bond_checks b ON b.tx_hash = d.tx_hash
    WHERE d.block_time >= ? AND d.block_time < ? AND COALESCE(b.held, 1) = 1
    GROUP BY d.depositor, d.activity
  `);
  const weekActivityStmt = db.prepare(`
    SELECT d.depositor AS address, d.block_time / 86400 AS day, d.activity AS activity, SUM(d.points) AS points
    FROM deposits d LEFT JOIN bond_checks b ON b.tx_hash = d.tx_hash
    WHERE d.block_time >= ? AND d.block_time < ? AND COALESCE(b.held, 1) = 1
    GROUP BY d.depositor, d.block_time / 86400, d.activity
  `);
  // The same three reads over only the rows a settlement could have seen (not marked late): what a settled day paid.
  const onTimeDayPointsStmt = db.prepare(`
    SELECT depositor AS address, SUM(points) AS dayPoints
    FROM deposits WHERE block_time >= ? AND block_time < ? AND late = 0
    GROUP BY depositor
  `);
  const onTimeDayActivityStmt = db.prepare(`
    SELECT d.depositor AS address, d.activity AS activity, SUM(d.points) AS points
    FROM deposits d LEFT JOIN bond_checks b ON b.tx_hash = d.tx_hash
    WHERE d.block_time >= ? AND d.block_time < ? AND COALESCE(b.held, 1) = 1 AND d.late = 0
    GROUP BY d.depositor, d.activity
  `);
  const onTimeWeekActivityStmt = db.prepare(`
    SELECT d.depositor AS address, d.block_time / 86400 AS day, d.activity AS activity, SUM(d.points) AS points
    FROM deposits d LEFT JOIN bond_checks b ON b.tx_hash = d.tx_hash
    WHERE d.block_time >= ? AND d.block_time < ? AND COALESCE(b.held, 1) = 1 AND d.late = 0
    GROUP BY d.depositor, d.block_time / 86400, d.activity
  `);
  const lateDaysStmt = db.prepare(`SELECT block_time / 86400 AS day, COUNT(*) AS n FROM deposits WHERE late = 1 GROUP BY block_time / 86400 ORDER BY day`);
  const creditedWithPrefixStmt = db.prepare(`SELECT wei FROM reward_adjustments WHERE id LIKE ? ESCAPE '\\'`);
  const saveBondRefStmt = db.prepare(`INSERT OR IGNORE INTO bond_refs (tx_hash, outpoint, funder) VALUES (?, ?, ?)`);
  const bondsToCheckStmt = db.prepare(`
    SELECT r.tx_hash AS txHash, r.outpoint AS outpoint, r.funder AS funder, d.depositor AS depositor, d.amount_wei AS amountWei
    FROM bond_refs r JOIN deposits d ON d.tx_hash = r.tx_hash LEFT JOIN bond_checks b ON b.tx_hash = r.tx_hash
    WHERE d.activity = 'cbtcmint' AND d.block_time >= ? AND d.block_time < ? AND b.tx_hash IS NULL
    ORDER BY d.block_number
  `);
  // The bonds that may still be posted on a day, one per (outpoint, funder, depositor): the latest row of each posted before
  // it. A funder that is a helper holds many depositors' shares, so each depositor is its own bond. A bond already found
  // released on its own day is left out.
  const bondPairsStmt = db.prepare(`
    SELECT r.outpoint AS outpoint, r.funder AS funder, d.depositor AS depositor, d.block_number AS blockNumber
    FROM bond_refs r JOIN deposits d ON d.tx_hash = r.tx_hash LEFT JOIN bond_checks b ON b.tx_hash = r.tx_hash
    WHERE d.activity = 'cbtcmint' AND d.block_time < ? AND COALESCE(b.held, 1) = 1
    ORDER BY d.block_time, d.block_number
  `);
  const saveBondCheckStmt = db.prepare(`INSERT OR IGNORE INTO bond_checks (tx_hash, held, checked_at) VALUES (?, ?, ?)`);
  const getRewardStmt = db.prepare(`SELECT cumulative_wei FROM reward_ledger WHERE address = ?`);
  const upsertRewardStmt = db.prepare(`
    INSERT INTO reward_ledger (address, cumulative_wei) VALUES (@address, @cumulativeWei)
    ON CONFLICT(address) DO UPDATE SET cumulative_wei = excluded.cumulative_wei
  `);
  const allRewardsStmt = db.prepare(`SELECT address, cumulative_wei AS cumulativeWei FROM reward_ledger WHERE cumulative_wei != '0'`);
  // Additive migration for a database created before `knobs` existed.
  try { db.exec('ALTER TABLE settle_state ADD COLUMN knobs TEXT'); } catch { /* already present */ }
  const loadSettleStateStmt = db.prepare(`SELECT last_settled_day, published_root, published_total_wei, knobs FROM settle_state WHERE id = 1`);
  const saveSettleStateStmt = db.prepare(`
    INSERT INTO settle_state (id, last_settled_day, published_root, published_total_wei, knobs)
    VALUES (1, @lastSettledDay, @publishedRoot, @publishedTotalWei, @knobs)
    ON CONFLICT(id) DO UPDATE SET
      last_settled_day = excluded.last_settled_day,
      published_root = excluded.published_root,
      published_total_wei = excluded.published_total_wei,
      knobs = excluded.knobs
  `);
  const clearPublishedClaimsStmt = db.prepare(`DELETE FROM published_claims`);
  const insertPublishedClaimStmt = db.prepare(`
    INSERT INTO published_claims (address, cumulative_amount, proof_json) VALUES (@address, @cumulativeAmount, @proofJson)
  `);
  const claimForStmt = db.prepare(`SELECT cumulative_amount AS cumulativeAmount, proof_json AS proofJson FROM published_claims WHERE address = ?`);

  const insertPpRecipientStmt = db.prepare(`
    INSERT OR IGNORE INTO pp_recipients (tx_hash, address, block_number, block_time, amount_wei)
    VALUES (@txHash, @address, @blockNumber, @blockTime, @amountWei)
  `);
  const hasEarlierPpWithdrawalStmt = db.prepare(`
    SELECT 1 FROM pp_recipients WHERE address = ? AND block_number <= ? LIMIT 1
  `);
  const loadPpCursorStmt = db.prepare(`SELECT last_scanned_block FROM pp_cursor WHERE id = 1`);
  const savePpCursorStmt = db.prepare(`
    INSERT INTO pp_cursor (id, last_scanned_block) VALUES (1, @lastScannedBlock)
    ON CONFLICT(id) DO UPDATE SET last_scanned_block = excluded.last_scanned_block
  `);
  const loadCeCursorStmt = db.prepare(`SELECT last_scanned_block FROM ce_cursor WHERE id = 1`);
  const saveCeCursorStmt = db.prepare(`
    INSERT INTO ce_cursor (id, last_scanned_block) VALUES (1, @lastScannedBlock)
    ON CONFLICT(id) DO UPDATE SET last_scanned_block = excluded.last_scanned_block
  `);
  const loadZrouterCursorStmt = db.prepare(`SELECT last_scanned_block FROM zrouter_cursor WHERE chain_id = ?`);
  const saveZrouterCursorStmt = db.prepare(`
    INSERT INTO zrouter_cursor (chain_id, last_scanned_block) VALUES (@chainId, @lastScannedBlock)
    ON CONFLICT(chain_id) DO UPDATE SET last_scanned_block = excluded.last_scanned_block
  `);
  const loadPmCursorStmt = db.prepare(`SELECT last_scanned_block FROM pm_cursor WHERE id = 1`);
  const savePmCursorStmt = db.prepare(`
    INSERT INTO pm_cursor (id, last_scanned_block) VALUES (1, @lastScannedBlock)
    ON CONFLICT(id) DO UPDATE SET last_scanned_block = excluded.last_scanned_block
  `);
  const loadWeinameCursorStmt = db.prepare(`SELECT last_scanned_block FROM weiname_cursor WHERE id = 1`);
  const saveWeinameCursorStmt = db.prepare(`
    INSERT INTO weiname_cursor (id, last_scanned_block) VALUES (1, @lastScannedBlock)
    ON CONFLICT(id) DO UPDATE SET last_scanned_block = excluded.last_scanned_block
  `);
  const recordPmMarketStmt = db.prepare(`
    INSERT INTO pm_markets (market_id, is_eth, creator, created_tx_hash) VALUES (@marketId, @isEth, @creator, @createdTxHash)
    ON CONFLICT(market_id) DO NOTHING
  `);
  const getPmMarketStmt = db.prepare(`SELECT is_eth, creator, created_tx_hash, creator_awarded FROM pm_markets WHERE market_id = ?`);
  const markPmCreatorAwardedStmt = db.prepare(`UPDATE pm_markets SET creator_awarded = 1 WHERE market_id = ?`);

  // amount_wei stays a TEXT decimal string throughout, and is only ever added as a BigInt (never CAST to
  // SQLite's 64-bit INTEGER): one address's cumulative total can pass 2^63 wei even though no single deposit
  // does.
  //
  // tipWei/tipRecipient default null here (not in the SQL) so every existing caller — including a direct
  // wrap with no WrapTipForwarder involved at all — stays valid without knowing these fields exist; points-
  // indexer.js only fills them in when it found a matching WrappedWithTip log for this same tx hash. Either
  // way `depositor` (tx.from, the transaction's own signer) is what earns points — a forwarder tip never
  // changes who that is.
  const recordDeposit = db.transaction((dep) => {
    if (never.has(String(dep.depositor).toLowerCase())) return false;
    // A row for a day that has already settled is marked late: the settlement never saw it.
    const settled = loadSettleStateStmt.get()?.last_settled_day;
    const late = settled != null && Math.floor(Number(dep.blockTime) / 86400) <= settled ? 1 : 0;
    const wrote = insertDeposit.run({ tipWei: null, tipRecipient: null, ppBoosted: 0, activity: 'wrap', tacBoost: 1, zShareBoost: 1, chainId: 1, ...dep, late });
    if (wrote.changes === 0) return false; // already recorded (safe to re-scan a chunk after a crash)
    const prior = BigInt(totalAmountStmt.get(dep.depositor)?.amount_wei ?? '0');
    bumpTotals.run({ address: dep.depositor, points: dep.points, amountWei: (prior + BigInt(dep.amountWei)).toString() });
    return true;
  });

  // Totals written before the sum was exact (it went through a 64-bit CAST) can be wrong for any address past
  // ~9.2 ETH. The deposits table is the source of truth, so recompute each address's total from it and fix only
  // what differs. Idempotent and cheap, so it simply runs at every open. A malformed row is skipped, never fatal.
  function repairTotalAmounts() {
    const sums = new Map();
    for (const r of db.prepare('SELECT depositor, amount_wei FROM deposits').iterate()) {
      try { sums.set(r.depositor, (sums.get(r.depositor) ?? 0n) + BigInt(r.amount_wei)); } catch { /* skip */ }
    }
    const fix = db.prepare('UPDATE totals SET amount_wei = ? WHERE address = ? AND amount_wei != ?');
    return db.transaction(() => {
      let fixed = 0;
      for (const [address, sum] of sums) fixed += fix.run(sum.toString(), address, sum.toString()).changes;
      return fixed;
    })();
  }
  repairTotalAmounts();

  // `ethDepositCount` is DERIVED from the deposits table, not trusted from the cursor row.
  //
  // The indexer bumps it once per recorded deposit but only persists the cursor once per scan chunk, while
  // each deposit row is committed immediately. A crash mid-chunk therefore leaves a persisted count lower
  // than the rows that actually exist — and since re-scanning a chunk is deliberately idempotent (a duplicate
  // insert returns false and does not re-bump), the gap never closes. That count is the early-adopter bonus
  // divisor, so every later depositor would be scored as if they were earlier than they are. Counting the
  // rows is exact, cheap, and runs once at startup. Only V1 wraps count: every other activity keeps its own
  // divisor (countByActivity), and rows from before the activity column existed were all wraps.
  function loadCursor() {
    const row = loadCursorStmt.get();
    if (!row) return null;
    const actual = db.prepare("SELECT COUNT(*) AS n FROM deposits WHERE activity = 'wrap'").get().n;
    return { lastScannedBlock: BigInt(row.last_scanned_block), ethDepositCount: actual };
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

  function countByActivity(activity) {
    return countByActivityStmt.get(activity).n;
  }

  function depositsFor(address, limit) {
    return depositsForStmt.all(address.toLowerCase(), limit).map((r) => ({ ...r, pp_boosted: !!r.pp_boosted }));
  }

  function dayPointsByAddress(dayStartSec, dayEndSec, { onTime = false } = {}) {
    return (onTime ? onTimeDayPointsStmt : dayPointsStmt).all(dayStartSec, dayEndSec);
  }
  // Each day that has rows recorded after it settled, with how many: [{ day, n }].
  const lateDays = () => lateDaysStmt.all();
  // What the adjustments whose id starts with `prefix` have credited so far, summed as a BigInt.
  const creditedWithPrefix = (prefix) => creditedWithPrefixStmt.all(prefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%').reduce((s, r) => s + BigInt(r.wei), 0n);
  const commitDayTx = db.transaction((deltas, state) => {
    if (deltas && deltas.size) applyDayRewards(deltas);
    saveSettleState(state);
  });
  const depositorOfStmt = db.prepare(`SELECT depositor FROM deposits WHERE tx_hash = ?`);
  const depositorOfTx = (txHash) => depositorOfStmt.get(txHash)?.depositor ?? null;
  const insertHoldingEventStmt = db.prepare(`INSERT OR IGNORE INTO holding_events (chain_id, block, log_index, first_index, out_leaf0, out_leaf1, nf0, nf1, new_root) VALUES (@chainId, @block, @logIndex, @firstIndex, @outLeaf0, @outLeaf1, @nf0, @nf1, @newRoot)`);
  const saveHoldingEvents = db.transaction((chainId, events) => {
    let n = 0;
    for (const e of events) n += insertHoldingEventStmt.run({ chainId, block: Number(e.block), logIndex: Number(e.logIndex), firstIndex: String(e.firstIndex), outLeaf0: String(e.outLeaf0), outLeaf1: String(e.outLeaf1), nf0: String(e.nf0), nf1: String(e.nf1), newRoot: String(e.newRoot) }).changes;
    return n;
  });
  const holdingEventsStmt = db.prepare(`SELECT block, log_index AS logIndex, first_index AS firstIndex, out_leaf0 AS outLeaf0, out_leaf1 AS outLeaf1, nf0, nf1, new_root AS newRoot FROM holding_events WHERE chain_id = ? AND block <= ? ORDER BY block, log_index`);
  const holdingCursorStmt = db.prepare(`SELECT block FROM holding_cursor WHERE chain_id = ?`);
  const saveHoldingCursorStmt = db.prepare(`INSERT INTO holding_cursor (chain_id, block) VALUES (?, ?) ON CONFLICT(chain_id) DO UPDATE SET block = excluded.block`);
  const saveHoldingSnapshotStmt = db.prepare(`INSERT OR IGNORE INTO holding_snapshots (epoch, chain_id, block, moment, root, nf_root, size, nullifiers, taken_at) VALUES (@epoch, @chainId, @block, @moment, @root, @nfRoot, @size, @nullifiers, @takenAt)`);
  const holdingSnapshotsStmt = db.prepare(`SELECT epoch, chain_id AS chainId, block, moment, root, nf_root AS nfRoot, size, nullifiers, taken_at AS takenAt FROM holding_snapshots WHERE epoch = ? ORDER BY chain_id`);
  const recordHoldingClaimStmt = db.prepare(`INSERT OR IGNORE INTO holding_claims (epoch, chain_id, ret_nf, claim_address, bucket_wei, points, claimed_at) VALUES (@epoch, @chainId, @retNf, @claimAddress, @bucketWei, @points, @claimedAt)`);
  const getMetaStmt = db.prepare(`SELECT v FROM meta WHERE k = ?`);
  const setMetaStmt = db.prepare(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
  const getMeta = (k) => getMetaStmt.get(k)?.v ?? null;
  const setMeta = (k, v) => { setMetaStmt.run(k, String(v)); };
  const holdingEvents = (chainId, throughBlock = Number.MAX_SAFE_INTEGER) => holdingEventsStmt.all(chainId, throughBlock);
  const loadHoldingCursor = (chainId) => holdingCursorStmt.get(chainId)?.block ?? null;
  const saveHoldingCursor = (chainId, block) => { saveHoldingCursorStmt.run(chainId, Number(block)); };
  // The first snapshot drawn for a day on a chain stands.
  const saveHoldingSnapshot = (s) => saveHoldingSnapshotStmt.run({ ...s, root: String(s.root), nfRoot: String(s.nfRoot) }).changes > 0;
  const holdingSnapshots = (epoch) => holdingSnapshotsStmt.all(epoch);
  const recordHoldingClaim = (c) => recordHoldingClaimStmt.run({ ...c, retNf: String(c.retNf) }).changes > 0;
  function dayActivityPoints(dayStartSec, dayEndSec, { onTime = false } = {}) {
    return (onTime ? onTimeDayActivityStmt : dayActivityStmt).all(dayStartSec, dayEndSec);
  }
  function weekActivityPoints(fromSec, toSec, { onTime = false } = {}) {
    return (onTime ? onTimeWeekActivityStmt : weekActivityStmt).all(fromSec, toSec);
  }
  // A reference that is not a 32-byte outpoint and an address is not kept, so a bond whose event came back half decoded
  // is left as it was and never becomes something the settle step cannot read.
  function saveBondRef({ txHash, outpoint, funder }) {
    const o = String(outpoint).toLowerCase(), f = String(funder).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(o) || !/^0x[0-9a-f]{40}$/.test(f)) return false;
    saveBondRefStmt.run(txHash, o, f);
    return true;
  }
  function bondPairsBefore(beforeSec) {
    const latest = new Map();
    for (const r of bondPairsStmt.all(beforeSec)) latest.set(`${r.outpoint}:${r.funder}:${r.depositor}`, r);
    return [...latest.values()];
  }
  function bondsToCheck(dayStartSec, dayEndSec) {
    return bondsToCheckStmt.all(dayStartSec, dayEndSec);
  }
  // One day's rewards and the settled-through mark in a single write, so a crash cannot leave a day paid and still open.
  function commitDay(deltas, state) {
    return commitDayTx(deltas, state);
  }
  // The first answer to a bond stands, so a settled day cannot move.
  function saveBondCheck(txHash, held, checkedAt) {
    return saveBondCheckStmt.run(txHash, held ? 1 : 0, checkedAt).changes > 0;
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

  const hasAdjustmentStmt = db.prepare(`SELECT 1 FROM reward_adjustments WHERE id = ?`);
  const insertAdjustmentStmt = db.prepare(`INSERT INTO reward_adjustments (id, address, wei, applied_at) VALUES (@id, @address, @wei, @appliedAt)`);
  const listAdjustmentsStmt = db.prepare(`SELECT id, address, wei, applied_at AS appliedAt FROM reward_adjustments ORDER BY applied_at, id`);

  // Credits `wei` to `address` once per id; false when the id was already applied. Add-only, summed as a BigInt, and
  // recorded in the same transaction so a crash cannot credit without remembering it (or the reverse).
  const applyAdjustment = db.transaction(({ id, address, wei }) => {
    if (wei <= 0n || hasAdjustmentStmt.get(id)) return false;
    const row = getRewardStmt.get(address);
    upsertRewardStmt.run({ address, cumulativeWei: ((row ? BigInt(row.cumulative_wei) : 0n) + wei).toString() });
    insertAdjustmentStmt.run({ id, address, wei: wei.toString(), appliedAt: Math.floor(Date.now() / 1000) });
    return true;
  });

  const insertPoolSnapshotStmt = db.prepare(`INSERT OR IGNORE INTO pool_snapshots (day, chain_id, pool, eth_wei, taken_at) VALUES (@day, @chainId, @pool, @ethWei, @takenAt)`);
  const poolSnapshotsStmt = db.prepare(`SELECT day, chain_id AS chainId, pool, eth_wei AS ethWei FROM pool_snapshots WHERE day >= ? ORDER BY day, chain_id, pool`);
  const poolDepositsStmt = db.prepare(`SELECT block_time AS t, amount_wei AS w FROM deposits WHERE activity IN ('wrap', 'evmpooldeposit') AND block_time >= ? AND block_time < ?`);

  function savePoolSnapshot(snap) {
    return insertPoolSnapshotStmt.run(snap).changes > 0;
  }

  // Wei scored as deposited into a pool (V1 wraps and EVM pool deposits) per UTC day, summed as BigInts.
  function poolDepositWeiByDay(fromSec, toSec) {
    const out = new Map();
    for (const r of poolDepositsStmt.iterate(fromSec, toSec)) {
      const day = Math.floor(r.t / 86400);
      out.set(day, (out.get(day) ?? 0n) + BigInt(r.w));
    }
    return out;
  }

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
      ? { lastSettledDay: row.last_settled_day, publishedRoot: row.published_root, publishedTotalWei: row.published_total_wei, knobs: row.knobs ?? null }
      : null;
  }

  function saveSettleState({ lastSettledDay, publishedRoot, publishedTotalWei, knobs }) {
    saveSettleStateStmt.run({
      lastSettledDay,
      publishedRoot: publishedRoot ?? null,
      publishedTotalWei: publishedTotalWei ?? null,
      knobs: knobs ?? null,
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

  function recordPpWithdrawal(w) {
    insertPpRecipientStmt.run(w); // INSERT OR IGNORE: idempotent against a re-scanned chunk
  }

  // Whether `address` was ever the recipient of a Privacy Pools ETH withdrawal at or before
  // `beforeBlockNumber` — the ordering check that makes "funded by" meaningful (a withdrawal that hasn't
  // happened yet can't have funded an earlier wrap).
  function hasEarlierPpWithdrawal(address, beforeBlockNumber) {
    return !!hasEarlierPpWithdrawalStmt.get(address.toLowerCase(), beforeBlockNumber);
  }

  function loadPpCursor() {
    const row = loadPpCursorStmt.get();
    return row ? BigInt(row.last_scanned_block) : null;
  }

  function savePpCursor(lastScannedBlock) {
    savePpCursorStmt.run({ lastScannedBlock: lastScannedBlock.toString() });
  }

  function loadCeCursor() {
    const row = loadCeCursorStmt.get();
    return row ? BigInt(row.last_scanned_block) : null;
  }

  function saveCeCursor(lastScannedBlock) {
    saveCeCursorStmt.run({ lastScannedBlock: lastScannedBlock.toString() });
  }

  function loadZrouterCursor(chainId = 1) {
    const row = loadZrouterCursorStmt.get(chainId);
    return row ? BigInt(row.last_scanned_block) : null;
  }

  function saveZrouterCursor(lastScannedBlock, chainId = 1) {
    saveZrouterCursorStmt.run({ chainId, lastScannedBlock: lastScannedBlock.toString() });
  }

  function loadPmCursor() {
    const row = loadPmCursorStmt.get();
    return row ? BigInt(row.last_scanned_block) : null;
  }

  function savePmCursor(lastScannedBlock) {
    savePmCursorStmt.run({ lastScannedBlock: lastScannedBlock.toString() });
  }

  function loadWeinameCursor() {
    const row = loadWeinameCursorStmt.get();
    return row ? BigInt(row.last_scanned_block) : null;
  }

  function saveWeinameCursor(lastScannedBlock) {
    saveWeinameCursorStmt.run({ lastScannedBlock: lastScannedBlock.toString() });
  }

  function recordPmMarket(marketId, isEth, creator, createdTxHash) {
    recordPmMarketStmt.run({ marketId, isEth: isEth ? 1 : 0, creator: creator.toLowerCase(), createdTxHash });
  }

  // { isEth, creator, createdTxHash, creatorAwarded } once the market's Created event has been seen, null if
  // it hasn't (a Bet arriving before its own market's Created is never expected in practice, since PM
  // requires the market to exist first, but this stays undecided rather than guessing if the scan somehow
  // saw one out of order).
  function getPmMarket(marketId) {
    const row = getPmMarketStmt.get(marketId);
    return row ? { isEth: !!row.is_eth, creator: row.creator, createdTxHash: row.created_tx_hash, creatorAwarded: !!row.creator_awarded } : null;
  }

  function markPmCreatorAwarded(marketId) {
    markPmCreatorAwardedStmt.run(marketId);
  }

  return {
    db, recordDeposit, loadCursor, saveCursor, leaderboard, totalFor, depositsFor, countByActivity,
    dayPointsByAddress, dayActivityPoints, weekActivityPoints, lateDays, creditedWithPrefix, commitDay, saveHoldingEvents, holdingEvents, loadHoldingCursor, saveHoldingCursor, saveHoldingSnapshot, holdingSnapshots, recordHoldingClaim, depositorOfTx, getMeta, setMeta, saveBondRef, bondPairsBefore, bondsToCheck, saveBondCheck, applyDayRewards, applyAdjustment, listAdjustments: () => listAdjustmentsStmt.all(), allRewards, rewardFor,
    savePoolSnapshot, poolSnapshots: (fromDay) => poolSnapshotsStmt.all(fromDay), poolDepositWeiByDay,
    loadSettleState, saveSettleState, savePublishedClaims, claimFor,
    recordPpWithdrawal, hasEarlierPpWithdrawal, loadPpCursor, savePpCursor,
    loadCeCursor, saveCeCursor, loadZrouterCursor, saveZrouterCursor,
    loadPmCursor, savePmCursor, recordPmMarket, getPmMarket, markPmCreatorAwarded,
    loadWeinameCursor, saveWeinameCursor,
  };
}
