'use strict';

const { CLOUD_PREFIX, SELF_MANAGED_PREFIX } = require('./audienceScope.js');

// A prefix that was clearly MEANT to scope a value to one docs build, spelled
// in a way the parser does not accept. Deliberately generous: underscores for
// hyphens, a space before the colon, any casing, a missing separator, and the
// retired `self-hosted-only` product name.
//
// Why this matters more than an unmatched link: an unrecognised prefix is not
// dropped, it is published. `cloud_only: Cloud clusters require...` renders on
// the page as that literal string, prefix and all, in both builds. Nothing
// errors, nothing is missing, and the only way to notice is to read the
// rendered page.
const SUSPICIOUS_PREFIX = /^[\s]*((?:cloud|self[-_ ]?managed|self[-_ ]?hosted)[-_ ]?only)[\s]*:/i;

// Keys that look like an attempt at the audience booleans but are not the two
// the templates read. `self_hosted_only` is absent on purpose: it is the
// deprecated spelling and parseAudience still honours it.
const VALID_FLAGS = new Set(['cloud_only', 'self_managed_only', 'self_hosted_only']);
const SUSPICIOUS_FLAG = /^(?:cloud|self[-_ ]?managed|self[-_ ]?hosted)[-_ ]?only$/i;

/**
 * Report a string whose leading prefix looks like a failed audience scope.
 *
 * @param {unknown} value
 * @returns {string|null} The offending prefix, or null when the value is fine.
 */
function findSuspiciousPrefix (value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // An exact prefix is correct by definition, so check those first.
  if (trimmed.startsWith(CLOUD_PREFIX) || trimmed.startsWith(SELF_MANAGED_PREFIX)) return null;
  const match = SUSPICIOUS_PREFIX.exec(trimmed);
  return match ? match[1] : null;
}

/**
 * Report object keys that look like an attempt at the audience booleans.
 *
 * A misspelled flag is silent in a different way: the template's `{{#if
 * cloud_only}}` is simply false, so the value renders in BOTH builds rather
 * than the one the writer scoped it to.
 *
 * @param {unknown} item
 * @returns {string[]} The offending key names.
 */
function findSuspiciousFlags (item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
  return Object.keys(item).filter((key) => !VALID_FLAGS.has(key) && SUSPICIOUS_FLAG.test(key));
}

function pushPrefix (problems, property, field, value) {
  const prefix = findSuspiciousPrefix(value);
  if (prefix) {
    problems.push({
      property,
      field,
      problem: 'unrecognized-prefix',
      detail: prefix,
      text: String(value).trim().slice(0, 120)
    });
  }
}

function pushFlags (problems, property, field, item) {
  for (const key of findSuspiciousFlags(item)) {
    problems.push({ property, field, problem: 'unrecognized-flag', detail: key, text: '' });
  }
}

/**
 * Walk every audience-scopable field on every property and report the scopes
 * that will not take effect.
 *
 * Run BEFORE applyPropertyLinks: that pass flattens an array description into
 * a single string, after which a per-paragraph prefix can no longer be
 * attributed to the paragraph it came from.
 *
 * @param {Record<string, object>} properties
 * @returns {Array<{property: string, field: string, problem: string, detail: string, text: string}>}
 */
function findAudienceScopeProblems (properties) {
  const problems = [];
  for (const [name, prop] of Object.entries(properties || {})) {
    if (!prop || typeof prop !== 'object') continue;

    if (Array.isArray(prop.description)) {
      prop.description.forEach((para, i) => pushPrefix(problems, name, `description[${i}]`, para));
    }

    if (prop.links && typeof prop.links === 'object') {
      for (const [key, value] of Object.entries(prop.links)) {
        pushPrefix(problems, name, `links["${key}"]`, value);
      }
    }

    // Both spellings: `related_topics` is the field 118 live entries use, and
    // `see_also` is what replaced it.
    for (const field of ['see_also', 'related_topics']) {
      const items = prop[field];
      if (!Array.isArray(items)) continue;
      items.forEach((item, i) => {
        pushPrefix(problems, name, `${field}[${i}]`, item);
        pushFlags(problems, name, `${field}[${i}]`, item);
      });
    }

    for (const field of ['admonitions', 'includes']) {
      const items = prop[field];
      if (!Array.isArray(items)) continue;
      items.forEach((item, i) => pushFlags(problems, name, `${field}[${i}]`, item));
    }
  }
  return problems;
}

module.exports = findAudienceScopeProblems;
module.exports.findAudienceScopeProblems = findAudienceScopeProblems;
module.exports.findSuspiciousPrefix = findSuspiciousPrefix;
module.exports.findSuspiciousFlags = findSuspiciousFlags;
