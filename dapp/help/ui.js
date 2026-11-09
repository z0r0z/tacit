// The help page's logic on a DOM, with the network passed in: a question, an answer with where in the docs it came from, and how many
// community machines are online to answer. Everything the gateway or a model sends is drawn as text, never as markup.
//
//   const ui = mountHelp({ root, ask, health })
//   root       the element holding #f (form), #q (question), #go (button), #out (answer or status), #nodes and #eg (example questions)
//   ask(q)     -> { answer, sources?, unavailable?, guarded?, gated? } for a question; rejects with an Error whose message is shown as it is
//   health()   -> { nodes } the machines online now; a rejection leaves the count out
//   ui.submit(q?)  asks (the textarea's text when q is left out); ui.refresh() re-reads the count

export const MAX_Q = 500;
export const EXAMPLES = ['Has Tacit been audited?', 'Can I get my notes back with just my key?', 'What do I get for holding TAC?'];

export function mountHelp({ root, ask, health, examples = EXAMPLES }) {
  const doc = root.ownerDocument;
  const $ = (s) => root.querySelector(s);
  const form = $('#f'), q = $('#q'), go = $('#go'), out = $('#out'), nodes = $('#nodes'), eg = $('#eg');
  let busy = false;

  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const show = (...kids) => { out.replaceChildren(...kids); };
  const status = (text, bad = false) => show(el('p', `status${bad ? ' err' : ''}`, text));

  function answerView(r) {
    const text = String(r?.answer ?? '').trim();
    if (!text) return status('No answer came back. Try again.', true);
    const kids = [el('p', 'a', text)];
    // the sources and the caution belong to an answer a model wrote from the docs, not to the gateway's own replies
    const fromDocs = Array.isArray(r.sources) && r.sources.length > 0 && !r.unavailable && !r.guarded && !r.gated;
    if (fromDocs) {
      kids.push(el('p', 'src', `From the docs: ${r.sources.map(String).join(' · ')}`));
      kids.push(el('p', 'fine', 'A small open model wrote this from the docs. It can be wrong.'));
    }
    const box = el('div', 'ans'); box.append(...kids); show(box);
  }

  async function refresh() {
    try {
      const h = await health(); const n = Number(h?.nodes);
      if (!Number.isFinite(n)) throw new Error('no count');
      nodes.textContent = n > 0 ? `${n} community ${n === 1 ? 'machine' : 'machines'} online` : 'no community machine online';
      nodes.classList.toggle('warn', n === 0);
    } catch { nodes.textContent = ''; nodes.classList.remove('warn'); }
  }

  async function submit(text = q.value) {
    const question = String(text ?? '').trim().slice(0, MAX_Q);
    if (!question) { q.focus(); return; }
    if (busy) return;
    busy = true; go.disabled = true; out.setAttribute('aria-busy', 'true'); q.value = question;
    status('Asking the community machines…');
    try { answerView(await ask(question)); }
    catch (e) { status(String(e?.message || 'The help desk could not be reached.'), true); }
    finally { busy = false; go.disabled = false; out.removeAttribute('aria-busy'); refresh(); }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });
  for (const text of examples) {
    const b = el('button', '', text); b.type = 'button';
    b.addEventListener('click', () => { q.value = text; submit(text); });
    eg.append(b);
  }
  refresh();
  return { submit, refresh };
}
