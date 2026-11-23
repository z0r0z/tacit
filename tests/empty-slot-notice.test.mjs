// A connected Bitcoin wallet with no saved key in this browser (dapp/empty-slot.js, wallet.load in dapp/tacit.js).
//
// Before a new key is made, the passphrase sheet says what points to a key kept elsewhere: another key saved in this
// browser, Activity made with a wallet that is not open, or a payment from the connected wallet to an address that
// holds Tacit coins. With nothing to say the sheet is the usual one. The notice only changes the sheet's words; Cancel
// makes no key and Continue makes the same key it always did.
//
// Run: `node tests/empty-slot-notice.test.mjs` (jsdom: Node 22)

import { JSDOM } from './_jsdom.mjs';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
if (!globalThis.crypto) globalThis.crypto = dom.window.crypto;
globalThis.__TACIT_NO_INIT__ = true;
localStorage.setItem('tacit-network-v1', 'mainnet');

// ── a small explorer ──
const EXT = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';   // the connected wallet
const KEYED = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';                     // an address it funded that holds Tacit coins
const SHOP = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';                      // an address it paid once
const FRAME_TX = 'aa'.repeat(32);   // creates a 546-sat output and carries an envelope
const PLAIN_TX = 'bb'.repeat(32);   // creates a 546-sat output, no envelope
const mk = (id, t, from, outs) => ({
  txid: id, status: { confirmed: true, block_time: t },
  vin: [{ prevout: { scriptpubkey_address: from } }],
  vout: outs.map(([a, v]) => ({ scriptpubkey_address: a, value: v, scriptpubkey_type: 'v0_p2wpkh' })),
});
const HISTORY = [
  mk('01'.repeat(32), 1700000500, EXT, [[KEYED, 2000000], [EXT, 9000]]),
  mk('02'.repeat(32), 1700000400, EXT, [[KEYED, 1500000], [EXT, 9000]]),
  mk('03'.repeat(32), 1700000300, EXT, [[SHOP, 40000], [EXT, 9000]]),
  mk('04'.repeat(32), 1700000200, EXT, [[KEYED, 20000], [EXT, 9000]]),
];
const world = {
  txs: HISTORY,
  utxos: { [KEYED]: [{ txid: FRAME_TX, vout: 0, value: 546 }, { txid: '01'.repeat(32), vout: 0, value: 315867 }], [SHOP]: [{ txid: PLAIN_TX, vout: 0, value: 546 }] },
  hex: { [FRAME_TX]: '0200000000010100' + '544143495401' + '2f2f', [PLAIN_TX]: '020000000001010000ffff' },
  down: false,
};
const calls = [];
globalThis.fetch = async (input) => {
  const url = String(input?.url ?? input);
  calls.push(url);
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
  const text = (v, status = 200) => new Response(v, { status });
  if (world.down) return json({ error: 'down' }, 404);
  let m = /\/address\/([a-z0-9]+)\/txs(?:\/chain\/[0-9a-f]{64})?$/.exec(url);
  if (m) return json(m[1] === EXT ? world.txs : []);
  m = /\/address\/([a-z0-9]+)\/utxo$/.exec(url);
  if (m) return json(world.utxos[m[1]] || []);
  m = /\/tx\/([0-9a-f]{64})\/hex$/.exec(url);
  if (m) return world.hex[m[1]] ? text(world.hex[m[1]]) : text('not found', 404);
  if (/\/blocks\/tip\/height$/.test(url)) return text('900000');
  return json({}, 404);
};

const E = await import('../dapp/empty-slot.js');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond === true) { console.log(`  PASS  ${label}`); pass++; }
  else               { console.log(`  FAIL  ${label}`); fail++; }
};
const short = (a) => (a.length > 20 ? a.slice(0, 10) + '…' + a.slice(-6) : a);
const apiJsonDirect = async (p) => { const r = await fetch('https://x' + p); if (!r.ok) throw new Error('http ' + r.status); return r.json(); };
const apiTextDirect = async (p) => { const r = await fetch('https://x' + p); if (!r.ok) throw new Error('http ' + r.status); return r.text(); };

