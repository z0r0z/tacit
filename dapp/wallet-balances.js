// What the Wallet sheet lays out as a key's balances, by where they are held. It takes the rows the front page's "Your Tacit" panel is drawn
// from (so the two never disagree) and the read of the key's Bitcoin address, and gives back the rows of each place: no network, no page state.
//
//   balanceRows(items, btc, tokens) → { bitcoin: [row], ethereum: [row] }
//     items   the panel's rows: { key, label, v (bigint, or null while it is read), dec, max, meta, icon | icons | mark, core?, show?, err?, noteVals? (the private notes that hold it, as amounts in the row's units, the largest first) }
//     btc     the key's Bitcoin address as read: { ready, err?, sats, silent, pending, held: [{ id, ticker, decimals, balance, known }] }, or null before any read
//     tokens  { icon(id) → the id of the asset's mark or null, dp(id) → the places to show it to }
// A row is the panel's own, or { key, label, v, dec, max, meta, icon | mark + markId, open, btcAsset?, pending?, err? }: `open` is the sheet its row goes to.

// what the panel carries that is not a balance: points, a reward to claim, a debt, an airdrop
const NOT_BALANCE = new Set(['pts', 'farm', 'loans', 'air']);
// the panel's rows for what is held on Bitcoin; every other row is held on Ethereum
const ON_BITCOIN = /^(btc|btc-.+|sats-.+|tethbtc|usdtbtc|tacbridged)$/;

export function balanceRows(items, btc, tokens = {}) {
  const bitcoin = [], ethereum = [], ready = !!btc?.ready;
  for (const it of items) {
    if (NOT_BALANCE.has(it.key)) continue;
    const held = it.core || it.show;
    if (ON_BITCOIN.test(it.key)) {
      // the address's own read gives every asset on it as a row; until it is read, the bridged ones the panel kept from the last visit stand in
      if (held && (it.key.startsWith('sats-') || (!ready && it.key !== 'btc'))) bitcoin.push(it);
    } else if (held && it.v !== 0n) ethereum.push(it);
  }
  const sats = ready ? (btc.sats ?? 0n) + (btc.silent ?? 0n) : null;
  const own = [{ key: 'btc', label: 'BTC', icon: 'tk-btc', dec: 8, max: 8, v: sats, open: 'btc', err: !!btc?.err && !ready, pending: btc?.pending > 0n ? btc.pending : null, meta: 'at your Bitcoin address' }];
  for (const a of ready ? btc.held || [] : []) {
    if (!a.known || !(a.balance > 0n)) continue;
    const icon = tokens.icon?.(a.id) || null;
    own.push({ key: `held-${a.id}`, label: a.ticker, dec: a.decimals, max: tokens.dp?.(a.id) ?? 4, v: a.balance, meta: 'on Bitcoin', open: 'btc', btcAsset: a.id, ...(icon ? { icon } : { mark: a.ticker, markId: a.id }) });
  }
  return { bitcoin: [...own, ...bitcoin], ethereum };
}
