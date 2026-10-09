// ETH panel of the Secret Sats page: the EVM pool (docs/EVM-POOL.md) on Ethereum, Base and Robinhood Chain, under the
// same Tacit key as the sats side. mount(el, ctx) renders into el.
//   ctx = { wallet, network, ensureKey, errMsg, onWallet, switchNet, hold, toast }
// Proofs run in a worker on this device and a relay submits them, so no gas and no funded address are needed.
// The proving key is the ceremony's: /evm-pool/pin.json names it and its files by SHA-256.
// Link: /sats#eth=<chain id>[&do=send|withdraw] opens this panel on that chain, at that form.

import { makeEvmPoolZk } from '/evm-pool-zk.js?cb=2f062779';
import { evmPoolKeys, makeEvmPoolWallet, jsonRpc } from '/evm-pool-wallet.js?cb=e689bce4';
import { vkHash } from '/evm-pool-zk-prover.js?cb=00ff69c2';
import { poolRecipient } from '/pool-recipient.js?cb=a9311fc4';
import { L2_BRIDGES } from '/evm-pool-gateway.js';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from '../vendor/tacit-poseidon.min.js';

const WORKER_URL = '/evm-pool-prove-worker.js?cb=7f41e5e0';
const O = globalThis.__TACIT_EVM_POOL__ || {};
const POOL = O.pool || '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
const ROUTER = O.router || '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const ARTIFACTS = O.artifacts || '/evm-pool/';
// keeper: the relay's …/evm-pool/keeper base. deployBlock: where event scans start.
const CHAINS = O.chains || [
  { chainId: 1, name: 'Ethereum', rpc: ['https://ethereum-rpc.publicnode.com', 'https://mainnet.gateway.tenderly.co', 'https://eth.drpc.org'], explorer: 'https://etherscan.io', keeper: 'https://tacit-evm-pool-keeper.onrender.com/evm-pool/keeper', deployBlock: 26069245, confirmations: 3 },
  { chainId: 8453, name: 'Base', rpc: ['https://mainnet.base.org', 'https://base.drpc.org'], explorer: 'https://basescan.org', keeper: 'https://tacit-evm-pool-keeper-base.onrender.com/evm-pool/keeper', deployBlock: 51864014, confirmations: 10 },
  { chainId: 4663, name: 'Robinhood Chain', rpc: ['https://rpc.mainnet.chain.robinhood.com'], explorer: 'https://robinhoodchain.blockscout.com', keeper: 'https://tacit-evm-pool-keeper-robinhood.onrender.com/evm-pool/keeper', deployBlock: 73991661, confirmations: 10 },
];
const CHAIN_PREF = 'tacit-sats-eth-chain-v1';
const CACHE_NAME = 'tacit-evm-pool-artifacts-v1';
const POLL_MS = 30_000;
const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const c of kids) if (c != null && c !== '') n.append(c);
  return n;
}
const short = (s, k = 10) => (s && s.length > 2 * k + 1 ? `${s.slice(0, k)}…${s.slice(-k)}` : s || '');
function fmtEth(wei) {
  const w = BigInt(wei);
  const whole = w / 10n ** 18n;
  const frac = (w % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${frac ? '.' + frac : ''} ETH`;
}
function parseEth(s) {
  const m = String(s).trim().match(/^(\d*)(?:\.(\d{0,18}))?$/);
  if (!m || (!m[1] && !m[2])) throw new Error('Enter an amount in ETH, at most 18 decimals.');
  const wei = BigInt(m[1] || '0') * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0') || '0');
  if (wei <= 0n) throw new Error('Enter an amount above zero.');
  return wei;
}
// The most the relay may take for a spend: a quarter above its quote, as the pay pages cap it. A quote above this is
// refused by the wallet, so nothing costs more than the confirmation said.
const capOf = (fee) => (BigInt(fee) * 5n) / 4n;
// Gas a bridge-out burns, by the kind of bridge (as bridgeOut asks the relay to price it).
const BRIDGE_GAS = { op: 1_300_000, arbitrum: 700_000 };
const hexOf = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
async function copy(text) { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } }

// ── proving artifacts (pinned by /evm-pool/pin.json) and the worker ──

let pinP = null;
const pin = () => (pinP ||= fetch(ARTIFACTS + 'pin.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null));

async function artifact(name, sha, onProgress) {
  const url = ARTIFACTS + name;
  const key = `${url}?sha256=${sha}`;
  let cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch {}
  const hit = cache ? await cache.match(key).catch(() => null) : null;
  let bytes;
  if (hit) bytes = new Uint8Array(await hit.arrayBuffer());
  else {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    const total = Number(r.headers.get('content-length')) || 0;
    const reader = r.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      onProgress?.(name, got, total);
    }
    bytes = new Uint8Array(got);
    let o = 0;
    for (const c of parts) { bytes.set(c, o); o += c.length; }
  }
  if (hexOf(await crypto.subtle.digest('SHA-256', bytes)) !== String(sha).replace(/^0x/, '').toLowerCase()) {
    if (hit) await cache.delete(key).catch(() => {});
    throw new Error(`${name} does not match the ceremony's pinned hash`);
  }
  if (!hit && cache) await cache.put(key, new Response(bytes)).catch(() => {});
  return bytes;
}

