// The Deposit tab's "Through a pool" panel: deposit into the first-generation association-set pool from the Tacit key's
// own pool account, watch each deposit's review, and take an approved one into a fresh Tacit receive address through a
// relayer, with the public exit as the way out of one that is not approved. The account is the pool app's own kind
// (assoc-pool.js), so the same deposits are there under the recovery phrase this panel can show.
//
// The page lends it its helpers, its Ethereum RPC and the next unused receive address; everything else is here.
//   ctx = { html, mount, copy, toast, fmt, parseUnits, short, amountField, ethIcon, tacitPriv (32 bytes), rpc,
//           wallet() → { address, send(tx) } | null, fresh(avoid: Set of addresses) → { index, address } | null, arrived(index),
//           makeWorker() → the prover Worker, store { get, set }, explorer, appUrl }

import { secp, keccak_256, sha256, hmac } from './vendor/tacit-deps.min.js';
import { poseidon1, poseidon2, poseidon3 } from './vendor/tacit-poseidon.min.js';
import { makeEvmTx } from './evm-tx.js';
import { makeAssocPool, CIRCUITS } from './assoc-pool.js';
import { makeAssocNet } from './assoc-pool-net.js';
import { makeAssocSession } from './assoc-pool-session.js';

const CACHE = 'tacit-assoc-pool-v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexOf = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const STATUS = { reviewing: 'Reviewing', approved: 'Approved', declined: 'Not approved', emptied: 'Taken in', exited: 'Exited', unreadable: 'Unreadable', foreign: 'Moved' };

