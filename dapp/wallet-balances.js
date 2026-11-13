
const NOT_BALANCE = new Set(['pts', 'farm', 'loans', 'air']);
const ON_BITCOIN = /^(btc|btc-.+|sats-.+|tethbtc|usdtbtc|tacbridged)$/;

export function balanceRows(items, btc, tokens = {}) {
  const bitcoin = [], ethereum = [], ready = !!btc?.ready;
  for (const it of items) {
    if (NOT_BALANCE.has(it.key)) continue;
    const held = it.core || it.show;
    if (ON_BITCOIN.test(it.key)) {
      // btc and btc-* stand in for the address's own holdings until they are read; the rest (the Bitcoin pool, assets bridged to the Taproot address) are not among them
      if (held && (!it.key.startsWith('btc') || (!ready && it.key !== 'btc'))) bitcoin.push(it);
    } else if (held && it.v !== 0n) ethereum.push(it);
  }
  const sats = ready ? (btc.sats ?? 0n) + (btc.silent ?? 0n) : null;
  const own = [{ key: 'btc', label: 'BTC', icon: 'tk-btc', dec: 8, max: 8, v: sats, open: 'btc', err: !!btc?.err && !ready, pending: btc?.pending > 0n ? btc.pending : null, meta: 'at your Bitcoin address' }];
  for (const a of ready ? btc.held || [] : []) {
    if (!a.known || !(a.balance > 0n)) continue;
    const icon = tokens.icon?.(a.id) || null;
    const kind = tokens.kind?.(a.id) || null;
    own.push({ key: `held-${a.id}`, label: a.ticker, dec: a.decimals, max: tokens.dp?.(a.id) ?? 4, v: a.balance, meta: 'on Bitcoin', open: 'btc', btcAsset: a.id, ...(kind ? { kind } : {}), ...(icon ? { icon } : { mark: a.ticker, markId: a.id }) });
  }
  return { bitcoin: [...own, ...bitcoin], ethereum };
}
