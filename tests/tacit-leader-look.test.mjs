// How often the leader looks at a shield that has no deposit yet: every step while it is young, then every minute, then every five; a funded one is forgotten.
//   node tests/tacit-leader-look.test.mjs
import assert from 'node:assert';
import { makeLooks } from '../tacit-leader/look.mjs';

const L = makeLooks({ young: 120_000, mid: 600_000, everyMid: 60_000, everyOld: 300_000 });
assert.ok(L.due('a', 0) && !L.aged('a', 0), 'a shield not seen yet is looked at, and is not aged');
L.saw('a', 0, false);
assert.ok(L.due('a', 6_000) && L.due('a', 100_000), 'while it is young it is looked at every step');
assert.ok(!L.aged('a', 100_000) && L.aged('a', 120_000), 'it is aged once the young time has passed');
L.saw('a', 119_000, false);
assert.ok(!L.due('a', 130_000) && L.due('a', 179_000), 'then once a minute');
L.saw('a', 179_000, false);
assert.ok(!L.due('a', 238_000) && L.due('a', 239_000), 'a minute after each look, while it is between two and ten minutes old');
L.saw('a', 599_000, false);
assert.ok(!L.due('a', 600_000) && !L.due('a', 898_000) && L.due('a', 899_000), 'after ten minutes, once in five');
// a shield first seen later keeps its first time, not its last look
L.saw('b', 1_000_000, false); L.saw('b', 1_006_000, false);
assert.ok(L.aged('b', 1_120_000) && !L.aged('b', 1_119_999), 'its age counts from the first look');
// funded: forgotten, so it is looked at each step again
L.saw('a', 899_000, true);
assert.ok(L.due('a', 899_001) && !L.aged('a', 899_001), 'a funded shield is forgotten');
// what left the mempool is forgotten
L.prune(new Set(['x']));
assert.equal(L.size, 0, 'only the ids still waiting are kept');
// the cost of a batch that never gets funded, against looking every step (a step is six seconds): reads of the chain over an hour
{
  const steps = 600, mk = makeLooks(); const ids = Array.from({ length: 128 }, (_, i) => 'id' + i); let looks = 0;
  for (let s = 0; s < steps; s++) { const t = s * 6_000; for (const id of ids) if (mk.due(id, t)) { looks++; mk.saw(id, t, false); } }
  assert.ok(looks < 128 * steps * 0.15, `128 unfunded shields cost ${looks} looks in an hour, not ${128 * steps}`);
}
console.log('leader look schedule: all passed');
