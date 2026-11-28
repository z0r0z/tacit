// node tools/pr-agent/ship.test.mjs -- the switch-on script, with the keychain, Render, GitHub and git all stood in. Shows that nothing is written without --send, that it refuses before the
// code is on main, that secrets are made once, and that the plan is the plan.
import { makeShip } from './ship.mjs';
let fails = 0; const check = (n, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) fails++; };
const USER = '123456789012345678';

function world({ main = true, dispatch = true, nudger = true, agent = '' } = {}) {
  const kc = { 'tacit-render-api-key': 'rk', ...(nudger ? { 'tacit-nudger-secret': 'n'.repeat(40) } : {}), ...(dispatch ? { 'tacit-pragent-dispatch-token': 'ghs_x' } : {}), ...(agent ? { 'tacit-agent-secret': agent } : {}) };
  const calls = [], gh = [], sets = [], vars = [];
  const fetchImpl = async (url, init) => { calls.push({ method: init.method, url: url.replace('https://api.render.com/v1', ''), body: init.body ? JSON.parse(init.body) : null });
    const u = new URL(url); const j = (o, code = 200) => new Response(JSON.stringify(o), { status: code });
    if (u.pathname === '/v1/services') { const n = u.searchParams.get('name'); return j([{ service: { id: n === 'tacit-api' ? 'srv-api' : 'srv-desk', name: n } }]); }
    return j({ ok: true }); };
  return { kc, calls, gh, sets, vars, make: (o = {}) => makeShip({ keychainGet: (n, opt) => { if (n in kc) return kc[n]; if (opt) return ''; throw new Error('missing ' + n); }, keychainSet: (n, v) => { kc[n] = v; sets.push(n); }, fetchImpl, ghSecretSet: async (n, v) => gh.push([n, v]), ghVarSet: async (n, v) => vars.push([n, v]), onMain: async () => main, say: () => {}, users: USER, ...o }) };
}
const writes = (w) => w.calls.filter((c) => c.method !== 'GET');

{ const w = world(); const r = await w.make({ send: false }).run();
  check('without --send nothing is written: no Render write, no GitHub secret or variable, no keychain item', writes(w).length === 0 && w.gh.length === 0 && w.vars.length === 0 && w.sets.length === 0 && r.sent === false);
  check('but it says what it would do: the secret, the settings on both services, the GitHub secrets, both deploys', ['make tacit-agent-secret', 'tacit-helpdesk: set AGENT_SECRET', 'tacit-helpdesk: set AGENT_MODELS', 'tacit-api: set GITHUB_DISPATCH_TOKEN', 'tacit-api: set IMPROVE_USER_IDS', 'set secret AGENT_SECRET', 'set secret NUDGER_SECRET', 'set variable PR_AGENT_ON', 'tacit-helpdesk: deploy', 'tacit-api: deploy'].every((t) => r.todo.some((x) => x.includes(t))), r.todo.join(' | ')); }

{ const w = world(); const r = await w.make({ send: true }).run();
  const put = writes(w).filter((c) => c.method === 'PUT');
  check('with --send the settings go to the right services', put.some((c) => c.url === '/services/srv-desk/env-vars/AGENT_MODELS' && c.body.value === 'qwen3.6-35b-a3b') && put.some((c) => c.url === '/services/srv-api/env-vars/IMPROVE_USER_IDS' && c.body.value === USER) && put.some((c) => c.url === '/services/srv-api/env-vars/GITHUB_DISPATCH_TOKEN' && c.body.value === 'ghs_x'));
  const agentVal = put.find((c) => c.url === '/services/srv-desk/env-vars/AGENT_SECRET')?.body.value;
  check('the gateway secret is 64 hex characters, kept in the keychain, and the same value goes to GitHub', /^[0-9a-f]{64}$/.test(agentVal) && w.kc['tacit-agent-secret'] === agentVal && w.gh.some(([n, v]) => n === 'AGENT_SECRET' && v === agentVal) && w.gh.some(([n]) => n === 'NUDGER_SECRET'));
  check('the daily pass is switched on only now, by the repository variable', w.vars.length === 1 && w.vars[0][0] === 'PR_AGENT_ON' && w.vars[0][1] === 'true');
  check('both services are deployed, after their settings', writes(w).filter((c) => c.method === 'POST').length === 2 && writes(w).findIndex((c) => c.method === 'POST') > writes(w).findLastIndex((c) => c.method === 'PUT'));
  check('the notes list what only a person can do: register the commands, start a big node', r.notes.some((n) => /node bot\.js/.test(n)) && r.notes.some((n) => /run-agent\.sh/.test(n))); }

{ const w = world({ agent: 'a'.repeat(64) }); await w.make({ send: true }).run();
  check('an existing gateway secret is kept, not remade', w.sets.length === 0 && writes(w).find((c) => c.url.endsWith('/AGENT_SECRET')).body.value === 'a'.repeat(64)); }

{ const w = world({ main: false }); let msg = ''; try { await w.make({ send: true }).run(); } catch (e) { msg = e.message; }
  check('before the code is on main it refuses and changes nothing', /not on main yet/.test(msg) && writes(w).length === 0 && w.gh.length === 0); }
{ const w = world({ dispatch: false }); const r = await w.make({ send: true }).run();
  check('without the GitHub dispatch token it carries on with the rest and says exactly how to make it', !writes(w).some((c) => c.url.endsWith('/GITHUB_DISPATCH_TOKEN')) && r.notes.some((n) => /MISSING tacit-pragent-dispatch-token/.test(n) && /Actions: write/.test(n))); }
{ const w = world({ nudger: false }); let msg = ''; try { await w.make({ send: true }).run(); } catch (e) { msg = e.message; }
  check('without the review channel secret it refuses', /tacit-nudger-secret/.test(msg) && writes(w).length === 0); }
{ const w = world(); let m1 = '', m2 = '', m3 = '';
  try { await w.make({ users: '' }).run(); } catch (e) { m1 = e.message; } try { await w.make({ users: 'someone' }).run(); } catch (e) { m2 = e.message; } try { await w.make({ users: '', roles: '12' }).run(); } catch (e) { m3 = e.message; }
  check('it will not run without saying who may ask, and refuses ids that are not Discord ids', /say who may ask/.test(m1) && /Discord ids/.test(m2) && /Discord ids/.test(m3)); }
{ const w = world(); await w.make({ send: true, users: '', roles: '223456789012345678' }).run();
  check('roles alone are enough, and set as IMPROVE_ROLE_IDS', writes(w).some((c) => c.url.endsWith('/IMPROVE_ROLE_IDS') && c.body.value === '223456789012345678') && !writes(w).some((c) => c.url.endsWith('/IMPROVE_USER_IDS'))); }
console.log(fails ? `${fails} FAILED` : 'ship: all tests passed'); process.exit(fails ? 1 : 0);
