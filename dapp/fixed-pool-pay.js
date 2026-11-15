// The large-pool part of the Pay page's Deposit tab (Ethereum, off until the page is opened with ?fixed=1).
//
// Two cards under the deposit form:
//   - an amount from a whole note up goes into the large pools in whole notes (the pool takes only those sizes) and
//     what is left stays for the form above, which deposits it as it always does;
//   - the notes in those pools: found again from the wallet, and moved into the Tacit balance (the withdrawal pays the
//     user's own deposit address, its gas paid from the note) or withdrawn to any address.
//
// The page hands in what it owns (`env`): its node, the wallet, the user's deposit address, its busy/status wrapper and
// the amount field. Notes are never kept: only where a note is (nonce, pool) and what it is called on chain, since its
// secrets come from signing the nonce again.

import { planSplit, FIXED_POOLS, DEFAULT_MIN_DENOMINATION, DEFAULT_MAX_NOTES, commitmentBytes32, parseNoteString } from '/fixed-pool-notes.js?cb=ab06e6d2';
import { makeFlow, parseEther, formatEther } from '/fixed-pool-flow.js?cb=0f50365d';
import { workerProver } from '/fixed-pool-prover.js?cb=307cfddc';
import { PAYMASTERS } from '/fixed-pool-paymaster.js?cb=40893745';
import { depositAddressOfName, signBox } from '/fixed-pool-box.js?cb=a2192b2d';
import { keccak_256 } from './vendor/tacit-deps.min.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const WALLET_METHODS = new Set(['eth_signTypedData_v4', 'eth_sendTransaction', 'wallet_sendCalls', 'wallet_getCallsStatus', 'wallet_getCapabilities']);
const SMALLEST = [{ wei: DEFAULT_MIN_DENOMINATION, label: '1 ETH' }, { wei: 10n ** 17n, label: '0.1 ETH' }];

