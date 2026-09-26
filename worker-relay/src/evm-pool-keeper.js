// Keeper for TacitEvmPoolRouter's deposit and wrap boxes (contracts/src/TacitEvmPoolRouter.sol). Takes intents
// over HTTP (POST /evm-pool/keeper/deposit, /evm-pool/keeper/wrap), watches each box's balance, and once it is
// funded completes it: a deposit with a proof built against the pool's current leaves, a wrap directly. It is
// paid the pool's relayer fee (deposits) or the intent's tip (wraps), and skips completions whose reward does
// not cover the gas.
//
// Signs with EVM_POOL_KEEPER_PRIV only. Disabled (exits 0) while EVM_POOL_ADDR / EVM_POOL_ROUTER_ADDR are unset.
// Knobs: src/lib/evm-pool-keeper-config.js.

import { createServer } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { poolAsset } from '../../dapp/evm-pool-zk.js';
import { loadKeeperConfig, checkKeeperSigner } from './lib/evm-pool-keeper-config.js';
import { openKeeperStore } from './lib/evm-pool-keeper-store.js';
import { makeKeeperChain } from './lib/evm-pool-keeper-chain.js';
import { makeLeafSync } from './lib/evm-pool-keeper-leaves.js';
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
  const leafSync = makeLeafSync({ store, chain, startBlock: cfg.startBlock, confirmations: cfg.confirmations, logChunk: cfg.logChunk, log });
  const keeper = createKeeper({ store, chain, prover, zk, assetField, leafSync, cfg, log });

  const assetKey = chain.asset.toLowerCase();
  if (!cfg.minFees.has(assetKey) && !cfg.rates.has(assetKey)) log(`warning: no EVM_POOL_KEEPER_MIN_FEES or _TOKEN_RATES entry for the pool asset ${assetKey}; deposits will be skipped`);
  log(`keeper ${account.address} on chain ${chain.chainId}: pool ${chain.pool} router ${chain.router} asset ${chain.asset} vk ${prover.vkHash.slice(0, 16)}${cfg.dryRun ? ' (dry run)' : ''}`);

  let lastTickOk = true;
  const handler = createIntakeHandler({ store, chain, zk, assetField, cfg, log, isReady: () => lastTickOk });
  createServer(handler).listen(cfg.port, () => log(`listening on ${cfg.port}`));

  for (;;) {
    try { await keeper.tick(); lastTickOk = true; }
    catch (e) { lastTickOk = false; log(`tick failed: ${safeErr(e)}`); }
    await sleep(cfg.pollSecs * 1000);
  }
}

main().catch((e) => { log('failed:', safeErr(e, 500)); process.exit(1); });
