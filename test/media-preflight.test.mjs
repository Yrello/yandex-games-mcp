import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateMediaPath } from '../src/media-preflight.mjs';

function png(width, height) {
  const crc = data => { let c=0xffffffff; for (const v of data) { c^=v; for(let i=0;i<8;i++) c=(c>>>1)^(c&1?0xedb88320:0); } return (c^0xffffffff)>>>0; };
  const chunk = (type, data) => { const out=Buffer.alloc(12+data.length); out.writeUInt32BE(data.length); out.write(type,4,'ascii'); data.copy(out,8); out.writeUInt32BE(crc(out.subarray(4,8+data.length)),8+data.length); return out; };
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height,4); ihdr[8]=8; ihdr[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',ihdr), chunk('IDAT',Buffer.from([0])), chunk('IEND',Buffer.alloc(0))]);
}

test('validates required PNG dimensions and returns compact metadata', async () => {
  const file = path.join(process.cwd(), 'test-icon-preflight.png');
  await writeFile(file, png(512, 512));
  try { const result=await validateMediaPath('icon', file); assert.deepEqual({ ...result, bytes:undefined }, { kind:'icon', path:'test-icon-preflight.png', width:512, height:512, bytes:undefined }); }
  finally { await rm(file, { force:true }); }
});

test('rejects wrong dimensions, malformed files, traversal, and external symlinks', async () => {
  const file = path.join(process.cwd(), 'test-cover-preflight.png');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'media-preflight-'));
  try {
    await writeFile(file, png(512, 512));
    await assert.rejects(validateMediaPath('cover', file), /800x470/);
    await writeFile(file, Buffer.from('not png'));
    await assert.rejects(validateMediaPath('icon', file), /structurally valid PNG/);
    await assert.rejects(validateMediaPath('icon', path.join(outside, 'missing.png')), /inside the project|does not exist/);
    const outsideFile = path.join(outside, 'x.png'); await writeFile(outsideFile, png(512,512));
    const link = path.join(process.cwd(), 'test-media-link.png');
    try { await symlink(outsideFile, link); await assert.rejects(validateMediaPath('icon', link), /inside the project/); }
    catch (e) { if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e; }
    finally { await rm(link, { force:true }); }
  } finally { await rm(file, { force:true }); await rm(outside, { recursive:true, force:true }); }
});