// A mixed-case address must carry its checksum (EIP-55); an all-lowercase one is taken as typed.
export function checksumOk(address) {
  const hex = address.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  const h = [...keccak_256(new TextEncoder().encode(hex.toLowerCase()))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return [...hex].every((c, i) => !/[a-f]/i.test(c) || (parseInt(h[i], 16) >= 8) === (c === c.toUpperCase()));
}

// What the flow needs of a provider: reads go to the page's own node, and only the wallet's own methods go to the wallet.
export function composeProvider({ read, wallet }) {
  return {
    async request({ method, params = [] }) {
      if (WALLET_METHODS.has(method)) {
        const w = wallet();
        if (!w) throw new Error('Connect your wallet first.');
        return w.request({ method, params });
      }
      return (await read())(method, params);
    },
  };
}

const keyOf = (chainId, account) => `tacit-fixed-notes:${chainId}:${String(account).toLowerCase()}`;
export function readNotes(store, chainId, account) {
  try { const v = JSON.parse(store.get(keyOf(chainId, account)) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function writeNotes(store, chainId, account, list) {
  const seen = new Set(), out = [];
  for (const n of list) { const k = `${n.pool.toLowerCase()}:${n.nonce}`; if (!seen.has(k)) { seen.add(k); out.push(n); } }
  try { store.set(keyOf(chainId, account), JSON.stringify(out)); } catch { /* a convenience: Find brings them back */ }
  return out;
}
// What is kept of a note: where it is and what it is called on chain. None of it opens the note.
export const metaOf = (n) => ({ nonce: n.nonce, pool: n.pool.address ?? n.pool, c: commitmentBytes32(n.secrets.commitment), nh: commitmentBytes32(n.secrets.nullifierHash) });

export function attach(env) {
  const { host, notesHost } = env;
  const chainId = env.chain.chainId;
  const provider = composeProvider({ read: env.read, wallet: env.walletProvider });
  const flowFor = () => makeFlow({ provider, account: env.account(), chainId, store: env.store, poll: 3000, timeout: 10 * 60 * 1000 });
  const reader = makeFlow({ provider, account: null, chainId, poll: 3000 });
  const st = { smallest: DEFAULT_MIN_DENOMINATION, notes: [], spent: new Map(), open: null, confirm: null, target: null };
  const looksLikeName = (x) => /^[^\s]+\.(g?wei|eth)$/i.test(x);
  // empty: the user's own deposit address; a name: the deposit address it publishes, checked against its own key; else an address
  async function resolveTarget(raw) {
    if (!raw) {
      const to = await env.depositAddress();
      if (!to) throw new Error('Open your private balance first.');
      return { to, label: 'your deposit address' };
    }
    if (looksLikeName(raw)) {
      const r = await depositAddressOfName(await env.names(), raw.toLowerCase());
      return { to: r.box, label: `${r.name}'s deposit address` };
    }
    return { to: raw, label: short(raw) };
  }
  // what the "Send to" fields take: an address (checked here) or a name (looked up and checked when it is sent)
  const addressProblem = (to) => {
    if (looksLikeName(to)) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(to) || /^0x0{40}$/.test(to)) return 'Enter the address that should receive it, or a name.';
    if (!checksumOk(to)) return 'That address\'s capitalization does not match its checksum. Check it.';
    return null;
  };

  // ---- card one: the split ----
  const plan = () => {
    const wei = parseEther(env.amountInput.value);
    if (!wei) return null;
    return { wei, ...planSplit(wei, chainId, { minDenominationWei: st.smallest, maxNotes: DEFAULT_MAX_NOTES }) };
  };
  function paintSplit() {
    const p = plan();
    if (!p || !p.notes.length) { host.innerHTML = ''; return; }
    const rows = p.notes.map((n) => `<div class="kv"><span>${n.count} × ${formatEther(n.denomination)} ETH</span><b>whole notes, large pool</b></div>`).join('');
    host.innerHTML = `<div class="blk" style="margin-top:22px;padding-top:14px;border-top:1px solid var(--hair)">
      <div class="lbl"><span>Large amount</span><span><label>Smallest note <select id="lg-min" aria-label="Smallest note">${SMALLEST.map((s) => `<option value="${s.wei}"${s.wei === st.smallest ? ' selected' : ''}>${s.label}</option>`).join('')}</select></label></span></div>
      ${rows}
      <div class="kv"><span>${p.remainder === 0n ? 'Nothing' : esc(formatEther(p.remainder)) + ' ETH'}</span><b>${p.remainder === 0n ? 'left for the deposit above' : 'stays for the deposit above'}</b></div>
      <button class="btn ghost" type="button" id="lg-go">${env.account() ? `Deposit ${p.noteCount} whole ${p.noteCount === 1 ? 'note' : 'notes'}` : 'Connect wallet'}</button>
      <p class="note">The notes go to the large pools from your wallet; the note numbers come from your wallet's signature, so they can be found again with it. The deposit above then takes what is left.</p>
    </div>`;
    host.querySelector('#lg-min').onchange = (e) => { st.smallest = BigInt(e.target.value); paintSplit(); };
    host.querySelector('#lg-go').onclick = (e) => depositNotes(e.currentTarget, p);
  }

  async function depositNotes(btn, p) {
    if (!env.account()) return env.connect().catch((e) => env.toast(env.errText(e), true));
    return env.act(btn, async (step, c) => {
      await env.ensureChain(c);
      const need = p.notes.reduce((s, n) => s + n.denomination * BigInt(n.count), 0n);
      const bal = BigInt(await (await env.read())('eth_getBalance', [env.account(), 'latest']));
      if (bal < need) throw new Error(`Your wallet holds ${formatEther(bal)} ETH on ${c.full}, less than the ${formatEther(need)} ETH of notes.`);
      const out = await flowFor().deposit(p, {
        onStep: (s) => step(s.step === 'find' ? 'looking for the next free note number' : s.step === 'sign' ? `sign for note ${s.i + 1} of ${s.of}` : s.step === 'send' ? 'confirm the deposits in your wallet' : `deposit ${s.i} of ${s.of} confirmed`),
      });
      writeNotes(env.store, chainId, env.account(), [...readNotes(env.store, chainId, env.account()), ...out.notes.map(metaOf)]);
      env.setAmount(p.remainder);
      env.say(`${out.notes.length === 1 ? 'The note is' : 'The notes are'} in the large ${out.notes.length === 1 ? 'pool' : 'pools'}. ${p.remainder > 0n ? `The amount above is now what is left, ${formatEther(p.remainder)} ETH.` : ''}`);
      loadNotes();
    });
  }

  // ---- card two: the notes ----
  const poolOf = (addr) => FIXED_POOLS[chainId]?.find((x) => x.address.toLowerCase() === addr.toLowerCase());
  async function loadNotes() {
    const account = env.account();
    st.notes = account ? readNotes(env.store, chainId, account) : [];
    paintNotes();
    for (const n of st.notes) {
      const pool = poolOf(n.pool);
      if (!pool || n.nh == null) continue;
      reader.spent(pool, BigInt(n.nh)).then((v) => { st.spent.set(n.nh, v); if (notesHost.isConnected) paintNotes(); }, () => {});
    }
  }
  function paintNotes() {
    const account = env.account();
    const rows = st.notes.map((n, i) => {
      const pool = poolOf(n.pool), gone = st.spent.get(n.nh);
      return `<div class="kv"><span>${pool ? formatEther(pool.denomination) : '?'} ETH <span class="mute">· note ${n.nonce}${gone ? ' · spent' : ''}</span></span>
        <b>${gone ? '' : `<button class="link" type="button" data-move="${i}">Move into Tacit</button> <button class="link" type="button" data-out="${i}">Withdraw</button>`}</b></div>`;
    }).join('');
    notesHost.innerHTML = `<div class="blk" style="margin-top:22px;padding-top:14px;border-top:1px solid var(--hair)">
      <div class="lbl"><span>Notes in the large pools</span><span><button class="link" type="button" id="lg-find">${account ? 'Find' : 'Connect wallet'}</button> · <button class="link" type="button" id="lg-paste">Paste a note</button></span></div>
      ${rows || '<p class="note">None found in this browser. Find looks through this wallet\'s deposits and asks for a signature for each number it tries. A note from anywhere else can be pasted.</p>'}
      <div id="lg-ask" hidden></div>
      <p class="note">If paying the gas from a note is not available, these notes follow <a href="https://github.com/ethereum/kohaku" target="_blank" rel="noopener noreferrer">Kohaku</a>'s format, so it can withdraw them too.</p>
    </div>`;
    notesHost.querySelector('#lg-find').onclick = () => (account ? find(notesHost.querySelector('#lg-find')) : env.connect().then(loadNotes, (e) => env.toast(env.errText(e), true)));
    notesHost.querySelector('#lg-paste').onclick = askPaste;
    notesHost.querySelectorAll('[data-move]').forEach((b) => { b.onclick = () => moveInto(b, st.notes[Number(b.dataset.move)]); });
    notesHost.querySelectorAll('[data-out]').forEach((b) => { b.onclick = () => askAddress(st.notes[Number(b.dataset.out)]); });
  }

  async function find(btn) {
    return env.act(btn, async (step, c) => {
      await env.ensureChain(c);
      const { found } = await flowFor().scan({ from: 0, onProbe: (n) => step(`sign for number ${n}`) });
      writeNotes(env.store, chainId, env.account(), [...readNotes(env.store, chainId, env.account()), ...found.map(metaOf)]);
      for (const f of found) st.spent.set(commitmentBytes32(f.secrets.nullifierHash), f.spent);
      env.say(found.length ? `${found.length} found.` : 'No deposits found for this wallet.');
      loadNotes();
    });
  }

  // The withdrawal itself: the note text comes from signing its nonce again; gas is paid from the note; nothing is sent
  // until the fee is shown and pressed.
  function confirmFee({ fee, receive, denomination }) {
    return new Promise((resolve) => {
      const ask = notesHost.querySelector('#lg-ask');
      const pct = Number((fee * 10000n) / denomination) / 100;
      ask.hidden = false;
      const where = st.target ? `<p class="note">To ${esc(st.target.label)}: <code>${esc(st.target.to)}</code></p>` : '';
      ask.innerHTML = `${where}<p class="note">Gas is paid from the note: up to ${formatEther(fee)} ETH (${pct.toFixed(2)}% of it), and what is not used comes back to the address. The address gets at least ${formatEther(receive)} ETH.</p>
        <div style="display:flex;gap:8px"><button class="btn" type="button" id="lg-send" style="margin-top:6px">Send</button><button class="btn ghost" type="button" id="lg-cancel" style="margin-top:6px">Cancel</button></div>`;
      const done = (ok) => { clearTimeout(t); ask.hidden = true; ask.innerHTML = ''; resolve(ok); };
      const t = setTimeout(() => done(false), 3 * 60 * 1000);
      ask.querySelector('#lg-send').onclick = () => done(true);
      ask.querySelector('#lg-cancel').onclick = () => done(false);
    });
  }
  // Runs inside the page's busy wrapper (`step` and `c` come from it), so it must not open another.
  // `n` is a stored note (its number is signed for again to get the secrets) or { text }, the text of any note, which needs no
  // signature. `raw` is where it goes: empty (the user's own deposit address), a name or an address.
  async function exitNote(step, c, n, raw, doneText) {
    if (!PAYMASTERS[chainId]) throw new Error('Paying the gas from the note is not available on this network.');
    const flow = flowFor();
    let text = n.text;
    if (!text) { await env.ensureChain(c); text = await flow.noteText(n); }
    const target = await resolveTarget(raw);
    const to = target.to;
    st.target = target;
    const prover = workerProver(env.workerUrl);
    try {
      const out = await flow.withdrawSponsored({
        noteText: text, recipient: to, prover, confirm: confirmFee,
        onStep: (s) => step(s.step === 'read' ? (s.of ? `reading the pool's deposits (${s.done} of ${s.of})` : 'reading the pool\'s deposits') : s.step === 'tree' ? `building the tree from ${s.count} deposits` : s.step === 'prove' ? 'proving' : s.step === 'estimate' ? 'asking the bundler about the gas' : s.step === 'price' ? 'gas is high right now, waiting for a calmer price' : s.step === 'quote' ? 'check the fee below' : s.step === 'wait' ? 'waiting for the withdrawal to be mined' : 'working'),
      });
      if (n.nh) st.spent.set(n.nh, !!out.spent);
      if (out.spent) env.done(c, out.hash, doneText(out, target)); else env.say('Sent; the pool has not shown it yet.');
    } catch (e) {
      if (!e?.cancelled) throw e;
      env.say('Cancelled. Nothing was sent.');
    } finally { prover.close(); st.target = null; }
    loadNotes();
  }
  function moveInto(btn, n) {
    return env.act(btn, async (step, c) => {
      // the private balance's own deposit address, which opens it if it is not open yet
      return exitNote(step, c, n, '', (out) => `${formatEther(out.receive)} ETH is on its way to your deposit address; it joins your private balance within minutes.`);
    });
  }
  function askPaste() {
    const ask = notesHost.querySelector('#lg-ask');
    ask.hidden = false;
    ask.innerHTML = `<div class="lbl"><span>Note</span><span></span></div>
      <div class="amt text"><textarea id="lg-note" rows="3" placeholder="tornado-eth-…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Note" style="width:100%;font:inherit;resize:vertical"></textarea></div>
      <div class="lbl"><span>Send to</span><span>empty: your own deposit address</span></div>
      <div class="amt text"><input id="lg-pto" placeholder="Empty: your deposit address. Or an address, or a name" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Send to"></div>
      <p class="note">The note stays in this page. Nothing here is signed by your wallet.</p>
      <div style="display:flex;gap:8px"><button class="btn" type="button" id="lg-pgo" style="margin-top:6px">Withdraw</button><button class="btn ghost" type="button" id="lg-pno" style="margin-top:6px">Cancel</button></div>`;
    ask.querySelector('#lg-pno').onclick = () => { ask.hidden = true; ask.innerHTML = ''; };
    const go = ask.querySelector('#lg-pgo');
    go.onclick = () => {
      const text = ask.querySelector('#lg-note').value.trim(), to = ask.querySelector('#lg-pto').value.trim();
      try { parseNoteString(text); } catch { return env.toast('That is not a note.', true); }
      const problem = to ? addressProblem(to) : null;
      if (problem) return env.toast(problem, true);
      ask.hidden = true; ask.innerHTML = '';
      env.act(go, (step, c) => exitNote(step, c, { text }, to, (out, t) => (to ? `${formatEther(out.receive)} ETH is on its way to ${t.label}.` : `${formatEther(out.receive)} ETH is on its way to your deposit address; it joins your private balance within minutes.`)));
    };
  }
  function askAddress(n) {
    const ask = notesHost.querySelector('#lg-ask');
    ask.hidden = false;
    ask.innerHTML = `<div class="lbl"><span>Withdraw to</span><span></span></div>
      <div class="amt text"><input id="lg-to" placeholder="0x… or a name" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Withdraw to"></div>
      <div style="display:flex;gap:8px"><button class="btn" type="button" id="lg-out" style="margin-top:6px">Withdraw</button><button class="btn ghost" type="button" id="lg-no" style="margin-top:6px">Cancel</button></div>`;
    ask.querySelector('#lg-no').onclick = () => { ask.hidden = true; ask.innerHTML = ''; };
    const go = ask.querySelector('#lg-out');
    go.onclick = () => {
      const to = ask.querySelector('#lg-to').value.trim(), problem = addressProblem(to);
      if (problem) return env.toast(problem, true);
      ask.hidden = true; ask.innerHTML = '';
      env.act(go, (step, c) => exitNote(step, c, n, to, (out, t) => `${formatEther(out.receive)} ETH is on its way to ${t.label}.`));
    };
  }

  env.amountInput.addEventListener('input', paintSplit);
  paintSplit();
  loadNotes();
  return { repaint() { paintSplit(); loadNotes(); } };
}


// The deposit-address row of the exchange-deposit panel (Ethereum, ?fixed=1): the owner's primary name can carry the deposit address,
// so that anyone can pay "name.wei" in plain ETH from a Tacit page (the record is signed with the view key, and checked by payers).
// `env` is what the page owns: the wallet, a node for names, one that can send, the wallet's own box key and the address it shows.
export function attachName(env) {
  const { host } = env;
  const say = (html) => { host.innerHTML = html ? `<div class="blk" style="margin-top:16px"><div class="lbl"><span>Your name</span><span></span></div>${html}</div>` : ''; };
  async function paint() {
    const owner = env.account();
    if (!owner) return say('');
    let names, primary;
    try { names = await env.names(); ({ primary } = await names.findPrimary(owner)); } catch { return say(''); }
    if (!primary) return say('');
    // what the page shows as the deposit address must be the one this key makes, and the name must point at this key
    const k = await env.boxKey();
    if (k.box.toLowerCase() !== String(env.shownBox()).toLowerCase()) return say('');
    let point;
    try { point = await names.resolveName(primary.name); } catch { return say(`<p class="note">${esc(primary.name)} has not published a Tacit address yet, so it cannot carry a deposit address either.</p>`); }
    if (String(point.pool || '').toLowerCase() !== String(env.ownPool()).toLowerCase()) {
      return say(`<p class="note">${esc(primary.name)} points to a different Tacit address than this one, so its deposit address cannot be published from here.</p>`);
    }
    const ns = await signBox(k.v, k.n);
    const plan = await (await env.publishNames()).planPublishBox({ owner, n: k.n, ns });
    if (!plan.changed) return say(`<p class="note">${esc(primary.name)} carries this deposit address: anyone can pay it in plain ETH from a Tacit page that takes names, and it comes here.</p>`);
    say(`<div class="kv"><span>${esc(primary.name)}</span><b>${plan.current ? 'carries another deposit address' : 'has none yet'}</b></div>
      <button class="btn ghost" type="button" id="lg-pub">Put this address in ${esc(primary.name)}</button>
      <p class="note">One transaction on Ethereum from your wallet. It makes the address public next to the name, and lets Tacit pages pay the name in plain ETH. The record is signed with your view key, so no one else can swap it.</p>`);
    const btn = host.querySelector('#lg-pub');
    btn.onclick = () => env.act(btn, async (step, c) => {
      step('confirm the update in your wallet');
      const r = await (await env.publishNames()).publish(plan);
      if (r.skipped) return env.say(`${primary.name} already carries it.`);
      step('waiting for the update');
      const end = Date.now() + 3 * 60 * 1000;
      for (;;) {
        const rc = await (await env.read())('eth_getTransactionReceipt', [r.txHash]).catch(() => null);
        if (rc) { if (rc.status === '0x1' || Number(rc.status) === 1) break; throw new Error(`The update of ${primary.name} failed, so nothing changed. Try again.`); }
        if (Date.now() > end) throw new Error(`The update of ${primary.name} is not confirmed yet. Check it in your wallet.`);
        await new Promise((res) => setTimeout(res, 4000));
      }
      env.done(c, r.txHash, `${primary.name} now carries your deposit address.`);
      paint().catch(() => {});
    });
  }
  paint().catch(() => say(''));
  return { repaint: () => paint().catch(() => say('')) };
}
