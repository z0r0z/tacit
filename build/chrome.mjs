// The header's links and the footer, made once and stamped into every page that wears them (build.mjs calls this and
// `--verify-only` fails when a page differs). The styles are dapp/chrome.css and the one script dapp/chrome.js, which
// only closes the menu; without it the menu still opens and shuts, as a <details>.
//
// A page marks where they go:
//   <!-- chrome:nav:begin -->…<!-- chrome:nav:end -->     the page links, inside the header's .top-r, before the page's own chips
//   <!-- chrome:foot:begin -->…<!-- chrome:foot:end -->   the footer; `label="…"` and `id="…"` on the begin marker name the left-hand text
//   <!-- chrome:head:begin -->…<!-- chrome:head:end -->   the stylesheet and script, last in the head, tokens taken from the files;
//                                                         `inline` on the begin marker writes the stylesheet into the page (no request to wait for)
// What belongs to one page alone (the Secret Sats papers, the pool's addresses on each chain) is the page's own, in a
// `<nav class="sf-x">` above the footer.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// page → which link is the page it is ('' for none); a page not listed here does not wear the chrome
export const CHROME_PAGES = {
  'index.html': '', 'assets/index.html': 'assets', 'rewards/index.html': 'rewards', 'trade/index.html': 'assets', 'teth/index.html': 'assets', 'cbtc/index.html': 'assets',
  'vault/index.html': 'borrow', 'pay/index.html': 'pay', 'pay/eth/index.html': 'pay', 'tasks/index.html': 'tasks',
  'build/index.html': '', 'etch/index.html': 'etch', 'weld/stats/index.html': '', 'relay/index.html': '',
  'splitter/index.html': '', 'sats/index.html': '', 'bridge/index.html': 'bridge',
  'discord/index.html': '', 'face/index.html': 'face', 'fast/index.html': 'bridge', 'prove/index.html': 'prove', 'help/index.html': '', 'docs/chain/index.html': '',
};

