import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('src/server.mjs')],
  stderr: 'pipe',
});
const client = new Client({ name: 'yandex-games-smoke', version: '0.1.0' });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), [
    'inspect_console', 'list_games', 'get_draft', 'inspect_draft_form', 'get_draft_localizations', 'add_draft_localization', 'check_draft', 'check_media_files', 'get_moderation_feedback',
    'update_fields', 'update_localized_fields', 'upload_draft_media', 'upload_draft_screenshot', 'update_draft_classification', 'update_draft_age_rating',
    'inspect_leaderboard_form', 'list_leaderboards', 'get_leaderboard', 'create_leaderboard', 'update_leaderboard', 'delete_leaderboard', 'upload_build',
  ]);
  process.stdout.write(`MCP tools: ${tools.tools.map(tool => tool.name).join(', ')}\n`);
} finally {
  await client.close();
}
