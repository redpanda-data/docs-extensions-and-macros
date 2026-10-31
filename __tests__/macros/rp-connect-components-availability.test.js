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
// A card ends at the next card, or at the script that follows the last one.
const cloudBadgeOf = (html, connector) => {
  const start = html.indexOf(`data-name="${connector} `)
  const card = html.slice(start).split(/<div class="component-card"|<script/)[0]
  return (card.match(/<(span|a) [^>]*class="badge badge-cloud"[^>]*>[^<]*<\/\1>/) || [])[0]
}

describe('component_table Cloud availability', () => {
  it('lists GPU-only components in the Cloud table', () => {
    const html = register({ csvData: { data: ROWS } }).component_table(doc({ 'env-cloud': '' }), '', {})
    expect(html).toContain('<code>ollama_chat</code>')
    expect(html).toContain('<code>kafka</code>')
    expect(html).not.toContain('<code>amqp_1</code>')
  })

  it('says which Cloud pipelines a component runs in, on the card Cloud badge', () => {
    const html = register({ csvData: { data: ROWS } }).component_table(doc({}), '', { all: 'all' })
    expect(cloudBadgeOf(html, 'ollama_chat')).toBe('<a href="/cloud/connect/components/processors/ollama_chat/" class="badge badge-cloud" title="Available in Redpanda Cloud (GPU pipelines only)">Cloud (GPU pipelines only)</a>')
    expect(cloudBadgeOf(html, 'jira')).toBe('<a href="/cloud/connect/components/inputs/jira/" class="badge badge-cloud" title="Available in Redpanda Cloud (not in GPU pipelines)">Cloud (not in GPU pipelines)</a>')
    // Negative control: a component in both pipeline kinds keeps the plain badge.
    expect(cloudBadgeOf(html, 'kafka')).toBe('<a href="/cloud/connect/components/inputs/kafka/" class="badge badge-cloud" title="Available in Redpanda Cloud">Cloud</a>')
    expect(cloudBadgeOf(html, 'amqp_1')).toBeUndefined()
  })

  it('keeps the Cloud badge as plain text when no Cloud page exists', () => {
    const rows = [row('jira', 'input', 'y', 'n', { redpandaCloudUrl: '' })]
    const html = register({ csvData: { data: rows } }).component_table(doc({}), '', { all: 'all' })
    expect(cloudBadgeOf(html, 'jira')).toBe('<span class="badge badge-cloud" title="Available in Redpanda Cloud (not in GPU pipelines)">Cloud (not in GPU pipelines)</span>')
  })
})

describe('component_type_dropdown type', () => {
  const licensed = [row('jira', 'input', 'y', 'n', { is_licensed: 'Yes' })]

  it('renders the license notice on a page with no :type:, using the page directory', () => {
    const html = register({ csvData: { data: licensed } }).component_type_dropdown(
      doc({ doctitle: 'jira', 'page-relative-src-path': 'inputs/jira.adoc', 'page-component-title': 'Connect' }), '', {})
    expect(html).toContain('enterprise license')
  })

  it('renders nothing on a page outside the type directories', () => {
    const html = register({ csvData: { data: licensed } }).component_type_dropdown(
      doc({ doctitle: 'jira', 'page-relative-src-path': 'guides/jira.adoc', 'page-component-title': 'Connect' }), '', {})
    expect(html).toBe('')
  })
})
