// dapp/prove.sh: the one command that installs tacit-prover and starts it mining the proof pool. It is run here as it is served (piped into
// `sh -s --`) against a local server standing in for GitHub, the API and the points service, with a stand-in for the program and for
// uname, sysctl, launchctl and systemctl, so nothing here touches this machine's services or the network.
//
// What matters: a download that does not match its pin is never run; the right asset is picked for the machine (Rosetta included) and
// the others are refused in words; a mistyped address is refused before anything is downloaded; the address reaches the service; a
// re-run without an address keeps the one installed; and a script cut short mid-download runs nothing.
//
// Run: node --test tests/prove-installer.test.mjs   (LIVE=1 also checks the pins against the real release's checksum files)

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, lstatSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rewrite, pinsIn } from '../tools/prove-pins.mjs';

const SCRIPT_PATH = new URL('../dapp/prove.sh', import.meta.url).pathname;
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8');
const ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const OTHER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const MIXED = '0x1234567890ABCDEF1234567890abcdef12345678';   // ADDR as a wallet shows it

// The program as a release would carry it, here a script that records what the installer asks of it.
const FAKE_PROVER = `#!/bin/sh
case "$1" in
  install)
    printf 'install mine=%s dir=%s exe=%s\\n' "$TACIT_MINE" "$TACIT_PROVER_DIR" "$0" >> "$HOME/fake-prover.log"
    [ -z "$FAKE_INSTALL_FAILS" ] || { echo "launchctl could not load the plist" >&2; exit 1; }
    echo "tacit-prover starts at login now and is starting (stand-in); its log is $HOME/.tacit-prover/daemon.log" ;;
  uninstall) printf 'uninstall\\n' >> "$HOME/fake-prover.log"; echo "tacit-prover no longer starts at login" ;;
  *) printf 'other %s\\n' "$*" >> "$HOME/fake-prover.log" ;;
esac
`;

const sha = (b) => createHash('sha256').update(b).digest('hex');
function tarball(dir, name, body = FAKE_PROVER) {
  const src = mkdtempSync(join(dir, 'pkg-'));
  writeFileSync(join(src, 'tacit-prover'), body, { mode: 0o755 });
  const out = join(dir, name);
  execFileSync('tar', ['czf', out, '-C', src, 'tacit-prover']);
  return readFileSync(out);
}

// The server: the release's assets and checksum files under /rel/, and the local daemon's, the pool's and the points service's answers.
async function serve(dir, { pool, mine } = {}) {
  const assets = {
    'tacit-prover-macos-arm64.tar.gz': tarball(dir, 'mac.tgz'),
    'tacit-prover-linux-x86_64.tar.gz': tarball(dir, 'linux.tgz'),
  };
  const lies = new Map();     // asset → the checksum the .sha256 file claims instead
  const seen = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(u.pathname + u.search);
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const m = u.pathname.match(/^\/rel\/(.+?)(\.sha256)?$/);
    if (m && assets[m[1]]) {
      if (m[2]) { res.writeHead(200); return res.end(`${lies.get(m[1]) || sha(assets[m[1]])}  ${m[1]}\n`); }
      res.writeHead(200, { 'content-type': 'application/gzip' }); return res.end(assets[m[1]]);
    }
    if (u.pathname === '/health') return json({ ok: true, vkey: '0x00', busy: false, queued: 0, gpu: null });
    if (u.pathname === '/prover/pool') return json(pool || { queued: 2, leased: 0, doneToday: 23, minersToday: 1, top: [], terms: { pointsPerProof: 20, proofsPerMinerDay: 30, leaseMs: 2700000 } });
    if (u.pathname === '/prover/pool/credits') return json({ day: Number(u.searchParams.get('day')), over: false, pointsPerProof: 20, miners: [{ miner: ADDR, proofs: 2, points: 40 }, { miner: '0x2222222222222222222222222222222222222222', proofs: 1, points: 20 }] });
    if (u.pathname === '/mine') return json(mine || { enabled: true, pocket: { totalWei: '1500000000000000000000', creditedWei: '9', remainingWei: '1' }, account: { address: u.searchParams.get('address'), creditedWei: '6200000000000000000' } });
    res.writeHead(404); res.end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, assets, lies, seen, port: server.address().port, base: `http://127.0.0.1:${server.address().port}` };
}

