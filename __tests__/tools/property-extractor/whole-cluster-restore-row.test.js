/**
 * The Whole Cluster Restore row has to survive both extraction paths: the one
 * where rp_util's runtime dump supplies gets_restored, and the one where no
 * rp_util schema can exist for the release (v26.2.x and older, which predate
 * streaming-enterprise#63's broker-scope dumps) and the Tree-sitter pass'
 * materialized default is all there is.
 *
 * Regression guard for the 626 rows that rendered "Unknown (rp_util merge
 * unavailable this build)" and the 48 topic-property rows that vanished
 * outright in redpanda-data/docs#2036.
 */
const fs = require('fs')
const path = require('path')
const handlebars = require('handlebars')
const helpers = require('../../../tools/property-extractor/helpers')

const TEMPLATES = path.join(__dirname, '../../../tools/property-extractor/templates')

for (const [name, fn] of Object.entries(helpers)) {
  if (typeof fn === 'function') handlebars.registerHelper(name, fn)
}

const render = (template, context) =>
  handlebars.compile(fs.readFileSync(path.join(TEMPLATES, template), 'utf8'))(context)

const wcrValue = (out) => {
  const i = out.indexOf('Restored on')
  if (i === -1) return null
  return out.slice(out.indexOf('\n', i) + 1).split('\n')[0].replace(/^\|\s*/, '').trim()
}

const base = { name: 'p', type: 'string', defined_in: 'src/v/config/configuration.cc' }

describe('Whole Cluster Restore row, rp_util available', () => {
  test.each([[true, 'Yes'], [false, 'No']])('gets_restored %s renders %s', (flag, expected) => {
    expect(wcrValue(render('property.hbs', { ...base, config_scope: 'cluster', gets_restored: flag })))
      .toBe(expected)
  })
})

describe('Whole Cluster Restore row, rp_util unavailable for the release', () => {
  // The Tree-sitter pass materializes base_property.h's gets_restored::yes
  // default, so these arrive with the key already set and never reach the
  // "Unknown" branch.
  test('a source-parsed property with the declared default renders Yes', () => {
    expect(wcrValue(render('property.hbs', { ...base, config_scope: 'cluster', gets_restored: true })))
      .toBe('Yes')
  })

  test('a source ::no annotation still renders No', () => {
    expect(wcrValue(render('property.hbs', {
      ...base, config_scope: 'broker', defined_in: 'src/v/config/node_config.cc', gets_restored: false
    }))).toBe('No')
  })

  test('topic properties keep the row: WCR restores topic metadata', () => {
    expect(wcrValue(render('topic-property.hbs', {
      ...base, config_scope: 'topic', defined_in: 'src/v/kafka/protocol/topic_properties.h', gets_restored: true
    }))).toBe('Yes')
  })
})

describe('Whole Cluster Restore row, genuinely unknown', () => {
  test('the marker still renders Unknown, so a real merge gap stays visible', () => {
    expect(wcrValue(render('property.hbs', {
      ...base, config_scope: 'cluster', rp_util_merge_status: 'unavailable'
    }))).toBe('Unknown (rp_util merge unavailable this build)')
  })

  test('an absent value with no marker renders no row and no empty conditional', () => {
    for (const template of ['property.hbs', 'topic-property.hbs']) {
      const out = render(template, { ...base, config_scope: 'cluster', defined_in: 'override' })
      expect(wcrValue(out)).toBeNull()
      expect(out).not.toMatch(/ifndef::env-cloud\[\]\s*\n\s*endif::\[\]/)
    }
  })
})
