// Spot-checks that tauG1 in the trimmed ptau is a single power chain: e(t^i G1, t G2) == e(t^(i+1) G1, G2)
// at random indices beyond the range already byte-matched against the ETag-verified power-19 file.
const { buildBn128 } = require('ffjavascript'); const fs = require('fs');
(async () => {
  const c = await buildBn128(); const f = fs.openSync(process.argv[2], 'r');
  const N = 4718610, S2 = 80, S3 = S2 + N * 64 + 12;
  const rd = (off, n) => { const b = Buffer.alloc(n); fs.readSync(f, b, 0, n, off); return new Uint8Array(b); };
  const g1 = (i) => c.G1.fromRprLEM(rd(S2 + i * 64, 64), 0); const tG2 = c.G2.fromRprLEM(rd(S3 + 128, 128), 0);
  const idx = [1048574, 1048575, N - 2]; for (let k = 0; k < 40; k++) idx.push(1048575 + Math.floor(Math.random() * (N - 1048577)));
  let ok = true; for (const i of idx) ok = (await c.pairingEq(g1(i), tG2, c.G1.neg(g1(i + 1)), c.G2.g)) && ok;
  console.log('pairing chain checks', idx.length, 'all ok', ok); await c.terminate(); process.exit(ok ? 0 : 1);
})();
