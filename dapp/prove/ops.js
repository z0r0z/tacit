// The network's other jobs on /prove/ (the Relay and Bitcoin tabs, and the proof market's card): advance Bitcoin's header relay, submit a
// published proof, send a waiting settle from the open board, each from the visitor's own wallet, which pays the network fee and keeps any
// fee the settle pays. Every call is permissionless on chain; no Tacit key touches this page. Moved here from the community ops page
// (/weld/keeper/ now sends its visitors to these tabs), with the same modules doing the planning and building.
import { makeEvmWallet } from '/evm-wallet.js?cb=b400cbe7';
import { announceWalletConnect, wcSheets, dialogHost, WC_PROJECT_ID } from '/walletconnect.js?cb=e0b29a34';
import { makeHeaderRelayAdvance } from '/header-relay-advance.js?cb=1c3a7226';
import { POOL, SEL_ANCESTRY, ATTEST_GAS, SETTLE_GAS, readProof, attestRefusal, encodeAttest, needsAncestry, ancestryCalls, ethText, ethFeeWei, feeWeiOf, readPrices, boardSummary, sendable, pickSettle, readBoard, reportLanded, settleCalldata } from '/community-ops.js';
import { bodyType } from '/rpc-body.js';
import { secp, keccak_256, sha256 } from '/vendor/tacit-deps.min.js';
import { makeEvmAccount } from '/evm-account.js?cb=e48ce3f6';
import { makeEvmTx } from '/evm-tx.js?cb=ed0eafb7';
import { makeNostrBoard, mergeBoards } from '/nostr-board.js?cb=0feadbff';
import { makeAutoRelay, AUTO_RESERVE_WEI } from '/prove/autorelay.js?cb=6d43079e';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const int = (n) => Number(n).toLocaleString('en-US');
const plural = (n, one, many = one + 's') => `${int(n)} ${n === 1 ? one : many}`;
const short = (a, n = 4) => a ? `${a.slice(0, n + 2)}…${a.slice(-n)}` : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SK = (w) => `<span class="sk" style="--w:${w}"></span>`;

// ── toasts: the front page's popover, each one also read out through the live region ──────────────────────────
const toasts = $('#toast-container');
const announce = (t) => { const el = $('#live'); if (el) el.textContent = t; };
function raiseToasts() {
  const on = toasts.childElementCount > 0;
  try { if (toasts.matches(':popover-open')) toasts.hidePopover(); } catch {}
  try { if (on) toasts.showPopover(); } catch {}
}
// A toast appears and fills in one tick, which screen readers miss, so its text goes to the live region too.
new MutationObserver((recs) => {
  raiseToasts();
  const said = recs.flatMap((r) => [...r.addedNodes]).map((n) => n.textContent || '').join(' ').trim();
  if (said) { announce(''); requestAnimationFrame(() => announce(said)); }
}).observe(toasts, { childList: true });
function toast(msg, bad = false, ms = bad ? 7000 : 4200) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  toasts.append(el);
  setTimeout(() => el.remove(), ms);
}
const errText = (e) => {
  const m = String(e?.message || e || 'Something went wrong');
  if (e?.code === 4001 || /user (rejected|denied)/i.test(m)) return 'Cancelled in your wallet.';
  if (e?.code === -32002 || /already (pending|processing)|request of type .* pending/i.test(m)) return 'Your wallet already has a request open. Answer it there, then try again.';
  if (/chain.*not approved|does not support 'wallet_switchEthereumChain'/i.test(m)) return 'Your wallet app did not allow Ethereum. Disconnect, then connect again.';
  if (/insufficient funds/i.test(m)) return 'Not enough ETH in that wallet for the network fee.';
  if (/no Ethereum wallet detected/i.test(m)) return 'No Ethereum wallet found in this browser. Open this page in your wallet’s own browser, or install MetaMask, Rabby or Rainbow.';
  if (/does not match the canonical chain/i.test(m)) return 'The relay’s newest block is not the block the explorer has at that height (a reorg, or an explorer running behind). Tacit’s header relay returns it to Bitcoin’s main chain on its next run. Nothing was sent.';
  if (/^esplora /.test(m)) return 'Could not read Bitcoin’s blocks from the explorer. Try again in a moment.';
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Could not reach the network. Check your connection and try again.';
  return m.replace(/^Error:\s*/, '').slice(0, 240);
};

// A single busy-button: a second press while the first is running does nothing. The advance and board buttons are set from the
// latest plan or board once their run ends (a refresh during the run leaves them alone).
let repaintPlan = null;
async function busy(btn, fn) {
  if (btn.getAttribute('aria-busy') === 'true') return;
  btn.setAttribute('aria-busy', 'true');
  try { await fn(); } catch (e) { toast(errText(e), true); if (e?.hash) onItsWay(btn, e.hash); } finally { btn.removeAttribute('aria-busy'); if (btn.id === 'btn-advance') repaintPlan?.(); if (btn.id === 'btn-board') paintBoard(); }
}
// A send refused because the wallet's last one is still on its way: that one's link goes on the card's status line, under the button.
function onItsWay(btn, hash) {
  const st = btn.parentElement?.querySelector('.status') || btn.closest('.panel')?.querySelector('.status');
  if (st) st.innerHTML = `Still on its way: ${txLink(hash, short(hash, 8))}.`;
}

// ── wallet: a bare injected-wallet connection, nothing Tacit-specific — anyone's wallet pays its own gas ──────
const evm = makeEvmWallet({});
const RPC = 'https://ethereum-rpc.publicnode.com';
// WalletConnect joins the browser's wallets, and is the one wallet used where the browser has none (a phone): a wallet app pays the gas.
const wcOpen = dialogHost({ dialog: $('#sheet-wc'), title: $('#wc-h'), body: $('#wc-body') }), wcSheet = wcSheets(wcOpen);
const WC = announceWalletConnect({
  projectId: WC_PROJECT_ID, chains: [1], rpcMap: { 1: RPC },
  metadata: { name: 'tacit ops', description: 'Keep Bitcoin’s state on Ethereum current', url: location.origin, icons: [`${location.origin}/tac-logo.png`] },
  onPair: (x) => wcSheet.onPair(x), onAsk: (x) => wcSheet.onAsk(x),
});
const S = { provider: null, address: null };
const TX_HASH = /^0x[0-9a-f]{64}$/i;

