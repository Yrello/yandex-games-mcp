import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeLeaderboardTool, leaderboardToolDefinitions } from '../src/leaderboards.mjs';

test('leaderboard read and write tools are advertised separately', () => {
  assert.deepEqual(leaderboardToolDefinitions.map(tool => tool.name), [
    'inspect_leaderboard_form', 'list_leaderboards', 'get_leaderboard',
    'create_leaderboard', 'update_leaderboard', 'delete_leaderboard',
  ]);
});

test('leaderboard tools validate IDs and arguments before browser access', async () => {
  const browser = { calls: 0, async call() { this.calls += 1; } };
  const bad = await invokeLeaderboardTool('inspect_leaderboard_form', { game_id: '1/2' }, browser);
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /digits only/);
  const invalid = await invokeLeaderboardTool('create_leaderboard', { game_id: '101003' }, browser);
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /technical_name/);
  assert.equal(browser.calls, 0);
});

const browserResult = value => ({ content: [{ type: 'text', text: `### Result\n${JSON.stringify(`YGJSON:${JSON.stringify(value)}`)}` }] });
function mockBrowser(values) {
  const calls = [];
  return { calls, async call(name, args) {
    calls.push({ name, args });
    if (name === 'browser_evaluate') {
      new Function(`return (${args.function})`);
      return browserResult(values.shift());
    }
    if (name === 'browser_click' || name === 'browser_fill_form') return browserResult('clicked');
    if (name === 'browser_navigate' || name === 'browser_wait_for') return browserResult('ok');
    throw new Error(`unexpected browser call ${name}`);
  } };
}
const page = overrides => {
  const value = { origin: 'https://games.yandex.ru', pathname: '/console/application/101003', hash: '#application-info-draft',
    title: 'Test game', headings: ['Test game'], tabs: [], controls: [], panels: [], ready: true, ...overrides };
  value.exact_leaderboard_tabs ??= value.tabs.filter(tab => tab.text === 'Лидерборды').map(({ text, ...tab }) => tab);
  return value;
};
const leaderboardDetails = overrides => ({ origin: 'https://games.yandex.ru', pathname: '/console/application/101003', hash: '#leaderboards',
  heading_present: true, application_block_count: 1, inputs: [], localized_add_buttons: [], existing_edit_actions: [],
  existing_edit_action_count: 0, save_button_count: 1, save_enabled: false, warning_present: true,
  warning: 'Поля нельзя редактировать т. к. вы отправили этот черновик на модерацию. Для редактирования полей надо отозвать черновик с модерации.',
  ...overrides });

