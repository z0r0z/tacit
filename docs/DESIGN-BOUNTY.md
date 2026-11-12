# Design bounty: a new skin for the Tacit dapp

[tacit.finance](https://tacit.finance) works and is live. This bounty is for a fresh look: layout, type, colour and motion on the
parts people use most. You change how the dapp is drawn. The code that holds keys, builds ops, proves and settles stays as it is.
The entry we merge ships at tacit.finance.

| | |
|---|---|
| **Reward** | **1,700 TAC**, to the Ethereum address you name in your pull request, once the entry is merged. One entry is merged and takes it in full. |
| **Closes** | 2026-12-10 |
| **Enter by** | a pull request to [`z0r0z/tacit`](https://github.com/z0r0z/tacit) titled `design bounty: <your name>` |
| **Questions** | an issue on the same repo titled `design bounty: question`, so every entrant sees the answer |

## 1. What there is

The front page, `dapp/index.html`, is the app: one file of about 21,000 lines holding the stylesheet (colour, type and spacing are
custom properties at the top: `--paper`, `--card`, `--ink`, `--orange`, `--mono`, `--serif`, with the dark set under
`prefers-color-scheme`), the markup, and one inline module that draws every card and sheet. Today it is warm paper, Instrument
Serif, IBM Plex Mono and an orange accent. Keep any of it or none of it.

The header, menu and footer come from `build/chrome.mjs` and `dapp/chrome.css` and are stamped into every page by `npm run build`,
so one change there reaches them all. The wallet sheet's look for the sub-pages is `dapp/trade/sheet.js`.

## 2. Scope

**Required**, on the front page `/`:

- **The card** (`#hx`) in every mode: Shield, Swap, Send, Earn, and More → Bridge and Borrow.
- **The wallet sheet** and sign-in: an Ethereum wallet, a Bitcoin wallet, a passkey, a saved key, a pasted key, a new wallet.
- **The header, menu and footer.**
- For each of those: loading, signed out, signed in, in flight, refused in the wallet, and error. Light and dark, 320 px to 1440 px.

**Welcome, not required:** the rest of the front page, the other sheets, holdings (`#dash`, `/assets/`), and the sub-pages (`/pay/`,
`/vault/`, `/bridge/`, `/rewards/`, `/tac/`, `/swap/`). A page you leave alone must still sit beside your header and footer
without breaking.

**Out of scope:** `classic.html`, `/admin/`, the papers, the contracts, and the relay, worker and server code.

## 3. What must keep working

Change how things are drawn, not what they do. A diff that touches an op builder, amount or fee maths, key derivation, recovery, a
relay call or a contract address is outside this bounty; open an issue first if you think one must change. Every action the dapp
offers today works the same after your change, and so do the deep links (`#swap`, `#earn`, `#card=send`, `?from=&to=&amt=`).

Keep these visible, because the user's key is the whole account and the interface adds no trust
([`INTEGRATOR-PLAYBOOK.md`](./INTEGRATOR-PLAYBOOK.md)):

- Addresses, hashes and ids show in full to anyone who looks. Use `addrView` (`dapp/address-view.js`): the middle is collapsed by CSS
  and never cut. Restyle it; do not slice the text.
- Before a button signs or sends, the card shows what it will do: asset, amount, destination, fee.
- Status says what the chain has shown. "Submitted", "in flight" and "confirmed" stay different words.
- Step lists, "what next" rows and ways back stay.
- The logo and token marks (`dapp/brand/`, the page's `#tk-*` icons) stay. Recolour or resize them to fit.

Copy is short and neutral: the fact, then what happens next. No hype or alarm words. Tickers and protocol terms keep their names.

## 4. Rules for the code

- **No new dependency, framework, CDN, analytics or remote font.** The CSP is `default-src 'self'` with a fixed `connect-src`. Do
  not widen it or add `unsafe-eval`. Fonts are open-licensed woff2 in `dapp/fonts/` with the licence file beside them.
- **Plain, readable source.** No minified or generated code, no `eval`, no binaries other than images and fonts.
- **Keep the hooks the checks use.** The front page's check selects by about 500 ids, 150 `data-` attributes and 90 classes.
  Restyle through new classes beside them. If a hook has to move, change it in `tools/weld-check.mjs` in the same PR and say so.
- **Keep the menu and footer entries and their order** (`tools/chrome-check.mjs` asserts them) unless you change the check too.
- **Accessibility:** readable contrast, a visible focus ring, keyboard use of the card and sheet, `prefers-reduced-motion` honoured.
- **Licence:** your work is MIT, like the repo. List any font, icon or image you add with its licence. Use any tools you like; the
  result is yours to answer for.

## 5. Try it

```bash
git clone https://github.com/z0r0z/tacit && cd tacit
(cd build && npm install) && npm install     # build and test tooling
PORT=8787 npm run serve                      # dapp/ at http://localhost:8787
npm run build                                # after edits: cache tokens, header and footer on every page, the page's CSP hash
npm run build:verify                         # must print no drift
```

Start from the head of `main` and rebase once before you submit: `dapp/index.html` is edited most days. To see how the checks load
the page with outside services stubbed, read `tests/front-boot.mjs` and `tools/chrome-check.mjs`. You need no funds.

## 6. Checks

Run these before you submit (`npx playwright-core install chromium` once). They need no fork:

```bash
PLAYWRIGHT=$PWD/node_modules/playwright-core node tools/chrome-check.mjs        # menu and footer at 1280, 390, 360 and 320 px
PLAYWRIGHT=$PWD/node_modules/playwright-core node tests/front-boot.mjs          # the card never stays a skeleton
PLAYWRIGHT=$PWD/node_modules/playwright-core node tests/front-tile-height.mjs   # the card holds its height from first paint*
node tests/front-head.mjs                                                       # the head holds nothing back
```

\* The page holds the card's height while its skeleton shows, so nothing below it moves when the card is drawn (`.hx:has(#hx-body >
.hx-sk)` in `dapp/index.html`). A new card height needs new skeleton heights at each width; the check measures them and says which.

We also run `tools/weld-check.mjs`, the front page's full check against a mainnet fork, before any merge. Failures come back to you
as selectors and steps. Every entry is read in full first: each touched file and each new asset. An entry that adds a dependency,
changes `package-lock.json`, loads a remote resource or touches the code in section 3 is sent back until that is removed.

## 7. Submitting and judging

One pull request from your fork, with a few screenshots (phone and desktop, light and dark), a line on anything you moved or added
(hooks, fonts, images, with licences), and the Ethereum address for the reward. Small commits are easier to merge than one big one:
tokens and shared chrome first, then the card, then the sheet.

We pick the entry that looks best and works: a clear visual system, flows that are easier on a phone, nothing broken, and a diff we
can read and merge. An entry that breaks the rules in sections 3 and 4 is not merged, however it looks.
