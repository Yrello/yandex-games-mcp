import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeDomainTool, summarizeDraftChecks, toolDefinitions, validateZipPath } from '../src/domains.mjs';

function storedZip(entryName) {
  const name = Buffer.from(entryName);
  const data = Buffer.from('<html></html>');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const directoryOffset = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

function mockBrowser(values) {
  const calls = [];
  return {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'browser_navigate') return { content: [{ type: 'text', text: 'navigated' }] };
      if (name === 'browser_wait_for') return { content: [{ type: 'text', text: 'waited' }] };
      if (name === 'browser_fill_form') return { content: [{ type: 'text', text: 'filled' }] };
      if (name === 'browser_click') return { content: [{ type: 'text', text: 'clicked' }] };
      if (name === 'browser_evaluate') {
        const value = values.shift();
        return { content: [{ type: 'text', text: `### Result\n${JSON.stringify(`YGJSON:${JSON.stringify(value)}`)}` }] };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
}

test('list_games returns only linked console games', async () => {
  const browser = mockBrowser([
    [
      { href: 'https://games.yandex.ru/console/application/101001#application-info-draft', cells: ['', 'Draft\nЧерновик\nDemo', '1 янв 2025', '—', '—', 'Отклонен', ''] },
      { href: 'https://example.com/game/12345', cells: ['', 'Outside', '', '', '', '', ''] },
    ],
  ]);
  const result = await invokeDomainTool('list_games', {}, browser);
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text).games, [
    { game_id: '101001', title: 'Demo', updated_at: '1 янв 2025', status: 'Отклонен', url: 'https://games.yandex.ru/console/application/101001' },
  ]);
  assert.equal(browser.calls[0].name, 'browser_navigate');
});

test('list_games waits briefly for an asynchronously loaded table', async () => {
  const browser = mockBrowser([
    [],
    [{ href: 'https://games.yandex.ru/console/application/101003',
      cells: ['', 'Demo Game', '2 янв 2025', '', '', 'Создан'] }],
  ]);
  const result = await invokeDomainTool('list_games', {}, browser);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.games[0].game_id, '101003');
  assert.equal(browser.calls.filter(call => call.name === 'browser_wait_for').length, 1);
});

test('get_draft rejects invalid ID before opening the browser', async () => {
  const browser = mockBrowser([]);
  const result = await invokeDomainTool('get_draft', { game_id: '../other' }, browser);
  assert.equal(result.isError, true);
  assert.equal(browser.calls.length, 0);
});

test('inspect_draft_form checks the exact page identity and performs only read calls', async () => {
  const browser = mockBrowser([
    { origin: 'https://games.yandex.ru', pathname: '/console/application/101003', hash: '#application-info-draft' },
    { ok: true, game_id: '101003' },
    { ok: true, game_id: '101003', form: { control_count: 1, controls: [{ id: 'title101003', type: 'text' }], sections: ['Карточка'] },
      draft: { screenshots: { type: 'array', count: 2 }, videos: { type: 'array', count: 0 }, categories: { type: 'array', count: 1 }, tags: { type: 'array', count: 1 }, features: { type: 'object', keys: ['orientation'] }, selected_categories: [{ id: '12', label: 'Puzzle' }], selected_tags: [] },
      catalogs: { categories: { shape: { type: 'array', count: 1 }, items: [{ id: '12', label: 'Puzzle' }] }, tags: { shape: { type: 'array', count: 0 }, items: [] } } },
  ]);
  const result = await invokeDomainTool('inspect_draft_form', { game_id: '101003' }, browser);
  const report = JSON.parse(result.content[0].text);
  assert.equal(report.ok, true);
  assert.equal(report.game_id, '101003');
  assert.deepEqual(report.draft.selected_categories, [{ id: '12', label: 'Puzzle' }]);
  assert.deepEqual(browser.calls.filter(call => call.name === 'browser_navigate').map(call => call.args.url), [
    'https://games.yandex.ru/console/', 'https://games.yandex.ru/console/application/101003#application-info-draft',
  ]);
  assert.equal(browser.calls.every(call => ['browser_navigate', 'browser_wait_for', 'browser_evaluate'].includes(call.name)), true);
  const projection = browser.calls.filter(call => call.name === 'browser_evaluate').at(-1).args.function;
  assert.match(projection, /location\.origin !== 'https:\/\/games\.yandex\.ru'/);
  assert.match(projection, /location\.pathname !== '\/console\/application\/' \+ gameId/);
});

