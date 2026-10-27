const gameIdSchema = { type: 'string', pattern: '^[0-9]+$' };
const localizedNames = {
  type: 'object', minProperties: 1, properties: { ru: { type: 'string', minLength: 1, maxLength: 30 } },
  patternProperties: { '^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$': { type: 'string', minLength: 1, maxLength: 30 } },
  additionalProperties: false,
};

export const leaderboardToolDefinitions = [
  { name: 'inspect_leaderboard_form', description: 'Inspect visible leaderboard edit entries, form settings and displayed warning text for one exact application. Read-only.',
    inputSchema: { type: 'object', properties: { game_id: gameIdSchema }, required: ['game_id'], additionalProperties: false } },
  { name: 'list_leaderboards', description: 'List visible leaderboard edit entries for one exact application. Read-only.',
    inputSchema: { type: 'object', properties: { game_id: gameIdSchema }, required: ['game_id'], additionalProperties: false } },
  { name: 'get_leaderboard', description: 'Read settings for one exact technical leaderboard name. Read-only.',
    inputSchema: { type: 'object', properties: { game_id: gameIdSchema, technical_name: { type: 'string', pattern: '^[A-Za-z0-9]{1,100}$' } }, required: ['game_id', 'technical_name'], additionalProperties: false } },
  { name: 'create_leaderboard', description: 'Create a leaderboard on one exact application and verify the saved settings.',
    inputSchema: { type: 'object', properties: { game_id: gameIdSchema, technical_name: { type: 'string', pattern: '^[A-Za-z0-9]{1,100}$' },
      names: localizedNames, primary: { type: 'boolean' }, result_type: { type: 'string', enum: ['numeric', 'time'] },
      sort_order: { type: 'string', enum: ['descending', 'ascending'] }, decimals: { type: 'integer', minimum: 0 } },
    required: ['game_id', 'technical_name', 'names', 'primary', 'result_type', 'sort_order'], additionalProperties: false } },
  { name: 'update_leaderboard', description: 'Update only technical name, localized display names and primary status; verify saved settings.',
    inputSchema: { type: 'object', properties: { game_id: gameIdSchema, technical_name: { type: 'string', pattern: '^[A-Za-z0-9]{1,100}$' },
      new_technical_name: { type: 'string', pattern: '^[A-Za-z0-9]{1,100}$' }, names: localizedNames, primary: { type: 'boolean' } },
    required: ['game_id', 'technical_name'], additionalProperties: false } },
  { name: 'delete_leaderboard', description: 'Delete one exact leaderboard after matching its technical name in the Console confirmation dialog.',
    inputSchema: { type: 'object', properties: { game_id: gameIdSchema,
      technical_name: { type: 'string', pattern: '^[A-Za-z0-9]{1,100}$' },
      confirm_technical_name: { type: 'string', pattern: '^[A-Za-z0-9]{1,100}$' } },
    required: ['game_id', 'technical_name', 'confirm_technical_name'], additionalProperties: false } },
];

const result = (data, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) });