export function makeAssocPanel(ctx) {
  const { html, mount, copy, toast, fmt, parseUnits, short, amountField, rpc } = ctx;
  const eth = (v) => fmt(v, 18, 6);
  const pool = makeAssocPool({ secp, keccak256: keccak_256, sha256, hmac, poseidon1, poseidon2, poseidon3 });
  const net = makeAssocNet({ rpc });
  const evmTx = makeEvmTx({ secp, keccak256: keccak_256 });
  const key = pool.poolKey(ctx.tacitPriv);
  const storeKey = `tacit-assoc-takes-v1:${key.address}`;
  const hex = (n) => '0x' + BigInt(n).toString(16);

  // ──────────────────── sending and proving ────────────────────

  async function receiptOf(hash) {
    for (let i = 0; i < 240; i++) { const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null); if (r) return r; await sleep(2500); }
    throw new Error('Sent, not confirmed yet. Check the transaction before sending anything again.');
  }
  // A transaction from the pool key: signed here, sent raw.
  async function sendFromKey({ to, data, value = 0n }) {
    const tx = { from: key.address, to, data, value: hex(value) };
    const [bal, nonce, block, tip] = await Promise.all([
      rpc('eth_getBalance', [key.address, 'latest']).then(BigInt), rpc('eth_getTransactionCount', [key.address, 'pending']).then(BigInt),
      rpc('eth_getBlockByNumber', ['latest', false]), rpc('eth_maxPriorityFeePerGas', []).then(BigInt).catch(() => 0n),
    ]);
    const gas = (BigInt(await rpc('eth_estimateGas', [tx]).catch(() => { throw new Error(bal < value ? `Your pool key holds ${eth(bal)} ETH. Send it more first.` : 'The network refused this transaction.'); })) * 6n) / 5n;
    const prio = !tip ? 10n ** 8n : tip < 15n * 10n ** 8n ? tip : 15n * 10n ** 8n, maxFee = BigInt(block.baseFeePerGas) * 2n + prio;
    if (bal < value + gas * maxFee) throw new Error(`Your pool key holds ${eth(bal)} ETH; this needs about ${eth(value + gas * maxFee)}. Send it more first.`);
    const { raw } = evmTx.signEip1559({ chainId: 1n, nonce, maxPriorityFeePerGas: prio, maxFeePerGas: maxFee, gasLimit: gas, to, value, data }, key.priv);
    const hash = await rpc('eth_sendRawTransaction', [raw]);
    return receiptOf(hash);
  }
  async function sendFromWallet({ to, data, value = 0n }) {
    const w = ctx.wallet();
    if (!w) throw new Error('Connect a wallet first.');
    const hash = await w.send({ to, data, value: hex(value) });
    return receiptOf(hash);
  }

  async function artifact(file, sha, onBytes) {
    const url = (ctx.artifactBase || CIRCUITS.base) + file, ck = `${url}?sha256=${sha}`;
    let cache = null; try { cache = await caches.open(CACHE); } catch {}
    const hit = cache ? await cache.match(ck).catch(() => null) : null;
    let bytes;
    if (hit) { bytes = new Uint8Array(await hit.arrayBuffer()); onBytes(bytes.length); }
    else {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
      const reader = r.body.getReader(), parts = []; let got = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onBytes(value.length); }
      bytes = new Uint8Array(got); let o = 0; for (const c of parts) { bytes.set(c, o); o += c.length; }
    }
    if (hexOf(await crypto.subtle.digest('SHA-256', bytes)) !== sha) { if (hit) await cache.delete(ck).catch(() => {}); throw new Error(`${file} does not match its pinned hash`); }
    if (!hit && cache) await cache.put(ck, new Response(bytes)).catch(() => {});
    return bytes;
  }
  let worker = null, wid = 0;
  const waiting = new Map(), ready = new Set();
  const wcall = (msg, ms, transfer = []) => new Promise((resolve, reject) => {
    if (!worker) {
      worker = ctx.makeWorker();
      let up = false;   // an error before the worker has answered once is its script not loading, not a proof running out of memory
      worker.onmessage = ({ data }) => { up = true; const w = waiting.get(data.id); if (!w) return; waiting.delete(data.id); data.ok ? w.resolve(data) : w.reject(new Error(data.error)); };
      worker.onerror = (e) => { e.preventDefault?.(); for (const w of waiting.values()) w.reject(new Error(up ? 'Proving stopped on this device, likely short of memory. Close other tabs and try again.' : 'The prover could not start in this browser. Try again.')); waiting.clear(); worker?.terminate(); worker = null; ready.clear(); };
    }
    const id = ++wid, t = setTimeout(() => { waiting.delete(id); reject(new Error('Proving is taking too long on this device. Try again.')); }, ms);
    waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    worker.postMessage({ ...msg, id }, transfer);
  });
  async function circuit(name, onBytes) {
    if (ready.has(name)) return;
    const p = CIRCUITS[name];
    const [vk, wasm, zkey] = await Promise.all([artifact(p.vkey.file, p.vkey.sha256, () => {}), artifact(p.wasm.file, p.wasm.sha256, onBytes), artifact(p.zkey.file, p.zkey.sha256, onBytes)]);
    await wcall({ op: 'init', circuit: name, wasm, zkey, vk: JSON.parse(new TextDecoder().decode(vk)) }, 5 * 60e3, [wasm.buffer, zkey.buffer]);
    ready.add(name);
  }
  let note = (m) => {};
  const prover = {
    async withdraw(args) { await circuit('withdraw', (n) => note('files', n)); const r = await wcall({ op: 'withdraw', ...args }, 10 * 60e3); return { plan: r.plan, proof: r.proof, publicSignals: r.publicSignals }; },
    async exit(args) { await circuit('commitment', (n) => note('files', n)); const r = await wcall({ op: 'exit', ...args }, 10 * 60e3); return { expect: r.expect, proof: r.proof, publicSignals: r.publicSignals }; },
  };
  const session = makeAssocSession({
    pool, net, rpc, tacitPriv: ctx.tacitPriv, prover, keccak256: keccak_256,
    sender: { key: sendFromKey, wallet: sendFromWallet, walletAddress: async () => ctx.wallet()?.address },
  });

  // ──────────────────── state ────────────────────

  const S = { phase: 'idle', err: null, notes: [], keyBal: 0n, head: 0, terms: { minDeposit: 10n ** 16n, vettingBps: 50n }, busy: null, status: null, open: null, quote: null, sure: null, phrase: null, takes: ctx.store ? (() => { try { return JSON.parse(ctx.store.get(storeKey) || '[]'); } catch { return []; } })() : [] };
  let host = null, timer = 0, poll = 0, quoteTimer = 0, got = 0;
  const saveTakes = () => ctx.store?.set(storeKey, JSON.stringify(S.takes.slice(-5)));
  // Addresses a take-in went to lately: never offered again, while the page's own list of used addresses catches up.
  const recentTo = () => new Set(S.takes.filter((t) => Date.now() - t.at < 6 * 3600e3).map((t) => String(t.to).toLowerCase()));
  const say = (view) => { S.status = view; const el = host?.querySelector('#p-status'); if (el) mount(el, view || html``); };
  const age = (block) => { const s = Math.max(0, (S.head - block) * 12); return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };
  const errText = (e) => String(e?.message || e || 'Something went wrong').replace(/^Error:\s*/, '').replace(/\brelayer/gi, 'relay').replace(/^[a-z]/, (c) => c.toUpperCase());

  async function refresh({ full = false, quiet = false } = {}) {
    if (!quiet) { S.phase = S.notes.length ? S.phase : 'loading'; S.err = null; paint(); }
    try {
      const [notes, bal, head, terms] = await Promise.all([session.load({ full }), rpc('eth_getBalance', [key.address, 'latest']).then(BigInt), rpc('eth_blockNumber', []).then((x) => Number(BigInt(x))), session.config()]);
      Object.assign(S, { notes, keyBal: bal, head, terms, phase: 'ready', err: null });
    } catch (e) { if (!quiet || !S.notes.length) Object.assign(S, { phase: S.notes.length ? 'ready' : 'error', err: errText(e) }); }
    paint();
  }

  // ──────────────────── view ────────────────────

  const chip = (n) => html`<span class="chip ${n.status === 'approved' ? 'go' : ''}">${STATUS[n.status] || n.status}</span>`;
  const takeSheet = (n) => {
    const q = S.quote?.label === n.label ? S.quote : null, to = ctx.fresh(recentTo());
    return html`<div class="pn-sheet">
      ${amountField('p-take', 'Take in', html`<button class="link" type="button" id="p-max">Max ${eth(n.balance)}</button>`)}
      ${q?.err ? html`<p class="note err">${q.err}</p>` : q?.q ? html`
        <div class="kv"><span>Relay fee</span><b class="num">${eth(q.q.feeWei)} ETH · ${(Number(q.q.bps) / 100).toFixed(2)}%</b></div>
        <div class="kv"><span>You receive</span><b class="num">${eth(q.q.receive)} ETH</b></div>` : html`<p class="note mute">${q ? 'Reading the relay’s fee…' : 'Enter an amount.'}</p>`}
      <div class="kv"><span>Into</span><b class="num">${to ? html`your fresh address ${short(to.address, 6)}` : 'preparing your fresh address…'}</b></div>
      <button class="btn" type="button" id="p-go" ${!q?.q || !to ? 'disabled' : ''}>Take it in privately</button>
      <p class="note">From there the relay moves it into your private balance, usually within minutes. Nothing on chain ties it to this deposit. Points go to the address that sent the ETH, so a take-in earns none.</p>
    </div>`;
  };
  const row = (n) => html`<div class="pn" data-label="${n.label}">
    <div class="kv"><span>${eth(n.balance)} ETH ${chip(n)}</span><b class="num">${n.balance !== n.deposited ? `of ${eth(n.deposited)} · ` : ''}${age(n.block)}</b></div>
    ${n.status === 'reviewing' ? html`<p class="note">The pool reviews each deposit before it can be taken in. This usually takes hours, sometimes days.</p>` : ''}
    ${n.status === 'declined' ? html`<p class="note warn">The pool did not approve this deposit. You can exit it publicly to the address that made it.</p>` : ''}
    ${n.status === 'unreadable' ? html`<p class="note warn">The pool’s history could not be read completely, so this deposit is not offered. Refresh in a moment.</p>` : ''}
    ${(n.status === 'approved' || n.status === 'reviewing' || n.status === 'declined') ? html`<div class="pn-acts">
      ${n.status === 'approved' ? html`<button class="btn sm" type="button" data-take="${n.label}" ${S.busy ? 'disabled' : ''}>${S.open === String(n.label) ? 'Close' : 'Take in'}</button>` : ''}
      ${S.sure === String(n.label)
        ? html`<span class="note">Returns ${eth(n.balance)} ETH to ${short(n.depositor, 4)} and shows the link. <button class="link" type="button" data-exit-go="${n.label}">Exit</button> · <button class="link" type="button" data-exit-no="1">cancel</button></span>`
        : html`<button class="link" type="button" data-exit="${n.label}" ${S.busy ? 'disabled' : ''}>Exit publicly</button>`}
    </div>` : ''}
    ${S.open === String(n.label) ? takeSheet(n) : ''}
  </div>`;

  const view = () => {
    const w = ctx.wallet();
    const mine = S.notes.filter((n) => n.status !== 'foreign');
    return html`
      <div class="blk"><div class="lbl"><span>Through a pool<a class="mk" href="${ctx.appUrl}" target="_blank" rel="noopener" aria-label="Privacy Pools" title="Privacy Pools"><svg aria-hidden="true"><use href="#i-pp"/></svg></a></span><span><span class="cs"><svg class="tk xs" role="img" aria-label="Ethereum"><title>Ethereum</title><use href="#c-eth"/></svg></span> · approval takes a while</span></div>
        <p class="note lead">Deposit into the pool, wait for its approval, then take it into your private balance. Nothing links the two once it is taken in.</p></div>
      <div class="blk"><div class="lbl"><span>Your pool key</span><span>pays your deposits</span></div>
        <div class="addr"><code>${key.address}</code><button class="link" type="button" data-copy="${key.address}">copy</button></div>
        <p class="note">It holds <b class="num">${eth(S.keyBal)}</b> ETH. Send it ETH to deposit from here${w ? ', or deposit from your wallet' : ''}.</p></div>
      <div class="blk">
        ${amountField('p-amt', 'Deposit')}
        <p class="note">At least ${eth(S.terms.minDeposit)} ETH. The pool keeps ${Number(S.terms.vettingBps) / 100}% when it takes a deposit in.</p>
        <div class="${w ? 'row2' : ''}"><button class="btn" type="button" id="p-dep" ${S.busy ? 'disabled' : ''}>Deposit</button>${w ? html`<button class="btn ghost" type="button" id="p-depw" ${S.busy ? 'disabled' : ''}>From my wallet</button>` : ''}</div>
      </div>
      <p class="note" id="p-status" role="status">${S.status || ''}</p>
      <div class="blk"><div class="lbl"><span>Your deposits</span><span><button class="link" type="button" id="p-refresh" ${S.busy ? 'disabled' : ''}>refresh</button></span></div>
        ${S.phase === 'loading' ? html`<p class="note"><span class="spin" aria-hidden="true"></span> Reading your pool account…</p>`
          : S.phase === 'error' ? html`<p class="note err">${S.err}</p>`
          : !mine.length ? html`<p class="note mute">None yet.</p>` : mine.map(row)}
        ${S.takes.length ? html`<div class="note mute">${S.takes.slice(-3).reverse().map((t) => html`<div>Took in ${eth(BigInt(t.amount))} ETH · <a href="${ctx.explorer}/tx/${t.tx}" target="_blank" rel="noopener">${short(t.tx, 6)} ↗</a></div>`)}</div>` : ''}
      </div>
      <div class="blk"><div class="lbl"><span>See them in the pool’s own app</span><span><a href="${ctx.appUrl}" target="_blank" rel="noopener">open ↗</a></span></div>
        <p class="note">Paste your recovery phrase into “Load account” there. It controls these deposits: keep it private.</p>
        ${S.phrase ? html`<div class="addr"><code>${S.phrase}</code><button class="link" type="button" data-copy="${S.phrase}">copy</button></div><p class="more"><button class="link" type="button" id="p-hide">Hide</button></p>`
          : html`<p class="more"><button class="link" type="button" id="p-show">Show recovery phrase</button> · <button class="link" type="button" id="p-full" ${S.busy ? 'disabled' : ''}>Search every deposit</button></p>`}
      </div>`;
  };

  function paint() {
    if (!host) return;
    const keepAmt = host.querySelector('#p-amt')?.value, keepTake = host.querySelector('#p-take')?.value;
    const on = document.activeElement && host.contains(document.activeElement) && document.activeElement.id ? document.activeElement : null;
    const at = on?.selectionStart != null ? [on.selectionStart, on.selectionEnd] : null;
    mount(host, view());
    const a = host.querySelector('#p-amt'); if (a && keepAmt) a.value = keepAmt;
    const t = host.querySelector('#p-take'); if (t && keepTake) t.value = keepTake;
    if (on) { const again = host.querySelector('#' + on.id); if (again) { again.focus({ preventScroll: true }); if (at) try { again.setSelectionRange(...at); } catch {} } }
    bind();
  }

  // ──────────────────── actions ────────────────────

  const wrap = (label, fn) => async () => {
    if (S.busy) return;
    S.busy = label; say(html`<span class="spin" aria-hidden="true"></span> Working…`); paint();
    try { await fn(); } catch (e) { console.error('pool panel:', e?.stack || e); say(html`<span class="err">${errText(e)}</span>`); }
    finally { S.busy = null; await refresh({ quiet: true }); }
  };
  const progress = (word) => (s) => { got = 0; say(html`<span class="spin" aria-hidden="true"></span> ${({ lists: 'Reading the pool’s lists…', proving: `Proving on this device${word}…`, sending: 'Sending it through a relay…', waiting: 'Waiting for the block…' })[s] || s}`); };
  note = (k, n) => { if (k !== 'files') return; got += n; const t = Math.min(99, Math.round((got / 24e6) * 100)); say(html`<span class="spin" aria-hidden="true"></span> Getting the pool’s proving files once · ${t}%`); };

  async function doDeposit(from) {
    const el = host.querySelector('#p-amt'), amt = parseUnits(el.value);
    if (amt == null || amt < S.terms.minDeposit) throw new Error(`The pool takes at least ${eth(S.terms.minDeposit)} ETH.`);
    const r = await session.deposit({ amount: amt, from });
    el.value = '';
    toast('Deposited. The pool reviews it before you can take it in.');
    say(html`<span class="ok">Deposited ${eth(r.value)} ETH.</span> The pool reviews it now.`);
  }
  async function doTake(label) {
    const n = S.notes.find((x) => String(x.label) === String(label));
    const el = host.querySelector('#p-take'), amt = parseUnits(el.value), to = ctx.fresh(recentTo());
    if (!n || amt == null || amt <= 0n || amt > n.balance) throw new Error('Enter an amount within the deposit.');
    if (!to) throw new Error('Your fresh address is not ready yet. Try again in a moment.');
    const r = await session.withdraw({ note: n, amount: amt, recipient: to.address, onStep: progress(' · about 10 seconds') });
    // The funds are on their way: nothing after this point may report a failure.
    S.takes.push({ tx: r.tx, amount: r.received.toString(), to: to.address, at: Date.now() });
    try { saveTakes(); ctx.arrived?.(to.index); } catch {}
    S.open = null; S.quote = null;
    toast('Taken in. It reaches your private balance in a few minutes.');
    say(html`<span class="ok">Sent ${eth(r.received)} ETH to your fresh address.</span> The relay moves it into your private balance in a few minutes. <a href="${ctx.explorer}/tx/${r.tx}" target="_blank" rel="noopener">${short(r.tx, 6)} ↗</a>`);
  }
  async function doExit(label) {
    const n = S.notes.find((x) => String(x.label) === String(label));
    if (!n) return;
    S.sure = null;
    const r = await session.exit({ note: n, onStep: progress('') });
    toast('Exited. The funds are back at the address that made the deposit.');
    say(html`<span class="ok">Exited ${eth(r.value)} ETH</span> to the address that made the deposit. <a href="${ctx.explorer}/tx/${r.tx}" target="_blank" rel="noopener">${short(r.tx, 6)} ↗</a>`);
  }
  function quoteSoon(label) {
    clearTimeout(quoteTimer);
    const n = S.notes.find((x) => String(x.label) === String(label)), el = host?.querySelector('#p-take');
    if (!n || !el) return;
    const amt = parseUnits(el.value);
    if (amt == null || amt <= 0n || amt > n.balance) { S.quote = null; patchSheet(n); return; }
    S.quote = { label: n.label, amt, q: null };
    patchSheet(n);
    quoteTimer = setTimeout(async () => {
      try {
        const q = await session.quote(amt);
        if (S.quote?.amt !== amt) return;
        S.quote = q.relayable ? { label: n.label, amt, q } : { label: n.label, amt, err: `Too small to relay at today’s network fee: take in at least ${eth(q.minWei ?? 0n)} ETH.` };
      } catch (e) { S.quote = { label: n.label, amt, err: errText(e) }; }
      patchSheet(n);
    }, 350);
  }
  function patchSheet(n) {
    const el = host?.querySelector(`.pn[data-label="${n.label}"] .pn-sheet`);
    if (!el) return paint();
    const keep = el.querySelector('#p-take')?.value;
    el.outerHTML = takeSheet(n).s;
    const t = host.querySelector('#p-take'); if (t) { t.value = keep || ''; t.focus({ preventScroll: true }); }
    bindSheet(n);
  }
  function bindSheet(n) {
    host.querySelector('#p-take')?.addEventListener('input', () => quoteSoon(n.label));
    host.querySelector('#p-max')?.addEventListener('click', () => { const t = host.querySelector('#p-take'); t.value = fmt(n.balance, 18, 18).replace(/,/g, ''); quoteSoon(n.label); });
    host.querySelector('#p-go')?.addEventListener('click', wrap(`take:${n.label}`, () => doTake(n.label)));
  }
  function bind() {
    host.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => copy(b.dataset.copy); });
    host.querySelector('#p-dep')?.addEventListener('click', wrap('deposit', () => doDeposit('key')));
    host.querySelector('#p-depw')?.addEventListener('click', wrap('deposit', () => doDeposit('wallet')));
    host.querySelector('#p-refresh')?.addEventListener('click', () => refresh());
    host.querySelector('#p-full')?.addEventListener('click', wrap('full', async () => { say(html`<span class="spin" aria-hidden="true"></span> Reading every deposit in the pool…`); await refresh({ full: true, quiet: true }); say(html`<span class="ok">Searched every deposit.</span>`); }));
    host.querySelector('#p-show')?.addEventListener('click', async () => { S.phrase = await session.phrase(); clearTimeout(timer); timer = setTimeout(() => { S.phrase = null; paint(); }, 60e3); paint(); });
    host.querySelector('#p-hide')?.addEventListener('click', () => { S.phrase = null; clearTimeout(timer); paint(); });
    host.querySelectorAll('[data-take]').forEach((b) => b.addEventListener('click', () => {
      const lab = b.dataset.take;
      S.open = S.open === lab ? null : lab; S.quote = null; S.sure = null; paint();
      if (S.open) { const t = host.querySelector('#p-take'); const n = S.notes.find((x) => String(x.label) === lab); if (t && n) { t.value = fmt(n.balance, 18, 18).replace(/,/g, ''); quoteSoon(lab); } }
    }));
    host.querySelectorAll('[data-exit]').forEach((b) => b.addEventListener('click', () => { S.sure = b.dataset.exit; S.open = null; paint(); }));
    host.querySelector('[data-exit-no]')?.addEventListener('click', () => { S.sure = null; paint(); });
    host.querySelectorAll('[data-exit-go]').forEach((b) => b.addEventListener('click', wrap(`exit:${b.dataset.exitGo}`, () => doExit(b.dataset.exitGo))));
    const open = S.notes.find((x) => String(x.label) === S.open);
    if (open) bindSheet(open);
  }

  return {
    // Draw into `el` (the page redraws its form often; the account is read once and kept).
    attach(el) {
      host = el; paint();
      if (S.phase === 'idle') refresh();
      clearInterval(poll);
      poll = setInterval(() => { if (host?.isConnected && !S.busy && document.visibilityState === 'visible' && S.notes.some((n) => n.status === 'reviewing')) refresh({ quiet: true }); }, 60e3);
    },
    repaint() { if (host?.isConnected) paint(); },
    detach() { host = null; clearInterval(poll); },
    destroy() { clearInterval(poll); clearTimeout(timer); worker?.terminate(); worker = null; host = null; },
    key,
  };
}