console.log('Candidates are the addresses paid most often');
{
  ok('the repeatedly funded address ranks first, the single payment after it', JSON.stringify(E.fundingCandidates(HISTORY, EXT)) === JSON.stringify([KEYED, SHOP]));
  const shopNewest = [mk('08'.repeat(32), 1700000900, EXT, [[SHOP, 40000]]), mk('09'.repeat(32), 1700000300, EXT, [[KEYED, 20000]]), mk('0a'.repeat(32), 1700000200, EXT, [[KEYED, 20000]]), mk('0b'.repeat(32), 1700000100, EXT, [[KEYED, 20000]])];
  ok('payments counted before recency: three older sends outrank one newer one', JSON.stringify(E.fundingCandidates(shopNewest, EXT)) === JSON.stringify([KEYED, SHOP]));
  ok('an unconfirmed payment counts as the newest on a tie', E.fundingCandidates([{ ...mk('0c'.repeat(32), 0, EXT, [[SHOP, 40000]]), status: { confirmed: false } }, mk('0d'.repeat(32), 1700000100, EXT, [[KEYED, 20000]])], EXT)[0] === SHOP);
  ok('the wallet itself and outputs under 1,000 sats are never candidates', !E.fundingCandidates([mk('05'.repeat(32), 1, EXT, [[EXT, 50000], ['bc1qdust', 546]])], EXT).length);
  ok('a transaction the wallet did not sign adds nothing', !E.fundingCandidates([mk('06'.repeat(32), 1, SHOP, [[KEYED, 50000]])], EXT).length);
  ok('only native segwit outputs count', !E.fundingCandidates([{ ...mk('07'.repeat(32), 1, EXT, [[KEYED, 50000]]), vout: [{ scriptpubkey_address: KEYED, value: 50000, scriptpubkey_type: 'v1_p2tr' }] }], EXT).length);
  ok('the list is capped', E.fundingCandidates(HISTORY, EXT, { max: 1 }).length === 1);
}

console.log('\nHolds Tacit coins');
{
  ok('a 546-sat output made by an envelope transaction', await E.holdsTacit({ apiJson: apiJsonDirect, apiText: apiTextDirect, address: KEYED }) === true);
  ok('a 546-sat output with no envelope behind it', await E.holdsTacit({ apiJson: apiJsonDirect, apiText: apiTextDirect, address: SHOP }) === false);
  ok('an address with no coins', await E.holdsTacit({ apiJson: apiJsonDirect, apiText: apiTextDirect, address: 'bc1qnone' }) === false);
  world.down = true;
  ok('an unreachable explorer answers false, not an error', await E.holdsTacit({ apiJson: apiJsonDirect, apiText: apiTextDirect, address: KEYED }) === false);
  world.down = false;
}

console.log('\nThe notice text');
{
  ok('nothing to say gives no notice', E.noticeFor({ ext: EXT, short }) === null);
  const h = E.noticeFor({ ext: EXT, holders: [KEYED], short });
  ok('a funded holder is named, conditionally, with where its key lives', /sent bitcoin to bc1qw508d6…v8f3t4, which holds Tacit coins\. If that is your Tacit wallet, its key is kept only in the browser where it was made/.test(h?.text || ''));
  ok('the sheet gets its own title and button', h?.title === 'a new key for this wallet?' && h?.submit === 'make new key');
  ok('Cancel and Continue are both explained', /Cancel to look for the browser or backup/.test(h.text) && /continue to make a separate new key/.test(h.text));
  const s = E.noticeFor({ ext: EXT, saved: [{ address: SHOP, boundTo: KEYED }], short });
  ok('a saved wallet is named with the wallet it is linked to', s?.text.includes('This browser already saves a Tacit wallet bc1qar0srr…wf5mdq linked to bc1qw508d6…v8f3t4. Cancel to open it instead.') === true);
  const sl = E.noticeFor({ ext: EXT, saved: [{ address: null, boundTo: null }], short });
  ok('a saved key whose address is not readable is still counted', sl?.text.includes('This browser already saves a Tacit wallet. Cancel to open it instead.') === true);
  const sm = E.noticeFor({ ext: EXT, saved: [{ address: SHOP, boundTo: null }, { address: KEYED, boundTo: null }, { address: null, boundTo: null }], short });
  ok('several saved wallets: two named, the rest counted', sm?.text.includes('saves a Tacit wallet bc1qar0srr…wf5mdq and a Tacit wallet bc1qw508d6…v8f3t4 and 1 more. Cancel to open one of them instead.') === true);
  const a = E.noticeFor({ ext: EXT, logged: { addrs: [SHOP], unknown: 0 }, short });
  ok('Activity by a wallet that is not open is named', a?.text.includes('Activity on this browser was made with bc1qar0srr…wf5mdq, which is not open now.') === true);
  const u = E.noticeFor({ ext: EXT, logged: { addrs: [], unknown: 3 }, short });
  ok('untagged Activity is counted when nothing else is known', /lists 3 earlier entries made with a wallet that is not open now/.test(u?.text || ''));
  ok('untagged Activity is left out when a saved wallet already explains the browser', !/earlier entr/.test(E.noticeFor({ ext: EXT, saved: [{ address: SHOP, boundTo: null }], logged: { addrs: [], unknown: 3 }, short })?.text || ''));
  ok('a wallet that is both saved and in Activity is named once', (E.noticeFor({ ext: EXT, saved: [{ address: SHOP, boundTo: null }], logged: { addrs: [SHOP], unknown: 0 }, short }).text.match(/bc1qar0srr/g) || []).length === 1);
}

