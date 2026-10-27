import path from 'node:path';
import { open, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateMediaPath } from './media-preflight.mjs';
import { validateScreenshotPath } from './screenshot-preflight.mjs';
import { classificationToolDefinition, updateDraftClassification } from './classification.mjs';
import { ageRatingToolDefinition, updateDraftAgeRating } from './settings.mjs';
import { suggestDraftActions } from './draft-guidance.mjs';

const CONSOLE_URL = 'https://games.yandex.ru/console/';
const MAX_TEXT = 6000;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const TEXT_FIELD_LIMITS = {
  version: 32, title: 50, seo_description: 160, description: 1000,
  short_description: 70, instructions: 1000, keywords: 100, developer_comment: 2048,
};

const TEXT_FIELD_SELECTORS = {
  version: gameId => `#app-version${gameId}`,
  title: gameId => `#title${gameId}`,
  seo_description: gameId => `#seo-description${gameId}`,
  description: gameId => `#description${gameId}`,
  short_description: gameId => `#short-description${gameId}`,
  instructions: gameId => `#instruction${gameId}`,
  keywords: gameId => `#keywords${gameId}`,
  developer_comment: gameId => `#developer-comment${gameId}`,
};
const LOCALIZED_FIELDS = ['title', 'seo_description', 'description', 'short_description', 'instructions'];
const LOCALE_LABELS = { ru: 'Русский', en: 'Английский' };
const MEDIA_INPUTS = { icon: gameId => `#icon-field${gameId}`, cover: gameId => `#cover-field${gameId}` };
const MEDIA_BUTTONS = { icon: gameId => `#uploader-icon-field${gameId}`, cover: gameId => `#uploader-cover-field${gameId}` };
const MISSING_FIELD_DETAILS = {
  'field.title.label': { label_ru: 'Название', type: 'text' },
  'field.description.label': { label_ru: 'Об игре', type: 'text' },
  'field.seo-description.label': { label_ru: 'Описание для SEO', type: 'text' },
  'field.instruction.label': { label_ru: 'Как играть', type: 'text' },
  'field.keywords.label': { label_ru: 'Ключевые слова', type: 'text' },
  'field.icon.label': { label_ru: 'Иконка', type: 'media' },
  'field.cover.label': { label_ru: 'Обложка', type: 'media' },
  'field.video.name': { label_ru: 'Видео', type: 'media' },
  'field.screenshots.name': { label_ru: 'Скриншоты', type: 'media' },
  'field.tags.label': { label_ru: 'Теги', type: 'classification' },
  'field.categories.label': { label_ru: 'Категории', type: 'classification' },
};
export const toolDefinitions = [
  {
    name: 'inspect_console',
    description: 'Read a compact map of the currently signed-in Yandex Games console. Does not change games.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_games',
    description: 'Read the currently selected account games and their statuses from the visible console table.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_draft',
    description: 'Read the draft fields and build status for a Yandex Games application ID.',
    inputSchema: {
      type: 'object',
      properties: { game_id: { type: 'string', pattern: '^[0-9]+$' } },
      required: ['game_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_draft_form',
    description: 'Read bounded form controls and safe draft/catalog shapes for one exact game draft. Does not change the draft.',
    inputSchema: { type: 'object', properties: { game_id: { type: 'string', pattern: '^[0-9]+$' }, language: { type: 'string', enum: ['ru', 'en'] } }, required: ['game_id'], additionalProperties: false },
  },
  {
    name: 'check_draft',
    description: 'Read known draft validation errors and missing fields. Does not save or submit.',
    inputSchema: {
      type: 'object',
      properties: { game_id: { type: 'string', pattern: '^[0-9]+$' } },
      required: ['game_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_media_files',
    description: 'Read local icon and cover PNG files inside this project and check their format and required dimensions. Does not upload files or open the browser.',
    inputSchema: {
      type: 'object',
      properties: { icon_path: { type: 'string', minLength: 1 }, cover_path: { type: 'string', minLength: 1 } },
      minProperties: 1,
      additionalProperties: false,
    },
  },
  {
    name: 'get_moderation_feedback',
    description: 'Read application validation feedback and moderation history for a Yandex Games application ID.',
    inputSchema: {
      type: 'object',
      properties: { game_id: { type: 'string', pattern: '^[0-9]+$' } },
      required: ['game_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_fields',
    description: 'Update only supplied Russian text fields in a game draft, save once, and verify by reading the draft again.',
    inputSchema: {
      type: 'object',
      properties: {
        game_id: { type: 'string', pattern: '^[0-9]+$' },
        fields: {
          type: 'object',
          properties: {
            version: { type: 'string', maxLength: 32 },
            title: { type: 'string', maxLength: 50 },
            seo_description: { type: 'string', maxLength: 160 },
            description: { type: 'string', maxLength: 1000 },
            short_description: { type: 'string', maxLength: 70 },
            instructions: { type: 'string', maxLength: 1000 },
            keywords: { type: 'string', maxLength: 100 },
            developer_comment: { type: 'string', maxLength: 2048 }
          },
          minProperties: 1,
          additionalProperties: false
        }
      },
      required: ['game_id', 'fields'],
      additionalProperties: false
    }
  },
  {
    name: 'update_localized_fields',
    description: 'Update only supplied localized text fields in a ru or en game draft, save once, and verify that language through the draft API. Does not submit.',
    inputSchema: {
      type: 'object',
      properties: {
        game_id: { type: 'string', pattern: '^[0-9]+$' },
        language: { type: 'string', enum: ['ru', 'en'] },
        fields: { type: 'object', minProperties: 1, additionalProperties: false, properties: {
          title: { type: 'string', maxLength: 50 },
          seo_description: { type: 'string', maxLength: 160 },
          description: { type: 'string', maxLength: 1000 },
          short_description: { type: 'string', maxLength: 70 },
          instructions: { type: 'string', maxLength: 1000 },
        } },
      },
      required: ['game_id', 'language', 'fields'], additionalProperties: false,
    },
  },
  {
    name: 'upload_draft_media',
    description: 'Upload icon and/or cover PNG files to one draft language; set replace_existing=true to replace a saved image. Saves once and verifies file IDs. Does not submit.',
    inputSchema: {
      type: 'object',
      properties: { game_id: { type: 'string', pattern: '^[0-9]+$' }, language: { type: 'string', enum: ['ru', 'en'] },
        icon_path: { type: 'string', minLength: 1 }, cover_path: { type: 'string', minLength: 1 },
        replace_existing: { type: 'boolean' } },
      required: ['game_id', 'language'], additionalProperties: false,
    },
  },
  {
    name: 'upload_draft_screenshot',
    description: 'Add one desktop landscape PNG/JPEG screenshot to a ru or en draft, save once, and verify the file ID. Does not upload video or submit.',
    inputSchema: {
      type: 'object',
      properties: { game_id: { type: 'string', pattern: '^[0-9]+$' }, language: { type: 'string', enum: ['ru', 'en'] },
        screenshot_path: { type: 'string', minLength: 1 } },
      required: ['game_id', 'language', 'screenshot_path'], additionalProperties: false,
    },
  },
  classificationToolDefinition,
  ageRatingToolDefinition,
  {
    name: 'upload_build',
    description: 'Upload one ZIP archive (up to 100 MiB with root index.html) from inside this project, save the draft, and verify its file ID. Does not submit for moderation or publish.',
    inputSchema: {
      type: 'object',
      properties: { game_id: { type: 'string', pattern: '^[0-9]+$' }, zip_path: { type: 'string', minLength: 1 } },
      required: ['game_id', 'zip_path'],
      additionalProperties: false
    }
  },
];

const asResult = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const asError = (action, reason) => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: false, action, reason }) }],
  isError: true,
});

function assertGameId(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new Error('game_id must contain digits only');
  }
  return value;
}

