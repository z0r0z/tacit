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
