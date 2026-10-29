'use strict'

/* The field vocabulary every value macro shares: propval:, rpkval: and
 * connectval:. A field means the same thing in every macro, so a writer who
 * knows `introduced` or `values` in one knows it in all of them, and the
 * aliases (the JSON key names, and the older spellings) are accepted
 * everywhere the field exists.
 *
 * Each macro declares which fields it supports with defineFields, mapping its
 * own data to the canonical names here. A macro may also have fields of its
 * own (propval's unit, rpkval's shorthand) and aliases of its own (propval's
 * minimum), which no other macro accepts.
 *
 * macros/REFERENCE.adoc has one table of every field per macro, and a test
 * fails when it and these declarations disagree.
 */

// Canonical fields and the aliases every macro that supports the field
// accepts for it. `inverse` aliases name the opposite of their field:
// optional is the opposite of required.
const SHARED_FIELDS = {
  default: {},
  type: {},
  description: { aliases: ['desc'] },
  summary: { aliases: ['short_description'] },
  values: { aliases: ['options', 'enum', 'accepted-values', 'annotated_options'] },
  introduced: { aliases: ['since', 'version'] },
  deprecated: { aliases: ['is_deprecated'] },
  status: {},
  required: { inverse: ['optional'] },
  examples: { aliases: ['example'] },
  advanced: { aliases: ['is_advanced'] },
  secret: { aliases: ['is_secret'] },
  enterprise: { aliases: ['is_enterprise'] },
  category: { aliases: ['categories'] },
  aliases: {},
  'see-also': { aliases: ['see_also', 'seeAlso'] },
  'cloud-access': { aliases: ['cloud'] },
}

const own = (object, key) => Boolean(object) && Object.prototype.hasOwnProperty.call(object, key)
const lower = (value) => String(value == null ? '' : value).trim().toLowerCase()

/**
 * The field set of one macro.
 *
 * @param {string} macro - The macro as written in messages, such as 'propval:'.
 * @param {object} fields - Canonical or macro-only field name -> options. A
 *   shared field gets the shared aliases; options may carry `cloudHidden`,
 *   `levels` (which targets have it, such as ['flag', 'command']) and
 *   `rich` (the value is text in a source format, such as a description).
 * @param {object} [aliases] - This macro's own alias -> field.
 * @param {object} [dropped] - Names the macro once documented and no longer
 *   supports, name -> why. Accepted with a warning instead of an error.
 */
function defineFields (macro, fields, aliases = {}, dropped = {}) {
  const FIELD_ALIASES = {}
  const INVERSE_ALIASES = {}
  for (const name of Object.keys(fields)) {
    const shared = SHARED_FIELDS[name]
    if (!shared) continue
    for (const alias of shared.aliases || []) FIELD_ALIASES[lower(alias)] = name
    for (const alias of shared.inverse || []) INVERSE_ALIASES[lower(alias)] = name
  }
  for (const [alias, name] of Object.entries(aliases)) FIELD_ALIASES[lower(alias)] = name

  /**
   * The canonical field for a name as written, with `invert` for an inverse
   * alias, or undefined for a field this macro does not support.
   */
  function resolveField (field) {
    const key = lower(field)
    if (own(fields, key)) return { name: key, invert: false }
    if (own(FIELD_ALIASES, key)) return { name: FIELD_ALIASES[key], invert: false }
    if (own(INVERSE_ALIASES, key)) return { name: INVERSE_ALIASES[key], invert: true, as: key }
    return undefined
  }

  const normalizeField = (field) => {
    const resolved = resolveField(field)
    return resolved && resolved.name
  }

  const droppedReason = (field) => (own(dropped, lower(field)) ? dropped[lower(field)] : undefined)

  /**
   * The message for a field this macro does not support, listing the ones
   * it does, so the warning is all a writer needs to fix the call.
   */
  const unsupportedMessage = (call, requested, level) => {
    const names = Object.keys(fields).filter((name) => !level || !fields[name].levels || fields[name].levels.includes(level))
    return `${call}: '${requested}' is not a field ${macro} supports${level ? ` for a ${level}` : ''}. Supported fields: ${names.join(', ')}.`
  }

  return { macro, FIELDS: fields, FIELD_ALIASES, INVERSE_ALIASES, DROPPED: dropped, resolveField, normalizeField, droppedReason, unsupportedMessage }
}

/**
 * Every alias a field set accepts, field -> sorted aliases, inverse aliases
 * marked with a trailing ' (inverted)'. For the REFERENCE.adoc table and its
 * test.
 */
function aliasesByField (set) {
  const out = {}
  for (const name of Object.keys(set.FIELDS)) out[name] = []
  for (const [alias, name] of Object.entries(set.FIELD_ALIASES)) if (out[name]) out[name].push(alias)
  for (const [alias, name] of Object.entries(set.INVERSE_ALIASES)) if (out[name]) out[name].push(`${alias} (inverted)`)
  for (const name of Object.keys(out)) out[name].sort()
  return out
}

module.exports = { SHARED_FIELDS, defineFields, aliasesByField }
