// The bridge page moving the holder's bridges on, with the key opened here: the same pass the front page makes every minute (bridge-tick.js),
// and the two presses that need only the relay (the burn of a moved bridge, the mint of a recorded one). Nothing is loaded until the holder asks:
// this module, the key sheet and tacit.js (four megabytes) all come in on that press. Starting a bridge is the front page's Bridge tab. Merging, bridging all, minting to another address,
// paying the mint from a wallet and proving it oneself stay on the front page, which these rows link to.
import { makeKeySession, signInSheet } from '/trade/key.js?cb=709c122d';
import { makeTacitSession } from '/tacit-session.js?cb=a2d34bb2';
import { stepIn, stepOut, advanceOut, outPubs, discoverIn, unsearched, discoverEvery } from '/bridge-tick.js?cb=db96a3a9';
import { ROUTES } from '/bridge/track.js?cb=31e3a58f';
import { parseUnits } from '/trade/util.js?cb=e53086bb';
import { forgetUx } from '/trade/poolux.js?cb=ac4a1175';
import { relayWords } from '/relay-outcome.js?cb=26298b8e';
import { secp, bytesToHex, hexToBytes } from '/vendor/tacit-deps.min.js';

const TACIT_URL = '/tacit.js?cb=262f9a47';
const PLAN_KEY = 'tacit-lite-bridge-plan-v1', SELF_PROVE = 'tacit-lite-prove-self-v1:';
const EVERY = 75e3;                                                                  // as often as the front page's pass
const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const memory = { get: read, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage is a convenience */ } } };
// Bitcoin's history for an address: mempool.space, then Blockstream (both are in this page's connect-src)
const EXPLORERS = ['https://mempool.space/api', 'https://blockstream.info/api'];
async function esplora(path) {
  let last = null;
  for (const base of EXPLORERS) {
    try { const r = await fetch(base + path, { signal: AbortSignal.timeout(12e3) }); if (r.ok) return await r.json(); last = new Error(String(r.status)); } catch (e) { last = e; }
  }
  throw new Error(`Bitcoin explorers are unreachable (${last?.message || 'network'})`);
}
const BURN_SENT = ['burn-submitted', 'burn-mined', 'registered', 'folded', 'minted'];

