const ACTIONS = new Map([
  ['field.title.label', ['update_localized_fields', 'fields.title']],
  ['field.description.label', ['update_localized_fields', 'fields.description']],
  ['field.seo-description.label', ['update_localized_fields', 'fields.seo_description']],
  ['field.instruction.label', ['update_localized_fields', 'fields.instructions']],
  ['field.keywords.label', ['update_fields', 'fields.keywords']],
  ['field.icon.label', ['upload_draft_media', 'icon_path']],
  ['field.cover.label', ['upload_draft_media', 'cover_path']],
]);

/**
 * Turn check_draft completeness into suggestions for supported draft tools.
 * This is guidance only; it does not imply that a draft is ready for moderation.
 */
export function suggestDraftActions(completeness) {
  const by_language = {};
  if (!completeness || typeof completeness !== 'object' || Array.isArray(completeness)) {
    return { by_language, note: 'Suggestions do not confirm moderation readiness.' };
  }

  for (const [language, data] of Object.entries(completeness)) {
    const suggestions = [];
    const unresolved = [];
    const fields = data?.missing_fields;
    if (Array.isArray(fields)) {
      for (const key of fields) {
        const action = typeof key === 'string' ? ACTIONS.get(key) : undefined;
        if (action) suggestions.push({ tool: action[0], argument: action[1] });
        else unresolved.push(key);
      }
    }
    by_language[language] = { available: Array.isArray(fields), suggestions, unresolved };
  }
  return { by_language, note: 'Suggestions do not confirm moderation readiness.' };
}