function decode(resultValue) {
  if (resultValue?.isError) throw new Error('browser tool failed');
  const text = (resultValue?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  const section = text.includes('### Result') ? text.split('### Result', 2)[1].split(/\n### /, 1)[0].trim() : text.trim();
  try {
    const value = JSON.parse(section);
    if (typeof value === 'string' && value.startsWith('YGJSON:')) return JSON.parse(value.slice(7));
  } catch { /* Playwright may return a quoted JSON value or plain text. */ }
  const at = section.indexOf('YGJSON:');
  if (at < 0) throw new Error('unexpected browser response');
  return JSON.parse(section.slice(at + 7).split(/\r?\n/)[0].trim());
}

async function evaluate(browser, expression) {
  return decode(await browser.call('browser_evaluate', {
    function: `async () => 'YGJSON:' + JSON.stringify(await (${expression})())`,
  }));
}

const boundedInspectionExpression = `() => {
  const visible = el => Boolean(el.getClientRects().length);
  const clean = value => String(value ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const tabElements = Array.from(document.querySelectorAll('a,button,[role="tab"]')).filter(visible);
  const cleanText = el => clean(el.innerText || el.getAttribute('aria-label'));
  const exactLeaderboardTabs = tabElements.filter(el => cleanText(el) === 'Лидерборды').slice(0, 10).map(el => {
    const href = el instanceof HTMLAnchorElement ? new URL(el.href) : null;
    return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'),
      href: href && href.origin === location.origin ? (href.pathname + href.hash).slice(0, 240) : null,
      selected: el.getAttribute('aria-selected') === 'true' };
  });
  const tabs = tabElements.slice(0, 100).map(el => {
    const href = el instanceof HTMLAnchorElement ? new URL(el.href) : null;
    return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), text: clean(el.innerText || el.getAttribute('aria-label')),
      href: href && href.origin === location.origin ? (href.pathname + href.hash).slice(0, 240) : null,
      selected: el.getAttribute('aria-selected') === 'true' };
  });
  const controls = Array.from(document.querySelectorAll('input,textarea,select,button,[role="checkbox"],[role="radio"]')).filter(visible).slice(0, 100).map(el => ({
    tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', role: el.getAttribute('role'),
    name: clean(el.getAttribute('name')), label: clean(el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder')),
    checked: 'checked' in el ? Boolean(el.checked) : el.getAttribute('aria-checked'), disabled: Boolean(el.disabled)
  }));
  const headings = Array.from(document.querySelectorAll('h1,h2,h3')).filter(visible).slice(0, 30).map(el => clean(el.innerText));
  const main = Array.from(document.querySelectorAll('main,[role="main"]')).find(visible);
  const main_control_count = main ? Array.from(main.querySelectorAll('input,textarea,select,button,[role="checkbox"],[role="radio"]')).filter(visible).length : 0;
  const hasDraftMarker = controls.some(control => /^(Комментарий разработчика|Developer comment)$/.test(control.label));
  const panels = Array.from(document.querySelectorAll('[role="tabpanel"],form,article')).filter(visible).slice(0, 30).map(el => ({
    tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), heading: clean(el.querySelector('h1,h2,h3')?.innerText),
    control_count: el.querySelectorAll('input,textarea,select,button,[role="checkbox"],[role="radio"]').length
  }));
  return { origin: location.origin, pathname: location.pathname, hash: location.hash, title: clean(document.title), headings, tabs,
    exact_leaderboard_tabs: exactLeaderboardTabs, controls, panels,
    main_control_count, ready: hasDraftMarker || exactLeaderboardTabs.length > 0 };
}`;

function leaderboardDetailsExpression(expectedHeading = null) {
  const expected = JSON.stringify(expectedHeading);
  return `() => {
  const visible = el => Boolean(el.getClientRects().length);
  const clean = value => String(value ?? '').replace(/\\s+/g, ' ').trim().slice(0, 160);
  const page = { origin: location.origin, pathname: location.pathname, hash: location.hash };
  const blocks = Array.from(document.querySelectorAll('.application-block')).filter(visible);
  const header = block => Array.from(block.querySelectorAll('h1,h2,h3')).filter(visible).map(el => clean(el.innerText));
  const formRoots = blocks.filter(block => header(block).includes(${expected})
    && Array.from(block.querySelectorAll('button[aria-label="Сохранить"]')).some(visible));
  const formRoot = formRoots.length === 1 ? formRoots[0] : null;
  const saveButtons = Array.from(formRoot?.querySelectorAll('button[aria-label="Сохранить"]') ?? []).filter(visible);
  const inputs = Array.from(formRoot?.querySelectorAll('input') ?? []).filter(visible).slice(0, 50).map(input => ({
    type: input.type || '', placeholder: clean(input.placeholder), label: clean(input.labels?.[0]?.innerText || input.getAttribute('aria-label')),
    value: ['text', 'number', 'radio'].includes(input.type) ? clean(input.value) : undefined,
    checked: input.type === 'checkbox' || input.type === 'radio' ? Boolean(input.checked) : undefined,
    disabled: Boolean(input.disabled), max_length: input.maxLength > 0 ? input.maxLength : null
  }));
  const addLocaleButtons = Array.from(formRoot?.querySelectorAll('.leaderboard-title-input__button') ?? []).filter(visible).slice(0, 50)
    .map(button => clean(button.innerText));
  const editActions = Array.from(document.querySelectorAll('h2,h3')).filter(visible).map(el => clean(el.innerText))
    .filter(text => text.startsWith('Изменение лидерборда')).slice(0, 50);
  const lockText = 'Поля нельзя редактировать т. к. вы отправили этот черновик на модерацию. Для редактирования полей надо отозвать черновик с модерации.';
  const normalizedBodyText = String(document.body?.innerText ?? '').replace(/\\s+/g, ' ');
  const locked = normalizedBodyText.includes(lockText);
  return { ...page, heading_present: header(formRoot ?? { querySelectorAll: () => [] }).includes('Добавление лидерборда'),
    form_heading: formRoot ? header(formRoot)[0] ?? null : null,
    application_block_count: blocks.length, form_root_found: Boolean(formRoot), inputs, localized_add_buttons: addLocaleButtons,
    existing_edit_actions: editActions, existing_edit_action_count: editActions.length,
    save_button_count: saveButtons.length, save_enabled: saveButtons.length === 1 && !saveButtons[0].disabled,
    warning_present: locked, warning: locked ? lockText : null };
}`;
}

async function inspectLeaderboardForm(gameId, browser) {
  if (!browser || typeof browser.call !== 'function') throw new Error('browser is unavailable');
  await browser.call('browser_navigate', { url: `https://games.yandex.ru/console/application/${gameId}#application-info-draft` });
  const draftWait = await browser.call('browser_wait_for', { text: 'Комментарий разработчика' });
  if (draftWait?.isError) throw new Error('the requested application draft did not finish loading');
  let initial = await evaluate(browser, boundedInspectionExpression);
  if (initial.origin !== 'https://games.yandex.ru' || initial.pathname !== `/console/application/${gameId}`
      || initial.hash !== '#application-info-draft')
    throw new Error('the requested application page is not open');
  for (let attempt = 0; attempt < 8 && !initial.ready; attempt += 1) {
    const waited = await browser.call('browser_wait_for', { time: 1 });
    if (waited?.isError) throw new Error('application page did not finish loading');
    initial = await evaluate(browser, boundedInspectionExpression);
    if (initial.origin !== 'https://games.yandex.ru' || initial.pathname !== `/console/application/${gameId}`
        || initial.hash !== '#application-info-draft')
      throw new Error('the requested application page is not open');
  }
  if (!initial.ready) return { ok: true, action: 'inspect_leaderboard_form', game_id: gameId, opened: false,
    reason: 'application page did not become ready before the bounded wait expired', page: initial };

  const appPath = `/console/application/${gameId}`;
  const sameApplicationPath = pathname => pathname === appPath || pathname.startsWith(`${appPath}/`);
  const matches = initial.exact_leaderboard_tabs ?? [];
  if (matches.length !== 1) return { ok: true, action: 'inspect_leaderboard_form', game_id: gameId,
    opened: false, reason: matches.length ? 'leaderboard tab is ambiguous' : 'leaderboard tab was not found', page: initial };
  const tab = matches[0];
  if (tab.tag === 'a' && (!tab.href || !sameApplicationPath(tab.href.split('#')[0])))
    return { ok: true, action: 'inspect_leaderboard_form', game_id: gameId, opened: false,
      reason: 'leaderboard tab target is outside the verified application route', page: initial };
  const target = tab.tag === 'a' ? 'a[data-qa="leaderboards"][href="#leaderboards"]'
    : tab.tag === 'button' ? 'button:has(span:text-is("Лидерборды"))'
      : '[role="tab"]:has(span:text-is("Лидерборды"))';
  const clicked = await browser.call('browser_click', { target, element: 'вкладка Лидерборды' });
  if (clicked?.isError) throw new Error('the uniquely identified leaderboard tab could not be opened');
  const page = await evaluate(browser, boundedInspectionExpression);
  if (page.origin !== 'https://games.yandex.ru' || !sameApplicationPath(page.pathname))
    throw new Error('leaderboard navigation left the requested application page');
  const opened = page.tabs.some(item => item.text === 'Лидерборды' && item.selected)
    || page.headings.includes('Лидерборды')
    || (page.hash !== initial.hash && /leaderboard/i.test(page.hash));
  if (!opened || page.hash !== '#leaderboards') return { ok: true, action: 'inspect_leaderboard_form', game_id: gameId,
    opened: false, reason: 'leaderboard tab activation was not confirmed', page };
  const details = await evaluate(browser, leaderboardDetailsExpression('Добавление лидерборда'));
  if (details.origin !== 'https://games.yandex.ru' || details.pathname !== appPath || details.hash !== '#leaderboards')
    throw new Error('leaderboard form identity changed during inspection');
  const technicalName = details.inputs.find(input => input.placeholder === 'Техническое название лидерборда') ?? null;
  const localizedNames = details.inputs.flatMap(input => {
    const match = input.placeholder.match(/^\[([^\]]+)\] Отображаемое название лидерборда$/);
    return match ? [{ language: match[1], value: input.value ?? '', max_length: input.max_length }] : [];
  });
  const decimals = details.inputs.find(input => input.placeholder === 'Размер десятичной части счета') ?? null;
  const primaryCandidates = details.inputs.filter(input => input.type === 'checkbox');
  const primary = primaryCandidates.length === 1 ? primaryCandidates[0] : null;
  const resultTypes = details.inputs.filter(input => input.type === 'radio' && ['numeric', 'time'].includes(input.value));
  const sortOrders = details.inputs.filter(input => input.type === 'radio' && ['descending', 'ascending'].includes(input.value));
  return { ok: true, action: 'inspect_leaderboard_form', game_id: gameId, opened: true,
    list: { existing_edit_actions: details.existing_edit_actions, count: details.existing_edit_action_count,
      coverage: 'visible leaderboard edit actions only' },
    form: { heading_present: details.heading_present, application_block_count: details.application_block_count,
      root_found: details.form_root_found, settings: { technical_name: technicalName,
        localized_display_names: localizedNames, primary: primary ? { checked: primary.checked, disabled: primary.disabled, label: primary.label } : null,
        result_type: { selected: resultTypes.find(input => input.checked)?.value ?? null, options: resultTypes.map(input => input.value) },
        sort_order: { selected: sortOrders.find(input => input.checked)?.value ?? null, options: sortOrders.map(input => input.value) },
        decimals: decimals ? { value: decimals.value, max_length: decimals.max_length } : null },
      input_count: details.inputs.length, localized_add_buttons: details.localized_add_buttons,
      save_button_count: details.save_button_count, save_enabled: details.save_enabled },
    warning_present: details.warning_present, warning: details.warning };
}

const boardSnapshotExpression = `() => {
  const visible = el => Boolean(el?.getClientRects().length);
  const clean = value => String(value ?? '').trim().slice(0, 200);
  const blocks = Array.from(document.querySelectorAll('.application-block')).filter(visible);
  const read = block => {
    const inputs = Array.from(block.querySelectorAll('input'));
    const tech = inputs.find(input => input.placeholder === 'Техническое название лидерборда');
    const localized_names = Object.fromEntries(inputs.flatMap(input => {
      const match = input.placeholder.match(/^\\[([^\\]]+)\\] Отображаемое название лидерборда$/);
      return match ? [[match[1], clean(input.value)]] : [];
    }));
    return { technical_name: clean(tech?.value), localized_names,
      primary: Boolean(inputs.find(input => input.type === 'checkbox')?.checked),
      result_type: inputs.find(input => input.type === 'radio' && input.checked && ['numeric','time'].includes(input.value))?.value ?? null,
      sort_order: inputs.find(input => input.type === 'radio' && input.checked && ['descending','ascending'].includes(input.value))?.value ?? null,
      decimals: clean(inputs.find(input => input.placeholder === 'Размер десятичной части счета')?.value),
      closed: block.classList.contains('application-block_closed'),
      save_count: Array.from(block.querySelectorAll('button[aria-label="Сохранить"]')).filter(visible).length,
      delete_count: Array.from(block.querySelectorAll('button[aria-label="Удалить"]')).filter(visible).length,
      add_locales: Array.from(block.querySelectorAll('.leaderboard-title-input__button')).filter(visible)
        .map(button => clean(button.innerText).replace(/^Добавить локализацию для /, '')).slice(0, 100) };
  };
  const create = blocks.filter(block => block.querySelector('h2 span')?.textContent?.trim() === 'Добавление лидерборда');
  const edit = blocks.filter(block => /^Изменение лидерборда '[A-Za-z0-9]+'$/.test(block.querySelector('h2 span')?.textContent?.trim() ?? ''));
  return { origin: location.origin, pathname: location.pathname, hash: location.hash,
    create_count: create.length, create: create.length === 1 ? read(create[0]) : null,
    boards: edit.slice(0, 200).map(read), edit_count: edit.length };
}`;

async function openBoardPage(gameId, browser) {
  const navigation = await browser.call('browser_navigate', { url: `https://games.yandex.ru/console/application/${gameId}#leaderboards` });
  if (navigation?.isError) throw new Error('leaderboard page could not be opened');
  const wait = await browser.call('browser_wait_for', { text: 'Добавление лидерборда' });
  if (wait?.isError) throw new Error('leaderboard page did not finish loading');
  const settled = await browser.call('browser_wait_for', { time: 2 });
  if (settled?.isError) throw new Error('leaderboard entries did not finish loading');
  const snapshot = await evaluate(browser, boardSnapshotExpression);
  if (snapshot.origin !== 'https://games.yandex.ru' || snapshot.pathname !== `/console/application/${gameId}`
      || snapshot.hash !== '#leaderboards' || snapshot.create_count !== 1 || snapshot.edit_count !== snapshot.boards.length)
    throw new Error('leaderboard page identity or form structure could not be confirmed');
  const names = snapshot.boards.map(board => board.technical_name);
  if (names.some(name => !/^[A-Za-z0-9]{1,100}$/.test(name)) || new Set(names).size !== names.length)
    throw new Error('leaderboard identities are missing or ambiguous');
  return snapshot;
}

async function click(browser, target, element) {
  const clicked = await browser.call('browser_click', { target, element });
  if (clicked?.isError) throw new Error(`${element} could not be clicked`);
}

async function fill(browser, target, value, name) {
  const filled = await browser.call('browser_fill_form', { fields: [{ name, type: 'textbox', target, value }] });
  if (filled?.isError) throw new Error(`${name} could not be filled`);
}

const createRoot = '.application-block:has(h2 span:text-is("Добавление лидерборда"))';
const editRoot = name => `.application-block:has(h2 span:text-is("Изменение лидерборда '${name}'"))`;
const techInput = root => `${root} input[placeholder="Техническое название лидерборда"]`;
const titleInput = (root, language) => `${root} input[placeholder="[${language}] Отображаемое название лидерборда"]`;

function validateName(value, label = 'technical_name') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9]{1,100}$/.test(value)) throw new Error(`${label} must use 1-100 ASCII letters or digits`);
  return value;
}

