import test from 'node:test';
import assert from 'node:assert/strict';
import { updateDraftAgeRating } from '../src/settings.mjs';

const gameId = '101001';
const result = value => ({ content: [{ type: 'text', text: `### Result\n${JSON.stringify(`YGJSON:${JSON.stringify(value)}`)}` }] });

function mockBrowser(values) {
  const calls = [];
  return {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'browser_evaluate') return result(values.shift());
      if (name === 'browser_click' || name === 'browser_wait_for') return result('ok');
      throw new Error(`unexpected browser call ${name}`);
    },
  };
}

const page = { origin: 'https://games.yandex.ru', pathname: `/console/application/${gameId}`, hash: '#application-info-draft' };
const api = age_rating => ({ ok: true, age_rating });

test('age rating rejects another page before UI writes', async () => {
  const browser = mockBrowser([{ ok: false, reason: 'wrong_page' }]);
  await assert.rejects(updateDraftAgeRating(gameId, '6+', browser), /wrong_page/);
  assert.equal(browser.calls.some(call => call.name === 'browser_click'), false);
});

test('age rating validates the requested value without opening the browser', async () => {
  const browser = mockBrowser([]);
  await assert.rejects(updateDraftAgeRating(gameId, '7+', browser), /must be one of/);
  assert.equal(browser.calls.length, 0);
});

test('same age rating is idempotent and does not Save', async () => {
  const browser = mockBrowser([api('0+')]);
  const value = await updateDraftAgeRating(gameId, '0+', browser);
  assert.deepEqual(value, { ok: true, action: 'update_draft_age_rating', game_id: gameId,
    requested: '0+', saved: false, verified: true, unchanged: true });
  assert.equal(browser.calls.some(call => call.name === 'browser_click'), false);
});

test('ambiguous exact option stops before Save', async () => {
  const browser = mockBrowser([
    api('0+'),
    { root_count: 1, button_count: 1, disabled: false, text: '0+' },
    [{ text: '6+' }, { text: '6+' }],
  ]);
  await assert.rejects(updateDraftAgeRating(gameId, '6+', browser), /missing or ambiguous/);
  assert.equal(browser.calls.filter(call => call.name === 'browser_click').length, 1);
});

test('selects the exact option, saves once and verifies API age rating', async () => {
  const browser = mockBrowser([
    api('0+'),
    { root_count: 1, button_count: 1, disabled: false, text: '0+' },
    [{ text: '6+' }],
    { page_ok: true, root_count: 1, button_count: 1, label: '6+', save_count: 1, save_enabled: true },
    api('6+'),
  ]);
  const value = await updateDraftAgeRating(gameId, '6+', browser);
  assert.equal(value.ok, true);
  assert.equal(value.saved, true);
  assert.equal(value.verified, true);
  const clicks = browser.calls.filter(call => call.name === 'browser_click');
  assert.equal(clicks.length, 3);
  assert.equal(clicks[1].args.target, '[role="option"]:text-is("6+")');
  assert.equal(clicks.filter(call => /Сохранить/.test(call.args.target ?? '')).length, 1);
  assert.equal(clicks.some(call => /модерац|moderation/i.test(call.args.target ?? '')), false);
});
