// A signed status of the kind the prober serves, for the page checks: a few community operators in each state, our own nodes, and public services.
import { secp, bytesToHex } from '../../dapp/vendor/tacit-deps.min.js';
import { signDoc } from '../../dapp/nodes-list.js';

export const SAMPLE_KEY = new Uint8Array(32).fill(9);
export const samplePub = bytesToHex(secp.getPublicKey(SAMPLE_KEY, true));

export function sampleStatus(T = Math.floor(Date.now() / 1000), key = SAMPLE_KEY) {
  const role = (r, o = {}) => ({ role: r, uptime: 0.99, correct: 1, fresh: 0.98, latency: 140, probes: 61, hard: 0, score: 0, ...o });
  const n = (id, url, o) => ({ id, url, kind: 'eth', name: null, operator: 'x', baseline: false, own: false, fronted: false, net: '1.2.3', state: 'listed', weight: 1, reliability: 0.99, cleanDays: 20, strikes: 0, lastOk: T - 240, roles: [role('eth-reads')], score: 0, ...o });
  const A = '03' + 'a1'.repeat(32), B = '02' + 'b2'.repeat(32), C = '02' + 'c3'.repeat(32);
  const nodes = [
    n('1'.repeat(16), 'https://eth.alice-node.net', { operator: A, name: 'alice', weight: 0.96, roles: [role('eth-reads', { score: 9.6 }), role('eth-logs', { latency: 410, score: 19 }), role('eth-archive', { latency: 820, uptime: 0.93, score: 33.5 })], score: 62.1 }),
    n('2'.repeat(16), 'https://btc.alice-node.net/api', { kind: 'btc', operator: A, name: 'alice', weight: 0.96, roles: [role('btc-esplora', { score: 14.7, latency: 90 }), role('btc-index', { score: 28, latency: 260 })], score: 42.7 }),
    n('3'.repeat(16), 'https://rpc.bobs-basement.org', { operator: B, weight: 0.31, state: 'probation', cleanDays: 4, roles: [role('eth-reads', { uptime: 0.91, fresh: 0.88, latency: 380, score: 7.6 })], score: 7.6 }),
    n('4'.repeat(16), 'https://eth.carol.example', { operator: C, name: 'carol', weight: 0, state: 'shadow', cleanDays: 0, roles: [role('eth-reads', { probes: 4 })] }),
    n('5'.repeat(16), 'https://node.tacit.finance/eth', { baseline: true, own: true, operator: 'baseline-tacit', name: 'Tacit node', roles: [role('eth-reads', { latency: 70 }), role('eth-logs', { latency: 190 }), role('eth-proofs', { latency: 230 })] }),
    n('6'.repeat(16), 'https://node.tacit.finance/btc/api', { kind: 'btc', baseline: true, own: true, operator: 'baseline-tacit', name: 'Tacit node', roles: [role('btc-esplora', { latency: 60 }), role('btc-index', { latency: 150 })] }),
    n('7'.repeat(16), 'https://ethereum-rpc.publicnode.com', { baseline: true, operator: 'baseline-public', name: 'PublicNode', roles: [role('eth-reads', { latency: 110 }), role('eth-logs', { latency: 330, correct: 0.97 }), role('eth-archive', { uptime: 0.88, latency: 900 })] }),
    n('8'.repeat(16), 'https://mempool.space/api', { kind: 'btc', baseline: true, operator: 'baseline-public', name: 'mempool.space', roles: [role('btc-esplora', { latency: 85 }), role('btc-index', { latency: 140 })] }),
    n('9'.repeat(16), 'https://eth.drpc.org', { baseline: true, operator: 'baseline-public', name: 'dRPC', state: 'down', weight: 0, lastOk: T - 5400, roles: [role('eth-reads', { uptime: 0.72, latency: 1900, fresh: 0.6 })] }),
  ];
  const ops = [
    { operator: A, baseline: false, own: false, name: 'alice', endpoints: 2, roles: ['eth-reads', 'eth-logs', 'eth-archive', 'btc-esplora', 'btc-index'], uptime: 0.98, correct: 1, fresh: 0.98, score: 62.1 + 42.7 * 0.25, rank: 1 },
    { operator: B, baseline: false, own: false, name: null, endpoints: 1, roles: ['eth-reads'], uptime: 0.91, correct: 1, fresh: 0.88, score: 7.6, rank: 2 },
    { operator: C, baseline: false, own: false, name: 'carol', endpoints: 1, roles: ['eth-reads'], uptime: 1, correct: 1, fresh: 1, score: 0, rank: 3 },
    { operator: 'baseline-tacit', baseline: true, own: true, name: null, endpoints: 2, roles: ['eth-reads', 'eth-logs', 'eth-proofs', 'btc-esplora', 'btc-index'], uptime: 0.99, correct: 1, fresh: 0.98, score: 0, rank: 4 },
    { operator: 'baseline-public', baseline: true, own: false, name: null, endpoints: 4, roles: ['eth-reads', 'eth-logs', 'eth-archive', 'btc-esplora', 'btc-index'], uptime: 0.93, correct: 0.99, fresh: 0.93, score: 0, rank: 5 },
  ];
  return signDoc('status', { v: 1, at: T - 90, day: Math.floor(T / 86400), signer: bytesToHex(secp.getPublicKey(key, true)), points: 'off', nodes, operators: ops }, key);
}
