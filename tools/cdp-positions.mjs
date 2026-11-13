// Reads the cUSD positions a settle opens and closes out of its publicValues (the keeper's view of the chain: tools/cdp-liquidation-keeper.mjs).
// publicValues is abi.encode(PublicValues), so what is read here must follow the struct in contracts/src/ConfidentialPool.sol (tests/cdp-positions.test.mjs
// decodes a real mainnet open and a real mainnet liquidation to keep it so).

// ── ABI word helpers (read-only PublicValues decode) ──
export const strip = (h) => String(h).replace(/^0x/, '');
export const wordAt = (hex, i) => hex.slice(i * 64, i * 64 + 64);
export const wBig = (w) => BigInt('0x' + w);
export const wHex = (w) => '0x' + w;
export const wAddr = (w) => '0x' + w.slice(24);

// Decode the cdpMints[] + retired position-nullifiers from one settle's publicValues bytes (hex, no 0x).
// PublicValues field order (see ConfidentialPool.sol): cdpMints is field 22, cdpCloses 23, cdpLiquidations 24.
export function decodeSettlePositions(pvHex, cdp) {
  const out = { mints: [], retired: new Set() };
  // publicValues is abi.encode(PublicValues), one dynamic tuple: a leading offset word (0x20) comes first, and every offset below is from the word after it
  if (pvHex.length >= 64 && BigInt('0x' + wordAt(pvHex, 0)) === 32n) pvHex = pvHex.slice(64);
  const arrAt = (fieldIdx) => wBig(wordAt(pvHex, fieldIdx)) * 2n; // byte offset → word offset (÷32 = ×2 nibblewords/... )
  // helper: offset (bytes) from a word value → starting WORD index into pvHex
  const wordIdx = (byteOff) => Number(byteOff) / 32;
  const readNullifiers = (fieldIdx, nfIndexInStruct, structIsDynamic) => {
    const off = Number(wBig(wordAt(pvHex, fieldIdx))) / 32;
    const len = Number(wBig(wordAt(pvHex, off)));
    for (let e = 0; e < len; e++) {
      // dynamic struct array → element offsets relative to (off+1)
      const elemOff = off + 1 + Number(wBig(wordAt(pvHex, off + 1 + e))) / 32;
      out.retired.add(wHex(wordAt(pvHex, elemOff + nfIndexInStruct)));
    }
  };
  try {
    // cdpMints (field 22): dynamic array of dynamic struct.
    const off = Number(wBig(wordAt(pvHex, 22))) / 32;
    const len = Number(wBig(wordAt(pvHex, off)));
    for (let e = 0; e < len; e++) {
      const base = off + 1 + Number(wBig(wordAt(pvHex, off + 1 + e))) / 32; // element start word
      const controller = wAddr(wordAt(pvHex, base + 0));
      const debtValue = wBig(wordAt(pvHex, base + 2));
      const positionLeaf = wHex(wordAt(pvHex, base + 3));
      const rateSnapshot = wHex(wordAt(pvHex, base + 4));
      const legsOff = base + Number(wBig(wordAt(pvHex, base + 5))) / 32; // legs offset relative to element start
      const owner = wHex(wordAt(pvHex, base + 6));
      const nLegs = Number(wBig(wordAt(pvHex, legsOff)));
      const legs = [];
      for (let l = 0; l < nLegs; l++) {
        const a = legsOff + 1 + l * 2;
        legs.push({ asset: wHex(wordAt(pvHex, a)), value: wBig(wordAt(pvHex, a + 1)) });
      }
      if (BigInt(positionLeaf) > 1n) out.mints.push({ controller, owner, debtValue, rateSnapshot, positionLeaf, legs });
    }
    // cdpCloses (23) + cdpLiquidations (24): positionNullifier is struct field index 4.
    readNullifiers(23, 4);
    readNullifiers(24, 4);
  } catch (e) { /* tolerate a partial/odd settle; the position just isn't surfaced this round */ }
  void arrAt; void wordIdx;
  return out;
}
