// Regression test for the variable-fill bid "springs-back" over-fill (audit
// bug #1). _projectBidRemaining is the single source of truth for a var bid's
// open capacity: amount − settled_amount − Σ(active unsettled partial-claims).
// Once a chunk settles the scanner bumps settled_amount and deletes the
// bidpclaim, so the consumed capacity must NOT re-open when the (now absent)
// bidpclaim's TTL would have lapsed.
import { _projectBidRemaining } from '../worker/src/index.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (String(got) === String(want)) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}: got ${got}, want ${want}`); fail++; }
};
const NOW = 1_000_000;
const claim = (fill, expOffset) => ({ fill_amount: String(fill), expires_at: NOW + expOffset });

console.log('\n=== _projectBidRemaining (bug #1 springs-back) ===\n');

// Fresh bid, no settlement, no claims → full amount open.
eq('fresh bid: remaining == amount', _projectBidRemaining(1000n, 0n, [], NOW), 1000n);

// One active claim reserves capacity.
eq('one active 300 claim reserves it', _projectBidRemaining(1000n, 0n, [claim(300, 60)], NOW), 700n);

// Expired claims do not reserve.
eq('expired claim does not reserve', _projectBidRemaining(1000n, 0n, [claim(300, -60)], NOW), 1000n);

// THE BUG: a chunk settled (settled_amount=300) and its bidpclaim is gone
// (deleted by the scanner). Capacity must stay consumed, NOT spring back.
eq('settled chunk stays consumed after bidpclaim gone', _projectBidRemaining(1000n, 300n, [], NOW), 700n);

// Settled + a separate live claim: both subtract, no double-count.
eq('settled 300 + active 200', _projectBidRemaining(1000n, 300n, [claim(200, 60)], NOW), 500n);

// Fully settled → 0 open (bid is consumed; dapp filters remaining<min_fill).
eq('fully settled → 0', _projectBidRemaining(1000n, 1000n, [], NOW), 0n);

// Never goes negative even if settled + claims over-shoot (defensive clamp).
eq('over-subscribed clamps to 0', _projectBidRemaining(1000n, 800n, [claim(500, 60)], NOW), 0n);

// Mixed expired + active + settled: only active + settled count.
eq('mixed: settled 100 + active 200 (+expired 400 ignored)',
   _projectBidRemaining(1000n, 100n, [claim(200, 60), claim(400, -10)], NOW), 700n);

console.log(`\n=== ${pass} passed · ${fail} failed ===`);
if (fail > 0) process.exit(1);