async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': bodyType(RPC) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
  // A node reports a contract's revert reason as data next to the message; keep it so a caller can read it.
  if (r.error) throw new Error(r.error.message + (typeof r.error.data === 'string' ? ` ${r.error.data}` : ''));
  return r.result;
}
// Every wallet knows Ethereum, so this only asks for the switch, then reads the chain back: some wallets report a
// switch they have not made yet.
async function ensureMainnet() {
  const onMainnet = async () => Number(await S.provider.request({ method: 'eth_chainId' })) === 1;
  if (await onMainnet()) return;
  await S.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
  if (!(await onMainnet())) throw new Error('Switch your wallet to Ethereum, then try again.');
}
async function connect({ change = false } = {}) {
  const { provider, address } = await evm[change ? 'changeAccount' : 'connect']({});
  S.provider = provider; S.address = '0x' + address;
  paintWallet();
  return S.address;
}
// The wallet connected last, on this or any other page of tacit.finance, is connected here again without a prompt while it still
// allows the site.
async function restoreWallet() {
  const c = await evm.restore().catch(() => null);
  if (!c || S.address) return;                                        // one connected meanwhile stands
  S.provider = c.provider; S.address = '0x' + c.address;
  paintWallet();
}
// The wallet changed accounts (or locked): the next send goes from the account it now has.
window.addEventListener('tacit:evm-accounts', (e) => {
  if (!S.provider || (e.detail?.provider && e.detail.provider !== S.provider)) return;
  const a = String((e.detail?.accounts || [])[0] || '').toLowerCase();
  S.address = /^0x[0-9a-f]{40}$/.test(a) ? a : null;
  paintWallet();
});
// The wallet's last send from here is kept until its receipt is seen (across reloads too): while it is still on its way nothing else is
// sent from that account, since the next transaction could only land after it, and the same call sent again would revert.
const PENDING = 'tacit-prove-wallet-pending-v1';
const pendingGet = () => { try { return JSON.parse(localStorage.getItem(PENDING) || 'null'); } catch { return null; } };
const pendingSet = (p) => { try { if (p) localStorage.setItem(PENDING, JSON.stringify(p)); else localStorage.removeItem(PENDING); } catch {} };
async function stillOnItsWay() {
  const p = pendingGet();
  if (!p || String(p.from).toLowerCase() !== String(S.address).toLowerCase()) return null;
  if (await rpc('eth_getTransactionReceipt', [p.hash])) { pendingSet(null); return null; }
  if (!(await rpc('eth_getTransactionByHash', [p.hash]))) { pendingSet(null); return null; }   // dropped, or replaced in the wallet
  return p;
}
async function noneOnItsWay() {
  const p = await stillOnItsWay();
  if (p) throw Object.assign(new Error('Your wallet’s last transaction from here is still on its way. Wait for it to land, or speed it up or cancel it in your wallet, then try again.'), { hash: p.hash });
}
async function send({ to, data, gas, value = 0n }) {
  if (!S.address) await connect();
  await ensureMainnet();
  await noneOnItsWay();
  const hash = await S.provider.request({ method: 'eth_sendTransaction', params: [{ from: S.address, to, data, gas: '0x' + gas.toString(16), chainId: '0x1', ...(value ? { value: '0x' + value.toString(16) } : {}) }] });
  if (!TX_HASH.test(String(hash))) throw new Error('The wallet did not return a transaction hash.');
  pendingSet({ from: S.address, hash: String(hash).toLowerCase(), at: Date.now() });
  return String(hash).toLowerCase();
}
// A missed poll is tried again; a transaction still unconfirmed after five minutes is left to Etherscan, and stays the wallet's last send.
async function waitReceipt(hash) {
  for (let i = 0; i < 100; i++) {
    try { const r = await rpc('eth_getTransactionReceipt', [hash]); if (r) { if (pendingGet()?.hash === hash) pendingSet(null); return r; } } catch {}
    await sleep(3000);
  }
  throw new Error('Not confirmed after 5 minutes. It can still land: follow it on Etherscan from the link above.');
}
const landed = (r) => r?.status === '0x1' || r?.status === 1;
const txLink = (hash, label) => `<a href="https://etherscan.io/tx/${esc(hash)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`;
function paintWallet() {
  $('#wallet-dot').classList.toggle('on', !!S.address);
  const label = $('#wallet-label');
  if (S.address) label.textContent = short(S.address);
  else label.innerHTML = '<span class="wide">Connect wallet</span><span class="narrow">Connect</span>';
  $('#wallet').title = S.address ? `Connected: ${S.address}` : 'Connect an Ethereum wallet to pay the network fee';
  if (S.address) dispatchEvent(new CustomEvent('tacit:prove-wallet', { detail: S.address }));    // app.js fills an empty "Pays to" with it
}

// ── what a send costs: the node's gas price now, for an estimate in ETH next to each action ───────────────────
let gasPrice = null;
async function readGasPrice() { try { gasPrice = BigInt(await rpc('eth_gasPrice', [])); } catch {} }
const ethFor = (gas) => (gasPrice == null ? null : ethText(BigInt(gas) * gasPrice));
// Measured on the header relay's own sends: about 92,000 gas a transaction and 172,000 a header (1 header used
// 263,969 gas, 2 used 436,448). Shown as an estimate only; each send's gas limit comes from the node.
const advanceGas = (headers, txs) => 92_000n * BigInt(txs) + 172_000n * BigInt(headers);

// ── the module doing the planning, building and estimating (dapp/header-relay-advance.js) ────────────────────
const advance = makeHeaderRelayAdvance({});
const API = 'https://api.tacit.finance';
// The pool's reads, as dapp/community-ops.js asks for them: an eth_call that returns hex and throws on a revert.
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