test('inspect_draft_form can select an available locale without saving', async () => {
  const browser = mockBrowser([
    { origin: 'https://games.yandex.ru', pathname: '/console/application/101003', hash: '#application-info-draft' },
    { ok: true, fields: { features: { languages: ['ru', 'en'] } }, completeness: { ru: {}, en: {} } },
    [{ label: 'Русский', active: true }, { label: 'Английский', active: false }],
    { origin: 'https://games.yandex.ru', pathname: '/console/application/101003', hash: '#application-info-draft' },
    ['Английский'],
    { ok: true, game_id: '101003', active_locale: 'Английский', form: { control_count: 0, controls: [], sections: [] }, draft: {}, catalogs: {} },
  ]);
  const result = await invokeDomainTool('inspect_draft_form', { game_id: '101003', language: 'en' }, browser);
  assert.equal(JSON.parse(result.content[0].text).active_locale, 'Английский');
  assert.equal(browser.calls.filter(call => call.name === 'browser_click').length, 1);
  assert.equal(browser.calls.some(call => call.name === 'browser_fill_form'), false);
});

test('inspect_draft_form rejects invalid IDs before browser access', async () => {
  const browser = mockBrowser([]);
  const result = await invokeDomainTool('inspect_draft_form', { game_id: '../101003' }, browser);
  assert.equal(result.isError, true);
  assert.equal(browser.calls.length, 0);
});

test('get_draft_localizations separates locales from feature metadata and returns bounded picker data read only', async () => {
  const browser = mockBrowser([
    { origin: 'https://games.yandex.ru', pathname: '/console/application/101003', hash: '#application-info-draft' },
    { ok: true, title: { ru: 'Demo', es: 'Demo' }, fields: {
      description: { ru: '', es: '' }, features: { languages: ['ru', 'es'], game_languages: { ru: true }, orientation: 'landscape', platforms: { desktop: true } },
    }, completeness: { ru: {}, es: {} }, media: { screenshots: { type: 'array', files: [] } } },
    [{ label: 'Русский', active: true }, { label: 'Испанский', active: false },
      { label: '', aria_label: '', data_language: '', text: '', active: false }],
    { candidate_found: true, candidate_count: 1, activation: 'not_attempted',
      controls: [{ tag: 'button', label: 'Добавить язык', data_qa: 'locale-add', visible: true, options: [] }],
      options: [{ label: 'French', value: 'fr', selected: false, disabled: false }] },
  ]);
  const result = await invokeDomainTool('get_draft_localizations', { game_id: '101003' }, browser);
  const report = JSON.parse(result.content[0].text);
  assert.equal(report.ok, true);
  assert.deepEqual(report.added_locales, ['es', 'ru']);
  assert.deepEqual(report.gameplay_languages, { ru: true });
  assert.equal(report.locale_picker.candidate_found, true);
  assert.equal(report.locale_picker.activation, 'not_attempted');
  assert.deepEqual(report.locale_picker.options.map(option => option.value), ['fr']);
  assert.equal(report.console_tabs.length, 3);
  assert.equal(report.console_tabs[2].language, null);
  assert.equal(browser.calls.some(call => call.name === 'browser_click'), false);
});