test('form inspection opens only exact game route, identifies exact tab, clicks once, and returns bounded metadata', async () => {
  const browser = mockBrowser([
    page({ tabs: [{ tag: 'a', text: 'Лидерборды', href: '/console/application/101003#leaderboards', selected: false }] }),
    page({ hash: '#leaderboards', headings: ['Добавление лидерборда'], tabs: [{ tag: 'a', text: 'Лидерборды', href: '/console/application/101003#leaderboards', selected: true }],
      controls: [{ tag: 'input', type: 'text', name: 'name', label: 'Техническое название', checked: false, disabled: false }],
      panels: [{ tag: 'form', role: null, heading: '', control_count: 6 }] }),
    leaderboardDetails({ inputs: [
      { type: 'text', placeholder: 'Техническое название лидерборда', value: '', disabled: false, max_length: 100 },
      { type: 'text', placeholder: '[ru] Отображаемое название лидерборда', value: '', disabled: false, max_length: 30 },
      { type: 'number', placeholder: 'Размер десятичной части счета', value: '0', disabled: false, max_length: null },
      { type: 'checkbox', placeholder: '', checked: true, disabled: true, max_length: null },
      { type: 'radio', placeholder: '', value: 'numeric', checked: true, disabled: false, max_length: null },
      { type: 'radio', placeholder: '', value: 'descending', checked: true, disabled: false, max_length: null },
    ], localized_add_buttons: ['Добавить локализацию для en'], existing_edit_actions: ["Изменение лидерборда 'best_score'"],
      existing_edit_action_count: 1 }),
  ]);
  const result = await invokeLeaderboardTool('inspect_leaderboard_form', { game_id: '101003' }, browser);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.ok, true);
  assert.equal(value.opened, true);
  assert.equal(value.warning_present, true);
  assert.match(value.warning, /отозвать черновик с модерации/);
  assert.equal(value.form.settings.technical_name.max_length, 100);
  assert.deepEqual(value.form.settings.localized_display_names, [{ language: 'ru', value: '', max_length: 30 }]);
  assert.equal(value.form.settings.primary.checked, true);
  assert.equal(value.form.settings.primary.disabled, true);
  assert.equal(value.form.settings.result_type.selected, 'numeric');
  assert.equal(value.form.settings.sort_order.selected, 'descending');
  assert.equal(value.form.settings.decimals.value, '0');
  assert.deepEqual(value.form.localized_add_buttons, ['Добавить локализацию для en']);
  assert.equal(value.form.save_enabled, false);
  assert.deepEqual(value.list.existing_edit_actions, ["Изменение лидерборда 'best_score'"]);
  assert.deepEqual(browser.calls.map(call => call.name), ['browser_navigate', 'browser_wait_for', 'browser_evaluate', 'browser_click', 'browser_evaluate', 'browser_evaluate']);
  assert.match(browser.calls.at(-1).args.function, /header\(block\)\.includes\("Добавление лидерборда"\)/);
  assert.equal(browser.calls[0].args.url, 'https://games.yandex.ru/console/application/101003#application-info-draft');
  assert.equal(browser.calls.filter(call => call.name === 'browser_click').length, 1);
  assert.match(browser.calls.find(call => call.name === 'browser_evaluate').args.function, /slice\(0, 100\)/);
  assert.equal(browser.calls.find(call => call.name === 'browser_click').args.target,
    'a[data-qa="leaderboards"][href="#leaderboards"]');
});

test('form inspection waits through a navigation skeleton before looking for the leaderboard tab', async () => {
  const skeleton = page({ headings: [], tabs: [{ tag: 'a', text: 'Помощь', href: '/help' }], controls: [], panels: [], ready: false,
    exact_leaderboard_tabs: [], main_control_count: 0 });
  const loaded = page({ tabs: [{ tag: 'a', text: 'Лидерборды', href: '/console/application/101003#leaderboards' }] });
  const opened = page({ hash: '#leaderboards', headings: ['Добавление лидерборда'],
    tabs: [{ tag: 'a', text: 'Лидерборды', href: '/console/application/101003#leaderboards', selected: true }] });
  const browser = mockBrowser([skeleton, loaded, opened, leaderboardDetails()]);
  const result = await invokeLeaderboardTool('inspect_leaderboard_form', { game_id: '101003' }, browser);
  assert.equal(JSON.parse(result.content[0].text).opened, true);
  assert.equal(browser.calls.filter(call => call.name === 'browser_wait_for' && call.args.text).length, 1);
  assert.equal(browser.calls.filter(call => call.name === 'browser_wait_for' && call.args.time).length, 1);
  assert.equal(browser.calls.filter(call => call.name === 'browser_click').length, 1);
});

test('form inspection returns bounded loading state after the wait limit without clicking', async () => {
  const skeleton = page({ headings: [], tabs: [{ tag: 'a', text: 'Помощь', href: '/help' }], controls: [], panels: [], ready: false,
    main_control_count: 3,
    exact_leaderboard_tabs: [], main_control_count: 0 });
  const browser = mockBrowser(Array.from({ length: 9 }, () => skeleton));
  const result = await invokeLeaderboardTool('inspect_leaderboard_form', { game_id: '101003' }, browser);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.opened, false);
  assert.match(value.reason, /bounded wait expired/);
  assert.equal(browser.calls.filter(call => call.name === 'browser_wait_for' && call.args.time).length, 8);
  assert.equal(browser.calls.some(call => call.name === 'browser_click'), false);
});