// 24×24 line drawings, the lander's tabs' hand; drawn by chrome.css (stroke, round caps) unless a glyph is .fill. The assets glyph is the TAC logo's t in its ring, at the logo's proportions (slanted stem, wide high bar, foot sweeping right). The llama is DefiLlama's mark in one colour
// (its badge, the llama paler, as the logo has it), the GitHub, X and Discord glyphs are theirs
const G = {
  assets: '<circle cx="12" cy="12" r="8.5"/><path d="M8.1 9.3h7.2"/><path d="M13 6.1L10 16.3Q10 17.9 13.3 17.2"/>',
  pay: '<path d="M21 3L10.5 13.5"/><path d="M21 3l-6.5 18-4-7.5L3 9.5z"/>',
  borrow: '<path d="M3 9.5L12 4l9 5.5"/><path d="M5.5 10v8M10 10v8M14 10v8M18.5 10v8"/><path d="M3 20.5h18"/>',
  more: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.7"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.7"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.7"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.7"/>',
  tac: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8-7.5 9.5-4.3-1.5-7.5-4.9-7.5-9.5V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  bridge: '<path d="M3 17h18"/><path d="M5 17v-3a7 7 0 0 1 14 0v3"/><path d="M9 17v-4.5M15 17v-4.5M12 17v-6"/>',
  rewards: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8"/><path d="M7.5 8a2.5 2.5 0 1 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 1 1 0 5"/>',
  etch: '<path d="M4 20l4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16z"/><path d="M13.6 7.4l3 3"/>',
  face: '<path d="M6 20V10a6 6 0 0 1 12 0v10l-2-2-2 2-2-2-2 2-2-2z"/><path d="M9.5 11.5h1M13.5 11.5h1"/>',
  portfolio: '<path d="M3 7h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"/><path d="M16 14h.01"/>',
  tasks: '<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
  build: '<path d="M8 7l-5 5 5 5"/><path d="M16 7l5 5-5 5"/><path d="M14 4l-4 16"/>',
  stats: '<path d="M5 20v-6"/><path d="M12 20V5"/><path d="M19 20v-10"/>',
  prove: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
  paper: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  contract: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/>',
  llama: '<g transform="translate(2.2 1) scale(.34375)"><path d="M17.62 51.872 17.21 64H5.786a5.8 5.8 0 0 1-4.09-1.691A5.77 5.77 0 0 1 0 58.23v-2.58a42.7 42.7 0 0 0 17.62-3.78"/><path d="M14.08 20.449a1.46 1.46 0 0 1-.121 1.149 1.46 1.46 0 0 1-.938.677 1.43 1.43 0 0 1-1.137-.234l-3.618-2.605a.973.973 0 0 1 .976-1.675l4.067 1.821a1.43 1.43 0 0 1 .772.867m0 23.74a1.42 1.42 0 0 1-.776.861l-4.067 1.826a.98.98 0 0 1-1.267-.39.97.97 0 0 1 .29-1.29l3.619-2.6a1.434 1.434 0 0 1 1.997.322c.029.039.053.083.078.122a1.46 1.46 0 0 1 .122 1.149M6.752 33.72 5.2 33.19a1.19 1.19 0 0 1-.804-1.12 1.18 1.18 0 0 1 .804-1.12l1.552-.531a1.75 1.75 0 0 1 1.892.49 1.742 1.742 0 0 1-.769 2.81 1.77 1.77 0 0 1-1.123 0M24.763 0H15.79a15.73 15.73 0 0 1-4.625 11.134A15.82 15.82 0 0 1 0 15.75v39.9a42.7 42.7 0 0 0 17.62-3.779l.698-20.623c-1.235-.609-2.118-2.226-2.118-4.114 0-2.128 1.113-3.896 2.582-4.295.2-1.28.655-2.509 1.338-3.612a2.13 2.13 0 0 1-1.567-1.013c-1.328-1.947-3.12-3.944-4.492-7.172a1.71 1.71 0 0 1 .186-1.728.855.855 0 0 1 1.303-.063c2.124 2.006 4.677 2.604 6.089 4.528q.155-.36.405-.663a2.96 2.96 0 0 1 3.496-.915 3 3 0 0 1 1.089-1.559 3.028 3.028 0 0 1 4.706 1.56 2.8 2.8 0 0 1 2.03-.098A42.2 42.2 0 0 1 39.372 3.5 32 32 0 0 0 24.763 0"/><path d="m51.668 33.185-1.557.53a1.75 1.75 0 0 1-2.197-1.097 1.74 1.74 0 0 1 1.074-2.204 1.77 1.77 0 0 1 1.123 0l1.557.531a1.19 1.19 0 0 1 .804 1.12 1.18 1.18 0 0 1-.804 1.12m-3.286 13.282a.976.976 0 0 1-1.245.404l-4.067-1.826a1.42 1.42 0 0 1-.722-1.87l.073-.14a1.42 1.42 0 0 1 1.425-.704c.186.025.366.087.528.182l.122.078 3.618 2.6a.973.973 0 0 1 .273 1.276m-6.093-26.019a1.43 1.43 0 0 1 .776-.862l4.067-1.82a.98.98 0 0 1 1.247.397.97.97 0 0 1-.27 1.277l-3.618 2.605a1.44 1.44 0 0 1-2.002-.336l-.068-.107a1.43 1.43 0 0 1-.132-1.154m-.161-15.356A32 32 0 0 0 39.37 3.5a42.2 42.2 0 0 0-6.006 8.603 3.05 3.05 0 0 1 1.465 1.013q.244.305.405.662c1.323-1.806 3.652-2.215 5.693-4.153a1.198 1.198 0 0 1 1.816.112 1.17 1.17 0 0 1 .142 1.217l-.059.136c-1.367 3.165-3.149 5.18-4.467 7.123a2.14 2.14 0 0 1-1.592 1.013 9.6 9.6 0 0 1 1.314 3.613c1.323.36 2.353 1.82 2.548 3.66q.036.316.034.634c0 1.777-.78 3.315-1.909 3.992a1.3 1.3 0 0 1-.21.122v.307l.977 28.852A32.05 32.05 0 0 0 52.163 48.62a31.93 31.93 0 0 0 4.666-16.618 31.9 31.9 0 0 0-3.906-15.325 32 32 0 0 0-10.79-11.585"/><path d="M15.79 0a15.73 15.73 0 0 1-4.626 11.134A15.82 15.82 0 0 1 0 15.75V5.77A5.77 5.77 0 0 1 1.696 1.69 5.8 5.8 0 0 1 5.786 0z"/><path d="M34.535 30.187a1.91 1.91 0 0 1-.107 2.03c-1.392 2.025-3.34 3.564-5.82 3.564h-.527c-2.144-.185-4.395-1.582-5.786-3.262a1.945 1.945 0 0 1-.18-2.206 5.83 5.83 0 0 0 .834-3.004c0-.993-.244-1.971-.713-2.848a1.9 1.9 0 0 1 .108-2.01q.16.212.366.384a2.856 2.856 0 0 0 3.462.049c0 1.105 1.118 2 2.49 2q.187.015.376 0c1.2-.146 2.118-.973 2.118-1.976a2.86 2.86 0 0 0 3.51-.073l.138-.122a1.94 1.94 0 0 1-.181 1.631 5.8 5.8 0 0 0-.82 2.985 6 6 0 0 0 .732 2.872m8.197-20.463a1 1 0 0 0-.268-.263 1.2 1.2 0 0 0-1.528.151c-2.041 1.947-4.394 2.347-5.693 4.153a3.2 3.2 0 0 0-.405-.662 3.05 3.05 0 0 0-1.465-1.013 2.8 2.8 0 0 0-2.031.098 3 3 0 0 0-1.09-1.56 3.028 3.028 0 0 0-4.705 1.56 2.966 2.966 0 0 0-3.496.915q-.25.302-.405.662c-1.411-1.923-3.965-2.522-6.089-4.528a.85.85 0 0 0-1.206-.063.7.7 0 0 0-.117.126 1.71 1.71 0 0 0-.185 1.729c1.372 3.228 3.163 5.214 4.492 7.171a2.13 2.13 0 0 0 1.586 1.013 9.7 9.7 0 0 0-1.337 3.613c-1.465.399-2.583 2.166-2.583 4.294 0 1.889.883 3.505 2.119 4.114l-.698 20.624L17.218 64h7.547a32 32 0 0 0 14.608-3.5l.171-.093-.971-28.852v-.307q.11-.051.21-.122c1.127-.677 1.909-2.215 1.909-3.992q0-.318-.035-.633c-.195-1.84-1.225-3.301-2.548-3.661a9.5 9.5 0 0 0-1.338-3.613 2.15 2.15 0 0 0 1.592-1.013c1.318-1.947 3.1-3.958 4.467-7.122l.059-.137a1.17 1.17 0 0 0-.142-1.217" fill-opacity="0.3"/><path d="m31.334 27.854-1.626 1.49c-.14.131-.24.3-.288.486-.107.429-.317 1.271-.488 2.07a.49.49 0 0 1-.488.37.49.49 0 0 1-.489-.37l-.517-2.07a.97.97 0 0 0-.288-.487l-1.626-1.49a.486.486 0 0 1 0-.686.49.49 0 0 1 .415-.15l2.441.33h.132l.19-.024 2.251-.307a.49.49 0 0 1 .488.273.485.485 0 0 1-.112.565m2.441-.546a5.8 5.8 0 0 1 .85-2.965 1.94 1.94 0 0 0 .156-1.611l-.112.102a2.86 2.86 0 0 1-3.486.03c0 .992-.908 1.83-2.12 1.966q-.187.015-.375 0c-1.372 0-2.49-.896-2.49-2.001a2.856 2.856 0 0 1-3.486-.03 2.3 2.3 0 0 1-.366-.384 1.9 1.9 0 0 0-.108 2.011 6 6 0 0 1 .713 2.882 5.8 5.8 0 0 1-.81 2.975 1.94 1.94 0 0 0-.255 1.13c.033.395.137.788.388 1.094 1.4 1.68 3.69 3.059 5.833 3.244h.527c2.48 0 4.428-1.539 5.82-3.564a1.91 1.91 0 0 0 .083-2.001 6 6 0 0 1-.732-2.873" fill-rule="evenodd" fill-opacity="0.3"/><path d="m31.337 27.854-1.626 1.49c-.14.131-.24.3-.288.486a64 64 0 0 0-.488 2.07.486.486 0 0 1-.488.37.49.49 0 0 1-.488-.37l-.518-2.07a.97.97 0 0 0-.288-.486l-1.626-1.49a.486.486 0 0 1 0-.687.49.49 0 0 1 .415-.15l2.441.33h.132l.19-.024 2.251-.307a.49.49 0 0 1 .489.273.485.485 0 0 1-.113.565" fill-rule="evenodd"/></g>',
  ethbeat: '<g transform="scale(.03785) translate(0 36.5)"><mask id="eb-cut" maskUnits="userSpaceOnUse" x="0" y="-36.5" width="634" height="634"><path fill="#fff" d="M307.096 560.329C215.105 476.865 24.6334 315.428 2.25121 198.915C-19.4595 86.099 120.653 13.5025 216.336 34.6765C272.292 47.112 272.18 64.9251 307.655 97.5263C315.489 89.572 320.525 79.4892 327.911 71.1988C353.763 42.2947 388.903 18.3199 426.169 7.34079C533.156 -24.0281 640.926 48.2323 633.651 165.081C627.944 255.379 414.183 471.709 414.183 471.709C384.863 499.605 343.019 545.205 307.096 560.329Z"/><path fill="#000" d="M253.41 202.969C236.176 199.72 199.917 216.189 189.062 196.247C180.109 179.667 210.884 175.522 220.061 172.945C256.208 162.75 310.037 143.929 346.184 141.24C381.436 138.439 369.797 166.559 347.415 176.978C337.343 181.683 325.928 183.14 316.192 188.629C310.149 221.342 318.227 266.099 319.905 299.709C321.472 332.086 321 362.08 322.347 394.992C323.866 432.098 335.231 492.294 293.633 492.294C252.034 492.294 259.851 428.828 257.999 399.361C255.984 367.32 257.887 217.757 253.41 202.969Z M148.071 279.359C158.436 280.844 229.014 270.225 224.199 292.285C220.132 310.727 163.131 310.927 148.792 319.134C147.668 335.55 148.759 392.688 154.905 406.118C173.918 410.952 215.29 395.48 229.142 413.866C238.258 425.941 214.156 436.451 205.726 438.475C181.765 444.158 117.892 457.181 96.8035 445.367C79.8402 435.853 81.4586 390.265 80.3631 371.585C77.4223 324.051 64.1845 199.571 77.436 159.116C80.4219 149.913 88.946 141.942 96.9131 136.797C116.893 124.1 177.327 111.89 200.192 117.801C205.963 119.248 215.006 124.039 212.837 131.303C207.438 150.023 161.915 146.042 148.826 157.449C139.314 165.909 142.997 264.765 148.071 279.359Z M502.421 243.903C484.11 247.936 466.595 246.062 449.151 248.415C447.249 215.453 455.642 151.844 448.927 125.516C445.57 112.52 432.812 100.421 418.711 104.118C390.062 111.4 389.055 143.889 386.481 167.752C383.236 197.44 384.131 227.129 383.124 256.705C381.781 291.995 369.023 364.144 382.676 395.4C399.239 433.379 438.296 411.645 442.213 366.048C444.115 342.409 445.796 317.216 447.249 292.443C461.122 288.634 474.258 288.634 502.421 288.634C504.91 317.216 498.859 342.384 502.421 363.359C508.128 396.969 548.536 397.319 557.455 366.048C562.929 351.138 569.231 164.055 566.322 135.823C563.972 112.744 565.762 77.2305 537.673 69.1642C519.095 63.7867 504.883 78.3508 501.078 95.6037C498.341 135.823 507.099 222.797 502.421 243.903Z"/></mask><path mask="url(#eb-cut)" d="M307.096 560.329C215.105 476.865 24.6334 315.428 2.25121 198.915C-19.4595 86.099 120.653 13.5025 216.336 34.6765C272.292 47.112 272.18 64.9251 307.655 97.5263C315.489 89.572 320.525 79.4892 327.911 71.1988C353.763 42.2947 388.903 18.3199 426.169 7.34079C533.156 -24.0281 640.926 48.2323 633.651 165.081C627.944 255.379 414.183 471.709 414.183 471.709C384.863 499.605 343.019 545.205 307.096 560.329Z"/></g>',
  github: '<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>',
  x: '<path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/>',
  discord: '<path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/>',
};
const FILLED = new Set(['github', 'x', 'llama', 'discord', 'ethbeat']);
const svg = (k) => `<svg viewBox="0 0 24 24"${FILLED.has(k) ? ' class="fill"' : ''} aria-hidden="true">${G[k]}</svg>`;

