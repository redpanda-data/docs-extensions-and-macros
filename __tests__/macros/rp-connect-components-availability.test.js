const { describe, it, expect } = require('@jest/globals')
const macro = require('../../macros/rp-connect-components.js')

// Captures each block macro's process callback by name.
function register (attributes) {
  const macros = {}
  const registry = {
    blockMacro (fn) {
      const self = {
        named (name) { this.name = name },
        positionalAttributes () {},
        process (cb) { macros[this.name] = cb },
        createBlock (parent, context, html) { return html }
      }
      fn.call(self)
    }
  }
  macro.register(registry, { config: { attributes } })
  return macros
}

const row = (connector, type, cloud, cloudAi, extra = {}) => ({
  connector,
  type,
  commercial_name: connector,
  support_level: 'certified',
  is_cloud_supported: cloud,
  cloud_ai: cloudAi,
  gpu_only: cloud !== 'y' && cloudAi === 'y' ? 'y' : 'n',
  no_gpu: cloud === 'y' && cloudAi !== 'y' ? 'y' : 'n',
  is_licensed: 'No',
  redpandaConnectUrl: `/connect/components/${type}s/${connector}/`,
  redpandaCloudUrl: cloud === 'y' || cloudAi === 'y' ? `/cloud/connect/components/${type}s/${connector}/` : '',
  ...extra
})

const ROWS = [
  row('ollama_chat', 'processor', 'n', 'y'),
  row('jira', 'input', 'y', 'n'),
  row('kafka', 'input', 'y', 'y'),
  row('amqp_1', 'input', 'n', 'n'),
  row('sql_driver_postgres', 'sql_driver', 'n', 'y', { commercial_name: 'PostgreSQL' })
]

const doc = (attrs) => ({ getDocument: () => ({ getAttributes: () => attrs }) })
// The Cloud badge on the card whose data-name starts with the connector name.
// A card ends at the next card, or at the legend that follows the last one.
const cardOf = (html, connector) => {
  const start = html.indexOf(`data-name="${connector} `)
  return html.slice(start).split(/<div class="component-card"|<div id="badgeLegendModal"|<script/)[0]
}
const cloudBadgeOf = (html, connector) => {
  const card = cardOf(html, connector)
  return (card.match(/<(span|a) [^>]*class="rp-badge rp-badge--sm rp-badge--cloud"[^>]*>[^<]*<\/\1>/) || [])[0]
}