function resultText(result) {
  if (result?.isError) throw new Error('browser tool failed');
  return (result?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
}

function decodeEvaluation(result) {
  const text = resultText(result);
  const marker = 'YGJSON:';
  const resultSection = text.includes('### Result') ? text.split('### Result', 2)[1].split(/\n### /, 1)[0].trim() : text.trim();
  // Playwright MCP may print a JS string as a quoted JSON string or as plain text.
  try {
    const value = JSON.parse(resultSection);
    if (typeof value === 'string' && value.startsWith(marker)) return JSON.parse(value.slice(marker.length));
  } catch { /* plain text result */ }
  const markerIndex = resultSection.indexOf(marker);
  if (markerIndex < 0) throw new Error('unexpected browser response');
  const raw = resultSection.slice(markerIndex + marker.length).split(/\r?\n/)[0].trim();
  return JSON.parse(raw);
}

async function evaluate(playwright, source) {
  const result = await playwright.call('browser_evaluate', {
    function: `async () => 'YGJSON:' + JSON.stringify(await (${source})())`,
  });
  return decodeEvaluation(result);
}

async function openConsole(playwright) {
  resultText(await playwright.call('browser_navigate', { url: CONSOLE_URL }));
}

async function ensureDraftPage(playwright, gameId) {
  const page = await evaluate(playwright, `() => ({
    origin: location.origin, pathname: location.pathname, hash: location.hash
  })`);
  if (page.origin !== 'https://games.yandex.ru') throw new Error('Yandex Games sign-in is required');
  if (page.pathname !== `/console/application/${gameId}`
    || page.hash !== '#application-info-draft') {
    throw new Error('The requested game draft page is not open');
  }
}

const overviewExpression = `() => {
  const visible = el => Boolean(el.getClientRects().length);
  const clean = value => String(value ?? '').trim().replace(/\\s+/g, ' ');
  return {
    url: location.href,
    title: document.title,
    headings: Array.from(document.querySelectorAll('h1,h2,h3')).filter(visible).slice(0, 30).map(el => clean(el.innerText)),
    links: Array.from(document.querySelectorAll('a[href]')).filter(visible).slice(0, 120).map(el => {
      const url = new URL(el.href);
      url.search = '';
      url.hash = '';
      return { text: clean(el.innerText).slice(0, 120), href: url.href };
    }),
    controls: Array.from(document.querySelectorAll('input,textarea,select,button')).filter(visible).slice(0, 100).map(el => ({
      tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', name: el.getAttribute('name') || '',
      label: clean(el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.innerText || '').slice(0, 120)
    })),
    text: clean(document.body?.innerText).slice(0, ${MAX_TEXT})
  };
}`;

async function getOverview(playwright) {
  return evaluate(playwright, overviewExpression);
}

const listExpression = `() => Array.from(document.querySelectorAll('table tbody tr')).map(row => {
  const cells = Array.from(row.querySelectorAll('td')).map(cell => String(cell.innerText || '').trim());
  const anchor = row.querySelector('a[href*="/console/application/"]');
  return { href: anchor?.href || '', cells };
})`;

function gamesFromRows(rows) {
  const games = new Map();
  for (const row of rows ?? []) {
    let url;
    try { url = new URL(row.href); } catch { continue; }
    if (url.hostname !== 'games.yandex.ru') continue;
    const match = url.pathname.match(/^\/console\/application\/([0-9]+)$/);
    if (!match) continue;
    const cells = row.cells ?? [];
    const title = String(cells[1] ?? '').split(/\r?\n/).map(part => part.trim()).filter(part => part && !['Draft', 'Черновик'].includes(part)).at(-1) ?? '';
    if (!title) continue;
    url.search = '';
    url.hash = '';
    games.set(match[1], { game_id: match[1], title, updated_at: String(cells[2] ?? ''), status: String(cells[5] ?? ''), url: url.href });
  }
  return [...games.values()];
}

async function readVisibleGames(playwright) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const games = gamesFromRows(await evaluate(playwright, listExpression));
    if (games.length) return games;
    if (attempt < 3) resultText(await playwright.call('browser_wait_for', { time: 1 }));
  }
  return [];
}

function applicationExpression(gameId) {
  return `async () => {
    const response = await fetch('/console/api/application/${gameId}', { credentials: 'same-origin' });
    if (response.status === 401 || response.status === 403) return { ok: false, reason: 'auth_required' };
    if (!response.ok) return { ok: false, http_status: response.status };
    const json = await response.json();
    const app = json?.data;
    const draft = app?.draft;
    if (!app || String(app.id) !== '${gameId}') return { ok: false, reason: 'application_not_found' };
    if (!draft) return { ok: false, reason: 'application_has_no_draft' };
    const screenshotFiles = [];
    const collectScreenshotFiles = (value, path = []) => {
      if (!value || typeof value !== 'object' || path.length > 8) return;
      if (Array.isArray(value)) { value.slice(0, 100).forEach((item, index) => collectScreenshotFiles(item, [...path, index])); return; }
      for (const [key, item] of Object.entries(value)) {
        if ((key === 'file' || key === 'file_id') && /^\\d+$/.test(String(item)))
          screenshotFiles.push({ path: [...path, key], file_id: Number(item) });
        else if (item && typeof item === 'object') collectScreenshotFiles(item, [...path, key]);
      }
    };
    collectScreenshotFiles(draft.screenshots);
    return {
      ok: true, game_id: String(app.id), title: draft.title ?? {},
      status: { state: draft.status?.state ?? 'unknown',
        error_code: draft.status?.info?.error_code ?? null, message: draft.status?.message ?? null },
      fields: { version: draft['app-version'] ?? null, description: draft.description ?? {},
        short_description: draft.short_description ?? {}, seo_description: draft['seo-description'] ?? {},
        instructions: draft.instruction ?? {}, categories: draft.categories ?? [], tags: draft.tags ?? [],
        keywords: draft.keywords ?? null, developer_comment: draft['developer-comment'] ?? '',
        features: { orientation: draft.features?.orientation ?? null,
          age_rating: draft.features?.age_rating ?? null, age_rating_num: draft.features?.age_rating_num ?? null,
          cloud_save: draft.features?.cloud_save ?? null, languages: draft.features?.languages ?? [],
          platforms: Object.entries(draft.features?.platforms ?? {}).map(([platform, modes]) =>
            [platform, Object.keys(modes ?? {}).filter(mode => modes[mode])]).filter(([, modes]) => modes.length) },
        languages: draft.languages ?? {} },
      build: { file_id: draft.sources?.file ?? null, state: draft.sources?.status?.state ?? 'unknown',
        steps: draft.sources?.status?.build_status_steps ?? [],
        error_code: draft.sources?.status?.info?.error_code ?? null,
        message: draft.sources?.status?.message ?? null },
      media: {
        icon: Object.fromEntries(Object.entries(draft.icon ?? {}).map(([lang, item]) => [lang, item?.file ?? null])),
        cover: Object.fromEntries(Object.entries(draft.cover ?? {}).map(([lang, item]) => [lang, item?.file ?? null])),
        screenshots: { type: Array.isArray(draft.screenshots) ? 'array' : draft.screenshots === null || draft.screenshots === undefined ? 'null' : typeof draft.screenshots,
          files: screenshotFiles.slice(0, 100) }
      },
      completeness: Object.fromEntries(Object.entries(draft.fill_info?.langs ?? {}).map(([lang, info]) =>
        [lang, { percent: info?.percent ?? null, missing_fields: info?.missed_fields ?? null }]))
    };
  }`;
}

