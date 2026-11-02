// The farms row on /assets/: where liquidity earns TAC, each with the APR it pays now. The TAC/ETH farm and the private pools' farms are read as the
// rewards page reads them (trade/farm-read.js); TACD's and TACE's pools are the ones the points service's liquidity campaign pays for (trade/lp-campaign.js).
import { ethCall, api, $ } from '/trade/util.js?cb=e53086bb';
import { aprText, readPrecision, privateFarms } from '/trade/farm-read.js?cb=112a01b9';
import { readCampaign, bestApr } from '/trade/lp-campaign.js?cb=9d89e80f';
import { DEPLOYMENTS } from '/vault/deployments.js?cb=4af96594';

const tile = (id) => $(`#fr-${id}`);
function put(id, { apr, note, href }) {
  const a = tile(id);
  if (!a) return;
  if (href) a.href = href;
  if (note != null) $('.sub', a).textContent = note;
  $('.apr', a).textContent = apr == null ? '' : aprText(apr);
}

// `spot` is a promise of { ethUsd, btcUsd }: the reads below start at once, and each tile is drawn when what it needs has come.
export function showFarms(spot) {
  const call = (c) => ethCall(c.to, c.data);
  const fac = readPrecision(call).catch(() => null);
  const prog = api('/farm/program?network=mainnet');
  const synths = Object.fromEntries(DEPLOYMENTS.vaults.map((v) => [v.key, v.hint?.synth]).filter(([, a]) => a));
  const campaign = readCampaign({ ethCall, synths }).catch(() => null);

  fac.then((f) => { if (f) put('pub', f.live ? { apr: f.apr } : { note: 'Between reward periods' }); });

  Promise.all([fac, prog, spot]).then(([f, p, px]) => {
    if (!f || !p) return;
    const list = privateFarms(p, f.tacEth, px || {});
    if (!list.length) return put('prv', { note: 'Between reward periods' });
    const best = list.reduce((m, x) => ((x.apr ?? -1) > (m.apr ?? -1) ? x : m));
    put('prv', { apr: best.apr, note: `${list.length} pools`, href: `/#farm/private-${best.pid}` });
  }).catch(() => {});

  Promise.all([fac, campaign, spot]).then(([f, c, px]) => {
    const tacUsd = (px?.ethUsd || 0) * (f?.tacEth || 0);
    for (const [key, id] of [['usd', 'tacd'], ['eth', 'tace']]) put(id, { apr: bestApr(c, key, tacUsd) });
  }).catch(() => {});
}