// the places most people come for, always in the header (icons below ~900px, a menu entry on a phone): the assets, what they pay (rewards: farms,
// points, the airdrop) and proving. Shielding, swapping, sending, earning, bridging and borrowing are the front page's tile, which the logo opens.
// The menu holds the rest: the pages of their own for a holder (pay, borrow, the bridge page that follows bridges under way). The footer has the
// network's own (build, stats)
const MAIN = [['assets', '/assets/', 'Assets'], ['rewards', '/rewards/', 'Rewards'], ['prove', '/prove/', 'Prove']];
const MORE = [['portfolio', '/#portfolio', 'Portfolio'], ['pay', '/pay/', 'Pay'], ['borrow', '/vault/', 'Borrow'], ['bridge', '/bridge/', 'Bridges'], ['tac', '/tac/', 'TAC'], ['etch', '/etch/', 'Etch'], ['tasks', '/tasks/', 'Tasks'], ['face', '/face/', 'FACE']];

const here = (key, k) => (key === k ? ' aria-current="page"' : '');

export function navHtml(key) {
  const main = MAIN.map(([k, href, name]) => `<a href="${href}" title="${name}"${here(key, k)}>${svg(k)}<span>${name}</span></a>`).join('\n    ');
  const phone = MAIN.map(([k, href, name]) => `<a class="pr" href="${href}"${here(key, k)}>${svg(k)}${name}</a>`).join('\n      ');
  const more = MORE.map(([k, href, name]) => `<a href="${href}"${here(key, k)}>${svg(k)}${name}</a>`).join('\n      ');
  const inMenu = MORE.some(([k]) => k === key);
  return `<nav class="sn" aria-label="Pages">
    ${main}
    <details class="sm">
      <summary aria-label="More pages" title="More"${inMenu ? ' class="here"' : ''}>${svg('more')}</summary>
      <div class="sm-p">
      ${phone}
      <hr class="pr">
      ${more}
      </div>
    </details>
  </nav>`;
}

