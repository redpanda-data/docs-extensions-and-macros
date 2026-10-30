'use strict'

// The rpk macros log through @antora/logger.
jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

const fs = require('fs')
const path = require('path')
const { register } = require('../../macros/prop')
const rpkLinks = require('../../extension-utils/rpk-links')

// Real data: the descriptions and content entries of docs-data/rpk-v26.2.2.json
// that link something, and the real pages of docs, cloud-docs, adp-docs and
// rp-connect-docs among the link targets (see _source in the file).
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'rpkval', 'rpk-links-sample.json'), 'utf8'))
const DATA = FIXTURE.rpk
const TREE = DATA.tree

const ATTRIBUTES = {
  'cloud-data-platform': { 'env-cloud': true },
  'agentic-data-plane': { 'env-adp': true },
}

function catalogOf ({ components = FIXTURE.components.map((c) => c.name) } = {}) {
  const files = [{ src: { component: 'streaming', version: '26.2', module: 'reference', family: 'attachment', relative: 'rpk-v26.2.2.json' }, contents: Buffer.from(JSON.stringify(DATA)) }]
  for (const c of FIXTURE.components) {
    if (!components.includes(c.name)) continue
    const pages = c.pages.map(({ module, relative }) => ({ src: { component: c.name, version: c.version, module, family: 'page', relative } }))
    files.push(...pages)
    for (const a of c.aliases) {
      const rel = pages.find((p) => p.src.module === a.target.module && p.src.relative === a.target.relative)
      files.push({ src: { component: c.name, version: c.version, module: a.module, family: 'alias', relative: a.relative }, rel })
    }
  }
  const named = new Set(FIXTURE.components.map((c) => c.name))
  return {
    findBy: (query) => files.filter((file) => Object.entries(query).every(([key, value]) => file.src[key] === value)),
    getComponent: (name) => {
      if (!named.has(name)) return undefined
      const version = (FIXTURE.components.find((c) => c.name === name) || {}).version || ''
      const entry = { version, asciidoc: { attributes: ATTRIBUTES[name] || {} } }
      return { name, versions: [entry], latest: entry }
    },
  }
}

const registry = { tag: 'v26.2.2', data: DATA, component: 'streaming', version: '26.2' }

// The description or content entry text that holds a link, as written.
const descriptionOf = (names) => names.reduce((node, name) => node.commands.find((c) => c.name === name), TREE).description
const contentLine = (names, needle) => names.reduce((node, name) => node.commands.find((c) => c.name === name), TREE)
  .content.flatMap((c) => c.content.split('\n')).find((line) => line.includes(needle))

const SRC = {
  docs: { component: 'streaming', version: '26.2', module: 'manage', relative: 'security/authorization/acl.adoc' },
  cloud: { component: 'cloud-data-platform', version: '', module: 'develop', relative: 'cloud-mcp/overview.adoc' },
  adp: { component: 'agentic-data-plane', version: '', module: 'ROOT', relative: 'index.adoc' },
  connect: { component: 'connect', version: '', module: 'get-started', relative: 'about.adoc' },
}

const relocate = (text, names, src, catalog = catalogOf()) => rpkLinks.relocateRpkRefs(text, { registry, names, src, contentCatalog: catalog })

