import os from 'node:os';
import path from 'node:path';

// Keep authentication outside the checkout, with a separate profile per OS user.
export const dataDir = path.resolve(process.env.YG_MCP_DATA_DIR
  || path.join(os.homedir(), '.codex', 'mcp', 'yandex-games'));
export const profilePath = path.join(dataDir, 'profile');
export const outputPath = path.join(dataDir, 'output');