console.log('\nThe notice waits for the chain, but not long');
{
  const n = await E.emptySlotNotice({ ext: EXT, saved: [], logged: { addrs: [], unknown: 0 }, short, apiJson: apiJsonDirect, apiText: apiTextDirect });
  ok('from a recent history the funded holder is found', /bc1qw508d6…v8f3t4, which holds Tacit coins/.test(n?.text || ''));
  ok('the address paid once with no coins is not named', !/bc1qar0srr/.test(n?.text || ''));
  const t0 = Date.now();
  const slow = await E.emptySlotNotice({ ext: EXT, saved: [{ address: SHOP, boundTo: null }], logged: { addrs: [], unknown: 0 }, short, budgetMs: 40, apiJson: () => new Promise(() => {}), apiText: () => new Promise(() => {}) });
  ok('a read that never answers is cut off at the budget, keeping what is known locally', Date.now() - t0 < 1000 && /already saves/.test(slow?.text || '') && !/sent bitcoin/.test(slow.text));
  const none = await E.emptySlotNotice({ ext: EXT, saved: [], logged: { addrs: [], unknown: 0 }, short, budgetMs: 40, apiJson: () => new Promise(() => {}), apiText: () => new Promise(() => {}) });
  ok('with nothing known and no answer there is no notice', none === null);
  const thrown = await E.emptySlotNotice({ ext: EXT, saved: [], logged: { addrs: [], unknown: 0 }, short, apiJson: async () => { throw new Error('boom'); }, apiText: apiTextDirect });
  ok('an explorer error is no notice, not a failure', thrown === null);
}

// ── the real wallet.load, through the sheet ──
const { secp, bytesToHex, hexToBytes } = await import('../dapp/vendor/tacit-deps.min.js');
const T = await import('../dapp/tacit.js');
const { wallet, extWallet } = T;

document.body.innerHTML = `
  <div id="toast-container"></div>
  <div id="pass-modal" style="display:none;"><form id="pass-form">
    <div id="pass-title"></div><div id="pass-reason"></div>
    <label id="pass-label-1"></label><input id="pass-input-1"><div id="pass-hint-1"></div>
    <div id="pass-field-2"><input id="pass-input-2"><div id="pass-hint-2"></div></div>
    <div id="pass-warn"></div><button id="pass-submit" type="submit"></button><button id="pass-cancel" type="button"></button>
  </form></div>`;
const sheets = [];
let answer = 'continue';
const watcher = setInterval(() => {
  const m = document.getElementById('pass-modal');
  if (m.style.display !== 'grid') return;
  sheets.push({
    title: document.getElementById('pass-title').textContent,
    reason: document.getElementById('pass-reason').textContent,
    submit: document.getElementById('pass-submit').textContent,
  });
  if (answer === 'cancel') { document.getElementById('pass-cancel').onclick(); return; }
  for (const id of ['pass-input-1', 'pass-input-2']) {
    const el = document.getElementById(id);
    el.value = 'correct horse battery staple';
    el.dispatchEvent(new dom.window.Event('input'));
  }
  document.getElementById('pass-form').onsubmit({ preventDefault() {} });
}, 5);

const SLOT = `tacit-wallet-v1:mainnet:by:${EXT.toLowerCase()}`;
const privOf = (n) => { const b = new Uint8Array(32); b[31] = n; return b; };
const pubHexOf = (priv) => bytesToHex(secp.getPublicKey(priv, true));
const blobFor = (pubHex) => JSON.stringify({ v: 1, kdf: 'pbkdf2', iter: 600000, salt: '00'.repeat(16), iv: '00'.repeat(12), ct: '00'.repeat(48), pub: pubHex });
const reset = () => {
  localStorage.clear(); localStorage.setItem('tacit-network-v1', 'mainnet');
  wallet.priv = null; wallet.pub = null; wallet.mode = null; extWallet.state = null;
  sheets.length = 0; calls.length = 0; answer = 'continue'; world.down = false; world.txs = HISTORY;
};
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };

