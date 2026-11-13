// Every Ethereum node a page may ask, by host: the lists in dapp/eth-nodes.js and the gateways pages name themselves. A browser test
// routes each of them to its own stand-in, so no read reaches the real chain when a list grows.
import { ETH_NODES, ETH_LOG_NODES, ETH_ARCHIVE_NODES } from '../dapp/eth-nodes.js';

export const RPC_HOSTS = [...new Set(['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co', 'rpc.flashbots.net', 'eth.rpc.blxrbdn.com',
  ...[...ETH_NODES, ...ETH_LOG_NODES, ...ETH_ARCHIVE_NODES].map((u) => new URL(u).hostname)])];
