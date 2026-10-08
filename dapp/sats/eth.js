// ETH panel of the Secret Sats page: the EVM pool (docs/EVM-POOL.md) on Ethereum, Base and Robinhood Chain, under the
// same Tacit key and the same Secret Sats address as the sats side. mount(el, ctx) renders into el.
//   ctx = { wallet, network, ensureKey, errMsg, onWallet, switchNet }
// Proofs run in a worker on this device and a relayer submits them, so no gas and no funded address are needed.
// The proving key is the ceremony's: /evm-pool/pin.json names it and its files by SHA-256; until it is published
// the panel says the pool opens when the ceremony closes.
// Link: /sats#eth=<chain id>[&do=send|withdraw] opens this panel on that chain, at that form.

import { makeEvmPoolZk } from '/evm-pool-zk.js?cb=2f062779';
import { evmPoolKeys, makeEvmPoolWallet, jsonRpc } from '/evm-pool-wallet.js?cb=aed5615a';
import { vkHash } from '/evm-pool-zk-prover.js?cb=00ff69c2';
import { poolRecipient } from '/pool-recipient.js?cb=a9311fc4';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from '../vendor/tacit-poseidon.min.js';

const WORKER_URL = '/evm-pool-prove-worker.js?cb=7f41e5e0';
const O = globalThis.__TACIT_EVM_POOL__ || {};
const POOL = O.pool || '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
const ROUTER = O.router || '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const ARTIFACTS = O.artifacts || '/evm-pool/';
// keeper: the relayer's …/evm-pool/keeper base, published at launch. deployBlock: where event scans start.
const CHAINS = O.chains || [
  { chainId: 1, name: 'Ethereum', rpc: ['https://ethereum-rpc.publicnode.com', 'https://rpc.flashbots.net'], explorer: 'https://etherscan.io', keeper: 'https://tacit-evm-pool-keeper.onrender.com/evm-pool/keeper', deployBlock: 26069245, confirmations: 3 },
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
  if (!m || (!m[1] && !m[2])) throw new Error('enter an amount in ETH');
  const wei = BigInt(m[1] || '0') * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0') || '0');
  if (wei <= 0n) throw new Error('enter an amount above zero');
  return wei;
}
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
    if (!p) throw new Error('the proving key is not published yet');
    const [vkBytes, wasm, zkey] = await Promise.all([artifact(p.vk, p.vk_sha256, onProgress), artifact(p.wasm, p.wasm_sha256, onProgress), artifact(p.zkey, p.zkey_sha256, onProgress)]);
    const vk = JSON.parse(new TextDecoder().decode(vkBytes));
    if (vkHash(vk) !== String(p.vk_hash).replace(/^0x/, '').toLowerCase()) throw new Error('verification key does not match the ceremony pin');
    const worker = new Worker(WORKER_URL, { type: 'module' });
    let id = 0;
    const waiting = new Map();
    worker.onmessage = ({ data }) => { const w = waiting.get(data.id); if (!w) return; waiting.delete(data.id); data.ok ? w.resolve(data) : w.reject(new Error(data.error)); };
    const call = (msg) => new Promise((resolve, reject) => { const i = ++id; waiting.set(i, { resolve, reject }); worker.postMessage({ ...msg, id: i }); });
    await call({ op: 'init', wasm, zkey, vk });
    return async (input) => { const r = await call({ op: 'prove', input }); return { proof: r.proof, publicSignals: r.publicSignals }; };
  })().catch((e) => { proverP = null; throw e; }));
}

// ── panel ──

