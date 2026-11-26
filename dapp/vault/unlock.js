// The TAC side of the page stays behind a countdown until the new price source is really in place: the clock runs to the moment the vaults'
// timelock ends (pendingOracleEta), then the page waits for the vault itself to report the new oracle. A page that cannot reach the chain
// opens six hours after the timelock rather than staying shut.
const ETA = 1795660379;                                       // Thu 2026-11-26 02:32:59 UTC
const NEW = '0x0000000000008fcd92818fd5f9930a7feced0b2a';     // the oracle announced on both vaults
const VAULT = '0x00000087ac9ed3E1Bd443E00FBe18B4EdcAEeb1F';   // TACD
const RPC = 'https://ethereum-rpc.publicnode.com';
const root = document.documentElement, secs = () => ETA - Math.floor(Date.now() / 1000);
const pad = (n) => String(n).padStart(2, '0');
const $ = (id) => document.getElementById(id);
const open = () => { root.removeAttribute('data-locked'); $('lock')?.remove(); };
let reached = false;
async function swapped() {
  try {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: VAULT, data: '0x38013f02' }, 'latest'] }) });
    const j = await r.json(); reached = true;
    return typeof j.result === 'string' && j.result.slice(-40).toLowerCase() === NEW.slice(2);
  } catch { return false; }
}
async function poll() {
  if (await swapped() || (!reached && -secs() > 6 * 3600)) return open();
  setTimeout(poll, 15e3);
}
function tick() {
  const s = secs(), t = $('lock-t');
  if (s > 0) { if (t) t.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`; }
  else { if (t) t.textContent = '00:00:00'; const h = $('lock-h'), n = $('lock-n'); if (h) h.textContent = 'Switching over'; if (n) n.textContent = 'The three-day wait is over. Borrowing opens the moment the new price source is in place.'; }
  setTimeout(tick, 1000 - (Date.now() % 1000));
}
root.setAttribute('data-locked', ''); tick(); poll();
