import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeDomainTool } from '../src/domains.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = { origin: 'https://games.yandex.ru', pathname: '/console/application/101001', hash: '#application-info-draft' };
const before = { ok: true, fields: { features: { languages: ['en'] } }, completeness: { en: {} },
  media: { screenshots: { type: 'null', files: [] } } };
const form = ids => ({ input_count: 1, input_name: 'screenshots-desktop', accept: 'image/jpeg, image/png',
  button_count: 1, button_text: 'Выбрать файл', container_count: 1, marker_ids: ids, error: '',
  platform_count: 1, platform_text: 'Десктопные', orientation_count: 1,
  orientation_text: 'Альбомная', active_locale: 'Английский' });

function jpeg() {
  const sof = Buffer.alloc(17); sof.set([0xff, 0xc0, 0, 15, 8]);
  sof.writeUInt16BE(720, 5); sof.writeUInt16BE(1280, 7); sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xda, 0, 2, 0, 0xff, 0xd9])]);
}

function mockBrowser(values) {
  const calls = [];
  return { calls, async call(name, args) {
    calls.push({ name, args });
    if (name === 'browser_evaluate') {
      assert.ok(values.length, 'unexpected browser_evaluate');
      const value = values.shift();
      return { content: [{ type: 'text', text: `### Result\n${JSON.stringify(`YGJSON:${JSON.stringify(value)}`)}` }] };
    }
    if (['browser_navigate', 'browser_wait_for', 'browser_click', 'browser_file_upload'].includes(name))
      return { content: [{ type: 'text', text: 'ok' }] };
    throw new Error(`unexpected ${name}`);
  } };
}

async function withScreenshot(callback) {
  const dir = await mkdtemp(path.join(root, '.screenshot-upload-'));
  try {
    const file = path.join(dir, 'screen.jpg');
    await writeFile(file, jpeg());
    return await callback(path.relative(root, file));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('screenshot upload stops before Save when preview has no new file ID', async () => withScreenshot(async screenshotPath => {
  const browser = mockBrowser([page, before, [{ label: 'Английский', active: true }], ['Английский'],
    form([]), page, { ...form([]), error: 'upload rejected' }]);
  const result = await invokeDomainTool('upload_draft_screenshot',
    { game_id: '101001', language: 'en', screenshot_path: screenshotPath }, browser);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.ok, false);
  assert.equal(value.saved, false);
  assert.equal(browser.calls.filter(call => call.name === 'browser_click' && /form__button\[type="submit"\]:visible/.test(call.args.target ?? '')).length, 0);
  assert.equal(browser.calls.filter(call => call.name === 'browser_file_upload').length, 1);
}));

test('screenshot upload saves once only after preview ID and verifies the API ID', async () => withScreenshot(async screenshotPath => {
  const browser = mockBrowser([page, before, [{ label: 'Английский', active: true }], ['Английский'],
    form([]), page, form(['14240000']), { count: 1, enabled: 1, disabled: false }, form(['14240000']), page,
    { ok: true, media: { screenshots: { type: 'object', files: [{ path: ['en', 'desktop', 0, 'file'], file_id: 14240000 }] } } }]);
  const result = await invokeDomainTool('upload_draft_screenshot',
    { game_id: '101001', language: 'en', screenshot_path: screenshotPath }, browser);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.ok, true, result.content[0].text);
  assert.equal(value.verified, true);
  assert.equal(value.selected_file_id, '14240000');
  assert.equal(browser.calls.filter(call => call.name === 'browser_click' && /form__button\[type="submit"\]:visible/.test(call.args.target ?? '')).length, 1);
  assert.equal(browser.calls.some(call => call.name === 'browser_click' && /модерац|moderation/i.test(call.args.target ?? '')), false);
}));
