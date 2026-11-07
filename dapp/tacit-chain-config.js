// Where the tacit chain is: its landing contract and a leader's API. Null until the chain is deployed, which hides every chain
// option in the app. A browser can point at another deployment (a local fork) with localStorage 'tacit-chain-dev' =
// {"blocks":"0x…","leader":"http://127.0.0.1:…"}; that setting is the browser's own and changes nothing for anyone else.
export const TACIT_CHAIN = { blocks: null, leader: null };

export function tacitChain() {
  try {
    const dev = JSON.parse(globalThis.localStorage?.getItem('tacit-chain-dev') || 'null');
    if (dev && /^0x[0-9a-fA-F]{40}$/.test(dev.blocks || '') && /^https?:\/\//.test(dev.leader || '')) return { blocks: dev.blocks, leader: dev.leader.replace(/\/$/, ''), dev: true };
  } catch {}
  return TACIT_CHAIN.blocks && TACIT_CHAIN.leader ? { ...TACIT_CHAIN } : null;
}
