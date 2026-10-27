import path from 'node:path';
import { open, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parsePng(data) {
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8, width, height, sawIdat = false, sawIend = false, first = true;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    if (length > data.length - offset - 12) return null;
    const type = data.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (crc32(data.subarray(offset + 4, offset + 8 + length)) !== data.readUInt32BE(offset + 8 + length)) return null;
    if (first && (type !== 'IHDR' || length !== 13)) return null;
    if (type === 'IHDR') {
      if (!first) return null;
      width = data.readUInt32BE(offset + 8); height = data.readUInt32BE(offset + 12);
    } else if (type === 'IDAT') sawIdat = true;
    else if (type === 'IEND') {
      if (length !== 0 || !sawIdat || end !== data.length) return null;
      sawIend = true;
    }
    first = false;
    offset = end;
    if (sawIend) break;
  }
  return sawIend ? { width, height } : null;
}

function parseJpeg(data) {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  if (data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) return null;
  let offset = 2;
  let dimensions = null;
  while (offset < data.length) {
    if (data[offset] !== 0xff) return null;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) return null;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) return null;
      dimensions = { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
    }
    if (marker === 0xda) return dimensions && offset + length < data.length - 2 ? dimensions : null;
    offset += length;
  }
  return null;
}

export async function validateScreenshotPath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('A screenshot file path is required.');
  const target = path.resolve(PROJECT_ROOT, filePath);
  let canonical;
  try { canonical = await realpath(target); }
  catch { throw new Error('Screenshot file does not exist or cannot be resolved.'); }
  const relative = path.relative(PROJECT_ROOT, canonical);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Screenshot file must be inside the project directory.');
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error('Screenshot path must refer to a regular file.');
  if (info.size > MAX_BYTES) throw new Error('Screenshot exceeds the 100 MiB local preflight limit.');
  const extension = path.extname(canonical).toLowerCase();
  if (extension !== '.png' && extension !== '.jpg' && extension !== '.jpeg') throw new Error('Screenshot must use a .png, .jpg, or .jpeg extension.');
  const handle = await open(canonical, 'r');
  let data;
  try { data = await handle.readFile(); } finally { await handle.close(); }
  const png = extension === '.png';
  const dimensions = png ? parsePng(data) : parseJpeg(data);
  if (!dimensions) throw new Error(`Screenshot content is not a structurally valid ${png ? 'PNG' : 'JPEG'}.`);
  const { width, height } = dimensions;
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) throw new Error(`Screenshot dimensions must be positive and no larger than ${MAX_DIMENSION}x${MAX_DIMENSION}.`);
  return { kind: 'screenshot', path: relative.split(path.sep).join('/'), width, height, bytes: info.size, mime: png ? 'image/png' : 'image/jpeg' };
}
