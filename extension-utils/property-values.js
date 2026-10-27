'use strict'

/* Field values for one entry of a published redpanda-properties-<tag>.json,
 * formatted the way the generated property reference renders them.
 *
 * Shared by the propval: inline macro (macros/prop.js) and the
 * migrate-property-values report, so prose, the migration report, and the
 * reference tables agree. The value strings come from the reference
 * generator's own helpers wherever the tables show the field:
 *
 *   default   formatPropertyValue (the table's code value), and the
 *             extractor's default_human_readable where the data carries it
 *             (the table's parenthetical, such as "2 weeks").
 *   unit      the table's Unit row: the units field, else formatUnits(name).
 *
 * Two humanizations go beyond what the table prints, and both are derived
 * only from data the table also shows, never guessed:
 *
 *   Durations without default_human_readable use humanizeDuration, a port of
 *   the extractor's format_time_human_readable (the function that produced
 *   default_human_readable), so the wording is identical.
 *   Byte values use IEC units (128 MiB) only when the table's Unit row says
 *   bytes and the value is an exact multiple. Anything else renders exactly.
 */

const formatPropertyValue = require('../tools/property-extractor/helpers/formatPropertyValue')
const formatUnits = require('../tools/property-extractor/helpers/formatUnits')
const { escapeHtml } = require('./html-utils')

const FORMAT_HUMAN = 'human'
const FORMAT_RAW = 'raw'

// Every field propval: supports. `cloudHidden` marks the fields the reference
// pages wrap in ifndef::env-cloud[], so a Cloud page never states them either.
const FIELDS = {
  default: { cloudHidden: true },
  type: {},
  unit: {},
  min: {},
  max: {},
  restart: {},
  nullable: {},
  values: {},
  scope: {},
  introduced: { cloudHidden: true },
  visibility: { cloudHidden: true },
  restored: { cloudHidden: true },
  aliases: { cloudHidden: true },
  'cloud-access': {},
}

// The JSON key names and table labels are accepted as aliases, so a writer
// who types what they see in the data or on the page gets the same field.
const FIELD_ALIASES = {
  minimum: 'min',
  maximum: 'max',
  needs_restart: 'restart',
  'requires-restart': 'restart',
  units: 'unit',
  enum: 'values',
  'accepted-values': 'values',
  config_scope: 'scope',
  version: 'introduced',
  gets_restored: 'restored',
  cloud: 'cloud-access',
}

const DURATION_UNITS = { milliseconds: 1, seconds: 1000 }

/**
 * Canonical field name, or undefined for a field propval: does not support.
 */
function normalizeField (field) {
  const key = String(field == null ? '' : field).trim().toLowerCase()
  if (Object.prototype.hasOwnProperty.call(FIELDS, key)) return key
  if (Object.prototype.hasOwnProperty.call(FIELD_ALIASES, key)) return FIELD_ALIASES[key]
  return undefined
}

/**
 * The unit the reference table prints for a property, lowercased for prose:
 * the units field, else the one formatUnits derives from the name suffix.
 * Empty when the table prints no Unit row.
 */
function unitOf (entry) {
  if (entry && typeof entry.units === 'string' && entry.units.trim()) return entry.units.trim()
  return formatUnits(entry && entry.name) || ''
}

/**
 * Port of property_extractor.py's format_time_human_readable: the largest
 * unit that divides the value evenly, else the value in its own unit.
 *
 * @param {number} value
 * @param {'milliseconds'|'seconds'} unit
 */
function humanizeDuration (value, unit) {
  const ms = unit === 'seconds' ? value * 1000 : value
  const units = [
    [365 * 24 * 60 * 60 * 1000, 'year', 'years'],
    [7 * 24 * 60 * 60 * 1000, 'week', 'weeks'],
    [24 * 60 * 60 * 1000, 'day', 'days'],
    [60 * 60 * 1000, 'hour', 'hours'],
    [60 * 1000, 'minute', 'minutes'],
    [1000, 'second', 'seconds'],
    [1, 'millisecond', 'milliseconds'],
  ]
  for (const [threshold, singular, plural] of units) {
    if (ms >= threshold && ms % threshold === 0) {
      const count = ms / threshold
      return `${count} ${count === 1 ? singular : plural}`
    }
  }
  return unit === 'seconds' ? `${value} seconds` : `${value} milliseconds`
}

/**
 * IEC rendering of a byte count, only for exact multiples: 134217728 is
 * "128 MiB", 1000 stays "1000 bytes".
 */
function humanizeBytes (value) {
  if (value === 0) return '0 bytes'
  const steps = [
    [1024 ** 4, 'TiB'],
    [1024 ** 3, 'GiB'],
    [1024 ** 2, 'MiB'],
    [1024, 'KiB'],
  ]
  for (const [size, label] of steps) {
    if (value >= size && value % size === 0) return `${value / size} ${label}`
  }
  return `${value} ${value === 1 ? 'byte' : 'bytes'}`
}

/**
 * A number in the property's own unit, humanized when the unit is known and
 * the value is a non-negative integer. Negative values are sentinels (-1 for
 * "unlimited") and render as written.
 */