function validateLocalizedNames(names, required = false) {
  if (names === undefined && !required) return null;
  if (!names || typeof names !== 'object' || Array.isArray(names) || !Object.keys(names).length)
    throw new Error('names must contain localized display names');
  for (const [language, value] of Object.entries(names)) {
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language) || typeof value !== 'string'
        || !value.trim() || value.length > 30) throw new Error('names contain an unsupported locale or title');
  }
  return names;
}

function exactBoard(snapshot, name) {
  const matches = snapshot.boards.filter(board => board.technical_name === name);
  if (matches.length !== 1) throw new Error(matches.length ? 'leaderboard identity is ambiguous' : `leaderboard ${name} was not found`);
  return matches[0];
}

function boardMatches(actual, expected) {
  return actual && Object.entries(expected).every(([key, value]) => key === 'localized_names'
    ? Object.entries(value).every(([locale, title]) => actual.localized_names?.[locale] === title)
    : String(actual[key]) === String(value));
}

async function verifyAfterSave(gameId, browser, name, expected, previousName = null) {
  const waited = await browser.call('browser_wait_for', { time: 2 });
  if (waited?.isError) throw new Error('save result is unknown; inspect leaderboard before retrying');
  const after = await openBoardPage(gameId, browser);
  const saved = after.boards.find(board => board.technical_name === name) ?? null;
  const oldNameGone = previousName === null || previousName === name
    || !after.boards.some(board => board.technical_name === previousName);
  return { saved, verified: boardMatches(saved, expected) && oldNameGone, primary_before: null,
    primary_after: after.boards.find(board => board.primary)?.technical_name ?? null };
}