test('get_draft_localizations ignores malformed API keys and keeps unmatched tabs unmapped', async () => {
  const browser = mockBrowser([
    { origin: 'https://games.yandex.ru', pathname: '/console/application/101003', hash: '#application-info-draft' },
    { ok: true, title: { ru: 'Demo', 'bad??': 'Malformed' }, fields: {
      description: { ru: '' }, features: { languages: ['ru'], orientation: 'landscape', languages_extra: { nonsense: true } },
    }, completeness: { ru: {} }, media: { screenshots: { type: 'array', files: [] } } },
    [{ label: 'Русский', active: true }, { label: 'Unmapped Locale', active: false }],
    { candidate_found: false, candidate_count: 0, activation: 'not_attempted', controls: [], options: [] },
  ]);
  const result = await invokeDomainTool('get_draft_localizations', { game_id: '101003' }, browser);
  const report = JSON.parse(result.content[0].text);
  assert.equal(report.ok, true);
  assert.deepEqual(report.added_locales, ['ru']);
  assert.deepEqual(report.console_tabs.map(tab => tab.language), ['ru', null]);
});

test('moderation feedback reads a published application without a draft', async () => {
  const browser = mockBrowser([
    { ok: true, title: { ru: 'Тестовая игра' }, release_type: 'published',
      release_status: { state: 'published' }, build: { file_id: 123, state: 'checked' } },
    { ok: true, history: { was_moderated: true } },
  ]);
  const result = await invokeDomainTool('get_moderation_feedback', { game_id: '101002' }, browser);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.release_type, 'published');
  assert.equal(value.moderation_history.was_moderated, true);
  assert.equal(browser.calls.filter(call => call.name === 'browser_evaluate').length, 2);
});

test('moderation feedback uses the visible game listing when release metadata is unavailable', async () => {
  const browser = mockBrowser([
    { ok: true, title: {}, release_type: 'unknown', release_status: null, build: null },
    { ok: true, history: { was_moderated: true } },
    [{ href: 'https://games.yandex.ru/console/application/101002#application-info-published',
      cells: ['', 'Тестовая игра', '2 янв 2025', '', '', 'Опубликовано'] }],
  ]);
  const result = await invokeDomainTool('get_moderation_feedback', { game_id: '101002' }, browser);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.ok, true);
  assert.deepEqual(value.title, { ru: 'Тестовая игра' });
  assert.equal(value.release_type, 'published');
  assert.equal(value.listing_status, 'Опубликовано');
  assert.equal(value.build, null);
});

test('exposes read and draft update tools while moderation actions remain deferred', () => {
  assert.deepEqual(toolDefinitions.map(tool => tool.name), [
    'inspect_console', 'list_games', 'get_draft', 'inspect_draft_form', 'get_draft_localizations', 'add_draft_localization', 'check_draft', 'check_media_files', 'get_moderation_feedback',
    'update_fields', 'update_localized_fields', 'upload_draft_media', 'upload_draft_screenshot', 'update_draft_classification', 'update_draft_age_rating',
    'inspect_leaderboard_form', 'list_leaderboards', 'get_leaderboard', 'create_leaderboard', 'update_leaderboard', 'delete_leaderboard', 'upload_build',
  ]);
});

test('update_fields opens the target draft before filling and saving text', async () => {
  const browser = mockBrowser([
    { origin: 'https://games.yandex.ru', pathname: '/console/application/101003', hash: '#application-info-draft' },
    { ok: true, fields: { developer_comment: '' } },
    [{ selector: '#developer-comment101003', expected: '', actual: '' }],
    [{ selector: '#developer-comment101003', expected: 'temporary', actual: 'temporary' }],
    { count: 1, enabled: 1 },
    { origin: 'https://games.yandex.ru', pathname: '/console/application/101003', hash: '#application-info-draft' },
    { ok: true, fields: { developer_comment: 'temporary' } },
  ]);
  const result = await invokeDomainTool('update_fields', {
    game_id: '101003', fields: { developer_comment: 'temporary' },
  }, browser);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.ok, true);
  const draftNavigation = browser.calls.find(call => call.name === 'browser_navigate'
    && call.args.url.includes('/application/101003#application-info-draft'));
  const wait = browser.calls.find(call => call.name === 'browser_wait_for');
  const fill = browser.calls.find(call => call.name === 'browser_fill_form');
  assert.ok(draftNavigation);
  assert.ok(wait);
  assert.ok(fill);
  assert.ok(browser.calls.indexOf(draftNavigation) < browser.calls.indexOf(wait));
  assert.ok(browser.calls.indexOf(wait) < browser.calls.indexOf(fill));
});