// #need=<height>&why=lock|bridge — a link from a waiting lock or deposit elsewhere on tacit.finance: the relay height
// it needs. Anything but a plain block height is ignored, and the page reads the link again when it changes.
let need = null, why = null;
function readLink() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  const n = p.get('need') || '';
  need = /^\d{1,8}$/.test(n) && Number(n) > 0 ? Number(n) : null;
  why = need != null && /^(lock|bridge)$/.test(p.get('why') || '') ? p.get('why') : null;
}
readLink();
const forWhat = () => (why === 'lock' ? 'your lock' : why === 'bridge' ? 'your bridge deposit' : 'the linked request');

// A card's chain mark is named for a screen reader and on hover; `dot` is a state dot before its line (on = in step, warn = behind).
const CHAIN = { btc: ['c-btc', 'Bitcoin'], eth: ['c-eth', 'Ethereum'] };
function cardHtml({ k, v, u, m, attn, chain, dot }) {
  const mk = chain ? `<svg class="tk sm" role="img" aria-label="${CHAIN[chain][1]}"><title>${CHAIN[chain][1]}</title><use href="#${CHAIN[chain][0]}"/></svg>` : '';
  return `<div class="card${attn ? ' attn' : ''}"><div class="k">${mk}${esc(k)}</div><div class="v num">${v == null ? SK('7ch') : `${esc(v)}${u ? `<small>${esc(u)}</small>` : ''}`}</div><div class="m">${m == null ? SK('16ch') : `${dot ? `<span class="dot ${dot}"></span>` : ''}${esc(m)}`}</div></div>`;
}
const CARDS = [['Header relay', 'eth'], ['Bitcoin tip', 'btc'], ['Proven to', 'eth'], ['Bridge deposits', 'btc']];
$('#cards-wait').innerHTML = CARDS.map(([k, chain]) => cardHtml({ k, chain })).join('');

let lastRead = 0;
async function refresh() {
  const [st] = await Promise.all([advance.status(), readGasPrice()]);
  lastRead = Date.now();
  paintBoard();                                                   // the board's fee estimate needs the price just read
  const lag = st.reflectionLag, far = needsAncestry(lag);
  $('#cards-wait').innerHTML = [
    cardHtml({ k: 'Header relay', chain: 'eth', v: int(st.relayTip), u: 'block', dot: st.behind <= 0 ? 'on' : 'warn', m: st.behind <= 0 ? 'at the tip' : `${plural(st.behind, 'block')} behind the tip` }),
    cardHtml({ k: 'Bitcoin tip', chain: 'btc', v: int(st.btcTip), u: 'block', m: 'from a public explorer' }),
    cardHtml({
      k: 'Proven to', chain: 'eth', v: st.attested == null ? '—' : int(st.attested), u: st.attested == null ? '' : 'block', attn: far,
      dot: lag == null ? null : lag <= 0 ? 'on' : 'warn',
      m: lag == null ? 'not read yet' : lag <= 0 ? 'caught up with the relay' : `${plural(lag, 'block')} behind the relay`,
    }),
    cardHtml({ k: 'Bridge deposits', chain: 'btc', v: st.burnDeposits == null ? '—' : int(st.burnDeposits), m: 'recorded by the proofs' }),
  ].join('');
  $('#asof').textContent = `As of ${new Date().toLocaleTimeString('en-GB')} · a block can be proven once it is ${st.confirmations} deep`;
  $('#ancestry-callout').hidden = !far;
  if (far) paintAncestry(st);
  paintPlan(st, advance.plan({ ...st, need }));
  return st;
}
function readFailed(e) {
  $('#asof').innerHTML = 'Could not read the relay. <button class="link" type="button" id="retry">Try again</button>';
  $('#retry').addEventListener('click', () => { $('#asof').textContent = 'Reading the relay…'; refresh().catch(readFailed); });
  $('#plan-box').innerHTML = '<p>The plan appears once the relay is read.</p>';
  if (e) toast(errText(e), true);
}

function paintPlan(st, pl) {
  repaintPlan = () => paintPlan(st, pl);
  const box = $('#plan-box'), btn = $('#btn-advance');
  const safeTip = st.btcTip - 2, proven = st.relayTip - st.confirmations;
  const lines = [];
  let can = false;
  if (pl.action === 'idle') {
    if (need != null && need <= st.relayTip) lines.push(`The relay already has block ${int(need)}, the height ${forWhat()} needs. Nothing to advance: what is left is the next proof (Submit a proof, below).`);
    else if (need != null && need > safeTip) lines.push(`${forWhat()[0].toUpperCase() + forWhat().slice(1)} needs the relay at block ${int(need)}. The relay stays 2 blocks behind Bitcoin’s tip (${int(st.btcTip)}), so it can go there after ${plural(need - safeTip, 'more Bitcoin block')}, about ${int((need - safeTip) * 10)} minutes.`);
    else if (st.relayTip >= safeTip) lines.push('The relay is at Bitcoin’s tip, less its 2-block margin. Nothing to advance.');
    else lines.push(`The relay already confirms Bitcoin to block ${int(proven)}, ${plural(proven - st.attested, 'block')} past the proven block ${int(st.attested)}, so the next proofs aren’t waiting on it. Nothing to advance.`);
  } else {
    can = true;
    const txs = Math.ceil(pl.pending / advance.MAX_BATCH);
    let what = `${plural(pl.pending, 'header')} to send, blocks ${int(pl.from)} to ${int(pl.to)}`;
    if (need != null) what += pl.to >= need ? `, to reach block ${int(need)}, the height ${forWhat()} needs.` : `. ${forWhat()[0].toUpperCase() + forWhat().slice(1)} needs block ${int(need)}: the relay stays 2 blocks behind Bitcoin’s tip, so the rest can follow after ${plural(need - pl.to, 'more Bitcoin block')}.`;
    else what += '.';
    lines.push(what);
    if (pl.useless && need == null) lines.push(`The relay already confirms Bitcoin to block ${int(proven)}, past the proven block ${int(st.attested)}, so the next proof isn’t waiting on it. Advancing now readies the ones after it.`);
    const eth = ethFor(advanceGas(pl.pending, txs));
    lines.push(`${plural(txs, 'transaction')}${eth ? `, about ${eth} ETH in network fees` : ''}. Your wallet shows the exact fee.`);
  }
  box.innerHTML = lines.map((l) => `<p>${esc(l)}</p>`).join('');
  if (btn.getAttribute('aria-busy') === 'true') return;   // a run in progress keeps its button
  btn.disabled = !can;
  btn.textContent = can ? 'Advance the relay' : 'Nothing to advance';
}

