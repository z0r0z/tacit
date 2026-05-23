import 'dotenv/config';

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('Missing required env vars: DISCORD_TOKEN, DISCORD_CLIENT_ID');
  process.exit(1);
}

const commands = [{
  name: 'verify',
  description: 'Prove you hold ≥ 1 TAC to access the server',
}];

const res = await fetch(`https://discord.com/api/v10/applications/${DISCORD_CLIENT_ID}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(commands),
});

const data = await res.json();
if (res.ok) console.log('[tacit-gate] slash commands registered:', data.map(c => `/${c.name}`).join(', '));
else console.error('[tacit-gate] registration failed:', data);
