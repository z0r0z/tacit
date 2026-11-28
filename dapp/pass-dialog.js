// The passphrase prompt of tacit.js, for a page that loads tacit.js as a library. tacit.js asks for a passphrase by
// styling #pass-modal; this puts that markup in a modal dialog, so the prompt stacks above any open sheet and takes
// typing. A page calls mountPassDialog() before the first thing that can unlock a saved key.
const MARKUP = `<dialog class="sheet layer" id="pass-dialog" aria-labelledby="pass-title">
  <div id="pass-modal" style="display:none">
    <form id="pass-form" class="sheet-in">
      <div class="sheet-head"><h2 id="pass-title">Unlock</h2></div>
      <p class="note" id="pass-reason"></p>
      <label class="lbl" id="pass-label-1" for="pass-input-1">passphrase</label>
      <div class="amt text"><input type="password" id="pass-input-1" autocomplete="new-password"></div>
      <div class="pass-hint" id="pass-hint-1" aria-live="polite"></div>
      <div id="pass-field-2"><label class="lbl" for="pass-input-2">repeat</label><div class="amt text"><input type="password" id="pass-input-2" autocomplete="new-password"></div><div class="pass-hint" id="pass-hint-2" aria-live="polite"></div></div>
      <p class="note" id="pass-warn">There is no reset. Forget it and only your key backup gets you back in.</p>
      <div class="row2"><button class="btn ghost" id="pass-cancel" type="button">Cancel</button><button class="btn" id="pass-submit" type="submit">Continue</button></div>
    </form>
  </div>
</dialog>`;

export function mountPassDialog() {
  if (document.getElementById('pass-dialog')) return;
  document.body.insertAdjacentHTML('beforeend', MARKUP);
  const dialog = document.getElementById('pass-dialog'), modal = document.getElementById('pass-modal');
  new MutationObserver(() => {
    const on = modal.style.display && modal.style.display !== 'none';
    if (on && !dialog.open) dialog.showModal(); else if (!on && dialog.open) dialog.close();
  }).observe(modal, { attributes: true, attributeFilter: ['style'] });
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); document.getElementById('pass-cancel').click(); });
}