export function summarizeDraftChecks(data) {
  const issues = [];
  if (data.status?.error_code || data.status?.state === 'rejected') {
    issues.push({ source: 'draft', code: data.status.error_code ?? 'rejected', message: data.status.message ?? null });
  }
  if (data.build?.error_code || data.build?.state === 'failed') {
    issues.push({ source: 'build', code: data.build.error_code ?? 'failed', message: data.build.message ?? null });
  }
  if (!data.build?.file_id) issues.push({ source: 'build', code: 'missing_archive' });
  if (!Object.keys(data.completeness ?? {}).length) issues.push({ source: 'completeness', code: 'unavailable' });
  const completeness = Object.fromEntries(Object.entries(data.completeness ?? {}).map(([language, info]) => {
    const available = Number.isFinite(info?.percent) && info.percent >= 0 && info.percent <= 100
      && Array.isArray(info?.missing_fields)
      && info.missing_fields.every(key => typeof key === 'string');
    const missingFields = Array.isArray(info?.missing_fields) ? info.missing_fields : [];
    const missingFieldDetails = missingFields.map(key => ({ key,
      ...(Object.hasOwn(MISSING_FIELD_DETAILS, key)
        ? MISSING_FIELD_DETAILS[key] : { label_ru: null, type: 'unknown' }) }));
    const missingByType = { text: [], media: [], classification: [], unknown: [] };
    for (const field of missingFieldDetails) missingByType[field.type].push(field.key);
    return [language, { ...info, missing_fields: missingFields,
      available, missing_field_details: missingFieldDetails, missing_by_type: missingByType }];
  }));
  for (const [language, info] of Object.entries(completeness)) {
    if (info.missing_fields.length && info.missing_fields.every(key => typeof key === 'string')) {
      issues.push({ source: 'completeness', language, code: 'missing_fields', count: info.missing_fields.length });
    }
    else if (info.available && info.percent < 100) issues.push({ source: 'completeness', language, code: 'incomplete_percent', percent: info.percent });
    if (!info.available) issues.push({ source: 'completeness', language, code: 'unavailable' });
  }
  const knownIssues = issues.filter(issue => issue.code !== 'unavailable');
  const unknowns = issues.filter(issue => issue.code === 'unavailable').map(issue =>
    issue.language ? `completeness_unavailable:${issue.language}` : 'completeness_unavailable');
  if (!data.status?.state || data.status.state === 'unknown') unknowns.push('draft_status_unavailable');
  else if (!['created', 'rejected'].includes(data.status.state)) unknowns.push('draft_status_unrecognized');
  if (!data.build?.state || data.build.state === 'unknown') unknowns.push('build_status_unavailable');
  else if (!['checked', 'failed'].includes(data.build.state)) unknowns.push('build_not_checked');
  const assessment = { state: knownIssues.length ? 'needs_attention'
    : unknowns.length ? 'insufficient_data' : 'no_reported_issues',
  note: 'This report does not submit the draft or confirm moderation readiness.',
  issue_count: knownIssues.length, unknowns };
  return { ok: true, action: 'check_draft', game_id: data.game_id, title: data.title,
    status: data.status, build: { file_id: data.build?.file_id ?? null, state: data.build?.state ?? 'unknown' },
    completeness, issues, suggested_actions: suggestDraftActions(data.completeness), assessment };
}

function moderationExpression(gameId) {
  return `async () => {
    const response = await fetch('/console/api/moderation-history/${gameId}', { credentials: 'same-origin' });
    if (response.status === 401 || response.status === 403) return { ok: false, reason: 'auth_required' };
    if (!response.ok) return { ok: false, http_status: response.status };
    const json = await response.json();
    return { ok: true, history: json?.data ?? {} };
  }`;
}

function applicationSummaryExpression(gameId) {
  return `async () => {
    const response = await fetch('/console/api/application/${gameId}', { credentials: 'same-origin' });
    if (response.status === 401 || response.status === 403) return { ok: false, reason: 'auth_required' };
    if (!response.ok) return { ok: false, http_status: response.status };
    const json = await response.json();
    const app = json?.data;
    if (!app || String(app.id) !== '${gameId}') return { ok: false, reason: 'application_not_found' };
    const release = app.draft ?? app.published ?? null;
    return { ok: true, title: release?.title ?? app.title ?? {},
      release_type: app.draft ? 'draft' : app.published ? 'published' : 'unknown',
      release_status: release?.status ? {
        state: release.status.state ?? 'unknown',
        error_code: release.status.info?.error_code ?? null,
        message: release.status.message ?? null
      } : null,
      build: release?.sources ? {
        file_id: release.sources.file ?? null,
        state: release.sources.status?.state ?? 'unknown'
      } : null };
  }`;
}

function getLocalized(data, field) {
  if (field === 'title') {
    const localized = data.title;
    if (typeof localized === 'string' || localized == null) return localized ?? '';
    return localized.ru ?? '';
  }
  if (field === 'keywords') {
    const keywords = data.fields?.keywords ?? '';
    return Array.isArray(keywords) ? keywords.join(', ') : keywords;
  }
  if (field === 'version' || field === 'developer_comment') return data.fields?.[field] ?? '';
  const localized = data.fields[field];
  if (typeof localized === 'string' || localized == null) return localized ?? '';
  return localized.ru ?? '';
}

function fieldValuesMatch(field, actual, expected) {
  if (field !== 'keywords') return actual === expected;
  const canonicalList = value => (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map(item => String(item).trim())
    .filter(Boolean);
  return JSON.stringify(canonicalList(actual)) === JSON.stringify(canonicalList(expected));
}

function assertLanguage(value) {
  if (!Object.hasOwn(LOCALE_LABELS, value)) throw new Error('language must be ru or en');
  return value;
}

function assertLocalizedFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('fields must be an object');
  const names = Object.keys(fields);
  if (!names.length) throw new Error('at least one localized field is required');
  for (const name of names) {
    if (!LOCALIZED_FIELDS.includes(name)) throw new Error(`Unsupported localized field: ${name}`);
    if (typeof fields[name] !== 'string') throw new Error(`${name} must be a string`);
    if (fields[name].length > TEXT_FIELD_LIMITS[name]) throw new Error(`${name} exceeds ${TEXT_FIELD_LIMITS[name]} characters`);
  }
  return names;
}

function localizedValue(data, name, language) {
  const values = name === 'title' ? data.title : data.fields?.[name];
  return values && typeof values === 'object' ? values[language] ?? '' : '';
}

async function openDraft(playwright, gameId) {
  await openConsole(playwright);
  resultText(await playwright.call('browser_navigate', { url: `${CONSOLE_URL}application/${gameId}#application-info-draft` }));
  resultText(await playwright.call('browser_wait_for', { text: 'Комментарий разработчика' }));
  await ensureDraftPage(playwright, gameId);
  const data = await evaluate(playwright, applicationExpression(gameId));
  if (!data.ok) throw new Error(data.reason ?? `Console returned HTTP ${data.http_status}`);
  return data;
}

