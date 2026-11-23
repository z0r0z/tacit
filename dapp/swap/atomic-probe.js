// Whether anyone offers Bitcoin for Ethereum (or the other way) right now: one read of the fast bridge's boards and providers, made when the card is idle and
// kept for the life of the page. The swap card shows its third mode only when this says yes, so a page with no such provider is the page it was.
//
// A provider of this pair has an ad whose Bitcoin side is plain sats, the asset id of 64 zeros (adaptor-xswap.js SATS_ASSET), against the pool's ETH (kept here as
// literals so the card does not load those modules to ask). The common answer is no, and it costs two small reads and no code: the boards' ad lists are looked at as data first, and
// only a list that names the pair is passed through the code that checks each ad's signature (fastbridge-mailbox.js readProviders, on the ads already read), so an ad
// no key signed does not open the mode.
//
//   probeAtomic({ fetchImpl, lists, now })  ->  Promise<boolean>        never rejects: a read that fails is a no

export const SATS_ASSET_ID = '0'.repeat(64);
export const ETH_ASSET_ID = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';      // the pool's ETH (fastbridge-pair.js ETH_ASSET)
// An ad or a provider's terms for this pair: plain sats on the Bitcoin side and the pool's ETH on the other (sats against another token is not this lane's)
const ofPair = (x) => !!x && typeof x === 'object' && plainHex(x.btcAsset) === SATS_ASSET_ID && plainHex(x.evmAsset) === ETH_ASSET_ID;
const plainHex = (v) => String(v || '').replace(/^0x/, '').toLowerCase();
const onlyHttps = (b) => typeof b === 'string' && /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(b);

export async function probeAtomic({ fetchImpl = (...a) => fetch(...a), lists = null, now = () => Math.floor(Date.now() / 1000), timeoutMs = 8000 } = {}) {
  try {
    const l = lists || (await fetchImpl('/fast/lp.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({})));
    const boards = (Array.isArray(l?.boards) ? l.boards : []).filter(onlyHttps).slice(0, 4);
    const servers = (Array.isArray(l?.providers) ? l.providers : []).map((p) => p && p.base).filter(onlyHttps).slice(0, 4);
    const get = (url) => fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [boardHits, serverHits] = await Promise.all([
      Promise.all(boards.map(async (base) => {
        const j = await get(`${base.replace(/\/$/, '')}/ads`);
        return Array.isArray(j?.ads) && j.ads.some(ofPair) ? j.ads : null;
      })),
      Promise.all(servers.map(async (base) => {
        const j = await get(`${base.replace(/\/$/, '')}/info`);
        return ofPair(j);
      })),
    ]);
    // a provider that serves its own HTTP is asked directly, as the bridge page does: its terms are what its key signs for
    if (serverHits.some(Boolean)) return true;
    const named = boardHits.filter(Boolean);
    if (!named.length) return false;
    // the ads already read are the ones checked: the board is not asked again
    const mailbox = await import('/fastbridge-mailbox.js?cb=b27bb787');
    for (const ads of named) {
      try {
        const ps = await mailbox.readProviders({ board: { ads: async () => ads }, now });
        if (ps.some((p) => ofPair(p.ad))) return true;
      } catch { /* a list that cannot be checked offers nothing here */ }
    }
    return false;
  } catch { return false; }
}
