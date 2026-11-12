// What a buyer signs to publish an encrypted opening for an output. The page builds it and the API checks it, so both call this one function. It names the
// network, the output and the ciphertext, so a signature is good for that blob at that output and nothing else.
import { sha256, concatBytes, hexToBytes } from './vendor/tacit-deps.min.js';

export function buyerOpeningMsg(network, txidHex, vout, ciphertextHex, declaredPubHex) {
  const txidBE = hexToBytes(txidHex).reverse();
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, vout >>> 0, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-buyer-opening-v1'),
    new TextEncoder().encode(String(network)),
    new Uint8Array([0]),
    txidBE,
    voutLE,
    sha256(hexToBytes(ciphertextHex)),
    hexToBytes(declaredPubHex),
  ));
}
