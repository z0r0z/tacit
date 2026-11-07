// The farms on /assets/: where liquidity earns TAC, a tile each with the APR it pays now, and on each asset's row a link to the best farm that pairs it. The TAC/ETH farm
// and the private pools' farms are read as the rewards page reads them (trade/farm-read.js); TACD's and TACE's pools are the ones the points service's liquidity campaign
// pays for (trade/lp-campaign.js). A tile, and an asset's farm link, go where that farm is joined: the front page's Earn card, on that pool, for the TAC/ETH farm and the
// private ones; the vault's markets for TACD and TACE.
import { ethCall, api, $ } from '/trade/util.js?cb=ba5a02b1';
import { aprText, readPrecision, privateFarms } from '/trade/farm-read.js?cb=112a01b9';
import { readCampaign, bestApr, notTrading } from '/trade/lp-campaign.js?cb=e1b8a224';
import { DEPLOYMENTS } from '/vault/deployments.js?cb=4af96594';

const joinAt = (pid) => `/#card=earn:ether:${pid == null ? 'public' : `p${pid}`}`;
const perDay = (n) => `APR · ${Math.round(n).toLocaleString('en-US')} TAC a day`;

function put(a, { apr, note, href, day }) {
  if (!a) return;
  if (href) a.href = href;
  if (note != null) $('.sub', a).textContent = note;
  if (day != null) $('.day', a).textContent = day;
  $('.apr', a).textContent = apr == null ? '' : aprText(apr);
  F.set(a.id, { pair: a.dataset.pair.split(' '), apr: apr ?? null, href: a.getAttribute('href') });
  links();
}

// What each tile pays now, by tile id: { pair: [sym, sym], apr, href }.
const F = new Map();
// Each asset's row: the farm that pays most of those that pair it, said as "up to" when there are others.
function links() {
  for (const el of document.querySelectorAll('.al .ern[data-sym]')) {
    const all = [...F.values()].filter((f) => f.pair.includes(el.dataset.sym) && f.apr != null);
    if (!all.length) { el.hidden = true; continue; }
    const best = all.reduce((m, f) => (f.apr > m.apr ? f : m));
    el.href = best.href;
    el.innerHTML = `Farm ${all.length > 1 ? 'up to ' : ''}<b class="num">${aprText(best.apr)}</b> APR`;
    el.hidden = false;
  }
}

// One tile for each private farm the program pays, in its order after the TAC/ETH one; a farm the page did not list is drawn like the others.
function privateTiles(list) {
  const pub = $('#fr-pub')?.closest('li');
  if (!pub) return;
  const want = new Set(list.map((x) => `fr-p${x.pid}`));
  for (const a of document.querySelectorAll('#fl a[id^="fr-p"]:not(#fr-pub)')) if (!want.has(a.id)) { F.delete(a.id); a.closest('li').remove(); }
  let after = pub;
  for (const x of list) {
    let a = $(`#fr-p${x.pid}`);
    if (!a) {
      const li = document.createElement('li'), [s0, s1] = x.name.split(' / '), tk = (k) => `<svg class="tk" aria-hidden="true"><use href="#tk-${k}"/></svg>`;
      li.innerHTML = `<a id="fr-p${x.pid}"><span class="pair">${tk(x.icons[0])}${tk(x.icons[1])}</span><span class="n"><b></b><small class="sub">Private pool</small></span><span class="a"><b class="num apr"></b><small class="day">APR now</small><span class="go" aria-hidden="true">→</span></span></a>`;
      a = li.firstChild;
      a.dataset.pair = `${s0} ${s1}`;
      $('.n b', a).textContent = x.name;
    }
    after.after(a.closest('li'));
    after = a.closest('li');
    put(a, { apr: x.apr, note: 'Private pool', href: joinAt(x.pid), day: x.perDay > 0 ? perDay(x.perDay) : null });
  }
}

// `spot` is a promise of { ethUsd, btcUsd }: the reads below start at once, and each tile is drawn when what it needs has come.
export function showFarms(spot) {
  const call = (c) => ethCall(c.to, c.data);
  const fac = readPrecision(call).catch(() => null);
  const prog = api('/farm/program?network=mainnet');
  const synths = Object.fromEntries(DEPLOYMENTS.vaults.map((v) => [v.key, v.hint?.synth]).filter(([, a]) => a));
  const campaign = readCampaign({ ethCall, synths }).catch(() => null);

  fac.then((f) => {
    if (f) put($('#fr-pub'), f.live ? { apr: f.apr, note: 'Public pool', day: perDay(Number(f.perDay) / 1e18) } : { note: 'Between reward periods' });
  });

  Promise.all([fac, prog, spot]).then(([f, p, px]) => {
    if (!f || !p) return;
    const list = privateFarms(p, f.tacEth, px || {});
    if (list.length) return privateTiles(list);
    for (const a of document.querySelectorAll('#fl a[id^="fr-p"]:not(#fr-pub)')) put(a, { note: 'Between reward periods' });
  }).catch(() => {});

  Promise.all([fac, campaign, spot]).then(([f, c, px]) => {
    const tacUsd = (px?.ethUsd || 0) * (f?.tacEth || 0);
    for (const [key, id] of [['usd', 'tacd'], ['eth', 'tace']]) put($(`#fr-${id}`), notTrading(c, key) ? { note: 'Not trading now' } : { apr: bestApr(c, key, tacUsd) });
  }).catch(() => {});
}
