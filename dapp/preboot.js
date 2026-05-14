// Deep-link tab pre-activation. Runs synchronously during head parse
// (the <script src="preboot.js"></script> tag in <head> has no async /
// defer, so the parser blocks here until execution finishes). Goal:
// when a user lands on tacit.finance/#tab=market (or any non-wallet
// tab via deep link), the wallet panel never gets a visible frame
// before the swap.
//
// Lives in its own file (rather than inline) because the dapp's CSP
// is `script-src 'self' 'wasm-unsafe-eval'` — no 'unsafe-inline'.
// CSP3 hash-based whitelisting would also work but pinning a hash
// across edits is brittle, so a same-origin .js file is the simpler
// load-bearing choice. The same logic was previously inline in
// index.html; it was being blocked by CSP and the user reported the
// market page loading without chart / data on first paint as a
// result.
//
// Two-stage swap:
//   1. INSTANT (during head parse, before body parses past the
//      tab-panel divs): inject a <style> rule with !important to
//      hide #tab-wallet and show #tab-<target>. Browser applies
//      new CSS the moment the rule lands, so the wallet panel
//      never gets a visible frame.
//   2. POST-DOM (DOMContentLoaded): flip the .active class on the
//      tab + panel so subsequent JS reading `.tab.active`
//      / `.tab-panel.active` sees the deep-linked tab as the
//      source of truth. Then remove the stage-1 override style so
//      future tab clicks aren't visually clamped by !important.
// Filter the "Cannot redefine property: ethereum" noise that fires when
// two wallet browser extensions (MetaMask + Phantom, Phantom + Coinbase
// Wallet, etc.) both try to define window.ethereum and the second one
// fails because the first set it as non-configurable. The throw happens
// inside the extension's inpage.js — not our code, not something we can
// fix at the source. tacit doesn't read window.ethereum so the failure
// is functionally harmless, but the red Uncaught TypeError row in
// devtools makes users think the dapp is broken. Suppress just this
// specific filename pattern so we don't accidentally swallow real
// errors from other scripts. Registered up here (top of preboot,
// before preActivateTabFromHash even runs) so it's installed before
// most extensions inject their inpage.js — extensions vary on inject
// timing, this is best-effort.
(function silenceExtensionEthereumCollision() {
  try {
    window.addEventListener('error', function (e) {
      if (!e || typeof e.filename !== 'string') return;
      if (!/inpage\.js(\?|$|:)/.test(e.filename)) return;
      var msg = (e.error && e.error.message) || e.message || '';
      if (!/Cannot redefine property: ethereum/.test(msg)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  } catch (_) { /* never break boot */ }
})();

(function preActivateTabFromHash() {
  try {
    var m = (window.location.hash || '').match(/[#&]tab=([a-z]+)/i);
    var target = m && m[1] && m[1].toLowerCase();
    if (!target || target === 'wallet') return;
    window._tacitDeeplinkTab = target;
    var styleEl = document.createElement('style');
    styleEl.id = '_tacit-preactivate-style';
    styleEl.textContent =
      '#tab-wallet{display:none!important;animation:none!important}' +
      '#tab-' + target + '{display:block!important}';
    document.head.appendChild(styleEl);
    document.addEventListener('DOMContentLoaded', function () {
      var prevTab = document.querySelector('.tab.active');
      var prevPanel = document.querySelector('.tab-panel.active');
      var nextTab = document.querySelector('.tab[data-tab="' + target + '"]');
      var nextPanel = document.getElementById('tab-' + target);
      if (!nextTab || !nextPanel) return;
      if (prevTab) prevTab.classList.remove('active');
      if (prevPanel) prevPanel.classList.remove('active');
      nextTab.classList.add('active');
      nextPanel.classList.add('active');
      var pre = document.getElementById('_tacit-preactivate-style');
      if (pre && pre.parentNode) pre.parentNode.removeChild(pre);
    });
  } catch (e) { /* never break boot on a hash parse */ }
})();
