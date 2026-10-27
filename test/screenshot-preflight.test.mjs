import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { validateScreenshotPath } from '../src/screenshot-preflight.mjs';

function png(width, height) {
  const crc = data => { let c=0xffffffff; for (const v of data) { c^=v; for(let i=0;i<8;i++) c=(c>>>1)^(c&1?0xedb88320:0); } return (c^0xffffffff)>>>0; };
  const chunk = (type, data) => { const out=Buffer.alloc(12+data.length); out.writeUInt32BE(data.length); out.write(type,4,'ascii'); data.copy(out,8); out.writeUInt32BE(crc(out.subarray(4,8+data.length)),8+data.length); return out; };
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height,4); ihdr[8]=8; ihdr[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',ihdr), chunk('IDAT',Buffer.from([0])), chunk('IEND',Buffer.alloc(0))]);
}

function jpeg(width, height) {
  const sof = Buffer.alloc(17); sof.set([0xff,0xc0,0,15,8]); sof.writeUInt16BE(height,5); sof.writeUInt16BE(width,7); sof[9]=3;
  return Buffer.concat([Buffer.from([0xff,0xd8]), sof, Buffer.from([0xff,0xda,0,2,0,0xff,0xd9])]);
}

test('accepts PNG and JPEG content and reports dimensions and MIME', async () => {
  const dir = await mkdtemp(path.join(process.cwd(), '.screenshot-preflight-'));
  try {
    const p = path.join(dir, 'screen.png'), j = path.join(dir, 'screen.jpg');
    await writeFile(p, png(1280, 720)); await writeFile(j, jpeg(720, 1280));
    const pngResult = await validateScreenshotPath(p);
    assert.deepEqual(pngResult, { kind:'screenshot', path:`${path.basename(dir)}/screen.png`, width:1280, height:720, bytes:(await stat(p)).size, mime:'image/png' });
    const result = await validateScreenshotPath(j);
    assert.equal(result.mime, 'image/jpeg'); assert.equal(result.width, 720); assert.equal(result.height, 1280);
  } finally { await rm(dir, { recursive:true, force:true }); }
});

test('rejects traversal, external symlinks, mismatched extensions, bad signatures, and oversized dimensions', async () => {
  const dir = await mkdtemp(path.join(process.cwd(), '.screenshot-preflight-'));
  try {
    const bad = path.join(dir, 'bad.png'); await writeFile(bad, Buffer.from('not an image'));
    await assert.rejects(validateScreenshotPath('../outside.png'), /inside the project|does not exist/);
    await assert.rejects(validateScreenshotPath(bad), /structurally valid PNG/);
    const mismatch = path.join(dir, 'mismatch.jpg'); await writeFile(mismatch, png(10,10));
    await assert.rejects(validateScreenshotPath(mismatch), /structurally valid JPEG/);
    const truncated = path.join(dir, 'truncated.jpg'); await writeFile(truncated, jpeg(1280,720).subarray(0, 20));
    await assert.rejects(validateScreenshotPath(truncated), /structurally valid JPEG/);
    const huge = path.join(dir, 'huge.png'); await writeFile(huge, png(8193,1));
    await assert.rejects(validateScreenshotPath(huge), /dimensions/);
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'screenshot-outside-'));
    const outside = path.join(outsideDir, 'outside.png'); await writeFile(outside, png(1,1));
    const link = path.join(dir, 'link.png');
    try {
      try { await symlink(outside, link); }
      catch (error) { if (error.code !== 'EPERM') throw error; }
      try { await stat(link); await assert.rejects(validateScreenshotPath(link), /inside the project/); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    finally { await rm(link, { force:true }); await rm(outsideDir, { recursive:true, force:true }); }
  } finally { await rm(dir, { recursive:true, force:true }); }
});
