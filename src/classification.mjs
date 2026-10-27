const CONSOLE_ORIGIN = 'https://games.yandex.ru';
const CATALOGS = {
  categories: { url: '/console/api/categories?lang=ru&app-type=html5-game', label: 'title', qa: 'categories' },
  tags: { url: '/console/api/tags?lang=ru', label: 'title', qa: 'tags' },
};

export const classificationToolDefinition = {
  name: 'update_draft_classification',
  description: 'Add categories and/or tags to an empty game draft selection, save once, and verify by reading the draft again. Does not submit for moderation.',
  inputSchema: {
    type: 'object',
    properties: {
      game_id: { type: 'string', pattern: '^[0-9]+$' },
      categories: { type: 'array', items: { type: 'integer', minimum: 1 }, uniqueItems: true },
      tags: { type: 'array', items: { type: 'integer', minimum: 1 }, uniqueItems: true },
    },
    required: ['game_id'], minProperties: 2, additionalProperties: false,
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

function requestedIds(value, key) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(id => !Number.isSafeInteger(id) || id < 1)
      || new Set(value).size !== value.length) throw new Error(`${key} must be an array of unique positive integer IDs`);
  return value;
}

function idList(value, kind, catalog) {
  if (!Array.isArray(value)) return null;
  const rows = catalogRows(catalog);
  return value.map(item => {
    const raw = typeof item === 'object' && item !== null ? item.id ?? item.name : item;
    if (kind === 'categories' && typeof raw === 'string' && !/^\d+$/.test(raw)) {
      const matches = rows.filter(row => row?.name === raw);
      return matches.length === 1 ? Number(matches[0].id) : NaN;
    }
    return Number(raw);
  });
}

function catalogRows(data) {
  const rows = data?.data ?? data?.items ?? data;
  return Array.isArray(rows) ? rows : [];
}

const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();

