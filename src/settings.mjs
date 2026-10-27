const CONSOLE_ORIGIN = 'https://games.yandex.ru';
const AGE_RATINGS = ['0+', '6+', '12+', '16+', '18+'];

export const ageRatingToolDefinition = {
  name: 'update_draft_age_rating',
  description: 'Set the age rating on one exact draft, save once, and verify it through the draft API. Does not submit for moderation.',
  inputSchema: {
    type: 'object',
    properties: {
      game_id: { type: 'string', pattern: '^[0-9]+$' },
      age_rating: { type: 'string', enum: AGE_RATINGS },
    },
    required: ['game_id', 'age_rating'],
    additionalProperties: false,
  },
};

function decode(result) {
  if (result?.isError) throw new Error('browser tool failed');
  const text = (result?.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
  const section = text.includes('### Result') ? text.split('### Result', 2)[1].split(/\n### /, 1)[0].trim() : text.trim();
  const marker = 'YGJSON:';
  try {
    const value = JSON.parse(section);
    if (typeof value === 'string' && value.startsWith(marker)) return JSON.parse(value.slice(marker.length));
  } catch { /* Some browser tool versions return plain text. */ }
  const at = section.indexOf(marker);
  if (at < 0) throw new Error('unexpected browser response');
  return JSON.parse(section.slice(at + marker.length).split(/\r?\n/)[0].trim());
}

async function evaluate(browser, source) {
  return decode(await browser.call('browser_evaluate', {
    function: `async () => 'YGJSON:' + JSON.stringify(await (${source})())`,
  }));
}

export async function updateDraftAgeRating(gameId, ageRating, browser) {
  if (typeof gameId !== 'string' || !/^\d+$/.test(gameId)) throw new Error('game_id must contain digits only');
  if (!AGE_RATINGS.includes(ageRating)) throw new Error(`age_rating must be one of ${AGE_RATINGS.join(', ')}`);

  const before = await evaluate(browser, `async () => {
    const page = { origin: location.origin, pathname: location.pathname, hash: location.hash };
    if (page.origin !== '${CONSOLE_ORIGIN}' || page.pathname !== '/console/application/${gameId}' || page.hash !== '#application-info-draft')
      return { ok: false, reason: 'wrong_page', page };
    const r = await fetch('/console/api/application/${gameId}', { credentials: 'same-origin' });
    if (!r.ok) return { ok: false, reason: 'api_read_failed', status: r.status };
    const app = (await r.json())?.data;
    if (!app || String(app.id) !== '${gameId}') return { ok: false, reason: 'application_not_found' };
    if (!app.draft) return { ok: false, reason: 'application_has_no_draft' };
    return { ok: true, age_rating: app.draft.features?.age_rating ?? null };
  }`);
  if (!before.ok) throw new Error(before.reason ?? 'could not read target draft');
  if (before.age_rating === ageRating) {
    return { ok: true, action: 'update_draft_age_rating', game_id: gameId, requested: ageRating,
      saved: false, verified: true, unchanged: true };
  }

  const control = await evaluate(browser, `() => {
    const roots = document.querySelectorAll('[data-qa="ageRating"]');
    const buttons = roots.length === 1 ? roots[0].querySelectorAll('button') : [];
    return { root_count: roots.length, button_count: buttons.length, disabled: buttons[0]?.disabled ?? null,
      text: buttons[0]?.innerText.trim() ?? null };
  }`);
  if (control.root_count !== 1 || control.button_count !== 1 || control.disabled)
    throw new Error('age rating control is missing, disabled, or ambiguous; nothing was saved');

  const opened = await browser.call('browser_click', { target: '[data-qa="ageRating"] button', element: 'age rating selector' });
  if (opened?.isError) throw new Error('age rating selector could not be opened; nothing was saved');
  const options = await evaluate(browser, `() => {
    const visible = e => Boolean(e.getClientRects().length);
    return Array.from(document.querySelectorAll('[role="option"]')).filter(visible)
      .map(e => ({ text: String(e.innerText ?? e.textContent ?? '').replace(/\\s+/g, ' ').trim() }));
  }`);
  const matches = options.filter(option => option.text === ageRating);
  if (matches.length !== 1) throw new Error('requested age rating option is missing or ambiguous; nothing was saved');
  const optionClick = await browser.call('browser_click', {
    target: `[role="option"]:text-is(${JSON.stringify(ageRating)})`, element: `age rating ${ageRating}`,
  });
  if (optionClick?.isError) throw new Error('requested age rating option could not be selected; nothing was saved');

  const selected = await evaluate(browser, `() => {
    const roots = document.querySelectorAll('[data-qa="ageRating"]');
    const buttons = roots.length === 1 ? roots[0].querySelectorAll('button') : [];
    const visible = e => Boolean(e.getClientRects().length);
    const save = Array.from(document.querySelectorAll('button')).filter(b => visible(b) && b.innerText.trim() === 'Сохранить');
    return { page_ok: location.origin === '${CONSOLE_ORIGIN}' && location.pathname === '/console/application/${gameId}' && location.hash === '#application-info-draft',
      root_count: roots.length, button_count: buttons.length, label: buttons[0]?.innerText.trim() ?? null,
      save_count: save.length, save_enabled: save.length === 1 && !save[0].disabled };
  }`);
  if (!selected.page_ok || selected.root_count !== 1 || selected.button_count !== 1 || selected.label !== ageRating
      || selected.save_count !== 1 || !selected.save_enabled)
    throw new Error('selected age rating or enabled Save button is not uniquely confirmed; nothing was saved');

  const saved = await browser.call('browser_click', { target: 'button:has-text("Сохранить")', element: 'кнопка сохранения черновика' });
  if (saved?.isError) throw new Error('draft Save failed; reread draft before retrying');
  await browser.call('browser_wait_for', { time: 2 });
  const after = await evaluate(browser, `async () => {
    if (location.origin !== '${CONSOLE_ORIGIN}' || location.pathname !== '/console/application/${gameId}' || location.hash !== '#application-info-draft')
      return { ok: false, reason: 'wrong_page_after_save' };
    const r = await fetch('/console/api/application/${gameId}', { credentials: 'same-origin' });
    if (!r.ok) return { ok: false, reason: 'api_read_failed', status: r.status };
    const app = (await r.json())?.data;
    if (!app || String(app.id) !== '${gameId}' || !app.draft) return { ok: false, reason: 'draft_unavailable_after_save' };
    return { ok: true, age_rating: app.draft.features?.age_rating ?? null };
  }`);
  const verified = after.ok && after.age_rating === ageRating;
  return { ok: Boolean(verified), action: 'update_draft_age_rating', game_id: gameId,
    requested: ageRating, saved: verified ? true : 'unknown', verified: Boolean(verified),
    ...(verified ? {} : { reason: 'saved draft did not confirm requested age rating', after }) };
}
