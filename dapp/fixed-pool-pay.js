// The large-pool part of the Pay page's Deposit tab (Ethereum; on, and ?fixed=0 turns it off in a browser).
//
// Two cards under the deposit form:
//   - an amount from a whole note up goes into the large pools in whole notes (the pool takes only those sizes) and
//     what is left goes into the private balance as it always does: the card shows the split and hands the page a plan,
//     and the form's own button deposits both in one press (the page asks for `depositRest` for the part that is left);
//   - the notes in those pools: found again from the wallet, and moved into the Tacit balance (the withdrawal pays the
//     user's own deposit address, its gas paid from the note) or withdrawn to any address.
// And two blocks under the Withdraw form: the notes the wallet holds there (`attachWithdraw`), which a withdrawal of a whole note or
// more takes first, the rest coming from the private balance; and `attachIntake`, the way in from the private balance: whole notes made
// from it in one private spend, whose call deposits them into the large pools.
// A note can leave with its gas paid from the note (the pool paymaster, the default) or from the wallet, which sends the withdrawal itself
// and shows as the sender: the choice is kept (`tacit-fixed-gas`) and shared by every block.
//
// The page hands in what it owns (`env`): its node, the wallet, the user's deposit address, its busy/status wrapper and
// the amount field. Notes are never kept: only where a note is (nonce, pool) and what it is called on chain, since its
// secrets come from signing the nonce again.

import { planSplit, FIXED_POOLS, DEFAULT_MIN_DENOMINATION, DEFAULT_MAX_NOTES, commitmentBytes32, parseNoteString } from '/fixed-pool-notes.js?cb=ab06e6d2';
import { makeFlow, parseEther, formatEther } from '/fixed-pool-flow.js?cb=7f4f9327';
import { workerProver } from '/fixed-pool-prover.js?cb=307cfddc';
import { PAYMASTERS, MAX_FEE_PERCENT } from '/fixed-pool-paymaster.js?cb=40893745';
export { MAX_FEE_PERCENT };
import { depositAddressOfName, signBox } from '/fixed-pool-box.js?cb=8abc44f0';
import { callIntent, call as intentCall } from '/evm-pool-gateway.js';
import { keccak_256 } from './vendor/tacit-deps.min.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const WALLET_METHODS = new Set(['eth_signTypedData_v4', 'eth_sendTransaction', 'wallet_sendCalls', 'wallet_getCallsStatus', 'wallet_getCapabilities']);
const SMALLEST = [{ wei: DEFAULT_MIN_DENOMINATION, label: '1 ETH' }, { wei: 10n ** 17n, label: '0.1 ETH' }, { wei: 0n, label: 'off' }];
// What the cards do, in plain words: why a large amount is split, what a note is, how it comes out, and why to wait. Shown at the top of the notes card,
// which is on the Deposit tab for ETH on Ethereum whatever is typed, closed until it is opened.
const HOW_IT_WORKS = `<details class="lg-how" style="margin:0 0 12px"><summary style="cursor:pointer">How large amounts work</summary>
  <p class="note">A large deposit would stand out in Tacit's pool, which is still young. So an amount of a whole note or more is split: whole notes (1, 10 or 100 ETH, or 0.1 ETH if you choose that) go from your wallet into large pools where every deposit is the same size, and what is left goes into your private balance. One press does both.</p>
  <p class="note">A note is yours alone. Its secret comes from a signature of your wallet, so there is nothing to save: <b>Find</b> brings your notes back on any device with the same wallet.</p>
  <p class="note">To take a note out, send it to any address or into your private balance. Its gas is paid from the note (a small fee, at most ${MAX_FEE_PERCENT}%) or from your wallet, which then shows as the sender. The longer a note sits, and the more deposits come after it, the better it hides, so avoid taking it out right away.</p>
  <p class="note">Going the other way, <b>Withdraw</b> makes notes from your private balance, and takes whole notes first when you withdraw a large amount.</p>
</details>`;
const MIN_KEY = (chainId) => `tacit-fixed-min:${chainId}`;
const GAS_KEY = (chainId) => `tacit-fixed-gas:${chainId}`;
const readGas = (store, chainId) => { try { return store.get(GAS_KEY(chainId)) === 'wallet' ? 'wallet' : 'note'; } catch { return 'note'; } };
const saveGas = (store, chainId, v) => { try { store.set(GAS_KEY(chainId), v); } catch { /* a convenience */ } };

