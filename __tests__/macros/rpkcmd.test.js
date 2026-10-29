'use strict'

// Same mocked logger as rpkval.test.js: the macros log through @antora/logger.
jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

const fs = require('fs')
const path = require('path')
const { register } = require('../../macros/prop')
const { THROW_KINDS } = require('../../macros/rpkcmd')
const rpkLinks = require('../../extension-utils/rpk-links')

// Real data: the trimmed rpk-v26.2.2 snapshot rpkval.test.js uses, and the
// rpk reference page paths of docs, cloud-docs and adp-docs for the same
// commands (see _source in each file).
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'rpkval')
const SAMPLE = fs.readFileSync(path.join(FIXTURES, 'rpk-v26.2.2-sample.json'))
const PAGES = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'rpk-pages-sample.json'), 'utf8'))
const TREE = JSON.parse(SAMPLE.toString()).tree

const ATTRIBUTES = {
  'cloud-data-platform': { 'env-cloud': true },
  'agentic-data-plane': { 'env-adp': true },
}

// A content catalog with the streaming 26.2 rpk data, the real page paths of
// streaming 26.2, the cloud-data-platform stubs and the agentic-data-plane
// pages, plus components that have no rpk pages of their own.
function catalogOf ({ components = PAGES.components.map((c) => c.name), data = true, extra = [] } = {}) {
  const files = []
  if (data) files.push({ src: { component: 'streaming', version: '26.2', module: 'reference', family: 'attachment', relative: 'rpk-v26.2.2.json' }, contents: SAMPLE })
  for (const c of PAGES.components) {
    if (!components.includes(c.name)) continue
    for (const relative of c.pages) files.push({ src: { component: c.name, version: c.version, module: 'reference', family: 'page', relative } })
  }
  files.push(...extra)
  const named = new Set([...files.map((f) => f.src.component), 'connect', 'cloud-data-platform', 'agentic-data-plane'])
  return {
    findBy: (query) => files.filter((file) => Object.entries(query).every(([key, value]) => file.src[key] === value)),
    getComponent: (name) => {
      if (!named.has(name)) return undefined
      const versions = [...new Set(files.filter((f) => f.src.component === name).map((f) => f.src.version))]
        .sort((a, b) => String(b).localeCompare(String(a), 'en', { numeric: true }))
        .map((version) => ({ version, asciidoc: { attributes: ATTRIBUTES[name] || {} } }))
      if (!versions.length) versions.push({ version: '', asciidoc: { attributes: ATTRIBUTES[name] || {} } })
      return { name, versions, latest: versions[0] }
    },
  }
}

function convert (input, { catalog = catalogOf(), attributes = {}, component = 'streaming', version = '26.2' } = {}) {
  const Asciidoctor = require('@asciidoctor/core')()
  const registry = Asciidoctor.Extensions.create()
  register(registry, {
    contentCatalog: catalog,
    file: { src: { path: 'modules/manage/pages/example.adoc', component, version, module: 'manage' } },
  })
  return Asciidoctor.convert(input, { extension_registry: registry, attributes })
}

// The xref target and code of the first rpkcmd output, or plain code.
function linkOf (html) {
  const link = html.match(/<a href="#([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
  if (link) return { target: link[1], inner: link[2] }
  const code = html.match(/<code>([\s\S]*?)<\/code>/)
  return code ? { plain: code[1] } : undefined
}

const warnings = () => jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})

