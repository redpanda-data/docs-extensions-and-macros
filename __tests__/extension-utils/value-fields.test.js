'use strict'

const fs = require('fs')
const path = require('path')
const { SHARED_FIELDS, defineFields, aliasesByField } = require('../../extension-utils/value-fields')
const propertyValues = require('../../extension-utils/property-values')
const rpkValues = require('../../extension-utils/rpk-values')
const connectValues = require('../../extension-utils/connect-values')
const bloblangValues = require('../../extension-utils/bloblang-values')

// Every value macro and its field set, in the column order of the
// REFERENCE.adoc table. A new value macro adds itself here.
const MACROS = [
  ['propval', propertyValues.FIELD_SET],
  ['rpkval', rpkValues.FIELD_SET],
  ['connectval', connectValues.FIELD_SET],
  ['bloblval', bloblangValues.FIELD_SET],
]

const REFERENCE = fs.readFileSync(path.join(__dirname, '..', '..', 'macros', 'REFERENCE.adoc'), 'utf8')

// The rows of the table after an [[id]] anchor, as arrays of cell text.
function tableRows (id) {
  const at = REFERENCE.indexOf(`[[${id}]]`)
  if (at === -1) throw new Error(`no [[${id}]] in REFERENCE.adoc`)
  const open = REFERENCE.indexOf('|===', at)
  const close = REFERENCE.indexOf('|===', open + 4)
  const body = REFERENCE.slice(open + 4, close).trim()
  return body.split(/\n\s*\n/).slice(1).map((row) => row.split('\n').filter((line) => line.startsWith('|')).map((line) => line.replace(/^\|\s?/, '').trim()))
}