async function setTitles(browser, root, current, available, names) {
  for (const [language, title] of Object.entries(names)) {
    if (!Object.hasOwn(current, language)) {
      if (!available.includes(language)) throw new Error(`locale ${language} is not offered by the leaderboard form`);
      await click(browser, `${root} button.leaderboard-title-input__button:has(span:text-is("Добавить локализацию для ${language}"))`,
        `add ${language} leaderboard title`);
    }
    await fill(browser, titleInput(root, language), title, `${language} leaderboard title`);
  }
}

async function createLeaderboard(gameId, args, browser) {
  const name = validateName(args.technical_name);
  const names = validateLocalizedNames(args.names, true);
  if (!Object.hasOwn(names, 'ru')) throw new Error('Russian display name is required by the Console form');
  if (typeof args.primary !== 'boolean' || !['numeric', 'time'].includes(args.result_type)
      || !['descending', 'ascending'].includes(args.sort_order)) throw new Error('primary, result_type or sort_order is invalid');
  if (args.decimals !== undefined && (!Number.isInteger(args.decimals) || args.decimals < 0 || args.decimals > 20))
    throw new Error('decimals must be an integer from 0 to 20');
  const before = await openBoardPage(gameId, browser);
  if (before.boards.some(board => board.technical_name === name)) throw new Error(`leaderboard ${name} already exists`);
  if (before.create?.save_count !== 1) throw new Error('create form Save button is missing or ambiguous');
  const previousPrimary = before.boards.find(board => board.primary)?.technical_name ?? null;
  await fill(browser, techInput(createRoot), name, 'technical name');
  await setTitles(browser, createRoot, before.create.localized_names, before.create.add_locales, names);
  if (before.create.primary !== args.primary) await click(browser, `${createRoot} input[type="checkbox"]`, 'primary checkbox');
  if (before.create.result_type !== args.result_type)
    await click(browser, `${createRoot} input[type="radio"][value="${args.result_type}"]`, 'result type');
  if (before.create.sort_order !== args.sort_order)
    await click(browser, `${createRoot} input[type="radio"][value="${args.sort_order}"]`, 'sort order');
  if (args.decimals !== undefined) await fill(browser, `${createRoot} input[placeholder="Размер десятичной части счета"]`,
    String(args.decimals), 'decimal digits');
  await click(browser, techInput(createRoot), 'technical name blur');
  await click(browser, `${createRoot} button[aria-label="Сохранить"]`, 'create leaderboard Save');
  const expected = { technical_name: name, localized_names: names, primary: args.primary,
    result_type: args.result_type, sort_order: args.sort_order,
    ...(args.decimals !== undefined ? { decimals: String(args.decimals) } : {}) };
  const verification = await verifyAfterSave(gameId, browser, name, expected);
  return { ok: verification.verified, action: 'create_leaderboard', game_id: gameId, technical_name: name,
    verified: verification.verified, leaderboard: verification.saved, previous_primary: previousPrimary,
    current_primary: verification.primary_after,
    ...(!verification.verified ? { reason: 'saved leaderboard did not match; inspect before retrying' } : {}) };
}

