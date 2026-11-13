// The salt grinder on the computer's GPU, through WebGPU: the same three hashes as saltcore.js, with each counter its own invocation of a compute shader, so a
// laptop's GPU walks more salts than twenty of its cores. A lane is a vec2<u32> (low word, high word). The shader's source is written out by grinderWgsl below,
// as the WebAssembly module is in saltcore.js: there is no compiled file. The shader notes each counter whose address starts with the zero bytes asked for; each
// note is then checked the plain way (saltcore.js saltAddress) before it counts.
import { templates, saltOf, saltAddress } from '/prove/saltcore.js?cb=87770f39';

// the shader's source (WGSL)
export function grinderWgsl({ notes = 255 } = {}) {
  const rot = Array.from({ length: 25 }, () => 0); { let x = 1, y = 0; for (let t = 0; t < 24; t++) { rot[x + 5 * y] = ((t + 1) * (t + 2) / 2) % 64; const ny = (2 * x + 3 * y) % 5; x = y; y = ny; } }
  const rc = []; { let lfsr = 1; for (let r = 0; r < 24; r++) { let lo = 0, hi = 0; for (let j = 0; j < 7; j++) { const bit = (1 << j) - 1; if (lfsr & 1) { if (bit < 32) lo ^= 1 << bit; else hi ^= 1 << (bit - 32); } lfsr = ((lfsr << 1) ^ (lfsr & 0x80 ? 0x71 : 0)) & 0xff; } rc.push(`vec2<u32>(${lo >>> 0}u, ${hi >>> 0}u)`); } }
  const rotl = (v, n) => (n === 0 ? v : n === 32 ? `${v}.yx` : n < 32 ? `vec2<u32>((${v}.x << ${n}u) | (${v}.y >> ${32 - n}u), (${v}.y << ${n}u) | (${v}.x >> ${32 - n}u))` : `vec2<u32>((${v}.y << ${n - 32}u) | (${v}.x >> ${64 - n}u), (${v}.x << ${n - 32}u) | (${v}.y >> ${64 - n}u))`);
  const L = [];
  L.push(`const RC = array<vec2<u32>, 24>(${rc.join(', ')});`);
  L.push('fn keccakf(s: ptr<function, array<vec2<u32>, 25>>) {');
  for (let i = 0; i < 25; i++) L.push(`  var a${i} = (*s)[${i}];`);
  L.push('  for (var r = 0u; r < 24u; r++) {');
  for (let x = 0; x < 5; x++) L.push(`    let c${x} = a${x} ^ a${x + 5} ^ a${x + 10} ^ a${x + 15} ^ a${x + 20};`);
  for (let x = 0; x < 5; x++) { L.push(`    let d${x} = c${(x + 4) % 5} ^ ${rotl(`c${(x + 1) % 5}`, 1)};`); }
  for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) L.push(`    let t${x + 5 * y} = a${x + 5 * y} ^ d${x};`);
  for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) L.push(`    let b${y + 5 * ((2 * x + 3 * y) % 5)} = ${rotl(`t${x + 5 * y}`, rot[x + 5 * y])};`);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) L.push(`    a${x + 5 * y} = b${x + 5 * y} ^ ((~b${(x + 1) % 5 + 5 * y}) & b${(x + 2) % 5 + 5 * y});`);
  L.push('    a0 = a0 ^ RC[r];', '  }');
  for (let i = 0; i < 25; i++) L.push(`  (*s)[${i}] = a${i};`);
  L.push('}');
  // the parameters: 11 vec4<u32> = 44 words: message 1's words 0..15, message 2's words 0..21 (from word 16), then the first counter, the mask and the row width
  const P = (k) => `P.w[${k >> 2}][${k & 3}]`, T1 = (i) => P(i), T2 = (i) => P(16 + i);
  L.push('struct Params { w: array<vec4<u32>, 11> }', '@group(0) @binding(0) var<uniform> P: Params;');
  L.push(`struct Notes { count: atomic<u32>, at: array<u32, ${notes}> }`, '@group(0) @binding(1) var<storage, read_write> O: Notes;');
  L.push('@compute @workgroup_size(64)', 'fn main(@builtin(global_invocation_id) id: vec3<u32>) {');
  L.push(`  let n = ${P(40)} + id.x + id.y * ${P(42)};`, '  var s = array<vec2<u32>, 25>();');
  // guarded = keccak(12 zero bytes ‖ deployer ‖ salt): the counter is word 15
  for (let l = 0; l < 7; l++) L.push(`  s[${l}] = vec2<u32>(${T1(2 * l)}, ${T1(2 * l + 1)});`);
  L.push(`  s[7] = vec2<u32>(${T1(14)}, n);`, '  s[8] = vec2<u32>(1u, 0u);', '  s[16] = vec2<u32>(0u, 0x80000000u);', '  keccakf(&s);');
  for (let k = 0; k < 4; k++) L.push(`  let g${2 * k} = s[${k}].x; let g${2 * k + 1} = s[${k}].y;`);
  // proxy = keccak(0xff ‖ CreateX ‖ guarded ‖ init hash): guarded starts at byte 21, a word and a byte in
  L.push('  s = array<vec2<u32>, 25>();', `  s[0] = vec2<u32>(${T2(0)}, ${T2(1)});`, `  s[1] = vec2<u32>(${T2(2)}, ${T2(3)});`);
  L.push(`  s[2] = vec2<u32>(${T2(4)}, ${T2(5)} | (g0 << 8u));`);
  L.push('  s[3] = vec2<u32>((g0 >> 24u) | (g1 << 8u), (g1 >> 24u) | (g2 << 8u));', '  s[4] = vec2<u32>((g2 >> 24u) | (g3 << 8u), (g3 >> 24u) | (g4 << 8u));', '  s[5] = vec2<u32>((g4 >> 24u) | (g5 << 8u), (g5 >> 24u) | (g6 << 8u));');
  L.push(`  s[6] = vec2<u32>((g6 >> 24u) | (g7 << 8u), ${T2(13)} | (g7 >> 24u));`);
  for (let l = 7; l <= 10; l++) L.push(`  s[${l}] = vec2<u32>(${T2(2 * l)}, ${T2(2 * l + 1)});`);
  L.push('  s[16] = vec2<u32>(0u, 0x80000000u);', '  keccakf(&s);');
  L.push('  let p3 = s[1].y; let p4 = s[2].x; let p5 = s[2].y; let p6 = s[3].x; let p7 = s[3].y;');
  // address = keccak(0xd6 0x94 ‖ proxy ‖ 0x01)
  L.push('  s = array<vec2<u32>, 25>();', '  s[0] = vec2<u32>(0x94d6u | (p3 << 16u), (p3 >> 16u) | (p4 << 16u));', '  s[1] = vec2<u32>((p4 >> 16u) | (p5 << 16u), (p5 >> 16u) | (p6 << 16u));', '  s[2] = vec2<u32>((p6 >> 16u) | (p7 << 16u), 0x01010000u | (p7 >> 16u));', '  s[16] = vec2<u32>(0u, 0x80000000u);', '  keccakf(&s);');
  // the address's first four bytes are word 3
  L.push(`  if ((s[1].y & ${P(41)}) == 0u) { let i = atomicAdd(&O.count, 1u); if (i < ${notes}u) { O.at[i] = n; } }`, '}');
  return L.join('\n');
}

