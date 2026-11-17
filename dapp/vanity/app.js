import { makeConnect } from '/trade/connect.js?cb=5725b977';
import { esc } from '/trade/sheet.js?cb=71cade73';
import { $, rpc } from '/trade/util.js?cb=1d2cd8d3';
import { SHOP, MARKET, TAC, TAC_NAME, FROM_BLOCK, TOPICS, foldShelf, sortShelf, addressParts, tacText, buyData, buyWithPermitData, approveData, listingsData, balanceOfData,
  allowanceData, noncesData, decodeListing, decodeWord, refusalWords, badRecipient, isAddress } from '/vanity/shelf.js?cb=30055da6';

// The vanity shop's shelf (contracts/src/VanityShop.sol): addresses that start with zeros, each a token the buyer can deploy a contract to on Ethereum. The page reads the shelf
// from the shop's events, checks the one a buyer picks against the shop again, and sends one transaction: the buy, with a TAC permit signed first when the shop has no
// allowance. The shop holds nothing: the TAC goes to its treasury and the token to the address the buyer names, in the same transaction.
const S = { shelf: [], loaded: false, failed: false, bal: null, busy: null, note: '', bad: false, to: '', done: null };
const hex = (n) => '0x' + n.toString(16);
const say = (text, bad = false) => { S.note = text; S.bad = bad; paintNote(); };
const conn = makeConnect({
  describe: 'Buy a vanity address with TAC', name: 'tacit vanity', rewards: false,
  say: (t, b) => say(t, b), busy: () => !!S.busy, onChange: () => { S.bal = null; S.to = ''; render(); readBalance(); },
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
    S.shelf = sortShelf(foldShelf(await logsBetween(FROM_BLOCK, head)));
    S.loaded = true; S.failed = false;
  } catch { S.failed = true; }
  render();
}
async function readBalance() {
  const who = W.account;
  if (!who) return;
  try { const b = decodeWord(await rpc('eth_call', [{ to: TAC, data: balanceOfData(who) }, 'latest'])); if (who === W.account) { S.bal = b; render(); } } catch { /* the balance is a convenience: a buy checks it again */ }
}

// ── buying ──
const txLink = (hash) => (/^0x[0-9a-fA-F]{64}$/.test(String(hash)) ? ` <a href="https://etherscan.io/tx/${hash}" target="_blank" rel="noopener noreferrer">See it on Etherscan</a>.` : '');
async function buy(id) {
  const row = S.shelf.find((x) => x.id === id);
  if (!row || S.busy) return;
  if (!W.account) { await conn.connect(); return; }
  const to = (S.to || W.account).trim();
  if (!isAddress(to) || badRecipient(to)) { say('Name an address to send the token to. It cannot be this shop, the market or TAC.', true); return; }
  S.busy = id; S.done = null; render(); say('Checking it is still for sale.');
  let hash = null;
  try {
    // the list may be a block or two old: the shop's own answer decides
    const cur = decodeListing(await rpc('eth_call', [{ to: SHOP, data: listingsData(id) }, 'latest']));
    if (!cur || cur.price === 0n) { say('That one is gone. The list is updated.', true); await readShelf(); return; }
    if (cur.nonce !== row.nonce || cur.price !== row.price) { say('Its price changed. The list is updated; look again.', true); await readShelf(); return; }
    const who = W.account, call = (data, to2) => rpc('eth_call', [{ to: to2, data }, 'latest']);
    const bal = decodeWord(await call(balanceOfData(who), TAC));
    if (bal === null || bal < row.price) { say(`You hold ${bal === null ? 'no readable' : tacText(bal)} TAC. This one costs ${tacText(row.price)}.`, true); return; }
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
    S.done = { hash, id, vanity: row.vanity, nonce: row.nonce, to, price: row.price };
    say('');
  } catch (e) {
    if (hash) say(`Sent, not confirmed yet.${txLink(hash)} Check it there before buying again.`, true);
    else say(esc(e?.message || 'It did not go through.'), true);
  } finally { S.busy = null; render(); readShelf(); readBalance(); }
}

// ── the page ──
const paintNote = () => { const el = $('#note'); if (el) { el.className = `status${S.bad ? ' err' : ''}`; el.innerHTML = S.note; } };
const rowHtml = (x) => {
  const { zeros, rest } = addressParts(x.vanity, x.bits), mine = S.busy === x.id;
  const label = !W.account ? 'Connect to buy' : mine ? 'Buying…' : 'Buy';
  return `<li class="row" data-id="${esc(x.id)}"><div class="addr"><code title="${esc(x.vanity)}"><b>${esc(zeros)}</b>${esc(rest)}</code><small class="num">${x.bits} zero bits · nonce ${x.nonce}</small></div>
    <div class="buy"><span class="price num">${esc(tacText(x.price))} <small>TAC</small></span><button class="btn ghost" type="button" data-buy="${esc(x.id)}"${S.busy ? ' disabled' : ''}>${label}</button></div></li>`;
};
function render() {
  const root = $('#shelf');
  if (!root) return;
  let out = '';
  if (S.done) {
    out += `<div class="done"><p class="eyebrow">Bought</p><h2>It is yours.</h2>
      <p class="mono"><code>${esc(S.done.vanity)}</code></p>
      <p class="note">The token for this address is in <code>${esc(S.done.to)}</code>. Burn it in the market to deploy any contract there, on Ethereum.
      <a href="https://etherscan.io/address/${MARKET}#writeContract" target="_blank" rel="noopener noreferrer">Deploy with it</a> · <a href="https://etherscan.io/tx/${esc(S.done.hash)}" target="_blank" rel="noopener noreferrer">Transaction</a></p></div>`;
  }
  out += `<p class="eyebrow"><span>For sale${S.loaded ? ` · ${S.shelf.length}` : ''}</span><span class="who num">${W.account && S.bal !== null ? `${esc(tacText(S.bal))} TAC` : ''}</span></p>`;
  if (S.failed && !S.loaded) out += `<p class="empty">The list could not be read. <button class="linkbtn" type="button" id="again">Try again</button></p>`;
  else if (!S.loaded) out += `<p class="empty">Reading the shop.</p>`;
  else if (!S.shelf.length) out += `<p class="empty">Nothing for sale right now.</p>`;
  else out += `<ol class="shelf">${S.shelf.map(rowHtml).join('')}</ol>`;
  if (W.account && S.shelf.length) out += `<label class="to"><span class="mute">Send the token to</span><input id="to" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="${esc(W.account)}" value="${esc(S.to)}"></label>`;
  out += `<div id="note" class="status" aria-live="polite"></div>`;
  const typing = document.activeElement?.id === 'to', caret = typing ? document.activeElement.selectionStart : 0;     // a refresh of the list must not take the field from someone typing in it
  root.innerHTML = out;
  paintNote();
  root.querySelectorAll('[data-buy]').forEach((b) => { b.onclick = () => buy(b.dataset.buy); });
  const to = $('#to'); if (to) to.oninput = () => { S.to = to.value; };
  if (typing && to) { to.focus(); try { to.setSelectionRange(caret, caret); } catch { /* a field that has no caret */ } }
  const again = $('#again'); if (again) again.onclick = () => { S.failed = false; render(); readShelf(); };
}
render();
readShelf();
setInterval(() => { if (!S.busy && !document.hidden) readShelf(); }, 60_000);