function stripHtml(batches) {
  return ['Wallet', ...batches.map((b, i) => `Batch ${i + 1}`), 'Done'].map((label, i) => `<li id="stp-${i}"><i></i>${esc(label)}</li>`).join('');
}
function stripSet(i, cls) { const el = $(`#stp-${i}`); if (el) el.className = cls; }

async function doAdvance() {
  const out = $('#status'), strip = $('#strip'), rows = $('#batch-rows');
  out.textContent = '';
  strip.hidden = true; $('#batch-table').hidden = true;
  if (!S.address) await connect();
  out.textContent = 'Checking the relay against Bitcoin…';
  let batches = [], at = -1, done = 0;
  const row = (i) => $(`#brow-${i} td:last-child`);
  try {
    const result = await advance.runAdvance({
      need, fromAddress: S.address, send,
      waitReceipt: async (hash) => {
        const r = await waitReceipt(hash);
        if (landed(r) && row(at)) { row(at).innerHTML = txLink(hash, 'landed'); stripSet(at + 1, 'done'); done++; }
        return r;
      },
      onPlan: (p) => { if (p.action === 'advance') out.textContent = `Reading ${plural(p.pending, 'header')} from Bitcoin…`; },
      onBatches: (bs) => {
        batches = bs;
        strip.innerHTML = stripHtml(bs); strip.hidden = false; stripSet(0, 'done');
        rows.innerHTML = bs.map((b, i) => `<tr id="brow-${i}"><td>${i + 1}</td><td>${int(b.from)} to ${int(b.to)}</td><td>waiting</td></tr>`).join('');
        $('#batch-table').hidden = false;
        out.textContent = bs.length > 1 ? `Your wallet asks you to confirm ${bs.length} transactions, one per batch.` : 'Confirm the transaction in your wallet.';
      },
      onProgress: (p) => {
        at = batches.findIndex((b) => b.from === p.from && b.to === p.to);
        const cell = row(at);
        if (p.skipped) { stripSet(at + 1, 'done'); if (cell) cell.textContent = 'already on chain'; return; }
        if (p.sending && !p.txHash) { stripSet(at + 1, 'now'); if (cell) cell.textContent = 'confirm in your wallet'; return; }
        if (p.txHash && cell) cell.innerHTML = txLink(p.txHash, 'confirming');
      },
    });
    if (result.action !== 'advance') { out.textContent = 'Nothing to advance now: the relay moved since this page read it.'; toast('Nothing to advance.'); return; }
    stripSet(batches.length + 1, 'done');
    if (!result.sent.length) { out.textContent = `The relay reached block ${int(result.to)} before your batches went out, so nothing was sent.`; toast('Nothing to send'); return; }
    out.textContent = `The relay now has block ${int(result.to)}. Tacit’s prover looks for a new batch every 30 seconds; the next proof can cover Bitcoin to block ${int(result.to - result.confirmations)}.`;
    toast('Header relay advanced');
  } catch (e) {
    if (at >= 0) { stripSet(at + 1, 'bad'); const cell = row(at); if (cell && !/landed/.test(cell.textContent)) cell.textContent = 'stopped'; }
    out.textContent = batches.length > 1 ? `Stopped at batch ${at + 1} of ${batches.length}${done ? `. ${plural(done, 'batch', 'batches')} landed before it` : ''}.` : '';
    throw e;
  } finally {
    refresh().catch(() => {});
  }
}

// ── the checkpoint for a lane far behind: advanceReflectionAncestry(), sized and simulated before it is sent ──
// Each call walks at most 2,016 blocks from the relay's confirmed tip down toward 2,016 past the proven block.
let ancestryGas = null;
async function paintAncestry(st) {
  const calls = ancestryCalls(st.reflectionLag);
  const say = () => {
    const eth = ancestryGas != null ? ethFor(ancestryGas) : null;
    $('#anc-plan').textContent = `This gap takes ${plural(calls, 'call')}${eth ? `, about ${eth} ETH each in network fees` : ''}.`;
  };
  say();
  try { ancestryGas = BigInt(await rpc('eth_estimateGas', [{ to: POOL, data: SEL_ANCESTRY }])); say(); } catch {}
}
async function doAncestry() {
  const out = $('#anc-status');
  out.textContent = '';
  if (!S.address) await connect();
  const st = await refresh();
  if (!needsAncestry(st.reflectionLag)) { toast('The proofs are back within 2,016 blocks of the relay. No checkpoint is needed.'); return; }
  const calls = ancestryCalls(st.reflectionLag);
  // Run it first: a call the pool refuses costs gas to find out, and the node tells us for free.
  try { await rpc('eth_call', [{ from: S.address, to: POOL, data: SEL_ANCESTRY }, 'latest']); }
  catch (e) { throw new Error(`The pool would not take this call, so nothing was sent: ${errText(e)}`); }
  const est = BigInt(await rpc('eth_estimateGas', [{ from: S.address, to: POOL, data: SEL_ANCESTRY }]));
  out.textContent = 'Confirm the transaction in your wallet.';
  let txHash;
  try { txHash = await send({ to: POOL, data: SEL_ANCESTRY, gas: (est * 125n) / 100n }); }
  catch (e) { out.textContent = ''; throw e; }
  out.innerHTML = `Sent ${txLink(txHash, short(txHash, 8))}. Waiting for it to land…`;
  const rcpt = await waitReceipt(txHash);
  if (!landed(rcpt)) { out.innerHTML = `Reverted: ${txLink(txHash, short(txHash, 8))}.`; refresh().catch(() => {}); throw new Error('The call reverted. Nothing was lost but its network fee.'); }
  out.innerHTML = `Landed: ${txLink(txHash, short(txHash, 8))}. ${calls > 1 ? `This gap takes ${plural(calls, 'call')}: ${plural(calls - 1, 'more carries', 'more carry')} the walk to the checkpoint.` : 'The checkpoint is set, and the next proof builds on it.'}`;
  toast('advanceReflectionAncestry() landed');
  refresh().catch(() => {});
}

