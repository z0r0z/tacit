// Which kind of job the settle relay takes next.
//
// The relay is one loop: it claims a job, proves it, settles it, and only then claims the next. Two kinds wait in the queue: relayed settles (a page
// handed the relay an op to prove and send) and prove-only jobs (the holder sends the settle, the relay only proves). A prove-only job that cannot be
// proved still costs minutes of the loop before it fails, and the queue used to hand jobs out in arrival order across both kinds, so a burst of them
// held every settle behind it (a 5.5 TAC Finish waited 20 minutes on 2026-11-16 instead of 30 seconds).
//
// So settles are taken first. Prove-only jobs are not starved: after `proveTurnEvery` settles in a row, one prove-only job gets a turn (when there is
// one), and whenever no settle is waiting, prove-only jobs are taken as before.
//
//   const pick = makeJobPicker({ confidentialJob, proveTurnEvery: 4 });
//   const job = await pick({ short, gather });   // → the API's job ({ jobId, ... }) or {} / null when there is none
//
// `short` (the settle wallet cannot pay) and `gather` (settles are being left a moment for company) both take only prove-only jobs, as the relay always did.
export function makeJobPicker({ confidentialJob, proveTurnEvery = 4 } = {}) {
  if (typeof confidentialJob !== 'function') throw new Error('makeJobPicker: confidentialJob is required');
  let settles = 0;   // settles taken since a prove-only job last had a turn
  return async function pick({ short = false, gather = false } = {}) {
    if (short || gather) return confidentialJob({ mode: 'prove' });
    if (proveTurnEvery > 0 && settles >= proveTurnEvery) {
      settles = 0;
      const turn = await confidentialJob({ mode: 'prove' });
      if (turn?.jobId) return turn;
    }
    const settle = await confidentialJob({ mode: 'settle' });
    if (settle?.jobId) { settles++; return settle; }
    settles = 0;
    return confidentialJob({ mode: 'prove' });
  };
}
