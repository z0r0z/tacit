import { makeConnect } from '/trade/connect.js?cb=514272b7';
import { esc } from '/trade/sheet.js?cb=d857446c';
import { $, rpc } from '/trade/util.js?cb=9c8b4133';
import { readSpot, readPrecision } from '/trade/farm-read.js?cb=fb6ec72f';
import { makeEvmTradeVenues, ZROUTER } from '/evm-trade-venues.js?cb=9aac0fac';
import { SHOP, MARKET, TAC, TAC_NAME, FROM_BLOCK, TOPICS, foldShelf, sortShelf, filterShelf, zeroTiers, zerosOf, zerosText, zeroBits, addressParts, tacText, usdText, priceUsd, tacUsdFrom, tokenNumber,
  tokenUrl, buyData, buyWithPermitData, approveData, listingsData, balanceOfData, allowanceData, noncesData, ownerOfData, addressOfData, deployData, initcodeOf, parseTokenId, soldTo, forwarderInit,
  forwardRefusal, decodeAddress, decodeListing, decodeWord, refusalWords, deployRefusal, deployFailed, ETH_AT_DEPLOY_ADDRESS, badRecipient, isAddress, ZAP, ZAP_MARGIN_BPS, buyWithEthData, retryAmountIn, pickVenue, ethText } from '/shop/shelf.js?cb=0182afe8';

