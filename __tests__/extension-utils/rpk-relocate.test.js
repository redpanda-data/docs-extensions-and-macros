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

// The URL Antora publishes a page at, with the docs site's settings
// (html_extension_style: indexify, latest_version_segment: current). Every
// fixture component version is its component's latest.
function pubUrl (component, { module, relative }) {
  let stem = relative.replace(/\.adoc$/, '')
  stem = stem === 'index' ? '' : stem.replace(/\/index$/, '')
  const segments = [component.name, ...(component.version ? ['current'] : []), ...(module === 'ROOT' ? [] : [module]), ...(stem ? [stem] : [])]
  return `/${segments.join('/')}/`
}

function catalogOf ({ components = FIXTURE.components.map((c) => c.name), data = DATA } = {}) {
  const files = [{ src: { component: 'streaming', version: '26.2', module: 'reference', family: 'attachment', relative: 'rpk-v26.2.2.json' }, contents: Buffer.from(JSON.stringify(data)) }]
  for (const c of FIXTURE.components) {
    if (!components.includes(c.name)) continue
    const pages = c.pages.map(({ module, relative, title, sections = [] }) => ({
      src: { component: c.name, version: c.version, module, family: 'page', relative },
      out: {},
      pub: { url: pubUrl(c, { module, relative }) },
      mediaType: 'text/asciidoc',
      ...(title ? { asciidoc: { doctitle: title }, contents: Buffer.from([`= ${title}`, ...sections.map((h) => `\n== ${h}`)].join('\n')) } : {}),
    }))
    files.push(...pages)
    for (const a of c.aliases) {
      const rel = pages.find((p) => p.src.module === a.target.module && p.src.relative === a.target.relative)
      files.push({ src: { component: c.name, version: c.version, module: a.module, family: 'alias', relative: a.relative }, rel, pub: { url: pubUrl(c, a) } })
    }
  }
  const named = new Set(FIXTURE.components.map((c) => c.name))
  const getComponent = (name) => {
    if (!named.has(name)) return undefined
    const version = (FIXTURE.components.find((c) => c.name === name) || {}).version || ''
    const entry = { version, asciidoc: { attributes: ATTRIBUTES[name] || {} } }
    return { name, versions: [entry], latest: entry }
  }
  return {
    findBy: (query) => files.filter((file) => Object.entries(query).every(([key, value]) => file.src[key] === value)),
    getComponent,
    getComponents: () => FIXTURE.components.filter((c) => components.includes(c.name)).map((c) => getComponent(c.name)),
    getPages: (filter = () => true) => files.filter((file) => file.src.family === 'page' && filter(file)),
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

// rpk's own help (raw_tree) for the 7 commands whose description has a
// docs.redpanda.com URL; the override-merged tree hides them today.
const RAW = Object.fromEntries(FIXTURE.raw_tree_urls.map(({ names, description }) => [names.join(' '), description]))
const RESTORE = ['cluster', 'storage', 'restore', 'start']
const CONNECTIONS = ['cluster', 'connections', 'list']
const BLOBL = ['connect', 'blobl']
const RESTORE_URL = 'https://docs.redpanda.com/current/manage/disaster-recovery/whole-cluster-restore/'
const ADMIN_URL = RAW['cluster connections list'].match(/https:\/\/docs\.redpanda\.com\/api\/\S+/)[0]
const lineWith = (text, needle) => text.split('\n').find((line) => line.includes(needle))

// The rpk data with those descriptions in its tree, as a new rpk would ship
// them, for the macro to render.
function withRawUrls (data) {
  const copy = JSON.parse(JSON.stringify(data))
  for (const { names, description } of FIXTURE.raw_tree_urls) {
    let node = copy.tree
    names.forEach((name, i) => {
      let child = (node.commands || []).find((c) => c.name === name)
      if (!child) {
        child = { name, usage: `rpk ${names.slice(0, i + 1).join(' ')} [flags]`, aliases: [], flags: [], commands: [] }
        node.commands = [...(node.commands || []), child]
      }
      node = child
    })
    node.description = description
  }
  return copy
}

describe('relocateRpkRefs: docs URLs in rpk descriptions, linked for the rendering page', () => {
  describe('a self-managed page, followed by a sentence period (rpk cluster storage restore start)', () => {
    const text = RAW['cluster storage restore start']

    test('the real help ends the URL with a sentence period', () => {
      expect(text).toContain(`visit ${RESTORE_URL}.`)
    })

    test('on streaming: the page in the rendering version, titled, the period left after the link', () => {
      const out = relocate(text, RESTORE, SRC.docs)
      expect(lineWith(out.text, 'For more information')).toBe('to restore from. For more information, visit xref:manage:disaster-recovery/whole-cluster-restore.adoc[Whole Cluster Restore].')
      expect(out.unlinked).toEqual([])
    })

    test('on Agentic Data Plane and rp-connect-docs: the streaming page, as url-to-xref writes a latest-version target', () => {
      for (const src of [SRC.adp, SRC.connect]) {
        expect(relocate(text, RESTORE, src).text).toContain('visit xref:streaming:manage:disaster-recovery/whole-cluster-restore.adoc[Whole Cluster Restore].')
      }
    })

    test('on Cloud: the title as text, never a self-managed link, and the URL reported', () => {
      const out = relocate(text, RESTORE, SRC.cloud)
      expect(out.text).toContain('For more information, visit Whole Cluster Restore.')
      expect(out.text).not.toMatch(/xref:|https:/)
      expect(out.unlinked).toEqual([RESTORE_URL])
    })

    test('on Cloud a label is the text shown', () => {
      const out = relocate(`See ${RESTORE_URL}[the restore guide].`, RESTORE, SRC.cloud)
      expect(out.text).toBe('See the restore guide.')
    })
  })

  describe('Redpanda Connect pages (rpk connect and its subcommands)', () => {
    test('the real help links each page by the legacy /redpanda-connect/ path', () => {
      for (const names of [['connect'], BLOBL, ['connect', 'streams'], ['connect', 'template'], ['connect', 'test']]) {
        expect(RAW[names.join(' ')]).toContain('https://docs.redpanda.com/redpanda-connect')
      }
    })

    test('on streaming and Agentic Data Plane: the rp-connect-docs page, titled', () => {
      for (const src of [SRC.docs, SRC.adp]) {
        const out = relocate(RAW['connect blobl'], BLOBL, src)
        expect(lineWith(out.text, 'Find out more')).toBe('Find out more about Bloblang at: xref:connect:guides:bloblang/about.adoc[Bloblang]')
        expect(out.unlinked).toEqual([])
      }
    })

    test('the example commands in the description, literal lines, are left alone', () => {
      const out = relocate(RAW['connect blobl'], BLOBL, SRC.docs)
      expect(out.text.split('\n').slice(0, -1)).toEqual(RAW['connect blobl'].split('\n').slice(0, -1))
    })

    test('on rp-connect-docs: its own page', () => {
      expect(relocate(RAW['connect blobl'], BLOBL, SRC.connect).text).toContain('Bloblang at: xref:guides:bloblang/about.adoc[Bloblang]')
      expect(relocate(RAW.connect, ['connect'], SRC.connect).text).toBe('A stream processor for mundane tasks - xref:home:index.adoc[Redpanda Connect Documentation]')
    })

    test('on Cloud: the Cloud page that declares the rp-connect-docs path as its alias', () => {
      expect(relocate(RAW['connect blobl'], BLOBL, SRC.cloud).text).toContain('Bloblang at: xref:guides:bloblang/about.adoc[Bloblang]')
      expect(relocate(RAW['connect test'], ['connect', 'test'], SRC.cloud).text).toContain('xref:configuration:unit_testing.adoc[Unit Testing]')
    })

    test('on Cloud without such a page: the title as text, reported, never a link to the self-managed Connect docs', () => {
      const out = relocate(RAW['connect streams'], ['connect', 'streams'], SRC.cloud)
      expect(lineWith(out.text, 'Streams Mode')).toBe('Streams Mode')
      expect(out.text).not.toMatch(/xref:|https:/)
      expect(out.unlinked).toEqual(['https://docs.redpanda.com/redpanda-connect/guides/streams_mode/about'])
      expect(relocate(RAW['connect template'], ['connect', 'template'], SRC.cloud).text).toMatch(/docs at:\nTemplating$/)
    })

    test('the bare /redpanda-connect URL is the start page, not a page of the same path in the rendering component', () => {
      // cloud-docs and adp-docs each have a home:index.adoc of their own; neither is the Connect start page.
      expect(relocate(RAW.connect, ['connect'], SRC.adp).text).toBe('A stream processor for mundane tasks - xref:connect:home:index.adoc[Redpanda Connect Documentation]')
      const out = relocate(RAW.connect, ['connect'], SRC.cloud)
      expect(out.text).toBe('A stream processor for mundane tasks - Redpanda Connect Documentation')
      expect(out.unlinked).toEqual(['https://docs.redpanda.com/redpanda-connect'])
    })
  })

  describe('a URL the catalog does not publish stays as written, unreported', () => {
    test('the Admin API reference under /api/ (rpk cluster connections list)', () => {
      for (const src of Object.values(SRC)) {
        const out = relocate(RAW['cluster connections list'], CONNECTIONS, src)
        expect(out.text).toBe(RAW['cluster connections list'])
        expect(out.unlinked).toEqual([])
      }
    })

    test('a page the build does not have, a query string, /mcp, and another host', () => {
      const text = [
        'https://docs.redpanda.com/current/manage/no-such-page/',
        `${RESTORE_URL}?tab=linux`,
        'https://docs.redpanda.com/mcp',
        'https://example.com/current/manage/disaster-recovery/whole-cluster-restore/',
      ].join('\n\n')
      for (const src of [SRC.docs, SRC.cloud]) expect(relocate(text, RESTORE, src)).toEqual({ text, unlinked: [] })
    })

    test('/api/ stays as written even where the build publishes a page at that path, as url-to-xref ignores it', () => {
      const catalog = catalogOf()
      const page = catalog.findBy({ component: 'streaming', family: 'page', relative: 'disaster-recovery/whole-cluster-restore.adoc' })[0]
      page.pub.url = new URL(ADMIN_URL).pathname
      expect(relocate(RAW['cluster connections list'], CONNECTIONS, SRC.docs, catalog).text).toBe(RAW['cluster connections list'])
    })

    test('a URL in a listing or inline code', () => {
      const text = `\`${RESTORE_URL}\`\n\n----\n${RESTORE_URL}\n----`
      expect(relocate(text, RESTORE, SRC.docs).text).toBe(text)
    })
  })

  describe('labels, versions, aliases and anchors, as url-to-xref maps them', () => {
    test('a label is kept', () => {
      expect(relocate(`See ${RESTORE_URL}[the restore guide].`, RESTORE, SRC.adp).text)
        .toBe('See xref:streaming:manage:disaster-recovery/whole-cluster-restore.adoc[the restore guide].')
    })

    test('a version segment that is the latest version resolves the same', () => {
      expect(relocate('https://docs.redpanda.com/26.2/manage/disaster-recovery/whole-cluster-restore/', RESTORE, SRC.adp).text)
        .toBe('xref:streaming:manage:disaster-recovery/whole-cluster-restore.adoc[Whole Cluster Restore]')
    })

    test('a page\'s former path resolves through its page alias', () => {
      expect(relocate('https://docs.redpanda.com/current/manage/whole-cluster-restore/', RESTORE, SRC.docs).text)
        .toBe('xref:manage:disaster-recovery/whole-cluster-restore.adoc[Whole Cluster Restore]')
    })

    test('an anchor on the page links with its heading as text; one not on the page stays a URL', () => {
      expect(relocate(`${RESTORE_URL}#restore-data-from-a-source-cluster`, RESTORE, SRC.adp).text)
        .toBe('xref:streaming:manage:disaster-recovery/whole-cluster-restore.adoc#restore-data-from-a-source-cluster[Restore data from a source cluster]')
      const missing = `${RESTORE_URL}#no-such-section`
      expect(relocate(missing, RESTORE, SRC.adp).text).toBe(missing)
    })

    test('an anchor on a page Antora has already converted is read from its HTML', () => {
      const catalog = catalogOf()
      const page = catalog.findBy({ component: 'streaming', family: 'page', relative: 'disaster-recovery/whole-cluster-restore.adoc' })[0]
      page.contents = Buffer.from('<div class="sect1"><h2 id="restore-data-from-a-source-cluster"><a class="anchor" href="#restore-data-from-a-source-cluster"></a>Restore data from a source cluster</h2></div>')
      page.mediaType = 'text/html'
      expect(relocate(`${RESTORE_URL}#restore-data-from-a-source-cluster`, RESTORE, SRC.adp, catalog).text)
        .toBe('xref:streaming:manage:disaster-recovery/whole-cluster-restore.adoc#restore-data-from-a-source-cluster[Restore data from a source cluster]')
      expect(relocate(`${RESTORE_URL}#manage-source-metadata-uploads`, RESTORE, SRC.adp, catalog).text).toBe(`${RESTORE_URL}#manage-source-metadata-uploads`)
    })
  })

  describe('an rpk command page links the page rpkcmd: would link', () => {
    const url = 'https://docs.redpanda.com/current/reference/rpk/rpk-security/rpk-security-user/'

    test('on Agentic Data Plane, which has no rpk security pages: streaming', () => {
      expect(relocate(`See ${url}.`, ['security', 'acl'], SRC.adp).text)
        .toBe('See xref:26.2@streaming:reference:rpk/rpk-security/rpk-security-user.adoc[`rpk security user`].')
    })

    test('on Cloud: the Cloud page', () => {
      expect(relocate(`See ${url}[user].`, ['security', 'acl'], SRC.cloud).text)
        .toBe('See xref:cloud-data-platform:reference:rpk/rpk-security/rpk-security-user.adoc[user].')
    })

    test('on Cloud without the page: the command as text, reported', () => {
      const out = relocate(`See ${url}.`, ['security', 'acl'], SRC.cloud, catalogOf({ components: ['streaming', 'connect'] }))
      expect(out.text).toBe('See `rpk security user`.')
    })
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

  test('a docs URL on a streaming page links the page in its own version', () => {
    const html = convert('rpkval::[rpk cluster storage restore start,description]', SRC.docs, catalogOf({ data: withRawUrls(DATA) }))
    expect(html).toContain('visit <a href="manage:disaster-recovery/whole-cluster-restore.html">Whole Cluster Restore</a>.')
  })

  test('a self-managed docs URL on a Cloud page renders as text and warns', () => {
    // rpk connect is on Cloud; rpk cluster storage restore start, self-managed
    // only in the real data, never renders its description there.
    const warn = jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})
    const html = convert('rpkval::[rpk connect streams,description]', SRC.cloud, catalogOf({ data: withRawUrls(DATA) }))
    expect(html).toMatch(/docs at:\nStreams Mode<\/p>/)
    expect(html).not.toContain('<a ')
    expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain('rpkval::[rpk connect streams,description] in modules/develop/pages/cloud-mcp/overview.adoc: the description links https://docs.redpanda.com/redpanda-connect/guides/streams_mode/about, which this Cloud page has no page for, so that link renders as text.')
  })

  test('a Connect URL on a Cloud page links the Cloud Connect page', () => {
    const html = convert('rpkval::[rpk connect blobl,description]', SRC.cloud, catalogOf({ data: withRawUrls(DATA) }))
    expect(html).toContain('<a href="guides:bloblang/about.html">Bloblang</a>')
  })

  test('the Admin API URL stays a plain URL link', () => {
    const warn = jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})
    const html = convert('rpkval::[rpk cluster connections list,description]', SRC.cloud, catalogOf({ data: withRawUrls(DATA) }))
    expect(html).toContain(`<a href="${ADMIN_URL}" class="bare">${ADMIN_URL}</a>`)
    expect(warn).not.toHaveBeenCalled()
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
