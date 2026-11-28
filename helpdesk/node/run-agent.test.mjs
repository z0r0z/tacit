// node node/run-agent.test.mjs -- the big-model node's launcher decides what to run from the hardware, in a dry run (nothing is downloaded or started)
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname), SH = path.join(HERE, 'run-agent.sh');
let fails = 0; const check = (n, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) fails++; };
const MINER = '0x' + 'ab'.repeat(20);
const run = (hw, env = {}) => spawnSync('bash', [SH], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, DRY_RUN: '1', MINER, HW_JSON: JSON.stringify(hw), ...env } });
const plan = (r) => r.stdout.split('\n').filter((l) => l.startsWith('plan: llama-server'))[0] || '';

const syn = spawnSync('bash', ['-n', SH], { encoding: 'utf8' });
check('the script parses', syn.status === 0, syn.stderr);

const win = run({ ram: 96, vram: 6, cores: 16, os: 'windows', arch: 'x64', unified: false });
check('a 6 GB GPU with 96 GB of RAM: attention on the GPU, the experts in RAM, and the measured flags', win.status === 0 && /--n-cpu-moe 99/.test(plan(win)) && /-ngl 99/.test(plan(win)) && /--jinja/.test(plan(win)) && /-b 2048 -ub 2048/.test(plan(win)) && /-c 32768/.test(plan(win)) && /-fa on/.test(plan(win)) && /-t 8 /.test(plan(win)), plan(win));
check('the plan names the model the help desk expects, and takes agent turns only', /qwen3\.6-35b-a3b-ud-q4_k_xl/.test(win.stdout) && /KINDS=agent /.test(win.stdout) && /--host 127\.0\.0\.1/.test(plan(win)), win.stdout);
const big = run({ ram: 64, vram: 24, cores: 16, os: 'linux', arch: 'x64', unified: false });
check('a 24 GB GPU holds the whole model: no experts moved to RAM', big.status === 0 && /-ngl 99/.test(plan(big)) && !/--n-cpu-moe/.test(plan(big)), plan(big));
const mac = run({ ram: 64, vram: 0, cores: 12, os: 'darwin', arch: 'arm64', unified: true });
check('Apple silicon uses its unified memory', mac.status === 0 && /-ngl 99/.test(plan(mac)) && !/--n-cpu-moe/.test(plan(mac)) && /Apple silicon/.test(mac.stdout), plan(mac));
const cpu = run({ ram: 32, vram: 0, cores: 8, os: 'linux', arch: 'x64', unified: false });
check('no GPU: it runs on the CPU and says that is slow', cpu.status === 0 && /-ngl 0/.test(plan(cpu)) && /slow/.test(cpu.stdout), plan(cpu));
check('threads are half the cores, at least 4 and at most 16', /-t 4 /.test(plan(run({ ram: 32, vram: 0, cores: 4, os: 'linux', arch: 'x64', unified: false }))) && /-t 16 /.test(plan(run({ ram: 256, vram: 0, cores: 128, os: 'linux', arch: 'x64', unified: false }))) && /-t 12 /.test(plan(run({ ram: 64, vram: 0, cores: 24, os: 'linux', arch: 'x64', unified: false }))));
check('THREADS overrides', /-t 6 /.test(plan(run({ ram: 64, vram: 0, cores: 24, os: 'linux', arch: 'x64', unified: false }, { THREADS: '6' }))));
const small = run({ ram: 16, vram: 0, cores: 8, os: 'darwin', arch: 'arm64', unified: true });
check('a machine with too little memory is refused, with the reason and where to go instead', small.status === 1 && /needs about 30 GB/.test(small.stderr) && /run\.sh/.test(small.stderr), small.stderr);
const edge = run({ ram: 29, vram: 6, cores: 8, os: 'windows', arch: 'x64', unified: false });
check('29 GB is refused and 30 GB is not', edge.status === 1 && run({ ram: 30, vram: 6, cores: 8, os: 'windows', arch: 'x64', unified: false }).status === 0);
const noMiner = spawnSync('bash', [SH], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, DRY_RUN: '1', MINER: 'nope', HW_JSON: '{"ram":96,"vram":6,"cores":16}' } });
check('without a valid address it says so and stops', noMiner.status === 1 && /MINER/.test(noMiner.stderr));
check('KINDS can be changed by the operator', /KINDS=agent,scan /.test(run({ ram: 96, vram: 6, cores: 16, os: 'linux', arch: 'x64', unified: false }, { KINDS: 'agent,scan' }).stdout));
console.log(fails ? `${fails} FAILED` : 'run-agent: all tests passed'); process.exit(fails ? 1 : 0);
