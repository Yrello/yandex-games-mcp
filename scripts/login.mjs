import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { profilePath, outputPath } from '../src/runtime-paths.mjs';

const require = createRequire(import.meta.url);
const cliPath = path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');

if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ browser: 'chrome', mode: 'headed', profilePath, outputPath }));
  process.exit(0);
}
if (!process.stdin.isTTY) {
  console.error('Run npm run login in an interactive terminal before connecting the MCP server.');
  process.exit(1);
}

await Promise.all([mkdir(profilePath, { recursive: true }), mkdir(outputPath, { recursive: true })]);
const transport = new StdioClientTransport({ command: process.execPath,
  args: [cliPath, '--browser', 'chrome', '--user-data-dir', profilePath,
    '--output-dir', outputPath, '--no-webmcp'], stderr: 'pipe' });
const client = new Client({ name: 'yandex-games-login', version: '0.1.0' });
const input = createInterface({ input: process.stdin, output: process.stdout });
try {
  await client.connect(transport);
  const opened = await client.callTool({ name: 'browser_navigate',
    arguments: { url: 'https://games.yandex.ru/console/' } });
  if (opened.isError) throw new Error('Could not open the Yandex Games console');
  console.log('Chrome открыт. Войдите в свой аккаунт Яндекса и дождитесь страницы консоли.');
  await input.question('После входа нажмите Enter здесь, чтобы сохранить профиль и закрыть браузер...');
  const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const page = (snapshot.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  if (snapshot.isError || !page.includes('Добавить игру')) {
    throw new Error('Вход в консоль не подтверждён. Запустите npm run login ещё раз.');
  }
  console.log('Вход подтверждён. Профиль сохранён в ' + profilePath);
} catch (error) {
  console.error(error?.message ?? 'Не удалось выполнить вход.');
  process.exitCode = 1;
} finally {
  input.close();
  try { await client.close(); } catch { /* browser may have exited */ }
  try { await transport.close(); } catch { /* transport may already be closed */ }
}