// what it is, where it is kept, who is watching it (outward), and the site's own build and stats pages. Icons, each named for a screen reader and a hover.
const OUT = [
  ['paper', 'Whitepaper', '/tacit-v1.pdf'],
  ['build', 'Build', '/build/'],
  ['lock', 'Security', 'https://github.com/src-company/tacit/blob/main/SECURITY.md'],
  ['github', 'Source', 'https://github.com/src-company/tacit'],
  ['contract', 'Pool contract', 'https://etherscan.io/address/0x000000000Ed1eabD231Be41d93b719056F7febFC'],
  ['stats', 'Stats', '/weld/stats/'],
  ['llama', 'DefiLlama', 'https://defillama.com/protocol/tacit'],
  ['ethbeat', 'Listed on ETHBeat', 'https://ethbeat.org/privacy/projects/tacit-pay'],
  ['x', '@tacitfi on X', 'https://x.com/tacitfi'],
  ['discord', 'Tacit Discord community', 'https://discord.gg/VxYx9XSBrM'],
];
export function footHtml(label = 'tacit.finance · mainnet', id = '') {
  const links = OUT.map(([k, name, href]) => `<a href="${href}" title="${name}" aria-label="${name}"${href.startsWith('/') ? '' : ' target="_blank" rel="noopener noreferrer"'}>${svg(k)}</a>`).join('\n    ');
  return `<footer class="sf">
  <span${id ? ` id="${id}"` : ''}>${label}</span>
  <nav aria-label="Elsewhere">
    ${links}
  </nav>
</footer>`;
}

