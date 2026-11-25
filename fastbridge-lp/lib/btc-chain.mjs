// The Bitcoin side of the LP on esplora explorers: dapp/fastbridge-btc.js, which the page's side of a swap shares.
export { makeEsploraBtcChain as makeNodeBtcChain } from '../../dapp/fastbridge-btc.js';

// The reflection tracer reports a direct pool exit as a generic non-transfer
// root. Use the provider's existing Bitcoin/pool validator to identify the
// exact confirmed TAC output, without changing the reflection worker.
export function makeTacitLineageReader({ tacit, btc, assetId }) {
  const asset = (s) => String(s).toLowerCase().replace(/^0x/, '');
  async function checkPoolExit({ txid, vout }) {
    const tx = await btc.fetchTx(txid);
    if (!tx) throw new Error('the note transaction could not be read');
    if (tacit.txOutputEnvelope(tx)?.opcode !== 0x6d) return false;
    if (tx.status?.confirmed !== true) throw new Error('the pool exit has not confirmed');
    const note = await btc.resolveNote(txid, vout);
    return !!note && asset(note.assetIdHex) === asset(assetId);
  }
  return (notes, options) => tacit.bridgeUx().lineage(notes, { ...options, checkPoolExit });
}