// Whole notes for a withdrawal of `amount`: the largest first, each only if it still fits under the amount, so that what the
// notes pay never passes what was asked. `dens` are the sizes (wei) of the notes held; the picks are indices into it.
export function planExit(amount, dens) {
  const order = dens.map((d, i) => [BigInt(d), i]).sort((x, y) => (x[0] === y[0] ? x[1] - y[1] : x[0] < y[0] ? 1 : -1));
  const picks = [];
  let total = 0n;
  for (const [d, i] of order) if (d > 0n && total + d <= amount) { picks.push(i); total += d; }
  return { picks, total };
}

const exitWords = (s) => (s.step === 'read' ? (s.of ? `reading the pool's deposits (${s.done} of ${s.of})` : 'reading the pool\'s deposits') : s.step === 'tree' ? `building the tree from ${s.count} deposits` : s.step === 'prove' ? 'proving' : s.step === 'estimate' ? 'asking the bundler about the gas' : s.step === 'price' ? 'gas is high right now, waiting for a calmer price' : s.step === 'quote' ? 'check the fee below' : s.step === 'wait' ? 'waiting for the withdrawal to be mined' : 'working');
// One note out, its gas paid from the note: proved in a worker, `confirm` asked once the fee is fixed and before anything is sent.
// `prover` and `cache` are for a run of notes: one prover and one cache for the run, so a pool's deposits are read and its tree built once (the caller closes the prover).
async function sponsoredExit({ flow, text, to, step, confirm, workerUrl, prover: given = null, cache = null }) {
  const prover = given || workerProver(workerUrl);
  try { return await flow.withdrawSponsored({ noteText: text, recipient: to, prover, confirm, cache, onStep: (s) => step(exitWords(s)) }); } finally { if (!given) prover.close(); }
}
// The same withdrawal sent from the wallet, which pays the gas and shows as the sender: proved in a worker, `confirm` asked once it is proved and
// before the wallet is asked, and the whole note goes to the recipient. No paymaster and no bundler.
async function walletExit({ flow, text, to, step, confirm, workerUrl, prover: given = null, cache = null }) {
  const prover = given || workerProver(workerUrl);
  try { return await flow.withdraw({ noteText: text, recipient: to, prover, confirm, cache, onStep: (s) => step(s.step === 'send' ? 'confirm in your wallet' : exitWords(s)) }); } finally { if (!given) prover.close(); }
}
// Notes found by signing numbers again (Find) and which of them are spent are shared by the cards, so a note that was seen spent is not asked about again.
const SPENT = new Set();

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
  const saved = (() => { try { const v = env.store.get(MIN_KEY(chainId)); return v == null ? null : BigInt(v); } catch { return null; } })();
  const st = { smallest: SMALLEST.some((x) => x.wei === saved) ? saved : DEFAULT_MIN_DENOMINATION, notes: [], spent: new Map(), open: null, confirm: null, target: null, gas: readGas(env.store, chainId) };
  const setSmallest = (v) => { st.smallest = v; try { env.store.set(MIN_KEY(chainId), v.toString()); } catch { /* a convenience */ } };
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
  const parse = (t) => (env.parseAmount ? env.parseAmount(t) : parseEther(t));
  const plan = () => {
    const wei = parse(env.amountInput.value);
    if (!wei) return null;
    const off = st.smallest === 0n;
    return { wei, off, ...planSplit(wei, chainId, { minDenominationWei: off ? DEFAULT_MIN_DENOMINATION : st.smallest, maxNotes: DEFAULT_MAX_NOTES }) };
  };
  const noteTotalOf = (p) => p.notes.reduce((t, n) => t + n.denomination * BigInt(n.count), 0n);
  const selectHtml = () => `<label>Smallest note <select id="lg-min" aria-label="Smallest note">${SMALLEST.map((s) => `<option value="${s.wei}"${s.wei === st.smallest ? ' selected' : ''}>${s.label}</option>`).join('')}</select></label>`;
  function paintSplit() {
    const p = plan();
    if (!p || !p.notes.length) { host.innerHTML = ''; env.onPlan?.(null); return; }
    const frame = (inner) => `<div class="blk" style="margin-top:22px;padding-top:14px;border-top:1px solid var(--hair)">${inner}</div>`;
    if (p.off) {
      host.innerHTML = frame(`<div class="lbl"><span>Large amount</span><span>${selectHtml()}</span></div><p class="note">The large pools are off: all of it goes into your private balance.</p>`);
      host.querySelector('#lg-min').onchange = (e) => { setSmallest(BigInt(e.target.value)); paintSplit(); };
      env.onPlan?.(null);
      return;
    }
    const rows = p.notes.map((n) => `<div class="kv"><span>${n.count} × ${formatEther(n.denomination)} ETH</span><b>whole notes, large pool</b></div>`).join('');
    host.innerHTML = frame(`<div class="lbl"><span>Large amount</span><span>${selectHtml()}</span></div>
      ${rows}
      <div class="kv"><span>${p.remainder === 0n ? 'Nothing' : esc(formatEther(p.remainder)) + ' ETH'}</span><b>${p.remainder === 0n ? 'left for your private balance' : 'into your private balance'}</b></div>
      <p class="note">One press above deposits both. The notes go to the large pools from your wallet; the note numbers come from your wallet's signature, so they can be found again with it.</p>`);
    host.querySelector('#lg-min').onchange = (e) => { setSmallest(BigInt(e.target.value)); paintSplit(); };
    const noteTotal = noteTotalOf(p);
    env.onPlan?.({
      label: `Deposit ${formatEther(p.wei)} ETH: ${p.noteCount} whole ${p.noteCount === 1 ? 'note' : 'notes'}${p.remainder > 0n ? ` + ${formatEther(p.remainder)}` : ''}`,
      noteCount: p.noteCount, noteTotal, remainder: p.remainder,
      run: (step, c) => depositBoth(p, noteTotal, step, c),
    });
  }

  // The whole notes from the wallet, then what is left through the page (`depositRest`), in the page's busy wrapper (`step`, `c`).
  // If the part that is left does not go in, the notes are already placed and the amount above says what remains.
  async function depositBoth(p, noteTotal, step, c) {
    if (!env.account()) throw new Error('Connect your wallet first.');
    await env.ensureChain(c);
    const bal = BigInt(await (await env.read())('eth_getBalance', [env.account(), 'latest']));
    if (bal < p.wei) throw new Error(`Your wallet holds ${formatEther(bal)} ETH on ${c.full}, less than the ${formatEther(p.wei)} ETH to deposit.`);
    let out;
    try {
      out = await flowFor().deposit(p, {
        onStep: (s) => step(s.step === 'find' ? 'looking for the next free note number' : s.step === 'sign' ? `sign for note ${s.i + 1} of ${s.of}` : s.step === 'send' ? 'confirm the deposits in your wallet' : `deposit ${s.i} of ${s.of} confirmed`),
      });
    } catch (e) {
      // Notes sent before it stopped (one declined in the wallet, a read that failed) are the wallet's: kept, and taken off the amount, so the
      // next press does not deposit them again.
      const sent = e?.done || [];
      if (sent.length) {
        const got = sent.reduce((t, n) => t + n.pool.denomination, 0n);
        writeNotes(env.store, chainId, env.account(), [...readNotes(env.store, chainId, env.account()), ...sent.map(metaOf)]);
        env.setAmount(p.wei - got);
        loadNotes();
        throw new Error(`${sent.length} of ${p.noteCount} notes ${sent.length === 1 ? 'was' : 'were'} sent (${formatEther(got)} ETH) and kept. The amount above is what is left to deposit. ${env.errText(e)}`);
      }
      throw e;
    }
    writeNotes(env.store, chainId, env.account(), [...readNotes(env.store, chainId, env.account()), ...out.notes.map(metaOf)]);
    env.setAmount(p.remainder);
    loadNotes();
    const placed = `${out.notes.length === 1 ? 'The note is' : 'The notes are'} in the large ${out.notes.length === 1 ? 'pool' : 'pools'} (${formatEther(noteTotal)} ETH)`;
    if (p.remainder === 0n) return { text: `${placed}.`, h: null };
    let h;
    try { h = await env.depositRest(p.remainder, step, c); } catch (e) {
      throw new Error(`${placed}. The rest, ${formatEther(p.remainder)} ETH, did not go in: ${env.errText(e)} The amount above is what is left; press the button again.`);
    }
    return { text: `${placed}, and ${formatEther(p.remainder)} ETH went into your private balance.`, h };
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
      reader.spent(pool, BigInt(n.nh)).then((v) => { st.spent.set(n.nh, v); if (v) SPENT.add(n.nh); if (notesHost.isConnected) paintNotes(); }, () => {});
    }
  }
  function paintNotes() {
    // while the fee panel is open the card is not redrawn: its Send and Cancel buttons live in it, and a late read or the gas choice would take them away
    if (st.confirming) { st.dirty = true; return; }
    const account = env.account();
    const rows = st.notes.map((n, i) => {
      const pool = poolOf(n.pool), gone = st.spent.get(n.nh);
      return `<div class="kv"><span>${pool ? formatEther(pool.denomination) : '?'} ETH <span class="mute">· note ${n.nonce}${gone ? ' · spent' : ''}</span></span>
        <b>${gone ? '' : `<button class="link" type="button" data-move="${i}">Move into Tacit</button> <button class="link" type="button" data-out="${i}">Withdraw</button>`}</b></div>`;
    }).join('');
    notesHost.innerHTML = `<div class="blk" style="margin-top:22px;padding-top:14px;border-top:1px solid var(--hair)">
      ${HOW_IT_WORKS}
      <div class="lbl"><span>Notes in the large pools</span><span><button class="link" type="button" id="lg-find">${account ? 'Find' : 'Connect wallet'}</button> · <button class="link" type="button" id="lg-paste">Paste a note</button></span></div>
      ${rows || '<p class="note">None found in this browser. Find looks through this wallet\'s deposits and asks for a signature for each number it tries. A note from anywhere else can be pasted.</p>'}
      <div id="lg-ask" hidden></div>
      <div class="lbl"><span>Gas</span><span><label>Paid from <select id="lg-gas" aria-label="Where a note's gas is paid from"><option value="note"${st.gas === 'note' ? ' selected' : ''}>the note</option><option value="wallet"${st.gas === 'wallet' ? ' selected' : ''}>my wallet</option></select></label></span></div>
      <p class="note">${st.gas === 'wallet' ? 'Your wallet sends the withdrawal and pays its gas, so it shows as the sender, and the address gets the whole note.' : 'The note pays its own gas, so no ETH is needed in a wallet.'} If paying the gas from a note is not available, these notes follow <a href="https://github.com/ethereum/kohaku" target="_blank" rel="noopener noreferrer">Kohaku</a>'s format, so it can withdraw them too.</p>
    </div>`;
    notesHost.querySelector('#lg-find').onclick = () => (account ? find(notesHost.querySelector('#lg-find')) : env.connect().then(loadNotes, (e) => env.toast(env.errText(e), true)));
    notesHost.querySelector('#lg-paste').onclick = askPaste;
    notesHost.querySelector('#lg-gas').onchange = (e) => { st.gas = e.target.value === 'wallet' ? 'wallet' : 'note'; saveGas(env.store, chainId, st.gas); paintNotes(); };
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
      const cost = fee === 0n
        ? `Your wallet sends this and pays the gas, so it shows as the sender. The address gets the whole ${formatEther(receive)} ETH.`
        : `Gas is paid from the note: up to ${formatEther(fee)} ETH (${pct.toFixed(2)}% of it), and what is not used comes back to the address. The address gets at least ${formatEther(receive)} ETH.`;
      ask.innerHTML = `${where}<p class="note">${cost}</p>
        <div style="display:flex;gap:8px"><button class="btn" type="button" id="lg-send" style="margin-top:6px">Send</button><button class="btn ghost" type="button" id="lg-cancel" style="margin-top:6px">Cancel</button></div>`;
      st.confirming = true;
      const done = (ok) => { clearTimeout(t); ask.hidden = true; ask.innerHTML = ''; st.confirming = false; resolve(ok); if (st.dirty) { st.dirty = false; paintNotes(); } };
      const t = setTimeout(() => done(false), 3 * 60 * 1000);
      ask.querySelector('#lg-send').onclick = () => done(true);
      ask.querySelector('#lg-cancel').onclick = () => done(false);
    });
  }
  // Runs inside the page's busy wrapper (`step` and `c` come from it), so it must not open another.
  // `n` is a stored note (its number is signed for again to get the secrets) or { text }, the text of any note, which needs no
  // signature. `raw` is where it goes: empty (the user's own deposit address), a name or an address.
  async function exitNote(step, c, n, raw, doneText) {
    const fromWallet = st.gas === 'wallet';
    if (!fromWallet && !PAYMASTERS[chainId]) throw new Error('Paying the gas from the note is not available on this network. Choose your wallet for the gas.');
    if (fromWallet && !env.account()) throw new Error('Connect your wallet first: it sends the withdrawal.');
    if (fromWallet) await env.ensureChain(c);
    const flow = flowFor();
    let text = n.text;
    if (!text) { await env.ensureChain(c); text = await flow.noteText(n); }
    const target = await resolveTarget(raw);
    const to = target.to;
    st.target = target;
    try {
      const out = await (fromWallet ? walletExit : sponsoredExit)({ flow, text, to, step, confirm: confirmFee, workerUrl: env.workerUrl });
      if (n.nh) st.spent.set(n.nh, !!out.spent);
      if (out.spent) env.done(c, out.hash, doneText(out, target)); else env.say('Sent; the pool has not shown it yet.');
    } catch (e) {
      if (!e?.cancelled) throw e;
      env.say('Cancelled. Nothing was sent.');
    } finally { st.target = null; }
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


// The notes block of the Withdraw form (Ethereum): the unspent notes this wallet holds in the large pools, which the form
// counts first for an amount of a whole note or more (`planExit`); the rest of the amount comes from the private balance, through
// the page. `exit` sends the chosen notes to an address one after the other, each with its gas paid from the note. Whatever the
// fee turns out to be, a note is only sent if it is within the ceiling the form states (MAX_FEE_PERCENT of the note), so the
// one press covers every note. `env.onNotes(list)` is told whenever the list changes.
export function attachWithdraw(env) {
  const { host } = env;
  const chainId = env.chain.chainId;
  const provider = composeProvider({ read: env.read, wallet: env.walletProvider });
  const flowFor = () => makeFlow({ provider, account: env.account(), chainId, store: env.store, poll: 3000, timeout: 10 * 60 * 1000 });
  const reader = makeFlow({ provider, account: null, chainId, poll: 3000 });
  const st = { list: [], gen: 0, gas: readGas(env.store, chainId) };
  const poolOf = (addr) => FIXED_POOLS[chainId]?.find((x) => x.address.toLowerCase() === addr.toLowerCase());
  const publish = () => env.onNotes?.(st.list);
  function paint() {
    if (!host.isConnected) return;
    const account = env.account(), total = st.list.reduce((t, x) => t + x.den, 0n);
    host.innerHTML = `<div class="blk" style="margin-top:18px;padding-top:12px;border-top:1px solid var(--hair)">
      <div class="lbl"><span>Notes in the large pools</span><span><button class="link" type="button" id="lw-find">${account ? 'Look for notes' : 'Connect wallet'}</button></span></div>
      ${st.list.length
        ? `<div class="kv"><span>${st.list.length} whole ${st.list.length === 1 ? 'note' : 'notes'}</span><b>${formatEther(total)} ETH</b></div>
           <p class="note">An amount of a whole note or more takes these first, and the rest comes from your private balance. ${st.gas === 'wallet' ? 'Your wallet sends each note and pays its gas, so it shows as the sender.' : `The notes pay their own gas, at most ${MAX_FEE_PERCENT}% of each.`}</p>
           <div class="lbl"><span>Gas</span><span><label>Paid from <select id="lw-gas" aria-label="Where the notes' gas is paid from"><option value="note"${st.gas === 'note' ? ' selected' : ''}>the notes</option><option value="wallet"${st.gas === 'wallet' ? ' selected' : ''}>my wallet</option></select></label></span></div>`
        : '<p class="note">None known in this browser. Looking asks your wallet for a signature for each note number it tries.</p>'}
    </div>`;
    const g = host.querySelector('#lw-gas');
    if (g) g.onchange = (e) => { st.gas = e.target.value === 'wallet' ? 'wallet' : 'note'; saveGas(env.store, chainId, st.gas); paint(); publish(); };
    host.querySelector('#lw-find').onclick = (e) => (account ? find(e.currentTarget) : env.connect().then(load, (err) => env.toast(env.errText(err), true)));
  }
  async function load() {
    const account = env.account(), gen = ++st.gen;
    const stored = account ? readNotes(env.store, chainId, account) : [];
    st.list = stored.map((meta) => ({ meta, den: poolOf(meta.pool)?.denomination ?? 0n })).filter((x) => x.den > 0n && !(x.meta.nh != null && SPENT.has(x.meta.nh)));
    paint(); publish();
    for (const x of [...st.list]) {
      const pool = poolOf(x.meta.pool);
      if (x.meta.nh == null) continue;
      reader.spent(pool, BigInt(x.meta.nh)).then((v) => {
        if (!v || gen !== st.gen) return;
        SPENT.add(x.meta.nh);
        st.list = st.list.filter((y) => y !== x); paint(); publish();
      }, () => {});
    }
  }
  function find(btn) {
    return env.act(btn, async (step, c) => {
      await env.ensureChain(c);
      const { found } = await flowFor().scan({ from: 0, onProbe: (n) => step(`sign for number ${n}`) });
      writeNotes(env.store, chainId, env.account(), [...readNotes(env.store, chainId, env.account()), ...found.map(metaOf)]);
      for (const f of found) if (f.spent) SPENT.add(commitmentBytes32(f.secrets.nullifierHash));
      env.say(found.length ? `${found.length} found.` : 'No deposits found for this wallet.');
      load();
    });
  }
  // Runs inside the page's busy wrapper. `notes` are entries of the list; `to` is a checked address. Returns what each withdrawal
  // came to; if one fails, the notes before it are out and the error says so (with `done`: what went out).
  async function exit(step, c, notes, to) {
    const fromWallet = st.gas === 'wallet';
    if (!fromWallet && !PAYMASTERS[chainId]) throw new Error('Paying the gas from a note is not available on this network. Choose your wallet for the gas.');
    if (!env.account()) throw new Error('Connect your wallet first.');
    await env.ensureChain(c);
    // one prover and one cache for the whole run, the notes of a pool together: each pool's deposits are read and its tree built once, not once a note
    const flow = flowFor(), outs = [], prover = workerProver(env.workerUrl), cache = { pools: new Map(), loaded: null };
    const ordered = [...notes].sort((x, y) => String((x.meta ?? x).pool).toLowerCase().localeCompare(String((y.meta ?? y).pool).toLowerCase()));
    notes = ordered;
    try {
    for (let k = 0; k < notes.length; k++) {
      const n = notes[k].meta ?? notes[k];
      const tag = (m) => step(notes.length > 1 ? `note ${k + 1} of ${notes.length}: ${m}` : m);
      try {
        const text = await flow.noteText(n);
        const out = await (fromWallet ? walletExit : sponsoredExit)({ flow, text, to, step: tag, confirm: ({ fee, denomination }) => fee * 100n <= denomination * MAX_FEE_PERCENT, workerUrl: env.workerUrl, prover, cache });
        outs.push(out);
        if (out.spent && n.nh) SPENT.add(n.nh);
      } catch (e) {
        const out = outs.reduce((t, o) => t + o.receive, 0n);
        const why = e?.cancelled ? 'The fee came to more than the notes\' ceiling, so it was not sent.' : env.errText(e);
        throw Object.assign(new Error(outs.length ? `${outs.length} of ${notes.length} notes went out to ${short(to)} (${formatEther(out)} ETH). Note ${k + 1} did not: ${why}` : why), { done: outs });
      }
    }
    } finally { prover.close(); }
    load();
    return outs;
  }
  load();
  return { get list() { return st.list; }, get fromWallet() { return st.gas === 'wallet'; }, exit, repaint: load };
}


// The way in, under the Withdraw form (Ethereum): whole notes made from the private balance. One private spend into the router's
// call escrow, whose calls are the large pools' deposits, so no wallet's ETH passes: the relay sends it (one note a transaction, since a deposit
// takes about a million gas and the relay's cap is 1.5 million), or the wallet does (no cap, all the notes in one transaction, the wallet shows as
// the sender and pays the gas). If any call fails the whole transaction reverts and nothing is spent. The note numbers come from the wallet's
// signatures, as for any note, so they can be found again with it. What the page owns comes in `env`: the private balance, the relay's fee for a
// gas figure, the refund box and the clock, and `send`, which makes the spend.
// Gas of the whole transaction: the pool's own withdrawal (450 thousand) and the deposits (measured on the live pools: about 1.00 million
// for the first, 0.81 million for each more).
const WATCH_MS = 5000;
const SEND_GRACE_MS = 60_000;   // how long a landed spend's unanswered send is waited for before the next one is started   // how often the pool is asked whether a pending spend's notes have landed
export const intakeGas = (notes) => 450_000 + 1_040_000 + 850_000 * Math.max(0, notes - 1);
export function attachIntake(env) {
  const { host } = env;
  const chainId = env.chain.chainId;
  const provider = composeProvider({ read: env.read, wallet: env.walletProvider });
  const flowFor = () => makeFlow({ provider, account: env.account(), chainId, store: env.store, poll: 3000, timeout: 10 * 60 * 1000 });
  const st = { via: 'relay', amount: '', fee: null, feeErr: null, busy: false };
  const smallest = () => { try { const v = BigInt(env.store.get(MIN_KEY(chainId))); return v > 0n ? v : DEFAULT_MIN_DENOMINATION; } catch { return DEFAULT_MIN_DENOMINATION; } };
  const planOf = () => {
    const wei = (env.parseAmount ? env.parseAmount(st.amount) : parseEther(st.amount));
    if (!wei) return null;
    return { wei, ...planSplit(wei, chainId, { minDenominationWei: smallest(), maxNotes: DEFAULT_MAX_NOTES }) };
  };
  const totalOf = (p) => p.notes.reduce((t, n) => t + n.denomination * BigInt(n.count), 0n);
  let quoteFor = 0;
  async function quote() {
    const id = ++quoteFor;
    st.fee = null; st.feeErr = null;
    try { const fee = await env.relayFee(intakeGas(1)); if (id === quoteFor) st.fee = fee; } catch (e) { if (id === quoteFor) { st.feeErr = env.errText(e); if (st.via === 'relay') st.via = 'wallet'; } }
    if (id === quoteFor && host.isConnected) paint();
  }
  function paint() {
    if (!host.isConnected) return;
    const p = planOf(), have = env.balance?.();
    const body = !p || !p.notes.length
      ? `<p class="note">${p ? 'That is less than the smallest note, ' + formatEther(smallest()) + ' ETH.' : 'Whole notes for a large amount, made from your private balance with no wallet in between.'}</p>`
      : (() => {
        const total = totalOf(p), n = p.noteCount, rows = p.notes.map((x) => `<div class="kv"><span>${x.count} × ${formatEther(x.denomination)} ETH</span><b>whole notes, large pool</b></div>`).join('');
        const left = p.remainder === 0n ? '' : `<div class="kv"><span>${esc(formatEther(p.remainder))} ETH</span><b>stays in your private balance</b></div>`;
        const cost = st.via === 'wallet'
          ? `<div class="kv"><span>Sent by</span><b>your wallet: it pays the gas and shows as the sender</b></div>`
          : st.fee == null ? '<div class="kv"><span>Relay fee</span><b>reading…</b></div>' : `<div class="kv"><span>Relay fee</span><b>up to ${esc(formatEther(st.fee * 5n / 4n))} ETH from your balance${n > 1 ? ' for each note' : ''}</b></div>`;
        const short = have != null && have < total ? `<p class="note err" role="alert">Your private balance holds ${esc(formatEther(have))} ETH, less than the ${esc(formatEther(total))} ETH of notes.</p>` : '';
        return `${rows}${left}${cost}${short}<button class="btn" type="button" id="li-go"${short || (st.via === 'relay' && st.fee == null) ? ' disabled' : ''}>${env.account() ? `Move ${esc(formatEther(total))} ETH into ${n} ${n === 1 ? 'note' : 'notes'}` : 'Connect wallet'}</button>`;
      })();
    host.innerHTML = `<div class="blk" style="margin-top:18px;padding-top:12px;border-top:1px solid var(--hair)">
      <div class="lbl"><span>Into whole notes</span><span><label>Sent by <select id="li-via" aria-label="Who sends it"><option value="relay"${st.via === 'relay' ? ' selected' : ''}>the relay</option><option value="wallet"${st.via === 'wallet' ? ' selected' : ''}>my wallet</option></select></label></span></div>
      <div class="amt text"><input id="li-amt" inputmode="decimal" placeholder="ETH to move into notes" autocomplete="off" aria-label="ETH to move into notes" value="${esc(st.amount)}"></div>
      ${body}
      ${st.feeErr && st.via === 'wallet' ? `<p class="note">The relay cannot send this one (${esc(st.feeErr.replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase()))}), so your wallet does.</p>` : ''}
      <p class="note">The notes are best left in the pool a while before they are taken out: the longer they sit, the more deposits they hide among. They can be taken out from this page, or with any tool that reads Kohaku's note format.</p>
    </div>`;
    const amt = host.querySelector('#li-amt');
    amt.oninput = () => { st.amount = amt.value; paintKeep(); };
    host.querySelector('#li-via').onchange = (e) => { st.via = e.target.value === 'wallet' ? 'wallet' : 'relay'; if (st.via === 'relay' && st.fee == null && !st.feeErr) quote(); paint(); };
    const go = host.querySelector('#li-go');
    if (go) go.onclick = () => (env.account() ? env.act(go, (step, c) => run(step, c, p)) : env.connect().then(paint, (e) => env.toast(env.errText(e), true)));
  }
  // redraw without losing the caret while typing
  function paintKeep() { const pos = host.querySelector('#li-amt')?.selectionStart; paint(); const a = host.querySelector('#li-amt'); if (a && pos != null) { a.focus(); a.setSelectionRange(pos, pos); } }

  const rnd = () => BigInt('0x' + [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''));
  // Runs inside the page's busy wrapper. The notes are made first (a signature each), then spent from the private balance: the relay one note
  // a transaction, the wallet all in one. Only notes found in their pool are kept; if some do not land, the message says which are missing.
  async function run(step, c, p) {
    if (!env.account()) throw new Error('Connect your wallet first: it signs for the notes.');
    await env.ensureChain(c);
    const total = totalOf(p), have = env.balance?.();
    if (have != null && have < total) throw new Error(`Your private balance holds ${formatEther(have)} ETH, less than the ${formatEther(total)} ETH of notes.`);
    const flow = flowFor();
    const notes = await flow.prepareNotes(p, { onStep: (s) => step(s.step === 'find' ? 'looking for the next free note number' : `sign for note ${s.i + 1} of ${s.of}`) });
    const groups = st.via === 'wallet' ? [notes] : notes.map((n) => [n]);
    const placed = [];
    for (let k = 0; k < groups.length; k++) {
      const g = groups[k], tag = (m) => step(groups.length > 1 ? `part ${k + 1} of ${groups.length}: ${m}` : m);
      try {
        const intent = callIntent({
          calls: g.map((n) => intentCall({ target: n.pool.address, value: n.pool.denomination, data: n.call.data })),
          refund: await env.refundBox(), deadline: BigInt((await env.clock()) + 3600), nonce: rnd(),
        });
        const amount = g.reduce((t, n) => t + n.pool.denomination, 0n), gas = intakeGas(g.length);
        const maxFee = st.via === 'wallet' ? null : ((await env.relayFee(gas)) * 5n) / 4n;
        // The pool, not the send's answer, says whether the notes are made: a relay's answer can be slow (a mainnet canary waited twelve minutes for one) or
        // lost though its transaction landed in a minute. So the pool is watched while the send is pending: the notes landing ends the wait, a send that
        // fails is believed only if they did not land, and what a send says after that is not shown.
        let live = true, sendErr = null, stop = false, settled = false;
        const sending = env.send({ intent, amount, gas, maxFee, via: st.via === 'wallet' ? 'self' : 'relay', onStep: (m) => { if (live) tag(m); } })
          .then(() => 'sent', (e) => { sendErr = e; return 'failed'; }).finally(() => { settled = true; });
        const watching = (async () => {
          while (!stop) {
            // one failed read must not end the wait (and fail the spend that is still going): ask again
            try { if ((await flow.landedNotes(g, { wait: false })).length === g.length) return 'landed'; } catch { /* ask again */ }
            await new Promise((r) => setTimeout(r, WATCH_MS));
          }
          return 'stopped';
        })();
        const first = await Promise.race([sending, watching]);
        stop = true;
        if (first === 'landed') live = false;
        const landed = await flow.landedNotes(g);
        live = false;
        placed.push(...landed);
        if (landed.length !== g.length) {
          if (sendErr) throw new Error(`${env.errText(sendErr)} If it was sent after all, Look for notes will show the note once it lands.`);
          throw new Error('The spend went through but the deposit is not in the pool yet. Look for notes will show it in a minute.');
        }
        // The notes are in the pool but the send has not answered: the next spend must not start while this one may still be using the same private
        // notes (two spends of them at once). Give it a moment, and stop here if it is still out.
        if (!settled && k < groups.length - 1) {
          await Promise.race([sending, new Promise((r) => setTimeout(r, env.sendGraceMs ?? SEND_GRACE_MS))]);
          if (!settled) throw new Error('The relay has not answered for the last note, so the others were not started: starting them now could spend the same funds twice. Look for notes lists what has landed.');
        }
      } catch (e) {
        if (placed.length) writeNotes(env.store, chainId, env.account(), [...readNotes(env.store, chainId, env.account()), ...placed.map(metaOf)]);
        throw new Error(placed.length ? `${placed.length} of ${notes.length} notes ${placed.length === 1 ? 'is' : 'are'} in the large ${placed.length === 1 ? 'pool' : 'pools'}. The next did not go: ${env.errText(e)}` : env.errText(e));
      }
    }
    writeNotes(env.store, chainId, env.account(), [...readNotes(env.store, chainId, env.account()), ...placed.map(metaOf)]);
    st.amount = '';
    env.say(`${notes.length === 1 ? 'The note is' : 'The notes are'} in the large ${notes.length === 1 ? 'pool' : 'pools'} (${formatEther(total)} ETH), made from your private balance. Look for notes lists ${notes.length === 1 ? 'it' : 'them'} under Withdraw.`);
    env.onMade?.();
  }
  quote();
  paint();
  return { repaint: paint, requote: quote, get via() { return st.via; } };
}


// The deposit-address row of the exchange-deposit panel (Ethereum): the owner's primary name can carry the deposit address,
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
