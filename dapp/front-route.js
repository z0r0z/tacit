// Routing for the front page, run in <head> so that a link meant for another page moves on before this one renders.
// The host serves this page for / and for every path that is not a file, so links made for the classic app (now
// /classic.html) and for this page's old home (/weld/, /lite/) arrive here. The query and fragment are carried over
// unchanged; a fragment never leaves the browser, which matters for the ones that carry a secret (#recv=, #claim=).
(function () {
  var CLASSIC = '/classic.html';
  // The classic app's tabs, which it writes into the address bar as clean paths (/market?aid=…). Mirrors preboot.js.
  var TABS = ['wallet', 'holdings', 'transfer', 'discover', 'market', 'pool', 'farms', 'etch', 'factory', 'drops', 'claim',
    'about', 'mixer', 'confidential-pool', 'otc', 'cdp', 'csend', 'cswap', 'earn', 'points', 'govern'];
  // Pages in their own directories, asked for without the trailing slash.
  var PAGES = ['sats', 'secret-sats', 'ceremony', 'tacit-v1', 'tac', 'pay', 'weld/stats', 'weld/keeper', 'pay/eth'];
  // The fragments and queries the classic app reads; this page's own are bare names (#eth, #farm) and #sp=/#st=.
  var CLASSIC_HASH = /^#(?:(?:tab|recv|claim|dclaim|gate|tacit-invoice|amm)=|amm-?ceremony$)/;
  var CLASSIC_QUERY = ['ceremony', 'coordinator', 'amm', 'ammceremony'];
  // Readable paths for this page's own views (/lock, /farm, /device/base/withdraw): each becomes its link, the part after
  // the #, on this same page, with no reload. Names the classic app used for its tabs (/points) stay its own, except /airdrop,
  // which opens this page's claim.
  var VIEWS = ['lock', 'borrow', 'farm', 'leaderboard', 'bitcoin', 'private', 'device', 'buy', 'sell', 'swap', 'activity', 'asset', 'airdrop'];
  // Leaving for another page: the front page's own module sees the flag and stays idle until the browser moves on.
  var away = function (to) { window.__tacitAway = true; window.location.replace(to); };
  try {
    var loc = window.location, path = loc.pathname, q = loc.search, h = loc.hash;
    var seg = ((path.match(/^\/([a-z0-9-]+(?:\/[a-z0-9-]+)?)\/?$/i) || [])[1] || '').toLowerCase();
    if (PAGES.indexOf(seg) !== -1 && !/\/$/.test(path)) return away('/' + seg + '/' + q + h);
    if (seg === 'classic') return away(CLASSIC + q + h);
    if (TABS.indexOf(seg) !== -1) {
      if (h) return away(CLASSIC + q + h);
      // The tab rides in the fragment, as preboot.js would put it, so the classic page opens on it.
      var qs = new URLSearchParams(q), aid = qs.get('aid') || '', lane = qs.get('lane') || '', tab = '#tab=' + seg;
      qs.delete('aid'); qs.delete('lane');
      if (/^[0-9a-f]{64}$/i.test(aid)) tab += '&aid=' + aid.toLowerCase() + (lane === 'btc' || lane === 'eth' ? '&lane=' + lane : '');
      var rest = qs.toString();
      return away(CLASSIC + (rest ? '?' + rest : '') + tab);
    }
    var params = new URLSearchParams(q);
    if (CLASSIC_HASH.test(h) || CLASSIC_QUERY.some(function (k) { return params.has(k); })) return away(CLASSIC + q + h);
    // Payment, gift and proof links belong to tacit pay: #btc&pay= and #tac&pay= to its hub, the rest to its ETH page.
    if (/(^#|&)(gift|proof|pay)=/.test(h)) return away((/^#(btc|tac)&/i.test(h) ? '/pay/' : '/pay/eth/') + h);
    var parts = path.toLowerCase().replace(/^\/+|\/+$/g, '').split('/');
    var view = VIEWS.indexOf(parts[0]) !== -1 && parts.every(function (x) { return /^[a-z0-9-]+$/.test(x); });
    if (path !== '/') window.history.replaceState(null, '', '/' + q + (view && !h ? '#' + parts.join('/') : h));
  } catch (e) { /* never keep the page from loading */ }
})();
