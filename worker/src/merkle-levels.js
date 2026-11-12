// The pool's note tree with every level kept, so a membership path is read in O(depth) after one build. The hashing is that of
// Tree.rootAndPath in dapp/confidential-pool.js (keccak256 of each pair, the zero subtree where a sibling is missing); the test
// tests/merkle-levels.test.mjs holds the two to the same roots and paths.
export function buildTreeLevels(leafHexes, keccak256, depth = 32) {
  const hexToBytes = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
  const b32 = (v) => hexToBytes(String(v).replace(/^0x/, '').padStart(64, '0'));
  const hx = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const ZERO32 = new Uint8Array(32);
  const cat = (l, r) => { const o = new Uint8Array(l.length + r.length); o.set(l, 0); o.set(r, l.length); return o; };
  const zeros = [ZERO32];
  for (let i = 1; i < depth; i++) zeros.push(keccak256(cat(zeros[i - 1], zeros[i - 1])));
  const levels = [leafHexes.map(b32)];
  for (let i = 0; i < depth; i++) {
    const level = levels[i], next = [];
    for (let k = 0; k * 2 < level.length; k++) next.push(keccak256(cat(level[2 * k], 2 * k + 1 < level.length ? level[2 * k + 1] : zeros[i])));
    levels.push(next.length ? next : [zeros[i + 1] || ZERO32]);
  }
  return {
    root: hx(levels[depth][0]),
    path(index) {
      const out = [];
      for (let i = 0; i < depth; i++) { const sib = (index >>> i) ^ 1; out.push(hx(sib < levels[i].length ? levels[i][sib] : zeros[i])); }
      return out;
    },
  };
}
