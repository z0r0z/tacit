// What a want's price is judged against: what a provider keeps of an amount at its terms, and whether that is within the most a want says its holder
// will pay (`maxFeeBps` on a want: fastbridge-board.js signWant). One judgement for every reader of a want: the fast page that tells the holder, the front
// page's notice, the provider panel that counts what it could take, and the daemon's alert. No imports, so a page, a test and the daemon's image take it
// alike (it is at the top of dapp/ for that: the image copies dapp/*.js).

// What a provider keeps of an amount at its terms ({ feeBps, flatFee }): a rate on the amount, rounded down, and a flat part. The provider's own sum
// (fastbridge-provider.js `price`), so a want's price is judged as the provider's quote will be.
export const feeOf = (terms, amount) => (BigInt(amount) * BigInt(terms.feeBps ?? 0)) / 10000n + BigInt(terms.flatFee ?? 0);

// Whether a provider with these terms meets a want's price: it keeps no more of the amount than the most the want names. A want that names none, or one
// whose price cannot be read, is met by any provider (an unreadable price is no price).
export const meetsPrice = (terms, want) => !Number.isInteger(want.maxFeeBps) || want.maxFeeBps < 0 || feeOf(terms, want.amount) * 10000n <= BigInt(want.amount) * BigInt(want.maxFeeBps);
