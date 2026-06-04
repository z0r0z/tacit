// Sats-Connect (Xverse / Leather / OKX provider abstraction), split out of
// the main vendor bundle: most sessions run burner/passkey wallets and never
// connect an external BTC wallet, so the ~233KB doesn't belong on the eager
// critical path. Vendored same-origin for the same TCB reason as the rest of
// the vendor set — any module in the wallet realm could read `wallet.priv`,
// so nothing loads from third-party CDNs. tacit.js lazy-imports the built
// bundle (vendor/tacit-satsconnect.min.js) via ensureSatsConnect() on first
// external-wallet use. The dApp only uses
// `default.request('getAccounts'|'sendTransfer'|'signMessage'|'wallet_getNetwork', …)`
// so tree-shaking trims what it can.
export { default as satsConnect } from 'sats-connect';
