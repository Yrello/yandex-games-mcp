import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeDomainTool } from '../src/domains.mjs';

function png(width, height) {
  const crc = data => { let c=0xffffffff; for (const v of data) { c^=v; for(let i=0;i<8;i++) c=(c>>>1)^(c&1?0xedb88320:0); } return (c^0xffffffff)>>>0; };
  const chunk = (type, data) => { const out=Buffer.alloc(12+data.length); out.writeUInt32BE(data.length); out.write(type,4,'ascii'); data.copy(out,8); out.writeUInt32BE(crc(out.subarray(4,8+data.length)),8+data.length); return out; };
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height,4); ihdr[8]=8; ihdr[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',ihdr), chunk('IDAT',Buffer.from([0])), chunk('IEND',Buffer.alloc(0))]);
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
      if (['browser_navigate','browser_wait_for','browser_fill_form','browser_click','browser_file_upload'].includes(name)) {
        return { content: [{ type: 'text', text: `${name} ok` }] };
      }
      throw new Error(`unexpected browser call ${name}`);
    },
  };
}

const page = gameId => ({ origin:'https://games.yandex.ru', pathname:`/console/application/${gameId}`, hash:'#application-info-draft' });
function draft(gameId, language = 'ru', overrides = {}) {
  return { ok:true, game_id:gameId,
    title:{ru:'Старое RU',en:'Old EN',es:'Old ES'},
    fields:{ seo_description:{ru:'',en:''}, description:{ru:'',en:''},
      short_description:{ru:'',en:'',es:''}, instructions:{ru:'',en:'',es:''}, features:{languages:['ru','en']}, ...overrides.fields },
    completeness:{ru:{},en:{},es:{}}, media:{icon:{ru:'old-icon',en:'old-icon-en',es:'old-icon-es'},cover:{ru:'old-cover',en:'old-cover-en',es:'old-cover-es'}},
    active_language:language, ...overrides };
}
const pageAndDraft = (gameId, data) => [page(gameId), data];
const resultValue = result => JSON.parse(result.content[0].text);

test('localized update validates arguments before opening the browser', async () => {
  const browser = mockBrowser([]);
  const result = await invokeDomainTool('update_localized_fields', {
    game_id:'101003', language:'en', fields:{ unknown:'value' },
  }, browser);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unsupported localized field/);
  assert.equal(browser.calls.length, 0);
});

for (const language of ['ru','en','es']) {
  test(`localized update selects ${language} and verifies saved API values`, async () => {
    const gameId='101003', value=language === 'ru' ? 'Новое название' : language === 'en' ? 'New title' : 'Nuevo titulo';
    const label = language === 'ru' ? 'Русский' : language === 'en' ? 'Английский' : 'испанский';
    const values = [
      ...pageAndDraft(gameId, draft(gameId)),
      [{label:'Русский',active:true},{label:'Английский',active:false},{label:'Испанский',active:false}],
      ...(language !== 'ru' ? [page(gameId), [label === 'испанский' ? 'Испанский' : label]] : [['Русский']]),
      [{selector:`#title${gameId}`,count:1,tag:'INPUT',actual:language==='ru'?'Старое RU':language==='en'?'Old EN':'Old ES',expected:language==='ru'?'Старое RU':language==='en'?'Old EN':'Old ES'}],
      [{selector:`#title${gameId}`,actual:value,expected:value}],
      {count:1,disabled:false}, page(gameId), [label === 'испанский' ? 'Испанский' : label],
      draft(gameId, language, { title:{ru:language==='ru'?value:'Старое RU', en:language==='en'?value:'Old EN', es:language==='es'?value:'Old ES'} }),
    ];
    const browser=mockBrowser(values);
    const result=await invokeDomainTool('update_localized_fields',{game_id:gameId,language,fields:{title:value}},browser);
    const report=resultValue(result);
    assert.equal(result.isError,undefined, `${result.content[0].text}\n${JSON.stringify(browser.calls)}`);
    assert.equal(report.ok,true);
    assert.equal(report.language,language);
    assert.equal(report.fields.title,value);
    assert.equal(report.verified,true);
    assert.equal(values.length,0);
    assert.equal(browser.calls.some(call=>call.name==='browser_click' && /moder|submit|отправ/i.test(call.args.element ?? call.args.target)),false);
  });
}

