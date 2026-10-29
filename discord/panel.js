// A stable custom_id lets the API handle this button across worker restarts.
export const DISCORD_VERIFY_BUTTON_ID = 'tacit:verify:v1';

export function verificationPanel() {
  return {
    content: '**Get the TAC holder role**\n\nHold at least 100 TAC in your wallet or in the public TAC/ETH Precision farm. Click Verify to receive your own private verification link.\n\nYour wallet only signs a message. No transaction or approval is needed.',
    allowed_mentions: { parse: [] },
    components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Verify', custom_id: DISCORD_VERIFY_BUTTON_ID }] }],
  };
}

// Save the returned message ID to update the same panel on subsequent runs.
export async function publishVerificationPanel({ token, channelId, messageId, request = fetch }) {
  if (!token) throw new Error('Missing DISCORD_TOKEN');
  for (const [name, value] of [['DISCORD_VERIFY_CHANNEL_ID', channelId], ['DISCORD_VERIFY_MESSAGE_ID', messageId]]) {
    if ((name === 'DISCORD_VERIFY_CHANNEL_ID' || value) && !/^\d{17,20}$/.test(value || '')) throw new Error(`Invalid ${name}`);
  }
  const path = `https://discord.com/api/v10/channels/${channelId}/messages${messageId ? `/${messageId}` : ''}`;
  const res = await request(path, {
    method: messageId ? 'PATCH' : 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(verificationPanel()),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Discord refused the panel (${res.status}): ${data.message || 'unknown error'}`);
  return data;
}