// ── a proof Tacit's prover has made and published: submit it from this wallet ────────────────────────────────
let readyProof = null;
// Reads the latest published proof against the pool's digest, paints it, and returns it when it can be submitted.
async function refreshProof() {
  const box = $('#proof-box'), btn = $('#btn-proof');
  const none = (msg) => { box.innerHTML = `<p>${esc(msg)}</p>`; btn.disabled = true; readyProof = null; return null; };
  let read;
  try { read = await readProof({ api: API, call }); }
  catch { return none('Could not read the latest proof. The page tries again every minute.'); }
  const rec = read.rec;
  if (read.offer === 'none') return none('No proof is waiting. Tacit’s prover submits each one itself, usually within minutes of making it.');
  if (read.offer === 'malformed') return none('The published proof is not in the form the pool takes, so it is not offered.');
  if (read.offer === 'spent') return none(`The latest published proof (Bitcoin to block ${int(rec.attestedTo)}) is already on chain, or builds on a state the pool has moved past. Nothing to submit.`);
  const mins = Number.isFinite(rec.at) ? Math.max(0, Math.round((Date.now() - rec.at) / 60000)) : null;
  const eth = ethFor(ATTEST_GAS);
  box.innerHTML = `<p><b>A proof is ready</b> for Bitcoin to block ${esc(int(rec.attestedTo))}${mins == null ? '' : `, published ${mins < 1 ? 'just now' : `${esc(int(mins))} min ago`}`}.</p><p>Submitting costs about 0.5 to 0.6 million gas${eth ? `, about ${esc(eth)} ETH in network fees` : ''}.</p>`;
  btn.disabled = false; readyProof = rec;
  return rec;
}
async function doSubmitProof() {
  const out = $('#proof-status');
  out.textContent = '';
  if (!S.address) await connect();
  // This send keeps its own copy: the minute's refresh clears readyProof as soon as this proof lands.
  const rec = await refreshProof();
  if (!rec) { toast('That proof is no longer needed.'); return; }
  const data = encodeAttest(rec.publicValues, rec.proof);
  // Run it first: a proof the pool no longer accepts costs gas to find out, and the node tells us for free.
  try { await rpc('eth_call', [{ from: S.address, to: POOL, data }, 'latest']); }
  catch (e) {
    const reason = attestRefusal(e?.message || e) || errText(e);
    throw new Error(`The pool would not accept this proof, so nothing was sent: ${reason}.`);
  }
  const est = BigInt(await rpc('eth_estimateGas', [{ from: S.address, to: POOL, data }]));
  out.textContent = 'Confirm the transaction in your wallet.';
  let txHash;
  try { txHash = await send({ to: POOL, data, gas: (est * 125n) / 100n }); }
  catch (e) { out.textContent = ''; throw e; }
  out.innerHTML = `Sent ${txLink(txHash, short(txHash, 8))}. Waiting for it to land…`;
  const rcpt = await waitReceipt(txHash);
  if (!landed(rcpt)) { out.innerHTML = `Reverted: ${txLink(txHash, short(txHash, 8))}.`; refreshProof().catch(() => {}); throw new Error('The transaction reverted: another wallet may have landed this proof first. Nothing was lost but its network fee.'); }
  out.innerHTML = `Landed: ${txLink(txHash, short(txHash, 8))}. Bitcoin is proven on Ethereum to block ${esc(int(rec.attestedTo))}; bridge deposits up to there can now mint.`;
  toast('Proof submitted');
  refresh().catch(() => {}); refreshProof().catch(() => {});
}

