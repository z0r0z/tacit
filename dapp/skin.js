// The app's two skins: Graphite, the default, and Classic, the look the app had before it. The one picked with the switch beside the
// header's menu is kept on this device and put on <html data-skin> here; the stylesheets draw Graphite unless it says "classic", so a page
// that has not run this yet is already in the default. Every page that wears the shared header loads this from its head (build/chrome.mjs
// stamps it), async so it holds nothing up. chrome.js reads the same key if it runs first, and turns the switch.
(() => {
  let skin = 'graphite';
  try { if (localStorage.getItem('tacit-skin') === 'classic') skin = 'classic'; } catch {}
  document.documentElement.dataset.skin = skin;
})();