// The shop's shelf (contracts/src/VanityShop.sol): addresses that start with zeros, each a token the buyer can deploy a contract to on Ethereum. The page reads the shelf
// from the shop's events, checks the one a buyer picks against the shop again, and sends one transaction: the buy, with a TAC permit signed first when the shop has no
// allowance. The shop holds nothing: the TAC goes to its treasury and the token to the address the buyer names, in the same transaction. What a buyer is left with (the token)
// is in its own panel above the list, and the section at the bottom puts a contract at an address a wallet holds: neither is drawn by the list's refresh.
// Where TAC is bought: the front page's swap, with ETH to TAC already chosen (its own "Buy TAC" button opens the same one).
const BUY_TAC_URL = '/?from=ETH&to=TAC';
const BUY_TAC = `<a href="${BUY_TAC_URL}">Buy TAC</a>`;
const S = { shelf: [], logs: [], loaded: false, failed: false, bal: null, busy: null, note: '', bad: false, noteAt: null, to: '', done: null, tacUsd: null, tacEth: null, ethUsd: null, zeros: null, q: '' };
// the section at the bottom: the addresses this wallet holds, and what to put at the one chosen (a contract that passes ETH on, or the bytecode someone pastes)
const U = { tokens: [], sel: '', otherId: '', kind: 'forward', to: '', init: '', busy: false, note: '', bad: false, result: null };
const hex = (n) => '0x' + n.toString(16);
// the note is under the row that was pressed (S.noteAt), or at the foot of the list when that row is gone: a note said after a press is brought into view if it is not
const say = (text, bad = false) => { S.note = text; S.bad = bad; paintNote(); if (text && S.noteAt) revealNote(); };
const pressed = (id) => { if (S.noteAt !== id) { S.noteAt = id; S.note = ''; S.bad = false; render(); } };
const reveal = (el) => {
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) el.scrollIntoView?.({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
};
const revealNote = () => reveal($('#note'));
// a token's mark beside an amount, as on the other pages: the TAC coin in the shop's own sprite, the standard ETH mark for the way to pay with ETH
const TAC_MARK = '<svg class="tk xs inl" aria-hidden="true"><use href="#tk-tac"/></svg>';
const ETH_MARK = '<svg class="tk" aria-hidden="true"><use href="#tk-eth"/></svg>';
const conn = makeConnect({
  describe: 'Buy an address that starts with zeros, for TAC', name: 'tacit shop', rewards: false,
  say: (t, b) => say(t, b), busy: () => !!S.busy,
  onChange: () => { S.bal = null; S.to = ''; U.tokens = []; U.result = null; U.note = ''; render(); renderAfter(); renderUse(); readBalance(); readTokens(); },
});
const W = conn.W;
$('#wallet-chip').hidden = false;

// ── reading ──
async function logsBetween(from, to) {
  try { return await rpc('eth_getLogs', [{ address: SHOP, fromBlock: hex(from), toBlock: hex(to), topics: [Object.values(TOPICS)] }]); }
  catch (e) {
    if (to - from < 2000) throw e;       // a node that will not give a long range gives a short one
    const mid = Math.floor((from + to) / 2);
    return [...await logsBetween(from, mid), ...await logsBetween(mid + 1, to)];
  }
}
async function readShelf() {
  try {
    const head = Number(BigInt(await rpc('eth_blockNumber', [])));
    S.logs = await logsBetween(FROM_BLOCK, head);
    S.shelf = sortShelf(foldShelf(S.logs));
    S.loaded = true; S.failed = false;
  } catch { S.failed = true; }
  render();
  if (W.account) readTokens();
}
async function readBalance() {
  const who = W.account;
  if (!who) return;
  try { const b = decodeWord(await rpc('eth_call', [{ to: TAC, data: balanceOfData(who) }, 'latest'])); if (who === W.account) { S.bal = b; render(); } } catch { /* the balance is a convenience: a buy checks it again */ }
}
// The addresses this wallet holds from the shop: the shop's sales to it, kept to the ones the market still shows it as the owner of (one that was used no longer is).
let readingTokens = false;
async function readTokens() {
  const who = W.account;
  if (!who || readingTokens) return;
  readingTokens = true;
  try {
    const ids = soldTo(S.logs, who).slice(0, 40), found = [];
    await Promise.all(ids.map(async (id) => {
      try {
        if (decodeAddress(await rpc('eth_call', [{ to: MARKET, data: ownerOfData(id) }, 'latest'])) !== who.toLowerCase()) return;
        const vanity = decodeAddress(await rpc('eth_call', [{ to: MARKET, data: addressOfData(id) }, 'latest']));
        if (vanity) found.push({ id, vanity, bits: zeroBits(vanity) });
      } catch { /* used, or not readable now */ }
    }));
    if (who !== W.account) return;
    found.sort((a, b) => b.bits - a.bits || (a.id < b.id ? -1 : 1));
    // a purchase just made is shown at once, before the logs have it: it stays until the logs do
    const fresh = U.tokens.filter((t) => !ids.includes(t.id));
    const next = [...fresh, ...found], changed = next.map((t) => t.id).join() !== U.tokens.map((t) => t.id).join();
    U.tokens = next;
    if (U.sel && U.sel !== 'other' && !U.tokens.some((t) => t.id === U.sel)) U.sel = '';      // '' is no choice made: the first address, or the field for an id when there is none
    if (changed) renderUse();
  } finally { readingTokens = false; }
}
// TAC's price in dollars, read the way the rest of the site reads it (the Precision pool's price and Chainlink's ETH price): the list shows it beside the TAC price. A price that
// cannot be read leaves the list in TAC alone, and one that cannot be read again keeps the last good one.
async function readPrice() {
  const call = ({ to, data }) => rpc('eth_call', [{ to, data }, 'latest']);
  try {
    const [px, f] = await Promise.all([readSpot((calls) => Promise.all(calls.map((c) => call(c).catch(() => null)))), readPrecision(call).catch(() => null)]);
    const p = tacUsdFrom({ ethUsd: px?.ethUsd, tacEth: f?.tacEth });
    if (p) { S.tacUsd = p; S.tacEth = f.tacEth; S.ethUsd = px.ethUsd; }
  } catch { /* the dollar figure is a convenience */ }
  render();
}

// ── buying ──
// What a purchase leaves: the bought panel, and the address offered at once at the bottom, before the logs have the sale.
function finishBuy({ hash, id, row, to, who }) {
  S.done = { hash, id, vanity: row.vanity, nonce: row.nonce, to, price: row.price }; S.noteAt = null;
  if (to.toLowerCase() === who.toLowerCase()) { U.tokens = [{ id, vanity: row.vanity, bits: row.bits }, ...U.tokens.filter((t) => t.id !== id)]; U.sel = id; U.result = null; U.note = ''; renderUse(); }
  say('');
  // the result is drawn above the list by the caller, right after this returns, and the buyer may be far down the list: it is brought into view
  setTimeout(() => reveal($('#after')), 0);
}
const txLink = (hash) => (/^0x[0-9a-fA-F]{64}$/.test(String(hash)) ? ` <a href="https://etherscan.io/tx/${hash}" target="_blank" rel="noopener noreferrer">See it on Etherscan</a>.` : '');
async function buy(id) {
  const row = S.shelf.find((x) => x.id === id);
  if (!row || S.busy) return;
  pressed(id);
  if (!W.account) { await conn.connect(); return; }
  const to = (S.to || W.account).trim();
  if (!isAddress(to) || badRecipient(to)) { say('Name an address to send the token to. It cannot be this shop, the market, TAC or the swap contracts.', true); return; }
  S.busy = id; S.done = null; render(); renderAfter(); say('Checking it is still for sale.');
  let hash = null;
  try {
    // the list may be a block or two old: the shop's own answer decides
    const cur = decodeListing(await rpc('eth_call', [{ to: SHOP, data: listingsData(id) }, 'latest']));
    if (!cur || cur.price === 0n) { say('That one is gone. The list is updated.', true); await readShelf(); return; }
    if (cur.nonce !== row.nonce || cur.price !== row.price) { say('Its price changed. The list is updated; look again.', true); await readShelf(); return; }
    const who = W.account, call = (data, to2) => rpc('eth_call', [{ to: to2, data }, 'latest']);
    const bal = decodeWord(await call(balanceOfData(who), TAC));
    if (bal === null || bal < row.price) {
      const offer = await zapOffer(row, who);
      const dollars = offer && S.ethUsd ? ` (≈ ${usdText((Number(offer.amountIn) / 1e18) * S.ethUsd)})` : '';
      const holds = `You hold ${bal === null ? 'no readable' : tacText(bal)} TAC. This one costs ${tacText(row.price)}.`;
      // with the ETH way offered this is not an error but a choice: the button is in the note's own colour, with the ETH mark
      say(offer
        ? `${holds} <span class="ways"><button class="btn ghost" type="button" data-zap="${esc(id)}">${ETH_MARK}Pay about ${esc(ethText(offer.amountIn))} ETH${esc(dollars)}</button> <span class="alt">One transaction · ${BUY_TAC}</span></span>`
        : `${holds} ${BUY_TAC}`, !offer);
      return;
    }
    const deadline = Math.floor(Date.now() / 1000) + 20 * 60, args = { id, to, nonce: row.nonce, maxPrice: row.price, deadline };
    let data;
    if ((decodeWord(await call(allowanceData(who, SHOP), TAC)) ?? 0n) >= row.price) data = buyData(args);
    else {
      const nonce = decodeWord(await call(noncesData(who), TAC));
      if (nonce === null) throw new Error('TAC did not answer. Try again in a moment.');
      say('Sign the TAC permit in your wallet. It lets the shop take this price and nothing more.');
      try { data = buyWithPermitData({ ...args, ...await conn.wallet.signPermit({ token: TAC, name: TAC_NAME, spender: SHOP, value: row.price, deadline, nonce, owner: who }) }); }
      catch (e) {
        if (e?.userStopped || e?.code === 4001 || /account changed/i.test(e?.message || '')) throw e;
        // a wallet that cannot sign a permit (a smart-contract account, or one without typed-data signing): the approval goes first, then the buy needs no signature
        say('Your wallet cannot sign a permit. Approve this price for the shop in your wallet.');
        const ok = await conn.wallet.receipt(await conn.wallet.sendTx({ to: TAC, data: approveData(SHOP, row.price), from: who }));
        if (ok.status !== '0x1') throw new Error('The approval did not go through.');
        data = buyData(args);
      }
    }
    // the same call, made as a read: a refusal the shop would give is said here, before the wallet is asked to send anything
    say('Checking the purchase before it is sent.');
    try { await rpc('eth_call', [{ from: who, to: SHOP, data }, 'latest']); }
    catch (e) {
      if (!e?.revert) throw new Error('Could not reach the network to check this. Nothing was sent.');
      say(`${refusalWords(e.data) || 'The shop would refuse this.'} Nothing was sent. The list is updated.`, true); await readShelf(); return;
    }
    say('Confirm the purchase in your wallet.');
    hash = await conn.wallet.sendTx({ to: SHOP, data, from: who });
    say('Sent. Waiting for it to be confirmed.');
    const r = await conn.wallet.receipt(hash);
    if (r.status !== '0x1') { say(`It did not go through, and nothing was taken.${txLink(hash)}`, true); return; }
    finishBuy({ hash, id, row, to, who });
  } catch (e) {
    if (hash) say(`Sent, not confirmed yet.${txLink(hash)} Check it there before buying again.`, true);
    else say(esc(e?.message || 'It did not go through.'), true);
  } finally { S.busy = null; render(); renderAfter(); readShelf(); readBalance(); }
}

// ── paying with ETH ──
// ShopZap (contracts/src/ShopZap.sol) takes the ETH, swaps it into TAC through zRouter with the call built here (the legs the TAC tile builds, with the zap as the buyer and the
// receiver of the TAC) and buys the address in the same transaction. The page finds the ETH that buys the price with a small margin over (the pool's quote for an amount, scaled
// until it pays that), makes the whole call as a read first, and only then asks the wallet. The swap is held to the price itself, so a pool that moved too far reverts it all.
const venues = makeEvmTradeVenues({ ethCall: (to, data, block = 'latest') => rpc('eth_call', [{ to, data }, block]) });
let zapLive = null;
async function zapOn() {
  if (!ZAP) return false;
  if (zapLive === null) { try { zapLive = (await rpc('eth_getCode', [ZAP, 'latest'])) !== '0x'; } catch { return false; } }
  return zapLive;
}
// The pool is chosen as the front page's swap chooses it for ETH to TAC (shelf.js pickVenue): the Precision pool unless the Tacit AMM pays over a percent more, and the one that
// answers when the other does not, so a pool that is down does not take the offer with it. `skip` names pools whose call was refused when it was read (zapBuy tries the other).
// A split between the two is not tried: it costs about 116,000 gas more, and at the size of a purchase here (a few dollars) no split pays that.
async function zapQuote(price, who, deadline, skip = []) {
  const target = (price * (10000n + ZAP_MARGIN_BPS)) / 10000n;
  let amountIn = S.tacEth ? BigInt(Math.ceil(Number(price) * S.tacEth * 1.03)) : 0n;
  if (amountIn <= 0n) amountIn = 10n ** 15n;
  let best = null;
  for (let i = 0; i < 5; i++) {
    const [precision, tacit] = await Promise.all([
      venues.quotePrecision({ dir: 'ETH_TO_TAC', amountIn, account: who, block: 'latest' }).catch(() => null),
      venues.quoteTacitAmm({ dir: 'ETH_TO_TAC', amountIn, block: 'latest' }).catch(() => null),
    ]);
    const q = pickVenue(precision, tacit, skip);
    if (!q) return null;
    if (q.amountOut >= target) {
      best = { amountIn, q };
      if (q.amountOut * 1000n <= target * 1005n) break;                 // within half a percent over the target: close enough
    }
    amountIn = retryAmountIn(amountIn, target, q.amountOut);              // up when it paid too little, down when it paid a good deal too much
  }
  if (!best) return null;
  const tx = venues.build({ quote: best.q, dir: 'ETH_TO_TAC', account: who, to: ZAP, minOut: price, deadline: BigInt(deadline) });
  // what is sent is what the built call says (the Tacit AMM takes whole multiples of 1e10 wei), never more than was asked
  return tx && String(tx.to).toLowerCase() === ZROUTER.toLowerCase() && tx.value > 0n && tx.value <= best.amountIn ? { amountIn: tx.value, venue: best.q.venue, tx } : null;
}
// the ETH offered when the wallet has too little TAC: only with a zap that holds code, a price from the pool, and more ETH in the wallet than that
async function zapOffer(row, who) {
  if (!(await zapOn())) return null;
  try {
    const eth = BigInt(await rpc('eth_getBalance', [who, 'latest'])), z = await zapQuote(row.price, who, Math.floor(Date.now() / 1000) + 20 * 60);
    return z && eth > z.amountIn ? { amountIn: z.amountIn } : null;
  } catch { return null; }
}
async function zapBuy(id) {
  const row = S.shelf.find((x) => x.id === id);
  if (!row || S.busy || !W.account) return;
  pressed(id);
  const who = W.account, to = (S.to || who).trim();
  if (!isAddress(to) || badRecipient(to)) { say('Name an address to send the token to. It cannot be this shop, the market, TAC or the swap contracts.', true); return; }
  S.busy = id; S.done = null; render(); renderAfter(); say('Checking it is still for sale.');
  let hash = null;
  try {
    const cur = decodeListing(await rpc('eth_call', [{ to: SHOP, data: listingsData(id) }, 'latest']));
    if (!cur || cur.price === 0n) { say('That one is gone. The list is updated.', true); await readShelf(); return; }
    if (cur.nonce !== row.nonce || cur.price !== row.price) { say('Its price changed. The list is updated; look again.', true); await readShelf(); return; }
    if (!(await zapOn())) throw new Error('Paying with ETH is not available right now.');
    const deadline = Math.floor(Date.now() / 1000) + 20 * 60;
    // The whole call is read first. If it would not go through with the pool chosen (a refusal the shop does not give), the other pool is tried before anything is said to be wrong.
    let z = null, data = null;
    const tried = [];
    while (tried.length < 3) {
      say(tried.length ? 'Trying the other pool.' : 'Getting a price for the ETH.');
      z = await zapQuote(row.price, who, deadline, tried);
      if (!z) break;
      const eth = BigInt(await rpc('eth_getBalance', [who, 'latest']));
      if (eth <= z.amountIn) { say(`This takes about ${ethText(z.amountIn)} ETH and the wallet holds ${ethText(eth)}. ${BUY_TAC}`, true); return; }
      data = buyWithEthData({ swapData: z.tx.data, id, to, nonce: row.nonce, maxPrice: row.price, deadline });
      say('Checking the purchase before it is sent.');
      try { await rpc('eth_call', [{ from: who, to: ZAP, data, value: hex(z.amountIn) }, 'latest']); break; }
      catch (e) {
        if (!e?.revert) throw new Error('Could not reach the network to check this. Nothing was sent.');
        if (refusalWords(e.data)) { say(`${refusalWords(e.data)} Nothing was sent. The list is updated.`, true); await readShelf(); return; }    // the shop's own refusal: another pool changes nothing
        tried.push(z.venue); z = null;                                                                                                          // the swap in this pool would not go through
      }
    }
    if (!z) {
      if (!tried.length) throw new Error('The pool gave no price for this just now. Try again in a moment.');
      say('The swap or the purchase would not go through at this price. Nothing was sent. The list is updated.', true); await readShelf(); return;
    }
    const dollars = S.ethUsd ? ` (≈ ${usdText((Number(z.amountIn) / 1e18) * S.ethUsd)})` : '';
    say(`Confirm in your wallet: about ${esc(ethText(z.amountIn))} ETH${esc(dollars)}, swapped into ${esc(tacText(row.price))} TAC and spent on this address in the same transaction.`);
    hash = await conn.wallet.sendTx({ to: ZAP, data, value: z.amountIn, from: who });
    say('Sent. Waiting for it to be confirmed.');
    const r = await conn.wallet.receipt(hash);
    if (r.status !== '0x1') { say(`It did not go through, and nothing was taken.${txLink(hash)}`, true); return; }
    finishBuy({ hash, id, row, to, who });
  } catch (e) {
    if (hash) say(`Sent, not confirmed yet.${txLink(hash)} Check it there before buying again.`, true);
    else say(esc(e?.message || 'It did not go through.'), true);
  } finally { S.busy = null; render(); renderAfter(); readShelf(); readBalance(); }
}

// ── using an address ──
// Deploys to the chosen address through the market, which burns the token: either the small contract that passes ETH on (forwarderInit) or the bytecode pasted. The same call is
// made as a read first: it returns the address the contract would land at, which must be the one the token stands for, and a refusal is said before the wallet is asked for anything.
// Whether code creates a contract when it is simply created with nothing sent: false when it does not, or when that cannot be asked.
const createsPlainly = (from, data) => rpc('eth_call', [{ from, data }, 'latest']).then(() => true, () => false);
async function useDeploy() {
  const who = W.account;
  if (!who || U.busy) return;
  const set = (note, bad = false) => { U.note = note; U.bad = bad; const el = $('#use-note'); if (el) { el.className = `status wide${bad ? ' err' : ''}`; el.innerHTML = note; } };
  const sel = U.sel || U.tokens[0]?.id || 'other';
  let id = sel, receiver = null, code = null;
  if (sel === 'other') { id = parseTokenId(U.otherId); if (!id) { set('Enter the token id: a number, or 0x and hex.', true); return; } }
  if (U.kind === 'forward') receiver = (U.to || who).trim();
  else { code = initcodeOf(U.init); if (!code) { set('Paste the contract\'s creation bytecode: hex digits, whole bytes, no more than 49,152 of them.', true); return; } }
  U.busy = true; renderUse(); set('Checking it first.');
  let hash = null;
  try {
    const holder = decodeAddress(await rpc('eth_call', [{ to: MARKET, data: ownerOfData(id) }, 'latest']).catch(() => null));
    if (holder !== who.toLowerCase()) { set('The wallet connected now does not hold that token. It may be used already.', true); return; }
    const vanity = decodeAddress(await rpc('eth_call', [{ to: MARKET, data: addressOfData(id) }, 'latest']));
    if (!vanity) throw new Error('The market did not say which address that token stands for. Try again.');
    if (receiver !== null) { const why = forwardRefusal(receiver, vanity); if (why) { set(why, true); return; } code = forwarderInit(receiver); }
    const data = deployData(id, code);
    try {
      const at = decodeAddress(await rpc('eth_call', [{ from: who, to: MARKET, data }, 'latest']));
      if (at !== vanity) { set('The market would put it somewhere else than the address the token stands for, so nothing was sent.', true); return; }
    } catch (e) {
      if (!e?.revert) throw new Error('Could not reach the network to check this. Nothing was sent.');
      const why = deployFailed(e.data) && await createsPlainly(who, code) ? ETH_AT_DEPLOY_ADDRESS : deployRefusal(e.data);
      set(`${why || 'The market would refuse this.'} Nothing was sent.`, true); return;
    }
    set('Confirm the deployment in your wallet. It uses the token up.');
    hash = await conn.wallet.sendTx({ to: MARKET, data, from: who });
    set('Sent. Waiting for it to be confirmed.');
    const r = await conn.wallet.receipt(hash);
    if (r.status !== '0x1') { set(`It did not go through.${txLink(hash)}`, true); return; }
    U.result = { vanity, receiver, hash }; U.note = ''; U.bad = false;
    U.tokens = U.tokens.filter((t) => t.id !== id); U.sel = '';
    if (S.done?.id === id) { S.done = null; renderAfter(); }
  } catch (e) {
    if (hash) set(`Sent, not confirmed yet.${txLink(hash)} Check it there before trying again.`, true);
    else set(esc(e?.message || 'It did not go through.'), true);
  } finally { U.busy = false; renderUse(); }
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* no clipboard access: the older way */ }
  try {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(t); t.select();
    const ok = document.execCommand('copy'); t.remove(); return ok;
  } catch { return false; }
}

