#!/usr/bin/env node
// tools/tac-vault-keeper.mjs against a TacVault on a local anvil: what it does with `absorb`, what it says about the gap between the venues' price and the price a vault's
// redemptions use, and what it says when the vault's owner changes something.
//
//   - Nothing to say: a vault in good order raises no alert.
//   - A venue price 10% over the offer view is an alert while the vault has debt.
//   - An auction that has run its time on a vault the liquidation view calls short, with SYNTH in the vault's reserve: while the venues' spot says the vault's TAC covers its debt
//     (the medians still read the earlier price) the keeper does not absorb, though the vault would let it; once the market is back down it does.
//   - With PAUSE_GAP_BPS set, a keeper that is not the vault's pauser says so and does nothing; named its pauser, it pauses the vault while the gap lasts.
//   - SYNTH held by the vault is an alert; so is an ETH price feed within a tenth of the age at which the vault refuses actions.
//   - A term or a further minter announced, and a new TAC sink, fee recipient, pauser or owner, each raise one alert; the keeper's first reading is the baseline.
//
//   VAULT_OUT=<forge out dir> node tests/tac-vault-keeper-guards.mjs
//
// VAULT_OUT holds the compiled TacVault and the test mocks (contracts/test/TacVaultMocks.sol); it defaults to contracts/out. Without them the test says so and stops.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('../', import.meta.url).pathname;
const OUT = process.env.VAULT_OUT || join(REPO, 'contracts/out');
const need = ['TacVault.sol/TacVault', 'TacVaultMocks.sol/TestTac', 'TacVaultMocks.sol/MockOracle', 'TacVaultMocks.sol/LiveFeed'];
if (need.some((f) => !existsSync(join(OUT, `${f}.json`)))) { console.log(`skipped: ${OUT} has no compiled TacVault and test mocks (forge build, or set VAULT_OUT)`); process.exit(0); }
const PORT = 26000 + Math.floor(Math.random() * 900), ANVIL = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--hardfork', 'prague', '--silent'], { stdio: 'ignore' });
let watcher = null;
process.on('exit', () => { anvil.kill('SIGKILL'); watcher?.kill('SIGKILL'); });
const rpc = async (method, params = []) => (await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 60) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 250)); } }

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const E18 = 10n ** 18n;
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEPLOYER_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OWNER = { a: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', k: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' };
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const art = (f) => JSON.parse(readFileSync(join(OUT, `${f}.json`), 'utf8')).bytecode.object;
const create = (data) => JSON.parse(cast('send', '--private-key', DEPLOYER, '--rpc-url', ANVIL, '--json', '--create', data)).contractAddress;
const send = (k, to, sig, ...args) => cast('send', to, sig, ...args, '--private-key', k, '--rpc-url', ANVIL, '--json');
const view = (to, sig, ...a) => cast('call', to, sig, ...a, '--rpc-url', ANVIL).split('\n')[0].trim().split(/\s+/)[0];
const lc = (a) => a.toLowerCase();

const TAC = create(art('TacVaultMocks.sol/TestTac'));
const A = create(art('TacVaultMocks.sol/MockOracle'));
const FEED = create(art('TacVaultMocks.sol/LiveFeed'));                                                  // ETH is $2,500
const price = (avg, short, current, latest) => { send(DEPLOYER, A, 'setPrices(uint256,uint256,uint256)', String(avg), String(short), String(current)); send(DEPLOYER, A, 'setLatest(uint256)', String(latest)); };
const flat = (p) => price(p, p, p, p);
flat(10n ** 14n);                                                                                        // 0.0001 ETH per TAC: $0.25
const cfg = `(${TAC},${A},${FEED},${OWNER.a},35000,20000,4000,3600,1800,${100n * E18},3900,${(1n << 256n) - 1n},15,50,100,0x00000000000000000000000000000000000000Fe,0x000000000000000000000000000000000000dEaD,TAC Dollar,TACD)`;
const enc = cast('abi-encode', 'f((address,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,address,string,string))', cfg);
const VAULT = create(art('TacVault.sol/TacVault') + enc.slice(2));
const SYNTH = cast('call', VAULT, 'SYNTH()(address)', '--rpc-url', ANVIL);
send(DEPLOYER, TAC, 'mint(address,uint256)', DEPLOYER_ADDR, String(1_000_000n * E18));
send(DEPLOYER, TAC, 'approve(address,uint256)', VAULT, String((1n << 256n) - 1n));
send(DEPLOYER, VAULT, 'deposit(uint256)', String(100_000n * E18));                                       // $25,000 of TAC
send(DEPLOYER, VAULT, 'borrow(uint256,uint256)', String(5_000n * E18), '500');                           // owes 5,050: about 495% cover