function draftFormExpression(gameId) {
  return `async () => {
    const gameId = '${gameId}';
    if (location.origin !== 'https://games.yandex.ru' || location.pathname !== '/console/application/' + gameId
      || location.hash !== '#application-info-draft') return { ok: false, reason: 'wrong_page' };
    const clean = (v, n = 100) => String(v ?? '').replace(/\\s+/g, ' ').trim().slice(0, n);
    const visible = el => Boolean(el.getClientRects().length);
    const controlNodes = Array.from(document.querySelectorAll('input,textarea,select,button,[role="combobox"],[role="listbox"],[role="option"]'))
      .filter(el => visible(el) || (el.tagName === 'INPUT' && el.type === 'file'));
    const controls = controlNodes.slice(0, 300).map(el => {
        const parentQa = el.closest('[data-qa]')?.getAttribute('data-qa') || '';
        const item = { tag: el.tagName.toLowerCase(), id: clean(el.id, 100), name: clean(el.getAttribute('name'), 100),
          type: clean(el.getAttribute('type') || el.getAttribute('role'), 30), accept: clean(el.getAttribute('accept'), 100),
          data_qa: clean(el.getAttribute('data-qa'), 100), container_data_qa: clean(parentQa, 100), visible: visible(el),
          aria_label: clean(el.getAttribute('aria-label'), 100), aria_controls: clean(el.getAttribute('aria-controls'), 100),
          aria_expanded: el.getAttribute('aria-expanded') };
        const label = el.labels?.[0] || (el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null);
        if (label) item.label = clean(label.innerText, 100);
        if (el.tagName === 'SELECT') item.options = Array.from(el.options).slice(0, 60).map(o => ({ label: clean(o.label), value: clean(o.value, 100), selected: o.selected }));
        if (el.type === 'radio' || el.type === 'checkbox') item.checked = Boolean(el.checked);
        if (el.tagName === 'BUTTON' || el.type === 'submit' || el.type === 'button' || el.getAttribute('role') === 'option') item.label = clean(item.aria_label || el.innerText || el.value, 100);
        return item;
      });
    const sections = Array.from(document.querySelectorAll('h1,h2,h3,h4,legend,[data-qa*=section]'))
      .filter(visible).slice(0, 60).map(el => clean(el.innerText || el.getAttribute('aria-label'), 100)).filter(Boolean);
    const qaNodes = Array.from(document.querySelectorAll('[data-qa]'));
    const qa_elements = qaNodes.slice(0, 300).map(el => ({
      tag: el.tagName.toLowerCase(), qa: clean(el.getAttribute('data-qa'), 100), id: clean(el.id, 100),
      role: clean(el.getAttribute('role'), 40), visible: visible(el),
      input_count: el.querySelectorAll('input').length, button_count: el.querySelectorAll('button').length,
    }));
    const fetchJson = async path => { const r = await fetch(path, { credentials: 'same-origin' }); return r.ok ? await r.json() : { __http_status: r.status }; };
    const appJson = await fetchJson('/console/api/application/' + gameId);
    const app = appJson?.data;
    if (!app || String(app.id) !== gameId || !app.draft) return { ok: false, reason: 'application_not_found' };
    const draft = app.draft;
    const typeOf = value => Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const shape = (value, depth = 0) => {
      const out = { type: typeOf(value) };
      if (Array.isArray(value)) { out.count = Math.min(value.length, 100); if (depth < 2) out.items = value.slice(0, 2).map(v => shape(v, depth + 1)); }
      else if (value && typeof value === 'object') { out.keys = Object.keys(value).slice(0, 50); if (depth < 2) out.fields = Object.fromEntries(out.keys.map(k => [k, shape(value[k], depth + 1)])); }
      return out;
    };
    const idLabel = value => {
      const rows = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
      return rows.slice(0, 100).map(row => ({ id: clean(row?.id ?? row?.value, 80), label: clean(row?.label ?? row?.name ?? row?.title, 100) }));
    };
    const categories = await fetchJson('/console/api/categories?lang=ru&app-type=html5-game');
    const tags = await fetchJson('/console/api/tags?lang=ru');
    const unwrap = value => value?.data ?? value?.items ?? value;
    const relevant = {};
    for (const key of ['screenshots','videos','categories','tags','features']) if (Object.hasOwn(draft, key)) relevant[key] = shape(draft[key]);
    relevant.selected_categories = idLabel(draft.categories);
    relevant.selected_tags = idLabel(draft.tags);
    const activeLocale = Array.from(document.querySelectorAll('.gc-adaptive-tabs__tab_active'))[0]?.firstElementChild?.getAttribute('title') || null;
    return { ok: true, game_id: gameId, active_locale: clean(activeLocale, 50), form: { control_count: controlNodes.length, controls, sections, qa_count: qaNodes.length, qa_elements }, draft: relevant,
      catalogs: { categories: { shape: shape(unwrap(categories)), items: idLabel(unwrap(categories)) }, tags: { shape: shape(unwrap(tags)), items: idLabel(unwrap(tags)) } } };
  }`;
}

async function ensureLocale(playwright, gameId, language, draft) {
  if (!draft.fields?.features?.languages?.includes(language) || !Object.hasOwn(draft.completeness ?? {}, language)) {
    throw new Error(`Language ${language} is not present in this draft`);
  }
  const label = LOCALE_LABELS[language];
  const tabs = await evaluate(playwright, `() => Array.from(document.querySelectorAll('.gc-adaptive-tabs__tab'))
    .map(el => ({ label: el.firstElementChild?.getAttribute('title') ?? '',
      active: el.classList.contains('gc-adaptive-tabs__tab_active') }))`);
  if (tabs.filter(tab => tab.label === label).length !== 1 || tabs.filter(tab => tab.active).length !== 1) {
    throw new Error('Draft language tabs are missing or ambiguous');
  }
  if (!tabs.some(tab => tab.label === label && tab.active)) {
    await ensureDraftPage(playwright, gameId);
    resultText(await playwright.call('browser_click', {
      target: `.gc-adaptive-tabs__tab > div[title=${JSON.stringify(label)}]`, element: `${label} draft language tab`,
    }));
  }
  const active = await evaluate(playwright, `() => Array.from(document.querySelectorAll('.gc-adaptive-tabs__tab_active'))
    .map(el => el.firstElementChild?.getAttribute('title') ?? '')`);
  if (active.length !== 1 || active[0] !== label) throw new Error(`Could not confirm active language ${language}`);
}

async function saveButtonState(playwright) {
  return evaluate(playwright, `() => {
    const buttons = Array.from(document.querySelectorAll('button')).filter(el => el.innerText.trim() === 'Сохранить');
    return { count: buttons.length, enabled: buttons.filter(el => !el.disabled).length,
      disabled: buttons.length !== 1 || buttons[0].disabled };
  }`);
}

async function updateLocalizedFields(gameId, language, fields, playwright) {
  const names = assertLocalizedFields(fields);
  const before = await openDraft(playwright, gameId);
  await ensureLocale(playwright, gameId, language, before);
  const selectors = Object.fromEntries(names.map(name => [TEXT_FIELD_SELECTORS[name](gameId), localizedValue(before, name, language)]));
  const formBefore = await evaluate(playwright, `() => {
    const expected = ${JSON.stringify(selectors)};
    return Object.entries(expected).map(([selector, value]) => {
      const matches = document.querySelectorAll(selector);
      return { selector, count: matches.length, tag: matches[0]?.tagName ?? null,
        actual: matches[0]?.value ?? null, expected: value };
    });
  }`);
  if (formBefore.some(item => item.count !== 1 || !['INPUT', 'TEXTAREA'].includes(item.tag)
    || item.actual !== item.expected)) throw new Error('Localized form does not match the saved draft');
  const changedNames = names.filter(name => localizedValue(before, name, language) !== fields[name]);
  if (!changedNames.length) return { ok: true, action: 'update_localized_fields', game_id: gameId,
    language, saved: true, verified: true, fields, changed_fields: [] };
  resultText(await playwright.call('browser_fill_form', { fields: changedNames.map(name => ({
    name, type: 'textbox', target: TEXT_FIELD_SELECTORS[name](gameId), value: fields[name],
  })) }));
  const expected = Object.fromEntries(changedNames.map(name => [TEXT_FIELD_SELECTORS[name](gameId), fields[name]]));
  const formAfter = await evaluate(playwright, `() => Object.entries(${JSON.stringify(expected)})
    .map(([selector, value]) => ({ selector, actual: document.querySelector(selector)?.value ?? null, expected: value }))`);
  if (formAfter.some(item => item.actual !== item.expected)) throw new Error('Localized form values did not match; nothing was saved');
  const saveState = await saveButtonState(playwright);
  if (saveState.count !== 1 || saveState.disabled) {
    resultText(await playwright.call('browser_fill_form', { fields: changedNames.map(name => ({
      name, type: 'textbox', target: TEXT_FIELD_SELECTORS[name](gameId),
      value: localizedValue(before, name, language),
    })) }));
    const restored = await evaluate(playwright, `() => Object.entries(${JSON.stringify(selectors)})
      .map(([selector, expected]) => ({ actual: document.querySelector(selector)?.value ?? null, expected }))`);
    const confirmed = restored.every(item => item.actual === item.expected);
    return { ok: false, action: 'update_localized_fields', game_id: gameId, language,
      saved: false, restored: confirmed ? true : 'unknown',
      reason: confirmed ? 'save button is unavailable; previous form values were restored and verified'
        : 'save button is unavailable; restoring previous form values could not be verified' };
  }
  await ensureDraftPage(playwright, gameId);
  const activeBeforeSave = await evaluate(playwright, `() => Array.from(document.querySelectorAll('.gc-adaptive-tabs__tab_active'))
    .map(el => el.firstElementChild?.getAttribute('title') ?? '')`);
  if (activeBeforeSave.length !== 1 || activeBeforeSave[0] !== LOCALE_LABELS[language]) {
    throw new Error('Draft language changed before save; nothing was saved');
  }
  resultText(await playwright.call('browser_click', { target: 'button:has-text("Сохранить")', element: 'кнопка сохранения черновика' }));
  await playwright.call('browser_wait_for', { time: 2 });
  const after = await evaluate(playwright, applicationExpression(gameId));
  if (!after.ok) return { ok: false, action: 'update_localized_fields', game_id: gameId, language,
    saved: 'unknown', reason: 'could not read the draft after save' };
  const verified = Object.fromEntries(names.map(name => [name, localizedValue(after, name, language)]));
  const mismatches = names.filter(name => verified[name] !== fields[name]);
  return { ok: !mismatches.length, action: 'update_localized_fields', game_id: gameId,
    language, saved: mismatches.length ? 'unknown' : true,
    verified: !mismatches.length, fields: verified, changed_fields: changedNames,
    ...(mismatches.length ? { reason: 'saved values did not match the request', mismatched_fields: mismatches } : {}) };
}

