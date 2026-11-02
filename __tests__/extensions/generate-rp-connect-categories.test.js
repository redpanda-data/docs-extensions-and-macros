const { describe, it, expect } = require('@jest/globals')
const ext = require('../../extensions/generate-rp-connect-categories.js')

// Translated rows, as generate-rp-connect-info leaves them in csvData.
const row = (connector, type, support, extra = {}) => ({
  connector, type, support_level: support, is_licensed: 'No', deprecated: 'n', ...extra
})

const ROWS = [
  // Names whose support level differs by type
  row('parquet', 'input', 'certified'),
  row('parquet', 'processor', 'community'),
  row('sql', 'cache', 'certified'),
  row('sql', 'output', 'community'),
  // Deprecation comes from the data, not the page
  row('kafka', 'input', 'certified', { deprecated: 'y' }),
  row('kafka', 'output', 'certified'),
  // catalog.json rows carry categories and status
  row('ollama_chat', 'processor', 'certified', { categories: ['AI'], status: 'stable' }),
  row('old_thing', 'processor', 'community', { status: 'deprecated' }),
  row('prometheus', 'metric', 'certified')
]

const page = (relative, header = '') => ({
  src: { component: 'connect', module: 'components', family: 'page', relative, stem: relative.split('/').pop().replace('.adoc', '') },
  pub: { url: `/connect/components/${relative.replace('.adoc', '/')}` },
  contents: Buffer.from(`= Title\n${header}\n\nBody.\n`)
})

function run (pages, rows = ROWS) {
  const component = {
    name: 'connect',
    latest: {
      asciidoc: {
        attributes: {
          categories: {
            input: [{ name: 'Services', description: 'Inputs that consume from services.' }],
            output: [{ name: 'Services', description: 'Outputs.' }],
            processor: [{ name: 'AI', description: 'AI processors.' }, { name: 'Parsing', description: 'Parsers.' }]
          },
          csvData: { data: rows }
        }
      }
    }
  }
  const handlers = {}
  const noop = () => {}
  const ctx = { getLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop }), on: (event, fn) => { handlers[event] = fn } }
  ext.register.call(ctx, { config: {} })
  handlers.contentClassified({
    contentCatalog: {
      getComponents: () => [component],
      findBy: (q) => pages.filter((p) => Object.entries(q).every(([k, v]) => p.src[k] === v))
    }
  })
  return component.latest.asciidoc.attributes
}

describe('generate-rp-connect-categories', () => {
  describe('support badge lookup', () => {
    it('keys support levels by name and type', () => {
      const lookup = ext.buildRowLookup(ROWS)
      expect(lookup.get('parquet:input').support_level).toBe('certified')
      expect(lookup.get('parquet:processor').support_level).toBe('community')
      expect(lookup.get('sql:cache').support_level).toBe('certified')
      expect(lookup.get('sql:output').support_level).toBe('community')
      expect(lookup.get('prometheus:metric')).toBeDefined()
    })

    it('gives the parquet input and the sql cache their own certified level', () => {
      const attrs = run([
        page('inputs/parquet.adoc', ':type: input\n:categories: ["Services"]'),
        page('processors/parquet.adoc', ':type: processor\n:categories: ["Parsing"]'),
        page('caches/sql.adoc', ':type: cache'),
        page('outputs/sql.adoc', ':type: output\n:categories: ["Services"]')
      ])
      const parquet = attrs.flatComponentsData.find((c) => c.name === 'parquet')
      expect(parquet.types).toEqual([
        expect.objectContaining({ type: 'input', support: 'certified' }),
        expect.objectContaining({ type: 'processor', support: 'community' })
      ])
      const sql = attrs.flatComponentsData.find((c) => c.name === 'sql')
      expect(sql.types).toEqual([
        expect.objectContaining({ type: 'cache', support: 'certified' }),
        expect.objectContaining({ type: 'output', support: 'community' })
      ])
      const services = attrs.connectCategoriesData.input.find((c) => c.name === 'Services')
      expect(services.items).toEqual([expect.objectContaining({ name: 'parquet', status: 'certified' })])
    })

    it('matches the metrics page type to the metric data type', () => {
      const attrs = run([page('metrics/prometheus.adoc', ':type: metrics')])
      expect(attrs.flatComponentsData[0].types).toEqual([expect.objectContaining({ type: 'metrics', support: 'certified' })])
    })
  })

  describe('deprecated status', () => {
    it('skips a component the data marks deprecated, whatever the page says', () => {
      const attrs = run([page('inputs/kafka.adoc', ':type: input\n:categories: ["Services"]')])
      expect(attrs.flatComponentsData).toEqual([])
    })

    it('lists a component the data marks live, even when the page says deprecated', () => {
      const attrs = run([page('outputs/kafka.adoc', ':type: output\n:status: deprecated\n:categories: ["Services"]')])
      expect(attrs.flatComponentsData.map((c) => c.name)).toEqual(['kafka'])
    })

    it('skips a component whose catalog.json status is deprecated', () => {
      const attrs = run([page('processors/old_thing.adoc', ':type: processor')])
      expect(attrs.flatComponentsData).toEqual([])
    })

    it('falls back to the page :status: when the data has no row', () => {
      const attrs = run([
        page('processors/gone.adoc', ':type: processor\n:status: deprecated'),
        page('processors/new_one.adoc', ':type: processor\n:status: beta')
      ])
      expect(attrs.flatComponentsData.map((c) => [c.name, c.support])).toEqual([['new_one', 'beta']])
    })
  })

  describe('pages without frozen :type: or :categories:', () => {
    it('takes the type from the page directory and the categories from catalog.json', () => {
      const attrs = run([page('processors/ollama_chat.adoc')])
      expect(attrs.flatComponentsData).toEqual([expect.objectContaining({ name: 'ollama_chat', types: [expect.objectContaining({ type: 'processor' })] })])
      const ai = attrs.connectCategoriesData.processor.find((c) => c.name === 'AI')
      expect(ai.items.map((i) => i.name)).toEqual(['ollama_chat'])
    })

    it('prefers catalog.json categories over a hand-kept :categories:', () => {
      const attrs = run([page('processors/ollama_chat.adoc', ':type: processor\n:categories: ["Parsing"]')])
      expect(attrs.connectCategoriesData.processor.map((c) => c.name)).toEqual(['AI'])
    })

    it('ignores pages in a type directory that have no data row and no :type:', () => {
      const attrs = run([page('inputs/about.adoc')])
      expect(attrs.flatComponentsData).toEqual([])
    })
  })
})
