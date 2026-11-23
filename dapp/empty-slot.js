// The notice shown before a new key is made for a connected Bitcoin wallet that has no saved key in this browser.
// A key made here starts empty, so the page first says what points to a key that lives somewhere else: another key
// saved in this browser, Activity made with a wallet that is not open, or a payment from the connected wallet to an
// address that holds Tacit coins. Nothing here changes a key; a notice is text for the passphrase sheet, or null.

export const TACIT_FRAME_HEX = '544143495401'; // "TACIT" 0x01, the start of every envelope
const NOTE_SATS = 546;
const MIN_FUNDING_SATS = 1000;
const TX_PAGE = 25;

// The connected wallet's newest transactions: unconfirmed ones and the latest confirmed pages.
export async function readRecentTxs({ apiJson, ext, pages = 3 }) {
  const out = [];
  let path = `/address/${ext}/txs`;
  for (let p = 0; p < pages; p++) {
    let page;
    try { page = await apiJson(path); } catch { break; }
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    const confirmed = page.filter((t) => t?.status?.confirmed);
    if (confirmed.length < TX_PAGE) break;
    path = `/address/${ext}/txs/chain/${confirmed[confirmed.length - 1].txid}`;
  }
  return out;
}

// Native segwit addresses the wallet paid, most often paid first: a Tacit key is funded more than once, a shop once.
export function fundingCandidates(txs, ext, { max = 3 } = {}) {
  const by = new Map();
  for (const tx of txs || []) {
    if (!(tx?.vin || []).some((i) => i?.prevout?.scriptpubkey_address === ext)) continue;
    const at = tx.status?.confirmed ? Number(tx.status.block_time) || 0 : Number.MAX_SAFE_INTEGER;
    for (const o of tx.vout || []) {
      const a = o?.scriptpubkey_address;
      if (o?.scriptpubkey_type !== 'v0_p2wpkh' || !a || a === ext || !(o.value >= MIN_FUNDING_SATS)) continue;
      const e = by.get(a) || { address: a, sends: new Set(), at: 0 };
      e.sends.add(tx.txid);
      e.at = Math.max(e.at, at);
      by.set(a, e);
    }
  }
  return [...by.values()]
    .sort((x, y) => (y.sends.size - x.sends.size) || (y.at - x.at))
    .slice(0, max)
    .map((e) => e.address);
}

// True when an unspent 546-sat output at the address was made by a transaction that carries a Tacit envelope.
export async function holdsTacit({ apiJson, apiText, address, maxTx = 4 }) {
  let utxos;
  try { utxos = await apiJson(`/address/${address}/utxo`); } catch { return false; }
  const ids = [...new Set((Array.isArray(utxos) ? utxos : []).filter((u) => u?.value === NOTE_SATS).map((u) => u.txid))].slice(0, maxTx);
  for (const id of ids) {
    try { if (String(await apiText(`/tx/${id}/hex`)).toLowerCase().includes(TACIT_FRAME_HEX)) return true; } catch {}
  }
  return false;
}

// Addresses the wallet funded that hold Tacit coins, pushed into `into` as they are found.
export async function fundedHolders({ apiJson, apiText, ext, pages, max, into = [] }) {
  const cands = fundingCandidates(await readRecentTxs({ apiJson, ext, pages }), ext, { max });
  for (const address of cands) if (await holdsTacit({ apiJson, apiText, address })) into.push(address);
  return into;
}

const list = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// saved: other keys kept in this browser, [{ address | null, boundTo | null }]
// logged: Activity made with wallets that are not open, { addrs, unknown }
export function noticeFor({ ext, saved = [], logged = { addrs: [], unknown: 0 }, holders = [], short = (a) => a }) {
  const parts = [];
  if (saved.length) {
    const one = (s) => `a Tacit wallet${s.address ? ` ${short(s.address)}` : ''}${s.boundTo ? ` linked to ${short(s.boundTo)}` : ''}`;
    const shown = saved.slice(0, 2).map(one);
    parts.push(`This browser already saves ${list(shown)}${saved.length > 2 ? ` and ${saved.length - 2} more` : ''}. Cancel to open ${saved.length === 1 ? 'it' : 'one of them'} instead.`);
  }
  const have = new Set(saved.map((s) => s.address).filter(Boolean));
  const addrs = (logged.addrs || []).filter((a) => !have.has(a));
  if (addrs.length) parts.push(`Activity on this browser was made with ${list(addrs.slice(0, 2).map(short))}, which is not open now.`);
  else if (!saved.length && logged.unknown > 0) {
    parts.push(`Activity on this browser lists ${logged.unknown} earlier ${logged.unknown === 1 ? 'entry' : 'entries'} made with a wallet that is not open now.`);
  }
  if (holders.length) {
    parts.push(`This wallet sent bitcoin to ${list(holders.slice(0, 2).map(short))}, which ${holders.length === 1 ? 'holds' : 'hold'} Tacit coins. If that is your Tacit wallet, its key is kept only in the browser where it was made.`);
  }
  if (!parts.length) return null;
  return {
    title: 'a new key for this wallet?',
    submit: 'make new key',
    text: `No key for ${short(ext)} is saved in this browser. ${parts.join(' ')} A new key made here starts empty and cannot open coins held by another key. Cancel to look for the browser or backup that key came from, or continue to make a separate new key.`,
  };
}

// The notice for `ext`, waiting at most budgetMs for the chain reads; null when nothing points elsewhere.
export async function emptySlotNotice({ ext, saved, logged, short, apiJson, apiText, budgetMs = 6000, pages, max }) {
  const holders = [];
  if (ext && apiJson && apiText) {
    let timer;
    const cap = new Promise((r) => { timer = setTimeout(r, budgetMs); });
    await Promise.race([fundedHolders({ apiJson, apiText, ext, pages, max, into: holders }).catch(() => {}), cap]);
    clearTimeout(timer);
  }
  return noticeFor({ ext, saved, logged, holders: holders.slice(), short });
}