test('form inspection refuses an ambiguous tab without clicking', async () => {
  const browser = mockBrowser([page({ tabs: [
    { tag: 'a', text: 'Лидерборды', href: '/console/application/101003#one' },
    { tag: 'button', text: 'Лидерборды' },
  ] })]);
  const result = await invokeLeaderboardTool('inspect_leaderboard_form', { game_id: '101003' }, browser);
  assert.equal(JSON.parse(result.content[0].text).opened, false);
  assert.match(result.content[0].text, /ambiguous/);
  assert.equal(browser.calls.some(call => call.name === 'browser_click'), false);
});

test('form inspection rejects a different application page before clicking', async () => {
  const browser = mockBrowser([page({ pathname: '/console/application/101004' })]);
  const result = await invokeLeaderboardTool('inspect_leaderboard_form', { game_id: '101003' }, browser);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requested application page/);
  assert.equal(browser.calls.some(call => call.name === 'browser_click'), false);
});

test('form inspection rejects the exact application path when the draft tab hash is not active', async () => {
  const browser = mockBrowser([page({ hash: '' })]);
  const result = await invokeLeaderboardTool('inspect_leaderboard_form', { game_id: '101003' }, browser);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requested application page/);
  assert.equal(browser.calls.some(call => call.name === 'browser_click'), false);
});


test('form inspection does not claim an unopened tab or follow another game link', async () => {
  const other = mockBrowser([page({ tabs: [{ tag: 'a', text: 'Лидерборды', href: '/console/application/1010039#leaderboards' }] })]);
  const rejected = await invokeLeaderboardTool('inspect_leaderboard_form', { game_id: '101003' }, other);
  assert.equal(JSON.parse(rejected.content[0].text).opened, false);
  assert.equal(other.calls.some(call => call.name === 'browser_click'), false);

  const samePage = page({ tabs: [{ tag: 'a', text: 'Лидерборды', href: '/console/application/101003#leaderboards', selected: false }] });
  const inactive = mockBrowser([samePage, samePage]);
  const result = await invokeLeaderboardTool('inspect_leaderboard_form', { game_id: '101003' }, inactive);
  assert.equal(JSON.parse(result.content[0].text).opened, false);
  assert.match(result.content[0].text, /activation was not confirmed/);
});

const board = (name, overrides = {}) => ({ technical_name: name, localized_names: { ru: 'Тест' }, primary: false,
  result_type: 'numeric', sort_order: 'descending', decimals: '0', closed: true, save_count: 1, delete_count: 1,
  add_locales: ['en', 'es'], ...overrides });
const boardPage = (boards, overrides = {}) => ({ origin: 'https://games.yandex.ru',
  pathname: '/console/application/101003', hash: '#leaderboards', create_count: 1,
  create: board('', { localized_names: { ru: '' }, primary: true, closed: false }),
  boards, edit_count: boards.length, ...overrides });

test('list and get return only bounded settings for an exact game and name', async () => {
  const existing = board('Score2', { localized_names: { ru: 'Счёт', en: 'Score' } });
  const listBrowser = mockBrowser([boardPage([existing])]);
  const listed = JSON.parse((await invokeLeaderboardTool('list_leaderboards', { game_id: '101003' }, listBrowser)).content[0].text);
  assert.equal(listed.count, 1);
  assert.deepEqual(listed.leaderboards[0].localized_names, { ru: 'Счёт', en: 'Score' });
  const getBrowser = mockBrowser([boardPage([existing])]);
  const got = JSON.parse((await invokeLeaderboardTool('get_leaderboard', { game_id: '101003', technical_name: 'Score2' }, getBrowser)).content[0].text);
  assert.equal(got.leaderboard.technical_name, 'Score2');
  const missing = await invokeLeaderboardTool('get_leaderboard', { game_id: '101003', technical_name: 'Missing' }, mockBrowser([boardPage([existing])]));
  assert.equal(missing.isError, true);
});

