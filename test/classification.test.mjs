import test from 'node:test';
import assert from 'node:assert/strict';
import { updateDraftClassification } from '../src/classification.mjs';

const gameId = '101003';
const result = value => ({ content: [{ type: 'text', text: `### Result\n${JSON.stringify(`YGJSON:${JSON.stringify(value)}`)}` }] });

function mockBrowser(values) {
  const calls = [];
  return {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'browser_evaluate') return result(values.shift());
      if (name === 'browser_fill_form' || name === 'browser_click' || name === 'browser_wait_for') return result('ok');
      throw new Error(`unexpected browser call ${name}`);
    },
  };
}

test('classification rejects a different page before any write interaction', async () => {
  const browser = mockBrowser([{ ok: false, reason: 'wrong_page' }]);
  await assert.rejects(updateDraftClassification(gameId, { categories: [12] }, browser), /wrong_page/);
  assert.equal(browser.calls.filter(x => x.name === 'browser_click' || x.name === 'browser_fill_form').length, 0);
});

test('classification refuses to change a non-empty existing selection', async () => {
  const browser = mockBrowser([{ ok: true, categories: [{ id: 12 }], tags: [], catalogs: {} }]);
  await assert.rejects(updateDraftClassification(gameId, { tags: [43] }, browser), /non-empty/);
  assert.equal(browser.calls.length, 1);
});

test('classification fails closed when visible popup options cannot be tied to a catalog ID', async () => {
  const initial = {
    ok: true, game_id: gameId, categories: [], tags: [],
    catalogs: { categories: { data: [{ id: 12, name: 'puzzles' }] }, tags: { data: [] } },
  };
  const browser = mockBrowser([
    initial,
    { container_count: 1, input_count: 1, disabled: false, visible: true },
    { inputs: 1, listboxes: 1 },
    [{ text: 'puzzles', id: null, qa: null, role: 'option' },
      { text: 'puzzles', id: null, qa: null, role: 'option' }],
  ]);
  await assert.rejects(updateDraftClassification(gameId, { categories: [12] }, browser), /not uniquely identified/);
  assert.equal(browser.calls.filter(x => x.name === 'browser_click' && /Сохранить/.test(x.args.target ?? '')).length, 0);
});

test('classification validates IDs before opening the browser', async () => {
  const browser = mockBrowser([]);
  await assert.rejects(updateDraftClassification(gameId, { tags: [43, 43] }, browser), /unique positive integer/);
  assert.equal(browser.calls.length, 0);
});

test('classification saves one uniquely identified category and verifies its API ID', async () => {
  const browser = mockBrowser([
    { ok: true, game_id: gameId, categories: [], tags: [],
      catalogs: { categories: { data: [{ id: 12, title: 'Головоломки', name: 'puzzles' }] }, tags: { data: [] } } },
    { container_count: 1, input_count: 1, disabled: false, visible: true },
    { inputs: 1, listboxes: 1 },
    [{ text: 'Головоломки', id: '12', qa: null, role: 'option' }],
    { page_ok: true, categories: { count: 1, ids: 'puzzles', chips: ['Головоломки'] }, tags: { count: 1, ids: '[]', chips: [] },
      save_count: 1, save_enabled: true },
    { ok: true, categories: ['puzzles'], tags: [] },
  ]);
  const value = await updateDraftClassification(gameId, { categories: [12] }, browser);
  assert.equal(value.ok, true);
  assert.equal(value.saved, true);
  assert.equal(value.verified, true);
  const saveClicks = browser.calls.filter(x => x.name === 'browser_click' && /Сохранить/.test(x.args.target ?? ''));
  assert.equal(saveClicks.length, 1);
  assert.equal(saveClicks[0].args.target, 'button.form__button[type="submit"]:text-is("Сохранить")');
  assert.equal(browser.calls.some(x => x.name === 'browser_click' && /модерац|moderation/i.test(x.args.target ?? '')), false);
});

test('classification recognizes an already saved category slug and tag ID without another Save', async () => {
  const browser = mockBrowser([{ ok: true, game_id: gameId, categories: ['puzzles'], tags: [43],
    catalogs: { categories: { data: [{ id: 12, title: 'Головоломки', name: 'puzzles' }] },
      tags: { data: [{ id: 43, title: '2048' }] } } }]);
  const value = await updateDraftClassification(gameId, { categories: [12], tags: [43] }, browser);
  assert.equal(value.ok, true);
  assert.equal(value.changed, false);
  assert.equal(browser.calls.length, 1);
});