let proverP = null;
function prover(onProgress) {
  return (proverP ||= (async () => {
    const p = await pin();
    if (!p) throw new Error('The proving key is not published yet.');
    const [vkBytes, wasm, zkey] = await Promise.all([artifact(p.vk, p.vk_sha256, onProgress), artifact(p.wasm, p.wasm_sha256, onProgress), artifact(p.zkey, p.zkey_sha256, onProgress)]);
    const vk = JSON.parse(new TextDecoder().decode(vkBytes));
    if (vkHash(vk) !== String(p.vk_hash).replace(/^0x/, '').toLowerCase()) throw new Error('verification key does not match the ceremony pin');
    const worker = new Worker(WORKER_URL, { type: 'module' });
    let id = 0;
    const waiting = new Map();
    worker.onmessage = ({ data }) => { const w = waiting.get(data.id); if (!w) return; waiting.delete(data.id); data.ok ? w.resolve(data) : w.reject(new Error(data.error)); };
    // A worker that fails to start or dies ends every proof it holds, and the next one starts a fresh worker: a proof
    // never waits forever on a worker that is gone.
    const dead = (e) => {
      proverP = null;
      try { worker.terminate(); } catch {}
      const err = new Error(`The prover stopped${e?.message ? `: ${e.message}` : ''}. Try again.`);
      for (const w of waiting.values()) w.reject(err);
      waiting.clear();
    };
    worker.onerror = (e) => { e.preventDefault?.(); dead(e); };
    worker.onmessageerror = () => dead(null);
    const call = (msg) => new Promise((resolve, reject) => { const i = ++id; waiting.set(i, { resolve, reject }); worker.postMessage({ ...msg, id: i }); });
    await call({ op: 'init', wasm, zkey, vk });
    return async (input) => { const r = await call({ op: 'prove', input }); return { proof: r.proof, publicSignals: r.publicSignals }; };
  })().catch((e) => { proverP = null; throw e; }));
}

// ── panel ──