async function updateLeaderboard(gameId, args, browser) {
  const name = validateName(args.technical_name);
  const newName = args.new_technical_name === undefined ? name : validateName(args.new_technical_name, 'new_technical_name');
  const names = validateLocalizedNames(args.names);
  if (args.primary !== undefined && typeof args.primary !== 'boolean') throw new Error('primary must be boolean');
  if (newName === name && !names && args.primary === undefined) throw new Error('no changes were supplied');
  const before = await openBoardPage(gameId, browser);
  const current = exactBoard(before, name);
  if (newName !== name && before.boards.some(board => board.technical_name === newName))
    throw new Error(`leaderboard ${newName} already exists`);
  const unchanged = newName === name && (!names || Object.entries(names).every(([locale, title]) => current.localized_names[locale] === title))
    && (args.primary === undefined || current.primary === args.primary);
  if (unchanged) return { ok: true, action: 'update_leaderboard', game_id: gameId, technical_name: name,
    changed: false, verified: true, leaderboard: current };
  const root = editRoot(name);
  if (current.closed) await click(browser, `${root} h2`, `open leaderboard ${name}`);
  const opened = await evaluate(browser, boardSnapshotExpression);
  const form = exactBoard(opened, name);
  if (form.closed || form.save_count !== 1) throw new Error('edit form is closed or Save button is ambiguous');
  if (names) await setTitles(browser, root, form.localized_names, form.add_locales, names);
  if (args.primary !== undefined && args.primary !== current.primary)
    await click(browser, `${root} input[type="checkbox"]`, 'primary checkbox');
  if (newName !== name) await fill(browser, techInput(root), newName, 'new technical name');
  await click(browser, newName === name ? techInput(root) : titleInput(root, 'ru'), 'edit form blur');
  await click(browser, `${root} button[aria-label="Сохранить"]`, 'update leaderboard Save');
  const expected = { technical_name: newName, localized_names: names ?? {},
    ...(args.primary === undefined ? {} : { primary: args.primary }) };
  const verification = await verifyAfterSave(gameId, browser, newName, expected, name);
  return { ok: verification.verified, action: 'update_leaderboard', game_id: gameId,
    technical_name: newName, previous_technical_name: name, changed: true, verified: verification.verified,
    leaderboard: verification.saved, previous_primary: before.boards.find(board => board.primary)?.technical_name ?? null,
    current_primary: verification.primary_after,
    ...(!verification.verified ? { reason: 'saved leaderboard did not match; inspect before retrying' } : {}) };
}

