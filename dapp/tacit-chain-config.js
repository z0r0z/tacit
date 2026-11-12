export const TACIT_CHAIN = { blocks: '0x00000000000a9147ffd8d41d152d730ca5f84e6c', leader: 'https://tacit-chain-leader.onrender.com' };
export const TACIT_SEATS = { address: '0x00000000001f703eae70de3b528213e4802790fb', from: 26366003 };

export function tacitChain() {
  try {
    const dev = JSON.parse(globalThis.localStorage?.getItem('tacit-chain-dev') || 'null');
    if (dev && /^0x[0-9a-fA-F]{40}$/.test(dev.blocks || '') && /^https?:\/\//.test(dev.leader || '')) return { blocks: dev.blocks, leader: dev.leader.replace(/\/$/, ''), dev: true };
  } catch {}
  return TACIT_CHAIN.blocks && TACIT_CHAIN.leader ? { ...TACIT_CHAIN, seats: TACIT_SEATS.address, seatsFrom: TACIT_SEATS.from } : null;
}
