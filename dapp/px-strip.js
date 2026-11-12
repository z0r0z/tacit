
export const PXS_KEY = 'tacit-front-pxs-v1', PXS_MS = 60 * 60e3;

const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const strip0x = (h) => String(h).replace(/^0x/, '');
const wordAt = (hex, i) => BigInt('0x' + (strip0x(hex).slice(i * 64, i * 64 + 64) || '0'));

const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11';
const AGGREGATE3 = '82ad56cb';
export const PX_CALLS = [
  { to: '0x0155358241411dB868BA714aE7c83A27087e3D6E', data: '2af1f249' },
  { to: '0x000000003f608BDdF0ca45934003ffb9DbDF70DB', data: '7dd55c2b' + word(10n ** 8n) },
  { to: '0x000000003f608BDdF0ca45934003ffb9DbDF70DB', data: 'd5901347' + word(10n ** 8n) },
  { to: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', data: 'bb2952fc' + word(10n ** 18n) },
];

export function pxFigures([sp, wst, usd, rate]) {
  const root = sp ? Number(wordAt(sp, 0)) / 1e18 : 0;
  return {
    mid: root > 0 ? 1 / (root * root) : null,
    ethBtc: wst && rate ? (Number(wordAt(wst, 0)) / 1e18) * (Number(wordAt(rate, 0)) / 1e18) : null,
    usdBtc: usd ? Number(wordAt(usd, 0)) / 1e8 : null,
  };
}

function pxHtml(v) {
  const eth = v?.usdBtc && v.ethBtc ? v.usdBtc / v.ethBtc : null, tac = eth && v.mid ? v.mid * eth : null;
  const usd0 = (x, dp = 0) => `$${x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
  const item = (id, name, val, link, title) => (val ? `<${link ? `a href="${link}" title="${title}"` : 'span'} class="px"><svg class="tk" aria-hidden="true"><use href="#tk-${id}"/></svg><b>${name}</b><span class="num">${val}</span></${link ? 'a' : 'span'}>` : '');
  return (tac ? item('tac', 'TAC', usd0(tac, tac < 1 ? 3 : 2), '/trade/tac/', 'Trade TAC') : '') + (v?.usdBtc ? item('cbtc', 'cBTC', usd0(v.usdBtc), '/cbtc/', 'cBTC: locked bitcoin, its backing and pools') : '') + (eth ? item('teth', 'tETH', usd0(eth), '/teth/', 'tETH: private ETH, its pool and farms') : '');
}
export function paintPx(el, v) {
  const out = pxHtml(v);
  if (el.__h !== out) { el.__h = out; el.innerHTML = out; }
  el.classList.toggle('on', !!out);
}

export const pxState = { fresh: false };

const HOSTS = ['https://ethereum-rpc.publicnode.com', 'https://rpc.mevblocker.io', 'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7', 'https://eth.drpc.org'];
async function read() {
  const bodies = PX_CALLS.map(({ to, data }) => strip0x(to).toLowerCase().padStart(64, '0') + word(1) + word(0x60) + word(data.length / 2) + data.padEnd(Math.ceil(data.length / 64) * 64, '0'));
  let off = PX_CALLS.length * 32;
  const heads = bodies.map((b) => { const o = word(off); off += b.length / 2; return o; });
  const input = '0x' + AGGREGATE3 + word(0x20) + word(PX_CALLS.length) + heads.join('') + bodies.join('');
  for (const url of HOSTS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: MULTICALL, data: input }, 'latest'] }), signal: AbortSignal.timeout(8000) });
      const out = strip0x((await r.json()).result || '');
      if (!out) continue;
      const arr = Number(wordAt(out, 0)) / 32;
      return PX_CALLS.map((_, i) => {
        const e = arr + 1 + Number(wordAt(out, arr + 1 + i)) / 32;
        if (wordAt(out, e) !== 1n) return null;
        const b = e + Number(wordAt(out, e + 1)) / 32;
        return '0x' + out.slice(64 * (b + 1), 64 * (b + 1) + Number(wordAt(out, b)) * 2);
      });
    } catch { }
  }
  return null;
}

const whenParsed = (f) => {
  const get = () => document.getElementById('pxs');
  if (get()) return f(get());
  const mo = new MutationObserver(() => { if (get()) { mo.disconnect(); f(get()); } });
  mo.observe(document, { childList: true, subtree: true });
};

if (!window.__tacitAway) {
  try {
    const kept = JSON.parse(localStorage.getItem(PXS_KEY));
    if (kept?.v && Date.now() - kept.at < PXS_MS) whenParsed((el) => paintPx(el, kept.v));
  } catch { }
  read().then((raw) => {
    const v = raw && pxFigures(raw);
    if (!v?.usdBtc || !v.mid) return;
    pxState.fresh = true;
    try { localStorage.setItem(PXS_KEY, JSON.stringify({ at: Date.now(), v })); } catch { }
    whenParsed((el) => paintPx(el, v));
  }).catch(() => {});
}
