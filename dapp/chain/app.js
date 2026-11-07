import { tacitChain } from '/tacit-chain-config.js?cb=76219357';
import { mountChain } from '/chain/ui.js?cb=b61ef9a5';

// The tacit chain's page: the chain read from Ethereum (the landing contract) and its leader, and with a Tacit key open (trade/key.js, the
// same sheet as /fast/) the key's balance there, its Tacit address with the chain lane, and anything of its that waits, each linked to the
// tile's flow that finishes it. While the chain is not deployed the page says so and loads nothing of it.
const cfg = tacitChain();
const $ = (id) => document.getElementById(id);
const S = { on: !!cfg, status: null, key: null, note: '' };
const ui = mountChain({
  root: $('chain'),
  actions: { signIn: () => signIn(), copy: () => copyAddress(), publish: () => publish(), lock: () => keyS?.lock() },
});
const draw = () => ui.render({ ...S, now: Date.now() });
draw();

let keyS = null, signInSheet = null, rpc = null, client = null, unified = null, mine = null;
const rpcCall = (m, p) => rpc(m, p);
const READ_FAILED = 'Could not read your notes on the Tacit chain. Trying again shortly.';
const short = (a, n = 6) => (!a ? '' : a.length > 2 * n + 4 ? `${a.slice(0, n + 2)}…${a.slice(-n)}` : a);

// The header's chip: Sign in, or the key's address once open
function paintChip() {
  const chip = $('wallet-chip');
  if (!chip) return;
  chip.hidden = !cfg;
  const on = !!keyS?.unlocked;
  $('wallet-dot').className = `dot${on ? ' on' : ''}`;
  $('wallet-label').textContent = on ? (S.key?.address ? short(S.key.address) : 'Opening…') : 'Sign in';
  chip.setAttribute('aria-label', on ? 'Your Tacit wallet' : 'Sign in');
}

async function signIn() {
  if (!keyS) return;
  try { await signInSheet(keyS, { icons: true, why: 'Open your Tacit wallet to see your TAC on the Tacit chain. This page never stores the key.' }); } catch { /* closed without a key */ }
}

async function readStatus() {
  try { S.status = await client.chainStatus({ cfg, rpcCall }); } catch { if (!S.status || S.status === 'error') S.status = 'error'; }
  draw();
}

// What a key's kept spends are now, as the front page reads them (dapp/index.html chainKeptRead): a deposit no longer waiting on Ethereum and
// not landed was taken back, unless it is an inbox not swept yet (paid, or still to be paid before its time runs out); one still waiting can be
// taken back once RECLAIM_AFTER has passed (`backAt`, seconds).
async function keptOf(c) {
  const list = await c.pending();
  const after = list.some((e) => e.deposit) ? await c.reclaimAfter().catch(() => 7 * 86400) : 0, out = [];
  for (const e of list) {
    if (e.deposit) {
      const d = await c.depositState(e.deposit).catch(() => null);
      if (d && /^0x0+$/.test(d.from)) {
        const ib = e.inbox ? await c.inboxState(e.inbox).catch(() => null) : null, paid = !!ib && ib.held >= BigInt(e.deposit.amount) * 10n ** 10n;
        if (e.inbox && (!ib || (!ib.swept && (paid || Date.now() < (e.pay?.until ?? 0))))) out.push({ ...e, unswept: true, paid, backAt: null });
        continue;
      }
      out.push({ ...e, backAt: d ? d.at + after : null });
      continue;
    }
    out.push(e);
  }
  return out;
}

// The key's side of the page, read again every 30 s while it is open
async function readMine(m = mine) {
  if (!m || m !== mine || m.reading) return;
  m.reading = true;
  try {
    await m.c.scan();
    const bal = await m.c.worth(), kept = await keptOf(m.c), hops = await m.c.hopsWaiting().catch(() => S.key?.hops || []);
    if (m === mine && S.key) { Object.assign(S.key, { balance: bal, kept, hops }); if (S.note === READ_FAILED) S.note = ''; }
  } catch {
    if (m === mine) S.note = READ_FAILED;
  } finally { m.reading = false; }
  if (m === mine) draw();
}

async function openKey() {
  const m = mine = { c: null, reading: false };
  S.key = { address: null, published: null, publishing: false, balance: null, kept: [], hops: [] }; S.note = '';
  draw(); paintChip();
  try {
    const c = m.c = client.makeChainClient({ cfg, rpcCall, priv: keyS.priv(), system: () => { throw new Error('This page does not prove: moves are made in the tile.'); }, storage: localStorage });
    const lane = await c.lane();
    if (m !== mine) return;
    S.key.address = unified.unifiedAddress(keyS.priv(), lane).address;
    draw(); paintChip();
    c.resolve(lane).then(() => true, () => false).then((p) => { if (m === mine && S.key.published !== true) { S.key.published = p; draw(); } });
    readMine(m);
  } catch (e) {
    if (m === mine) { S.note = 'Could not read the Tacit chain for this key. Try again in a moment.'; draw(); }
  }
}

async function publish() {
  const m = mine;
  if (!m?.c || S.key.publishing) return;
  S.key.publishing = true; S.note = ''; draw();
  try { await m.c.publish(); if (m === mine) S.key.published = true; }
  catch { if (m === mine) S.note = 'The leader did not take it. Try again in a moment.'; }
  finally { if (m === mine) { S.key.publishing = false; draw(); } }
}

function copyAddress() {
  const a = S.key?.address;
  if (!a) return;
  navigator.clipboard.writeText(a).then(() => { S.note = 'Address copied.'; draw(); }, () => { S.note = a; draw(); });
}

if (cfg) {
  paintChip();
  // what the page needs only while the chain is on: the chain's client, the key's sheet and the reads of Ethereum
  const [k, u, cm, un] = await Promise.all([import('/trade/key.js?cb=d110df5e'), import('/trade/util.js?cb=ba5a02b1'), import('/tacit-chain-client.js?cb=17e554e6'), import('/tacit-unified.js?cb=c268c3d8')]);
  rpc = u.rpc; client = cm; unified = un; signInSheet = k.signInSheet;
  keyS = k.makeKeySession({ moved: (why) => { keyS.lock(); S.note = why; draw(); } });
  keyS.onChange(() => { if (keyS.unlocked) openKey(); else { mine = null; S.key = null; draw(); } paintChip(); });
  $('wallet-chip').onclick = () => (keyS.unlocked ? $('mine')?.scrollIntoView({ block: 'center' }) : signIn());
  readStatus();
  setInterval(() => { if (!document.hidden) readStatus(); }, 30e3);
  setInterval(() => { if (!document.hidden) draw(); }, 15e3);
  setInterval(() => { if (!document.hidden) readMine(); }, 30e3);
}
