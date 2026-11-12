(function () {
  var LIMIT = 12000, reloaded = false, dead = false, box = null, said = null;
  var skeleton = function () { return window.__tacitAway ? null : document.querySelector('#hx-body > .hx-sk'); };
  function say(text) {
    var sk = skeleton();
    if (!sk) return;
    if (!box || !box.isConnected) {
      var again = document.createElement('button');
      again.type = 'button'; again.textContent = 'Reload'; again.onclick = function () { window.location.reload(); };
      box = document.createElement('div'); box.className = 'hx-say'; box.setAttribute('role', 'status');
      said = document.createElement('span');
      box.append(said, again);
      sk.after(box);
    }
    said.textContent = text;
  }
  function failed() {
    if (!skeleton()) return;
    var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (!reloaded && nav && nav.type !== 'reload') { reloaded = true; return window.location.reload(); }
    dead = true;
    say('Could not load the page.');
  }
  window.addEventListener('error', function (e) { var t = e.target; if (t && t.tagName === 'SCRIPT' && t.type === 'module' && !t.src) failed(); }, true);
  window.setTimeout(function () { if (!dead) say('Taking longer than usual.'); }, Math.max(0, LIMIT - performance.now()));
})();
