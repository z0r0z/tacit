// The entries the status page starts with: our own nodes and the public RPCs and explorers the site already uses. They are probed like anyone's and
// shown on the board, so the page is useful before any operator joins; they are not on the signed list (the pages carry them already) and earn nothing.
// `refs` are who the expected answers come from: our node first, then public sources that serve the deep reads.
export const OWN = [
  { url: 'https://tacit-node-gw.onrender.com/eth', kind: 'eth', roles: ['eth-reads'], name: 'Tacit gateway (light)' },
  { url: 'https://node.tacit.finance/eth', kind: 'eth', roles: ['eth-reads', 'eth-logs', 'eth-proofs'], name: 'Tacit node' },
  { url: 'https://node.tacit.finance/btc/api', kind: 'btc', roles: ['btc-esplora', 'btc-index'], name: 'Tacit node' },
];
export const PUBLIC = [
  { url: 'https://ethereum-rpc.publicnode.com', kind: 'eth', roles: ['eth-reads', 'eth-logs', 'eth-archive'], name: 'PublicNode' },
  { url: 'https://rpc.mevblocker.io', kind: 'eth', roles: ['eth-reads', 'eth-logs', 'eth-archive'], name: 'MEV Blocker' },
  { url: 'https://mainnet.rpc.buidlguidl.com', kind: 'eth', roles: ['eth-reads', 'eth-logs', 'eth-archive'], name: 'BuidlGuidl' },
  { url: 'https://eth.drpc.org', kind: 'eth', roles: ['eth-reads', 'eth-archive'], name: 'dRPC' },
  { url: 'https://1rpc.io/eth', kind: 'eth', roles: ['eth-reads'], name: '1RPC' },
  { url: 'https://ethereum-json-rpc.stakely.io', kind: 'eth', roles: ['eth-reads'], name: 'Stakely' },
  { url: 'https://mempool.space/api', kind: 'btc', roles: ['btc-esplora', 'btc-index'], name: 'mempool.space' },
  { url: 'https://blockstream.info/api', kind: 'btc', roles: ['btc-esplora', 'btc-index'], name: 'Blockstream' },
  { url: 'https://mempool.emzy.de/api', kind: 'btc', roles: ['btc-esplora', 'btc-index'], name: 'Emzy' },
];
export const REFS = {
  eth: [{ url: 'https://node.tacit.finance/eth', own: true }, { url: 'https://ethereum-rpc.publicnode.com' }, { url: 'https://rpc.mevblocker.io' }, { url: 'https://mainnet.rpc.buidlguidl.com' }],
  btc: [{ url: 'https://node.tacit.finance/btc/api', own: true }, { url: 'https://mempool.space/api' }, { url: 'https://blockstream.info/api' }, { url: 'https://mempool.emzy.de/api' }],
};
export const BASELINE = [...OWN.map((e) => ({ ...e, own: true })), ...PUBLIC];