test('update_fields reads title from the top-level localized API property and confirms Russian locale', async () => {
  const browser = mockBrowser([
    { origin: 'https://games.yandex.ru', pathname: '/console/application/101003', hash: '#application-info-draft' },
    { ok: true, title: { ru: 'Old title' }, fields: { features: { languages: ['ru'] } }, completeness: { ru: {} } },
    [{ label: 'Русский', active: false }, { label: 'Английский', active: true }],
    { origin: 'https://games.yandex.ru', pathname: '/console/application/101003', hash: '#application-info-draft' },
    ['Русский'],
    [{ selector: '#title101003', expected: 'Old title', actual: 'Old title' }],
    [{ selector: '#title101003', expected: 'New title', actual: 'New title' }],
    { count: 1, enabled: 1 },
    { origin: 'https://games.yandex.ru', pathname: '/console/application/101003', hash: '#application-info-draft' },
    ['Русский'],
    { ok: true, title: { ru: 'New title' } },
  ]);
  const result = await invokeDomainTool('update_fields', { game_id: '101003', fields: { title: 'New title' } }, browser);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(value.fields, { title: 'New title' });
  assert.equal(browser.calls.filter(call => call.name === 'browser_click').length, 2);
  assert.ok(browser.calls.some(call => call.name === 'browser_click' && `${call.args.target} ${call.args.element}`.includes('Русский')));
});

test('update_fields saves through the visible draft submit, ignoring hidden Save controls', async () => {
  const keywords = 'Demo, числа, головоломка, слияние, плитки, цепочки';
  const browser = mockBrowser([
    { origin: 'https://games.yandex.ru', pathname: '/console/application/101003', hash: '#application-info-draft' },
    { ok: true, fields: { keywords: [] } },
    [{ selector: '#keywords101003', expected: '', actual: '' }],
    [{ selector: '#keywords101003', expected: keywords, actual: keywords }],
    { count: 1, enabled: 1 },
    { origin: 'https://games.yandex.ru', pathname: '/console/application/101003', hash: '#application-info-draft' },
    { ok: true, fields: { keywords: ['Demo', 'числа', 'головоломка', 'слияние', 'плитки', 'цепочки'] } },
  ]);
  const result = await invokeDomainTool('update_fields', { game_id: '101003', fields: { keywords } }, browser);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.saved, true);
  assert.deepEqual(value.fields, { keywords });
  assert.deepEqual(value.changed_fields, ['keywords']);
  assert.equal(browser.calls.filter(call => call.name === 'browser_click'
    && call.args.target.includes('form__button[type="submit"]:visible')).length, 1);
  const saveProbe = browser.calls.find(call => call.name === 'browser_evaluate'
    && call.args.function.includes('button.form__button'));
  assert.ok(saveProbe);
  assert.match(saveProbe.args.function, /getClientRects\(\)\.length/);
});

test('update_fields rejects prototype field names before opening the browser', async () => {
  const browser = mockBrowser([]);
  const result = await invokeDomainTool('update_fields', { game_id: '101003', fields: { constructor: 'x' } }, browser);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unsupported field: constructor/);
  assert.equal(browser.calls.length, 0);
});

