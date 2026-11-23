// The vaults' addresses on Ethereum mainnet: { key: 'usd' | 'eth', vault: '0x…' } for the dollar vault and the ETH vault. Everything else
// (the two tokens, the terms, the prices) is read from the vault itself. Empty until they are deployed: the page then says it opens soon.
// `hint`: the vault's TAC, its synth, its oracle and its price feed as they were when this was written. The page asks the vault for these on every
// reading and uses the hint only to send the reads that follow them in the same request; a vault that answers otherwise (the owner swapped the oracle or the
// feed) is read again from its own answers, so a hint that has gone out of date costs one more request and nothing else.
// `router`: the TacVaultRouter built for these two vaults, once deployed (empty until then: the page does without it).
// `proofUrls`: where provers post their newest proof for a TacProvenOracle (tac-oracle-host's proof.json), asked in order when a vault's oracle is one and
// its prices need a newer proof.
export const DEPLOYMENTS = Object.freeze({
  chainId: 1,
  router: '0x000000F9ab49650502BeC910D13b4717F0082598',
  proofUrls: Object.freeze([]),
  // The markets where a vault's token sells: Precision pools that anyone can open (dapp/vault/pools.js). `factory`: the Precision pool factory. `quotes`: what a token sells for.
  // `markets`: the ones worth opening, in the order the page lists them (the first is the one it opens on). Each is `{ vault, quote, tier, fee, low, high }`: the token of that
  // vault against the asset it tracks; `fee` in pips (500 = 0.05%); `low` and `high` the ends of the price band it trades in (a swap that would leave it is refused), as multiples
  // of its peg, in tokens of the vault per unit of the quote. Two tiers for each token, and no more: a tight band around the peg, which gives the best price in ordinary times (a
  // $200 pool sells 25 of its tokens at 1.3% slippage in a ±10% band and 19.5% in a full-range one, measured against the pool itself), and a wide one that still trades if the peg
  // breaks. A market is its tuple: the pool's address follows from the tokens, the band and the fee, so changing one here points the page at another pool (a pool the factory
  // already holds for the token is listed either way).
  pools: Object.freeze({
    factory: '0x000000Eb27B557aB426d9E99cFd54EC455799e81',
    // The points service, whose /lp says what the liquidity campaign pays for opening each of these pools and for holding liquidity in it (nothing is shown when it says nothing).
    campaign: 'https://tacit-points.onrender.com',
    quotes: Object.freeze({
      USDC: Object.freeze({ addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', dec: 6 }),
      ETH: Object.freeze({ addr: null, dec: 18 }),
    }),
    markets: Object.freeze([
      Object.freeze({ vault: 'usd', quote: 'USDC', tier: 'Peg', fee: 500, low: '9/10', high: '10/9' }),
      Object.freeze({ vault: 'usd', quote: 'USDC', tier: 'Backstop', fee: 3000, low: '1/2', high: '2' }),
      Object.freeze({ vault: 'eth', quote: 'ETH', tier: 'Peg', fee: 500, low: '9/10', high: '10/9' }),
      Object.freeze({ vault: 'eth', quote: 'ETH', tier: 'Backstop', fee: 3000, low: '1/2', high: '2' }),
    ]),
  }),
  vaults: Object.freeze([
    Object.freeze({ key: 'usd', vault: '0x00000087ac9ed3E1Bd443E00FBe18B4EdcAEeb1F', hint: Object.freeze({ tac: '0xA1313EB9F3A445606D9583BCAC3EBEB56A858279', synth: '0xA0f6B02561C8ef08335B69aD25e022C0B342147C', oracle: '0x000000cE58D7d49319252DaFB0ABdB3F02101271', feed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' }) }),
    Object.freeze({ key: 'eth', vault: '0x00000047bFC8cF504967049D9Cf9E1FD9651ED80', hint: Object.freeze({ tac: '0xA1313EB9F3A445606D9583BCAC3EBEB56A858279', synth: '0x9DE27883C5Dc9Db47BE12E595D59b8f1aBEC8570', oracle: '0x000000cE58D7d49319252DaFB0ABdB3F02101271', feed: '0x0000005891f244187A4F00Ab6Ca25BbCd5B742Ef' }) }),
  ]),
});
