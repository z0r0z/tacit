// Keeper and relayer for the EVM pool (contracts/src/TacitEvmPool.sol, TacitEvmPoolRouter.sol). Takes deposit and
// wrap intents and receive boxes over HTTP (POST /evm-pool/keeper/{deposit,wrap,receive}), watches each box's
// balance and acts once it is funded: a deposit is completed with a proof built against the pool's current leaves,
// a wrap directly, and a receive box is swept into a note for its owner. It is paid the pool's relayer fee
// (deposits, sweeps) or the intent's tip (wraps), and skips work whose reward does not cover the gas. It also
// relays users' own proven withdrawals and transfers that name it as relayer (GET /evm-pool/keeper/quote, then
// POST /evm-pool/keeper/relay), so a user needs no gas and no funded address.
//
// Signs with EVM_POOL_KEEPER_PRIV only. Disabled (exits 0) while EVM_POOL_ADDR / EVM_POOL_ROUTER_ADDR are unset.
// Knobs: src/lib/evm-pool-keeper-config.js.

import { createServer } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { poolAsset } from '../../dapp/evm-pool-zk.js';
import { loadKeeperConfig, checkKeeperSigner } from './lib/evm-pool-keeper-config.js';
import { openKeeperStore } from './lib/evm-pool-keeper-store.js';
import { makeKeeperChain } from './lib/evm-pool-keeper-chain.js';
import { makeLeafSync, makeFactsSync } from './lib/evm-pool-keeper-leaves.js';
import { makePipeline } from './lib/evm-pool-keeper-pipeline.js';
import { makeKeeperProver, loadZk } from './lib/evm-pool-keeper-prover.js';
import { createIntakeHandler } from './lib/evm-pool-keeper-intake.js';
import { createKeeper } from './lib/evm-pool-keeper-loop.js';
import { safeErr } from './lib/safe-err.js';

const log = (...a) => console.log(`[evm-pool-keeper ${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadKeeperConfig(process.env);
  if (!cfg.enabled) { log(`disabled: ${cfg.reason}`); return; }
  if (!cfg.keeperKey) throw new Error('EVM_POOL_KEEPER_PRIV is not set');
  const account = privateKeyToAccount(cfg.keeperKey.startsWith('0x') ? cfg.keeperKey : `0x${cfg.keeperKey}`);
  checkKeeperSigner(cfg, account.address);
  cfg.keeperAddress = account.address;

  const chain = await makeKeeperChain({ cfg, account, log });
  const assetField = poolAsset({ chainId: BigInt(chain.chainId), pool: chain.pool, token: chain.asset });
  const zk = await loadZk();
  const prover = await makeKeeperProver(cfg);
  const store = openKeeperStore(cfg.dbPath);
  const leafSync = makeLeafSync({ store, chain, zk, startBlock: cfg.startBlock, confirmations: cfg.confirmations, logChunk: cfg.logChunk, log });
  const pipeline = cfg.pipeline ? makePipeline({ chain, verify: prover.verify, assetField, baseTree: () => leafSync.sync(), maxDepth: cfg.pipelineDepth, log }) : null;
  const keeper = createKeeper({ store, chain, prover, zk, assetField, leafSync, pipeline, cfg, log });

  const assetKey = chain.asset.toLowerCase();
  if (!cfg.minFees.has(assetKey) && !cfg.rates.has(assetKey)) log(`warning: no EVM_POOL_KEEPER_MIN_FEES or _TOKEN_RATES entry for the pool asset ${assetKey}; deposits will be skipped`);
  log(`keeper ${account.address} on chain ${chain.chainId}: pool ${chain.pool} router ${chain.router} asset ${chain.asset} vk ${prover.vkHash.slice(0, 16)}${cfg.dryRun ? ' (dry run)' : ''}`);

  let lastTickOk = true;
  const handler = createIntakeHandler({ store, chain, zk, assetField, cfg, log, leafSync, pipeline, isReady: () => lastTickOk });
  createServer(handler).listen(cfg.port, () => log(`listening on ${cfg.port}`));

  // The history's public facts fill in on their own loop: a backfill or a slow node never delays a relay or a proof.
  if (cfg.facts) {
    const facts = makeFactsSync({ store, chain, startBlock: cfg.startBlock, logChunk: cfg.logChunk, concurrency: cfg.factsConcurrency });
    (async () => {
      for (;;) {
        let more = false;
        try { more = await facts.step(20_000); } catch (e) { log(`history facts: ${safeErr(e)}`); }
        await sleep(more ? 1000 : cfg.historySecs * 1000);
      }
    })();
  }

  let lastHistory = 0;
  for (;;) {
    try { await keeper.tick(); lastTickOk = true; }
    catch (e) { lastTickOk = false; log(`tick failed: ${safeErr(e)}`); }
    // Keeps the stored history (the /events feed) current when there is nothing to prove.
    if (Date.now() - lastHistory >= cfg.historySecs * 1000) {
      lastHistory = Date.now();
      try { await leafSync.sync(); } catch (e) { log(`history sync: ${safeErr(e)}`); }
    }
    await sleep(cfg.pollSecs * 1000);
  }
}

main().catch((e) => { log('failed:', safeErr(e, 500)); process.exit(1); });