// ── the page ──
const paintNote = () => { const el = $('#note'); if (el) { el.className = `status${S.bad ? ' err' : ''}`; el.innerHTML = S.note; } };
const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
const rowHtml = (x) => {
  const { zeros, rest } = addressParts(x.vanity, x.bits), mine = S.busy === x.id, usd = priceUsd(x.price, S.tacUsd);
  const label = !W.account ? 'Connect to buy' : mine ? 'Buying…' : 'Buy';
  return `<li class="row" data-id="${esc(x.id)}"><div class="addr"><code title="${esc(x.vanity)}"><b>${esc(zeros)}</b>${esc(rest)}</code><small class="num">${esc(zerosText(zerosOf(x.bits)))}</small></div>
    <div class="buy"><span class="price num">${TAC_MARK}${esc(tacText(x.price))} <small>TAC</small>${usd === null ? '' : ` <em class="usd">≈ ${esc(usdText(usd))}</em>`}</span><button class="btn ghost" type="button" data-buy="${esc(x.id)}"${S.busy ? ' disabled' : ''}>${label}</button></div></li>`
    + (S.noteAt === x.id ? '<li id="note" class="status" aria-live="polite"></li>' : '');     // what a press says, under its row
};
const filtersHtml = () => {
  const tiers = zeroTiers(S.shelf);
  const chips = tiers.length > 1 ? `<div class="zcs" role="group" aria-label="Leading zeros">${[null, ...tiers].map((z) => `<button class="zc" type="button" data-zeros="${z === null ? '' : z}" aria-pressed="${S.zeros === z}">${z === null ? 'All' : esc(zerosText(z))}</button>`).join('')}</div>` : '';
  return `<div class="filters">${chips}<input id="find" type="search" autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore="true" data-form-type="other" spellcheck="false" placeholder="Search the addresses" aria-label="Search the addresses" value="${esc(S.q)}"></div>`;
};
// the field someone is typing in, kept (with its caret) through a redraw
const keepFocus = (root, ids, redraw) => {
  const id = ids.includes(document.activeElement?.id) ? document.activeElement.id : null, caret = id ? document.activeElement.selectionStart : 0;
  redraw();
  if (id) { const el = root.querySelector(`#${id}`); if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch { /* a field that has no caret */ } } }
};
function render() {
  const root = $('#shelf');
  if (!root) return;
  if (S.zeros !== null && !zeroTiers(S.shelf).includes(S.zeros)) S.zeros = null;      // the last of a kind was sold: show them all again
  const shown = filterShelf(S.shelf, { zeros: S.zeros, q: S.q });
  const gone = !!S.noteAt && S.loaded && !S.shelf.some((x) => x.id === S.noteAt);      // the row the note was about was sold or taken down: the note stays, at the foot of the list
  if (gone) S.noteAt = null;
  const anchored = !!S.noteAt && shown.some((x) => x.id === S.noteAt);
  let out = `<p class="eyebrow"><span>For sale${S.loaded ? ` · ${shown.length}${shown.length === S.shelf.length ? '' : ` of ${S.shelf.length}`}` : ''}</span><span class="who num">${W.account && S.bal !== null ? `${TAC_MARK}${esc(tacText(S.bal))} TAC` : ''}</span></p>`;
  out += `<p class="note need">Need TAC? <a href="${BUY_TAC_URL}">Buy it</a>.</p>`;     // at the top: a shelf of sixty rows would bury it
  if (S.failed && !S.loaded) out += `<p class="empty">The list could not be read. <button class="linkbtn" type="button" id="again">Try again</button></p>`;
  else if (!S.loaded) out += `<p class="empty">Reading the shop.</p>`;
  else if (!S.shelf.length) out += `<p class="empty">Nothing for sale right now.</p>`;
  else {
    if (S.shelf.length > 1) out += filtersHtml();
    out += shown.length ? `<ol class="shelf">${shown.map(rowHtml).join('')}</ol>` : `<p class="empty">No address matches that. <button class="linkbtn" type="button" id="clear">Show them all</button></p>`;
  }
  if (W.account && S.shelf.length) out += `<label class="to"><span class="mute">Send the token to</span><input id="to" type="text" inputmode="text" autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore="true" data-form-type="other" spellcheck="false" placeholder="${esc(W.account)}" value="${esc(S.to)}"></label>`;
  if (!anchored) out += `<div id="note" class="status" aria-live="polite"></div>`;
  keepFocus(root, ['to', 'find'], () => { root.innerHTML = out; });     // a refresh of the list must not take a field from someone typing in it
  paintNote();
  if (gone && S.note) revealNote();
  root.querySelectorAll('[data-buy]').forEach((b) => { b.onclick = () => buy(b.dataset.buy); });
  root.querySelectorAll('[data-zeros]').forEach((b) => { b.onclick = () => { S.zeros = b.dataset.zeros === '' ? null : Number(b.dataset.zeros); render(); }; });
  const to = $('#to'); if (to) to.oninput = () => { S.to = to.value; };
  const find = $('#find'); if (find) find.oninput = () => { S.q = find.value; render(); };
  const clear = $('#clear'); if (clear) clear.onclick = () => { S.zeros = null; S.q = ''; render(); };
  const again = $('#again'); if (again) again.onclick = () => { S.failed = false; render(); readShelf(); };
}
// What the buyer is left with, above the list: drawn when a purchase is made or the wallet changes, never by the list's refresh.
function renderAfter() {
  const box = $('#after');
  if (!box) return;
  const d = S.done;
  box.hidden = !d;
  if (!d) { box.innerHTML = ''; return; }
  const mine = !!W.account && d.to.toLowerCase() === W.account.toLowerCase();
  box.innerHTML = `<p class="eyebrow">Bought</p><h2>It is yours.</h2>
    <p class="mono"><code>${esc(d.vanity)}</code></p>
    <p class="note">Its token is in <code>${esc(d.to)}</code>${mine ? '' : ', not the wallet connected now'}. The token deploys any contract to this address, once: deploying uses it up.</p>
    <p class="note">Token id <code>${esc(tokenNumber(d.id))}</code> <button class="linkbtn" type="button" id="copy-id">Copy</button></p>
    ${mine ? '<button class="btn" type="button" id="use-it">Deploy to it</button>' : ''}
    <p class="note">${link(tokenUrl(d.id), 'See the token')} · ${link(`https://etherscan.io/tx/${d.hash}`, 'Transaction')}</p>`;
  const copy = $('#copy-id');
  if (copy) copy.onclick = async () => { const ok = await copyText(tokenNumber(d.id)); copy.textContent = ok ? 'Copied' : 'Select it to copy'; setTimeout(() => { copy.textContent = 'Copy'; }, 2200); };
  const use = $('#use-it');
  if (use) use.onclick = () => { U.sel = d.id; U.result = null; U.note = ''; renderUse(); $('#use')?.scrollIntoView({ block: 'start' }); };
}
// The section at the bottom: which address, what it should do, and the button. Drawn when the choice changes or the wallet's addresses do, never by the list's refresh.
function renderUse() {
  const box = $('#use');
  if (!box) return;
  const who = W.account;
  const head = `<p class="eyebrow">Use an address</p><h2 id="h-use">Deploy to an address you own</h2>
    <p class="note">Each address bought here is a token in your wallet. It puts a contract at its address, once. You can also call deploy on ${link(`https://etherscan.io/address/${MARKET}#writeContract`, 'the market\'s page')}.</p>`;
  if (!who) { box.innerHTML = `${head}<button class="btn" type="button" id="use-connect">Connect a wallet</button>`; const b = $('#use-connect'); if (b) b.onclick = () => conn.connect(); return; }
  if (U.result) {
    const r = U.result;
    box.innerHTML = `${head}<p class="status">Deployed at <code>${esc(r.vanity)}</code>. ${link(`https://etherscan.io/address/${r.vanity}`, 'See the contract')}. The token is used up.${r.receiver ? ` ETH sent to it now goes on to <code>${esc(r.receiver)}</code>.` : ''}</p>
      <button class="linkbtn" type="button" id="use-again">Use another address</button>`;
    const again = $('#use-again'); if (again) again.onclick = () => { U.result = null; U.note = ''; renderUse(); readTokens(); };
    return;
  }
  const sel = U.sel || U.tokens[0]?.id || 'other', forward = U.kind === 'forward';
  const opts = U.tokens.map((t) => `<option value="${esc(t.id)}"${sel === t.id ? ' selected' : ''}>${esc(t.vanity)} · ${esc(zerosText(zerosOf(t.bits)))}</option>`).join('')
    + `<option value="other"${sel === 'other' ? ' selected' : ''}>${U.tokens.length ? 'Another token id' : 'A token id I enter'}</option>`;
  const html = `${head}
    <div class="useform">
      <label class="to"><span class="mute">Address</span><span class="sel"><select id="use-token">${opts}</select></span></label>
      <label class="to"><span class="mute">What should it do?</span><span class="sel"><select id="use-kind"><option value="forward"${forward ? ' selected' : ''}>Pass ETH on to an address of mine</option><option value="custom"${forward ? '' : ' selected'}>Run my own contract</option></select></span></label>
      ${sel === 'other' ? `<label class="to wide"><span class="mute">Token id (a number, or 0x and hex)</span><input id="use-id" type="text" autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore="true" data-form-type="other" spellcheck="false" placeholder="0x…" value="${esc(U.otherId)}"></label>` : ''}
      ${forward
        ? `<label class="to wide"><span class="mute">Send everything that arrives to</span><input id="use-to" type="text" autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore="true" data-form-type="other" spellcheck="false" placeholder="${esc(who)}" value="${esc(U.to)}"></label>
           <p class="note wide">A tiny contract with one job: ETH sent to the address goes straight on to the one above, for good. It cannot be changed, and only ETH is passed on: tokens sent to it would be stuck.</p>`
        : `<label class="to wide"><span class="mute">Creation bytecode (hex)</span><textarea id="use-init" rows="4" spellcheck="false" autocomplete="off" placeholder="0x6080…">${esc(U.init)}</textarea></label>
           <p class="note wide">Your contract is deployed to the address with no ETH sent along.</p>`}
      <button class="btn wide" type="button" id="use-go"${U.busy ? ' disabled' : ''}>${U.busy ? 'Deploying…' : 'Deploy'}</button>
      <div id="use-note" class="status wide${U.bad ? ' err' : ''}" aria-live="polite">${U.note}</div>
    </div>`;
  keepFocus(box, ['use-id', 'use-to', 'use-init'], () => { box.innerHTML = html; });
  const on = (id, f) => { const el = $(`#${id}`); if (el) f(el); };
  on('use-token', (el) => { el.onchange = () => { U.sel = el.value; U.note = ''; renderUse(); }; });
  on('use-id', (el) => { el.oninput = () => { U.otherId = el.value; }; });
  on('use-kind', (el) => { el.onchange = () => { U.kind = el.value; U.note = ''; renderUse(); }; });
  on('use-to', (el) => { el.oninput = () => { U.to = el.value; }; });
  on('use-init', (el) => { el.oninput = () => { U.init = el.value; }; });
  on('use-go', (el) => { el.onclick = () => useDeploy(); });
}
$('#shelf').addEventListener('click', (e) => { const b = e.target.closest?.('[data-zap]'); if (b) zapBuy(b.dataset.zap); });
render();
renderAfter();
renderUse();
readShelf();
readPrice();
setInterval(() => { if (!S.busy && !document.hidden) readShelf(); }, 60_000);
setInterval(() => { if (!document.hidden) readPrice(); }, 5 * 60_000);
