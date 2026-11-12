// Trading an asset on Bitcoin from the trade page (TAC's market, and tETH's when it has one): the market page's own module (btc-market.js: the order book, the ticket, your orders) with the
// executors and the book's data from tacit.js, mounted in a sheet. The module plans and tacit.js settles; this file supplies what the classic
// app supplies around them and a page like this one does not have: signing in, a confirmation, a notice, the sats and TAC the key holds,
// and where a purchase that stopped halfway is recovered. Nothing here builds or signs a transaction.
import { makeBtcSession, short } from '/trade/btc-session.js?cb=bf1ce674';
import { overlay, esc } from '/trade/sheet.js?cb=c8f387a5';
import { signInSheet, pickWalletSheet } from '/trade/sign-in.js?cb=5c1bc20a';

const MARKET_URL = '/btc-market.js?cb=62f95e6b', CSS_URL = '/trade/btc-market.css?cb=359753e6';
const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
// The asset a sheet trades: its id, its title, and the line under the market about getting it onto Bitcoin. TAC's, unless the page names another.
const TAC_ASSET = { id: TAC, title: 'TAC on Bitcoin', after: 'To sell TAC you hold on Ethereum, bridge it to Bitcoin first. <a href="/#bridge">Bridge →</a>' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `wallet()` names the Ethereum wallet the page has connected ({ uuid, address }, or null), so opening the Tacit key can use that same wallet
// without asking again which one. `onChange` hears when the key opens or locks and when the sats and TAC it holds are read again.
// `purpose` finishes the sign-in sheet's first line; `prefer: 'btc'` puts a Bitcoin wallet first when the browser has one and no Tacit wallet was opened here before.
export function makeBitcoin({ notify = () => {}, onTraded = () => {}, onChange = () => {}, wallet = () => null, asset = TAC_ASSET, purpose = 'trade on Bitcoin', prefer = '' } = {}) {
  const AID = asset.id;
  const session = makeBtcSession({ moved: (why) => { session.lock(); meState = null; ctl?.refresh?.({ soft: true }); notify(why); } });
  let main = null, host = null, ctl = null, meState = null, meTimer = 0, off = null;
  const changed = () => { try { onChange(); } catch { /* the page's listener must not break the market */ } };
  session.onChange(() => { if (!session.unlocked) meState = null; changed(); });

  // ── signing in ──
  // The sheet is the shared one (trade/sign-in.js). The Ethereum wallet this page has connected signs with no choice to make, and a Bitcoin wallet leads
  // when `prefer` says so, the browser has one, no Tacit wallet was opened here before and no Ethereum wallet is connected.
  function signIn() {
    const here = wallet(), btcFirst = prefer === 'btc' && session.btcSeen() && !session.known() && !here;
    return signInSheet(session, {
      pick: pickWalletSheet, first: btcFirst ? 'btc' : 'eth', here,
      why: `Open your Tacit wallet to ${purpose}. It comes from a signature or a passkey, so there is nothing to back up, and it stays open in this tab only, until you close it, lock it, or leave the site idle for 30 minutes.`,
    });
  }
  // Which Ethereum wallet signs: the one connected on this page when the key being opened is its account's (or any account's), else the visitor chooses
  // among the browser's wallets (WalletConnect is announced beside them here, so a choice is always on offer).
  function pickFor(k) {
    const here = wallet();
    return here?.uuid && (!k?.address || String(k.address).toLowerCase() === here.address.toLowerCase()) ? async () => here.uuid : pickWalletSheet;
  }
  // The Tacit key from the wallet already connected on this page: its signature, for that account only, with no wallet to choose.
  function openWithPage() {
    const here = wallet();
    if (!here) throw new Error('Connect an Ethereum wallet on this page first.');
    return session.open.eth({ address: here.address }, pickFor({ address: here.address }));
  }
  // The market module's unlock: a key already open is used as it is.
  // Two asks at once (a double click, or the module and a recovery) share one prompt.
  let signing = null;
  function unlock() {
    return (signing ||= (async () => {
      await session.load();
      if (session.unlocked) return;
      await signIn();
      await refreshMe();
    })().finally(() => { signing = null; }));
  }

  // ── what the module asks the page for ──
  function confirmDialog({ title = 'Confirm', body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', hideCancel = false } = {}) {
    return new Promise((resolve) => {
      let answered = false;
      const done = (v) => { if (!answered) { answered = true; resolve(v); } };
      const o = overlay({ title, top: true, onClose: () => done(false) });
      o.body.innerHTML = `<p style="white-space:pre-line;margin:0 0 16px">${esc(body)}</p><div class="bsheet-actions">${hideCancel ? '' : `<button class="btn ghost" type="button" data-no>${esc(cancelLabel)}</button>`}<button class="btn" type="button" data-yes>${esc(confirmLabel)}</button></div>`;
      o.body.querySelector('[data-yes]').onclick = () => { done(true); o.close(); };
      o.body.querySelector('[data-no]')?.addEventListener('click', () => { done(false); o.close(); });
    });
  }
  // The sheet runs for as long as it watches the address and nobody waits on it: whatever goes wrong inside is not a page's error.
  const fund = (opts) => { fundDialog(opts).catch(() => {}); };
  // A Bitcoin wallet to send sats from, connected for that alone: the Tacit key is not changed, and the records of which wallet is open are put back.
  async function connectExt() {
    await session.load();
    return session.turn(async () => {
      const x = session.T.extWallet;
      if (!x.state) {
        const st = await x.connectDefault();
        if (!/^(bc1|[13])/i.test(String(st?.address || ''))) { x.state = null; throw new Error('Your Bitcoin wallet is on a test network. Switch it to mainnet.'); }
      }
      return x;
    });
  }
  // The sheet that gets sats to the key's Bitcoin address. `sats`: how many the page is short of, and `need`: how many the address must hold; `fiat(n)`: what n sats
  // are worth, as text. A Bitcoin wallet in the browser sends them in one confirmation, whichever way the Tacit key was opened; anything else scans the code, opens a
  // wallet app, or copies the address. The sheet watches the address and closes when the sats show.
  async function fundDialog(opts) {
    const addr = session.address, lack = Number(opts?.sats) || 0, need = Number(opts?.need) || 0, fiat = typeof opts?.fiat === 'function' ? opts.fiat : () => '';
    const o = overlay({ title: 'Add sats', top: true });
    if (!addr) { o.body.innerHTML = '<p style="margin:0">Open your Tacit wallet first. The address belongs to the wallet you open.</p>'; return; }
    const send = lack > 0 ? Math.max(Math.ceil((lack + 1000) / 500) * 500, 5000) : 0;
    const connected = session.key?.mode === 'btc' && !!session.T?.extWallet?.state;
    const money = (n) => { const f = fiat(n); return `${n.toLocaleString('en-US')} sats${f ? ` (${f})` : ''}`; };
    const uri = `bitcoin:${addr}${send ? `?amount=${(send / 1e8).toFixed(8)}` : ''}`;
    o.body.innerHTML = `<p style="margin:0 0 12px">${send ? `Send about ${esc(money(send))}` : 'Send sats'} to your Tacit wallet’s Bitcoin address, from any Bitcoin wallet or exchange.</p>
      ${send && (connected || session.btcSeen()) ? `<button class="btn" type="button" data-send>Send ${esc(money(send))} from ${connected && session.T.extWallet.state.provider === 'unisat' ? 'UniSat' : 'your Bitcoin wallet'}</button>` : ''}
      <div style="display:flex;gap:14px;align-items:center;margin:14px 0 4px"><span data-qr style="flex:none;line-height:0"></span><p class="addr" style="margin:0;min-width:0"><code>${esc(addr)}</code></p></div>
      <div class="bsheet-actions"><button class="btn ghost" type="button" data-copy>Copy address</button><a class="btn ghost" href="${esc(uri)}" data-open>Open in a wallet app</a></div>
      <p class="note" data-st role="status" style="margin:12px 0 0">Waiting for the sats to arrive…</p>`;
    const st = o.body.querySelector('[data-st]'), say = (t) => { st.textContent = t; };
    import('/qr.js?cb=7ca24213').then(({ qrSvg }) => { const q = o.body.querySelector('[data-qr]'); if (q && !o.closed) q.innerHTML = qrSvg(uri, 148, 'QR code of your Tacit wallet’s Bitcoin address'); }).catch(() => {});
    const c = o.body.querySelector('[data-copy]');
    c.onclick = () => navigator.clipboard?.writeText(addr).then(() => { c.textContent = 'Copied'; }, () => { c.textContent = 'Could not copy'; });
    const b = o.body.querySelector('[data-send]');
    if (b) b.onclick = async () => {
      b.disabled = true; say('Confirm it in your wallet…');
      try {
        const x = connected ? session.T.extWallet : await connectExt();
        await x.sendSats(addr, send);
        say('Sent. Waiting for Bitcoin to show it…');
      } catch (e) {
        const m = e?.message || String(e);
        say(/reject|cancel|denied|declin/i.test(m) ? 'Nothing was sent.' : `Could not send: ${m}`);
        b.disabled = false;
      }
    };
    // the address is watched for as long as the sheet is open (half an hour): sats from a wallet, a phone or an exchange all end it the same way
    const read = async () => { const u = await session.T.getUtxos(addr).catch(() => null); return Array.isArray(u) ? u.reduce((a, x) => a + (Number(x.value) > 546 ? Number(x.value) : 0), 0) : null; };
    let base = await read();
    for (let i = 0; i < 360 && !o.closed; i++) {
      await sleep(5000);
      const now = await read();
      if (now == null) continue;
      if (base == null || now <= base) { base = base == null ? now : Math.min(base, now); continue; }
      const got = now - base; base = now;
      await refreshMe().catch(() => {});                                            // a read that fails is not sats that did not arrive: it is tried again
      const have = meState?.sats ?? 0;
      if (!need || have >= need) { say(`Received ${got.toLocaleString('en-US')} sats.`); await sleep(900); o.close(); return; }
      say(`Received ${got.toLocaleString('en-US')} sats. About ${(need - have).toLocaleString('en-US')} more are needed.`);
    }
  }
  // A purchase that stopped after its commit went out holds sats until they are swept back; the record that sweeps them is in this browser.
  async function recovery(err) {
    const msg = err?.message || String(err || '');
    if (!/Commit tx broadcast|locked at|recovery record/.test(msg)) return;
    const m = /locked at ([0-9a-f]{64}):0/i.exec(msg);
    if (!m) { notify('The purchase stopped after its first transaction. The sats it holds can be recovered in the classic app, under Holdings.', 'error', 12000); return; }
    const v = /(?:Commit tx broadcast — |locked\s+)(\d+)\s*sats/i.exec(msg), sats = v ? Number(v[1]) : 0;
    const yes = await confirmDialog({
      title: 'Purchase stopped · sats recoverable',
      body: `The purchase stopped after its first transaction. The ${sats.toLocaleString('en-US')} sats it holds are not lost: one more transaction (small fee) returns them to your wallet. You can also recover them later in the classic app, under Holdings.`,
      confirmLabel: `Recover ${sats.toLocaleString('en-US')} sats now`, cancelLabel: 'Later',
    });
    if (!yes) return;
    try {
      if (!session.unlocked) await unlock();                                                // tacit.js would otherwise open the classic app's own wallet prompt
      const r = await session.T.recoverPreauthCommit(m[1].toLowerCase());
      notify(`Recovered ${Number(r.recovered_sats).toLocaleString('en-US')} sats (sweep fee ${r.fee_sats} sats).`, 'success', 9000);
      await refreshMe(); ctl?.refresh?.({ soft: true });
    } catch (e) { notify(`Could not recover them: ${e?.message || e}. They stay recoverable in the classic app, under Holdings.`, 'error', 12000); }
  }

  // The sats at the key's address and the TAC it holds, which the module reads synchronously through ctx.me().
  // The sats are read quickly and this returns once they are in; the TAC takes a walk through the key's history (up to a minute and a half) and follows
  // behind, the sheet and the page being told again when it arrives. So signing in, opening the sheet and a fill never wait for the walk. A balance
  // read before a trade is not shown as if it were current: `blank` drops the TAC until the walk has read it again.
  // The sats are what the executors can spend: the coins that carry TAC (or sit in the dust band, where they are) are not counted, as they are not spent.
  const DUST = 546;
  const spendable = (utxos, holdings) => {
    const keep = new Set();
    if (holdings instanceof Map) {
      const add = (x) => { const t = x?.utxo?.txid || x?.txid, v = x?.utxo?.vout ?? x?.vout; if (t != null) keep.add(`${t}:${v}`); };
      for (const h of holdings.values()) for (const k of ['utxos', 'ghosts', 'inflated', 'pending', 'unverified']) for (const x of (h[k] || [])) add(x);
      for (const k of (holdings.unclassified || [])) keep.add(k);
    }
    return utxos.reduce((a, u) => a + (Number(u.value || 0) > DUST && !keep.has(`${u.txid}:${u.vout}`) ? Number(u.value) : 0), 0);
  };
  let meSeq = 0;
  async function refreshMe({ blank = false } = {}) {
    const seq = ++meSeq;                                                                    // a read that began later is the one to keep: an older, slower one must not put its balance over it
    if (!session.unlocked) { meState = null; changed(); return; }
    const T = session.T, my = session.key;
    if (meState?.pubHex !== my.pubHex) { meState = { pubHex: my.pubHex, h160: T.bytesToHex(T.hash160(T.wallet.pub)), unlocked: true, sats: null, assetBase: null, address: T.wallet.address() }; changed(); ctl?.refresh?.({ soft: true }); }      // no state reads as no wallet: the sheet shows the key open, its balance being checked, while the explorers answer
    const holdingsP = T.scanHoldings().catch(() => null);
    const utxos = await T.getUtxos(T.wallet.address()).catch(() => null);
    if (session.key !== my || seq !== meSeq) return;                                       // the key changed while this was read, or a newer read began
    const raw = Array.isArray(utxos) ? utxos : null, kept = !blank && meState?.pubHex === my.pubHex ? meState.assetBase : null;
    meState = {
      pubHex: my.pubHex, h160: T.bytesToHex(T.hash160(T.wallet.pub)), unlocked: true,
      sats: raw ? spendable(raw, null) : null,
      assetBase: kept, address: T.wallet.address(), bridged: meState?.pubHex === my.pubHex ? meState.bridged : undefined,
    };
    changed(); ctl?.refresh?.({ soft: true });
    T.bridgedAtTaproot().then((b) => { if (session.key !== my || !meState || seq !== meSeq || b.count == null || meState.bridged === b.count) return; meState = { ...meState, bridged: b.count }; changed(); ctl?.refresh?.({ soft: true }); }).catch(() => {});
    holdingsP.then((holdings) => {
      if (session.key !== my || !meState || seq !== meSeq) return;
      const h = holdings instanceof Map ? holdings.get(AID) : null;
      meState = { ...meState, sats: raw && holdings instanceof Map ? spendable(raw, holdings) : meState.sats, assetBase: h && typeof h.balance === 'bigint' ? h.balance : (holdings ? 0n : kept) };
      changed(); ctl?.refresh?.({ soft: true });
    });
  }
  // Opens the key with the page's wallet and reads what it holds, with no sheet: the page's own panels show the result.
  let opening = null;
  function openHere() {
    return (opening ||= (async () => {
      await session.load();
      if (!session.unlocked) await openWithPage();
      await refreshMe();
    })().finally(() => { opening = null; }));
  }

  // The asset's ticker and decimals come with the market data, and the module reads them once when it mounts, so the data is loaded first.
  async function buildCtx() {
    const T = session.T;
    if (typeof T._btcMarketCtx !== 'function') throw new Error('the wallet library served to this browser is older than the page: reload in a minute');
    await T._btcMarketCtx(AID).loadListings();
    const base = T._btcMarketCtx(AID);
    if (!base.asset()?.ticker || base.asset().ticker === '?') throw new Error('the market data did not load');
    const logo = (h) => (typeof h === 'string' ? h.replace('src="tac-logo.png"', 'src="/tac-logo.png"') : h);      // tacit.js names the logo relative to the classic app's address
    const settled = (fn, kind) => async (...a) => { try { await fn?.(...a); } finally { try { await refreshMe({ blank: true }); } catch { /* the next refresh reads it */ } onTraded({ kind, ...(a[0] || {}) }); } };       // the sats are read again at once and the TAC behind, so the next fill is not held for a walk
    return {
      ...base,
      mountEth: null, initialLane: 'btc', onLane: null,
      asset: () => { const a = base.asset(); return { ...a, iconHtml: logo(a.iconHtml), identityHtml: logo(a.identityHtml) }; },
      me: () => meState,
      friendlyError: (...a) => { const m = base.friendlyError?.(...a); return typeof m === 'string' ? m.replace('retry with the Swap tile or pick another row', 'try again or pick another row') : m; },      // the classic app's wording names a tile this sheet does not have
      unlock, feeRate: () => T.getFeeRate(), fundSats: (o) => fund({ fiat: (n) => { const px = Number(base.btcUsd?.() || 0); return px > 0 ? `$${((n / 1e8) * px).toFixed(2)}` : ''; }, ...(o || {}) }),
      confirm: confirmDialog,
      toast: (m, k, ms) => notify(m, k, ms),
      onError: (e) => { recovery(e).catch(() => {}); },
      goBack: () => main?.close(),
      onAct: () => {},
      after: { bought: settled(base.after.bought, 'bought'), sold: settled(base.after.sold, 'sold'), listed: settled(base.after.listed, 'listed') },
    };
  }

  // ── the sheet ──
  // Which key is open, with a way to lock it, beside the close button.
  function paintHead() {
    const head = main?.root.querySelector('.bsheet-head');
    if (!head) return;
    let who = head.querySelector('.who');
    if (!who) { who = document.createElement('span'); who.className = 'who'; head.insertBefore(who, head.querySelector('.x')); }
    who.innerHTML = session.unlocked ? `<span class="mute" title="The Bitcoin address of your Tacit wallet">${esc(short(session.address, 6))}</span><button class="linkbtn" type="button" data-lock>Lock</button>` : '';
    who.querySelector('[data-lock]')?.addEventListener('click', () => { session.lock(); meState = null; ctl?.refresh?.({ soft: true }); });
  }
  let cssP = null;
  const ensureCss = () => (cssP ||= new Promise((res) => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = CSS_URL;
    l.onload = l.onerror = () => res(); document.head.append(l);
  }));
  function destroy() { try { ctl?.destroy?.(); } catch { /* it is going away */ } ctl = null; host = null; main = null; clearInterval(meTimer); off?.(); off = null; }
  // `prime` sets the ticket once the book has loaded: { side, type, receiveBase, sellBase, spendSats }, or { side, type: 'market', atUnit, flag } for a row of the
  // page's ladder (the price it names: the ticket takes everything up to it, within a limit that reaches it, as a press on the sheet's own row does). A sheet that was closed while it loaded
  // (and maybe opened again) is not mounted into: each step checks that it is still the current one.
  async function open(prime = null) {
    if (main) { if (prime) await primeWhenReady(prime); return; }
    const mine = overlay({ title: asset.title, wide: true, onClose: () => { if (main === mine) destroy(); } });
    main = mine;
    const box = document.createElement('div'); box.className = 'bm-skin'; box.innerHTML = '<p class="note">Loading the Bitcoin market…</p>';
    mine.body.append(box); host = box;
    try {
      await Promise.all([session.load(), ensureCss()]);
      const market = await import(MARKET_URL);
      if (main !== mine) return;
      await refreshMe();
      const ctx = await buildCtx();
      if (main !== mine) return;
      box.replaceChildren();
      ctl = market.mountBtcMarket(box, ctx);
      meTimer = setInterval(() => { if (!document.hidden && session.unlocked) refreshMe().then(() => ctl?.refresh?.({ soft: true })).catch(() => {}); }, 45e3);
      off = session.onChange(() => { paintHead(); refreshMe().then(() => ctl?.refresh?.({ soft: true })).catch(() => {}); });
      box.insertAdjacentHTML('beforeend', `<p class="note bm-after">${asset.after}</p>`);
      paintHead();
      if (prime) await primeWhenReady(prime);
    } catch (e) {
      if (main === mine) box.innerHTML = `<p class="err">Could not load the Bitcoin market: ${esc(e?.message || e)}</p>`;
    }
  }
  // The market redraws itself as the key's balance and orders arrive, which can put the scroll back: the node is brought into view again, for a few seconds, if it has left (it may sit near the bottom of the sheet, where it cannot reach the top).
  async function bringIntoView(node) {
    const inView = () => { const r = node.getBoundingClientRect(), s = main?.root.getBoundingClientRect(); return !!s && node.isConnected && r.top >= s.top - 4 && r.bottom <= s.bottom + 4; };
    for (const wait of [0, 600, 1500, 3500]) {
      await sleep(wait);
      if (!main || !node.isConnected) return;
      if (!inView()) node.scrollIntoView({ block: 'start' });
    }
  }
  // `focus: 'orders'` brings the visitor's own orders into view once the market shows them (they show when the key is open and has any: a visitor who
  // has to sign in first is waited for, for a minute).
  async function primeWhenReady(opts) {
    for (let i = 0, max = opts.focus === 'orders' ? 400 : 80; i < max; i++) {
      if (!main) return;
      if (!ctl) { await sleep(150); continue; }                                                // the sheet is still loading: a press made meanwhile is kept for it
      if (opts.focus === 'orders') { const o = host?.querySelector('[data-k="orders"]'); if (o && !o.hidden) { await bringIntoView(o); return; } }
      else if (ctl.state?.loadedOnce) { const set = opts.atUnit != null && opts.type === 'market' && ctl.primeAt ? ctl.primeAt(opts.side === 'sell' ? 'bid' : 'ask', opts.atUnit, opts.flag) : false; if (set === false) ctl.prime(opts); return; }       // a book with nothing at that price is set by the amount
      await sleep(150);
    }
  }
  return {
    open, session, recovery, get isOpen() { return !!main; },
    openHere, refresh: refreshMe, fund, signIn: unlock,
    get me() { return meState; },
    lock() { session.lock(); meState = null; ctl?.refresh?.({ soft: true }); changed(); },
  };
}
