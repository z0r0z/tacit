// One at a time, in the order asked, whatever happens to the one before: a failure is that task's own and does not stop the ones behind it.
//
// The provider's address is sent from by more than one part of the process (its own settles, and the refill's pull and deposit). Two sends begun in
// the same moment would read the same pending nonce and one would be refused or replace the other; taking turns, each is begun after the one before
// has been sent, so each reads the nonce the one before left. A refill used to wait until no swap was locking or refunding, which in a busy hour is
// never: the TAC it was to shield sat at the address while the provider ran dry.

export function makeSerial() {
  let tail = Promise.resolve();
  return function serial(task) {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}
