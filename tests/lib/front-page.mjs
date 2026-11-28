// The front page (and its /tac/ and /spx/ copies) as one text: the HTML with /front/main.js put back where its <script> tag stands, the way the
// page's code read when it was inline. Tests that cut functions out of the page, or match its code, read it through this.
import { readFileSync } from 'node:fs';

const MAIN = new URL('../../dapp/front/main.js', import.meta.url);
const TAG = /<script type="module" src="\/front\/main\.js(?:\?cb=[0-9a-f]+)?"><\/script>/;

export function frontPage(path) {
  const html = readFileSync(path, 'utf8');
  if (!TAG.test(html)) return html;
  const main = readFileSync(MAIN, 'utf8');
  return html.replace(TAG, () => `<script type="module">\n${main}</script>`);
}
