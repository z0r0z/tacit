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

import { planSplit, FIXED_POOLS, DEFAULT_MIN_DENOMINATION, DEFAULT_MAX_NOTES, commitmentBytes32 } from '/fixed-pool-notes.js?cb=ab06e6d2';
import { makeFlow, parseEther, formatEther } from '/fixed-pool-flow.js?cb=0f50365d';
import { workerProver } from '/fixed-pool-prover.js?cb=307cfddc';
import { PAYMASTERS } from '/fixed-pool-paymaster.js?cb=40893745';
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
  const st = { smallest: DEFAULT_MIN_DENOMINATION, notes: [], spent: new Map(), open: null, confirm: null };

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
    if (!account && !st.notes.length) { notesHost.innerHTML = ''; return; }
    const rows = st.notes.map((n, i) => {
      const pool = poolOf(n.pool), gone = st.spent.get(n.nh);
      return `<div class="kv"><span>${pool ? formatEther(pool.denomination) : '?'} ETH <span class="mute">· note ${n.nonce}${gone ? ' · spent' : ''}</span></span>
        <b>${gone ? '' : `<button class="link" type="button" data-move="${i}">Move into Tacit</button> <button class="link" type="button" data-out="${i}">Withdraw</button>`}</b></div>`;
    }).join('');
    notesHost.innerHTML = `<div class="blk" style="margin-top:22px;padding-top:14px;border-top:1px solid var(--hair)">
      <div class="lbl"><span>Notes in the large pools</span><span><button class="link" type="button" id="lg-find">${account ? 'Find' : 'Connect wallet'}</button></span></div>
      ${rows || '<p class="note">None found in this browser. Find looks through this wallet\'s deposits and asks for a signature for each number it tries.</p>'}
      <div id="lg-ask" hidden></div>
      <p class="note">If paying the gas from a note is not available, these notes follow <a href="https://github.com/ethereum/kohaku" target="_blank" rel="noopener noreferrer">Kohaku</a>'s format, so it can withdraw them too.</p>
    </div>`;
    notesHost.querySelector('#lg-find').onclick = () => (account ? find(notesHost.querySelector('#lg-find')) : env.connect().then(loadNotes, (e) => env.toast(env.errText(e), true)));
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
      ask.innerHTML = `<p class="note">Gas is paid from the note: up to ${formatEther(fee)} ETH (${pct.toFixed(2)}% of it), and what is not used comes back to the address. The address gets at least ${formatEther(receive)} ETH.</p>
        <div style="display:flex;gap:8px"><button class="btn" type="button" id="lg-send" style="margin-top:6px">Send</button><button class="btn ghost" type="button" id="lg-cancel" style="margin-top:6px">Cancel</button></div>`;
      const done = (ok) => { clearTimeout(t); ask.hidden = true; ask.innerHTML = ''; resolve(ok); };
      const t = setTimeout(() => done(false), 3 * 60 * 1000);
      ask.querySelector('#lg-send').onclick = () => done(true);
      ask.querySelector('#lg-cancel').onclick = () => done(false);
    });
  }
  // Runs inside the page's busy wrapper (`step` and `c` come from it), so it must not open another.
  async function exitNote(step, c, n, recipient, doneText) {
    if (!PAYMASTERS[chainId]) throw new Error('Paying the gas from the note is not available on this network.');
    await env.ensureChain(c);
    const flow = flowFor();
    const text = await flow.noteText(n);
    const prover = workerProver(env.workerUrl);
    try {
      const out = await flow.withdrawSponsored({
        noteText: text, recipient, prover, confirm: confirmFee,
        onStep: (s) => step(s.step === 'read' ? (s.of ? `reading the pool's deposits (${s.done} of ${s.of})` : 'reading the pool\'s deposits') : s.step === 'tree' ? `building the tree from ${s.count} deposits` : s.step === 'prove' ? 'proving' : s.step === 'estimate' ? 'asking the bundler about the gas' : s.step === 'price' ? 'gas is high right now, waiting for a calmer price' : s.step === 'quote' ? 'check the fee below' : s.step === 'wait' ? 'waiting for the withdrawal to be mined' : 'working'),
      });
      st.spent.set(n.nh, !!out.spent);
      if (out.spent) env.done(c, out.hash, doneText(out)); else env.say('Sent; the pool has not shown it yet.');
    } catch (e) {
      if (!e?.cancelled) throw e;
      env.say('Cancelled. Nothing was sent.');
    } finally { prover.close(); }
    loadNotes();
  }
  function moveInto(btn, n) {
    return env.act(btn, async (step, c) => {
      // the private balance's own deposit address, which opens it if it is not open yet
      const box = await env.depositAddress();
      if (!box) throw new Error('Open your private balance first.');
      return exitNote(step, c, n, box, (out) => `${formatEther(out.receive)} ETH is on its way to your deposit address; it joins your private balance within minutes.`);
    });
  }
  function askAddress(n) {
    const ask = notesHost.querySelector('#lg-ask');
    ask.hidden = false;
    ask.innerHTML = `<div class="lbl"><span>Withdraw to</span><span></span></div>
      <div class="amt text"><input id="lg-to" placeholder="0x…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Withdraw to"></div>
      <div style="display:flex;gap:8px"><button class="btn" type="button" id="lg-out" style="margin-top:6px">Withdraw</button><button class="btn ghost" type="button" id="lg-no" style="margin-top:6px">Cancel</button></div>`;
    ask.querySelector('#lg-no').onclick = () => { ask.hidden = true; ask.innerHTML = ''; };
    const go = ask.querySelector('#lg-out');
    go.onclick = () => {
      const to = ask.querySelector('#lg-to').value.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(to) || /^0x0{40}$/.test(to)) return env.toast('Enter the address that should receive it.', true);
      if (!checksumOk(to)) return env.toast('That address\'s capitalization does not match its checksum. Check it.', true);
      ask.hidden = true; ask.innerHTML = '';
      env.act(go, (step, c) => exitNote(step, c, n, to, (out) => `${formatEther(out.receive)} ETH is on its way to ${short(to)}.`));
    };
  }

  env.amountInput.addEventListener('input', paintSplit);
  paintSplit();
  loadNotes();
  return { repaint() { paintSplit(); loadNotes(); } };
}