const NOTES = 255, ROW = 256;   // counters noted in one dispatch at most; workgroups in a row (64 counters each)
// A grinder like saltcore.js's, on the GPU. -> null where there is no WebGPU or no adapter. grind(count, minBits) is async, walks about `count` salts (whole rows of
// 16,384) and resolves to the shares; at() says how far it has walked. After the device is lost grind rejects, and the thread goes back to the cores.
export async function makeGpuGrinder({ day, prefix, gpu = globalThis.navigator?.gpu }) {
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' }); if (!adapter) return null;
  const device = await adapter.requestDevice();
  let lost = null; device.lost.then((i) => { lost = i?.message || 'the GPU device was lost'; });
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: device.createShaderModule({ code: grinderWgsl({ notes: NOTES }) }), entryPoint: 'main' } });
  const size = 4 * (NOTES + 1);
  const params = device.createBuffer({ size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const notes = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const read = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: params } }, { binding: 1, resource: { buffer: notes } }] });
  const { m1, m2 } = templates(day, prefix), P = new Uint32Array(44), zero = new Uint32Array(1);
  let dispatches = 0, noted = 0;   // how many dispatches it has run and how many counters the shader noted in them: a mask too wide shows as far too many notes
  P.set(new Uint32Array(m1.buffer.slice(0)), 0); P.set(new Uint32Array(m2.buffer.slice(0)), 16); P[42] = ROW * 64;
  // the counters base .. base + rows * 16384 - 1, in one dispatch -> the counters it noted, or null if it noted more than it could hold
  async function run(base, rows, mask) {
    if (lost) throw new Error(lost);
    P[40] = base; P[41] = mask; device.queue.writeBuffer(params, 0, P); device.queue.writeBuffer(notes, 0, zero);
    const enc = device.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(ROW, rows); pass.end();
    enc.copyBufferToBuffer(notes, 0, read, 0, size); device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const got = new Uint32Array(read.getMappedRange().slice(0)); read.unmap();
    dispatches++; noted += got[0];
    return got[0] > NOTES ? null : Array.from(got.subarray(1, 1 + got[0]));
  }
  // a stretch that noted too many is walked again as two halves (it only happens at a share size far under the pool's)
  async function walk(base, rows, mask) {
    const got = await run(base, rows, mask); if (got) return got;
    if (rows === 1) throw new Error('a share size this small is left to the cores');
    const half = rows >> 1;
    return [...await walk(base, half, mask), ...await walk((base + half * ROW * 64) | 0, rows - half, mask)];
  }
  let n = 0;
  async function grind(count, minBits) {
    if (minBits < 16) throw new Error('minBits under 16: use the cores');
    const k = Math.min(4, minBits >> 3), mask = k >= 4 ? -1 : (1 << (8 * k)) - 1;
    const rows = Math.max(1, Math.min(65535, Math.round(count / (ROW * 64))));
    const at = await walk((n + 1) | 0, rows, mask >>> 0);
    n = (n + rows * ROW * 64) | 0;
    return at.map((c) => ({ n: c | 0, bits: saltAddress(saltOf(day, prefix, c | 0)).bits })).filter((f) => f.bits >= minBits).sort((a, b) => (a.n >>> 0) - (b.n >>> 0));
  }
  return { grind, saltOf: (c) => saltOf(day, prefix, c), day, at: () => n, gpu: true, maxChunk: 65535 * ROW * 64, stats: () => ({ dispatches, noted }), close: () => { try { device.destroy(); } catch { /* gone already */ } } };
}