// `repaint()` reads the journals again; `say(text, front)` writes the status line (`front`: the text ends with the way to the front page).
export function mountMover({ pick, repaint = () => {}, say = () => {}, onState = () => {} } = {}) {
  const key = makeKeySession({ moved: (why) => { lockNow(); say(why); } });
  const TS = makeTacitSession({ url: TACIT_URL, key: () => (key.unlocked ? { pubHex: key.key.pubHex, priv: bytesToHex(key.priv()) } : null), secp, bytesToHex, hexToBytes });
  let timer = null, busy = false, pressing = false, last = 0, loadSaid = false;     // pressing: a press is running (the tick waits for it, so a ready step is not taken by itself meanwhile)
  const rechecked = {};                                                              // when a burn whose claim was not matched was last looked at again (stepOut waits ten minutes)

  const journaledIn = (pub) => { try { return /"stage":"(?!minted"|reclaimed")/.test(localStorage.getItem(`tacit-burndep-bridge-v1:mainnet:${pub}`) || ''); } catch { return false; } };
  const planOf = (pub) => (rec) => read(PLAN_KEY)?.[pub]?.[rec.id] || null;

  // One pass: the way in for the open key, the way out for every key with a journal here (only the Bitcoin step needs the open key).
  async function tick(force = false) {
    if (busy || !key.unlocked || (!force && Date.now() - last < EVERY - 1000)) return;
    busy = true; last = Date.now();
    const pub = key.key.pubHex;
    try {
      let T;
      try { T = await TS.load(); loadSaid = false; }
      catch (e) { if (!loadSaid) { loadSaid = true; say(`Could not load the wallet (${txt(e)}). Check your connection, then press Move them on here again.`); } throw e; }
      if (journaledIn(pub)) await stepIn({ ux: T.bridgeUx(), pub, withKey: TS.withKey, priv: () => key.priv(), planOf: planOf(pub), alive: () => key.key?.pubHex === pub });
      const pubs = outPubs();
      if (pubs.length) {
        const out = T.crossoutUx();
        await stepOut({ ux: out, pubs, records: (p) => out.list(p).filter((r) => r.stage !== 'minted'), keyPub: () => key.key?.pubHex, withKey: TS.withKey, priv: () => key.priv(), rechecked });
      }
    } catch { /* a pass that fails is tried again on the next */ } finally { busy = false; }
    repaint();
    find().catch(() => {});
  }
  // Bridges this browser has no record of (a new browser, or one whose data was cleared): found from the key's Bitcoin address, a little way back
  // each time and once through a long stretch. `force` looks now, whatever was looked at lately.
  let findAt = 0, finding = false;
  async function find(force = false) {
    if (finding || !key.unlocked) return null;
    const pub = key.key.pubHex, T = await TS.load(), listed = T.bridgeUx().list(pub), deep = unsearched(pub, listed, memory);
    if (!force && Date.now() - findAt < discoverEvery(deep, true)) return null;
    finding = true; findAt = Date.now();
    try {
      if (force) say('Looking through your Bitcoin address…');
      const { found } = await discoverIn({ pub, listed, esplora, withKey: TS.withKey, priv: () => key.priv(), memory });
      if (key.key?.pubHex !== pub) return null;
      if (found.length) { say(found.length === 1 ? 'Found a bridge that this browser had no record of: it goes on here.' : `Found ${found.length} bridges that this browser had no record of: they go on here.`); last = 0; tick(true); }
      else if (force) say('No bridge turned up for this key. If it was started on another key, open that one.');
      return found;
    } catch (e) { if (force) say(txt(e)); return null; } finally { finding = false; repaint(); }
  }
  // one bridge to Bitcoin rebuilt from the Ethereum transaction of its burn and the amount bridged
  async function findOut(hash, amountText) {
    if (!key.unlocked) return say('Open your Tacit wallet first.');
    const h = String(hash || '').trim().toLowerCase().replace(/^0x/, ''), v = parseUnits(amountText || '', 8);
    if (!/^[0-9a-f]{64}$/.test(h)) return say('A transaction hash is 64 characters, 0-9 and a-f.');
    if (!v) return say(v === null && parseUnits(amountText || '', 64) != null ? 'Up to 8 decimals.' : 'Add the amount you bridged.');
    try {
      say('Checking the burn and rebuilding the bridge…');
      const T = await TS.load();
      await T.crossoutUx().recoverFromEthTx('0x' + h, key.priv(), { amount: v });
      say('✓ Found it. It shows under Your bridges.'); last = 0; tick(true);
      return true;
    } catch (e) { say(txt(e)); return false; } finally { repaint(); }
  }

  function start() {
    stop();
    timer = setInterval(() => { if (!document.hidden) tick(); }, 15e3);
    document.addEventListener('visibilitychange', onVisible);
    onState(true);
    tick(true);
  }
  const onVisible = () => { if (!document.hidden) tick(); };
  function stop() { clearInterval(timer); timer = null; document.removeEventListener('visibilitychange', onVisible); TS.drop(); onState(false); }
  // The key locked: out of the session first (so the page, told next, sees it closed), then the pass stopped and the pool module's copies of it dropped.
  function lockNow() { key.lock(); forgetUx(); stop(); }

  // The key opened here, then the pass running while the page is open. A second press locks the key again.
  async function toggle() {
    if (key.unlocked) { lockNow(); say(''); return false; }
    try { await signInSheet(key, { pick, why: 'Open your Tacit wallet to move your bridges on from this page. This page never stores the key.' }); }
    catch (e) { if (e?.unlockCancelled) return false; say(String(e?.message || e)); return false; }
    start();
    return true;
  }

  // The presses a bridge offers (track.js `acts`), made with the key: the front page's own, one call to the bridge's engine each. What the relay
  // will not take, and the holder who proves their own mints, is sent to the front page. A bridge is cancelled on the second press.
  let drop = null;                                                                   // the bridge a first press of Cancel asked about: { id, at }
  const armed = (id) => drop?.id === id && Date.now() - drop.at < 120e3;
  // The second press counts a second after the first: a double click lands on the button the first one turned into "Yes", before the words it asks about were read.
  const confirmed = (id) => armed(id) && Date.now() - drop.at >= 1000;
  const txt = (e) => String(e?.message || e).replace(/^(crossout-ux|burndep-ux):\s*/, '').slice(0, 200);
  const outState = (after, ticker) => (after.stage === 'minted' ? `✓ ${ticker} is on your Bitcoin address.` : after.lastError ? `Checked: ${txt(after.lastError.message)}` : 'Checked: its row says where it stands.');

  async function pressIn(T, pub, row, kind) {
    const ux = T.bridgeUx(), id = row.id, rec = ux.list(pub).find((r) => r.id === id);
    if (!rec) return say('That bridge is not in this browser’s record any more. Reload the page.');
    const priv = () => key.priv();
    if (kind === 'mint' && read(SELF_PROVE + pub) === true) return say('You prove your own mints, which the front page does.', row.href || true);
    if (kind === 'burn') {
      say('Signing the burn and sending it to a miner…');
      let after = await TS.withKey(() => ux.advance(pub, id, { walletPriv: priv(), go: true }), pub);
      if (after.stage === 'burn-signed') after = await ux.advance(pub, id).catch(() => ux.list(pub).find((r) => r.id === id) || after);
      return say(BURN_SENT.includes(after.stage) ? '✓ Burn sent.'
        : after.stage === 'traced' && after.checkWait ? 'Its history is being checked before the burn. This page sends the burn once the check is done, while it is open with your key.'
        : after.stage === 'traced' ? 'Not yet: it waits for Bitcoin’s proof to reach the move. Try again later.'
        : after.stage === 'burn-signed' ? 'Signed, but the miner did not take it yet. It is tried again on its own.' : 'Checked.');
    }
    if (kind === 'mint' || kind === 'poll') {
      say(kind === 'mint' ? 'Minting: the relay proves it, about a minute…' : 'Trying again…');
      // A mint signs nothing, and waits up to 15 minutes on the relay: it is not taken inside the key's turn, as the tick's own mint is not (a bridge of another key
      // is refused by its own record). A "try again" may land on a step that signs a burn, which needs the key in the wallet library, so it keeps the turn.
      const advance = () => ux.advance(pub, id, { walletPriv: priv() });
      const after = await (kind === 'mint' ? advance() : TS.withKey(advance, pub));
      return say(after.stage === 'minted' ? '✓ Minted: it is in your private balance.'
        : after.mintJob && !after.lastError ? 'Its mint is with the relay and lands on its own, usually within minutes. It is not sent twice.' : after.lastError ? `Checked: ${txt(after.lastError.message)}` : 'Checked.');
    }
    if (kind === 'reclaim') {
      const moved = await TS.withKey(() => ux.reclaim({ rec, walletPriv: priv() }), pub);
      return say(moved && moved.stage !== 'reclaim-sent' ? 'Its burn is already with Bitcoin, so there is nothing to move back: the bridge goes on from the burn.'
        : 'Moving it back to your Bitcoin address. It shows there once it confirms.');
    }
    if (kind === 'recover') {
      const after = await ux.recover({ rec, walletPriv: priv() }).catch(async (e) => {
        if (rec.path !== 'reflected' || !/completed|mint it instead/i.test(String(e?.message))) throw e;
        await ux.recheckBurn(pub, id);
        return null;
      });
      return say(!after ? 'Bitcoin’s proof on Ethereum did record this burn: it goes on to its mint.'
        : after.stage === 'recovered' ? '✓ It is back on your Bitcoin address.' : 'Recovering: it returns to your Bitcoin address, usually within the hour.');
    }
    if (kind === 'recheck') {
      const after = await ux.recheckBurn(pub, id);
      return say(after.stage === 'rburn-mined' ? 'Looking again: it is waiting for Bitcoin’s proof on Ethereum to record the burn.' : 'Checked.');
    }
    if (kind === 'cancel') {
      if (!confirmed(id)) { if (!armed(id)) drop = { id, at: Date.now() }; say('Cancelling drops this bridge from this page once Bitcoin is asked again and has neither of its transactions; what it holds stays where it is. Press “Yes, cancel it” to go ahead.'); return; }
      drop = null;
      say('Asking Bitcoin for its transactions once more…');
      const txid = rec.burn?.txid || rec.migrate?.revealTxid, after = await ux.cancelSigned(pub, id);
      return say(after ? 'Bitcoin has this bridge’s transaction, so it was not cancelled: it goes on from its row.' : `Cancelled. What it held is where it was.${txid ? ` Its transaction id, should it ever show on Bitcoin: ${txid}` : ''}`);
    }
    say('That press is on the front page.', row.href || true);
  }

  async function pressOut(T, pub, row, kind) {
    const ux = T.crossoutUx(), id = row.id, rec = ux.list(pub).find((r) => r.id === id);
    if (!rec) return say('That bridge is not in this browser’s record any more. Reload the page.');
    const priv = () => key.priv(), keyPub = () => key.key?.pubHex, ticker = ROUTES[row.asset]?.ticker || 'It';
    if (kind === 'cancel') {
      return say(await ux.cancelIntent(pub, id) ? 'That burn had landed on Ethereum: it goes on from its row.' : 'Cancelled: no burn for it was found on Ethereum.');
    }
    // sending it anyway pays today's Bitcoin fee whatever it is: the row's own words name the rate and the sats, and a second press makes it so
    if (kind === 'force') {
      if (!confirmed(id)) { if (!armed(id)) drop = { id, at: Date.now() }; say(`Sending it now pays today’s Bitcoin fee. ${row.err ? `${txt(row.err)}. ` : ''}Press “Yes, send it now” to go ahead.`); return; }
      drop = null;
    }
    let cur = rec;
    if (kind === 'recheck') cur = await ux.recoverFromEthTx('0x' + String(rec.settle.txHash).replace(/^0x/, ''), priv(), { amount: BigInt(rec.source.amount ?? rec.source.value) });
    if (kind === 'resign') cur = await ux.resign(pub, id);
    if (kind === 'retry') cur = await ux.retryRejected(pub, id);
    say(kind === 'force' ? 'Sending it to Bitcoin at today’s fee…' : kind === 'retry' ? 'Sending the Bitcoin step again…' : 'Checking…');
    say(outState(await advanceOut(ux, pub, cur, { withKey: TS.withKey, priv, keyPub, allowHighFee: kind === 'force' }), ticker));
  }

  async function press(kind, row) {
    if (!key.unlocked) return say('Open your Tacit wallet first.');
    const pub = key.key.pubHex;
    if (!row) return;
    if (row.pub && row.pub !== pub) return say('That bridge belongs to another Tacit key. Open that one to move it on.');
    if (busy) return say('Checking your bridges: press again in a moment.');
    busy = true; pressing = true;
    try {
      const T = await TS.load();
      await (row.dir === 'out' ? pressOut : pressIn)(T, pub, row, kind);
    } catch (e) {
      const f = e?.fundWait ? `Still no free coin of ${Number(e.needSats).toLocaleString('en-US')} sats on this key’s Bitcoin address. This goes on by itself once it is there.`
        : /another tab/i.test(txt(e)) ? 'This bridge is being moved on in another tab. Wait for it there, or close that tab and try again.' : null;
      const w = relayWords(e);
      say(f || w?.text || txt(e), !!w?.front);
    } finally { busy = false; pressing = false; repaint(); }
  }

  return { toggle, press, tick, find, findOut, armed, get pressing() { return pressing; }, get open() { return key.unlocked; }, get pub() { return key.key?.pubHex || null; } };
}