async function updateTextFields(gameId, fields, playwright) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('fields must be an object');
  const names = Object.keys(fields);
  if (names.length === 0) throw new Error('at least one field is required');
  for (const name of names) {
    if (!Object.hasOwn(TEXT_FIELD_SELECTORS, name)) throw new Error(`Unsupported field: ${name}`);
    if (typeof fields[name] !== 'string') throw new Error(`${name} must be a string`);
    if (fields[name].length > TEXT_FIELD_LIMITS[name]) throw new Error(`${name} exceeds ${TEXT_FIELD_LIMITS[name]} characters`);
  }

  await openConsole(playwright);
  resultText(await playwright.call('browser_navigate', {
    url: `${CONSOLE_URL}application/${gameId}#application-info-draft`,
  }));
  resultText(await playwright.call('browser_wait_for', { text: 'Комментарий разработчика' }));
  await ensureDraftPage(playwright, gameId);
  const before = await evaluate(playwright, applicationExpression(gameId));
  if (!before.ok) throw new Error(before.reason ?? `Console returned HTTP ${before.http_status}`);
  if (names.some(name => LOCALIZED_FIELDS.includes(name))) await ensureLocale(playwright, gameId, 'ru', before);
  const changedNames = names.filter(name => !fieldValuesMatch(name, getLocalized(before, name), fields[name]));
  if (changedNames.length === 0) return { ok: true, action: 'update_fields', game_id: gameId, saved: true, verified: true, fields: Object.fromEntries(names.map(name => [name, getLocalized(before, name)])), changed_fields: [] };

  const formFields = changedNames.map(name => ({
    name, type: 'textbox', target: TEXT_FIELD_SELECTORS[name](gameId), value: fields[name],
  }));
  const selectors = Object.fromEntries(changedNames.map(name => [TEXT_FIELD_SELECTORS[name](gameId), getLocalized(before, name)]));
  const draftPage = await evaluate(playwright, `() => {
    const expected = ${JSON.stringify(selectors)};
    return Object.entries(expected).map(([selector, value]) => ({
      selector, expected: value, actual: document.querySelector(selector)?.value ?? null
    }));
  }`);
  if (draftPage.some(item => item.actual !== item.expected)) throw new Error('Form values did not match the saved draft; nothing was changed');
  resultText(await playwright.call('browser_fill_form', { fields: formFields }));
  const postFill = await evaluate(playwright, `() => Object.entries(${JSON.stringify(Object.fromEntries(changedNames.map(name => [TEXT_FIELD_SELECTORS[name](gameId), fields[name]])))})
    .map(([selector, expected]) => ({ actual: document.querySelector(selector)?.value ?? null, expected }))`);
  if (postFill.some(item => item.actual !== item.expected)) throw new Error('Form values did not match; nothing was saved');
  const saveState = await saveButtonState(playwright);
  if (saveState.count !== 1 || saveState.enabled !== 1) {
    resultText(await playwright.call('browser_fill_form', { fields: changedNames.map(name => ({
      name, type: 'textbox', target: TEXT_FIELD_SELECTORS[name](gameId), value: getLocalized(before, name) ?? '',
    })) }));
    const restored = await evaluate(playwright, `() => Object.entries(${JSON.stringify(Object.fromEntries(changedNames.map(name => [TEXT_FIELD_SELECTORS[name](gameId), getLocalized(before, name) ?? ''])))}).map(([selector, expected]) => ({ actual: document.querySelector(selector)?.value ?? null, expected }))`);
    const confirmed = restored.every(item => item.actual === item.expected);
    return { ok: false, action: 'update_fields', game_id: gameId, saved: false,
      restored: confirmed ? true : 'unknown',
      reason: confirmed ? 'Save button is unavailable; previous form values were restored and verified' : 'Save button is unavailable; restoring previous form values could not be verified' };
  }

  await ensureDraftPage(playwright, gameId);
  if (names.some(name => LOCALIZED_FIELDS.includes(name))) {
    const activeLocale = await evaluate(playwright, `() => Array.from(document.querySelectorAll('.gc-adaptive-tabs__tab_active')).map(el => el.firstElementChild?.getAttribute('title') ?? '')`);
    if (activeLocale.length !== 1 || activeLocale[0] !== LOCALE_LABELS.ru) throw new Error('Draft language changed before save; nothing was saved');
  }
  resultText(await playwright.call('browser_click', {
    target: 'button:has-text("Сохранить")', element: 'кнопка сохранения черновика',
  }));
  await playwright.call('browser_wait_for', { time: 2 });

  const after = await evaluate(playwright, applicationExpression(gameId));
  if (!after.ok) return { ok: false, action: 'update_fields', game_id: gameId, saved: 'unknown', reason: 'could not read the draft after save' };
  const verified = Object.fromEntries(names.map(name => [name, getLocalized(after, name)]));
  const mismatches = names.filter(name => !fieldValuesMatch(name, verified[name], fields[name]));
  return {
    ok: mismatches.length === 0, action: 'update_fields', game_id: gameId,
    saved: mismatches.length ? 'unknown' : true, verified: mismatches.length === 0, fields: verified, changed_fields: changedNames,
    ...(mismatches.length ? { reason: 'saved values did not match the request', mismatched_fields: mismatches } : {}),
  };
}

export async function validateZipPath(zipPath) {
  if (typeof zipPath !== 'string' || zipPath.trim() === '') throw new Error('zip_path is required');
  const candidate = path.resolve(PROJECT_ROOT, zipPath);
  let canonical;
  try { canonical = await realpath(candidate); }
  catch { throw new Error('ZIP file was not found inside the project folder'); }
  const relative = path.relative(PROJECT_ROOT, canonical);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('zip_path must point to a file inside the project folder');
  }
  if (path.extname(canonical).toLowerCase() !== '.zip') throw new Error('zip_path must be a .zip file');
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error('zip_path must be a regular file');
  if (info.size <= 0 || info.size > MAX_ARCHIVE_BYTES) throw new Error('ZIP size must be between 1 byte and 100 MiB');
  const file = await open(canonical, 'r');
  try {
    const signature = Buffer.alloc(4);
    const { bytesRead } = await file.read(signature, 0, 4, 0);
    const valid = bytesRead === 4 && signature[0] === 0x50 && signature[1] === 0x4b
      && [[0x03, 0x04], [0x05, 0x06], [0x07, 0x08]].some(([a, b]) => signature[2] === a && signature[3] === b);
    if (!valid) throw new Error('zip_path does not start with a ZIP signature');

    const tailSize = Math.min(info.size, 65557);
    const tail = Buffer.alloc(tailSize);
    const tailRead = await file.read(tail, 0, tailSize, info.size - tailSize);
    if (tailRead.bytesRead !== tailSize) throw new Error('ZIP central directory could not be read');
    const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const endOffset = tail.lastIndexOf(endSignature);
    if (endOffset < 0 || endOffset + 22 > tail.length) throw new Error('ZIP central directory is missing');
    const archiveEnd = info.size - tailSize + endOffset;
    const commentLength = tail.readUInt16LE(endOffset + 20);
    if (endOffset + 22 + commentLength !== tail.length
      || tail.readUInt16LE(endOffset + 4) !== 0
      || tail.readUInt16LE(endOffset + 6) !== 0
      || tail.readUInt16LE(endOffset + 8) !== tail.readUInt16LE(endOffset + 10)) {
      throw new Error('ZIP end record is invalid or spans multiple disks');
    }
    const entries = tail.readUInt16LE(endOffset + 10);
    const directorySize = tail.readUInt32LE(endOffset + 12);
    const directoryOffset = tail.readUInt32LE(endOffset + 16);
    if (entries === 0 || directorySize === 0 || directorySize > 16 * 1024 * 1024
      || entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff
      || directoryOffset + directorySize !== archiveEnd) throw new Error('ZIP central directory is invalid');
    const directory = Buffer.alloc(directorySize);
    const directoryRead = await file.read(directory, 0, directorySize, directoryOffset);
    if (directoryRead.bytesRead !== directorySize) throw new Error('ZIP central directory could not be read');

    let cursor = 0;
    let rootIndexFound = false;
    for (let index = 0; index < entries; index += 1) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error('ZIP entry directory is invalid');
      }
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const uncompressedSize = directory.readUInt32LE(cursor + 24);
      const localOffset = directory.readUInt32LE(cursor + 42);
      const nameEnd = cursor + 46 + nameLength;
      const entryEnd = nameEnd + extraLength + commentLength;
      if (entryEnd > directory.length || compressedSize === 0xffffffff
        || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error('ZIP entry directory is invalid');
      }
      const entryName = directory.toString('utf8', cursor + 46, nameEnd);
      if (entryName === 'index.html') rootIndexFound = true;
      if (entryName.startsWith('/') || entryName.includes('\\')
        || entryName.split('/').includes('..')) throw new Error('ZIP contains an unsafe entry path');
      if (localOffset + 30 > directoryOffset) throw new Error('ZIP local entry is missing');
      const local = Buffer.alloc(30);
      if ((await file.read(local, 0, 30, localOffset)).bytesRead !== 30
        || local.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP local entry is missing');
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset + compressedSize > directoryOffset) throw new Error('ZIP entry data is incomplete');
      const localName = Buffer.alloc(localNameLength);
      if ((await file.read(localName, 0, localNameLength, localOffset + 30)).bytesRead !== localNameLength
        || !localName.equals(directory.subarray(cursor + 46, nameEnd))) {
        throw new Error('ZIP local entry name does not match the directory');
      }
      cursor = entryEnd;
    }
    if (cursor !== directory.length) throw new Error('ZIP central directory has trailing data');
    if (!rootIndexFound) throw new Error('ZIP must contain index.html at its root');
  } finally {
    await file.close();
  }
  return canonical;
}

