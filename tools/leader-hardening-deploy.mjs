// Puts the hardened leader live: sets the leader's RPC_URL to a list of endpoints (the first that answers is used), deploys commit 98e97e3f to the
// tacit-chain-leader service, waits for it, shows whether the node was rebuilt from the blocks on its disk, and redeploys the monitor job that calls a
// leader behind the chain critical. Run once, from this checkout:   node tools/leader-hardening-deploy.mjs
// (the Render key is read from the keychain entry tacit-render-api-key and is never printed)
import { execFileSync } from 'node:child_process';

const COMMIT = '98e97e3f82eabcf5c24407f4b97904e6229c2be7';
const LEADER = 'srv-dbnqgeh5efls73c2h010', MONITOR = 'crn-d9eb08bbc2fs73fkm8h0', OWNER = 'tea-d6v0ghf5gffc73d1n4k0';
const RPC_URL = 'https://rpc.mevblocker.io,https://ethereum-rpc.publicnode.com,https://eth.drpc.org';
const LEADER_URL = 'https://tacit-chain-leader.onrender.com';
const key = execFileSync('security', ['find-generic-password', '-s', 'tacit-render-api-key', '-w'], { encoding: 'utf8' }).trim();
const api = async (method, path, body) => {
  const r = await fetch('https://api.render.com/v1' + path, { method, headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deploy = async (id, name) => {
  const r = await api('POST', `/services/${id}/deploys`, { commitId: COMMIT, clearCache: 'do_not_clear' });
  const d = r.json.deploy || r.json;
  console.log(`${name}: deploy ${r.status} ${d.id || JSON.stringify(r.json).slice(0, 120)}`);
  if (!d.id) return false;
  for (let i = 0; i < 60; i++) {
    const s = (await api('GET', `/services/${id}/deploys/${d.id}`)).json;
    const st = (s.deploy || s).status;
    if (st === 'live') { console.log(`${name}: live`); return true; }
    if (['build_failed', 'update_failed', 'canceled', 'deactivated'].includes(st)) { console.log(`${name}: ${st}`); return false; }
    await sleep(15000);
  }
  console.log(`${name}: still not live after 15 min`);
  return false;
};

const put = await api('PUT', `/services/${LEADER}/env-vars/RPC_URL`, { value: RPC_URL });
console.log('RPC_URL set:', put.status);
if (put.status !== 200) process.exit(1);
if (!(await deploy(LEADER, 'leader'))) process.exit(1);
for (let i = 0; i < 30; i++) {
  const s = await fetch(`${LEADER_URL}/state`).then((r) => r.json()).catch(() => null);
  console.log(new Date().toISOString().slice(11, 19), 'leader node height', s?.height, 'notes', s?.leaves);
  if (s && Number(s.height) > 0) break;
  await sleep(10000);
}
const logs = (await api('GET', `/logs?ownerId=${OWNER}&resource=${LEADER}&limit=100&direction=backward`)).json.logs || [];
for (const l of logs.reverse()) if (/replayedFromArchive|archiveSkipped|archiveReplayFailed|archiveNotKept|"synced"|"error"/.test(l.message || '')) console.log(' ', (l.message || '').slice(0, 220));
await deploy(MONITOR, 'monitor');
