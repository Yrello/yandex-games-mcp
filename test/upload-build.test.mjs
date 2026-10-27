import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeDomainTool } from '../src/domains.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A minimal stored ZIP containing one root-level index.html. CRC is not needed
// by the ZIP preflight; it validates record structure, offsets, and filenames.
function tinyZip() {
  const name = Buffer.from('index.html');
  const body = Buffer.from('<!doctype html><title>test</title>');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  const localRecord = Buffer.concat([local, name, body]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralRecord = Buffer.concat([central, name]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralRecord.length, 12);
  end.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, centralRecord, end]);
}

function mockBrowser(values) {
  const calls = [];
  return {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'browser_evaluate') {
        assert.ok(values.length, `unexpected browser_evaluate: ${args.function}`);
        const value = values.shift();
        calls.at(-1).value = value;
        return { content: [{ type: 'text', text: `### Result\n${JSON.stringify(`YGJSON:${JSON.stringify(value)}`)}` }] };
      }
      if (['browser_navigate', 'browser_wait_for', 'browser_click', 'browser_file_upload'].includes(name)) {
        return { content: [{ type: 'text', text: `${name} ok` }] };
      }
      throw new Error(`unexpected browser call ${name}`);
    },
  };
}

const gameId = '101003';
const page = { origin: 'https://games.yandex.ru', pathname: `/console/application/${gameId}`, hash: '#application-info-draft' };
const draft = fileId => ({ ok: true, build: { file_id: fileId, state: 'unknown' } });
const resultValue = result => JSON.parse(result.content[0].text);
const formState = fileId => ({ file_id: fileId, save_found: true, save_disabled: false });
const uploadPrefix = [page, draft('old-file')];
const uploadAfterSelection = [page, formState('new-file'), page];

test('build upload rejects a malformed ZIP before making browser calls', async () => {
  const folder = await mkdtemp(path.join(projectRoot, '.upload-build-test-'));
  try {
    const badZip = path.join(folder, 'bad.zip');
    await writeFile(badZip, Buffer.from('not a zip'));
    const browser = mockBrowser([]);
    const result = await invokeDomainTool('upload_build', {
      game_id: gameId, zip_path: path.relative(projectRoot, badZip),
    }, browser);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ZIP signature/);
    assert.equal(browser.calls.length, 0);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('build upload uploads once, saves once, and verifies persisted API file ID', async () => {
  const folder = await mkdtemp(path.join(projectRoot, '.upload-build-test-'));
  try {
    const zip = path.join(folder, 'build.zip');
    await writeFile(zip, tinyZip());
    const values = [...uploadPrefix, ...uploadAfterSelection, draft('new-file')];
    const browser = mockBrowser(values);
    const result = await invokeDomainTool('upload_build', {
      game_id: gameId, zip_path: path.relative(projectRoot, zip),
    }, browser);
    const report = resultValue(result);
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(report.ok, true);
    assert.equal(report.uploaded, true);
    assert.equal(report.saved, true);
    assert.equal(String(report.new_file_id), 'new-file');
    assert.equal(values.length, 0);
    assert.equal(browser.calls.filter(call => call.name === 'browser_file_upload').length, 1);
    assert.equal(browser.calls.filter(call => call.name === 'browser_click' && call.args.target === 'button.form__button[type="submit"]:visible').length, 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('build upload with unknown upload ID never saves', async () => {
  const folder = await mkdtemp(path.join(projectRoot, '.upload-build-test-'));
  try {
    const zip = path.join(folder, 'build.zip');
    await writeFile(zip, tinyZip());
    const values = [...uploadPrefix, ...Array.from({ length: 15 }, () => formState(null)), draft('old-file')];
    const browser = mockBrowser(values);
    const result = await invokeDomainTool('upload_build', {
      game_id: gameId, zip_path: path.relative(projectRoot, zip),
    }, browser);
    const report = resultValue(result);
    assert.equal(result.isError, undefined);
    assert.equal(report.ok, false);
    assert.equal(report.uploaded, 'unknown');
    assert.equal(report.saved, false);
    assert.equal(values.length, 0);
    assert.equal(browser.calls.some(call => call.name === 'browser_click' && call.args.target === 'button.form__button[type="submit"]:visible'), false);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('build upload reports failure when the post-save API file ID differs', async () => {
  const folder = await mkdtemp(path.join(projectRoot, '.upload-build-test-'));
  try {
    const zip = path.join(folder, 'build.zip');
    await writeFile(zip, tinyZip());
    const values = [...uploadPrefix, ...uploadAfterSelection, draft('different-file')];
    const browser = mockBrowser(values);
    const result = await invokeDomainTool('upload_build', {
      game_id: gameId, zip_path: path.relative(projectRoot, zip),
    }, browser);
    const report = resultValue(result);
    assert.equal(result.isError, undefined);
    assert.equal(report.ok, false);
    assert.equal(report.uploaded, true);
    assert.equal(report.saved, 'unknown');
    assert.match(report.reason, /did not confirm its file ID/);
    assert.equal(values.length, 0);
    assert.equal(browser.calls.filter(call => call.name === 'browser_click' && call.args.target === 'button.form__button[type="submit"]:visible').length, 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