// ── the open board: a settle any wallet can send, paid its proof's fee legs inside the same transaction ──────────
// The board's figures, the job sent next (the one paying the most) and the settle itself all come from dapp/community-ops.js, as the runner's do.
let board = null, boardErr = false;
const passed = new Set();                                         // jobs the pool refused here: not offered again on this page
const taken = new Set();                                          // jobs a send has in hand, the wallet's or the relay account's: the other leaves them alone
const skip = { has: (id) => passed.has(id) || taken.has(id) };
// The board is the API's and Nostr's (nostr-board.js): the proofs posted to public relays, which any visitor here also copies the API's
// jobs to, so the board goes on when the API does not. Nostr is read at most once a minute; either half may be missing.
const NB = makeNostrBoard({ pool: POOL });
const MIRRORED = new Map();                                       // proofs this tab has posted, by public values: not posted again for an hour
let nostrAt = 0, nostrJobs = null;
// TAC's worth to a sender (community-ops.js readPrices: the TAC/tETH pool at 80%), read at most once a minute: a TAC fee counts with it.
let PRICES = null, pricesAt = 0;
async function prices() {
  if (Date.now() - pricesAt > 60e3) { pricesAt = Date.now(); PRICES = await readPrices({ call: (to, data) => rpc('eth_call', [{ to, data }, 'latest']) }).catch(() => PRICES); }
  return PRICES;
}
async function readBoards() {
  const fresh = Date.now() - nostrAt > 60e3;
  const [a, n] = await Promise.allSettled([readBoard({ api: API }), fresh ? NB.read() : Promise.resolve(nostrJobs)]);
  if (fresh && n.status === 'fulfilled') { nostrJobs = n.value; nostrAt = Date.now(); }
  const api = a.status === 'fulfilled' ? a.value.jobs : null;
  if (!api && !nostrJobs) throw new Error('Neither the API’s board nor the Nostr relays answered.');
  if (api && nostrJobs) mirror(api).catch(() => {});
  return { jobs: mergeBoards(api, nostrJobs), api: !!api, nostr: nostrJobs?.length ?? null };
}
// The API's open jobs that no relay carries yet, posted from here: two at a time, each once an hour.
async function mirror(api) {
  const on = new Set((nostrJobs || []).map((j) => j.publicValues.toLowerCase()));
  for (const [k, at] of MIRRORED) if (Date.now() - at > 3600e3) MIRRORED.delete(k);
  const todo = api.filter((j) => j.status === 'open' && j.publicValues && j.proof && Array.isArray(j.memos) && !on.has(j.publicValues.toLowerCase()) && !MIRRORED.has(j.publicValues.toLowerCase())).slice(0, 2);
  for (const j of todo) {
    MIRRORED.set(j.publicValues.toLowerCase(), Date.now());
    try { await NB.post(j); } catch { /* a type the board does not carry, or no relay took it */ }
  }
}
const reportIf = (jobId, txHash) => (String(jobId).startsWith('nostr:') ? Promise.resolve() : reportLanded({ api: API, jobId, txHash }));
// What a settle (or several together) pays its sender, in words: its ETH, and its TAC apart (a TAC pool unit is 10^10 of TAC's 18-decimal units).
function feeText(pv) {
  const pvs = [].concat(pv), eth = pvs.reduce((a, p) => a + ethFeeWei(p), 0n), tacWei = pvs.reduce((a, p) => a + feeWeiOf(p, { tacWeiPerUnit: 10n ** 10n }), 0n) - eth;
  return [eth > 0n ? `${ethText(eth)} ETH` : null, tacWei > 0n ? `${ethText(tacWei)} TAC` : null].filter(Boolean).join(' and ');
}
async function refreshBoard() {
  await prices().catch(() => {});
  try { board = await readBoards(); boardErr = false; } catch { boardErr = true; }   // a board read before stays shown
  paintBoard();
}
function paintBoard() {
  const box = $('#board-box'), btn = $('#btn-board');
  if (!board) { if (boardErr) box.innerHTML = '<p>Could not read the board. The page tries again every minute.</p>'; }
  else {
    const s = boardSummary(board.jobs, { prices: PRICES }), legs = feeText(board.jobs.filter((j) => sendable(j)).map((j) => j.publicValues));
    const fees = legs ? `${legs} in fees` : s.feeUsd > 0 ? `≈ $${s.feeUsd.toFixed(2)} in fees` : 'no fee';
    const eth = ethFor(SETTLE_GAS);
    box.innerHTML = `<p>${s.waiting ? `${esc(plural(s.waiting, 'settle'))} waiting · ${esc(fees)}${eth ? ` · network fee ${eth.startsWith('<') ? esc(eth) : `≈ ${esc(eth)}`} ETH each` : ''}` : 'Nothing waiting.'}</p>`;
    const where = !board.api ? 'The API’s board is not answering: these are the ones posted on Nostr.' : board.nostr == null ? '' : `Read from the API and ${board.nostr ? `Nostr (${int(board.nostr)} posted there)` : 'Nostr'}.`;
    if (where) box.innerHTML += `<p class="mute">${esc(where)}</p>`;
  }
  if (btn.getAttribute('aria-busy') === 'true') return;           // a send in progress keeps its button
  const next = board && pickSettle(board.jobs, { skip, prices: PRICES });
  btn.disabled = !next;
  btn.textContent = next ? 'Send one' : 'Nothing to send';
}
async function doSendOne() {
  const out = $('#board-status');
  out.textContent = '';
  if (!S.address) await connect();
  await noneOnItsWay();                                           // a settle of this wallet's still on its way is said before the board is read
  await refreshBoard();
  const job = board && pickSettle(board.jobs, { skip, prices: await prices() });
  if (!job) { toast('Nothing is waiting to be sent.'); return; }
  const data = settleCalldata(job), fee = feeText(job.publicValues);
  taken.add(job.jobId);
  try {
    // Run it first: a settle another wallet sent first, or one the pool no longer takes, costs gas to find out, and the node tells us for free.
    try { await rpc('eth_call', [{ from: S.address, to: POOL, data }, 'latest']); }
    catch { passed.add(job.jobId); throw new Error('The pool would not take this settle, so nothing was sent: another wallet most likely sent it first.'); }
    const est = BigInt(await rpc('eth_estimateGas', [{ from: S.address, to: POOL, data }]));
    out.textContent = 'Confirm the transaction in your wallet.';
    let txHash;
    try { txHash = await send({ to: POOL, data, gas: (est * 125n) / 100n }); }
    catch (e) { out.textContent = ''; throw e; }
    out.innerHTML = `Sent ${txLink(txHash, short(txHash, 8))}. Waiting for it to land…`;
    // One still on its way when the wait gives up is not offered again on this page, to either sender: a second one could only revert.
    const rcpt = await waitReceipt(txHash).catch((e) => { passed.add(job.jobId); throw e; });
    if (!landed(rcpt)) { out.innerHTML = `Reverted: ${txLink(txHash, short(txHash, 8))}.`; passed.add(job.jobId); throw new Error('The settle reverted: another wallet may have sent it first. Nothing was lost but its network fee.'); }
    await reportIf(job.jobId, txHash).catch(() => {});
    out.innerHTML = `Landed: ${txLink(txHash, short(txHash, 8))}.${fee ? ` ${esc(fee)} went to ${esc(short(S.address))}.` : ''}`;
    toast('Settle sent');
  } finally { taken.delete(job.jobId); }
  refreshBoard().catch(() => {});
}

