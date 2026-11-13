(function () {
  var CLASSIC = '/classic.html';
  var TABS = ['wallet', 'holdings', 'transfer', 'discover', 'market', 'pool', 'farms', 'etch', 'factory', 'drops', 'claim',
    'about', 'mixer', 'confidential-pool', 'otc', 'cdp', 'csend', 'cswap', 'earn', 'points', 'govern'];
  var PAGES = ['sats', 'secret-sats', 'ceremony', 'tacit-v1', 'tac', 'trade', 'trade/tac', 'teth', 'cbtc', 'vault', 'pay', 'weld/stats', 'weld/keeper', 'pay/eth', 'swap', 'assets', 'rewards', 'bridge', 'discord'];
  var CLASSIC_HASH = /^#(?:(?:tab|recv|claim|dclaim|gate|tacit-invoice|amm)=|amm-?ceremony$)/;
  var CLASSIC_QUERY = ['ceremony', 'coordinator', 'amm', 'ammceremony'];
  var VIEWS = ['lock', 'borrow', 'farm', 'leaderboard', 'bitcoin', 'private', 'device', 'buy', 'sell', 'activity', 'asset', 'airdrop'];
  var away = function (to) { window.__tacitAway = true; window.location.replace(to); };
  try {
    var loc = window.location, path = loc.pathname, q = loc.search, h = loc.hash;
    var pay = /^\/to\/([^/]+)(?:\/([^/]+))?\/?$/i.exec(path);
    if (pay) {
      var pq = new URLSearchParams(q), amt = pay[2] || pq.get('amt') || '', note = Array.from((pq.get('for') || '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')).slice(0, 80).join('');
      return away('/tac/#to=' + encodeURIComponent(decodeURIComponent(pay[1]).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '').toLowerCase()) + (/^\d{1,12}(\.\d{1,8})?$/.test(amt) ? '&amt=' + amt : '')
        + (note ? '&for=' + encodeURIComponent(note) : ''));
    }
    var seg = ((path.match(/^\/([a-z0-9-]+(?:\/[a-z0-9-]+)?)\/?$/i) || [])[1] || '').toLowerCase();
    if (seg === 'airdrop' && !h) return away('/rewards/' + q);
    if (seg === 'trade') return away('/trade/tac/' + q + h);
    if (seg === 'trade/teth') return away('/teth/' + q + h);
    if (seg === 'trade/cbtc') return away('/cbtc/' + q + h);
    if (seg === 'vault/tac') return away('/vault/' + q + h);
    if (seg === 'vault/btc') return away('/vault/' + q + (h && h !== '#' ? h : '#btc'));
    if (PAGES.indexOf(seg) !== -1 && !/\/$/.test(path)) return away('/' + seg + '/' + q + h);
    if (seg === 'classic') return away(CLASSIC + q + h);
    if (seg === 'tac') return;
    if (TABS.indexOf(seg) !== -1) {
      if (h) return away(CLASSIC + q + h);
      var qs = new URLSearchParams(q), aid = qs.get('aid') || '', lane = qs.get('lane') || '', tab = '#tab=' + seg;
      qs.delete('aid'); qs.delete('lane');
      if (/^[0-9a-f]{64}$/i.test(aid)) tab += '&aid=' + aid.toLowerCase() + (lane === 'btc' || lane === 'eth' ? '&lane=' + lane : '');
      var rest = qs.toString();
      return away(CLASSIC + (rest ? '?' + rest : '') + tab);
    }
    var params = new URLSearchParams(q);
    if (CLASSIC_HASH.test(h) || CLASSIC_QUERY.some(function (k) { return params.has(k); })) return away(CLASSIC + q + h);
    if (/(^#|&)(gift|proof|pay)=/.test(h)) return away((/^#(btc|tac)&/i.test(h) ? '/pay/' : '/pay/eth/') + h);
    var parts = path.toLowerCase().replace(/^\/+|\/+$/g, '').split('/');
    var view = VIEWS.indexOf(parts[0]) !== -1 && parts.every(function (x) { return /^[a-z0-9-]+$/.test(x); });
    if (path !== '/') window.history.replaceState(null, '', '/' + q + (view && !h ? '#' + parts.join('/') : h));
    // a link that opens a sheet: the sheets' code is asked for now, beside the page's module, not once the module reaches the link
    if (window.location.hash.length > 1) {
      var pre = document.createElement('link');
      pre.rel = 'modulepreload'; pre.href = '/front/sheets.js?cb=f2e268f5';
      document.head.appendChild(pre);
    }
  } catch (e) { }
})();