async function deleteLeaderboard(gameId, args, browser) {
  const name = validateName(args.technical_name);
  if (args.confirm_technical_name !== name) throw new Error('confirm_technical_name must exactly match technical_name');
  const before = await openBoardPage(gameId, browser);
  const current = exactBoard(before, name);
  if (current.primary) throw new Error('change the primary leaderboard before deleting this one');
  const root = editRoot(name);
  if (current.closed) await click(browser, `${root} h2`, `open leaderboard ${name}`);
  const opened = await evaluate(browser, boardSnapshotExpression);
  const form = exactBoard(opened, name);
  if (form.closed || form.delete_count !== 1) throw new Error('delete control is missing or ambiguous');
  await click(browser, `${root} button[aria-label="Удалить"]`, `delete leaderboard ${name}`);
  const dialog = await evaluate(browser, `() => Array.from(document.querySelectorAll('[role="dialog"]'))
    .filter(el => Boolean(el.getClientRects().length)).map(el => ({
      title: el.querySelector('h3')?.textContent?.trim() ?? '',
      text: el.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      buttons: Array.from(el.querySelectorAll('button')).map(button => button.textContent?.trim()) }))`);
  if (dialog.length !== 1 || dialog[0].title !== 'Удаление лидерборда'
      || !dialog[0].text.includes(`удалить лидерборд '${name}'?`)
      || dialog[0].buttons.filter(button => button === 'OK').length !== 1) throw new Error('delete confirmation does not match the requested leaderboard');
  await click(browser, '[role="dialog"] button:has(span:text-is("OK"))', `confirm deletion of ${name}`);
  const waited = await browser.call('browser_wait_for', { time: 2 });
  if (waited?.isError) throw new Error('delete result is unknown; inspect leaderboard before retrying');
  const after = await openBoardPage(gameId, browser);
  const verified = !after.boards.some(board => board.technical_name === name);
  return { ok: verified, action: 'delete_leaderboard', game_id: gameId, technical_name: name,
    verified, remaining_count: after.boards.length,
    ...(!verified ? { reason: 'leaderboard still appears after deletion; inspect before retrying' } : {}) };
}