// ── the board's settles sent while this tab is open (prove/autorelay.js), from a relay account kept in this browser: it signs with no
// popup, so it holds only gas money. Its key never leaves this browser; Take out sends what it holds to the connected wallet.
const RELAY_KEY = 'tacit-relay-account-v1', AUTO_ON = 'tacit-relay-auto-v1', AUTO_DAY = 'tacit-relay-day-v1';
const PROTECT = 'https://rpc.flashbots.net/fast?hint=hash';
const evmAcct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }), evmTx = makeEvmTx({ secp, keccak256: keccak_256 });
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} } };
const A = { acct: null, relay: null, on: false, running: false, said: '', bal: null, adding: false, taking: false };
function relayAcct(make = false) {
  if (A.acct) return A.acct;
  let priv = ls.get(RELAY_KEY);
  if (!/^0x[0-9a-f]{64}$/.test(priv || '')) {
    if (!make) return null;
    priv = '0x' + evmAcct.toValidScalar(crypto.getRandomValues(new Uint8Array(32))).toString(16).padStart(64, '0');
    ls.set(RELAY_KEY, priv);
  }
  A.acct = { priv, address: evmAcct.addressFromPriv(priv) };
  return A.acct;
}
async function sendPrivate(raw) {
  const j = await fetch(PROTECT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }) }).then((r) => r.json());
  if (j.error || !TX_HASH.test(j.result || '')) throw new Error(j.error?.message || 'Flashbots Protect did not take it');
  return j.result.toLowerCase();
}
// No `prices`: a TAC fee leg is paid to the relay account as TAC, which Take out does not send, so it takes only settles whose ETH pays the gas.
function autoRelay() {
  const a = relayAcct(true);
  return (A.relay ||= makeAutoRelay({ address: a.address, rpc, sign: (tx) => evmTx.signEip1559(tx, a.priv), sendPrivate,
    board: () => readBoards(), landed: (jobId, txHash) => reportIf(jobId, txHash), taken,
    store: { get: () => { try { return JSON.parse(ls.get(AUTO_DAY) || 'null'); } catch { return null; } }, set: (v) => ls.set(AUTO_DAY, JSON.stringify(v)) } }));
}
// `read` false keeps the balance a pass just read.
async function paintAuto(read = true) {
  const box = $('#auto-box'), btn = $('#btn-auto');
  if (!box) return;
  const a = relayAcct();
  if (a && read) A.bal = await rpc('eth_getBalance', [a.address, 'latest']).then(BigInt, () => A.bal);
  const t = a ? autoRelay().today() : null;
  box.innerHTML = a ? `<p>Relay account <b title="${esc(a.address)}">${esc(short(a.address))}</b> <button class="link" type="button" data-auto-copy>copy</button> · ${A.bal == null ? '—' : `${esc(ethText(A.bal))} ETH`}`
      + ` · <button class="link" type="button" data-auto-add${A.adding ? ' disabled' : ''}>Add 0.01 ETH</button>${A.bal > 0n ? ` · <button class="link" type="button" data-auto-out${A.taking ? ' disabled' : ''}>Take out</button>` : ''}</p>`
      + `<p>Today: ${esc(plural(t.sent, 'settle'))} sent · earned ${esc(ethText(BigInt(t.earnedWei)))} ETH · gas ${esc(ethText(BigInt(t.gasWei)))} ETH</p>`
    : '<p>Start makes a relay account in this browser. Add a little ETH to it for gas; keep only that much there.</p>';
  btn.textContent = A.on ? 'Stop' : 'Start';
  btn.setAttribute('aria-pressed', String(A.on));
  const low = A.on && A.bal != null && A.bal < AUTO_RESERVE_WEI * 2n;
  $('#auto-status').textContent = low ? 'Add a little ETH to the relay account: it starts sending once it holds enough for gas.' : A.said;
}
const inFlight = () => (relayAcct() ? autoRelay().today().inFlight : null);
// With the relay off, a settle still on its way is seen home all the same (counted, reported), and nothing new is sent.
async function autoTick() {
  if (A.running || !(A.on || inFlight())) return;
  A.running = true;
  let read = true;
  try {
    if (A.on) { const r = await autoRelay().pass(); A.said = r.why; if (r.bal != null) { A.bal = r.bal; read = false; } if (r.did === 'landed') toast('A settle landed; its fee is in the relay account'); }
    else if (await autoRelay().check() === 'landed') toast('A settle landed; its fee is in the relay account');
  }
  catch (e) { A.said = `Could not read the board or the chain just now (${String(e?.message || e).slice(0, 80)}). It tries again.`; }
  finally { A.running = false; paintAuto(read).catch(() => {}); }
}
function autoSet(on) {
  A.on = on; ls.set(AUTO_ON, on ? '1' : null);
  A.said = on ? 'Watching the board…' : 'Stopped.';
  if (on) { relayAcct(true); autoTick(); }
  paintAuto().catch(() => {});
}
// One add at a time: the box is drawn again while it waits (a fresh button each time), so the add in flight is kept here, not on the button.
async function autoAdd() {
  if (A.adding) return;
  A.adding = true; paintAuto();
  try {
    const a = relayAcct(true);
    const hash = await send({ to: a.address, data: '0x', gas: 21000n, value: 10n ** 16n });
    A.said = 'Sending 0.01 ETH to the relay account…'; paintAuto();
    if (!landed(await waitReceipt(hash))) throw new Error('That transfer did not go through.');
    toast('0.01 ETH added to the relay account');
  } finally { A.adding = false; }
}
// One at a time, as the add is. Nothing leaves while the relay is on or a settle is on its way: that settle's gas stays in the account, and a
// private send is not in the public mempool, so a transfer signed meanwhile would take its nonce.
async function autoOut() {
  if (A.taking) return;
  if (A.on) throw new Error('Stop the relay first, then take out what the account holds.');
  if (A.running || inFlight()) throw new Error('A settle is still on its way from the relay account. Wait for it to land, then take out.');
  const a = relayAcct();
  if (!a) return;
  A.taking = true; paintAuto();
  try {
    if (!S.address) await connect();
    const [bal, nonce, block] = await Promise.all([rpc('eth_getBalance', [a.address, 'latest']).then(BigInt), rpc('eth_getTransactionCount', [a.address, 'pending']).then(BigInt), rpc('eth_getBlockByNumber', ['latest', false])]);
    const tip = 10n ** 8n, maxFee = BigInt(block.baseFeePerGas) * 2n + tip, value = bal - 21000n * maxFee;
    if (value <= 0n) throw new Error('The relay account holds too little to cover the transfer’s own network fee.');
    const { raw } = evmTx.signEip1559({ chainId: 1n, nonce, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gasLimit: 21000n, to: S.address, value, data: '0x' }, a.priv);
    const hash = await rpc('eth_sendRawTransaction', [raw]);
    A.said = `Sending ${ethText(value)} ETH to ${short(S.address)}…`; paintAuto();
    if (!landed(await waitReceipt(hash))) throw new Error('That transfer did not go through.');
    toast('Taken out to your wallet');
  } finally { A.taking = false; }
}

