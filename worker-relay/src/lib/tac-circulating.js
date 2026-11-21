// TAC's circulating supply as a public JSON endpoint for CoinGecko (its "Integration API Standards", section C: a simple REST endpoint, decimals
// included, public, no key, polled about every 30 minutes). GET /supply on the points service answers it.
//
// Total supply is the fixed 21,000,000 etched on Bitcoin (lib/tac-supply.js): the ERC-20's own totalSupply is only the public part, because the
// pool burns TAC as it is shielded and mints it as it is withdrawn. Circulating is the total less the TAC held in the project's own wallets, read
// from chain on each refresh: the ops multisig (treasury), the airdrop contract and the points distributor (both unclaimed until claimed), and any
// wallet added in POINTS_SUPPLY_EXCLUDED. It is the same list the supply update form gives CoinGecko, so the two never disagree. TAC held privately on
// Bitcoin or inside the pools has no public address and is not subtracted.
import { isAddress, getAddress } from 'viem';
import { TAC_ETCH_SUPPLY } from './tac-supply.js';

// contracts/deployments/1.json: engineAdmin. tests/tac-circulating.test.mjs compares it with that file byte for byte.
export const OPS_MULTISIG = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
// The airdrop that holds unclaimed TAC (dapp/weld/stats/read.js: A.airdrop); the test compares it too.
export const TAC_AIRDROP = '0x4b4cb98D0C836c2783Ac46f0078b904dab533AE8';

const BALANCE_OF = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];

// A comma list of addresses → { ok: [checksummed], bad: [what was not an address] }.
export function parseExcluded(text) {
  const ok = [], bad = [];
  for (const raw of String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean)) (isAddress(raw, { strict: false }) ? ok : bad).push(isAddress(raw, { strict: false }) ? getAddress(raw) : raw);
  return { ok, bad };
}

// The wallets whose TAC is not circulating, each once, with what it is.
export function uncirculatedWallets({ distributor = '', extra = [] } = {}) {
  const list = [
    { label: 'ops multisig (treasury)', address: OPS_MULTISIG },
    { label: 'airdrop, unclaimed', address: TAC_AIRDROP },
    ...(distributor ? [{ label: 'points distributor, unclaimed rewards', address: getAddress(distributor) }] : []),
    ...extra.map((address) => ({ label: 'project wallet', address })),
  ];
  const seen = new Set();
  return list.filter((w) => { const k = w.address.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// One figure as a bare number, for a field that wants only that (CoinGecko's own example endpoint, blockchain.info/q/totalbc, answers one): GET
// /supply/total and /supply/circulating. A bare number is also valid JSON. r is get()'s answer; a failed read passes its status and error through.
export function plainValue(r, which) {
  if (r.status !== 200) return { status: r.status, text: JSON.stringify(r.body) };
  return { status: 200, text: String(which === 'total' ? r.body.total_supply : r.body.circulating_supply) };
}

// whole tokens with up to eight decimals, from wei
const tokens = (wei) => Number(wei / 10n ** 10n) / 1e8;

// client: a viem public client. get() → { status, body }, refreshed at most every ttlMs; a failed read serves the last good answer for up to staleMs.
export function makeCirculating({ client, token, wallets, nowMs = () => Date.now(), ttlMs = 60_000, staleMs = 3_600_000, log = () => {} }) {
  let last = null, inflight = null;
  async function read() {
    const balances = await Promise.all(wallets.map((w) => client.readContract({ address: token, abi: BALANCE_OF, functionName: 'balanceOf', args: [w.address] })));
    const held = balances.reduce((s, b) => s + BigInt(b), 0n);
    const circulating = TAC_ETCH_SUPPLY > held ? TAC_ETCH_SUPPLY - held : 0n;
    return {
      at: nowMs(),
      body: {
        symbol: 'TAC', token, chainId: 1, decimals: 18,
        total_supply: tokens(TAC_ETCH_SUPPLY), max_supply: tokens(TAC_ETCH_SUPPLY), circulating_supply: tokens(circulating),
        excluded: wallets.map((w, i) => ({ label: w.label, address: w.address, balance: tokens(BigInt(balances[i])) })),
        updated: new Date(nowMs()).toISOString(),
      },
    };
  }
  return async function get() {
    if (last && nowMs() - last.at < ttlMs) return { status: 200, body: last.body };
    inflight ||= read().then((r) => { last = r; return r; }).finally(() => { inflight = null; });
    try { return { status: 200, body: (await inflight).body }; } catch (err) {
      log('supply read failed:', err?.message || err);
      if (last && nowMs() - last.at < staleMs) return { status: 200, body: { ...last.body, stale: true } };
      return { status: 503, body: { error: 'supply is not readable right now' } };
    }
  };
}
