// Where a USDT round trip stands, read from one Bitcoin transaction of it. The claim card and tasks-usdt-settle.mjs both use this, so a tester
// is guided and credited from what the chains say and nobody has to be found in Discord.
//
// A tester names any Bitcoin transaction of the trip: the one that minted the USDT on Bitcoin (its commit or its reveal), or the burn that brought
// it back. From a transaction that is not a burn, the trip is followed forward through the output that holds the USDT to the burn that spends it.
// The reads come in as `deps`, so the page and Node supply their own and nothing here needs a server of ours (the page reads the explorer, the pool
// and the burn's own bytes; the pool's mint, not a status somewhere, is what says a trip is complete):
//
//   deps.look(txid)       → null (not on Bitcoin) | { confirmed, height, time, kind: 'burn' | 'crossout_mint' | 'other', assetId, nullifier }
//   deps.outspends(txid)  → [{ spent, txid }]               deps.minted(nullifier) → whether the pool has minted this burn
//   deps.attested()       → the height Bitcoin's blocks are attested to on Ethereum, or null (optional)

export const CUSDT_ID = '0xc50e8dd9666f64a23e5457d686382901f08aaea3554328fc4ac25d2f9fac6c00';
// How long the pool takes to mint a burn again, measured on 6 November 2026: 5.2 and 5.5 hours from the burn's block (the reflection attests it after
// 24 confirmations, then the next proof mints it). A burn that has waited this long and three hours more is late.
export const MINT_BACK_SECS = 5.5 * 3600, LATE_SECS = 3 * 3600;

const lc = (s) => String(s || '').toLowerCase().replace(/^0x/, '');

// → { state, txid, burn, minted, height, eta, kind, text }
//   state: complete | burn-recorded | burn-awaiting | burn-late | on-bitcoin | unconfirmed | absent | other-asset | not-tacit | unreachable
//   burn: the burn's txid, when the trip has reached one; eta: when the pool should have minted it (seconds), until it has
export async function trace(named, deps, { hops = 4, now = Date.now() / 1000 } = {}) {
  let cur = lc(named), kind = null;
  const down = (txid) => ({ state: 'unreachable', txid, text: 'Could not read it just now.' });
  for (let hop = 0; hop < hops; hop++) {
    const tx = await deps.look(cur).catch(() => undefined);
    if (tx === undefined) return down(cur);
    if (tx === null) return { state: 'absent', txid: cur, text: 'Not on Bitcoin yet.' };
    if (!tx.confirmed) return { state: 'unconfirmed', txid: cur, burn: tx.kind === 'burn' ? cur : null, text: 'Waiting for its first confirmation on Bitcoin.' };
    if (tx.kind === 'burn') {
      if (lc(tx.assetId) !== lc(CUSDT_ID)) return { state: 'other-asset', txid: cur, text: 'That burns another asset, not USDT.' };
      const minted = await deps.minted(tx.nullifier).catch(() => null);
      const eta = tx.time ? tx.time + MINT_BACK_SECS : null;
      const out = { txid: cur, burn: cur, minted, height: tx.height ?? null, eta };
      if (minted === true) return { ...out, state: 'complete', eta: null, text: 'The pool has minted your USDT back.' };
      const attested = deps.attested ? await deps.attested().catch(() => null) : null;
      if (Number.isInteger(attested) && Number.isInteger(tx.height) && tx.height > attested) return { ...out, state: 'burn-awaiting', text: 'The pool mints your USDT back about 5 hours after the burn, by itself.' };
      if (eta && now > eta + LATE_SECS) return { ...out, state: 'burn-late', text: 'The pool is taking longer than usual to mint it back. If it is not back by tomorrow, say so in Discord, with the transaction id.' };
      return { ...out, state: 'burn-recorded', text: 'The pool mints your USDT back about 5 hours after the burn, by itself.' };
    }
    // not a burn: what it is, then the transaction that spends its first spent output
    kind = tx.kind === 'crossout_mint' ? 'crossout_mint' : kind;
    const os = await deps.outspends(cur).catch(() => null);
    if (!os) return down(cur);
    const next = os.find((o) => o && o.spent && o.txid);
    if (!next) {
      return kind === 'crossout_mint'
        ? { state: 'on-bitcoin', txid: cur, kind, text: 'Your USDT is on Bitcoin. Bring it back from the bridge: burn it there, and the pool mints it again about 5 hours later.' }
        : { state: 'not-tacit', txid: cur, text: 'That is not a transaction of a USDT bridge. Use the Bitcoin transaction that minted your USDT, or the one that burned it.' };
    }
    cur = lc(next.txid);
  }
  return { state: 'not-tacit', txid: cur, text: 'Could not follow that to a burn.' };
}

// The Bitcoin and Ethereum transaction ids in what a tester pastes (a link, a list, an id): a bare 64 hex is Bitcoin, one with 0x (an Etherscan link) is Ethereum.
export function idsIn(text) {
  const btc = [], eth = [];
  for (const m of String(text || '').matchAll(/(0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/g)) { const id = m[2].toLowerCase(); (m[1] ? eth : btc).includes(id) || (m[1] ? eth : btc).push(id); }
  return { btc, eth };
}

// The headline a place held for a tester shows, for where its round trip stands.
export function guide(r) {
  switch (r.state) {
    case 'complete': return ['Round trip complete'];
    case 'burn-recorded': case 'burn-awaiting': return ['Burned on Bitcoin'];
    case 'burn-late': return ['Burned, minting late'];
    case 'on-bitcoin': return ['USDT on Bitcoin'];
    case 'unconfirmed': return ['Waiting for a confirmation'];
    default: return ['Not read yet'];
  }
}