/** UI-based classification update. Refuses non-empty selections so no existing metadata is removed. */
export async function updateDraftClassification(gameId, requested, browser) {
  if (typeof gameId !== 'string' || !/^\d+$/.test(gameId)) throw new Error('game_id must contain digits only');
  const wanted = {
    categories: requestedIds(requested.categories, 'categories'),
    tags: requestedIds(requested.tags, 'tags'),
  };
  if (!wanted.categories.length && !wanted.tags.length) throw new Error('at least one category or tag ID is required');

  const initial = await evaluate(browser, `async () => {
    const page = { origin: location.origin, pathname: location.pathname, hash: location.hash };
    if (page.origin !== '${CONSOLE_ORIGIN}' || page.pathname !== '/console/application/${gameId}' || page.hash !== '#application-info-draft')
      return { ok: false, reason: 'wrong_page', page };
    const get = async url => { const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) return { ok: false, status: r.status }; return { ok: true, data: await r.json() }; };
    const [app, categories, tags] = await Promise.all([
      get('/console/api/application/${gameId}'),
      get('${CATALOGS.categories.url}'), get('${CATALOGS.tags.url}')]);
    if (!app.ok || !categories.ok || !tags.ok) return { ok: false, reason: 'api_read_failed', statuses: [app.status, categories.status, tags.status] };
    const application = app.data?.data;
    if (!application || String(application.id) !== '${gameId}') return { ok: false, reason: 'application_not_found' };
    if (!application.draft) return { ok: false, reason: 'application_has_no_draft' };
    return { ok: true, game_id: String(application.id), categories: application.draft.categories ?? [], tags: application.draft.tags ?? [],
      catalogs: { categories: categories.data, tags: tags.data } };
  }`);
  if (!initial.ok) throw new Error(initial.reason ?? 'could not read target draft and catalogs');
  const currentCategories = idList(initial.categories, 'categories', initial.catalogs.categories);
  const currentTags = idList(initial.tags, 'tags', initial.catalogs.tags);
  if (!currentCategories || !currentTags || [...currentCategories, ...currentTags].some(id => !Number.isSafeInteger(id)))
    throw new Error('current category or tag selection has an unknown shape; nothing was saved');
  if (currentCategories.length || currentTags.length) {
    const same = ['categories', 'tags'].every(kind => {
      const current = kind === 'categories' ? currentCategories : currentTags;
      return current.length === wanted[kind].length && current.every(id => wanted[kind].includes(id));
    });
    if (same) return { ok: true, action: 'update_draft_classification', game_id: gameId,
      saved: true, verified: true, changed: false, requested: wanted };
    throw new Error('current category or tag selection is non-empty; additions are restricted to empty selections');
  }

  const wantedRows = {};
  for (const kind of Object.keys(CATALOGS)) {
    const cfg = CATALOGS[kind];
    const rows = catalogRows(initial.catalogs[kind]);
    wantedRows[kind] = wanted[kind].map(id => {
      const matches = rows.filter(row => Number(row?.id) === id && clean(row?.[cfg.label] ?? row?.name));
      if (matches.length !== 1) throw new Error(`${kind} ID ${id} is missing or ambiguous in the current catalog`);
      const labels = [...new Set([matches[0][cfg.label], matches[0].name].map(clean).filter(Boolean))];
      return { id, labels };
    });
  }

  for (const kind of Object.keys(CATALOGS)) {
    const items = wantedRows[kind];
    if (!items.length) continue;
    const rows = catalogRows(initial.catalogs[kind]);
    const selector = `[data-qa="${CATALOGS[kind].qa}"] input:not([data-qa="form-suggested-items-input-hidden-input"])`;
    const popupInput = `[data-qa="${CATALOGS[kind].qa}"] input[size="1"]`;
    const field = await evaluate(browser, `() => { const c=document.querySelectorAll('[data-qa="${CATALOGS[kind].qa}"]');
      const visible=e=>Boolean(e?.getClientRects().length); const inputs=Array.from(c).flatMap(x=>Array.from(x.querySelectorAll('input')).filter(visible));
      return { container_count:c.length, input_count:inputs.length, disabled:inputs[0]?.disabled ?? null,
        visible:inputs[0] ? true : false }; }`);
    if (field.container_count !== 1 || field.input_count !== 1 || field.disabled) throw new Error(`${kind} form input is missing or ambiguous; nothing was saved`);
    const opened = await browser.call('browser_click', { target: selector, element: `${kind} input` });
    if (opened?.isError) throw new Error(`${kind} picker could not be opened; nothing was saved`);
    const popup = await evaluate(browser, `() => ({ inputs:document.querySelectorAll(${JSON.stringify(popupInput)}).length,
      listboxes:Array.from(document.querySelectorAll('[role="listbox"]')).filter(e=>e.getClientRects().length).length })`);
    if (popup.inputs !== 1) throw new Error(`${kind} picker search input is missing or ambiguous; nothing was saved`);
    for (const item of items) {
      let candidate = null;
      const attempts = [];
      for (const label of item.labels) {
        const filled = await browser.call('browser_fill_form', { fields: [{ name: kind, type: 'textbox', target: popupInput, value: label }] });
        if (filled?.isError) throw new Error(`${kind} search field rejected the input; nothing was saved`);
        const choices = await evaluate(browser, `() => {
        const visible=e=>Boolean(e.getClientRects().length); const clean=s=>String(s??'').replace(/\\s+/g,' ').trim();
        const nodes=Array.from(document.querySelectorAll('[role="listbox"] [role="option"]')).filter(visible).slice(0,100);
        return nodes.map(e=>({ text:clean(e.innerText), content:clean(e.textContent).slice(0,160),
          aria:clean(e.getAttribute('aria-label')).slice(0,160), title:clean(e.getAttribute('title')).slice(0,160),
          id:e.getAttribute('data-id')??e.getAttribute('data-value')??e.getAttribute('data-key'),
          qa:e.getAttribute('data-qa'), role:e.getAttribute('role'), html:e.outerHTML.slice(0,400) }));
        }`);
        attempts.push({ label, choices: choices.slice(0,12) });
        const matches = choices.filter(choice => [choice.text, choice.content, choice.aria, choice.title].includes(label)
          && (choice.id === null || Number(choice.id) === item.id));
        if (matches.length === 1 && rows.filter(row => Number(row?.id) !== item.id
          && [row?.[CATALOGS[kind].label], row?.name].some(value => clean(value) === label)).length === 0) {
          candidate = { label, option: matches[0] };
          break;
        }
      }
      if (!candidate) throw new Error(`${kind} option for ID ${item.id} was not uniquely identified; inspected: ${JSON.stringify(attempts).slice(0,3000)}`);
      const target = candidate.option.role === 'option'
        ? `[role="listbox"] [role="option"]:text-is(${JSON.stringify(candidate.label)})`
        : candidate.option.qa && /^[A-Za-z0-9_-]+$/.test(candidate.option.qa)
          ? `[data-qa="${candidate.option.qa}"]:text-is(${JSON.stringify(candidate.label)})`
          : null;
      if (!target) throw new Error(`${kind} option for ID ${item.id} has no stable selector; nothing was saved`);
      const clicked = await browser.call('browser_click', { target, element: `${kind} ${candidate.label}` });
      if (clicked?.isError) throw new Error(`${kind} option could not be selected; nothing was saved`);
    }
  }

  const selected = await evaluate(browser, `() => {
    const visible=e=>Boolean(e.getClientRects().length);
    const read=qa=>{ const roots=Array.from(document.querySelectorAll('[data-qa="'+qa+'"]'));
      if(roots.length!==1) return { count:roots.length, ids:null };
      const hidden=roots[0].querySelectorAll('[data-qa="form-suggested-items-input-hidden-input"]');
      return { count:hidden.length, ids:hidden.length===1 ? (hidden[0].value??'') : null,
        chips:Array.from(roots[0].querySelectorAll('[data-qa="form-suggested-items-input-selected-item"]'))
          .filter(visible).map(x=>x.innerText.trim()) }; };
    const save=Array.from(document.querySelectorAll('button')).filter(b=>visible(b)&&b.innerText.trim()==='Сохранить');
    return { page_ok:location.origin==='${CONSOLE_ORIGIN}'&&location.pathname==='/console/application/${gameId}'&&location.hash==='#application-info-draft',
      categories:read('categories'), tags:read('tags'), save_count:save.length, save_enabled:save.length===1&&!save[0].disabled };
  }`);
  for (const kind of Object.keys(CATALOGS)) {
    if (!wanted[kind].length) continue;
    const field = selected[kind];
    const value = field?.ids;
    let raw;
    try { raw = JSON.parse(value); } catch { raw = String(value ?? '').split(/[;,\s]+/).filter(Boolean); }
    if (!Array.isArray(raw)) raw = [raw];
    const ids = idList(raw, kind, initial.catalogs[kind]);
    const labels = wantedRows[kind].map(row => row.labels[0]);
    const hiddenMatches = !String(value ?? '').trim() || (Array.isArray(ids) && ids.length === wanted[kind].length
      && ids.every((id, i) => id === wanted[kind][i]));
    if (field?.count !== 1 || !hiddenMatches
        || field.chips?.length !== labels.length || field.chips.some((label, i) => clean(label) !== labels[i]))
      throw new Error(`${kind} selected IDs or labels did not match the request; nothing was saved`);
  }
  if (!selected.page_ok || selected.save_count !== 1 || !selected.save_enabled)
    throw new Error('Target draft or enabled Save button is missing or ambiguous; nothing was saved');
  await browser.call('browser_click', { target: 'button.form__button[type="submit"]:text-is("Сохранить")', element: 'кнопка сохранения черновика' });
  await browser.call('browser_wait_for', { time: 2 });
  const after = await evaluate(browser, `async () => {
    if(location.origin!=='${CONSOLE_ORIGIN}'||location.pathname!=='/console/application/${gameId}'||location.hash!=='#application-info-draft') return {ok:false,reason:'wrong_page_after_save'};
    const r=await fetch('/console/api/application/${gameId}',{credentials:'same-origin'}); if(!r.ok) return {ok:false,http_status:r.status};
    const app=(await r.json())?.data; if(!app||String(app.id)!=='${gameId}'||!app.draft) return {ok:false,reason:'draft_unavailable_after_save'};
    return {ok:true,categories:app.draft.categories??[],tags:app.draft.tags??[]};
  }`);
  const verified = after.ok && Object.keys(CATALOGS).every(kind => {
    const ids = idList(after[kind], kind, initial.catalogs[kind]);
    return Array.isArray(ids) && ids.length === wanted[kind].length && wanted[kind].every(id => ids.includes(id));
  });
  return { ok: Boolean(verified), action: 'update_draft_classification', game_id: gameId,
    saved: verified ? true : 'unknown', verified: Boolean(verified), requested: wanted,
    ...(verified ? {} : { reason: 'saved draft did not confirm requested classification IDs', after: after.ok ? after : undefined }) };
}