test('localized update fails closed for another page and for a locale absent from the draft', async () => {
  const wrongPage=mockBrowser([{...page('101001')}]);
  const pageResult=await invokeDomainTool('update_localized_fields',{game_id:'101003',language:'ru',fields:{title:'x'}},wrongPage);
  assert.equal(pageResult.isError,true);
  assert.match(pageResult.content[0].text,/requested game draft page/);
  assert.equal(wrongPage.calls.some(call=>call.name==='browser_fill_form'),false);

  const noEnglish=draft('101003');
  noEnglish.fields.features.languages=['ru'];
  delete noEnglish.title.en;
  for (const field of ['seo_description','description','short_description','instructions']) delete noEnglish.fields[field].en;
  delete noEnglish.media.icon.en;
  delete noEnglish.media.cover.en;
  delete noEnglish.completeness.en;
  const wrongLocale=mockBrowser([...pageAndDraft('101003',noEnglish), [{ label: 'Русский', active: true }]]);
  const localeResult=await invokeDomainTool('update_localized_fields',{game_id:'101003',language:'en',fields:{title:'x'}},wrongLocale);
  assert.equal(localeResult.isError,true);
  assert.match(localeResult.content[0].text,/language tabs are missing or ambiguous/);
  assert.equal(wrongLocale.calls.some(call=>call.name==='browser_fill_form'),false);
});

test('localized update can fill an empty locale present in the Console tabs', async () => {
  const gameId = '101003';
  const emptyLocale = draft(gameId);
  delete emptyLocale.title.es;
  for (const field of ['seo_description','description','short_description','instructions']) delete emptyLocale.fields[field].es;
  delete emptyLocale.completeness.es;
  delete emptyLocale.media.icon.es;
  delete emptyLocale.media.cover.es;
  const values = [
    ...pageAndDraft(gameId, emptyLocale),
    [{ label: 'Русский', active: true }, { label: 'Испанский', active: false }],
    page(gameId), ['Испанский'],
    [{ selector: `#title${gameId}`, count: 1, tag: 'INPUT', actual: '', expected: '' }],
    [{ selector: `#title${gameId}`, actual: 'Titulo', expected: 'Titulo' }],
    { count: 1, disabled: false }, page(gameId), ['Испанский'],
    { ...emptyLocale, title: { ...emptyLocale.title, es: 'Titulo' } },
  ];
  const browser = mockBrowser(values);
  const result = await invokeDomainTool('update_localized_fields', { game_id: gameId, language: 'es', fields: { title: 'Titulo' } }, browser);
  assert.equal(result.isError, undefined, `${result.content[0].text}\n${JSON.stringify(browser.calls.map(call => call.args.function ?? call.args.target))}`);
  assert.equal(resultValue(result).verified, true);
  assert.equal(browser.calls.filter(call => call.name === 'browser_click' && /form__button\[type="submit"\]:visible/.test(call.args.target ?? '')).length, 1);
});

test('add_draft_localization selects one exact picker option and saves once', async () => {
  const gameId = '101003';
  const before = draft(gameId);
  delete before.title.es;
  for (const field of ['seo_description','description','short_description','instructions']) delete before.fields[field].es;
  delete before.completeness.es;
  delete before.media.icon.es;
  delete before.media.cover.es;
  const after = { ...before, fields: { ...before.fields, features: { ...before.fields.features, languages: ['ru','en','es'] } }, completeness: { ...before.completeness, es: {} } };
  const browser = mockBrowser([
    ...pageAndDraft(gameId, before),
    { root_count: 1, tabs: [{ label: 'Русский', active: true }, { label: 'Английский', active: false }], picker_count: 1, picker_disabled: false, listbox_count: 0 },
    page(gameId),
    { listbox_count: 1, options: [{ label: 'Испанский', disabled: false }] },
    page(gameId),
    [{ label: 'Русский', active: false }, { label: 'Английский', active: false }, { label: 'Испанский', active: true }],
    { count: 1, enabled: 1, disabled: false },
    page(gameId), after,
  ]);
  const result = await invokeDomainTool('add_draft_localization', { game_id: gameId, language: 'es' }, browser);
  const report = resultValue(result);
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.equal(report.ok, true, result.content[0].text);
  assert.equal(report.verified, true);
  assert.deepEqual(report.locale_codes, ['ru','en','es']);
  assert.equal(browser.calls.filter(call => call.name === 'browser_click' && call.args.target === '[data-qa="application-draft-languages"] > .g-select > button').length, 1);
  assert.equal(browser.calls.filter(call => call.name === 'browser_click' && call.args.target === '[role="listbox"] [role="option"]:has-text("Испанский")').length, 1);
  assert.equal(browser.calls.filter(call => call.name === 'browser_click' && call.args.target.includes('form__button[type="submit"]')).length, 1);
  assert.equal(browser.calls.some(call => call.name === 'browser_click' && /has-text\("Сохранить"\)/.test(call.args.target)), false);
});