describe('rpkcmd macro', () => {
  afterEach(() => jest.restoreAllMocks())

  describe('page paths, as the rpk generator writes them', () => {
    test.each([
      [[], 'rpk/rpk.adoc'],
      [['version'], 'rpk/rpk-version.adoc'],
      [['topic'], 'rpk/rpk-topic/rpk-topic.adoc'],
      [['topic', 'create'], 'rpk/rpk-topic/rpk-topic-create.adoc'],
      [['cluster', 'partitions', 'move-cancel'], 'rpk/rpk-cluster/rpk-cluster-partitions-move-cancel.adoc'],
      [['ai', 'agent', 'credential', 'create'], 'rpk/rpk-ai/rpk-ai-agent-credential-create.adoc'],
    ])('%j is %s', (names, relative) => {
      expect(rpkLinks.commandPagePath(TREE, names)).toBe(relative)
      expect(rpkLinks.commandOfPage(TREE, relative).names).toEqual(names)
    })

    test('every real page of a command in the data is where the path rule puts it', () => {
      for (const c of PAGES.components) {
        for (const relative of c.pages) {
          const command = rpkLinks.commandOfPage(TREE, relative)
          if (!command) continue
          expect(rpkLinks.commandPagePath(TREE, command.names)).toBe(relative)
        }
      }
    })

    test('a section page or a page in the wrong group is not a command page', () => {
      expect(rpkLinks.commandOfPage(TREE, 'rpk/index.adoc')).toBeUndefined()
      expect(rpkLinks.commandOfPage(TREE, 'rpk/rpk-x-options.adoc')).toBeUndefined()
      expect(rpkLinks.commandOfPage(TREE, 'rpk/rpk-cluster/rpk-topic-create.adoc')).toBeUndefined()
      expect(rpkLinks.commandOfPage(TREE, 'rpk/rpk-topic-create.adoc')).toBeUndefined()
    })
  })

  describe('links', () => {
    test('renders the command as code, linked to its page in the page\'s own component and version', () => {
      const html = convert('Run rpkcmd:[rpk topic create].')
      expect(html).toContain('<a href="#26.2@streaming:reference:rpk/rpk-topic/rpk-topic-create.adoc"><code class="rpk-command" data-rpk-command="rpk topic create">rpk topic create</code></a>')
    })

    test('the leading rpk is optional and an alias links the canonical page, shown as typed', () => {
      expect(linkOf(convert('rpkcmd:[topic create]'))).toEqual({ target: '26.2@streaming:reference:rpk/rpk-topic/rpk-topic-create.adoc', inner: '<code class="rpk-command" data-rpk-command="rpk topic create">rpk topic create</code>' })
      expect(linkOf(convert('rpkcmd:[rpk cluster status]'))).toEqual({ target: '26.2@streaming:reference:rpk/rpk-cluster/rpk-cluster-info.adoc', inner: '<code class="rpk-command" data-rpk-command="rpk cluster info">rpk cluster status</code>' })
    })

    test('a flag renders with the command and links the command page, which has no flag anchors', () => {
      expect(linkOf(convert('rpkcmd:[rpk topic create --partitions]'))).toEqual({ target: '26.2@streaming:reference:rpk/rpk-topic/rpk-topic-create.adoc', inner: '<code class="rpk-command" data-rpk-command="rpk topic create" data-rpk-flag="partitions">rpk topic create --partitions</code>' })
      expect(linkOf(convert('rpkcmd:[rpk topic create -p]')).inner).toContain('data-rpk-flag="partitions">rpk topic create -p<')
    })

    test('a global flag links the rpk page', () => {
      expect(linkOf(convert('rpkcmd:[rpk --profile]'))).toEqual({ target: '26.2@streaming:reference:rpk/rpk.adoc', inner: '<code class="rpk-command" data-rpk-command="rpk" data-rpk-flag="profile">rpk --profile</code>' })
    })

    test('a top-level command without subcommands links rpk/rpk-<name>.adoc', () => {
      expect(linkOf(convert('rpkcmd:[rpk version]')).target).toBe('26.2@streaming:reference:rpk/rpk-version.adoc')
    })

    test('text= replaces the code', () => {
      expect(linkOf(convert('rpkcmd:[rpk topic create,text=create a topic]'))).toEqual({ target: '26.2@streaming:reference:rpk/rpk-topic/rpk-topic-create.adoc', inner: 'create a topic' })
    })

    test('a command streaming has no page for links the component with the most pages in its directory that has it', () => {
      // cloud-data-platform and agentic-data-plane both have rpk cloud login.
      // agentic-data-plane has more rpk pages, cloud-data-platform more
      // rpk-cloud pages, as in the real repos.
      expect(linkOf(convert('rpkcmd:[rpk cloud login]')).target).toBe('cloud-data-platform:reference:rpk/rpk-cloud/rpk-cloud-login.adoc')
      expect(linkOf(convert('rpkcmd:[rpk ai auditlog list]')).target).toBe('agentic-data-plane:reference:rpk/rpk-ai/rpk-ai-auditlog-list.adoc')
    })
  })

  describe('rendering component', () => {
    test('a Cloud stub page links the Cloud stub, not the streaming page', () => {
      expect(linkOf(convert('rpkcmd:[rpk topic create]', { component: 'cloud-data-platform', version: '' })).target).toBe('cloud-data-platform:reference:rpk/rpk-topic/rpk-topic-create.adoc')
    })

    test('Cloud with no page for the command renders plain code and warns, never linking self-managed docs', () => {
      const warn = warnings()
      const html = convert('rpkcmd:[rpk cluster partitions move-cancel]', { component: 'cloud-data-platform', version: '' })
      expect(linkOf(html)).toEqual({ plain: 'rpk cluster partitions move-cancel' })
      expect(html).not.toContain('streaming:')
      expect(warn.mock.calls[0][0]).toContain('cloud-data-platform@unversioned has no reference page for rpk cluster partitions move-cancel (reference:rpk/rpk-cluster/rpk-cluster-partitions-move-cancel.adoc), and a Cloud page links only Cloud pages')
    })

    test('an Agentic Data Plane page links its own rpk ai page, and streaming for the rest', () => {
      expect(linkOf(convert('rpkcmd:[rpk ai auditlog list]', { component: 'agentic-data-plane', version: '' })).target).toBe('agentic-data-plane:reference:rpk/rpk-ai/rpk-ai-auditlog-list.adoc')
      expect(linkOf(convert('rpkcmd:[rpk topic create]', { component: 'agentic-data-plane', version: '' })).target).toBe('26.2@streaming:reference:rpk/rpk-topic/rpk-topic-create.adoc')
    })

    test('a page in a component with no rpk data of its own (rp-connect-docs) checks against the latest streaming data and links streaming', () => {
      expect(linkOf(convert('rpkcmd:[rpk connect run]', { component: 'connect', version: '' })).target).toBe('26.2@streaming:reference:rpk/rpk-connect/rpk-connect-run.adoc')
      expect(linkOf(convert('rpkcmd:[rpk topic consume]', { component: 'connect', version: '' })).target).toBe('26.2@streaming:reference:rpk/rpk-topic/rpk-topic-consume.adoc')
    })

    test('a streaming page links its own version, never the latest', () => {
      const older = { src: { component: 'streaming', version: '26.1', module: 'reference', family: 'page', relative: 'rpk/rpk-topic/rpk-topic-create.adoc' } }
      const data = { src: { component: 'streaming', version: '26.1', module: 'reference', family: 'attachment', relative: 'rpk-v26.1.12.json' }, contents: SAMPLE }
      const catalog = catalogOf({ extra: [older, data] })
      expect(linkOf(convert('rpkcmd:[rpk topic create]', { catalog, version: '26.1' })).target).toBe('26.1@streaming:reference:rpk/rpk-topic/rpk-topic-create.adoc')
      // 26.1 has no rpk version page: no jump to streaming 26.2, but the
      // next rule, another component with the page.
      expect(linkOf(convert('rpkcmd:[rpk version]', { catalog, version: '26.1' })).target).toBe('cloud-data-platform:reference:rpk/rpk-version.adoc')
      expect(linkOf(convert('rpkcmd:[rpk version]', { catalog: catalogOf({ extra: [older, data], components: ['streaming'] }), version: '26.1' }))).toEqual({ plain: 'rpk version' })
    })

    test('a versioned streaming page with no rpk data renders plain code, never borrowing another release', () => {
      const warn = warnings()
      const older = { src: { component: 'streaming', version: '25.3', module: 'reference', family: 'page', relative: 'rpk/rpk-topic/rpk-topic-create.adoc' } }
      expect(linkOf(convert('rpkcmd:[rpk topic create]', { catalog: catalogOf({ extra: [older] }), version: '25.3', attributes: { 'rpk-validate': 'error' } }))).toEqual({ plain: 'rpk topic create' })
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain('no rpk data to check')
    })
  })

  describe('not linked', () => {
    test.each([
      ['rpk topic make', 'unknown-command', "'rpk topic make' is not a command in rpk-v26.2.2.json from streaming@26.2: rpk topic has no subcommand 'make'."],
      ['rpk cluster partitions movement-cancel', 'unknown-command', 'Did you mean: move-cancel?'],
      ['rpk topic create my-topic', 'unknown-command', 'Write the command path, without arguments.'],
      ['rpk redpanda admin brokers', 'deprecated-command', 'rpk redpanda admin brokers'],
      ['rpk topic create --partition', 'unknown-flag', 'Did you mean: --partitions?'],
      ['rpk topic create --partitions 3', 'unknown-flag', "'3' follows --partitions"],
      ['rpk registry mode set --schema-context', 'unknown-flag', 'it is defined on rpk registry; write rpkcmd:[rpk registry --schema-context]'],
    ])('rpkcmd:[%s] renders plain code and warns (%s)', (line, kind, message) => {
      const warn = warnings()
      const html = convert(`rpkcmd:[${line}]`)
      expect(linkOf(html)).toEqual({ plain: line })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toContain(`rpkcmd:[${line}] in modules/manage/pages/example.adoc: `)
      expect(warn.mock.calls[0][0]).toContain(message)
      expect(THROW_KINDS).toContain(kind)
      expect(() => convert(`rpkcmd:[${line}]`, { attributes: { 'rpk-validate': 'error' } })).toThrow(message)
    })

    test('rpk-validate=off silences the warning and still renders plain code', () => {
      const warn = warnings()
      expect(linkOf(convert('rpkcmd:[rpk topic make]', { attributes: { 'rpk-validate': 'off' } }))).toEqual({ plain: 'rpk topic make' })
      expect(warn).not.toHaveBeenCalled()
    })

    test('a missing page is a warning even in error mode', () => {
      const warn = warnings()
      const html = convert('rpkcmd:[rpk cluster partitions move-cancel]', { component: 'cloud-data-platform', version: '', attributes: { 'rpk-validate': 'error' } })
      expect(linkOf(html)).toEqual({ plain: 'rpk cluster partitions move-cancel' })
      expect(warn).toHaveBeenCalledTimes(1)
    })

    test('a placeholder in the command line is escaped once', () => {
      warnings()
      expect(convert('rpkcmd:[rpk topic create <name>]')).toContain('<code>rpk topic create &lt;name&gt;</code>')
    })
  })
})
