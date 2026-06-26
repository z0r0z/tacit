// Shared cross-chain "lane" component — the single abstraction behind every "one note, two chains"
// surface. Mounted by both the shielded-pool tab (the canonical cross-chain DeFi surface) and the
// legacy tETH bridge modal, so the two read as one system instead of two parallel bridges.
//
// The component owns the visual chrome only (chain framing, lane grouping, action heads); each caller
// supplies the inner control markup as a `body` HTML string and keeps its own element IDs + wiring.
// That keeps existing flows intact while unifying how cross-chain value is presented everywhere.

const CHAINS = {
  eth: { label: 'Ethereum', cls: 'eth' },
  btc: { label: 'Bitcoin', cls: 'btc' },
  both: { label: 'one note', cls: 'both' },
};

// A chain badge (dot + label), reusing the site's .chain-badge tokens.
export function chainBadge(key, label) {
  const c = CHAINS[key] || CHAINS.both;
  return `<span class="chain-badge ${c.cls}"><span class="dot"></span>${label || c.label}</span>`;
}

// The "₿ ⇄ Ξ · one note" header that frames a lane panel.
export function laneHeader({ left = 'btc', right = 'eth', note = 'one note' } = {}) {
  return `<div class="xchain-header">`
    + chainBadge(left)
    + `<span class="xchain-arrow" aria-hidden="true">⇄</span>`
    + chainBadge(right)
    + (note ? `<span class="xchain-note">· ${note}</span>` : '')
    + `</div>`;
}

const DIR_GLYPH = { in: '↓ in', out: '↑ out', over: '⇄ cross' };

function renderAction(a) {
  // Headless action: a raw body with no title head. Used when the body already
  // carries its own affordance (e.g. the bridge modal's relocated option cards).
  if (!a.title) return `<div class="lane-action">${a.body || ''}</div>`;
  const dir = a.dir ? `<span class="lane-action-dir dir-${a.dir}">${DIR_GLYPH[a.dir] || a.dir}</span>` : '';
  const meta = a.meta ? `<span class="lane-action-meta">· ${a.meta}</span>` : '';
  return `<div class="lane-action">`
    + `<div class="lane-action-head"><span class="lane-action-title">${a.title}</span>${dir}${meta}</div>`
    + `<div class="lane-action-body">${a.body || ''}</div>`
    + `</div>`;
}

function renderLane(lane) {
  const legacy = lane.legacy ? ' lane-legacy' : '';
  const badge = chainBadge(lane.key, lane.label);
  const actions = (lane.actions || []).map(renderAction).join('');
  return `<div class="lane${legacy}">`
    + `<div class="lane-title">${badge}</div>`
    + (lane.blurb ? `<div class="muted" style="font-size:11px;margin-bottom:6px;">${lane.blurb}</div>` : '')
    + actions
    + `</div>`;
}

// Full lane panel. `intro` is optional concept HTML (e.g. a .note-concept block), `header` toggles the
// ⇄ chain header, `lanes` is the ordered list of lane descriptors, `footer` is optional escape-hatch
// HTML (e.g. a "redeem legacy notes" link). Returns one HTML string the caller drops into a container.
//
// lane:   { key:'eth'|'btc', label?, blurb?, legacy?, actions:[…] }
// action: { title, dir?:'in'|'out'|'over', meta?, body }  // body carries the caller's wired controls
export function renderLanePanel({ intro = '', header = true, lanes = [], footer = '' } = {}) {
  return `<div class="tab-form">`
    + (intro || '')
    + (header ? laneHeader() : '')
    + lanes.map(renderLane).join('')
    + (footer ? `<div class="xchain-footer">${footer}</div>` : '')
    + `</div>`;
}