test('create fills one exact form, saves once, and verifies a fresh page', async () => {
  const browser = mockBrowser([
    boardPage([]),
    boardPage([board('Score2', { localized_names: { ru: 'Счёт', en: 'Score' }, primary: true })]),
  ]);
  const response = await invokeLeaderboardTool('create_leaderboard', { game_id: '101003', technical_name: 'Score2',
    names: { ru: 'Счёт', en: 'Score' }, primary: true, result_type: 'numeric', sort_order: 'descending', decimals: 0 }, browser);
  const value = JSON.parse(response.content[0].text);
  assert.equal(value.verified, true);
  assert.equal(browser.calls.filter(call => call.name === 'browser_click' && call.args.element === 'create leaderboard Save').length, 1);
  assert.equal(browser.calls.filter(call => call.name === 'browser_navigate').length, 2);
  assert.equal(browser.calls.some(call => call.name === 'browser_click' && call.args.element === 'add en leaderboard title'), true);
});

test('update checks exact target, changes localization and primary once, and verifies new state', async () => {
  const first = board('Score2', { localized_names: { ru: 'Счёт' }, primary: false });
  const open = board('Score2', { localized_names: { ru: 'Счёт' }, primary: false, closed: false });
  const saved = board('Score2', { localized_names: { ru: 'Счёт', en: 'Score' }, primary: true });
  const browser = mockBrowser([boardPage([first]), boardPage([open]), boardPage([saved])]);
  const response = await invokeLeaderboardTool('update_leaderboard', { game_id: '101003', technical_name: 'Score2',
    names: { en: 'Score' }, primary: true }, browser);
  const value = JSON.parse(response.content[0].text);
  assert.equal(value.verified, true);
  assert.equal(browser.calls.filter(call => call.name === 'browser_click' && call.args.element === 'update leaderboard Save').length, 1);
  assert.equal(browser.calls.some(call => call.name === 'browser_click' && call.args.element === 'primary checkbox'), true);
});

test('rename is not verified while the previous leaderboard name still exists', async () => {
  const original = board('Score2');
  const opened = board('Score2', { closed: false });
  const renamed = board('Score3');
  const browser = mockBrowser([
    boardPage([original]), boardPage([opened]), boardPage([original, renamed]),
  ]);
  const response = await invokeLeaderboardTool('update_leaderboard', {
    game_id: '101003', technical_name: 'Score2', new_technical_name: 'Score3',
  }, browser);
  const value = JSON.parse(response.content[0].text);
  assert.equal(response.isError, true);
  assert.equal(value.verified, false);
});

test('delete requires exact confirmation and verifies disappearance after one OK', async () => {
  const missingConfirmation = await invokeLeaderboardTool('delete_leaderboard', { game_id: '101003',
    technical_name: 'Score2', confirm_technical_name: 'Other' }, mockBrowser([]));
  assert.equal(missingConfirmation.isError, true);
  const current = board('Score2');
  const browser = mockBrowser([boardPage([current]), boardPage([board('Score2', { closed: false })]),
    [{ title: 'Удаление лидерборда', text: "Удаление лидерборда Вы уверены что хотите удалить лидерборд 'Score2'? OK Отмена", buttons: ['OK', 'Отмена'] }],
    boardPage([])]);
  const response = await invokeLeaderboardTool('delete_leaderboard', { game_id: '101003',
    technical_name: 'Score2', confirm_technical_name: 'Score2' }, browser);
  const value = JSON.parse(response.content[0].text);
  assert.equal(value.verified, true);
  assert.equal(browser.calls.filter(call => call.name === 'browser_click' && call.args.element === 'confirm deletion of Score2').length, 1);
});

test('an already open edit card stays open for deletion', async () => {
  const open = board('Score2', { closed: false });
  const browser = mockBrowser([boardPage([open]), boardPage([open]),
    [{ title: 'Удаление лидерборда', text: "Удаление лидерборда Вы уверены что хотите удалить лидерборд 'Score2'? OK Отмена", buttons: ['OK', 'Отмена'] }],
    boardPage([])]);
  const response = await invokeLeaderboardTool('delete_leaderboard', { game_id: '101003',
    technical_name: 'Score2', confirm_technical_name: 'Score2' }, browser);
  assert.equal(JSON.parse(response.content[0].text).verified, true);
  assert.equal(browser.calls.some(call => call.args?.element === 'open leaderboard Score2'), false);
});