export async function invokeLeaderboardTool(name, args = {}, browser) {
  const known = leaderboardToolDefinitions.some(tool => tool.name === name);
  if (!known) return result({ ok: false, action: name, reason: 'unknown leaderboard tool' }, true);
  if (typeof args.game_id !== 'string' || !/^\d+$/.test(args.game_id))
    return result({ ok: false, action: name, reason: 'game_id must contain digits only' }, true);
  try {
    if (name === 'inspect_leaderboard_form') return result(await inspectLeaderboardForm(args.game_id, browser));
    if (name === 'list_leaderboards') {
      const page = await openBoardPage(args.game_id, browser);
      return result({ ok: true, action: name, game_id: args.game_id, count: page.boards.length,
        leaderboards: page.boards.map(({ technical_name, localized_names, primary, result_type, sort_order, decimals }) =>
          ({ technical_name, localized_names, primary, result_type, sort_order, decimals })) });
    }
    if (name === 'get_leaderboard') {
      const technicalName = validateName(args.technical_name);
      const page = await openBoardPage(args.game_id, browser);
      return result({ ok: true, action: name, game_id: args.game_id, leaderboard: exactBoard(page, technicalName) });
    }
    const data = name === 'create_leaderboard' ? await createLeaderboard(args.game_id, args, browser)
      : name === 'update_leaderboard' ? await updateLeaderboard(args.game_id, args, browser)
        : name === 'delete_leaderboard' ? await deleteLeaderboard(args.game_id, args, browser) : null;
    if (data) return result(data, !data.ok);
  } catch (error) {
    return result({ ok: false, action: name, game_id: args.game_id,
      reason: error instanceof Error ? error.message : 'leaderboard operation failed' }, true);
  }
  return result({ ok: false, action: name, game_id: args.game_id, reason: 'unknown leaderboard tool' }, true);
}
