// scripts/pay-relay.mjs: the one-command Pay relay. The parts that decide things (the keys it makes, the settings it starts the relay with, the tunnel's name, what the
// registry needs done) are tested alone, and the command itself in a dry run and on bad input: it must say what it would do without making, starting or sending anything.
//   node worker-relay/tests/pay-relay-launcher.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureSecrets, ensureOwner, withRpc, relayEnv, parseTunnelUrl, urlAction, loadDefaults, staleStore } from '../scripts/pay-relay.mjs';
import { utimesSync, writeFileSync } from 'node:fs';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const SCRIPT = new URL('../scripts/pay-relay.mjs', import.meta.url).pathname;
const OWNER = '0x' + 'ab'.repeat(20);

await check('the keys are made once, kept as files only their owner can read, and the same ones come back', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'payrelay-')), 'keys');
  const a = ensureSecrets(dir), b = ensureSecrets(dir);
  assert.deepEqual(a, b);
  assert.match(a.key, /^0x[0-9a-f]{64}$/); assert.match(a.gateway, /^[0-9a-f]{64}$/); assert.match(a.address, /^0x[0-9a-fA-F]{40}$/);
  for (const f of ['relay.key', 'gateway.key']) assert.equal((statSync(join(dir, f)).mode & 0o777).toString(8), '600', f);
  assert.equal((statSync(dir).mode & 0o777).toString(8), '700');
  const other = ensureSecrets(join(mkdtempSync(join(tmpdir(), 'payrelay-')), 'keys2'));
  assert.notEqual(other.key, a.key, 'another folder, other keys');
  rmSync(dir, { recursive: true, force: true });
});
await check('the settings file holds public values only: the pool, the ceremony files and their pins, public nodes, and no key of any kind', () => {
  const d = loadDefaults();
  assert.match(d.EVM_POOL_ADDR, /^0x[0-9a-fA-F]{40}$/); assert.match(d.EVM_POOL_ROUTER_ADDR, /^0x[0-9a-fA-F]{40}$/); assert.match(d.EVM_POOL_START_BLOCK_1, /^\d+$/);
  for (const k of ['EVM_POOL_WASM_SHA256', 'EVM_POOL_ZKEY_SHA256', 'EVM_POOL_VK_HASH']) assert.match(d[k], /^[0-9a-f]{64}$/, k);
  for (const k of ['EVM_POOL_WASM', 'EVM_POOL_ZKEY', 'EVM_POOL_VK', 'EVM_POOL_RPC_URL_1']) assert.match(d[k], /^https:\/\//, k);
  assert.ok(!Object.keys(d).some((k) => /PRIV|GATEWAY_KEY|SECRET|TOKEN/i.test(k)), 'no key in the settings file');
  assert.ok(!JSON.stringify(d).includes('onrender.com'), 'it names no host of anyone\'s');
});
await check('the relay starts with those settings plus its own two keys, its own store and port, and a feed only when one is asked for', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'payrelay-')), 'k'), s = ensureSecrets(dir), defaults = loadDefaults();
  const env = relayEnv({ defaults, key: s.key, gateway: s.gateway, port: 10001, dir });
  assert.equal(env.EVM_POOL_KEEPER_PRIV_1, s.key); assert.equal(env.EVM_POOL_KEEPER_GATEWAY_KEY, s.gateway); assert.equal(env.PORT, '10001');
  assert.equal(env.EVM_POOL_KEEPER_DB_1, join(dir, 'keeper-1.db')); assert.equal(env.EVM_POOL_KEEPER_DB, join(dir, 'keeper.db')); assert.equal(env.EVM_POOL_ARTIFACT_DIR, join(dir, 'artifacts'));
  assert.ok(!Object.values(env).some((v) => String(v).startsWith('/var/lib')), 'nothing is left pointing at a folder only a server has'); assert.equal(env.EVM_POOL_CHAINS, '1'); assert.equal(env.EVM_POOL_ZKEY, defaults.EVM_POOL_ZKEY);
  assert.equal('EVM_POOL_SEED_FEED_1' in env, false);
  assert.equal(relayEnv({ defaults, key: s.key, gateway: s.gateway, port: 1, dir, seed: 'https://x.example/1/evm-pool/keeper' }).EVM_POOL_SEED_FEED_1, 'https://x.example/1/evm-pool/keeper');
  assert.throws(() => relayEnv({ defaults: {}, key: s.key, gateway: s.gateway, port: 1, dir }), /incomplete/);
  assert.throws(() => relayEnv({ defaults, key: '', gateway: s.gateway, port: 1, dir }), /incomplete/);
});
await check('a feed asks for a store to be emptied and read again only when it is stale or has been asked to; a store written a moment ago, or none, is left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'payrelay-')), f = join(dir, 'keeper-1.db'), s = ensureSecrets(join(dir, 'k')), defaults = loadDefaults();
  assert.equal(staleStore(f), false, 'no store: nothing to empty');
  writeFileSync(f, 'x'); assert.equal(staleStore(f), false, 'written just now');
  const old = (Date.now() - 3 * 3600e3) / 1000; utimesSync(f, old, old); assert.equal(staleStore(f), true, 'written three hours ago');
  assert.equal(staleStore(f, Date.now(), 4 * 3600e3), false, 'within a longer limit');
  const feed = 'https://x.example/1/evm-pool/keeper';
  assert.equal(relayEnv({ defaults, key: s.key, gateway: s.gateway, port: 1, dir, seed: feed, reset: true }).EVM_POOL_SEED_RESET_1, '1');
  assert.equal('EVM_POOL_SEED_RESET_1' in relayEnv({ defaults, key: s.key, gateway: s.gateway, port: 1, dir, seed: feed }), false);
  assert.equal('EVM_POOL_SEED_RESET_1' in relayEnv({ defaults, key: s.key, gateway: s.gateway, port: 1, dir, reset: true }), false, 'with no feed there is nothing to read again from');
});
await check('the tunnel\'s public name is read from its output, and nothing else is taken for one', () => {
  assert.equal(parseTunnelUrl('2026 INF |  https://quiet-river-1234.trycloudflare.com  |'), 'https://quiet-river-1234.trycloudflare.com');
  for (const bad of ['', 'no url here', 'https://example.com', 'http://a.trycloudflare.com', 'https://trycloudflare.com', null, undefined]) assert.equal(parseTunnelUrl(bad), null, String(bad));
});
await check('the registry needs: a listing when there is none, nothing when the address is the same (in any case, with or without a slash), and a change when it moved', () => {
  const listed = { url: 'https://a.example/1/evm-pool/keeper' };
  assert.equal(urlAction({ listed: null, url: 'https://a.example/1/evm-pool/keeper' }), 'register');
  assert.equal(urlAction({ listed, url: 'https://a.example/1/evm-pool/keeper' }), 'ok');
  assert.equal(urlAction({ listed, url: 'HTTPS://A.EXAMPLE/1/evm-pool/keeper/' }), 'ok');
  assert.equal(urlAction({ listed, url: 'https://b.example/1/evm-pool/keeper' }), 'setUrl');
});
await check('a dry run says what it would do and makes, starts and sends nothing; the keys it has are not printed', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'payrelay-')), 'none');
  const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--owner', OWNER, '--tunnel', '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY RUN: nothing is made, started or sent/); assert.match(r.stdout, /1,000 TAC and 0\.01 ETH/); assert.match(r.stdout, new RegExp(OWNER));
  assert.equal(existsSync(dir), false, 'no folder was made');
  const real = join(mkdtempSync(join(tmpdir(), 'payrelay-')), 'have');
  const s = ensureSecrets(real);
  const r2 = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--owner', OWNER, '--url', 'https://relay.example', '--dir', real], { encoding: 'utf8' });
  assert.match(r2.stdout, new RegExp(s.address)); assert.ok(!r2.stdout.includes(s.key.slice(2)) && !r2.stdout.includes(s.gateway), 'no key in the output');
  assert.deepEqual(readdirSync(real).sort(), ['gateway.key', 'relay.key']);
});
await check('an owner is optional (a fresh address is made), but one that is named has to be an address; without a way to be reached it stops and says what to add', () => {
  const a = spawnSync(process.execPath, [SCRIPT, '--owner', '0x123', '--tunnel', '--dir', join(tmpdir(), 'payrelay-never-3')], { encoding: 'utf8' });
  assert.equal(a.status, 2); assert.match(a.stderr, /--owner has to be an address/);
  assert.equal(existsSync(join(tmpdir(), 'payrelay-never-3')), false);
  const none = join(tmpdir(), 'payrelay-never-4');
  const c = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--tunnel', '--dir', none], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr); assert.match(c.stdout, /a fresh address it makes/); assert.equal(existsSync(none), false, 'a dry run makes no key');
  const b = spawnSync(process.execPath, [SCRIPT, '--owner', OWNER, '--dir', join(tmpdir(), 'payrelay-never')], { encoding: 'utf8' });
  assert.equal(b.status, 2); assert.match(b.stderr, /--url .*--tunnel/s);
  assert.equal(existsSync(join(tmpdir(), 'payrelay-never')), false, 'it made nothing before asking');
});
await check('the owner key is made once, kept readable only by its user, and is another key than the relay\'s', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'payrelay-')), 'o');
  const s = ensureSecrets(dir), a = ensureOwner(dir), b = ensureOwner(dir);
  assert.match(a, /^0x[0-9a-fA-F]{40}$/); assert.equal(a, b, 'the same address on the next start');
  assert.notEqual(a.toLowerCase(), s.address.toLowerCase());
  assert.equal(statSync(join(dir, 'owner.key')).mode & 0o777, 0o600);
});
await check('--rpc puts one node in place of the free public ones, for the relay and for what it sends through', () => {
  const d = loadDefaults();
  assert.deepEqual(withRpc(d, null), d, 'no --rpc: the settings as they are');
  const w = withRpc(d, 'http://127.0.0.1:8545');
  assert.equal(w.EVM_POOL_RPC_URL_1, 'http://127.0.0.1:8545'); assert.equal(w.EVM_POOL_RPC_URLS_FALLBACK_1, 'http://127.0.0.1:8545');
  assert.equal(w.EVM_POOL_ADDR, d.EVM_POOL_ADDR, 'nothing else changes');
  assert.equal(d.EVM_POOL_RPC_URL_1.startsWith('https://'), true, 'the defaults file itself is not touched');
});
await check('--tunnel without cloudflared stops at once, before any key is made or any funds are asked for', () => {
  const dir = join(tmpdir(), 'payrelay-never-5');
  const r = spawnSync(process.execPath, [SCRIPT, '--tunnel', '--dir', dir], { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent' } });
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /cloudflared.*brew install cloudflared.*--url/s);
  assert.equal(existsSync(dir), false, 'no key was made');
});
await check('the community runner\'s relay mode is the same command: its dry run is this one\'s', () => {
  const runner = new URL('../../tools/community-runner.mjs', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [runner, 'relay', '--dry-run', '--owner', OWNER, '--tunnel', '--dir', join(tmpdir(), 'payrelay-never-2')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /DRY RUN: nothing is made, started or sent/); assert.match(r.stdout, new RegExp(OWNER));
  assert.equal(existsSync(join(tmpdir(), 'payrelay-never-2')), false);
});
console.log(`\n${n} passed`);
