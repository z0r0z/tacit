import { looksLikeSecret } from './guard.mjs';
const must = ['My seed phrase is: abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about. Can you look them up?',
  'legal winner thank year wave sausage worth useful legal winner thank yellow', '0x' + 'ab'.repeat(32),
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong please help me recover it'];
const mustNot = ["How does the fast bridge stop either side from stealing the other side's funds?", 'How does the fast bridge stop either side from stealing the other side funds on the way',
  'What happens in a fast bridge swap if the liquidity provider disappears halfway through the swap and never comes back',
  'Can I run the community runner on Node 20 and still use the Nostr board without any extra flags or a newer version',
  'I lost my device but I still have my private key can I get my notes back on a new phone or a fresh browser please'];
let bad = 0; for (const t of must) if (!looksLikeSecret(t)) { bad++; console.log('MISSED  ', t.slice(0, 70)); }
for (const t of mustNot) if (looksLikeSecret(t)) { bad++; console.log('FALSE+  ', t.slice(0, 70)); }
console.log(bad ? `${bad} guard test(s) failed` : `guard: ${must.length} secrets caught, ${mustNot.length} normal questions passed`);
process.exit(bad ? 1 : 0);