test('add_draft_localization refuses duplicate picker options and does not Save', async () => {
  const gameId = '101003';
  const before = draft(gameId);
  delete before.title.es;
  for (const field of ['seo_description','description','short_description','instructions']) delete before.fields[field].es;
  delete before.completeness.es;
  delete before.media.icon.es;
  delete before.media.cover.es;
  const browser = mockBrowser([
    ...pageAndDraft(gameId, before),
    { root_count: 1, tabs: [{ label: 'Русский', active: true }], picker_count: 1, picker_disabled: false, listbox_count: 0 },
    page(gameId),
    { listbox_count: 1, options: [{ label: 'Испанский', disabled: false }, { label: 'Испанский', disabled: false }] },
  ]);
  const result = await invokeDomainTool('add_draft_localization', { game_id: gameId, language: 'es' }, browser);
  assert.equal(result.isError, undefined);
  const report = resultValue(result);
  assert.equal(report.ok, false);
  assert.equal(report.saved, false);
  assert.match(report.reason, /one exact supported language option/);
  assert.equal(browser.calls.some(call => call.name === 'browser_click' && call.args.target.includes('[role="option"]:text-is(')), false);
  assert.equal(browser.calls.some(call => call.name === 'browser_click' && call.args.target.includes('form__button[type="submit"]')), false);
});

test('add_draft_localization is idempotent for an already verified locale', async () => {
  const gameId = '101003';
  const existing = draft(gameId);
  existing.fields.features.languages.push('es');
  const browser = mockBrowser(pageAndDraft(gameId, existing));
  const result = await invokeDomainTool('add_draft_localization', { game_id: gameId, language: 'es' }, browser);
  const report = resultValue(result);
  assert.equal(report.ok, true);
  assert.equal(report.added, false);
  assert.equal(report.verified, true);
  assert.equal(browser.calls.some(call => call.name === 'browser_click'), false);
});

test('localized update fails closed when a region-specific Console label does not match Intl', async () => {
  const gameId = '101003';
  const before = draft(gameId, 'ru', { title: { ru: 'Demo', 'es-MX': 'Demo' }, completeness: { ru: {}, 'es-MX': {} } });
  const browser = mockBrowser([
    ...pageAndDraft(gameId, before),
    [{ label: 'Русский', active: true }, { label: 'Mexican Spanish', active: false }],
  ]);
  const result = await invokeDomainTool('update_localized_fields', {
    game_id: gameId, language: 'es-MX', fields: { title: 'Titulo' },
  }, browser);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /language tabs are missing or ambiguous/);
  assert.equal(browser.calls.some(call => call.name === 'browser_click' || call.name === 'browser_fill_form'), false);
});

test('media preflight rejects invalid input before any browser call', async () => {
  const browser=mockBrowser([]);
  const result=await invokeDomainTool('upload_draft_media',{game_id:'101003',language:'ru',icon_path:'missing-draft.png'},browser);
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/does not exist/);
  assert.equal(browser.calls.length,0);
});

