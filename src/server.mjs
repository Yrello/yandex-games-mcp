import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PlaywrightMcpClient } from './playwright-client.mjs';
import { createBrowserLifecycle } from './browser-lifecycle.mjs';
const { toolDefinitions, invokeDomainTool } = await import('./domains.mjs');

const server = new Server({ name: 'yandex-games', version: '0.1.0' }, { capabilities: { tools: {} } });
const playwright = createBrowserLifecycle(() => new PlaywrightMcpClient());
let queue = Promise.resolve();
let shuttingDown = false;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params;
  const run = queue.then(async () => {
    try {
      const browser = name === 'check_media_files' ? null : await playwright.start();
      return await invokeDomainTool(name, args, browser);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, action: name, error: safeError(error) }) }],
      };
    }
  });
  queue = run.catch(() => {});
  return run;
});

function safeError(error) {
  const message = String(error?.message ?? 'операция не выполнена');
  return message.includes('браузерная сессия') ? 'браузерная сессия недоступна' : 'операция не выполнена';
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await queue;
  await playwright.close();
  try { await server.close(); } catch { /* transport can already be closed */ }
}

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
process.once('beforeExit', () => void shutdown());

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
} catch {
  await shutdown();
  process.exitCode = 1;
}