describe('relocateRpkRefs: links in rpk descriptions, rewritten for the rendering page', () => {
  describe('a command page links the page rpkcmd: would link', () => {
    const text = descriptionOf(['cloud', 'mcp', 'stdio'])

    test('the real description names its link by the streaming path', () => {
      expect(text).toContain('xref:reference:rpk/rpk-cloud/rpk-cloud-mcp-install.adoc[`rpk cloud mcp install`]')
    })

    test('on Cloud: the Cloud page, relative to nothing but cloud-docs', () => {
      const out = relocate(text, ['cloud', 'mcp', 'stdio'], SRC.cloud)
      expect(out.text).toContain('xref:cloud-data-platform:reference:rpk/rpk-cloud/rpk-cloud-mcp-install.adoc[`rpk cloud mcp install`]')
      expect(out.unlinked).toEqual([])
    })

    test('on Cloud without that page: the label as text, reported, never a self-managed link', () => {
      const out = relocate(text, ['cloud', 'mcp', 'stdio'], SRC.cloud, catalogOf({ components: ['streaming', 'agentic-data-plane'] }))
      expect(out.text).toContain('Most users should use `rpk cloud mcp install` instead')
      expect(out.text).not.toContain('xref:')
      expect(out.unlinked).toEqual(['reference:rpk/rpk-cloud/rpk-cloud-mcp-install.adoc'])
    })

    test('on streaming, which has no rpk cloud mcp pages: the Cloud page, the only one in the build', () => {
      expect(relocate(text, ['cloud', 'mcp', 'stdio'], SRC.docs).text).toContain('xref:cloud-data-platform:reference:rpk/rpk-cloud/rpk-cloud-mcp-install.adoc[')
    })

    test('on Agentic Data Plane: its own rpk page when it has one, as for rpk profile list', () => {
      const out = relocate(descriptionOf(['profile', 'create']), ['profile', 'create'], SRC.adp)
      expect(out.text).toContain('xref:agentic-data-plane:reference:rpk/rpk-profile/rpk-profile-list.adoc[`rpk profile list`]')
    })

    test('on Agentic Data Plane without the page: streaming, the component the data came from', () => {
      const out = relocate(descriptionOf(['security', 'acl']), ['security', 'acl'], SRC.adp)
      expect(out.text).toContain('xref:26.2@streaming:reference:rpk/rpk-security/rpk-security-user.adoc[`rpk security user`]')
    })

    test('on rp-connect-docs, which has no rpk pages: streaming', () => {
      const out = relocate(descriptionOf(['security', 'acl']), ['security', 'acl'], SRC.connect)
      expect(out.text).toContain('xref:26.2@streaming:reference:rpk/rpk-security/rpk-security-user.adoc[')
    })

    test('on no page with no rpk page anywhere: the label as text', () => {
      const out = relocate(descriptionOf(['cloud', 'mcp', 'stdio']), ['cloud', 'mcp', 'stdio'], SRC.docs, catalogOf({ components: ['streaming', 'connect'] }))
      expect(out.text).toContain('use `rpk cloud mcp install` instead')
      expect(out.unlinked).toHaveLength(1)
    })
  })

  describe('a path beside the command page (xref:./x.adoc)', () => {
    test('resolves beside the command\'s own page and keeps its fragment', () => {
      const line = contentLine(['redpanda', 'tune'], 'xref:./rpk-redpanda-tune-list.adoc#tuners[Tuners reference] for descriptions')
      expect(relocate(line, ['redpanda', 'tune'], SRC.docs).text)
        .toBe('See also the xref:26.2@streaming:reference:rpk/rpk-redpanda/rpk-redpanda-tune-list.adoc#tuners[Tuners reference] for descriptions about each tuner.')
    })

    test('on Cloud, which has no rpk redpanda pages, renders as text', () => {
      const line = contentLine(['redpanda', 'tune'], 'xref:./rpk-redpanda-mode.adoc[`rpk redpanda mode production`]')
      const out = relocate(line, ['redpanda', 'tune'], SRC.cloud)
      expect(out.text).toBe('* `rpk redpanda mode production`')
      expect(out.unlinked).toEqual(['reference:rpk/rpk-redpanda/rpk-redpanda-mode.adoc'])
    })
  })

  describe('an anchor on the command page (<<id>>)', () => {
    const line = contentLine(['redpanda', 'tune', 'list'], '<<disk_irq,disk_irq tuner>>')

    test('links the anchor on the command\'s page from any other page', () => {
      expect(relocate(line, ['redpanda', 'tune', 'list'], SRC.docs).text).toContain('xref:26.2@streaming:reference:rpk/rpk-redpanda/rpk-redpanda-tune-list.adoc#disk_irq[disk_irq tuner]')
    })

    test('stays an anchor on the command\'s own page', () => {
      const own = { component: 'streaming', version: '26.2', module: 'reference', relative: 'rpk/rpk-redpanda/rpk-redpanda-tune-list.adoc' }
      expect(relocate(line, ['redpanda', 'tune', 'list'], own).text).toBe(line)
    })
  })

  describe('any other page', () => {
    const line = contentLine(['security', 'acl', 'create'], 'xref:manage:security/authorization/acl.adoc')

    test('stays as written where the rendering component has it', () => {
      expect(relocate(line, ['security', 'acl', 'create'], SRC.docs).text).toBe(line)
    })

    test('is qualified with the data\'s component and version elsewhere', () => {
      expect(relocate(line, ['security', 'acl', 'create'], SRC.adp).text).toContain('See xref:26.2@streaming:manage:security/authorization/acl.adoc[Configure Access Control Lists].')
    })

    test('on Cloud, which has the ACL page at another path, renders as text', () => {
      const out = relocate(line, ['security', 'acl', 'create'], SRC.cloud)
      expect(out.text).toContain('See Configure Access Control Lists.')
      expect(out.unlinked).toEqual(['manage:security/authorization/acl.adoc'])
    })

    test('a non-command rpk page (rpk-x-options) resolves in the rendering component when it has it', () => {
      const text = contentLine(['generate', 'app'], 'rpk-x-options.adoc#adminhosts')
      expect(relocate(text, ['generate', 'app'], SRC.cloud).text).toBe(text)
      expect(relocate(text, ['generate', 'app'], SRC.connect).text).toContain('xref:26.2@streaming:reference:rpk/rpk-x-options.adoc#adminhosts[')
    })
  })

  describe('a qualified target', () => {
    const line = contentLine(['connect'], 'xref:connect:streaming:about.adoc')

    test('stays as written when the build has it, page aliases included', () => {
      expect(relocate(line, ['connect'], SRC.cloud).text).toBe(line)
    })

    test('renders as text when the build does not', () => {
      const out = relocate(line, ['connect'], SRC.cloud, catalogOf({ components: ['streaming', 'cloud-data-platform'] }))
      expect(out.text).toBe('For full details, see the Redpanda Connect documentation.')
      expect(out.unlinked).toEqual(['connect:streaming:about.adoc'])
    })
  })

  test('listings are left alone', () => {
    const text = 'See xref:./rpk-redpanda-mode.adoc[mode].\n\n----\nxref:./rpk-redpanda-mode.adoc[mode]\n----'
    expect(relocate(text, ['redpanda', 'tune'], SRC.cloud).text).toBe('See mode.\n\n----\nxref:./rpk-redpanda-mode.adoc[mode]\n----')
  })

  test('with no catalog, nothing changes', () => {
    const text = descriptionOf(['cloud', 'mcp', 'stdio'])
    expect(rpkLinks.relocateRpkRefs(text, { registry, names: ['cloud', 'mcp', 'stdio'], src: SRC.cloud })).toEqual({ text, unlinked: [] })
  })
})