export async function mount(root, ctx) {
  const status = el('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const say = (msg, kind = '') => { status.replaceChildren(msg ? el('span', { class: kind === 'error' ? 'err' : '' }, msg) : ''); };
  const link = new URLSearchParams(location.hash.replace(/^#/, ''));
  const linked = CHAINS.find((c) => String(c.chainId) === link.get('eth'));
  if (linked) store.set(CHAIN_PREF, String(linked.chainId));
  const focus = { send: 'eth-to', withdraw: 'eth-wto' }[link.get('do')] || null;
  let chain = linked || CHAINS.find((c) => String(c.chainId) === store.get(CHAIN_PREF)) || CHAINS[1] || CHAINS[0];
  let W = null;
  let live = null;
  let timer = null;

  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Chain', style: 'margin: 0 0 var(--s4)' });
  const body = el('div');
  root.replaceChildren(seg, body, status);

  function renderSeg() {
    seg.replaceChildren(...CHAINS.map((c) => el('button', {
      type: 'button', 'aria-pressed': String(c === chain),
      onclick: () => { if (c === chain) return; chain = c; store.set(CHAIN_PREF, String(c.chainId)); W = null; live = null; say(''); render(); },
    }, c.name)));
  }

  async function isLive() {
    if (live !== null) return live;
    const rpc = jsonRpc(chain.rpc);
    const [code, p] = await Promise.all([rpc('eth_getCode', [POOL, 'latest']).catch(() => '0x'), pin()]);
    live = code && code !== '0x' && !!p;
    return live;
  }

  function soon() {
    body.replaceChildren(
      el('p', { class: 'note' }, 'Private ETH with the same address as your sats. Hold, send and withdraw ETH on Ethereum, Base and Robinhood Chain, with every transaction proved here, on this device, and sent by a relay so you need no gas.'),
      el('p', { class: 'note' }, 'It opens when the trusted setup for its circuit closes. Anyone can add randomness to it in a few minutes.'),
      el('div', { class: 'row' },
        el('a', { class: 'btn', href: '/?evmpool=ceremony' }, 'Help with the setup'),
        el('a', { class: 'btn quiet', href: '/ceremony/' }, 'How it works')),
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
      el('div', { class: 'row' }, el('button', { class: 'btn', type: 'button', onclick: async () => { try { await ctx.ensureKey(); render(); } catch (e) { say(ctx.errMsg(e), 'error'); } } }, 'Unlock')),
    );
  }

  function wallet() {
    if (W) return W;
    const keys = evmPoolKeys(zk, ctx.wallet.priv);
    W = makeEvmPoolWallet({
      zk, keys, keeper: chain.keeper, store,
      chain: { chainId: chain.chainId, pool: POOL, router: ROUTER, rpc: jsonRpc(chain.rpc), deployBlock: chain.deployBlock ?? 0, confirmations: chain.confirmations },
      prove: async (input) => (await prover((name, got, total) => say(`Getting the proving key once: ${name} ${total ? Math.floor((got / total) * 100) + '%' : ''}`)))(input),
    });
    return W;
  }

  function copyRow(label, value, hint) {
    const b = el('b', { title: value }, short(value, 12));
    const a = el('a', { href: '#', role: 'button', onclick: async (e) => { e.preventDefault(); if (await copy(value)) { a.textContent = 'copied'; setTimeout(() => { a.textContent = 'copy'; }, 1500); } } }, 'copy');
    return [el('div', { class: 'kv' }, el('span', {}, label), b, el('span', { class: 'acts' }, a)), hint ? el('p', { class: 'note small' }, hint) : null];
  }

  function field(id, label, placeholder, mode = 'text') {
    return el('div', { class: 'field' }, el('label', { for: id }, label), el('input', { type: 'text', id, placeholder, inputmode: mode, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }));
  }

  async function action(btn, fn) {
    btn.disabled = true; btn.dataset.busy = '1';
    try { await fn(); } catch (e) { say(ctx.errMsg ? ctx.errMsg(e) : String(e?.message || e), 'error'); }
    finally { btn.disabled = false; delete btn.dataset.busy; }
  }

  async function refresh() {
    if (!W) return;
    try {
      const s = await W.sync();
      const bal = root.querySelector('#eth-bal');
      if (bal) bal.textContent = fmtEth(s.balance);
      await showWaiting();
    } catch (e) { say(`Could not read the pool: ${ctx.errMsg ? ctx.errMsg(e) : e.message}`, 'error'); }
  }

  // A browser wallet (EIP-1193) on this chain, as the pool wallet's signer.
  async function browserSigner() {
    const eth = globalThis.ethereum;
    if (!eth?.request) throw new Error('no browser wallet found');
    const [from] = await eth.request({ method: 'eth_requestAccounts' });
    const want = '0x' + chain.chainId.toString(16);
    if ((await eth.request({ method: 'eth_chainId' })) !== want) await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
    return { address: from, send: ({ to, data, value }) => eth.request({ method: 'eth_sendTransaction', params: [{ from, to, data, value: '0x' + BigInt(value).toString(16) }] }) };
  }

  // ETH at the private ETH address, the smallest amount the relayer collects at today's gas price, and what a
  // relayed send or withdrawal costs now.
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
    const relayer = !!chain.keeper;
    const sendBtn = el('button', { class: 'btn', type: 'button', disabled: !relayer }, 'Send privately');
    const wdBtn = el('button', { class: 'btn quiet', type: 'button', disabled: !relayer }, 'Withdraw');
    const checkBtn = el('button', { class: 'btn quiet sm', type: 'button', disabled: !relayer }, 'Check for payments');
    const explorer = (h) => el('a', { href: `${chain.explorer}/tx/${h}`, target: '_blank', rel: 'noopener noreferrer' }, short(h, 8));
    const step = (m) => say(m[0].toUpperCase() + m.slice(1) + '…');

    body.replaceChildren(...[
      el('p', { class: 'note' }, `Private ETH on ${chain.name}: proved on this device, sent by a relay, so you need no gas.`),
      el('div', { class: 'kv' }, el('span', {}, 'private balance'), el('b', { id: 'eth-bal' }, '…')),
      ...copyRow('private ETH address', w.receiveBox, `Send ETH here from any wallet or exchange on ${chain.name}. It moves into your private balance within minutes, less at most 0.25%.`),
      el('p', { class: 'note small', id: 'eth-wait', hidden: true }),
      el('div', { class: 'row' }, el('button', { class: 'btn quiet sm', type: 'button', id: 'eth-collect', hidden: true }, 'Collect it now from my wallet')),
      ...copyRow('private address', w.address, 'For private payments from other Tacit users, in sats or ETH. Nothing on chain links a payment to it.'),
      el('div', { class: 'row' }, checkBtn),
      relayer ? null : el('p', { class: 'note' }, `Sending and withdrawing open on ${chain.name} when its relay is announced.`),
      el('p', { class: 'note small', id: 'eth-fee', hidden: true }),
      el('h3', {}, 'Send privately'),
      field('eth-to', 'To: a Tacit address (tacit1…) or Secret Sats address (bp1…)', 'tacit1… or bp1…'),
      field('eth-amt', 'Amount (ETH)', '0.01', 'decimal'),
      el('div', { class: 'row' }, sendBtn),
      el('h3', {}, 'Withdraw'),
      field('eth-wto', 'To: any 0x address, a fresh one leaves no link to you', '0x…'),
      field('eth-wamt', 'Amount (ETH)', '0.01', 'decimal'),
      el('div', { class: 'row' }, wdBtn),
      ...(chain.chainId === 1 && relayer ? [
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
      const h = await w.send({ to: poolRecipient(root.querySelector('#eth-to').value, 'mainnet'), amount: parseEth(root.querySelector('#eth-amt').value), onStep: step });
      status.replaceChildren('Sent privately in ', explorer(h), '.');
      refresh();
    });
    const bseg = root.querySelector('#eth-bdest');
    if (bseg) {
      for (const b of bseg.querySelectorAll('button')) b.onclick = () => { for (const x of bseg.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b)); };
      const bBtn = root.querySelector('#eth-bbtn');
      bBtn.onclick = () => action(bBtn, async () => {
        const dest = CHAINS.find((c) => String(c.chainId) === bseg.querySelector('[aria-pressed="true"]').dataset.chain);
        const h = await w.bridgeOut({ toChainId: dest.chainId, amount: parseEth(root.querySelector('#eth-bamt').value), l2Rpc: jsonRpc(dest.rpc), onStep: step });
        // The destination's keeper collects the arrival; tell it to watch (the wallet there may never have been opened).
        const there = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, ctx.wallet.priv), keeper: dest.keeper, prove: null, chain: { chainId: dest.chainId, pool: POOL, router: ROUTER, rpc: jsonRpc(dest.rpc), deployBlock: dest.deployBlock } });
        there.watchReceive().catch(() => {});
        status.replaceChildren(`Sent to ${dest.name} in `, explorer(h), '. It arrives at your private ETH address there in a few minutes.');
        refresh();
      });
    }
    wdBtn.onclick = () => action(wdBtn, async () => {
      const h = await w.withdraw({ to: root.querySelector('#eth-wto').value.trim(), amount: parseEth(root.querySelector('#eth-wamt').value), onStep: step });
      status.replaceChildren('Withdrawn in ', explorer(h), '.');
      refresh();
    });
    if (relayer) w.watchReceive().catch(() => {});
    // The proving key (about 33 MB the first time, cached after) starts downloading once a form is in use.
    const warm = () => { prover((name, got, total) => say(`Getting the proving key once: ${name} ${total ? Math.floor((got / total) * 100) + '%' : ''}`)).then(() => say('')).catch(() => {}); };
    for (const id of ['eth-to', 'eth-amt', 'eth-wto', 'eth-wamt', 'eth-bamt']) root.querySelector('#' + id)?.addEventListener('focus', warm, { once: true });
    if (focus) root.querySelector('#' + focus)?.focus();
    refresh();
  }

  async function render() {
    renderSeg();
    clearInterval(timer); timer = null;
    if (ctx.network !== 'mainnet' && !O.chains) return wrongNet();
    body.replaceChildren(el('p', { class: 'note' }, `Checking ${chain.name}…`));
    if (!(await isLive())) return soon();
    if (!ctx.wallet?.priv) return locked();
    main();
    timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  }

  ctx.onWallet?.(() => { if (!W && ctx.wallet?.priv) render(); });
  await render();
  return { refresh: render };
}