// The proof market's board (GET /market/orders): the orders waiting for a prover, each a holder's wrap and the TAC it pays at most.
async function refreshMarket() {
  const box = $('#prove-box');
  let j = null;
  try { const r = await fetch(`${API}/market/orders?limit=50`, { cache: 'no-store' }); if (r.ok) j = await r.json(); else if (r.status === 404) { $('#g-prove').hidden = true; return; } } catch {}
  if (!j) { box.innerHTML = '<p>Could not read the board. The page tries again every minute.</p>'; return; }
  const os = j.orders || [], most = os.reduce((m, o) => (BigInt(o.intent.maxFee) > m ? BigInt(o.intent.maxFee) : m), 0n);
  box.innerHTML = os.length ? `<p>${esc(plural(os.length, 'order'))} waiting · the best pays up to ${esc((Number(most / 10n ** 14n) / 1e4).toFixed(2))} TAC</p>` : '<p>No orders waiting. Tacit’s relay takes them first, so orders reach the board when it is busy.</p>';
}

// The connected wallet is left from here (evm.disconnect): a WalletConnect session ends in the wallet app too, so the next connection can pair another app or
// account; a browser wallet takes this site's permission back, so the next connection asks which account. Either way no page connects it again on load.
// Change account: another account of the same wallet (its own chooser), or a new pairing for a wallet app.
function walletSheet() {
  const wc = !!S.provider?.isWalletConnect, app = S.provider?.peerName?.(), via = wc ? `WalletConnect${app ? ` · ${app}` : ''}` : evm.providerLabel();
  const o = wcOpen('Wallet');
  o.body.innerHTML = `<div class="kv"><span>Connected with</span><b>${esc(via)} <button class="link" type="button" data-change>Change account</button></b></div><div class="kv"><span>Account</span><b>${esc(S.address)}</b></div><button class="btn ghost" type="button" data-off>Disconnect</button>`;
  o.body.querySelector('[data-change]').onclick = () => { o.close(); busy($('#wallet'), () => connect({ change: true })); };
  o.body.querySelector('[data-off]').onclick = () => { o.close(); evm.disconnect(); S.provider = S.address = null; paintWallet(); };
}
$('#wallet').addEventListener('click', (e) => (S.address ? walletSheet() : busy(e.currentTarget, connect)));
document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });
$('#btn-advance').addEventListener('click', (e) => busy(e.currentTarget, doAdvance));
$('#btn-ancestry').addEventListener('click', (e) => busy(e.currentTarget, doAncestry));
$('#btn-proof').addEventListener('click', (e) => busy(e.currentTarget, doSubmitProof));
$('#btn-board').addEventListener('click', (e) => busy(e.currentTarget, doSendOne));
$('#btn-auto')?.addEventListener('click', () => autoSet(!A.on));
$('#auto-box')?.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.matches('[data-auto-copy]')) { navigator.clipboard?.writeText(relayAcct()?.address || '').then(() => toast('Address copied'), () => {}); return; }
  if (b.matches('[data-auto-add]')) busy(b, autoAdd).then(() => paintAuto());
  if (b.matches('[data-auto-out]')) busy(b, autoOut).then(() => paintAuto());
});
window.addEventListener('hashchange', () => { readLink(); if (started) refresh().catch(() => {}); });

paintWallet();
restoreWallet();
evm.onElsewhere(restoreWallet);                                  // a wallet connected in another tab is connected here too

// The reads start when a tab that shows them first opens (app.js calls startOps), then repeat every minute while one is in view, and at
// once when the page comes back after longer.
const inView = () => !document.hidden && [...document.querySelectorAll('.tab.ops')].some((t) => !t.hidden);
const readAll = () => { refresh().catch(() => {}); refreshProof().catch(() => {}); refreshBoard().catch(() => {}); refreshMarket().catch(() => {}); };
let started = false;
// The Prove tab's market card reads on its own, the rest waiting for a tab that shows them: once the page has settled (app.js), then each
// minute while the page is in view, until startOps takes it over.
let marketOn = false;
export function startMarket() {
  if (marketOn || started) return;
  marketOn = true;
  refreshMarket().catch(() => {});
  setInterval(() => { if (!document.hidden && !started) refreshMarket().catch(() => {}); }, 60000);
}
export function startOps() {
  if (started) return;
  started = true;
  refreshProof().catch(() => {});
  refresh().catch(readFailed);
  refreshBoard().catch(() => {});
  refreshMarket().catch(() => {});
  setInterval(() => { if (inView()) readAll(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (inView() && Date.now() - lastRead > 60000) readAll(); });
}

// The board's settles: every 20 s while it is on, from the moment the page opens and whichever tab shows (a hidden tab's timers slow to
// once a minute). One started before is started again when the page is opened again.
paintAuto().catch(() => {});
if (ls.get(AUTO_ON) === '1' && relayAcct()) autoSet(true);
setInterval(autoTick, 20000);