describe('rpkval:: renders a description\'s links for the rendering page', () => {
  afterEach(() => jest.restoreAllMocks())

  function convert (input, src, catalog = catalogOf()) {
    const Asciidoctor = require('@asciidoctor/core')()
    const extensions = Asciidoctor.Extensions.create()
    register(extensions, { contentCatalog: catalog, file: { src: { path: `modules/${src.module}/pages/${src.relative}`, ...src } } })
    return Asciidoctor.convert(input, { extension_registry: extensions })
  }

  test('a Cloud page links the Cloud rpk cloud mcp install page', () => {
    const html = convert('rpkval::[rpk cloud mcp stdio,description]', SRC.cloud)
    expect(html).toMatch(/<a href="cloud-data-platform:reference:rpk\/rpk-cloud\/rpk-cloud-mcp-install\.html"[^>]*><code>rpk cloud mcp install<\/code><\/a>/)
  })

  test('an Agentic Data Plane page links streaming for rpk security user', () => {
    const html = convert('rpkval::[rpk security acl,description]', SRC.adp)
    expect(html).toContain('href="26.2@streaming:reference:rpk/rpk-security/rpk-security-user.html"')
  })

  test('a Cloud page without the page renders the label as code and warns', () => {
    const warn = jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})
    const html = convert('rpkval::[rpk cloud mcp stdio,description]', SRC.cloud, catalogOf({ components: ['streaming', 'agentic-data-plane'] }))
    expect(html).toContain('Most users should use <code>rpk cloud mcp install</code> instead')
    expect(html).not.toContain('<a ')
    expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain('rpkval::[rpk cloud mcp stdio,description] in modules/develop/pages/cloud-mcp/overview.adoc: the description links reference:rpk/rpk-cloud/rpk-cloud-mcp-install.adoc, which this Cloud page has no page for, so that link renders as text.')
  })

  test('rpk-validate=off silences that warning', () => {
    const warn = jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})
    const Asciidoctor = require('@asciidoctor/core')()
    const extensions = Asciidoctor.Extensions.create()
    register(extensions, { contentCatalog: catalogOf({ components: ['streaming', 'agentic-data-plane'] }), file: { src: { path: 'x.adoc', ...SRC.cloud } } })
    Asciidoctor.convert('rpkval::[rpk cloud mcp stdio,description]', { extension_registry: extensions, attributes: { 'rpk-validate': 'off' } })
    expect(warn).not.toHaveBeenCalled()
  })
})
