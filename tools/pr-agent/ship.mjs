#!/usr/bin/env node
// Switches tacit-bot's code agent on, once this branch is on main. Shows what it would do unless --send is given.
//
//   node tools/pr-agent/ship.mjs --users 123456789012345678,234567890123456789            what it would do (reads only)
//   node tools/pr-agent/ship.mjs --users … --send                                         do it
//   --users   Discord user ids allowed to use /improve and the buttons (IMPROVE_USER_IDS); --roles for role ids (IMPROVE_ROLE_IDS)
//   --models  model-name prefixes the gateway hands agent turns to (default qwen3.6-35b-a3b)
//
// It makes (once) one secret and keeps it in the macOS keychain, sets the settings on the two Render services, sets the two GitHub secrets and the PR_AGENT_ON variable (which starts the daily
// autonomous pass), and deploys both services.
// What it cannot do for you: create the GitHub token the Discord worker uses to start a run (a fine-grained token, Actions: write on this repo and nothing else; GitHub only lets a person
// make one) -- put it in the keychain as `tacit-pragent-dispatch-token` -- and register the Discord commands (cd discord && node bot.js, from the checkout that has discord/.env).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (n, d = '') => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const SEND = argv.includes('--send');
const REPO = flag('--repo', 'z0r0z/tacit');
const KEYS = { render: 'tacit-render-api-key', agent: 'tacit-agent-secret', nudger: 'tacit-nudger-secret', dispatch: 'tacit-pragent-dispatch-token' };

// The parts that touch the world are passed in, so the plan can be tested with fakes.
export function makeShip({ keychainGet, keychainSet, fetchImpl = fetch, ghSecretSet, ghVarSet = async () => {}, onMain, say = console.log, send = SEND, users = '', roles = '', models = 'qwen3.6-35b-a3b' }) {
  const todo = [], notes = [];
  const api = async (method, path, body, write = false) => {
    if (write && !send) return null;
    const r = await fetchImpl(`https://api.render.com/v1${path}`, { method, headers: { authorization: `Bearer ${keychainGet(KEYS.render)}`, 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`); return j;
  };
  const find = async (name) => { const l = await api('GET', `/services?name=${encodeURIComponent(name)}&limit=5`); const s = (l || []).map((x) => x.service ?? x).find((x) => x.name === name); if (!s) throw new Error(`no Render service named ${name}`); return s; };
  const setEnv = async (svc, key, value) => { todo.push(`${svc.name}: set ${key}`); await api('PUT', `/services/${svc.id}/env-vars/${key}`, { value }, true); };

  async function run() {
    if (!(await onMain())) throw new Error('the code agent is not on main yet (worker/src/pr-agent.js is missing there): merge the pull request first, then run this');
    if (!users && !roles) throw new Error('say who may ask: --users <discord user ids> and/or --roles <role ids>');
    for (const [flagName, v] of [['--users', users], ['--roles', roles]]) if (v && !v.split(',').every((x) => /^\d{17,20}$/.test(x.trim()))) throw new Error(`${flagName} must be comma-separated Discord ids (17-20 digits)`);
    // the secrets: made once, kept in the keychain
    let agent = keychainGet(KEYS.agent, true);
    if (!agent) { agent = randomBytes(32).toString('hex'); todo.push(`keychain: make ${KEYS.agent}`); if (send) keychainSet(KEYS.agent, agent); }
    const nudger = keychainGet(KEYS.nudger, true); if (!nudger) throw new Error(`the keychain has no ${KEYS.nudger} (the review channel's secret): the code agent reports through it`);
    const dispatch = keychainGet(KEYS.dispatch, true);
    if (!dispatch) notes.push(`MISSING ${KEYS.dispatch}: create a fine-grained GitHub token for ${REPO} with Actions: write and nothing else, then \`security add-generic-password -U -s ${KEYS.dispatch} -a $USER -w\` and run this again (until then the Discord side cannot start a run)`);
    const desk = await find('tacit-helpdesk'), apiSvc = await find('tacit-api');
    await setEnv(desk, 'AGENT_SECRET', agent); await setEnv(desk, 'AGENT_MODELS', models);
    if (dispatch) await setEnv(apiSvc, 'GITHUB_DISPATCH_TOKEN', dispatch);
    if (users) await setEnv(apiSvc, 'IMPROVE_USER_IDS', users.split(',').map((x) => x.trim()).join(','));
    if (roles) await setEnv(apiSvc, 'IMPROVE_ROLE_IDS', roles.split(',').map((x) => x.trim()).join(','));
    for (const [name, v] of [['AGENT_SECRET', agent], ['NUDGER_SECRET', nudger]]) { todo.push(`github ${REPO}: set secret ${name}`); if (send) await ghSecretSet(name, v); }
    todo.push(`github ${REPO}: set variable PR_AGENT_ON=true (the daily autonomous pass starts)`); if (send) await ghVarSet('PR_AGENT_ON', 'true');
    for (const svc of [desk, apiSvc]) { todo.push(`${svc.name}: deploy the latest main`); await api('POST', `/services/${svc.id}/deploys`, { clearCache: 'do_not_clear' }, true); }
    notes.push('REGISTER THE COMMANDS (replaces the app\'s list: /verify, /improve, "Prepare a PR"; the new two start admin-only): cd discord && node bot.js   (from the checkout that has discord/.env)');
    notes.push('A BIG NODE: on a machine with ~30 GB of memory, `MINER=0x… bash helpdesk/node/run-agent.sh`; the gateway counts it at /agent/status');
    return { todo, notes, sent: send };
  }
  return { run };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const keychainGet = (name, optional = false) => { try { return execFileSync('security', ['find-generic-password', '-s', name, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { if (optional) return ''; throw new Error(`the keychain has no ${name}`); } };
  const keychainSet = (name, value) => execFileSync('security', ['add-generic-password', '-U', '-s', name, '-a', process.env.USER || 'z', '-w', value], { stdio: 'ignore' });
  const ghVarSet = (name, value) => { execFileSync('gh', ['variable', 'set', name, '--repo', REPO, '--body', value], { stdio: ['ignore', 'ignore', 'inherit'] }); };
  const ghSecretSet = (name, value) => { execFileSync('gh', ['secret', 'set', name, '--repo', REPO], { input: value, stdio: ['pipe', 'ignore', 'inherit'] }); };   // the value goes in on stdin, not on a command line
  const onMain = () => { try { execFileSync('git', ['fetch', '-q', 'origin', 'main'], { stdio: 'ignore' }); return execFileSync('git', ['ls-tree', 'origin/main', 'worker/src/pr-agent.js'], { encoding: 'utf8' }).trim().length > 0; } catch { return false; } };
  try {
    const r = await makeShip({ keychainGet, keychainSet, ghSecretSet, ghVarSet, onMain, users: flag('--users'), roles: flag('--roles'), models: flag('--models', 'qwen3.6-35b-a3b') }).run();
    console.log(`${r.sent ? 'Done' : 'Would do'}:\n  - ${r.todo.join('\n  - ')}\n\n${r.notes.map((n) => `* ${n}`).join('\n')}${r.sent ? '' : '\n\nNothing was changed. Add --send to do it.'}`);
  } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
}