test('update_fields refuses duplicate Save buttons and verifies restoration in the DOM', async () => {
  const browser = mockBrowser([
    { origin: 'https://games.yandex.ru', pathname: '/console/application/101003', hash: '#application-info-draft' },
    { ok: true, fields: { developer_comment: 'old' } },
    [{ expected: 'old', actual: 'old' }],
    [{ expected: 'new', actual: 'new' }],
    { count: 2, enabled: 2 },
    [{ expected: 'old', actual: 'old' }],
  ]);
  const result = await invokeDomainTool('update_fields', { game_id: '101003', fields: { developer_comment: 'new' } }, browser);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.ok, false);
  assert.equal(value.saved, false);
  assert.equal(value.restored, true);
  assert.equal(browser.calls.some(call => call.name === 'browser_click' && call.args.target.includes('form__button[type="submit"]:visible')), false);
});

test('update_fields stops when the browser is on another game', async () => {
  const browser = mockBrowser([
    { origin: 'https://games.yandex.ru', pathname: '/console/application/101001', hash: '#application-info-draft' },
  ]);
  const result = await invokeDomainTool('update_fields', {
    game_id: '101003', fields: { developer_comment: 'temporary' },
  }, browser);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requested game draft page/);
  assert.equal(browser.calls.some(call => call.name === 'browser_fill_form'), false);
});

