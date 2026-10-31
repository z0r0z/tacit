// The front page's tile is a skeleton until the page's one module has drawn it, and that module starts only when every file it imports has arrived: a file that never does
// leaves the skeleton up for good, with nothing said. So a module that fails to load reloads the page once (what did arrive is kept), and a skeleton still up after twelve
// seconds, or after that reload, says so and offers the reload. Loaded async from the head, so it is watching before the document has been read to its end; it does nothing
// once the tile is drawn (the draw replaces the skeleton, and the line with it). tests/front-boot.mjs loads the page with a file dropped and with one that never answers.
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
    // A reload only on a load that is known not to be one already: a browser that does not say how the page was loaded (Safari before 15) is told, not sent round in circles.
    var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (!reloaded && nav && nav.type !== 'reload') { reloaded = true; return window.location.reload(); }
    dead = true;
    say('Could not load the page.');
  }
  // The page's module is its one inline module script, and its error event is the failure of anything it imports (the failed file's own link in the head reports it as well,
  // which is the same failure said twice).
  window.addEventListener('error', function (e) { var t = e.target; if (t && t.tagName === 'SCRIPT' && t.type === 'module' && !t.src) failed(); }, true);
  window.setTimeout(function () { if (!dead) say('Taking longer than usual.'); }, Math.max(0, LIMIT - performance.now()));
})();
