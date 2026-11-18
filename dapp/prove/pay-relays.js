// The Pay relays card on the Relay tab: who the relay registry lists (a read of the chain), whether each can be reached through the private route, and, for the
// wallet that owns an entry, what an owner may do: add stake, change the address, leave, and take the stake out once the wait is over. Registering is not here: the
// registry lists the key that sends the call, which is the relay's own key on its server (worker-relay/scripts/register-relay.mjs, docs/RUN-A-PAY-RELAY.md).
//
// ops.js hands in what it already has (its wallet, its sends and its reads): ctx = { $, esc, short, toast, rpc, send, waitReceipt, landed, txLink, S, connect, busy }.

import { calls, readEntries, stateOf, mine, urlProblem, tacText, parseTac, RELAY_REGISTRY } from '/relay-registry-ui.js';
import { verifyDoc } from '/relay-gateway-doc.js';
import { invaderSvg } from '/prove/invader.js';

const GAS = { approve: 70_000n, topUp: 160_000n, startExit: 110_000n, finishExit: 130_000n, setUrl: 170_000n };
const STATE_TEXT = { listed: 'listed', below: 'under the minimum: not shown to wallets', leaving: 'leaving', ready: 'ready to take out' };
// each relay is drawn by its mark (the same zOrgz invader the provers get, picked by its address) and its short address
const faces = new Map();
const face = (a) => {
  if (!faces.has(a)) faces.set(a, `data:image/svg+xml;base64,${btoa(invaderSvg(a, 64))}`);
  return `<img class="inv" src="${faces.get(a)}" width="22" height="22" alt="">`;
};
const day = (s) => new Date(s * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function startPayRelays(ctx, { forwarders = [], fetchImpl = globalThis.fetch?.bind(globalThis), now = () => Math.floor(Date.now() / 1000) } = {}) {
  const { $, esc, short, toast, rpc, send, waitReceipt, landed, txLink, S, connect, busy } = ctx;
  const box = $('#pay-box'), mineBox = $('#pay-mine'), status = $('#pay-status'), cmd = $('#pay-cmd');
  if (!box || !mineBox) return null;
  const raw = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);       // what readEntries calls
  const call = (c) => raw(c.to, c.data);                                      // one of calls.*
  let model = null, arming = null;

  // can a wallet reach this relay through the private route: a forwarder shows its key, signed for by the relayer
  async function routeOf(e) {
    let answered = false;
    for (const fw of forwarders) {
      try {
        const r = await fetchImpl(`${fw}/r/${e.chainId}/${e.relayer}/key`, { cache: 'no-store', signal: AbortSignal.timeout?.(6000) });
        answered = true;
        if (!r.ok) continue;
        const { docs } = await r.json();
        if ((Array.isArray(docs) ? docs : []).some((d) => verifyDoc(d, e.relayer))) return 'yes';
      } catch { /* the next forwarder */ }
    }
    return answered ? 'no' : 'unknown';
  }

  async function load() {
    const [entries, min, delay] = await Promise.all([readEntries({ call: raw }), call(calls.minStake()).then(BigInt), call(calls.unstakeDelay()).then(BigInt)]);
    const t = now();
    const rows = entries.map((e) => ({ ...e, state: stateOf(e, { now: t, minStake: min }), route: 'unknown' }));
    model = { rows, min, delay: Number(delay), at: t };
    paint();
    // the route check is slower than the chain read: filled in as each answers
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => { while (i < rows.length) { const r = rows[i++]; if (r.state === 'listed') { r.route = await routeOf(r); paint(); } } }));
  }

  const who = (a) => `<span class="who">${face(a)}${esc(short(a))}</span>`;
  function paint() {
    if (!model) return;
    const { rows } = model;
    box.innerHTML = rows.length
      ? rows.map((e) => `<div class="kv"><span>${who(e.relayer)}</span><b>${esc(tacText(e.stake))} TAC · ${esc(e.state === 'leaving' ? `leaving, ready ${day(e.exitAt)}` : STATE_TEXT[e.state])}${e.state === 'listed' ? `<small>${e.route === 'yes' ? 'reached through the private route' : e.route === 'no' ? 'no private route key: wallets cannot use it' : 'private route: checking…'}</small>` : ''}</b></div>`).join('')
      : '<p class="plan">No relay is listed yet.</p>';
    box.insertAdjacentHTML?.('beforeend', `<div class="kv"><span>To list one</span><b>${esc(tacText(model.min))} TAC, ${Math.round(model.delay / 86400)}-day wait to leave</b></div>`);
    paintMine();
  }

  // the command to run one: no owner named, so the command makes a fresh address to hold the stake (an owner is public on chain: a connected wallet is not made it)
  const COMMAND = 'git clone https://github.com/src-company/tacit\ncd tacit/worker-relay && npm ci\nnode scripts/pay-relay.mjs --tunnel';
  if (cmd) cmd.textContent = COMMAND;
  const copyBtn = $('#pay-copy');
  copyBtn?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(COMMAND); copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500); } catch { /* the block can be selected by hand */ }
  });
  function paintMine() {
    if (!S.address) { mineBox.hidden = false; mineBox.innerHTML = '<button class="btn ghost" id="pay-connect" type="button">Connect your wallet to manage a relay you listed</button>'; return; }
    const owned = mine(model.rows, S.address);
    mineBox.hidden = false;
    if (!owned.length) { mineBox.innerHTML = `<p class="plan">No relay is listed with ${esc(short(S.address))} as its owner.</p>`; return; }
    mineBox.innerHTML = '<h3 class="plan">Yours</h3>' + owned.map((e) => `<div class="relay" data-id="${e.id}">
      <div class="kv"><span>${who(e.relayer)}</span><b>${esc(tacText(e.stake))} TAC · ${esc(e.state === 'leaving' ? `leaving, ready ${day(e.exitAt)}` : STATE_TEXT[e.state])}</b></div>
      ${e.exitAt === 0 ? `<label class="fld"><span>Add stake (TAC)</span><input data-k="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="${esc(tacText(model.min))}"></label>
      <button class="btn ghost" data-act="topup" type="button">Add stake</button>
      <label class="fld"><span>Relay address</span><input data-k="url" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(e.url)}"></label>
      <button class="btn ghost" data-act="url" type="button">Change address</button>` : ''}
      ${e.state === 'ready' ? '<button class="btn" data-act="finish" type="button">Take the stake out</button>'
        : e.exitAt === 0 ? `<button class="btn ghost" data-act="exit" type="button">Leave: take it off the list and start the ${Math.round(model.delay / 86400)}-day wait</button>`
        : `<p class="plan">The stake can be taken out from ${esc(day(e.exitAt))}.</p>`}
    </div>`).join('');
  }

  const val = (id, k) => mineBox.querySelector(`.relay[data-id="${id}"] [data-k="${k}"]`)?.value ?? '';
  const entry = (id) => model?.rows.find((r) => r.id === Number(id));
  const say = (html) => { status.innerHTML = html; };
  async function run(label, c, gas) {
    const hash = await send({ to: c.to, data: c.data, gas });
    say(`${esc(label)}: sent, waiting for it. ${txLink(hash, 'follow it')}`);
    const rc = await waitReceipt(hash);
    if (!landed(rc)) throw new Error(`${label} did not go through. ${hash}`);
    say(`${esc(label)}: done. ${txLink(hash, 'transaction')}`);
    return hash;
  }

  async function act(btn) {
    const id = Number(btn.closest('.relay')?.dataset.id), act = btn.dataset.act, e = entry(id);
    if (!e || String(e.owner).toLowerCase() !== String(S.address).toLowerCase()) throw new Error('That relay is not owned by the connected wallet.');
    if (act === 'topup') {
      const amount = parseTac(val(id, 'amount'));
      if (!amount || amount <= 0n) throw new Error('Write how much TAC to add, for example 500.');
      const have = BigInt(await call(calls.balanceOf(S.address)));
      if (have < amount) throw new Error(`The wallet holds ${tacText(have)} TAC, not ${tacText(amount)}.`);
      if (BigInt(await call(calls.allowance(S.address))) < amount) await run('Approving the stake', calls.approve(amount), GAS.approve);
      await run('Adding stake', calls.topUp(id, amount), GAS.topUp);
    } else if (act === 'url') {
      const url = val(id, 'url').trim(), bad = urlProblem(url);
      if (bad) throw new Error(bad);
      if (url === e.url) throw new Error('That is the address it has already.');
      await run('Changing the address', calls.setUrl(id, url), GAS.setUrl);
    } else if (act === 'exit') {
      // leaving takes the relay off the list at once: a second press confirms
      if (arming !== id) { arming = id; btn.textContent = 'Press again to leave'; setTimeout(() => { if (arming === id) { arming = null; paintMine(); } }, 6000); return; }
      arming = null;
      await run('Leaving', calls.startExit(id), GAS.startExit);
    } else if (act === 'finish') {
      if (stateOf(e, { now: now(), minStake: model.min }) !== 'ready') throw new Error('The wait is not over yet.');
      await run('Taking the stake out', calls.finishExit(id), GAS.finishExit);
    } else return;
    await load();
  }
  mineBox.addEventListener('click', (ev) => {
    const btn = ev.target?.closest?.('[data-act],#pay-connect');
    if (!btn) return;
    if (btn.id === 'pay-connect') { busy(btn, async () => { await connect(); paintMine(); }); return; }
    busy(btn, () => act(btn));
  });
  globalThis.addEventListener?.('tacit:prove-wallet', () => { if (model) paintMine(); });
  const first = load().catch(() => { box.innerHTML = '<p class="plan">The registry could not be read just now.</p>'; });
  return { load, act, paint, first, get model() { return model; }, RELAY_REGISTRY };
}
