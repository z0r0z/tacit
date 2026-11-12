const TAC_ID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', TETH_ID = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
export const OUT_ASSETS = {
  tac: { key: 'tac', ticker: 'TAC', pool: 'cTAC', id: '0x' + TAC_ID, dp: 4, floor: true, min: 2_000_000_000n },
  teth: { key: 'teth', ticker: 'tETH', pool: 'cETH', id: '0x' + TETH_ID, dp: 6, floor: false, min: 0n },
};

export function makeOutFee({ api, fetchImpl = (...a) => fetch(...a) }) {
  const floors = {};
  return async function outFee(t, a) {
    const own = BigInt(await t.quoteOpFee(a.pool, 'bridgeburn'));
    if (!a.floor) return own;
    if (!floors[a.key] || Date.now() - floors[a.key].at > 300e3) {
      const entry = floors[a.key] = { at: Date.now(), v: fetchImpl(`${api}/confidential/quote?asset=${a.pool}`, { signal: AbortSignal.timeout(10e3) }).then((r) => (r.ok ? r.json() : null))
        .then((j) => (/^\d+$/.test(String(j?.staticFloorUnits)) ? BigInt(j.staticFloorUnits) : 0n), () => 0n) };
      entry.v.then((v) => { if (!v && floors[a.key] === entry) delete floors[a.key]; });
    }
    const published = await floors[a.key].v;
    return published > own ? published : own;
  };
}

export function limitText({ units, fee, min, cap, ticker, fmt }) {
  if (units < min) return `Bridge at least ${fmt(min)} ${ticker}: below that the fees take too much of it.`;
  if (units > cap) return `One bridge takes at most ${fmt(cap)} ${ticker} while this is new. Bridge less, then again.`;
  if (units <= fee) return `Bridge more than ${fmt(fee, 6)} ${ticker}: the relay fee comes out of it.`;
  return null;
}

export const proofWarn = (w, lag) => (w.name === 'reflection-behind' ? `Bitcoin’s proof on Ethereum is ${w.detail} behind (about ${Math.max(1, Math.round(lag / 6))} hours), so this will take longer than usual. Nothing is lost by waiting.`
  : w.name === 'coverage-behind' ? 'The proof’s view of Ethereum is further behind than usual, so this will take longer than usual. Nothing is lost by waiting.' : '');
export const proofProblem = 'Bitcoin’s proof on Ethereum could not be read, so nothing was started. Try again in a minute.';

export function onTheWay(records, notes) {
  const made = new Set((notes || []).filter((n) => n && n.amount != null).map((n) => String(n.claimId || '').toLowerCase()).filter(Boolean));
  return records.filter((r) => !(r.settle?.claimId && made.has(String(r.settle.claimId).toLowerCase())));
}

export function fundingText(pf, fmtBtc) {
  const k = pf.pending || 0, coin = pf.haveSats ? `${fmtBtc(pf.haveSats)} BTC` : null, need = `${pf.needSats.toLocaleString('en-US')} sats`;
  if (!k) return coin ? `The largest free coin on this key’s Bitcoin address holds ${coin}; the Bitcoin step, a few hours from now, needs one coin of ${need}, kept there until the bridge arrives.`
    : `This key’s Bitcoin address has no free coin yet; the Bitcoin step, a few hours from now, needs one coin of ${need}, kept there until the bridge arrives.`;
  return `${k === 1 ? 'A bridge under way takes a coin' : `${k} bridges under way take a coin each`} from this key’s Bitcoin address for ${k === 1 ? 'its' : 'their'} Bitcoin step. `
    + (coin ? `The next free coin holds ${coin}; this one needs a coin of ${need}, kept there until it arrives.` : `No other coin is free; this one needs a coin of ${need}, kept there until it arrives.`);
}
