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
const cell = (html, id) => (html.match(new RegExp(`id="${id}">\\s*<p class="tableblock">([\\s\\S]*?)</p>`)) || [])[1]
const rowIdOf = (html, connector) => html.match(new RegExp(`<tr id="row-(\\d+)">\\s*<td[^>]*>\\s*<p class="tableblock"><a href="[^"]*"><code>${connector}</code>`))[1]

describe('component_table Cloud availability', () => {
  it('lists GPU-only components in the Cloud table', () => {
    const html = register({ csvData: { data: ROWS } }).component_table(doc({ 'env-cloud': '' }), '', {})
    expect(html).toContain('<code>ollama_chat</code>')
    expect(html).toContain('<code>kafka</code>')
    expect(html).not.toContain('<code>amqp_1</code>')
  })

  it('says which Cloud pipelines a component runs in', () => {
    const html = register({ csvData: { data: ROWS } }).component_table(doc({}), '', { all: 'all' })
    const cloudCell = (connector) => cell(html, `componentCloud-${rowIdOf(html, connector)}`)
    expect(cloudCell('ollama_chat')).toBe('<a href="/cloud/connect/components/processors/ollama_chat/">Yes</a> (GPU pipelines only)')
    expect(cloudCell('jira')).toBe('<a href="/cloud/connect/components/inputs/jira/">Yes</a> (not in GPU pipelines)')
    expect(cloudCell('kafka')).toBe('<a href="/cloud/connect/components/inputs/kafka/">Yes</a>')
    expect(cloudCell('amqp_1')).toBe('No')
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