const env = (extra = {}) => ({ ...process.env, KEEPER_PRIV: DEPLOYER, RPC: ANVIL, VAULTS: VAULT, FROM_BLOCK: '0', ALERT_WEBHOOK: '', ...extra });
const keeper = (extra = {}) => execFileSync('node', [join(REPO, 'tools/tac-vault-keeper.mjs')], { env: env({ ONCE: '1', ...extra }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const alerts = (out) => out.split('\n').filter((l) => / ALERT /.test(l));
const owed = () => view(VAULT, 'vaults(address)(uint256,uint256,uint256)', DEPLOYER_ADDR);
const debtOf = () => BigInt(cast('call', VAULT, 'vaults(address)(uint256,uint256,uint256)', DEPLOYER_ADDR, '--rpc-url', ANVIL).split('\n')[1].split(' ')[0]);
const reserve = () => BigInt(view(SYNTH, 'balanceOf(address)(uint256)', VAULT));

// A vault in good order: nothing to say.
let out = keeper();
ok(alerts(out).length === 0, `a vault in good order raises no alert (${alerts(out).join(' | ') || 'none'})`);

// A venue 10% over the price the vault's redemptions use (medians and the newest record lag it): an alert naming the gap.
price(10n ** 14n, 10n ** 14n, 11n * 10n ** 13n, 10n ** 14n);
out = keeper();
const gap = alerts(out).find((l) => /above the price its redemptions and bids use/.test(l));
ok(gap && /trades 10% above/.test(gap) && lc(gap).includes(lc(VAULT)), `TAC 10% over the offer view is an alert (${gap ? gap.split(' ALERT ')[1] : 'none'})`);

// With PAUSE_GAP_BPS set the keeper pauses the vault for the gap's length, if it may: not as long as it is no pauser, and then it says so.
out = keeper({ PAUSE_GAP_BPS: '500' });
ok(/is not its pauser/.test(out) && view(VAULT, 'paused()(bool)') === 'false', 'a keeper that is not the vault\'s pauser says so and pauses nothing');
send(OWNER.k, VAULT, 'setPauser(address)', DEPLOYER_ADDR);
out = keeper({ PAUSE_GAP_BPS: '500' });
ok(view(VAULT, 'paused()(bool)') === 'true' && /paused for 1500 s/.test(out), 'named the pauser, it pauses the vault while TAC trades over the offer view');
flat(10n ** 14n);
await rpc('evm_increaseTime', [1600]); await rpc('evm_mine');

// TAC loses most of its value: the vault is short of its debt, and the keeper opens the auction.
flat(15n * 10n ** 12n);                                                                                  // $0.0375: the 100,000 TAC are worth $3,750 against 5,050
out = keeper();
ok(/liquidate/.test(out), 'the keeper opens the auction on a vault under the line');
send(DEPLOYER, SYNTH, 'transfer(address,uint256)', VAULT, String(5_000n * E18));                         // a reserve for absorb to burn
await rpc('evm_increaseTime', [3700]); await rpc('evm_mine');

// Spot and the newest record move up while the medians still say short: the vault would absorb, the keeper does not.
price(15n * 10n ** 12n, 15n * 10n ** 12n, 10n ** 14n, 10n ** 14n);
const before = debtOf();
let absorbable = true;
try { cast('call', VAULT, 'absorb(address)', DEPLOYER_ADDR, '--from', DEPLOYER_ADDR, '--rpc-url', ANVIL); } catch { absorbable = false; }
ok(absorbable, 'the vault itself would absorb now (its liquidation view still reads the fall)');
out = keeper();
ok(/holds 5000 of its synth/.test(out), 'the SYNTH in the vault\'s reserve is an alert');
ok(/absorb waits/.test(out), `the keeper says it is waiting (${(out.split('\n').find((l) => /absorb waits/.test(l)) || 'no line').slice(25)})`);
ok(debtOf() === before && reserve() === 5_000n * E18, 'and the vault is as it was: its debt and the reserve are untouched');

// The market falls back to where the medians were: nothing covers the debt now, and the keeper absorbs.
flat(15n * 10n ** 12n);
out = keeper();
ok(debtOf() < before && reserve() < 5_000n * E18, `once the vault is short at every price the keeper absorbs (debt ${before / E18} to ${debtOf() / E18}, reserve ${reserve() / E18})`);

// A vault whose ETH price feed is nearly as old as it tolerates (3,900 s): an alert; a fresh feed raises none.
const FEED2 = create(art('TacVaultMocks.sol/MockFeed'));
send(DEPLOYER, FEED2, 'set(int256)', '250000000000');
const enc2 = cast('abi-encode', 'f((address,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,address,string,string))', cfg.replace(FEED, FEED2));
const VAULT2 = create(art('TacVault.sol/TacVault') + enc2.slice(2));
const keeperOn = (vault) => execFileSync('node', [join(REPO, 'tools/tac-vault-keeper.mjs')], { env: env({ ONCE: '1', VAULTS: vault }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
ok(!alerts(keeperOn(VAULT2)).some((l) => /price feed/.test(l)), 'a fresh feed raises no alert');
const now = Number(cast('block', 'latest', '--field', 'timestamp', '--rpc-url', ANVIL));
send(DEPLOYER, FEED2, 'setUpdatedAt(uint256)', String(now - 3600));
const stale = alerts(keeperOn(VAULT2)).find((l) => /price feed is \d+ s old and it refuses actions at 3900 s/.test(l));
ok(stale, `a feed 3,600 s old is an alert (${stale ? stale.split(' ALERT ')[1].slice(43) : 'none'})`);

// The owner changes things while the keeper watches (it runs on, a pass a second): each change is one alert, and the first reading is only the baseline.
watcher = spawn('node', [join(REPO, 'tools/tac-vault-keeper.mjs')], { env: env({ SCAN_SECONDS: '1', RECORD_POLL_SECONDS: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
watcher.stdout.on('data', (d) => { log += d; });
watcher.stderr.on('data', (d) => { log += d; });
const until = async (re, ms = 240_000) => { const t = Date.now(); while (!re.test(log) && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 500)); return re.test(log); };
ok(await until(/watching the owner, fee recipient, TAC sink and pauser/), 'the keeper takes its baseline and says what it watches');
ok(!/ALERT .*(now 0x|announced)/.test(log), 'and the baseline itself is no alert');

send(OWNER.k, VAULT, 'queueParam(uint8,uint256)', '5', '7200');
ok(await until(/ALERT .*auction duration \(s\) is announced to become 7200 from /), 'an announced term is an alert with its value and time');
send(OWNER.k, SYNTH, 'queueMinter(address)', A);
ok(await until(new RegExp(`ALERT .*${lc(A)} is announced as a further minter`, 'i')), 'an announced further minter is an alert');
send(OWNER.k, VAULT, 'setTacSink(address)', OTHER);
ok(await until(new RegExp(`ALERT .*TAC sink is now ${lc(OTHER)}`)), 'a new TAC sink is an alert');
send(OWNER.k, VAULT, 'setFeeTo(address)', OTHER);
ok(await until(new RegExp(`ALERT .*fee recipient is now ${lc(OTHER)}`)), 'a new fee recipient is an alert');
send(OWNER.k, VAULT, 'setPauser(address)', OTHER);
ok(await until(new RegExp(`ALERT .*pauser is now ${lc(OTHER)}`)), 'a new pauser is an alert');
send(OWNER.k, VAULT, 'transferOwnership(address)', OTHER);
ok(await until(new RegExp(`ALERT .*owner is now ${lc(OTHER)}`)), 'a new owner is an alert');
await new Promise((r) => setTimeout(r, 4000));
const count = (re) => (log.match(re) || []).length;
ok(count(/ALERT .*TAC sink is now/g) === 1 && count(/ALERT .*announced to become 7200/g) === 1, 'and each is said once, not on every pass');
watcher.kill('SIGKILL');

console.log(fails ? `${fails} failed, ${n} passed` : `${n} checks passed`);
process.exit(fails ? 1 : 0);