async function uploadBuild(gameId, zipPath, playwright) {
  const archive = await validateZipPath(zipPath);
  await openConsole(playwright);
  resultText(await playwright.call('browser_navigate', {
    url: `${CONSOLE_URL}application/${gameId}#application-info-draft`,
  }));
  resultText(await playwright.call('browser_wait_for', { text: 'Заменить архив' }));
  await ensureDraftPage(playwright, gameId);
  const before = await evaluate(playwright, applicationExpression(gameId));
  if (!before.ok) throw new Error(before.reason ?? `Console returned HTTP ${before.http_status}`);

  resultText(await playwright.call('browser_click', {
    target: 'button:has-text("Заменить архив")', element: 'кнопка замены архива игры',
  }));
  resultText(await playwright.call('browser_file_upload', { paths: [archive] }));

  let uploadedFileId = null;
  let saveState = null;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await playwright.call('browser_wait_for', { time: 2 });
    const formState = await evaluate(playwright, `() => {
      const link = Array.from(document.querySelectorAll('a[href*="/console/api/files/archive?file-id="]'))[0];
      const match = link?.href.match(/[?&]file-id=([0-9]+)/);
      const button = Array.from(document.querySelectorAll('button')).find(el => el.innerText.trim() === 'Сохранить');
      return { file_id: match?.[1] ?? null, save_found: Boolean(button), save_disabled: !button || button.disabled };
    }`);
    if (formState.file_id && String(formState.file_id) !== String(before.build.file_id)) {
      uploadedFileId = String(formState.file_id);
      saveState = { found: formState.save_found, disabled: formState.save_disabled };
      break;
    }
  }
  if (!uploadedFileId) {
    const unchanged = await evaluate(playwright, applicationExpression(gameId));
    return {
      ok: false, action: 'upload_build', game_id: gameId, uploaded: 'unknown', saved: false,
      old_file_id: before.build.file_id,
      new_file_id: unchanged.ok ? unchanged.build.file_id : null,
      build: unchanged.ok ? unchanged.build : null,
      reason: 'upload outcome is not confirmed; inspect the draft before retrying',
    };
  }

  if (!saveState.found || saveState.disabled) {
    return {
      ok: false, action: 'upload_build', game_id: gameId, uploaded: true, saved: false,
      old_file_id: before.build.file_id, new_file_id: uploadedFileId,
      reason: 'archive uploaded, but draft save is unavailable; inspect the draft before retrying',
    };
  }
  await ensureDraftPage(playwright, gameId);
  resultText(await playwright.call('browser_click', {
    target: 'button:has-text("Сохранить")', element: 'кнопка сохранения черновика',
  }));
  await playwright.call('browser_wait_for', { time: 2 });
  const savedDraft = await evaluate(playwright, applicationExpression(gameId));
  const saved = savedDraft.ok && String(savedDraft.build.file_id) === uploadedFileId;
  return {
    ok: Boolean(saved), action: 'upload_build', game_id: gameId, uploaded: true,
    saved: saved ? true : 'unknown',
    old_file_id: before.build.file_id, new_file_id: savedDraft.ok ? savedDraft.build.file_id : null,
    build: savedDraft.ok ? savedDraft.build : null,
    ...(!saved ? { reason: 'archive uploaded, but the saved draft did not confirm its file ID' } : {}),
  };
}

