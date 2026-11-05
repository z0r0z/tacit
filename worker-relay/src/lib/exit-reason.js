// Why a prover binary stopped, in one line a log can carry: the error it printed last (a Rust `main` returning Err prints
// "Error: …" and any "Caused by:" chain on stderr, then exits 1; a panic prints "panicked at …"), else its last lines.
//
// The raw tail is no use here: cut at a fixed length it starts mid-line (inside an RPC key, a block hash), and a reason that
// keeps only its first line kept only that fragment ('… (code=1): b4352e577fa708e0a'), losing the error itself. A URL can
// carry an access key, so each one is cut to its scheme and host.

export const redactUrls = (s) => String(s || '').replace(/\b(https?|wss?):\/\/([^\s/?#'"<>)]+)[^\s'"<>)]*/gi, (_, scheme, host) => `${scheme}://${host.replace(/^[^@]*@/, '')}/…`);

export function exitReason({ out = '', err = '' } = {}, max = 240) {
  const lines = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const e = lines(err);
  let pick = [];
  const at = e.findLastIndex((l) => /^Error:/.test(l) || /panicked at/.test(l));
  if (at >= 0) {
    pick = e.slice(at).filter((l) => l !== 'Caused by:' && !/^note: run with `RUST_BACKTRACE/.test(l) && !/^Stack backtrace:/.test(l)).slice(0, 6);
  } else {
    pick = (e.length ? e : lines(out)).slice(-3);
  }
  const one = redactUrls(pick.join(' | ')).replace(/\s+/g, ' ');
  return one.length > max ? `${one.slice(0, max - 1)}…` : one || 'no output';
}
