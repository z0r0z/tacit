// What a holder's Ethereum wallet signs on the governance page. The worker (worker/src/governance.js) rebuilds the same text to find the
// signer, so the two copies must stay identical; tests/governance-page.test.mjs compares them.
export const GOV_NETWORK = 'mainnet';
export const PROPOSE_FLOOR_TAC = 100;
export const CATEGORIES = [['general', 'General'], ['parameter', 'Parameter'], ['treasury', 'Treasury'], ['spec-amendment', 'Spec amendment'], ['collateral-engine', 'Collateral engine']];

export const voteMessage = (id, choice, label) =>
  `Tacit governance vote\nProposal: ${id}\nChoice: ${choice} — ${label}\nThis casts a vote weighted by your public TAC balance. No funds move.`;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function proposeMessage(c) {
  const bytes = new TextEncoder().encode(JSON.stringify([
    'tacit-governance-eth-proposal-v1', c.network, c.title, c.body, c.choices, c.category,
    c.voting_ends_at | 0, c.quorum || '0', c.exec_target || '', c.exec_note || '',
  ]));
  const h = hex(await crypto.subtle.digest('SHA-256', bytes));
  return `Tacit governance proposal\nNetwork: ${c.network}\nTitle: ${c.title}\nVoting ends: ${c.voting_ends_at | 0}\nContent: ${h}\nThis opens a signalling proposal for TAC holders. No funds move.`;
}

// What the wallet signs to hand its TAC voting power to another address (rights: 'vote', or 'all' to open proposals too), or to take it back
// (an empty delegate). Mirrors govDelegateMessage in the worker.
export const delegateMessage = (c) => {
  const to = c.delegate ? String(c.delegate).toLowerCase() : '';
  if (!to) return `Tacit governance delegation\nNetwork: ${c.network}\nDelegate: none\nIssued: ${c.issued | 0}\nThis takes your delegation back. No funds move.`;
  const all = c.rights === 'all';
  return `Tacit governance delegation\nNetwork: ${c.network}\nDelegate: ${to}\nRights: ${all ? 'vote and propose' : 'vote'}\nIssued: ${c.issued | 0}\nThis lets the delegate vote${all ? ' and open proposals' : ''} with your TAC. You can vote yourself on any proposal, or take it back, at any time. No funds move.`;
};
