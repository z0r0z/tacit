// Env config for the EVM pool box keeper (src/evm-pool-keeper.js). Pure: takes an env object, returns a plain
// config, so tests build one without touching process.env.
//
// The keeper signs with EVM_POOL_KEEPER_PRIV and nothing else. It never reads the relay's keys: that EOA's
// nonce is shared by several services, and a second signer on it would race them.

import { getAddress, isAddress } from 'viem';

const ETH = '0x0000000000000000000000000000000000000000';
// The shared relay EOA. A keeper key that derives to it is refused outright.
export const RELAY_EOA = '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7';
const BUILD = new URL('../../../dapp/circuits/evm-pool/build/', import.meta.url).pathname;

const str = (env, k, d = '') => (env[k] === undefined || env[k] === '' ? d : String(env[k]).trim());
const int = (env, k, d) => {
  const v = str(env, k);
  if (v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a non-negative number`);
  return n;
};
const big = (env, k, d) => {
  const v = str(env, k);
  if (v === '') return d;
  if (!/^\d+$/.test(v)) throw new Error(`${k} must be a non-negative integer`);
  return BigInt(v);
};
const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);

// "token:amount,..." with token an address or "eth". Keys are lowercase addresses.
export function parseTokenMap(v, name) {
  const out = new Map();
  for (const pair of list(v || '')) {
    const [t, a] = pair.split(':').map((s) => s.trim());
    const token = t?.toLowerCase() === 'eth' ? ETH : t;
    if (!token || !isAddress(token) || !/^\d+$/.test(a || '')) throw new Error(`${name}: bad entry "${pair}"`);
    out.set(token.toLowerCase(), BigInt(a));
  }
  return out;
}

export function loadKeeperConfig(env = process.env) {
  const pool = str(env, 'EVM_POOL_ADDR');
  const router = str(env, 'EVM_POOL_ROUTER_ADDR');
  if (!pool || !router) return { enabled: false, reason: 'EVM_POOL_ADDR and EVM_POOL_ROUTER_ADDR are not both set' };
  if (!isAddress(pool) || !isAddress(router)) throw new Error('EVM_POOL_ADDR / EVM_POOL_ROUTER_ADDR must be addresses');

  const rpcUrl = str(env, 'EVM_POOL_RPC_URL', str(env, 'RPC_URL'));
  if (!rpcUrl) throw new Error('EVM_POOL_RPC_URL is not set');
  const chainId = str(env, 'EVM_POOL_CHAIN_ID') ? Number(str(env, 'EVM_POOL_CHAIN_ID')) : null;

  const minFees = parseTokenMap(str(env, 'EVM_POOL_KEEPER_MIN_FEES'), 'EVM_POOL_KEEPER_MIN_FEES');
  const rates = parseTokenMap(str(env, 'EVM_POOL_KEEPER_TOKEN_RATES'), 'EVM_POOL_KEEPER_TOKEN_RATES');
  rates.set(ETH, 10n ** 18n);

  const sendDefault = chainId === 1 ? 'https://rpc.flashbots.net,https://rpc.mevblocker.io' : '';
  return {
    enabled: true,
    pool: getAddress(pool),
    router: getAddress(router),
    chainId,
    rpcUrls: [rpcUrl, ...list(str(env, 'EVM_POOL_RPC_URLS_FALLBACK'))].filter((u, i, a) => a.indexOf(u) === i),
    sendRpcUrls: list(str(env, 'EVM_POOL_KEEPER_SEND_RPC_URLS', sendDefault)),
    allowPublicSend: str(env, 'EVM_POOL_KEEPER_ALLOW_PUBLIC', '1') !== '0',
    dryRun: str(env, 'EVM_POOL_KEEPER_DRY_RUN', '0') === '1',

    dbPath: str(env, 'EVM_POOL_KEEPER_DB', '/var/lib/tacit-evm-pool-keeper/keeper.db'),
    port: int(env, 'PORT', 10000),

    startBlock: big(env, 'EVM_POOL_START_BLOCK', 0n),
    confirmations: big(env, 'EVM_POOL_CONFIRMATIONS', 12n),
    logChunk: big(env, 'EVM_POOL_LOG_CHUNK', 2000n),

    pollSecs: int(env, 'EVM_POOL_KEEPER_POLL_SECS', 15),
    maxBackoffSecs: int(env, 'EVM_POOL_KEEPER_MAX_BACKOFF_SECS', 900),
    maxChecksPerTick: int(env, 'EVM_POOL_KEEPER_MAX_CHECKS_PER_TICK', 200),
    minFees,
    rates,
    marginBps: big(env, 'EVM_POOL_KEEPER_MARGIN_BPS', 2000n),
    depositGas: big(env, 'EVM_POOL_KEEPER_DEPOSIT_GAS', 500000n),
    wrapGas: big(env, 'EVM_POOL_KEEPER_WRAP_GAS', 300000n),
    gasCap: big(env, 'EVM_POOL_KEEPER_GAS_CAP', 1500000n),
    staleRetries: int(env, 'EVM_POOL_KEEPER_STALE_RETRIES', 3),
    maxAttempts: int(env, 'EVM_POOL_KEEPER_MAX_ATTEMPTS', 5),
    receiptWaitSecs: int(env, 'EVM_POOL_KEEPER_RECEIPT_WAIT_SECS', 180),
    reclaim: str(env, 'EVM_POOL_KEEPER_RECLAIM', '0') === '1',
    expireGraceSecs: int(env, 'EVM_POOL_KEEPER_EXPIRE_GRACE_SECS', 86400),

    maxBody: int(env, 'EVM_POOL_KEEPER_MAX_BODY', 16384),
    maxMemoBytes: int(env, 'EVM_POOL_KEEPER_MAX_MEMO_BYTES', 1024),
    maxPending: int(env, 'EVM_POOL_KEEPER_MAX_PENDING', 5000),
    minDeadlineSecs: int(env, 'EVM_POOL_KEEPER_MIN_DEADLINE_SECS', 600),
    maxDeadlineSecs: int(env, 'EVM_POOL_KEEPER_MAX_DEADLINE_SECS', 30 * 86400),
    ratePerMin: int(env, 'EVM_POOL_KEEPER_RATE_PER_MIN', 20),

    wasm: str(env, 'EVM_POOL_WASM', BUILD + 'transact_js/transact.wasm'),
    zkey: str(env, 'EVM_POOL_ZKEY', BUILD + 'transact_dev_final.zkey'),
    vk: str(env, 'EVM_POOL_VK', BUILD + 'transact_dev_vk.json'),
    vkHash: str(env, 'EVM_POOL_VK_HASH'),
    singleThread: str(env, 'EVM_POOL_KEEPER_SINGLE_THREAD', '0') === '1',

    keeperKey: str(env, 'EVM_POOL_KEEPER_PRIV'),
    // Public addresses only: the keeper key must not be one of these.
    forbiddenSigners: [RELAY_EOA, str(env, 'SETTLE_ADDRESS')].filter((a) => isAddress(a)).map((a) => a.toLowerCase()),
  };
}

export function checkKeeperSigner(cfg, address) {
  if (cfg.forbiddenSigners.includes(address.toLowerCase())) {
    throw new Error(`EVM_POOL_KEEPER_PRIV derives to ${address}, a shared relay signer; give the keeper its own key`);
  }
}

export { ETH };