console.log('\nConnecting a wallet whose key is not here, but which funded an address with Tacit coins');
reset();
{
  const e = await err(wallet.load(EXT));
  ok('the load goes ahead after Continue', e === null && /^0[23][0-9a-f]{64}$/.test(JSON.parse(localStorage.getItem(SLOT) || '{}').pub || ''));
  ok('one sheet, with the notice title and button', sheets.length === 1 && sheets[0].title === 'a new key for this wallet?' && sheets[0].submit === 'make new key');
  ok('it names the funded address and says the key lives elsewhere', /bc1qw508d6…v8f3t4, which holds Tacit coins/.test(sheets[0]?.reason || '') && /kept only in the browser where it was made/.test(sheets[0]?.reason || ''));
  ok('the explorer was asked for the wallet and for the addresses it funded, nothing else', calls.every((u) => /\/address\/|\/tx\//.test(u)) && calls.length <= 12);
}

console.log('\nCancel on that sheet');
reset(); answer = 'cancel';
{
  const e = await err(wallet.load(EXT));
  ok('the load is cancelled', e?.unlockCancelled === true);
  ok('no key was made', localStorage.getItem(SLOT) === null && wallet.priv === null && wallet.pub === null);
}

console.log('\nA wallet with no history that points anywhere');
reset(); world.txs = [];
{
  const e = await err(wallet.load(EXT));
  ok('the usual sheet, title and button', e === null && sheets.length === 1 && sheets[0].title === 'set passphrase' && sheets[0].submit === 'set passphrase');
  ok('the usual reason', /in-browser tacit signing key linked to /.test(sheets[0]?.reason || ''));
}

console.log('\nThe explorer cannot be read');
reset(); world.down = true;
{
  const e = await err(wallet.load(EXT));
  ok('the usual sheet and a new key, no failure', e === null && sheets.length === 1 && sheets[0].title === 'set passphrase' && !!localStorage.getItem(SLOT));
}

console.log('\nAnother key is saved in this browser');
reset(); world.txs = [];
localStorage.setItem('tacit-wallet-v1:mainnet:by:bc1qother', blobFor(pubHexOf(privOf(7))));
{
  const e = await err(wallet.load(EXT));
  ok('the notice names that wallet and the address it is linked to', sheets[0]?.title === 'a new key for this wallet?' && /already saves a Tacit wallet bc1q[a-z0-9]{6}…[a-z0-9]{6} linked to bc1qother\./.test(sheets[0]?.reason || ''));
  ok('the saved key is untouched, and Continue still makes this wallet its own key', e === null && JSON.parse(localStorage.getItem('tacit-wallet-v1:mainnet:by:bc1qother')).pub === pubHexOf(privOf(7)) && !!localStorage.getItem(SLOT));
}

console.log('\nThe wallet open now is not offered as somewhere else');
reset(); world.txs = [];
localStorage.setItem('tacit-wallet-v1:mainnet', blobFor(pubHexOf(privOf(9))));
wallet.pub = hexToBytes(pubHexOf(privOf(9)));
{
  const e = await err(wallet.load(EXT));
  ok('an open key that is saved here does not trigger the notice', e === null && sheets[0]?.title === 'set passphrase');
}

console.log('\nActivity made with a wallet that is not open');
reset(); world.txs = [];
localStorage.setItem(T.activityKey(), JSON.stringify([
  { kind: 'swap-buy', ticker: 'TAC', amount: '1', decimals: 8, assetId: '', txid: '', ts: 1, addr: SHOP },
]));
{
  const e = await err(wallet.load(EXT));
  ok('the notice names it', e === null && sheets[0]?.title === 'a new key for this wallet?' && (sheets[0]?.reason || '').includes('Activity on this browser was made with bc1qar0srr…wf5mdq'));
}

console.log('\nA local key with no wallet connected');
reset();
{
  const e = await err(wallet.load());
  ok('the usual sheet, and the explorer is not asked anything', e === null && sheets[0]?.title === 'set passphrase' && calls.length === 0);
}

clearInterval(watcher);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
