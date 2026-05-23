import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_BOT_SECRET,
  TAC_ROLE_ID,
  WORKER_URL = 'https://tacit-pin.rosscampbell9.workers.dev',
  DAPP_URL   = 'https://tacit.finance',
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_BOT_SECRET || !TAC_ROLE_ID) {
  console.error('Missing required env vars: DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_BOT_SECRET, TAC_ROLE_ID');
  process.exit(1);
}

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS  = 10 * 60 * 1_000;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on('ready', () => console.log(`[tacit-gate] logged in as ${client.user.tag}`));

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'verify') return;
  if (!interaction.guild) {
    return interaction.reply({ content: 'This command only works in a server.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  let nonce;
  try {
    const res = await fetch(`${WORKER_URL}/discord/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DISCORD_BOT_SECRET}` },
      body: JSON.stringify({ discord_user_id: interaction.user.id, guild_id: interaction.guild.id }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'nonce creation failed');
    nonce = data.nonce;
  } catch (e) {
    return interaction.editReply(`Could not start verification: ${e.message}`);
  }

  const link = `${DAPP_URL}/#gate=${nonce}`;
  await interaction.editReply(
    `**Verify your TAC holdings**\n\n` +
    `Open this link and follow the prompts:\n${link}\n\n` +
    `This link expires in 10 minutes. Once verified your role is granted automatically.`
  );

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const poll = setInterval(async () => {
    if (Date.now() > deadline) {
      clearInterval(poll);
      try { await interaction.editReply('Verification timed out. Run `/verify` again.'); } catch {}
      return;
    }
    try {
      const res = await fetch(`${WORKER_URL}/discord/status/${nonce}`, {
        headers: { Authorization: `Bearer ${DISCORD_BOT_SECRET}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.status !== 'verified') return;
      clearInterval(poll);
      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(TAC_ROLE_ID);
      await interaction.editReply('Verified! You now have the **TAC Holder** role.');
    } catch {}
  }, POLL_INTERVAL_MS);
});

const commands = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Prove you hold ≥ 1 TAC to access the server'),
];

const rest = new REST().setToken(DISCORD_TOKEN);
await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands.map(c => c.toJSON()) });
console.log('[tacit-gate] slash command registered');
await client.login(DISCORD_TOKEN);
