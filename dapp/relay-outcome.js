const WHO = /\b(relay(er|ing)?|keeper|sponsor)\b/i, WHAT = /\b(gas|funds?|balance|spent|top(ped)?[- ]?up|allowance|budget|used today|is off)\b/i;
const selfTalk = (t) => String(t || '').split(/(?<=[.!?])\s+/).some((x) => WHO.test(x) && WHAT.test(x));
export const calmText = (t) => (selfTalk(t) ? 'The relay can’t take this one right now. Send it from your own wallet, or try again later.' : String(t || ''));
export const relayCode = (e) => (typeof e?.code === 'string' ? e.code : '');
export const proveCapped = (e) => relayCode(e) === 'prove_budget' || /\bprove_budget\b|prove capacity for today|as many proofs as it can/i.test(String(e?.message || e || ''));
export const proved = (e) => relayCode(e) === 'open' && !!e?.open?.proof && Array.isArray(e.open.memos);
export const relayRefused = (e) => !proveCapped(e) && relayCode(e) !== 'relay_paused' && relayCode(e) !== 'prove_reserved'
  && (proved(e) || ['relay_held', 'free_budget'].includes(relayCode(e))
    || /fee below the current floor|FEE_MOVED|can.t take this one|free relayed settles|relay (5\d\d|429)\b|temporarily unavailable/i.test(`${relayCode(e)} ${e?.message || e || ''}`));
export const waitRanOut = (e) => /settle timed out|status polling for job/i.test(e?.message || '');
export const jobSaid = (e) => /^(settle|prove) failed:|relay lost the job/i.test(e?.message || '');

export function relayWords(e) {
  const m = String(e?.message || e || ''), code = relayCode(e);
  if (proveCapped(e)) return { text: 'Today’s relay proofs are taken. Prove it yourself, or try again after midnight UTC; nothing was spent.', front: false };
  if (code === 'open' || /^settle held: proved/i.test(m)) {
    return { text: proved(e) ? 'It is proved and waiting to be sent: it goes through when a relay sends it (follow it in Activity on the front page), or send it yourself from the front page.'
      : 'It is proved and waiting for a relay to send it. It goes through when one does; follow it in Activity on the front page.', front: true };
  }
  if (code === 'relay_paused') return { text: e?.queued ? 'In line. It keeps its place and goes through on its own.' : 'Nothing was spent. Prove it yourself, or try again in a few minutes.', front: false };
  if (code === 'free_budget' || /free relayed settles for today are used up/i.test(m)) return { text: 'Today’s free sends are taken. Send it from your own wallet now, or free again at midnight UTC.', front: true };
  if (code === 'relay_held') return { text: e?.queued ? (e.slow ? 'It is taking longer than usual. It keeps its place in line.' : 'The relay can’t send this one right now. It keeps its place in line.') : 'The relay can’t take this one right now.', front: true };
  if (/fee below the current floor/i.test(m)) return { text: 'The network fee rose while this was being sent. Nothing was spent. Try again in a minute; the fee is worked out again each time.', front: false };
  if (waitRanOut(e)) return { text: 'Still in the relay’s queue. It goes through on its own; follow it in Activity on the front page, and do not send it again.', front: false };
  if (/prove timed out/i.test(m)) return { text: 'The proof is still being made, and this page stopped waiting for it. Try again in a few minutes; nothing was spent.', front: false };
  if (/relay lost the job/i.test(m)) return { text: 'This one needs a check: see Activity on the front page before sending it again.', front: false };
  if (relayRefused(e)) return { text: 'The relay can’t take this one right now.', front: true };
  return null;
}
