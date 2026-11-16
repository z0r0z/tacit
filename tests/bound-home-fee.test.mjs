// How a bought bound note goes home by the fast lane (dapp/bound-swap.js homeFeePlan, used by tacit.js moveBoundNoteHome): through the
// relay for its quoted fee in the token, or, with no quote (a runtime token the relay does not price: the quote throws or is empty),
// settled by the wallet itself with fee 0. A quote at or above the note's amount is refused. Offline.
//   node tests/bound-home-fee.test.mjs
import { readFileSync } from 'node:fs';
import { homeFeePlan } from '../dapp/bound-swap.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; console.log(`  FAIL - ${m}`); } };
const rejects = async (p, re) => { try { await p; return false; } catch (e) { return re.test(e.message); } };

const quoted = await homeFeePlan({ amount: 5_000_000n, quote: async () => 1234n });
ok(quoted.fee === 1234n && quoted.selfRelay === false, 'a relay quote: the relay settles it, for that fee in the token');
const asString = await homeFeePlan({ amount: '5000000', quote: async () => '77' });
ok(asString.fee === 77n && asString.selfRelay === false, 'a quote given as a decimal string reads the same');
const none = await homeFeePlan({ amount: 5_000_000n, quote: async () => { throw new Error('no relay price for this token'); } });
ok(none.fee === 0n && none.selfRelay === true, 'no quote (it throws, as for a runtime token): the wallet settles it itself, fee 0');
const empty = await homeFeePlan({ amount: 5_000_000n, quote: async () => null });
ok(empty.fee === 0n && empty.selfRelay === true, 'an empty quote: the wallet settles it itself');
const zero = await homeFeePlan({ amount: 5_000_000n, quote: async () => 0n });
ok(zero.fee === 0n && zero.selfRelay === true, 'a zero quote (the relay refuses a fast-lane job with no fee): the wallet settles it itself');
const odd = await homeFeePlan({ amount: 5_000_000n, quote: async () => -5n });
ok(odd.fee === 0n && odd.selfRelay === true, 'a quote below zero is no quote');
ok(await rejects(homeFeePlan({ amount: 1000n, quote: async () => 1000n }), /smaller than the fee/), 'a quote at or above the note\'s amount is refused');

// tacit.js hands the plan to the fast lane as it is (the relay or the wallet, and the fee)
const src = readFileSync(new URL('../dapp/tacit.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('async function moveBoundNoteHome('), src.indexOf('\n}\n', src.indexOf('async function moveBoundNoteHome(')));
ok(/homeFeePlan\(\{ amount: note\.amount, quote:/.test(body) && /buildFastlaneExitOp\(\{[^}]*fee: plan\.fee \}\)/.test(body) && /selfRelay: tried\.plan\.selfRelay/.test(body) && !/selfRelay: false/.test(body),
  'moveBoundNoteHome asks homeFeePlan and passes its fee (to the op) and relay choice (to fastlaneExit), with no fixed relay');
ok(/fastlaneExit\(\{[^}]*built: tried\.built/.test(body) && /queuedTimeoutMs: HOME_EXIT_QUEUED_MS/.test(body) && /if \(!_waitRanOut\(e\)\) _homeExits\.delete\(key\)/.test(body),
  'a try whose wait ran out keeps its op, so the next try sends the same op (the API answers with the job it holds) and waits out the queue');

ok(/ux\.poolTickerOf\(aid\)/.test(body) && /ux\.relayFeeEligible\(t\)/.test(body) && !/assetById/.test(body) && /readAsset\(aid\)\)\?\.poolMinted/.test(body),
  'the quote names the token by its pool ticker (cUSDT, not the asset id), and a token the relay does not price, or one the pool does not mint (its fee would revert BtcHomedValueExitMustBridge), gets no quote');

console.log(`\n${pass} bound-home-fee checks passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