function humanizeNumber (value, unit) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return String(value)
  if (DURATION_UNITS[unit]) return humanizeDuration(value, unit)
  if (unit === 'bytes') return humanizeBytes(value)
  return String(value)
}

// An integer outside JavaScript's exact range (2^64 - 1 sentinels such as
// virtual_cluster_min_producer_ids) has already lost digits by the time
// JSON.parse returns it, so there is no exact value left to render.
const isImprecise = (value) => typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
const imprecise = () => ({ ok: false, reason: 'imprecise' })
const plain = (text) => ({ ok: true, text: String(text) })
const missing = () => ({ ok: false, reason: 'missing' })
const yesNo = (value, format) => plain(format === FORMAT_RAW ? String(value) : (value ? 'yes' : 'no'))

/**
 * The value of one field of one property entry.
 *
 * @param {object} entry - One value of the JSON's properties object.
 * @param {string} field - A field name or alias.
 * @param {object} [opts]
 * @param {'human'|'raw'} [opts.format] - human (default) or the exact value.
 * @returns {{ok: true, text: string, html?: string} |
 *           {ok: false, reason: 'unsupported'|'missing'|'imprecise'}}
 *   html, when present, is pre-escaped markup to use instead of text.
 */
function fieldValue (entry, field, { format = FORMAT_HUMAN } = {}) {
  const name = normalizeField(field)
  if (!name) return { ok: false, reason: 'unsupported' }
  const has = (key) => Object.prototype.hasOwnProperty.call(entry, key) && entry[key] !== undefined
  const raw = format === FORMAT_RAW

  switch (name) {
    case 'default': {
      if (!has('default')) return missing()
      const value = entry.default
      if (isImprecise(value)) return imprecise()
      const exact = String(formatPropertyValue(value, entry.type))
      if (raw) return plain(exact)
      if (typeof entry.default_human_readable === 'string' && entry.default_human_readable.trim()) {
        return plain(entry.default_human_readable.trim())
      }
      if (typeof value === 'number') return plain(humanizeNumber(value, unitOf(entry)))
      return plain(exact)
    }
    case 'type':
      return has('type') && entry.type !== '' ? plain(entry.type) : missing()
    case 'unit': {
      const unit = unitOf(entry)
      return unit ? plain(unit) : missing()
    }
    case 'min':
    case 'max': {
      const key = name === 'min' ? 'minimum' : 'maximum'
      if (!has(key) || entry[key] === null) return missing()
      if (isImprecise(entry[key])) return imprecise()
      return plain(raw ? String(entry[key]) : humanizeNumber(entry[key], unitOf(entry)))
    }
    case 'restart':
      return has('needs_restart') && typeof entry.needs_restart === 'boolean' ? yesNo(entry.needs_restart, format) : missing()
    case 'nullable':
      return has('nullable') && typeof entry.nullable === 'boolean' ? yesNo(entry.nullable, format) : missing()
    case 'restored':
      return has('gets_restored') && typeof entry.gets_restored === 'boolean' ? yesNo(entry.gets_restored, format) : missing()
    case 'values': {
      const list = Array.isArray(entry.enum) && entry.enum.length
        ? entry.enum
        : entry.items && Array.isArray(entry.items.enum) && entry.items.enum.length ? entry.items.enum : undefined
      if (!list) return missing()
      if (raw) return plain(JSON.stringify(list))
      // Each value in its own code element, as the table prints them: some
      // values contain commas (compact,delete), so a plain comma-joined list
      // would be ambiguous.
      return {
        ok: true,
        text: list.map(String).join(', '),
        html: list.map((v) => `<code>${escapeHtml(String(v))}</code>`).join(', '),
      }
    }
    case 'scope':
      return has('config_scope') && entry.config_scope ? plain(entry.config_scope) : missing()
    case 'introduced':
      return has('version') && entry.version ? plain(entry.version) : missing()
    case 'visibility':
      return has('visibility') && entry.visibility ? plain(entry.visibility) : missing()
    case 'aliases':
      return Array.isArray(entry.aliases) && entry.aliases.length
        ? plain(raw ? JSON.stringify(entry.aliases) : entry.aliases.join(', '))
        : missing()
    case 'cloud-access': {
      // cloud_* fields describe cluster configuration only (see isAvailable
      // in macros/prop.js), so other scopes have no Cloud access value.
      if (entry.config_scope !== 'cluster') return missing()
      if (entry.cloud_readonly === true) return plain(raw ? 'readonly' : 'read-only')
      if (entry.cloud_editable === true) return plain('editable')
      if (entry.cloud_supported === false) return plain(raw ? 'unsupported' : 'not available')
      return missing()
    }
    default:
      return { ok: false, reason: 'unsupported' }
  }
}

module.exports = {
  FIELDS,
  FIELD_ALIASES,
  FORMAT_HUMAN,
  FORMAT_RAW,
  normalizeField,
  fieldValue,
  unitOf,
  humanizeDuration,
  humanizeBytes,
  humanizeNumber,
}
