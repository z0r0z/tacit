import { looksLikeSecret } from './guard.mjs';
const must = ['My seed phrase is: abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about. Can you look them up?',
  'legal winner thank year wave sausage worth useful legal winner thank yellow', '0x' + 'ab'.repeat(32),
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong please help me recover it',
  'lagel renniw knaht raey evaw egasuas htrow lufesu lagel renniw knaht wolley',
  'my key is ' + 'ab12'.repeat(8) + ' ' + 'cd34'.repeat(8) + ' can you check it', 'key: ' + '0f1e2d3c'.repeat(4) + '-' + '4b5a6978'.repeat(4)];
const mustNot = ["How does the fast bridge stop either side from stealing the other side's funds?", 'How does the fast bridge stop either side from stealing the other side funds on the way',
  'What happens in a fast bridge swap if the liquidity provider disappears halfway through the swap and never comes back',
  'Can I run the community runner on Node 20 and still use the Nostr board without any extra flags or a newer version',
  'I lost my device but I still have my private key can I get my notes back on a new phone or a fresh browser please',
  'I sent from 0x' + 'ab'.repeat(20) + ' to 0x' + 'cd'.repeat(20) + ' and it has not arrived', 'my note id is deadbeef and the batch is 12345678'];
let bad = 0; for (const t of must) if (!looksLikeSecret(t)) { bad++; console.log('MISSED  ', t.slice(0, 70)); }
for (const t of mustNot) if (looksLikeSecret(t)) { bad++; console.log('FALSE+  ', t.slice(0, 70)); }
console.log(bad ? `${bad} guard test(s) failed` : `guard: ${must.length} secrets caught, ${mustNot.length} normal questions passed`);
process.exit(bad ? 1 : 0);
