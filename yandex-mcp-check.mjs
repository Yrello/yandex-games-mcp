import path from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createInterface } from 'node:readline';
import { profilePath, outputPath } from './src/runtime-paths.mjs';

const require = createRequire(import.meta.url);
const cliPath = path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cliPath, '--browser', 'chrome', '--headless',
    '--user-data-dir', profilePath, '--output-dir', outputPath, '--no-webmcp'],
  stderr: 'pipe',
});
const client = new Client({ name: 'codex-yandex-connection-check', version: '1.0.0' });
await client.connect(transport);
const tools = await client.listTools();
console.log(JSON.stringify({ server: client.getServerVersion(), tools: tools.tools.map(t => t.name) }));
const show = result => {
  for (const item of result.content ?? []) if (item.type === 'text') console.log(item.text);
  if (result.isError) console.log('MCP_TOOL_ERROR');
};
const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://games.yandex.ru/console/' } });
if (process.argv.includes('--once')) {
  const snapshot = navigation.isError ? navigation : await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const text = (snapshot.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  const authenticated = text.includes('Добавить игру');
  console.log(JSON.stringify({ authenticated, profilePath }));
  await client.close();
  process.exit(authenticated ? 0 : 1);
}
show(navigation);
console.log('READY: snapshot | tabs | close');
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  try {
    if (line.trim() === 'close') {
      await client.close();
      input.close();
      break;
    }
    if (line.trim() === 'snapshot') show(await client.callTool({ name: 'browser_snapshot', arguments: {} }));
    if (line.trim() === 'tabs') show(await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }));
  } catch (error) {
    console.log('CHECK_ERROR', error.message);
  }
}
