import 'dotenv/config';
import { publishVerificationPanel } from './panel.js';

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_VERIFY_CHANNEL_ID,
  DISCORD_VERIFY_MESSAGE_ID,
} = process.env;

if (process.argv[2] === 'panel') {
  try {
    const panel = await publishVerificationPanel({ token: DISCORD_TOKEN, channelId: DISCORD_VERIFY_CHANNEL_ID, messageId: DISCORD_VERIFY_MESSAGE_ID });
    console.log(`[tacit-gate] verification panel message ${panel.id} in channel ${panel.channel_id}`);
    console.log(`[tacit-gate] Save DISCORD_VERIFY_MESSAGE_ID=${panel.id} in .env to update this panel next time.`);
  } catch (e) {
    console.error(`[tacit-gate] ${e.message}`);
    process.exitCode = 1;
  }
} else if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('Missing required env vars: DISCORD_TOKEN, DISCORD_CLIENT_ID');
  process.exit(1);
} else {
  const commands = [{
    name: 'verify',
    description: 'Prove you hold at least 100 TAC in your wallet or Precision farm',
  }];
  const res = await fetch(`https://discord.com/api/v10/applications/${DISCORD_CLIENT_ID}/commands`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  const data = await res.json();
  if (res.ok) console.log('[tacit-gate] slash commands registered:', data.map(c => `/${c.name}`).join(', '));
  else { console.error('[tacit-gate] registration failed:', data); process.exitCode = 1; }
}
