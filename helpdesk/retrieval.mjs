// BM25 retrieval + a confidence gate. Used by the server and by the offline calibration.
const STOP = new Set('a an and are as at be by can do does for from how i if in is it its me my of on or so that the this to was what when which who will with you your we our they them there their about into than then these those'.split(' '));
export const tok = (s) => (s.toLowerCase().match(/[a-z0-9][a-z0-9.]*/g) || []).map((t) => t.replace(/\.+$/, '')).filter((t) => t && !STOP.has(t));

export function buildIndex(chunks) {
  const docs = chunks.map((c) => { const t = tok(c.title + ' ' + c.title + ' ' + c.text); const tf = new Map(); t.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1)); return { len: t.length, tf }; });
  const df = new Map(); docs.forEach((d) => d.tf.forEach((_, w) => df.set(w, (df.get(w) || 0) + 1)));
  const N = docs.length, avg = docs.reduce((a, d) => a + d.len, 0) / N;
  const idf = (w) => Math.log(1 + (N - (df.get(w) || 0) + 0.5) / ((df.get(w) || 0) + 0.5));   // an unseen word gets the largest idf
  function search(q, k = 6) {
    const qt = [...new Set(tok(q))];
    return docs.map((d, i) => { let s = 0;
      for (const w of qt) { const f = d.tf.get(w); if (!f) continue; s += idf(w) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / avg)); }
      return [s, i]; }).sort((a, b) => b[0] - a[0]).slice(0, k).filter((x) => x[0] > 0).map(([score, i]) => ({ score, chunk: chunks[i], i }));
  }
  // coverage = idf-weighted share of the question's words that appear in the retrieved text. Words the corpus has never
  // seen weigh the most, so a question about bread or Solana scores near zero while a Tacit question scores high.
  function assess(q, hits) {
    const qt = [...new Set(tok(q))]; if (!qt.length || !hits.length) return { coverage: 0, top: 0 };
    const seen = new Set(); for (const h of hits) docs[h.i].tf.forEach((_, w) => seen.add(w));
    let have = 0, all = 0; for (const w of qt) { const x = idf(w); all += x; if (seen.has(w)) have += x; }
    return { coverage: have / all, top: hits[0].score };
  }
  return { search, assess, size: N };
}