async function uploadDraftMedia(gameId, language, requested, replaceExisting, playwright) {
  const kinds = Object.keys(requested);
  if (!kinds.length) throw new Error('icon_path or cover_path is required');
  const files = {};
  for (const kind of kinds) {
    if (!Object.hasOwn(MEDIA_INPUTS, kind)) throw new Error(`Unsupported media kind: ${kind}`);
    const metadata = await validateMediaPath(kind, requested[kind]);
    files[kind] = { absolute: path.resolve(PROJECT_ROOT, metadata.path), basename: path.basename(metadata.path), metadata };
  }
  const before = await openDraft(playwright, gameId);
  await ensureLocale(playwright, gameId, language, before);
  const oldFileIds = Object.fromEntries(kinds.map(kind => [kind, before.media?.[kind]?.[language] ?? null]));
  if (kinds.some(kind => oldFileIds[kind] !== null) && !replaceExisting) {
    throw new Error('replace_existing=true is required to replace saved draft media');
  }
  const controls = await evaluate(playwright, `() => {
    const expected = ${JSON.stringify(kinds.map(kind => ({ kind, input: MEDIA_INPUTS[kind](gameId), button: MEDIA_BUTTONS[kind](gameId) })))};
    return expected.map(item => {
      const inputs = document.querySelectorAll(item.input), buttons = document.querySelectorAll(item.button);
      const markers = document.querySelectorAll('[data-qa="' + item.kind + '-field"] .form-attach__close[data-file-id]');
      return { kind: item.kind, inputs: inputs.length, buttons: buttons.length,
        inputName: inputs[0]?.name ?? null, accept: inputs[0]?.accept ?? null,
        buttonText: buttons[0]?.innerText.trim() ?? null,
        markers: markers.length, fileId: markers[0]?.getAttribute('data-file-id') ?? null };
    });
  }`);
  if (controls.some(item => oldFileIds[item.kind] === null
    ? item.inputs !== 1 || item.buttons !== 1 || item.markers !== 0
      || item.inputName !== `${item.kind}-field` || item.accept !== 'image/png'
      || item.buttonText !== 'Выбрать файл'
    : item.inputs !== 0 || item.buttons !== 0 || item.markers !== 1
      || String(item.fileId) !== String(oldFileIds[item.kind]))) {
    throw new Error('Media upload controls are missing or ambiguous');
  }
  const selectedFileIds = {};
  for (const kind of kinds) {
    await ensureDraftPage(playwright, gameId);
    const activeBeforeUpload = await evaluate(playwright, `() => Array.from(document.querySelectorAll('.gc-adaptive-tabs__tab_active'))
      .map(el => el.firstElementChild?.getAttribute('title') ?? '')`);
    if (activeBeforeUpload.length !== 1 || activeBeforeUpload[0] !== LOCALE_LABELS[language]) {
      throw new Error('Draft language changed before media upload; nothing was saved');
    }
    if (oldFileIds[kind] !== null) {
      resultText(await playwright.call('browser_click', {
        target: `[data-qa="${kind}-field"] .form-attach__close[data-file-id="${oldFileIds[kind]}"]`,
        element: `${kind} previous media removal from draft form`,
      }));
      const replacement = await evaluate(playwright, `() => {
        const input = document.querySelectorAll(${JSON.stringify(MEDIA_INPUTS[kind](gameId))});
        const button = document.querySelectorAll(${JSON.stringify(MEDIA_BUTTONS[kind](gameId))});
        const markers = document.querySelectorAll(${JSON.stringify(`[data-qa="${kind}-field"] .form-attach__close[data-file-id]`)});
        return { inputs: input.length, buttons: button.length, markers: markers.length,
          name: input[0]?.name ?? null, accept: input[0]?.accept ?? null,
          buttonText: button[0]?.innerText.trim() ?? null };
      }`);
      if (replacement.inputs !== 1 || replacement.buttons !== 1 || replacement.markers !== 0
        || replacement.name !== `${kind}-field` || replacement.accept !== 'image/png'
        || replacement.buttonText !== 'Выбрать файл') {
        return { ok: false, action: 'upload_draft_media', game_id: gameId, language,
          saved: false, selected_file_ids: selectedFileIds,
          reason: `${kind} replacement control did not appear; inspect draft before retrying` };
      }
    }
    resultText(await playwright.call('browser_click', {
      target: MEDIA_BUTTONS[kind](gameId), element: `${kind} PNG upload button`,
    }));
    resultText(await playwright.call('browser_file_upload', { paths: [files[kind].absolute] }));
    let preview = null;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      preview = await evaluate(playwright, `() => {
        const fields = document.querySelectorAll(${JSON.stringify(`[data-qa="${kind}-field"]`)});
        const markers = fields[0]?.querySelectorAll('.form-attach__close[data-file-id]') ?? [];
        return { fields: fields.length, count: markers.length,
          file_id: markers[0]?.getAttribute('data-file-id') ?? null,
          error: fields[0]?.querySelector('.form-attach__errors')?.innerText.trim() ?? '' };
      }`);
      if (preview.fields === 1 && preview.count === 1 && /^\d+$/.test(preview.file_id ?? '')
        && String(preview.file_id) !== String(oldFileIds[kind])) break;
      if (preview.error || preview.fields !== 1 || preview.count > 1) break;
      if (attempt < 14) await playwright.call('browser_wait_for', { time: 2 });
    }
    if (preview.fields !== 1 || preview.count !== 1 || !/^\d+$/.test(preview.file_id ?? '')
      || String(preview.file_id) === String(oldFileIds[kind])) {
      return { ok: false, action: 'upload_draft_media', game_id: gameId, language,
        uploaded: 'unknown', saved: false, selected_file_ids: selectedFileIds,
        reason: preview.error || `${kind} upload preview did not confirm a file ID; inspect draft before retrying` };
    }
    selectedFileIds[kind] = preview.file_id;
  }
  let saveState = null;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    saveState = await saveButtonState(playwright);
    if (saveState.count === 1 && !saveState.disabled) break;
    if (attempt < 14) await playwright.call('browser_wait_for', { time: 2 });
  }
  if (saveState.count !== 1 || saveState.disabled) {
    return { ok: false, action: 'upload_draft_media', game_id: gameId, language,
      uploaded: true, saved: false, selected_file_ids: selectedFileIds,
      reason: 'media selected, but draft save is unavailable; inspect draft before retrying' };
  }
  await ensureDraftPage(playwright, gameId);
  const activeBeforeSave = await evaluate(playwright, `() => Array.from(document.querySelectorAll('.gc-adaptive-tabs__tab_active'))
    .map(el => el.firstElementChild?.getAttribute('title') ?? '')`);
  if (activeBeforeSave.length !== 1 || activeBeforeSave[0] !== LOCALE_LABELS[language]) {
    throw new Error('Draft language changed before save; nothing was saved');
  }
  resultText(await playwright.call('browser_click', { target: 'button:has-text("Сохранить")', element: 'кнопка сохранения черновика' }));
  await playwright.call('browser_wait_for', { time: 2 });
  const after = await evaluate(playwright, applicationExpression(gameId));
  if (!after.ok) return { ok: false, action: 'upload_draft_media', game_id: gameId,
    language, uploaded: true, saved: 'unknown', selected_file_ids: selectedFileIds,
    reason: 'could not read the draft after save' };
  const newFileIds = Object.fromEntries(kinds.map(kind => [kind, after.media?.[kind]?.[language] ?? null]));
  const mismatches = kinds.filter(kind => !newFileIds[kind]
    || String(newFileIds[kind]) !== selectedFileIds[kind]
    || String(newFileIds[kind]) === String(oldFileIds[kind]));
  return { ok: !mismatches.length, action: 'upload_draft_media', game_id: gameId, language,
    uploaded: true, saved: mismatches.length ? 'unknown' : true, verified: !mismatches.length, old_file_ids: oldFileIds,
    selected_file_ids: selectedFileIds, new_file_ids: newFileIds,
    media: Object.fromEntries(kinds.map(kind => [kind, files[kind].metadata])),
    ...(mismatches.length ? { reason: 'saved draft did not confirm new media file IDs', mismatched_media: mismatches } : {}) };
}

