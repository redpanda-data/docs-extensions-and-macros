'use strict';

/**
 * Normalizes a property's related-topics data into one shape for the
 * templates to render, regardless of which field or convention the override
 * author used:
 *
 *   - see_also (current): array of items, each either a plain string (shown
 *     everywhere) or {content, cloud_only, self_hosted_only} (shown only in
 *     the named build). Schema-validated — see docs-data/property-overrides.schema.json.
 *   - related_topics (deprecated, still read for back-compat with existing
 *     override files): array of strings, optionally prefixed with
 *     'cloud-only:' / 'self-managed-only:' to get the same conditional
 *     behaviour. That prefix was free text with no validation; see_also
 *     replaces it with data a schema can check.
 *
 * @param {object} property - A property record, as extracted or overridden.
 * @returns {Array<{content: string, cloudOnly: boolean, selfHostedOnly: boolean}>}
 */
function normalizeSeeAlso(property) {
  if (!property) return [];
  const rawItems = Array.isArray(property.see_also)
    ? property.see_also
    : Array.isArray(property.related_topics)
      ? property.related_topics
      : [];

  return rawItems
    .map((item) => {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed.startsWith('cloud-only:')) {
          return { content: trimmed.slice('cloud-only:'.length).trim(), cloudOnly: true, selfHostedOnly: false };
        }
        if (trimmed.startsWith('self-managed-only:')) {
          return { content: trimmed.slice('self-managed-only:'.length).trim(), cloudOnly: false, selfHostedOnly: true };
        }
        return { content: trimmed, cloudOnly: false, selfHostedOnly: false };
      }
      if (item && typeof item === 'object' && typeof item.content === 'string') {
        return {
          content: item.content.trim(),
          cloudOnly: item.cloud_only === true,
          selfHostedOnly: item.self_hosted_only === true,
        };
      }
      return null;
    })
    .filter((item) => item && item.content);
}

/**
 * Builds the single view object property.hbs/topic-property.hbs render the
 * "Related topics" row from: the normalized item list, plus which env-cloud
 * branch (if any) every item shares, so the row's own header can be wrapped
 * once instead of duplicated per item.
 *
 * sectionType is 'cloud' only when every item is cloud-only, 'self-managed'
 * only when every item is self-hosted-only, and 'normal' otherwise (a mix of
 * conditional and/or unconditional items, each wrapped individually).
 *
 * @param {object} property - A property record, as extracted or overridden.
 * @returns {{items: Array, sectionType: ('cloud'|'self-managed'|'normal')}}
 */
function seeAlsoView(property) {
  const items = normalizeSeeAlso(property);
  let sectionType = 'normal';
  if (items.length > 0) {
    if (items.every((item) => item.cloudOnly)) sectionType = 'cloud';
    else if (items.every((item) => item.selfHostedOnly)) sectionType = 'self-managed';
  }
  return { items, sectionType };
}

module.exports = seeAlsoView;
module.exports.normalizeSeeAlso = normalizeSeeAlso;
