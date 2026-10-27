import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestDraftActions } from '../src/draft-guidance.mjs';

const readinessNote = 'Suggestions do not confirm moderation readiness.';

test('maps supported missing fields to draft tools per locale', () => {
  const result = suggestDraftActions({
    ru: { missing_fields: [
      'field.title.label', 'field.description.label', 'field.seo-description.label',
      'field.instruction.label', 'field.keywords.label', 'field.icon.label', 'field.cover.label',
    ] },
  });
  assert.deepEqual(result, {
    by_language: { ru: { available: true, suggestions: [
      { tool: 'update_localized_fields', argument: 'fields.title' },
      { tool: 'update_localized_fields', argument: 'fields.description' },
      { tool: 'update_localized_fields', argument: 'fields.seo_description' },
      { tool: 'update_localized_fields', argument: 'fields.instructions' },
      { tool: 'update_fields', argument: 'fields.keywords' },
      { tool: 'upload_draft_media', argument: 'icon_path' },
      { tool: 'upload_draft_media', argument: 'cover_path' },
    ], unresolved: [] } },
    note: readinessNote,
  });
});

test('leaves unsupported classification and unknown keys unresolved in stable order', () => {
  const fields = [
    'field.video.name', 'field.screenshots.name', 'field.categories.label',
    'field.tags.label', 'field.future.label', 'field.icon.label', 'field.future.label',
  ];
  const result = suggestDraftActions({ en: { percent: 10, missing_fields: fields } });
  assert.deepEqual(result.by_language.en, {
    available: true,
    suggestions: [{ tool: 'upload_draft_media', argument: 'icon_path' }],
    unresolved: fields.slice(0, 5).concat(fields[6]),
  });
  assert.match(result.note, /do not confirm moderation readiness/);
});

test('handles partial completeness and malformed input without inventing actions', () => {
  assert.deepEqual(suggestDraftActions({ ru: { percent: null, missing_fields: null }, en: {} }), {
    by_language: { ru: { available: false, suggestions: [], unresolved: [] },
      en: { available: false, suggestions: [], unresolved: [] } },
    note: readinessNote,
  });
  assert.deepEqual(suggestDraftActions(null), { by_language: {}, note: readinessNote });
});
