'use strict'

// A content catalog for the Connect link and Bloblang tests, built from real
// data (see _source in each fixture): the trimmed connect-4.115.1.json, the
// page paths and page-aliases of rp-connect-docs and the cloud-docs stubs for
// the same components and the Bloblang pages, three rp-connect-docs page
// sources, two cloud-docs stub sources (postgres_cdc, whose page-aliases
// has no components: path, and redpanda), and the heading lines of four
// partials of the connect release asset. Page aliases are alias files whose rel is the page, as Antora
// registers them.

const fs = require('fs')
const path = require('path')

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'connect-links')
const SAMPLE = fs.readFileSync(path.join(FIXTURES, 'connect-4.115.1-sample.json'))
const DATA = JSON.parse(SAMPLE.toString())
const PAGES = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'pages-sample.json'), 'utf8'))

const ATTRIBUTES = {
  'cloud-data-platform': { 'env-cloud': true },
  'agentic-data-plane': { 'env-adp': true },
}
const VERSIONS = { streaming: '26.2' }

/**
 * @param {object} [opts]
 * @param {string[]} [opts.components] - Components whose pages the build has.
 * @param {boolean} [opts.data] - Whether connect publishes the data attachment.
 * @param {boolean} [opts.sources] - Whether the connect pages and Cloud stubs carry their real source.
 * @param {boolean} [opts.partials] - Whether the build has the release asset partials.
 * @param {object[]} [opts.extra] - More files.
 */
function catalogOf ({ components = ['connect', 'cloud-data-platform'], data = true, sources = true, partials = true, extra = [] } = {}) {
  const files = []
  if (data) files.push({ src: { component: 'connect', version: '', module: 'components', family: 'attachment', relative: 'connect-4.115.1.json' }, contents: SAMPLE })
  for (const component of components) {
    for (const p of PAGES[component] || []) {
      const key = p.relative.replace(/^connect\/(?:components|guides)\//, '').replace(/^(?:components\/)?/, '').replace(/\.adoc$/, '')
      const text = !sources ? undefined : component === 'connect' ? PAGES.sources[key] : PAGES['cloud-sources'][p.relative]
      const page = { src: { component, version: '', module: p.module, family: 'page', relative: p.relative }, ...(text ? { contents: Buffer.from(text) } : {}) }
      files.push(page)
      for (const alias of p.aliases) {
        const [module, relative] = alias.split(':')
        files.push({ src: { component, version: '', module, family: 'alias', relative }, rel: page })
      }
    }
  }
  if (partials && components.includes('connect')) {
    for (const [relative, text] of Object.entries(PAGES.partials)) {
      files.push({ src: { component: 'connect', version: '', module: 'components', family: 'partial', relative }, contents: Buffer.from(text) })
    }
  }
  files.push(...extra)
  const named = new Set(['connect', 'cloud-data-platform', 'streaming', 'agentic-data-plane', ...files.map((f) => f.src.component)])
  return {
    findBy: (query) => files.filter((file) => Object.entries(query).every(([key, value]) => file.src[key] === value)),
    getComponent: (name) => {
      if (!named.has(name)) return undefined
      const versions = [{ version: VERSIONS[name] || '', asciidoc: { attributes: ATTRIBUTES[name] || {} } }]
      return { name, versions, latest: versions[0] }
    },
  }
}

/**
 * Convert with the prop extension's macros, rendering in one component.
 */
function convert (input, { catalog = catalogOf(), component = 'connect', version = VERSIONS[component] || '', module = 'guides', relative = 'example.adoc', attributes = {} } = {}) {
  const { register } = require('../../macros/prop')
  const Asciidoctor = require('@asciidoctor/core')()
  const registry = Asciidoctor.Extensions.create()
  register(registry, catalog && {
    contentCatalog: catalog,
    file: { src: { path: `modules/${module}/pages/${relative}`, component, version, module, relative } },
  })
  return Asciidoctor.convert(input, { extension_registry: registry, attributes })
}

module.exports = { FIXTURES, SAMPLE, DATA, PAGES, ATTRIBUTES, catalogOf, convert }
