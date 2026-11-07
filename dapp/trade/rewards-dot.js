import { rpc } from '/trade/util.js?cb=ba5a02b1';

const KEY = 'tacit-rewards-owed-v1', TTL = 10 * 60e3, API = 'https://api.tacit.finance', DISTRIBUTOR = '0x000000C918e44A3a443937fA7594eA4f7C95D6b9', DUST = 10n ** 16n;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { } } };

export const rememberOwed = (address, on) => store.set(KEY, JSON.stringify({ a: String(address).toLowerCase(), at: Date.now(), on: !!on }));
const cached = (address) => { try { const c = JSON.parse(store.get(KEY) || 'null'); return c && c.a === address && Date.now() - c.at < TTL ? !!c.on : null; } catch { return null; } };

const call = ({ to, data }) => rpc('eth_call', [{ to, data }, 'latest']);

async function pointsOwed(address) {
  const [c, paid] = await Promise.all([
    fetch(`${API}/claim/${address}`, { signal: AbortSignal.timeout(10e3) }).then((r) => (r.ok ? r.json() : null)),
    call({ to: DISTRIBUTOR, data: `0xc884ef83${address.slice(2).padStart(64, '0')}` }).then(BigInt),
  ]);
  if (!c) throw new Error('the points reward could not be read');
  const earned = BigInt(c.cumulativeAmount || 0);
  return c.proof && earned > paid ? earned - paid : 0n;
}
async function airdropClaimable(address) {
  const [{ makeTacAirdrop }, { keccak_256 }] = await Promise.all([import('/tac-airdrop.js'), import('/vendor/tacit-deps.min.js')]);
  const s = await makeTacAirdrop({ call, keccak256: keccak_256 }).status(address);
  if (s.reason === 'error') throw new Error('the airdrop could not be read');
  return !!s.claimable;
}

export async function owedDot(address, set) {
  const hit = cached(address);
  if (hit != null) { set(hit); return; }
  const [p, a] = await Promise.allSettled([pointsOwed(address), airdropClaimable(address)]);
  const on = (p.status === 'fulfilled' && p.value >= DUST) || (a.status === 'fulfilled' && a.value);
  if (on || (p.status === 'fulfilled' && a.status === 'fulfilled')) { rememberOwed(address, on); set(on); }
}