test('valid media upload saves once, verifies the new locale file ID, and never submits for moderation', async () => {
  const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const folder=await mkdtemp(path.join(projectRoot,'.draft-media-'));
  const icon=path.join(folder,'icon.png');
  try {
    await writeFile(icon,png(512,512));
    const gameId='101003';
    const beforeDraft=draft(gameId);
    beforeDraft.media.icon.ru=null;
    const values=[
      ...pageAndDraft(gameId,beforeDraft),
      [{label:'Русский',active:true}], ['Русский'],
      [{kind:'icon',inputs:1,buttons:1,inputName:'icon-field',accept:'image/png',buttonText:'Выбрать файл',markers:0,fileId:null}],
      page(gameId), ['Русский'],
      {fields:1,count:1,file_id:'14189603',error:''},
      {count:1,disabled:false}, page(gameId), ['Русский'],
      draft(gameId,'ru',{media:{icon:{ru:14189603,en:'old-icon-en'},cover:{ru:'old-cover',en:'old-cover-en'}}}),
    ];
    const browser=mockBrowser(values);
    const result=await invokeDomainTool('upload_draft_media',{game_id:gameId,language:'ru',icon_path:path.relative(projectRoot,icon)},browser);
    const report=resultValue(result);
    assert.equal(result.isError,undefined, result.content[0].text);
    assert.equal(report.ok,true);
    assert.equal(report.selected_file_ids.icon,'14189603');
    assert.equal(report.new_file_ids.icon,14189603);
    assert.equal(report.verified,true);
    assert.equal(values.length,0);
    const clicks=browser.calls.filter(call=>call.name==='browser_click');
    assert.ok(browser.calls.some(call=>call.name==='browser_wait_for' && call.args.time===2));
    assert.equal(clicks.filter(call=>/form__button\[type="submit"\]:visible/.test(call.args.target ?? '')).length,1);
    assert.equal(clicks.some(call=>/moder|submit|отправ/i.test(call.args.element ?? call.args.target)),false);
  } finally {
    await rm(folder,{recursive:true,force:true});
  }
});

test('existing media needs an explicit replace flag and its saved file ID is verified', async () => {
  const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const folder=await mkdtemp(path.join(projectRoot,'.draft-media-'));
  const icon=path.join(folder,'icon.png');
  try {
    await writeFile(icon,png(512,512));
    const gameId='101003', iconPath=path.relative(projectRoot,icon);
    const beforeDraft=draft(gameId);
    beforeDraft.media.icon.ru=14000000;
    const denied=mockBrowser([...pageAndDraft(gameId,beforeDraft),
      [{label:'Русский',active:true}], ['Русский']]);
    const deniedResult=await invokeDomainTool('upload_draft_media',
      {game_id:gameId,language:'ru',icon_path:iconPath},denied);
    assert.equal(deniedResult.isError,true);
    assert.match(deniedResult.content[0].text,/replace_existing=true/);
    assert.equal(denied.calls.some(call=>call.name==='browser_click'),false);

    const values=[
      ...pageAndDraft(gameId,beforeDraft),
      [{label:'Русский',active:true}], ['Русский'],
      [{kind:'icon',inputs:0,buttons:0,markers:1,fileId:'14000000'}],
      page(gameId), ['Русский'],
      {inputs:1,buttons:1,markers:0,name:'icon-field',accept:'image/png',buttonText:'Выбрать файл'},
      {fields:1,count:1,file_id:'14000000',error:''},
      {fields:1,count:1,file_id:'14189610',error:''},
      {count:1,disabled:false}, page(gameId), ['Русский'],
      draft(gameId,'ru',{media:{icon:{ru:14189610,en:'old-icon-en'},cover:{ru:'old-cover',en:'old-cover-en'}}}),
    ];
    const browser=mockBrowser(values);
    const result=await invokeDomainTool('upload_draft_media',
      {game_id:gameId,language:'ru',icon_path:iconPath,replace_existing:true},browser);
    const report=resultValue(result);
    assert.equal(report.ok,true,result.content[0].text);
    assert.equal(report.old_file_ids.icon,14000000);
    assert.equal(report.selected_file_ids.icon,'14189610');
    assert.equal(report.new_file_ids.icon,14189610);
    assert.equal(values.length,0);
    const clicks=browser.calls.filter(call=>call.name==='browser_click');
    assert.equal(clicks.filter(call=>/form-attach__close/.test(call.args.target??'')).length,1);
    assert.equal(clicks.filter(call=>/form__button\[type="submit"\]:visible/.test(call.args.target??'')).length,1);
  } finally {
    await rm(folder,{recursive:true,force:true});
  }
});