describe('component_table Cloud availability', () => {
  it('lists GPU-only components in the Cloud table', () => {
    const html = register({ csvData: { data: ROWS } }).component_table(doc({ 'env-cloud': '' }), '', {})
    expect(html).toContain('<code>ollama_<wbr>chat</code>')
    expect(html).toContain('<code>kafka</code>')
    expect(html).not.toContain('<code>amqp_<wbr>1</code>')
  })

  it('says which Cloud pipelines a component runs in, in the card Cloud badge tooltip', () => {
    const html = register({ csvData: { data: ROWS } }).component_table(doc({}), '', { all: 'all' })
    expect(cloudBadgeOf(html, 'ollama_chat')).toBe('<a class="rp-badge rp-badge--sm rp-badge--cloud" href="/cloud/connect/components/processors/ollama_chat/" data-tooltip="Available in Redpanda Cloud. GPU pipelines only.">Cloud</a>')
    expect(cloudBadgeOf(html, 'jira')).toBe('<a class="rp-badge rp-badge--sm rp-badge--cloud" href="/cloud/connect/components/inputs/jira/" data-tooltip="Available in Redpanda Cloud. Not in GPU pipelines.">Cloud</a>')
    // Negative control: a component in both pipeline kinds keeps the plain badge.
    expect(cloudBadgeOf(html, 'kafka')).toBe('<a class="rp-badge rp-badge--sm rp-badge--cloud" href="/cloud/connect/components/inputs/kafka/" data-tooltip="Available in Redpanda Cloud.">Cloud</a>')
    expect(cloudBadgeOf(html, 'amqp_1')).toBeUndefined()
  })

  it('says which Cloud pipelines a component runs in as text after the Cloud badge', () => {
    const html = register({ csvData: { data: ROWS } }).component_table(doc({}), '', { all: 'all' })
    expect(cardOf(html, 'ollama_chat')).toMatch(/rp-badge--cloud"[^>]*>Cloud<\/a> <span class="catalog-pipeline-note">GPU pipelines only<\/span>/)
    expect(cardOf(html, 'jira')).toContain('<span class="catalog-pipeline-note">Not in GPU pipelines</span>')
    // Negative control: a component in both pipeline kinds has no qualifier
    expect(cardOf(html, 'kafka')).not.toContain('catalog-pipeline-note')
    expect(cardOf(html, 'amqp_1')).not.toContain('catalog-pipeline-note')
  })

  it('shows the pipeline qualifier on Cloud catalog cards, which have no Cloud badge', () => {
    const html = register({ csvData: { data: ROWS } }).component_table(doc({ 'env-cloud': '' }), '', {})
    const ollama = cardOf(html, 'ollama_chat')
    expect(ollama).not.toContain('rp-badge--cloud')
    expect(ollama).toContain('<span class="badge-group-label">Availability</span>')
    expect(ollama).toContain('<span class="catalog-pipeline-note">GPU pipelines only</span>')
    expect(cardOf(html, 'jira')).toContain('<span class="catalog-pipeline-note">Not in GPU pipelines</span>')
    const kafka = cardOf(html, 'kafka')
    expect(kafka).not.toContain('catalog-pipeline-note')
    expect(kafka).not.toContain('badge-group-label">Availability')
  })

  it('shows no pipeline qualifier on the basic Self-Managed catalog, which has no Cloud badge', () => {
    const html = register({ csvData: { data: ROWS } }).component_table(doc({}), '', {})
    expect(html).not.toContain('catalog-pipeline-note"')
  })

  it('keeps the Cloud badge as plain text when no Cloud page exists', () => {
    const rows = [row('jira', 'input', 'y', 'n', { redpandaCloudUrl: '' })]
    const html = register({ csvData: { data: rows } }).component_table(doc({}), '', { all: 'all' })
    expect(cloudBadgeOf(html, 'jira')).toBe('<span class="rp-badge rp-badge--sm rp-badge--cloud" data-tooltip="Available in Redpanda Cloud. Not in GPU pipelines.">Cloud</span>')
  })
})

describe('component_type_dropdown type', () => {
  const licensed = [row('jira', 'input', 'y', 'n', { is_licensed: 'Yes' })]

  it('renders the license notice on a page with no :type:, using the page directory', () => {
    const html = register({ csvData: { data: licensed } }).component_type_dropdown(
      doc({ doctitle: 'jira', 'page-relative-src-path': 'inputs/jira.adoc', 'page-component-title': 'Connect' }), '', {})
    expect(html).toContain('Enterprise license required')
  })

  it('renders a Beta badge for a beta connector, from the catalog row for the page type', () => {
    const rows = [row('nats_kv', 'cache', 'n', 'n', { status: 'experimental' }), row('nats_kv', 'output', 'n', 'n', { status: 'beta' })]
    const html = register({ csvData: { data: rows } }).component_type_dropdown(
      doc({ doctitle: 'nats_kv', type: 'output', 'page-component-title': 'Connect' }), '', {})
    expect(html).toContain('<div class="paragraph connector-status"><p><span class="rp-badge rp-badge--beta" data-tooltip="Beta: available to try, and may change before general availability.">Beta</span></p></div>')
    expect(html).not.toContain('Experimental')
  })

  it('renders an Experimental badge, with the Preview look, for an experimental connector', () => {
    const rows = [row('nats_kv', 'cache', 'n', 'n', { status: 'experimental' }), row('nats_kv', 'output', 'n', 'n', { status: 'beta' })]
    const html = register({ csvData: { data: rows } }).component_type_dropdown(
      doc({ doctitle: 'nats_kv', type: 'cache', 'page-component-title': 'Connect' }), '', {})
    expect(html).toContain('<span class="rp-badge rp-badge--preview" data-tooltip="Experimental: breaking changes could be made outside of major version releases.">Experimental</span>')
    expect(html).not.toContain('>Beta<')
  })

  it('falls back to the page :status: attribute when the catalog row has none (info.csv builds)', () => {
    const html = register({ csvData: { data: [row('nats_kv', 'cache', 'n', 'n')] } }).component_type_dropdown(
      doc({ doctitle: 'nats_kv', type: 'cache', status: 'experimental', 'page-component-title': 'Connect' }), '', {})
    expect(html).toContain('>Experimental</span>')
  })

  it('keeps the status badge alongside the license notice', () => {
    const rows = [row('jira', 'input', 'y', 'n', { is_licensed: 'Yes', status: 'beta' })]
    const html = register({ csvData: { data: rows } }).component_type_dropdown(
      doc({ doctitle: 'jira', type: 'input', 'page-component-title': 'Connect' }), '', {})
    expect(html.indexOf('rp-badge--beta')).toBeGreaterThan(-1)
    expect(html.indexOf('rp-badge--beta')).toBeLessThan(html.indexOf('Enterprise license required'))
  })

  it('renders no status badge for stable, deprecated, or missing statuses', () => {
    for (const status of ['stable', 'deprecated', '', undefined]) {
      const html = register({ csvData: { data: [row('jira', 'input', 'y', 'n', { status })] } }).component_type_dropdown(
        doc({ doctitle: 'jira', type: 'input', status, 'page-component-title': 'Connect' }), '', {})
      expect(html).not.toContain('connector-status')
    }
  })

  it('renders nothing on a page outside the type directories', () => {
    const html = register({ csvData: { data: licensed } }).component_type_dropdown(
      doc({ doctitle: 'jira', 'page-relative-src-path': 'guides/jira.adoc', 'page-component-title': 'Connect' }), '', {})
    expect(html).toBe('')
  })
})