const token = (dapp, file) => createHash('sha256').update(readFileSync(join(dapp, file))).digest('hex').slice(0, 8);
// A stylesheet link is a request the first paint waits for, and it queues behind the page's preloads (fonts, modules).
// `<!-- chrome:head:begin inline -->` puts the styles in the page instead, so the first paint needs the HTML alone.
export const headHtml = (dapp, inline = false) => `${inline ? `<style>\n${readFileSync(join(dapp, 'chrome.css'), 'utf8').trim()}\n</style>` : `<link rel="stylesheet" href="/chrome.css?cb=${token(dapp, 'chrome.css')}">`}\n<script src="/chrome.js?cb=${token(dapp, 'chrome.js')}" defer></script>`;

// a block is the begin marker's line, what is stamped (indented as the marker is) and the end marker's line
const BLOCK = (name) => new RegExp(`^([ \\t]*)(<!-- chrome:${name}:begin([^>]*?)-->)[\\s\\S]*?<!-- chrome:${name}:end -->`, 'm');
const attr = (s, k) => (new RegExp(`${k}="([^"]*)"`).exec(s) || [])[1];
const block = (name, ind, begin, html) => `${ind}${begin}\n${html.replace(/^/gm, ind)}\n${ind}<!-- chrome:${name}:end -->`;

// the page as it should be; throws when a page lacks a marker, so a page cannot quietly go without
export function chromePage(text, rel, dapp) {
  const key = CHROME_PAGES[rel];
  let out = text;
  for (const name of ['nav', 'foot', 'head']) if (!BLOCK(name).test(out)) throw new Error(`${rel} has no chrome:${name} markers`);
  out = out.replace(BLOCK('nav'), (m, ind, begin) => block('nav', ind, begin, navHtml(key)));
  out = out.replace(BLOCK('foot'), (m, ind, begin, params) => block('foot', ind, begin, footHtml(attr(params, 'label'), attr(params, 'id'))));
  out = out.replace(BLOCK('head'), (m, ind, begin, params) => block('head', ind, begin, headHtml(dapp, /\binline\b/.test(params))));
  return out;
}