export async function mount(root, ctx) {
  const status = el('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
  // The pool read's own line: a failed read never covers what an action said (a send's link stays on screen).
  const sync = el('p', { class: 'note small', hidden: true });
  const say = (msg, kind = '') => { status.replaceChildren(msg ? el('span', { class: kind === 'error' ? 'err' : '' }, msg) : ''); };
  const errText = (e) => (ctx.errMsg ? ctx.errMsg(e) : String(e?.message || e));
  const link = new URLSearchParams(location.hash.replace(/^#/, ''));
  const linked = CHAINS.find((c) => String(c.chainId) === link.get('eth'));
  if (linked) store.set(CHAIN_PREF, String(linked.chainId));
  const focus = { send: 'eth-to', withdraw: 'eth-wto' }[link.get('do')] || null;
  let chain = linked || CHAINS.find((c) => String(c.chainId) === store.get(CHAIN_PREF)) || CHAINS[1] || CHAINS[0];
  let W = null;
  let owner = null;    // the Tacit key W was made from
  let live = null;
  let timer = null;
  let pending = 0;     // actions in flight: the chain and the key stay put until they end
  let drawing = 0;     // the latest render; an older one that finishes later draws nothing

  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Chain', style: 'margin: 0 0 var(--s4)' });
  const body = el('div');
  root.replaceChildren(seg, body, sync, status);

  const pubOf = () => (ctx.wallet?.pub ? hexOf(ctx.wallet.pub) : null);

  function renderSeg() {
    seg.replaceChildren(...CHAINS.map((c) => el('button', {
      type: 'button', 'aria-pressed': String(c === chain),
      onclick: () => {
        if (c === chain) return;
        if (pending) { say('Wait for the transaction in progress to finish, then switch chains.', 'error'); return; }
        chain = c; store.set(CHAIN_PREF, String(c.chainId)); W = null; live = null; say(''); render();
      },
    }, c.name)));
  }

  // true: the pool is on this chain and its proving key is published. false: it is not. A chain that cannot be read
  // throws, and is asked again next time rather than taken as closed.
  async function isLive() {
    if (live !== null) return live;
    const rpc = jsonRpc(chain.rpc);
    const [code, p] = await Promise.all([rpc('eth_getCode', [POOL, 'latest']), pin()]);
    live = !!code && code !== '0x' && !!p;
    return live;
  }

  function closed() {
    body.replaceChildren(
      el('p', { class: 'note' }, `Private ETH is not open on ${chain.name} yet. Hold, send and withdraw ETH privately on the chains above where it is, with every transaction proved on this device and sent by a relay, so you need no gas.`),
    );
  }

  function unreachable(e) {
    body.replaceChildren(
      el('p', { class: 'note' }, `Could not reach ${chain.name} just now (${errText(e)}).`),
      el('div', { class: 'row' }, el('button', { class: 'btn quiet sm', type: 'button', onclick: () => render() }, 'Try again')),
    );
  }

  function wrongNet() {
    body.replaceChildren(
      el('p', { class: 'note' }, 'Private ETH runs on mainnets and uses this page’s mainnet key. Switch the page to mainnet to use it.'),
      el('div', { class: 'row' }, el('button', { class: 'btn', type: 'button', onclick: () => ctx.switchNet('mainnet') }, 'Switch to mainnet')),
    );
  }

  function locked() {
    body.replaceChildren(
      el('p', { class: 'note' }, 'Unlock your wallet to see your private ETH.'),
      el('div', { class: 'row' }, el('button', { class: 'btn', type: 'button', onclick: async () => { try { await ctx.ensureKey(); render(); } catch (e) { say(errText(e), 'error'); } } }, 'Unlock')),
    );
  }

  function signedOut() {
    body.replaceChildren(el('p', { class: 'note' }, 'Connect a wallet above to use private ETH on Ethereum, Base and Robinhood Chain, with the same key as your sats.'));
  }

  function wallet() {
    if (W && owner === pubOf()) return W;
    const keys = evmPoolKeys(zk, ctx.wallet.priv);
    owner = pubOf();
    W = makeEvmPoolWallet({
      zk, keys, keeper: chain.keeper, store,
      chain: { chainId: chain.chainId, pool: POOL, router: ROUTER, rpc: jsonRpc(chain.rpc), deployBlock: chain.deployBlock ?? 0, confirmations: chain.confirmations },
      prove: async (input) => (await prover((name, got, total) => say(`Getting the proving key once: ${name} ${total ? Math.floor((got / total) * 100) + '%' : ''}`)))(input),
    });
    return W;
  }

  function copyRow(label, value, hint) {
    const b = el('b', { title: value }, short(value, 12));
    const a = el('button', { type: 'button', class: 'link-btn', onclick: async () => {
      if (await copy(value)) { ctx.toast ? ctx.toast('Copied') : null; a.textContent = 'copied'; setTimeout(() => { a.textContent = 'copy'; }, 1500); }
      else if (ctx.toast) ctx.toast(`Could not copy: ${value}`, true);
    } }, 'copy');
    return [el('div', { class: 'kv' }, el('span', {}, label), b, el('span', { class: 'acts' }, a)), hint ? el('p', { class: 'note small' }, hint) : null];
  }

  function field(id, label, placeholder, mode = 'text') {
    return el('div', { class: 'field' }, el('label', { for: id }, label), el('input', { type: 'text', id, placeholder, inputmode: mode, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }));
  }

  // One action at a time per button; the page holds its key and network until it ends, and asks before closing.
  async function action(btn, fn) {
    if (btn.dataset.busy === '1') return;
    btn.disabled = true; btn.dataset.busy = '1';
    pending++;
    const release = ctx.hold?.() || (() => {});
    try { await fn(); } catch (e) { const t = errText(e); say(t, /^Cancelled/.test(t) ? '' : 'error'); }
    finally { release(); pending--; btn.disabled = false; delete btn.dataset.busy; }
  }

  // The relay's fee for this spend now, shown in a confirmation with its cap; the spend then refuses a higher quote.
  async function confirmFee(w, words, gas = null) {
    const q = await w.quote(gas);
    const cap = capOf(q.fee);
    if (!confirm(`${words}\n\nThe relay's fee is at most ${fmtEth(cap)}, from your private balance (the same again for each pair of notes it combines first).`)) {
      throw new Error('Cancelled.');
    }
    return cap;
  }

  async function refresh() {
    if (!W) return;
    const mine = W;
    try {
      const s = await mine.sync();
      if (mine !== W) return;
      const bal = root.querySelector('#eth-bal');
      if (bal) bal.textContent = fmtEth(s.balance);
      await showWaiting();
      sync.hidden = true;
    } catch (e) {
      if (mine !== W) return;
      sync.textContent = `Could not read the pool on ${chain.name} just now (${errText(e)}). This page tries again on its own.`;
      sync.hidden = false;
    }
  }

  // A browser wallet (EIP-1193) on this chain, as the pool wallet's signer.
  async function browserSigner() {
    const eth = globalThis.ethereum;
    if (!eth?.request) throw new Error('No browser wallet found.');
    const [from] = await eth.request({ method: 'eth_requestAccounts' });
    const want = '0x' + chain.chainId.toString(16);
    if ((await eth.request({ method: 'eth_chainId' })) !== want) await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
    return { address: from, send: ({ to, data, value }) => eth.request({ method: 'eth_sendTransaction', params: [{ from, to, data, value: '0x' + BigInt(value).toString(16) }] }) };
  }

  // ETH at the private ETH address, the smallest amount the relay collects at today's gas price, and what a relayed
  // send or withdrawal costs now.
  async function showWaiting() {
    const p = root.querySelector('#eth-wait');
    if (!p || !W) return;
    const [held, q] = await Promise.all([W.waiting(), chain.keeper ? W.quote().catch(() => null) : null]);
    const min = q?.receiveMin ? ((BigInt(q.receiveMin) + 10n ** 12n - 1n) / 10n ** 12n) * 10n ** 12n : null; // rounded up to what fmtEth shows
    const stuck = held > 0n && min && held < min;
    p.textContent = '';
    if (held > 0n) p.textContent = stuck
      ? `${fmtEth(held)} is at your private ETH address. The relay collects it once it reaches ${fmtEth(min)} at today's gas price.`
      : `${fmtEth(held)} is at your private ETH address, on its way into your private balance.`;
    else if (min) p.textContent = `At today's gas price, send at least ${fmtEth(min)} at a time.`;
    p.hidden = !p.textContent;
    const collect = root.querySelector('#eth-collect');
    if (collect) collect.hidden = !(held > 0n && (stuck || !chain.keeper) && globalThis.ethereum?.request);
    const fee = root.querySelector('#eth-fee');
    if (fee) { fee.textContent = q?.fee ? `The relay's fee is ${fmtEth(BigInt(q.fee))} now, taken from your private balance.` : ''; fee.hidden = !fee.textContent; }
  }

  function main() {
    const w = wallet();
    const relayed = !!chain.keeper;
    const sendBtn = el('button', { class: 'btn', type: 'button', disabled: !relayed }, 'Send privately');
    const wdBtn = el('button', { class: 'btn quiet', type: 'button', disabled: !relayed }, 'Withdraw');
    const checkBtn = el('button', { class: 'btn quiet sm', type: 'button', disabled: !relayed }, 'Check for payments');
    const explorer = (h) => el('a', { href: `${chain.explorer}/tx/${h}`, target: '_blank', rel: 'noopener noreferrer' }, short(h, 8));
    const step = (m) => say(m[0].toUpperCase() + m.slice(1) + '…');
    const val = (id) => root.querySelector('#' + id).value;

    body.replaceChildren(...[
      el('p', { class: 'note' }, `Private ETH on ${chain.name}: proved on this device, sent by a relay, so you need no gas. Deposits to your private ETH address and withdrawals show on chain; payments inside the pool do not.`),
      el('div', { class: 'kv' }, el('span', {}, 'private balance'), el('b', { id: 'eth-bal' }, '…')),
      ...copyRow('private ETH address', w.receiveBox, `Send ETH here from any wallet or exchange on ${chain.name}. It moves into your private balance within minutes, less at most 0.25%.`),
      el('p', { class: 'note small', id: 'eth-wait', hidden: true }),
      el('div', { class: 'row' }, el('button', { class: 'btn quiet sm', type: 'button', id: 'eth-collect', hidden: true }, 'Collect it now from my wallet')),
      ...copyRow('pool address', w.address, 'For private payments from other Tacit users: ETH in this pool, TAC in the pool on Bitcoin. Nothing on chain links a payment to it.'),
      el('div', { class: 'row' }, checkBtn),
      relayed ? null : el('p', { class: 'note' }, `Sending and withdrawing open on ${chain.name} when its relay is announced.`),
      el('p', { class: 'note small', id: 'eth-fee', hidden: true }),
      el('h3', {}, 'Send privately'),
      field('eth-to', 'To: a Tacit address (tacit1…) or pool address (bp1…)', 'tacit1… or bp1…'),
      field('eth-amt', 'Amount (ETH)', '0.01', 'decimal'),
      el('div', { class: 'row' }, sendBtn),
      el('h3', {}, 'Withdraw'),
      field('eth-wto', 'To: any 0x address (a fresh one leaves no link to you)', '0x…'),
      field('eth-wamt', 'Amount (ETH)', '0.01', 'decimal'),
      el('div', { class: 'row' }, wdBtn),
      ...(chain.chainId === 1 && relayed ? [
        el('h3', {}, 'Move to an L2'),
        el('p', { class: 'note small' }, 'Moves ETH from here to your private ETH address on Base or Robinhood Chain through its canonical bridge, in one relayed transaction. It arrives in minutes and is collected into your private balance there. The amount is public on Ethereum; which of your notes paid is not.'),
        el('div', { class: 'seg', role: 'group', 'aria-label': 'Destination', id: 'eth-bdest' },
          ...CHAINS.filter((c) => c.chainId !== 1).map((c, i) => el('button', { type: 'button', 'data-chain': String(c.chainId), 'aria-pressed': String(i === 0) }, c.name))),
        field('eth-bamt', 'Amount (ETH)', '0.01', 'decimal'),
        el('div', { class: 'row' }, el('button', { class: 'btn quiet', type: 'button', id: 'eth-bbtn' }, 'Move privately')),
      ] : []),
    ].filter(Boolean));
    const collectBtn = root.querySelector('#eth-collect');
    collectBtn.title = 'Proves on this device and sends from your browser wallet: you pay the gas, no fee.';
    collectBtn.onclick = () => action(collectBtn, async () => {
      w.connect(await browserSigner());
      const h = await w.sweep({ onStep: step });
      status.replaceChildren('Collected in ', explorer(h), '.');
      refresh();
    });
    checkBtn.onclick = () => action(checkBtn, async () => { await w.watchReceive(); say('Asked the relay to check your private ETH address.'); await refresh(); });
    sendBtn.onclick = () => action(sendBtn, async () => {
      if (!val('eth-to').trim()) throw new Error('Enter a Tacit address (tacit1…) or pool address (bp1…).');
      const to = poolRecipient(val('eth-to'), 'mainnet'), amount = parseEth(val('eth-amt'));
      const maxFee = await confirmFee(w, `Send ${fmtEth(amount)} privately to ${short(to, 10)} on ${chain.name}?`);
      const h = await w.send({ to, amount, maxFee, onStep: step });
      status.replaceChildren(`Sent ${fmtEth(amount)} privately in `, explorer(h), '.');
      root.querySelector('#eth-amt').value = '';
      refresh();
    });
    const bseg = root.querySelector('#eth-bdest');
    if (bseg) {
      for (const b of bseg.querySelectorAll('button')) b.onclick = () => { for (const x of bseg.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b)); };
      const bBtn = root.querySelector('#eth-bbtn');
      bBtn.onclick = () => action(bBtn, async () => {
        const dest = CHAINS.find((c) => String(c.chainId) === bseg.querySelector('[aria-pressed="true"]').dataset.chain);
        const amount = parseEth(val('eth-bamt'));
        const gas = BRIDGE_GAS[L2_BRIDGES[dest.chainId]?.kind] || null;
        const maxFee = await confirmFee(w, `Move ${fmtEth(amount)} to your private ETH address on ${dest.name}? The amount shows on Ethereum.`, gas);
        const h = await w.bridgeOut({ toChainId: dest.chainId, amount, l2Rpc: jsonRpc(dest.rpc), maxFee, onStep: step });
        // The destination's relay collects the arrival; tell it to watch (the wallet there may never have been opened).
        const there = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, ctx.wallet.priv), keeper: dest.keeper, prove: null, chain: { chainId: dest.chainId, pool: POOL, router: ROUTER, rpc: jsonRpc(dest.rpc), deployBlock: dest.deployBlock } });
        there.watchReceive().catch(() => {});
        status.replaceChildren(`Sent to ${dest.name} in `, explorer(h), '. It arrives at your private ETH address there in a few minutes.');
        root.querySelector('#eth-bamt').value = '';
        refresh();
      });
    }
    wdBtn.onclick = () => action(wdBtn, async () => {
      const to = val('eth-wto').trim(), amount = parseEth(val('eth-wamt'));
      if (!/^0x[0-9a-fA-F]{40}$/.test(to) || BigInt(to) === 0n) throw new Error('Enter a 0x address to withdraw to.');
      const maxFee = await confirmFee(w, `Withdraw ${fmtEth(amount)} to ${short(to, 8)} on ${chain.name}? The withdrawal and its amount show on chain.`);
      const h = await w.withdraw({ to, amount, maxFee, onStep: step });
      status.replaceChildren(`Withdrawn ${fmtEth(amount)} in `, explorer(h), '.');
      root.querySelector('#eth-wamt').value = '';
      refresh();
    });
    if (relayed) w.watchReceive().catch(() => {});
    // The proving key (about 33 MB the first time, cached after) starts downloading once a form is in use.
    const warm = () => { prover((name, got, total) => say(`Getting the proving key once: ${name} ${total ? Math.floor((got / total) * 100) + '%' : ''}`)).then(() => say('')).catch(() => {}); };
    for (const id of ['eth-to', 'eth-amt', 'eth-wto', 'eth-wamt', 'eth-bamt']) root.querySelector('#' + id)?.addEventListener('focus', warm, { once: true });
    if (focus) root.querySelector('#' + focus)?.focus();
    refresh();
  }

  async function render() {
    const my = ++drawing;
    renderSeg();
    clearInterval(timer); timer = null;
    sync.hidden = true;
    if (ctx.network !== 'mainnet' && !O.chains) return wrongNet();
    if (!ctx.wallet?.pub) { W = null; owner = null; return signedOut(); }
    body.replaceChildren(el('p', { class: 'note' }, `Checking ${chain.name}…`));
    let open;
    try { open = await isLive(); } catch (e) { if (my === drawing) unreachable(e); return; }
    if (my !== drawing) return;
    if (!open) return closed();
    if (!ctx.wallet?.priv) return locked();
    main();
    timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  }

  // A different key (or none) drops the pool wallet made from the last one: its balance and addresses are never shown
  // under another key. A key unlocked for the first time draws the panel.
  let seen = pubOf(), seenUnlocked = !!ctx.wallet?.priv;
  ctx.onWallet?.((d) => {
    const pub = d?.pubHex || null, unlocked = !!d?.unlocked;
    const changed = pub !== seen;
    const opened = unlocked && !seenUnlocked;
    seen = pub; seenUnlocked = unlocked;
    if (changed) { W = null; owner = null; say(''); }
    if (changed || (opened && !W)) render();
  });
  await render();
  return { refresh: render };
}
