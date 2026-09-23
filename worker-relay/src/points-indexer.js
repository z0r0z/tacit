// ETH-wrap points program. Purely a read + tally over the pool's existing Wrap event and each wrap's
// tx sender — no contract change, no interaction with settle/reflection. See CFG's "Points program"
// section (lib/config.js) for the formula and every tunable.
//
// Deliberately forward-only: counts wraps from CFG.pointsStartBlock on, nothing earlier. Informational
// only for now — this serves a leaderboard/lookup API; it does not mint or gate anything on-chain.

import { createServer } from 'node:http';
import { CFG, ADDR } from './lib/config.js';
import { publicClient } from './lib/chain.js';
import { openStore } from './lib/points-store.js';

const log = (...a) => console.log(`[points ${new Date().toISOString()}]`, ...a);

const WRAP_EVENT = {
  type: 'event',
  name: 'Wrap',
  inputs: [
    { name: 'depositId', type: 'bytes32', indexed: true },
    { name: 'assetId', type: 'bytes32', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
  ],
};

function pointsForDeposit(amountWei, priorDepositCount) {
  const amountEth = Number(amountWei) / 1e18;
  const bonus = 1 + CFG.pointsBonusScale / (1 + priorDepositCount / CFG.pointsBonusHalfLife);
  return amountEth * CFG.pointsBasePerEth * bonus;
}

async function scanCycle(store) {
  const cursor = store.loadCursor() ?? {
    lastScannedBlock: BigInt(CFG.pointsStartBlock) - 1n,
    ethDepositCount: 0,
  };

  const latest = await publicClient.getBlockNumber();
  const confirmedTip = latest - BigInt(CFG.pointsConfirmations);
  if (confirmedTip <= cursor.lastScannedBlock) return;

  const chunk = BigInt(CFG.pointsScanChunk);
  const blockCache = new Map();
  const txCache = new Map();

  let from = cursor.lastScannedBlock + 1n;
  while (from <= confirmedTip) {
    const to = from + chunk - 1n > confirmedTip ? confirmedTip : from + chunk - 1n;

    const logs = await publicClient.getLogs({
      address: ADDR.pool,
      event: WRAP_EVENT,
      args: { assetId: CFG.ethAssetId },
      fromBlock: from,
      toBlock: to,
    });

    for (const evt of logs) {
      let block = blockCache.get(evt.blockNumber);
      if (!block) {
        block = await publicClient.getBlock({ blockNumber: evt.blockNumber });
        blockCache.set(evt.blockNumber, block);
      }
      let tx = txCache.get(evt.transactionHash);
      if (!tx) {
        tx = await publicClient.getTransaction({ hash: evt.transactionHash });
        txCache.set(evt.transactionHash, tx);
      }

      const priorDepositCount = cursor.ethDepositCount;
      const points = pointsForDeposit(evt.args.amount, priorDepositCount);
      const wrote = store.recordDeposit({
        txHash: evt.transactionHash,
        blockNumber: Number(evt.blockNumber),
        blockTime: Number(block.timestamp),
        depositor: tx.from.toLowerCase(),
        amountWei: evt.args.amount.toString(),
        priorDepositCount,
        points,
      });
      if (wrote) cursor.ethDepositCount += 1;
    }

    cursor.lastScannedBlock = to;
    store.saveCursor(cursor);
    from = to + 1n;
  }

  log(`scanned to block ${cursor.lastScannedBlock}, ${cursor.ethDepositCount} ETH deposits recorded`);
}

function startHttp(store) {
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/health') {
        const cursor = store.loadCursor();
        res.end(JSON.stringify({
          ok: true,
          lastScannedBlock: cursor ? cursor.lastScannedBlock.toString() : null,
          ethDepositCount: cursor ? cursor.ethDepositCount : 0,
        }));
        return;
      }
      if (url.pathname === '/leaderboard') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
        res.end(JSON.stringify(store.leaderboard(limit)));
        return;
      }
      const pointsMatch = url.pathname.match(/^\/points\/(0x[0-9a-fA-F]{40})$/);
      if (pointsMatch) {
        const address = pointsMatch[1];
        const total = store.totalFor(address) ?? { address: address.toLowerCase(), points: 0, deposit_count: 0, amount_wei: '0' };
        const deposits = store.depositsFor(address, 100);
        res.end(JSON.stringify({ ...total, deposits }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
  });
  server.listen(CFG.pointsHttpPort, () => log(`http listening on :${CFG.pointsHttpPort}`));
}

async function main() {
  if (!CFG.pointsStartBlock) throw new Error('missing required env POINTS_START_BLOCK');
  const store = openStore(CFG.pointsDbPath);
  startHttp(store);

  for (;;) {
    try {
      await scanCycle(store);
    } catch (err) {
      log('scan cycle failed:', err?.message || err);
    }
    await new Promise((r) => setTimeout(r, CFG.pointsPollSecs * 1000));
  }
}

main().catch((err) => {
  log('fatal:', err?.stack || err);
  process.exit(1);
});