async function uploadDraftScreenshot(gameId, language, screenshotPath, playwright) {
  const metadata = await validateScreenshotPath(screenshotPath);
  if (metadata.width <= metadata.height) throw new Error('Desktop landscape screenshot must be wider than it is tall');
  const absolute = path.resolve(PROJECT_ROOT, metadata.path);
  const before = await openDraft(playwright, gameId);
  await ensureLocale(playwright, gameId, language, before);
  const oldIds = (before.media?.screenshots?.files ?? []).map(item => String(item.file_id));
  const inputSelector = `#screenshots-desktop${gameId}`;
  const buttonSelector = `#uploader-screenshots-desktop${gameId}`;
  // The wrapper div and its file input both carry this data-qa.
  const containerSelector = 'div[data-qa="screenshots-desktop"]';
  const readForm = async () => evaluate(playwright, `() => {
    const inputs = document.querySelectorAll(${JSON.stringify(inputSelector)});
    const buttons = document.querySelectorAll(${JSON.stringify(buttonSelector)});
    const containers = document.querySelectorAll(${JSON.stringify(containerSelector)});
    const markers = containers[0]?.querySelectorAll('.form-attach__close[data-file-id]') ?? [];
    const platform = document.querySelectorAll('[data-qa="screenshotsPlatform"] button');
    const orientation = document.querySelectorAll('[data-qa="desktop.visual-instructions-orientation"] button');
    const active = document.querySelectorAll('.gc-adaptive-tabs__tab_active');
    return { input_count: inputs.length, input_name: inputs[0]?.name ?? null, accept: inputs[0]?.accept ?? null,
      button_count: buttons.length, button_text: buttons[0]?.innerText.trim() ?? null,
      container_count: containers.length,
      marker_ids: Array.from(markers).map(el => el.getAttribute('data-file-id')),
      error: containers[0]?.querySelector('.form-attach__errors')?.innerText.trim() ?? '',
      platform_count: platform.length, platform_text: platform[0]?.innerText.trim() ?? null,
      orientation_count: orientation.length, orientation_text: orientation[0]?.innerText.trim() ?? null,
      active_locale: active.length === 1 ? active[0].firstElementChild?.getAttribute('title') ?? null : null };
  }`);
  const validContext = state => state.container_count === 1 && state.platform_count === 1
    && state.platform_text === 'Десктопные' && state.orientation_count === 1
    && state.orientation_text === 'Альбомная' && state.active_locale === LOCALE_LABELS[language];
  const formBefore = await readForm();
  if (!validContext(formBefore) || formBefore.input_count !== 1 || formBefore.button_count !== 1
    || formBefore.input_name !== 'screenshots-desktop'
    || formBefore.accept !== 'image/jpeg, image/png' || formBefore.button_text !== 'Выбрать файл'
    || formBefore.marker_ids.some(id => !oldIds.includes(String(id)))
    || new Set(formBefore.marker_ids).size !== formBefore.marker_ids.length) {
    throw new Error(`Screenshot controls or existing attachments are ambiguous; nothing was uploaded. Form: ${JSON.stringify(formBefore).slice(0, 1200)}`);
  }
  await ensureDraftPage(playwright, gameId);
  resultText(await playwright.call('browser_click', {
    target: buttonSelector, element: 'desktop landscape screenshot upload button',
  }));
  resultText(await playwright.call('browser_file_upload', { paths: [absolute] }));
  let preview;
  let newId = null;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    preview = await readForm();
    const newIds = preview.marker_ids.filter(id => /^\d+$/.test(String(id)) && !formBefore.marker_ids.includes(id));
    if (validContext(preview) && newIds.length === 1 && !preview.error) { newId = String(newIds[0]); break; }
    if (preview.error || !validContext(preview) || newIds.length > 1) break;
    if (attempt < 14) await playwright.call('browser_wait_for', { time: 2 });
  }
  if (!newId) return { ok: false, action: 'upload_draft_screenshot', game_id: gameId, language,
    uploaded: 'unknown', saved: false, reason: preview?.error || 'Screenshot preview did not confirm one new file ID; inspect draft before retrying' };
  const saveState = await saveButtonState(playwright);
  const beforeSave = await readForm();
  if (saveState.count !== 1 || saveState.disabled || !validContext(beforeSave)
    || beforeSave.marker_ids.filter(id => id === newId).length !== 1) {
    return { ok: false, action: 'upload_draft_screenshot', game_id: gameId, language,
      uploaded: true, saved: false, selected_file_id: newId,
      reason: 'Screenshot selected, but draft save is unavailable or form changed; inspect draft before retrying' };
  }
  await ensureDraftPage(playwright, gameId);
  resultText(await playwright.call('browser_click', { target: 'button:has-text("Сохранить")', element: 'кнопка сохранения черновика' }));
  await playwright.call('browser_wait_for', { time: 2 });
  const after = await evaluate(playwright, applicationExpression(gameId));
  const newFiles = after.ok ? after.media?.screenshots?.files ?? [] : [];
  const newIds = newFiles.map(item => String(item.file_id));
  const verified = after.ok && newIds.includes(newId) && oldIds.every(id => newIds.includes(id));
  return { ok: Boolean(verified), action: 'upload_draft_screenshot', game_id: gameId, language,
    uploaded: true, saved: verified ? true : 'unknown', verified: Boolean(verified),
    selected_file_id: newId, saved_screenshots: after.ok ? after.media?.screenshots ?? null : null,
    file: metadata,
    ...(!verified ? { reason: 'Saved draft did not confirm the screenshot file ID; inspect draft before retrying' } : {}) };
}


export async function invokeDomainTool(name, args = {}, playwright) {
  try {
    switch (name) {
      case 'inspect_console': {
        await openConsole(playwright);
        return asResult({ ok: true, action: name, ...(await getOverview(playwright)) });
      }
      case 'list_games': {
        await openConsole(playwright);
        const games = await readVisibleGames(playwright);
        if (!games.length) return asError(name, 'games_table_unavailable_or_empty');
        return asResult({ ok: true, action: name, games });
      }
      case 'inspect_draft_form': {
        const gameId = assertGameId(args.game_id);
        const draft = await openDraft(playwright, gameId);
        if (args.language !== undefined) await ensureLocale(playwright, gameId, assertLanguage(args.language), draft);
        const data = await evaluate(playwright, draftFormExpression(gameId));
        if (!data.ok) return asError(name, data.reason ?? 'form_unavailable');
        return asResult({ ...data, action: name });
      }
      case 'get_draft': {
        const gameId = assertGameId(args.game_id);
        await openConsole(playwright);
        const data = await evaluate(playwright, applicationExpression(gameId));
        if (!data.ok) return asError(name, data.reason ?? `Console returned HTTP ${data.http_status}`);
        return asResult({ ...data, action: name });
      }
      case 'check_draft': {
        const gameId = assertGameId(args.game_id);
        await openConsole(playwright);
        const data = await evaluate(playwright, applicationExpression(gameId));
        if (!data.ok) return asError(name, data.reason ?? `Console returned HTTP ${data.http_status}`);
        return asResult(summarizeDraftChecks(data));
      }
      case 'check_media_files': {
        const paths = [['icon', args.icon_path], ['cover', args.cover_path]].filter(([, filePath]) => filePath !== undefined);
        if (!paths.length) throw new Error('icon_path or cover_path is required');
        const files = {};
        for (const [kind, filePath] of paths) {
          try { files[kind] = { ok: true, ...(await validateMediaPath(kind, filePath)) }; }
          catch (error) { files[kind] = { ok: false, reason: error instanceof Error ? error.message : 'validation failed' }; }
        }
        return asResult({ ok: Object.values(files).every(file => file.ok), action: name, files });
      }
      case 'get_moderation_feedback': {
        const gameId = assertGameId(args.game_id);
        await openConsole(playwright);
        const app = await evaluate(playwright, applicationSummaryExpression(gameId));
        if (!app.ok) return asError(name, app.reason ?? `Console returned HTTP ${app.http_status}`);
        const moderation = await evaluate(playwright, moderationExpression(gameId));
        if (!moderation.ok) return asError(name, `Moderation history returned HTTP ${moderation.http_status}`);
        let listing;
        if (app.release_type === 'unknown' || !Object.keys(app.title ?? {}).length) {
          listing = (await readVisibleGames(playwright)).find(game => game.game_id === gameId);
        }
        const listedAsPublished = listing?.status === 'Опубликовано' || listing?.status === 'Published';
        const title = Object.keys(app.title ?? {}).length ? app.title : listing ? { ru: listing.title } : {};
        return asResult({ ok: true, action: name, game_id: gameId, title,
          release_type: listedAsPublished ? 'published' : app.release_type,
          release_status: app.release_status, listing_status: listing?.status ?? null,
          build: app.build,
          moderation_history: moderation.history });
      }
      case 'update_fields': {
        const gameId = assertGameId(args.game_id);
        const result = await updateTextFields(gameId, args.fields, playwright);
        return asResult(result);
      }
      case 'update_localized_fields': {
        const gameId = assertGameId(args.game_id);
        const language = assertLanguage(args.language);
        return asResult(await updateLocalizedFields(gameId, language, args.fields, playwright));
      }
      case 'upload_draft_media': {
        const gameId = assertGameId(args.game_id);
        const language = assertLanguage(args.language);
        if (args.replace_existing !== undefined && typeof args.replace_existing !== 'boolean') {
          throw new Error('replace_existing must be a boolean');
        }
        const requested = Object.fromEntries([['icon', args.icon_path], ['cover', args.cover_path]]
          .filter(([, filePath]) => filePath !== undefined));
        return asResult(await uploadDraftMedia(gameId, language, requested, args.replace_existing === true, playwright));
      }
      case 'upload_draft_screenshot': {
        const gameId = assertGameId(args.game_id);
        const language = assertLanguage(args.language);
        return asResult(await uploadDraftScreenshot(gameId, language, args.screenshot_path, playwright));
      }
      case 'update_draft_classification': {
        const gameId = assertGameId(args.game_id);
        await openDraft(playwright, gameId);
        return asResult(await updateDraftClassification(gameId, args, playwright));
      }
      case 'update_draft_age_rating': {
        const gameId = assertGameId(args.game_id);
        await openDraft(playwright, gameId);
        return asResult(await updateDraftAgeRating(gameId, args.age_rating, playwright));
      }
      case 'upload_build': {
        const gameId = assertGameId(args.game_id);
        const result = await uploadBuild(gameId, args.zip_path, playwright);
        return asResult(result);
      }
      default:
        return asError(name, 'Unknown tool');
    }
  } catch (error) {
    return asError(name, error instanceof Error ? error.message : 'unexpected error');
  }
}
