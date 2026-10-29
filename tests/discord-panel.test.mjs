import assert from 'node:assert/strict';
import test from 'node:test';
import { DISCORD_VERIFY_BUTTON_ID, publishVerificationPanel } from '../discord/panel.js';

const channelId = '123456789012345678', messageId = '223456789012345678';

test('publishes a persistent public panel with no member-specific link', async () => {
  let call;
  const result = await publishVerificationPanel({ token: 'test-token', channelId, request: async (url, init) => {
    call = { url, ...init };
    return Response.json({ id: messageId, channel_id: channelId });
  } });
  assert.equal(result.id, messageId);
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `https://discord.com/api/v10/channels/${channelId}/messages`);
  assert.equal(call.headers.Authorization, 'Bot test-token');
  const body = JSON.parse(call.body);
  assert.equal(body.components[0].components[0].custom_id, DISCORD_VERIFY_BUTTON_ID);
  assert.equal(body.components[0].components[0].style, 1);
  assert.equal(body.flags, undefined);
  assert.doesNotMatch(body.content, /#gate=/);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
});

test('updates the saved panel in place', async () => {
  await publishVerificationPanel({ token: 'test-token', channelId, messageId, request: async (url, init) => {
    assert.equal(init.method, 'PATCH');
    assert.equal(url, `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`);
    return Response.json({ id: messageId });
  } });
});

test('rejects missing credentials and invalid channel or message IDs before sending', async () => {
  const request = () => assert.fail('must not contact Discord');
  await assert.rejects(publishVerificationPanel({ channelId, request }), /Missing DISCORD_TOKEN/);
  await assert.rejects(publishVerificationPanel({ token: 'test-token', request }), /DISCORD_VERIFY_CHANNEL_ID/);
  await assert.rejects(publishVerificationPanel({ token: 'test-token', channelId, messageId: '../other', request }), /DISCORD_VERIFY_MESSAGE_ID/);
});

test('reports a Discord permission failure', async () => {
  await assert.rejects(publishVerificationPanel({ token: 'test-token', channelId, request: async () =>
    Response.json({ message: 'Missing Permissions' }, { status: 403 }),
  }), /Discord refused the panel \(403\): Missing Permissions/);
});