const backticked = (text) => [...String(text).matchAll(/`([^`]+)`/g)].map((m) => m[1])

describe('defineFields', () => {
  const set = defineFields('demo:', {
    default: {},
    required: { levels: ['flag'] },
    usage: { levels: ['command'] },
    unit: {},
  }, { minimum: 'unit' }, { deprecated: 'no data' })

  test('canonical names, shared aliases and the macro\'s own aliases resolve, case-insensitively', () => {
    expect(set.normalizeField('Default')).toBe('default')
    expect(set.normalizeField('minimum')).toBe('unit')
    expect(set.normalizeField(' unit ')).toBe('unit')
  })

  test('a shared alias of a field the macro lacks is not accepted', () => {
    expect(set.normalizeField('options')).toBeUndefined()
    expect(set.normalizeField('version')).toBeUndefined()
  })

  test('an inverse alias resolves to its field, inverted', () => {
    expect(set.resolveField('optional')).toEqual({ name: 'required', invert: true, as: 'optional' })
    expect(set.resolveField('required')).toEqual({ name: 'required', invert: false })
  })

  test('a dropped name is not a field, and says why', () => {
    expect(set.normalizeField('deprecated')).toBeUndefined()
    expect(set.droppedReason('Deprecated')).toBe('no data')
  })

  test('the unsupported message lists the fields, for one level when given', () => {
    expect(set.unsupportedMessage('demo:x[colour]', 'colour')).toBe("demo:x[colour]: 'colour' is not a field demo: supports. Supported fields: default, required, usage, unit.")
    expect(set.unsupportedMessage('demo:x[colour]', 'colour', 'flag')).toBe("demo:x[colour]: 'colour' is not a field demo: supports for a flag. Supported fields: default, required, unit.")
  })

  test('own properties only: toString and constructor are never fields', () => {
    expect(set.normalizeField('toString')).toBeUndefined()
    expect(set.normalizeField('constructor')).toBeUndefined()
    expect(set.normalizeField('__proto__')).toBeUndefined()
  })
})

describe('the value macros share one vocabulary', () => {
  test.each(MACROS)('%s accepts every shared alias of every shared field it has', (_macro, set) => {
    for (const name of Object.keys(set.FIELDS)) {
      const shared = SHARED_FIELDS[name]
      if (!shared) continue
      for (const alias of shared.aliases || []) expect([alias, set.normalizeField(alias)]).toEqual([alias, name])
      for (const alias of shared.inverse || []) expect(set.resolveField(alias)).toMatchObject({ name, invert: true })
    }
  })

  test('no alias of one macro means a different field in another', () => {
    const meaning = {}
    for (const [macro, set] of MACROS) {
      for (const [alias, name] of Object.entries(set.FIELD_ALIASES)) {
        if (meaning[alias]) expect([alias, name]).toEqual([alias, meaning[alias].name])
        else meaning[alias] = { name, macro }
      }
    }
  })

  test('propval keeps every field name and alias it shipped with in 5.58.0', () => {
    const shipped = {
      default: 'default', type: 'type', unit: 'unit', min: 'min', max: 'max', restart: 'restart', nullable: 'nullable', values: 'values', scope: 'scope', introduced: 'introduced', visibility: 'visibility', restored: 'restored', aliases: 'aliases', 'cloud-access': 'cloud-access',
      minimum: 'min', maximum: 'max', needs_restart: 'restart', 'requires-restart': 'restart', units: 'unit', enum: 'values', 'accepted-values': 'values', config_scope: 'scope', version: 'introduced', gets_restored: 'restored', cloud: 'cloud-access',
    }
    for (const [name, field] of Object.entries(shipped)) expect([name, propertyValues.normalizeField(name)]).toEqual([name, field])
    expect(Object.keys(propertyValues.FIELDS).slice(0, 14)).toEqual(Object.keys(shipped).slice(0, 14))
  })

  test('connectval: values is the canonical name, and options still works', () => {
    expect(connectValues.normalizeField('values')).toBe('values')
    expect(connectValues.normalizeField('options')).toBe('values')
    expect(connectValues.FIELDS.options).toBeUndefined()
  })

  test('rpkval: deprecated is dropped for flags, and still recognized', () => {
    expect(rpkValues.normalizeField('deprecated')).toBeUndefined()
    expect(rpkValues.FIELD_SET.droppedReason('deprecated')).toContain('no deprecation for flags')
  })
})

describe('REFERENCE.adoc agrees with the field sets', () => {
  const rows = tableRows('value-fields-table')
  const header = (() => {
    const at = REFERENCE.indexOf('[[value-fields-table]]')
    const open = REFERENCE.indexOf('|===', at)
    return REFERENCE.slice(open + 4).trim().split('\n')[0].split('|').map((c) => c.trim()).filter(Boolean)
  })()

  test('the table has a column per value macro, in order', () => {
    expect(header).toEqual(['Field', 'Aliases', ...MACROS.map(([macro]) => macro)])
  })

  test('every row has a cell per column', () => {
    for (const row of rows) expect([row[0], row.length]).toEqual([row[0], header.length])
  })

  test.each(MACROS.map(([macro, set], i) => [macro, set, i]))('the %s column lists exactly its fields, at their levels', (_macro, set, i) => {
    const listed = {}
    for (const row of rows) {
      const cell = row[2 + i]
      if (cell) listed[backticked(row[0])[0]] = cell
    }
    const expected = {}
    for (const [name, options] of Object.entries(set.FIELDS)) expected[name] = options.levels ? options.levels.join(', ') : 'yes'
    expect(listed).toEqual(expected)
  })

  test('the Aliases column lists every alias any macro accepts for the field', () => {
    const listed = {}
    for (const row of rows) listed[backticked(row[0])[0]] = row[1].split(/,\s*/).filter(Boolean).map((a) => a.replace(/`/g, '').toLowerCase()).sort()
    const expected = {}
    for (const [, set] of MACROS) {
      for (const [name, aliases] of Object.entries(aliasesByField(set))) expected[name] = [...new Set([...(expected[name] || []), ...aliases])].sort()
    }
    expect(listed).toEqual(expected)
  })

  test.each(MACROS)('the %s section\'s own field table names exactly its fields', (macro, set) => {
    const names = tableRows(`${macro}-fields`).flatMap((row) => backticked(row[0].replace(/\(.*$/, '')))
    expect([...new Set(names)].sort()).toEqual(Object.keys(set.FIELDS).sort())
  })
})
