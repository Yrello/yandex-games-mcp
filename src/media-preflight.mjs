import path from 'node:path';
import { open, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPECS = { icon: { width: 512, height: 512 }, cover: { width: 800, height: 470 } };
const MAX_PREFLIGHT_BYTES = 100 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8, width, height, sawIdat = false, sawIend = false, first = true;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) return null;
    const payload = buffer.subarray(offset + 4, offset + 8 + length);
    if (crc32(payload) !== buffer.readUInt32BE(offset + 8 + length)) return null;
    if (first && (type !== 'IHDR' || length !== 13)) return null;
    if (type === 'IHDR') {
      if (!first) return null;
      width = buffer.readUInt32BE(offset + 8); height = buffer.readUInt32BE(offset + 12);
    } else if (type === 'IDAT') sawIdat = true;
    else if (type === 'IEND') {
      if (length !== 0 || !sawIdat || end !== buffer.length) return null;
      sawIend = true;
    }
    first = false;
    offset = end;
    if (sawIend) break;
  }
  return sawIend ? { width, height } : null;
}

export async function validateMediaPath(kind, filePath) {
  const spec = SPECS[kind];
  if (!spec) throw new Error('Media kind must be icon or cover.');
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('A media file path is required.');
  const target = path.resolve(PROJECT_ROOT, filePath);
  let canonical;
  try { canonical = await realpath(target); }
  catch { throw new Error('Media file does not exist or cannot be resolved.'); }
  const relative = path.relative(PROJECT_ROOT, canonical);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Media file must be inside the project directory.');
  }
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error('Media path must refer to a regular file.');
  if (info.size > MAX_PREFLIGHT_BYTES) throw new Error('Media file exceeds the 100 MiB local preflight limit.');
  const handle = await open(canonical, 'r');
  let data;
  try { data = await handle.readFile(); } finally { await handle.close(); }
  const dimensions = validatePng(data);
  if (!dimensions) throw new Error('Media file is not a structurally valid PNG.');
  const { width, height } = dimensions;
  if (width !== spec.width || height !== spec.height) throw new Error(`${kind} PNG must be ${spec.width}x${spec.height}; found ${width}x${height}.`);
  return { kind, path: relative.split(path.sep).join('/'), width, height, bytes: info.size };
}