// The commands the installer asks of the system, as stand-ins that answer from the environment and record what they were asked.
function shims(dir) {
  const bin = join(dir, 'shims');
  mkdirSync(bin);
  const put = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  put('uname', 'case "$1" in -m) echo "${FAKE_ARCH:-arm64}" ;; *) echo "${FAKE_OS:-Darwin}" ;; esac');
  put('sysctl', 'case "$2" in hw.optional.arm64) echo "${FAKE_ARM64:-1}" ;; hw.memsize) echo "${FAKE_MEM:-17179869184}" ;; *) exit 1 ;; esac');
  put('launchctl', 'echo "launchctl $*" >> "$HOME/system.log"; [ "$1" != print ] || printf "gui/501/finance.tacit.prover = {\\n\\tpath = x\\n\\tstate = %s\\n}\\n" "${FAKE_LAUNCHD:-running}"');
  put('systemctl', 'echo "systemctl $*" >> "$HOME/system.log"; case "$2" in is-active) echo "${FAKE_SYSTEMD:-active}" ;; esac');
  put('loginctl', 'echo "Linger=${FAKE_LINGER:-no}"');
  return bin;
}

async function world(opts) {
  const dir = mkdtempSync(join(tmpdir(), 'prove-test-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const srv = await serve(dir, opts);
  const sh = shims(dir);
  const env = (extra = {}) => ({
    PATH: `${sh}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: dir,
    TACIT_PROVER_BASE: `${srv.base}/rel`, TACIT_POOL_API: srv.base, TACIT_POINTS_API: srv.base, TACIT_PROVER_PORT: String(srv.port),
    TACIT_PROVER_SHA256: sha(srv.assets['tacit-prover-macos-arm64.tar.gz']),
    ...extra,
  });
  // The script as it is served: on sh's standard input, its arguments after `-s --`.
  const run = (args = [], extra = {}, script = SCRIPT) => new Promise((resolve) => {
    const p = spawn('sh', ['-s', '--', ...args], { env: env(extra), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.on('error', () => {});
    p.stdin.end(script);
  });
  const read = (f) => (existsSync(join(home, f)) ? readFileSync(join(home, f), 'utf8') : '');
  const done = () => { srv.server.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, home, srv, run, read, done, bin: join(home, '.tacit-prover/bin/tacit-prover') };
}

const withWorld = (fn, opts) => async () => { const w = await world(opts); try { await fn(w); } finally { w.done(); } };

test('installs the program, checks it, and hands the address to the service', withWorld(async (w) => {
  const r = await w.run([ADDR]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(existsSync(w.bin) && (lstatSync(w.bin).mode & 0o111), 'the program is in place and executable');
  assert.deepEqual(w.srv.seen.filter((p) => p.startsWith('/rel/')), ['/rel/tacit-prover-macos-arm64.tar.gz']);
  assert.match(r.out, /Checked its sha256 \([0-9a-f]{12}\.\.\.\) against the sha256 you gave/);
  assert.equal(w.read('fake-prover.log').trim(), `install mine=${ADDR} dir=${w.home}/.tacit-prover exe=${w.bin}`);
  assert.match(r.out, /tacit-prover is running\./);
  assert.match(r.out, new RegExp(`for ${ADDR.slice(0, 6)}\\.\\.\\.${ADDR.slice(-4)}`));
  assert.match(r.out, /6\.2 GB circuit/);
  assert.match(r.out, /--status/);
  assert.match(r.out, /--uninstall/);
}));

test('a download that does not match the pin is never installed or run', withWorld(async (w) => {
  // No sha256 given and the script's own tag: the pin in the script is what is checked, and the stand-in is not the real release.
  const r = await w.run([ADDR], { TACIT_PROVER_SHA256: '' });
  assert.equal(r.code, 1);
  assert.match(r.err, /so nothing was installed/);
  assert.ok(!existsSync(w.bin));
  assert.equal(w.read('fake-prover.log'), '');
  assert.equal(w.read('system.log'), '');
}));

test('a build of your own with no sha256 given is checked against the release\'s own checksum file', withWorld(async (w) => {
  const r = await w.run([ADDR], { TACIT_PROVER_SHA256: '', TACIT_PROVER_TAG: 'tacit-prover-v9.9.9' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /against the release's own checksum file \(tacit-prover-v9\.9\.9 is not pinned in this script\)/);
  assert.ok(w.srv.seen.includes('/rel/tacit-prover-macos-arm64.tar.gz.sha256'));
}));

test('a tarball that does not match its checksum file is refused', withWorld(async (w) => {
  w.srv.lies.set('tacit-prover-macos-arm64.tar.gz', 'ab'.repeat(32));
  const r = await w.run([ADDR], { TACIT_PROVER_SHA256: '', TACIT_PROVER_TAG: 'tacit-prover-v9.9.9' });
  assert.equal(r.code, 1);
  assert.match(r.err, /so nothing was installed/);
  assert.ok(!existsSync(w.bin));
}));

test('each machine gets its own asset, and the ones with none are told why', withWorld(async (w) => {
  const linux = sha(w.srv.assets['tacit-prover-linux-x86_64.tar.gz']);
  let r = await w.run([ADDR], { FAKE_OS: 'Linux', FAKE_ARCH: 'x86_64', TACIT_PROVER_SHA256: linux });
  assert.equal(r.code, 0, r.err);
  assert.ok(w.srv.seen.includes('/rel/tacit-prover-linux-x86_64.tar.gz'));
  assert.match(r.out, /sudo loginctl enable-linger/, 'a server login is told how to keep it running after logout');
  assert.match(w.read('system.log'), /systemctl --user restart tacit-prover/, 'an update on systemd is restarted, as it leaves a running unit alone');

  // An x86_64 shell on an Apple-silicon Mac (Rosetta) still gets the arm64 build.
  w.srv.seen.length = 0;
  const systemBefore = w.read('system.log');
  r = await w.run([ADDR], { FAKE_OS: 'Darwin', FAKE_ARCH: 'x86_64', FAKE_ARM64: '1' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(w.srv.seen.filter((p) => p.startsWith('/rel/')), ['/rel/tacit-prover-macos-arm64.tar.gz']);
  assert.doesNotMatch(r.out, /enable-linger/);
  assert.equal(w.read('system.log'), systemBefore, 'on a Mac the script asks nothing of launchd itself: the program\'s own install boots the old one out');

  for (const [env, why] of [
    [{ FAKE_OS: 'Darwin', FAKE_ARCH: 'x86_64', FAKE_ARM64: '0' }, /needs an Apple-silicon Mac.*x86_64/],
    [{ FAKE_OS: 'Linux', FAKE_ARCH: 'aarch64' }, /no Linux build for aarch64/],
    [{ FAKE_OS: 'MINGW64_NT-10.0', FAKE_ARCH: 'x86_64' }, /wsl --install/],
    [{ FAKE_OS: 'FreeBSD', FAKE_ARCH: 'amd64' }, /builds for Apple-silicon Macs and x86-64 Linux; this is FreeBSD amd64/],
  ]) {
    w.srv.seen.length = 0;
    r = await w.run([ADDR], env);
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.match(r.err, why);
    assert.deepEqual(w.srv.seen.filter((p) => p.startsWith('/rel/')), [], 'nothing is downloaded for a machine with no build');
  }
}));

test('a mistyped address is refused before anything is downloaded', withWorld(async (w) => {
  for (const bad of ['0xYourAddress', 'vitalik.eth', '0x' + 'a'.repeat(39), '0x' + 'g'.repeat(40), 'bc1qxyz']) {
    const r = await w.run([bad]);
    assert.equal(r.code, 1, bad);
    assert.match(r.err, /is not an address.*0x and 40 hex digits/);
  }
  assert.equal((await w.run(['--bogus'])).code, 1);
  assert.deepEqual(w.srv.seen, [], 'no request was made');
  assert.ok(!existsSync(w.bin));
}));

test('with no address it installs for the computer\'s own pages, and a re-run keeps the address a service already has', withWorld(async (w) => {
  let r = await w.run([]);
  assert.equal(r.code, 0, r.err);
  assert.match(w.read('fake-prover.log'), /install mine= dir=/);
  assert.match(r.out, /No address was given/);

  // launchd's plist carries the address it was installed with; the next run without one installs with that.
  const plist = join(w.home, 'Library/LaunchAgents');
  mkdirSync(plist, { recursive: true });
  writeFileSync(join(plist, 'finance.tacit.prover.plist'), `<dict><key>TACIT_MINE</key><string>${OTHER}</string></dict>`);
  r = await w.run([]);
  assert.equal(r.code, 0, r.err);
  assert.match(w.read('fake-prover.log').trim().split('\n').pop(), new RegExp(`install mine=${OTHER} `));
  assert.match(r.out, /for 0xabcd\.\.\.abcd/);

  // An address given wins.
  r = await w.run([ADDR]);
  assert.match(w.read('fake-prover.log').trim().split('\n').pop(), new RegExp(`install mine=${ADDR} `));
}));

test('TACIT_PROVER_NO_SERVICE installs the program and prints how to run it by hand', withWorld(async (w) => {
  const r = await w.run([ADDR], { TACIT_PROVER_NO_SERVICE: '1' });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(w.bin));
  assert.equal(w.read('fake-prover.log'), '', 'the service was not asked for');
  assert.match(r.out, new RegExp(`${w.bin} mine ${ADDR}`));
}));

test('a service that cannot be set up leaves the program installed and says how to run it in a terminal', withWorld(async (w) => {
  const r = await w.run([ADDR], { FAKE_INSTALL_FAILS: '1' });
  assert.equal(r.code, 1);
  assert.match(r.err, /launchctl could not load the plist/);
  assert.match(r.err, new RegExp(`${w.bin} mine ${ADDR}`));
  assert.match(r.err, /desktop session, not ssh/);
  assert.ok(existsSync(w.bin));
}));

test('it goes on the PATH where ~/.local/bin is already, and never over a program of the same name that is not its own', withWorld(async (w) => {
  const lb = join(w.home, '.local/bin');
  mkdirSync(lb, { recursive: true });
  let r = await w.run([ADDR]);
  assert.equal(r.code, 0, r.err);
  assert.equal(readlinkSync(join(lb, 'tacit-prover')), w.bin);

  rmSync(join(lb, 'tacit-prover'));
  writeFileSync(join(lb, 'tacit-prover'), 'mine');
  r = await w.run([ADDR]);
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(join(lb, 'tacit-prover'), 'utf8'), 'mine');
}));

test('--status says what runs, what the pool has and what the address has earned', withWorld(async (w) => {
  await w.run([ADDR]);
  writeFileSync(join(w.home, '.tacit-prover/daemon.log'), [
    'tacit-prover: mining the proof pool for ' + ADDR,
    'tacit-prover: proving pool job 3f9c0a1b2c3d4e5f for ' + ADDR,
    'tacit-prover: pool job 3f9c0a1b2c3d4e5f proved in 421 s, 20 points to ' + ADDR,
    'tacit-prover: proving pool job aaaaaaaaaaaaaaaa for ' + ADDR, ''].join('\n'));
  const plist = join(w.home, 'Library/LaunchAgents');
  mkdirSync(plist, { recursive: true });
  writeFileSync(join(plist, 'finance.tacit.prover.plist'), `<string>${ADDR}</string>`);

  const r = await w.run(['--status']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Service    running, and starts at login/);
  assert.match(r.out, /Answering  yes, on 127\.0\.0\.1:/);
  assert.match(r.out, new RegExp(`Mining for ${ADDR}`));
  assert.match(r.out, /Last       proving pool job aaaaaaaaaaaaaaaa/);
  assert.match(r.out, /Accepted   1 in this log/);
  assert.match(r.out, /The pool   2 wraps waiting, 23 proved today by 1 prover\n/);
  assert.match(r.out, /Today      2 proofs, 40 points to 0x1234\.\.\.5678/);
  assert.match(r.out, /Credited   6\.2000 TAC to 0x1234\.\.\.5678/);
  assert.ok(w.srv.seen.includes(`/mine?address=${ADDR}`));
  assert.ok(w.srv.seen.includes(`/prover/pool/credits?day=${Math.floor(Date.now() / 86400000)}`), 'the tally asked for is the UTC day');

  // An address on the command line is the one looked up, and a stopped service says so.
  w.srv.seen.length = 0;
  const q = await w.run(['--status', OTHER], { FAKE_LAUNCHD: 'waiting' });
  assert.match(q.out, /Service    waiting/);
  assert.match(q.out, /Today      no proofs yet from 0xabcd\.\.\.abcd/);
  assert.ok(w.srv.seen.includes(`/mine?address=${OTHER}`));
}));

test('--status finds an address in the tally however it is cased', withWorld(async (w) => {
  const r = await w.run(['--status', MIXED]);
  assert.match(r.out, /Today      2 proofs, 40 points to 0x1234\.\.\.5678/);
}));

test('--status on a computer with nothing installed says how to install, and reads no account', withWorld(async (w) => {
  const r = await w.run(['--status'], { FAKE_OS: 'Linux', FAKE_ARCH: 'x86_64', FAKE_SYSTEMD: '' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Program    not installed \(curl -fsSL https:\/\/tacit\.finance\/prove\.sh \| sh -s -- 0xYourAddress\)/);
  assert.match(r.out, /Service    not set to start at login/);
  assert.match(r.out, /Mining for no address/);
  assert.ok(!w.srv.seen.some((p) => p.startsWith('/mine')));
}));

test('--status keeps going when the pool and the points service do not answer', withWorld(async (w) => {
  await w.run([ADDR]);
  const r = await w.run(['--status', ADDR], { TACIT_POOL_API: 'http://127.0.0.1:9', TACIT_POINTS_API: 'http://127.0.0.1:9' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /The pool   could not be read just now/);
  assert.match(r.out, /Today      could not be read just now/);
  assert.match(r.out, /Credited   could not be read just now/);
}));

test('--uninstall stops the service, removes the program and its link, and keeps the circuit and the log', withWorld(async (w) => {
  const lb = join(w.home, '.local/bin');
  mkdirSync(lb, { recursive: true });
  await w.run([ADDR]);
  writeFileSync(join(w.home, '.tacit-prover/daemon.log'), 'kept\n');
  assert.ok(lstatSync(join(lb, 'tacit-prover')).isSymbolicLink());

  const r = await w.run(['--uninstall']);
  assert.equal(r.code, 0, r.err);
  assert.match(w.read('fake-prover.log'), /\nuninstall\n$/);
  assert.ok(!existsSync(w.bin));
  assert.ok(!existsSync(join(lb, 'tacit-prover')) && !(() => { try { lstatSync(join(lb, 'tacit-prover')); return true; } catch { return false; } })());
  assert.equal(w.read('.tacit-prover/daemon.log'), 'kept\n');
  assert.match(r.out, /rm -rf ~\/\.sp1\/circuits/);

  // With the program already gone, the service is still taken out by hand.
  const again = await w.run(['--uninstall']);
  assert.equal(again.code, 0, again.err);
  assert.match(w.read('system.log'), /launchctl bootout gui\/\d+\/finance\.tacit\.prover/);
}));

test('a script cut short in the download runs nothing', withWorld(async (w) => {
  // Cut anywhere before the last line, it either does not parse or defines functions and stops: it says nothing and does nothing.
  const lastLine = SCRIPT.lastIndexOf('main "$@"');
  for (const cut of [0.1, 0.3, 0.6, 0.95, (lastLine - 1) / SCRIPT.length]) {
    const r = await w.run([ADDR], {}, SCRIPT.slice(0, Math.floor(SCRIPT.length * cut)));
    assert.equal(r.out, '', `cut at ${cut}`);
  }
  assert.deepEqual(w.srv.seen, [], 'no request was made');
  assert.ok(!existsSync(w.bin));
}));

test('the pins are well formed, and the pages that offer the install name the script, not a release of their own', () => {
  const pins = Object.fromEntries([...SCRIPT.matchAll(/^(PIN_[A-Z0-9_]+)=(\S+)$/gm)].map((m) => [m[1], m[2]]));
  assert.match(pins.PIN_TAG, /^tacit-prover-v\d+\.\d+\.\d+$/);
  assert.match(pins.PIN_MACOS_ARM64, /^[0-9a-f]{64}$/);
  assert.match(pins.PIN_LINUX_X86_64, /^[0-9a-f]{64}$/);
  const dapp = new URL('../dapp/', import.meta.url).pathname;
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'vendor' ? [] : walk(join(dir, e.name))) : /\.(html|js)$/.test(e.name) ? [join(dir, e.name)] : []));
  for (const f of walk(dapp)) {
    for (const m of readFileSync(f, 'utf8').matchAll(/releases\/download\/(tacit-prover-v[\d.]+)\//g)) assert.equal(m[1], pins.PIN_TAG, `${f} offers ${m[1]}, the script pins ${pins.PIN_TAG}`);
  }
  for (const page of ['index.html', 'weld/keeper/index.html']) assert.match(readFileSync(join(dapp, page), 'utf8'), /https:\/\/tacit\.finance\/prove\.sh/, `${page} offers the installer`);
});

test('the pins are the real release\'s checksums', { skip: !process.env.LIVE }, async () => {
  const tag = SCRIPT.match(/^PIN_TAG=(\S+)$/m)[1];
  for (const [plat, key] of [['macos-arm64', 'PIN_MACOS_ARM64'], ['linux-x86_64', 'PIN_LINUX_X86_64']]) {
    const res = await fetch(`https://github.com/src-company/tacit/releases/download/${tag}/tacit-prover-${plat}.tar.gz.sha256`);
    assert.equal(res.status, 200);
    assert.equal((await res.text()).split(/\s+/)[0], SCRIPT.match(new RegExp(`^${key}=(\\S+)$`, 'm'))[1], plat);
  }
});

test('tools/prove-pins.mjs writes a release\'s tag and sums into the script and touches nothing else', () => {
  const sums = { PIN_MACOS_ARM64: 'a'.repeat(64), PIN_LINUX_X86_64: 'b'.repeat(64) };
  const next = rewrite(SCRIPT, 'tacit-prover-v0.3.1', sums);
  assert.deepEqual(pinsIn(next), { PIN_TAG: 'tacit-prover-v0.3.1', ...sums });
  const strip = (t) => t.replace(/^PIN_[A-Z0-9_]+=\S+$/gm, '');
  assert.equal(strip(next), strip(SCRIPT), 'only the three pin lines changed');
  assert.equal(rewrite(next, pinsIn(SCRIPT).PIN_TAG, { PIN_MACOS_ARM64: pinsIn(SCRIPT).PIN_MACOS_ARM64, PIN_LINUX_X86_64: pinsIn(SCRIPT).PIN_LINUX_X86_64 }), SCRIPT, 'and it goes back');
  assert.throws(() => rewrite(SCRIPT, 'v0.3.1', sums), /not a release tag/);
  assert.throws(() => rewrite(SCRIPT, 'tacit-prover-v0.3.1', { ...sums, PIN_LINUX_X86_64: 'xyz' }), /no sha256 for PIN_LINUX_X86_64/);
});