test('ZIP preflight requires exact root index and complete local entry', async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const folder = await mkdtemp(path.join(projectRoot, '.zip-test-'));
  try {
    const valid = path.join(folder, 'valid.zip');
    await writeFile(valid, storedZip('index.html'));
    assert.equal(await validateZipPath(valid), valid);

    const uppercase = path.join(folder, 'uppercase.zip');
    await writeFile(uppercase, storedZip('INDEX.HTML'));
    await assert.rejects(validateZipPath(uppercase), /index\.html/);

    const missingLocal = path.join(folder, 'missing-local.zip');
    const broken = storedZip('index.html');
    const centralOffset = 30 + Buffer.byteLength('index.html') + Buffer.byteLength('<html></html>');
    broken.writeUInt32LE(1, centralOffset + 42);
    await writeFile(missingLocal, broken);
    await assert.rejects(validateZipPath(missingLocal), /local entry/);

    const shortData = path.join(folder, 'short-data.zip');
    const truncated = storedZip('index.html');
    truncated.writeUInt32LE(100, centralOffset + 20);
    await writeFile(shortData, truncated);
    await assert.rejects(validateZipPath(shortData), /entry data is incomplete/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});


test('check_draft keeps archive processing separate from draft validation', () => {
  const report = summarizeDraftChecks({
    game_id: '101001', title: { ru: 'Demo' },
    status: { state: 'rejected', error_code: 'SOURCE.NO_SOURCE_FILE', message: 'Invalid archive' },
    build: { file_id: 14068244, state: 'checked', error_code: null },
    completeness: { ru: { percent: 23, missing_fields: ['field.icon.label', 'field.cover.label'] } },
  });
  assert.equal(report.build.state, 'checked');
  assert.equal(report.status.state, 'rejected');
  assert.deepEqual(report.issues.map(issue => issue.code), ['SOURCE.NO_SOURCE_FILE', 'missing_fields']);
  assert.equal(report.completeness.ru.missing_fields.length, 2);
  assert.deepEqual(report.completeness.ru.missing_field_details, [
    { key: 'field.icon.label', label_ru: 'Иконка', type: 'media' },
    { key: 'field.cover.label', label_ru: 'Обложка', type: 'media' },
  ]);
  assert.deepEqual(report.completeness.ru.missing_by_type, {
    text: [], media: ['field.icon.label', 'field.cover.label'], classification: [], unknown: [],
  });
  assert.equal(report.assessment.state, 'needs_attention');
  assert.deepEqual(report.suggested_actions.by_language.ru.suggestions, [
    { tool: 'upload_draft_media', argument: 'icon_path' },
    { tool: 'upload_draft_media', argument: 'cover_path' },
  ]);
});

test('check_draft preserves unknown missing-field identifiers', () => {
  const report = summarizeDraftChecks({
    game_id: '1', title: {}, status: { state: 'created' },
    build: { file_id: 7, state: 'checked' },
    completeness: { ru: { percent: 50, missing_fields: ['field.future.label'] } },
  });
  assert.deepEqual(report.completeness.ru.missing_field_details, [
    { key: 'field.future.label', label_ru: null, type: 'unknown' },
  ]);
  assert.deepEqual(report.completeness.ru.missing_by_type.unknown, ['field.future.label']);
});

test('check_draft distinguishes incomplete evidence from reported issues', () => {
  const base = { game_id: '1', title: {}, status: { state: 'created' },
    build: { file_id: 7, state: 'checked' } };
  const unknown = summarizeDraftChecks({ ...base, completeness: {
    ru: { percent: null, missing_fields: null },
  } });
  assert.equal(unknown.assessment.state, 'insufficient_data');
  assert.deepEqual(unknown.assessment.unknowns, ['completeness_unavailable:ru']);
  assert.deepEqual(unknown.issues.map(issue => issue.code), ['unavailable']);

  const clean = summarizeDraftChecks({ ...base, completeness: {
    ru: { percent: 100, missing_fields: [] },
  } });
  assert.equal(clean.assessment.state, 'no_reported_issues');
  assert.equal(clean.assessment.issue_count, 0);

  const processing = summarizeDraftChecks({ ...base,
    build: { file_id: 7, state: 'checking' }, completeness: clean.completeness });
  assert.equal(processing.assessment.state, 'insufficient_data');
  assert.deepEqual(processing.assessment.unknowns, ['build_not_checked']);

  const incomplete = summarizeDraftChecks({ ...base, completeness: {
    ru: { percent: 85, missing_fields: [] },
  } });
  assert.equal(incomplete.assessment.state, 'needs_attention');
  assert.deepEqual(incomplete.issues.map(issue => issue.code), ['incomplete_percent']);

  const pending = summarizeDraftChecks({ ...base, status: { state: 'pending' },
    completeness: clean.completeness });
  assert.equal(pending.assessment.state, 'insufficient_data');
  assert.deepEqual(pending.assessment.unknowns, ['draft_status_unrecognized']);

  const malformed = summarizeDraftChecks({ ...base, completeness: {
    ru: { percent: 100, missing_fields: [null] },
  } });
  assert.equal(malformed.assessment.state, 'insufficient_data');
  assert.deepEqual(malformed.assessment.unknowns, ['completeness_unavailable:ru']);
});


test('check_draft is read only and returns a compact issue report', async () => {
  const browser = mockBrowser([{
    ok: true, game_id: '101001', title: { ru: 'Demo' },
    status: { state: 'rejected', error_code: 'SOURCE.NO_SOURCE_FILE', message: 'Invalid archive' },
    build: { file_id: 14068244, state: 'checked' },
    completeness: { ru: { percent: 23, missing_fields: ['field.icon.label'] } },
  }]);
  const result = await invokeDomainTool('check_draft', { game_id: '101001' }, browser);
  const report = JSON.parse(result.content[0].text);
  assert.equal(report.action, 'check_draft');
  assert.equal(report.issues.length, 2);
  assert.deepEqual(browser.calls.map(call => call.name), ['browser_navigate', 'browser_evaluate']);
});


test('check_draft reports unavailable completeness as unknown evidence', () => {
  const report = summarizeDraftChecks({
    game_id: '1', title: {}, status: { state: 'created' },
    build: { file_id: 7, state: 'checked' }, completeness: {},
  });
  assert.deepEqual(report.issues.map(issue => issue.code), ['unavailable']);
});

test('check_media_files reports local validation failures without a browser', async () => {
  const result = await invokeDomainTool('check_media_files', { icon_path: 'missing-icon.png' });
  const report = JSON.parse(result.content[0].text);
  assert.equal(report.action, 'check_media_files');
  assert.equal(report.ok, false);
  assert.equal(report.files.icon.ok, false);
  assert.match(report.files.icon.reason, /does not exist/);
});
