import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { profilePath, outputPath } from './runtime-paths.mjs';

const require = createRequire(import.meta.url);
const cliPath = path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');

export class PlaywrightMcpClient {
  #client;
  #transport;
  #closed = false;
  #failure;

  async start() {
    if (this.#client) return this;
    await Promise.all([mkdir(profilePath, { recursive: true }), mkdir(outputPath, { recursive: true })]);
    this.#transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, '--browser', 'chrome', '--headless', '--user-data-dir', profilePath,
        '--output-dir', outputPath, '--no-webmcp'],
      stderr: 'pipe',
    });
    this.#client = new Client({ name: 'yandex-games-domain-wrapper', version: '0.1.0' });
    this.#transport.onclose = () => {
      if (!this.#closed) this.#failure = 'браузерная сессия недоступна';
    };
    this.#transport.onerror = () => {
      if (!this.#closed) this.#failure = 'браузерная сессия недоступна';
    };
    try {
      await this.#client.connect(this.#transport);
    } catch {
      this.#failure = 'браузерная сессия недоступна';
      await this.close();
      throw new Error(this.#failure);
    }
    return this;
  }

  async call(toolName, args = {}) {
    if (this.#closed || this.#failure || !this.#client) throw new Error('браузерная сессия недоступна');
    try {
      return await this.#client.callTool({ name: toolName, arguments: args });
    } catch {
      this.#failure = 'браузерная сессия недоступна';
      throw new Error(this.#failure);
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    try { await this.#client?.close(); } catch { /* process may already have exited */ }
    try { await this.#transport?.close(); } catch { /* process may already have exited */ }
  }
}
