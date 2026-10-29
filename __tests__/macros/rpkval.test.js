'use strict'

// Same mocked logger as propval.test.js: the macros log through @antora/logger.
jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

const fs = require('fs')
const path = require('path')
const { register } = require('../../macros/prop')
const { THROW_KINDS } = require('../../macros/rpkval')
const rpkValues = require('../../extension-utils/rpk-values')

// Real data: docs 84bd0514 docs-data/rpk-v26.2.2.json, projected as docs PR
// 2255 publishes it and trimmed (see _source in the file).
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'rpkval')
const SAMPLE = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'rpk-v26.2.2-sample.json'), 'utf8'))
const DECOY = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'rpk-v26.1.12-sample.json'), 'utf8'))
const clone = (value) => JSON.parse(JSON.stringify(value))

function attachment (component, version, tag, data = SAMPLE) {
  return {
    src: { component, version, module: 'reference', family: 'attachment', relative: `rpk-${tag}.json` },
    contents: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)),
  }
}

function catalogOf (files, components = {}) {
  const names = new Set([...files.map((f) => f.src.component), ...Object.keys(components)])
  return {
    findBy: (query) => files.filter((file) => Object.entries(query).every(([key, value]) => file.src[key] === value)),
    getComponent: (name) => {
      if (!names.has(name)) return undefined
      const attributes = components[name] || {}
      const versions = [...new Set(files.filter((f) => f.src.component === name).map((f) => f.src.version))]
        .sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }))
        .map((v) => ({ version: v, asciidoc: { attributes } }))
      if (!versions.length) versions.push({ version: '', asciidoc: { attributes } })
      return { name, versions, latest: versions[versions.length - 1] }
    },
  }
}

function convert (input, { catalog, attributes = {}, component = 'streaming', version = '26.2' } = {}) {
  const Asciidoctor = require('@asciidoctor/core')()
  const registry = Asciidoctor.Extensions.create()
  register(registry, catalog && {
    contentCatalog: catalog,
    file: { src: { path: 'modules/manage/pages/example.adoc', component, version, module: 'manage' } },
  })
  return Asciidoctor.convert(input, { extension_registry: registry, attributes })
}

const spans = (html) => [...html.matchAll(/<span class="rpk-value[^"]*"[^>]*>([\s\S]*?)<\/span>/g)]
  .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
const valueOf = (html) => spans(html)[0]

const warnings = () => jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})

const streaming = (data = SAMPLE) => catalogOf([attachment('streaming', '26.2', 'v26.2.2', data)])
const cloud = (data = SAMPLE) => catalogOf([attachment('streaming', '26.2', 'v26.2.2', data)], { 'cloud-data-platform': { 'env-cloud': true } })
const onCloud = (input, opts = {}) => convert(input, { catalog: cloud(opts.data), component: 'cloud-data-platform', version: '', ...opts })

describe('rpkval macro', () => {
  afterEach(() => jest.restoreAllMocks())

  describe('fields', () => {
    test('renders the default as a span naming the command and flag', () => {
      const html = convert('The default is rpkval:partitions[command=rpk topic create].', { catalog: streaming() })
      expect(html).toContain('<span class="rpk-value" data-rpk-command="rpk topic create" data-rpk-flag="partitions" data-field="default">-1</span>')
      expect(html).not.toContain('data-source')
    })

    test.each([
      ['rpkval:partitions[command=rpk topic create]', '-1'],
      ['rpkval:partitions[default,command=rpk topic create]', '-1'],
      ['rpkval:partitions[shorthand,command=rpk topic create]', '-p'],
      ['rpkval:partitions[short,command=rpk topic create]', '-p'],
      ['rpkval:partitions[type,command=rpk topic create]', 'int32'],
      ['rpkval:partitions[required,command=rpk topic create]', 'no'],
      ['rpkval:partitions[required,command=rpk topic create,format=raw]', 'false'],
      ['rpkval:partitions[deprecated,command=rpk topic create]', 'no'],
      ['rpkval:partitions[deprecated,command=rpk topic create,format=raw]', 'false'],
      ['rpkval:disk-duration-ms[command=rpk cluster self-test start]', '30000'],
      ['rpkval:topic-config[command=rpk topic create]', '[]'],
      ['rpkval:dry[command=rpk topic create]', 'false'],
      ['rpkval:profile[command=rpk cloud cluster select]', '""'],
      ['rpkval:timeout[command=rpk debug bundle]', '1m0s'],
    ])('%s renders %s', (input, expected) => {
      expect(valueOf(convert(input, { catalog: streaming() }))).toBe(expected)
    })

    test('a field written after command= is still the field', () => {
      expect(valueOf(convert('rpkval:partitions[command=rpk topic create,shorthand]', { catalog: streaming() }))).toBe('-p')
    })

    test('a deprecated flag reads yes', () => {
      const data = clone(SAMPLE)
      data.tree.commands.find((c) => c.name === 'topic').commands.find((c) => c.name === 'create').flags.find((f) => f.name === 'dry').deprecated = true
      expect(valueOf(convert('rpkval:dry[deprecated,command=rpk topic create]', { catalog: streaming(data) }))).toBe('yes')
    })
  })

  describe('bracket form: the command line, then the field', () => {
    test.each([
      ['rpkval:[rpk topic create --partitions]', 'rpkval:partitions[command=rpk topic create]', '-1'],
      ['rpkval:[rpk topic create --partitions,default]', 'rpkval:partitions[default,command=rpk topic create]', '-1'],
      ['rpkval:[topic create --partitions,shorthand]', 'rpkval:partitions[shorthand,command=rpk topic create]', '-p'],
      ['rpkval:[rpk topic create --partitions,required,format=raw]', 'rpkval:partitions[required,command=rpk topic create,format=raw]', 'false'],
      ['rpkval:[rpk cluster partitions alter-cancel --node]', 'rpkval:node[command=rpk cluster partitions alter-cancel]', '-1'],
      ['rpkval:[rpk --config-opt,type]', 'rpkval:config-opt[type]', 'stringArray'],
      ['rpkval:[--config-opt,type]', 'rpkval:config-opt[type]', 'stringArray'],
      ['rpkval:[rpk ai auditlog list --since]', 'rpkval:since[command=rpk ai auditlog list]', '24h'],
    ])('%s renders what %s renders', (bracket, named, expected) => {
      const a = convert(`The value is ${bracket}.`, { catalog: streaming() })
      const b = convert(`The value is ${named}.`, { catalog: streaming() })
      expect(valueOf(a)).toBe(expected)
      expect(a).toBe(b)
    })

    test('two bracket calls on one line, in backticks', () => {
      const html = convert('`rpkval:[rpk topic create --partitions]` and `rpkval:[rpk topic create --replicas]`', { catalog: streaming() })
      expect(spans(html)).toEqual(['-1', '-1'])
    })

    test.each([
      ['rpkval:[rpk topic create]', 'unknown-flag', 'rpkval:[rpk topic create] in modules/manage/pages/example.adoc: names no flag; write the command, then the flag, as in rpkval:[rpk topic create --partitions].'],
      ['rpkval:[rpk topic create --partitions 3]', 'unknown-flag', "rpkval:[rpk topic create --partitions 3] in modules/manage/pages/example.adoc: '3' follows --partitions; write the command and one flag, without a value or arguments"],
      ['rpkval:[rpk topic create -p]', 'shorthand-target', 'Write rpkval:[rpk topic create --partitions] instead.'],
      ['rpkval:[rpk registry mode set --schema-context]', 'unknown-flag', 'write rpkval:[rpk registry --schema-context].'],
      ['rpkval:[rpk --partitions]', 'unknown-flag', 'write the command that defines it before the flag'],
      ['rpkval:[rpk topic create my-topic --partitions]', 'unknown-command', 'Write the command path and one flag, without arguments.'],
      ['rpkval:[rpk redpanda admin brokers --x]', 'deprecated-command', "rpkval:[rpk redpanda admin brokers --x] in modules/manage/pages/example.adoc: 'rpk redpanda admin brokers' is deprecated"],
      ['rpkval:[rpk topic create --partitions,colour]', 'unsupported-field', "rpkval:[rpk topic create --partitions,colour] in modules/manage/pages/example.adoc: 'colour' is not a field rpkval: supports."],
    ])('%s is a placeholder (%s) whose message names the bracket call', (input, kind, message) => {
      const warn = warnings()
      const html = convert(input, { catalog: streaming() })
      expect(html).toContain('rpk-value-unknown')
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain(message)
      expect(THROW_KINDS).toContain(kind)
      expect(() => convert(input, { catalog: streaming(), attributes: { 'rpk-validate': 'error' } })).toThrow(message)
    })
  })

  describe('command resolution', () => {
    test.each([
      ['a global flag with no command', 'rpkval:config-opt[type]', 'stringArray', 'rpk'],
      ['command=rpk for a global flag', 'rpkval:config-opt[type,command=rpk]', 'stringArray', 'rpk'],
      ['no leading rpk', 'rpkval:partitions[command=topic create]', '-1', 'rpk topic create'],
      ['a leading -- on the target', 'rpkval:--partitions[command=rpk topic create]', '-1', 'rpk topic create'],
      ['a quoted command', 'rpkval:partitions[command="rpk topic create"]', '-1', 'rpk topic create'],
      ['extra whitespace', 'rpkval:partitions[command=rpk   topic  create]', '-1', 'rpk topic create'],
      ['an alias (cluster status is cluster info)', 'rpkval:format[command=rpk cluster status]', 'text', 'rpk cluster info'],
      ['an alias of a nested command', 'rpkval:node[command=rpk cluster partitions alter-cancel]', '-1', 'rpk cluster partitions move-cancel'],
    ])('%s', (_name, input, expected, command) => {
      const html = convert(input, { catalog: streaming() })
      expect(valueOf(html)).toBe(expected)
      expect(html).toContain(`data-rpk-command="${command}"`)
    })

    test('a command flag wins over a global flag of the same name', () => {
      const registry = rpkValues.loadRpkFor(streaming(), 'streaming', '26.2')
      const result = rpkValues.resolveRpkValue({ registry, command: 'rpk cloud cluster select', flag: 'profile' })
      const select = SAMPLE.tree.commands.find((c) => c.name === 'cloud').commands.find((c) => c.name === 'cluster').commands.find((c) => c.name === 'select')
      expect(result.ok).toBe(true)
      expect(result.flag).toEqual(select.flags.find((f) => f.name === 'profile'))
      expect(result.flag).not.toEqual(SAMPLE.tree.global_flags.find((f) => f.name === 'profile'))
    })

    test('a flag defined on an ancestor is unknown on the child, and the message names the ancestor', () => {
      const warn = warnings()
      const html = convert('rpkval:schema-context[command=rpk registry mode set]', { catalog: streaming() })
      expect(valueOf(html)).toBe('<unknown default>')
      expect(warn.mock.calls[0][0]).toContain('--schema-context is defined on rpk registry; write command=rpk registry')
      expect(valueOf(convert('rpkval:schema-context[command=rpk registry]', { catalog: streaming() }))).toBe('""')
    })

    test('a non-global flag with no command says to add command=', () => {
      const warn = warnings()
      convert('rpkval:partitions[]', { catalog: streaming() })
      expect(warn.mock.calls[0][0]).toContain('It is not a global flag; add command=')
    })
  })

  describe('authoring errors', () => {
    test('a shorthand target is an error that names the long flag', () => {
      const warn = warnings()
      const html = convert('rpkval:p[command=rpk topic create]', { catalog: streaming() })
      expect(valueOf(html)).toBe('<unknown default>')
      expect(warn.mock.calls[0][0]).toContain("is a shorthand; rpkval: targets name the long flag. Write rpkval:partitions[...] instead.")
      expect(() => convert('rpkval:-p[command=rpk topic create]', { catalog: streaming(), attributes: { 'rpk-validate': 'error' } })).toThrow(/shorthand/)
    })

    test('a deprecated command carries its replacement', () => {
      const warn = warnings()
      convert('rpkval:x[command=rpk redpanda admin brokers]', { catalog: streaming() })
      expect(warn.mock.calls[0][0]).toContain("'rpk redpanda admin brokers' is deprecated")
      expect(warn.mock.calls[0][0]).toContain('`rpk cluster`')
    })

    test('an unknown command suggests the real one (docs continuous-data-balancing.adoc:101)', () => {
      const warn = warnings()
      convert('rpkval:node[command=rpk cluster partitions movement-cancel]', { catalog: streaming() })
      expect(warn.mock.calls[0][0]).toContain('Did you mean: move-cancel?')
    })

    test('command= with an argument is an unknown command that says why', () => {
      const warn = warnings()
      convert('rpkval:partitions[command=rpk topic create my-topic]', { catalog: streaming() })
      expect(warn.mock.calls[0][0]).toContain('command= takes the command path only')
    })

    test('an unsupported field', () => {
      const warn = warnings()
      expect(valueOf(convert('rpkval:partitions[colour,command=rpk topic create]', { catalog: streaming() }))).toBe('<unknown colour>')
      expect(warn.mock.calls[0][0]).toContain("'colour' is not a field rpkval: supports")
    })
  })

  describe('placeholders', () => {
    test.each([
      ['a null default (rpk transform deploy --var)', 'rpkval:var[command=rpk transform deploy]', 'has no default'],
      ['an empty default whose description states one (rpk debug bundle --output)', 'rpkval:output[command=rpk debug bundle]', 'its description states the real one'],
      ['a plugin flag help gives no default for (rpk ai agent credential create --ttl)', 'rpkval:ttl[command=rpk ai agent credential create]', "comes from the ai plugin's --help"],
      ['a plugin flag help gives no required for', 'rpkval:ttl[required,command=rpk ai agent credential create]', "comes from the ai plugin's --help"],
      ['a missing shorthand', 'rpkval:if-not-exists[shorthand,command=rpk topic create]', 'has no shorthand'],
    ])('%s', (_name, input, message) => {
      const warn = warnings()
      const html = convert(input, { catalog: streaming() })
      expect(html).toContain('rpk-value-unknown')
      expect(valueOf(html)).toMatch(/^<unknown /)
      expect(warn.mock.calls[0][0]).toContain(message)
    })

    test('a scraped plugin default renders without help quotes and is marked as from help', () => {
      const html = convert('The window defaults to rpkval:since[command=rpk ai auditlog list].', { catalog: streaming() })
      expect(valueOf(html)).toBe('24h')
      expect(html).toContain('data-source="help"')
    })

    test('a plugin flag the tree marks from_plugin is not scraped', () => {
      const data = clone(SAMPLE)
      const search = data.tree.commands.find((c) => c.name === 'ai').commands.find((c) => c.name === 'docs').commands.find((c) => c.name === 'search')
      expect(valueOf(convert('rpkval:limit[command=rpk ai docs search]', { catalog: streaming() }))).toBe('20')
      expect(convert('rpkval:limit[command=rpk ai docs search]', { catalog: streaming() })).toContain('data-source="help"')
      search.flags.find((f) => f.name === 'limit').from_plugin = true
      // Help's string "20" is then the stored value as written.
      expect(convert('rpkval:limit[command=rpk ai docs search]', { catalog: streaming(data) })).not.toContain('data-source')
    })

    test('plugin_flag_sources tree marks a whole plugin as not scraped', () => {
      const data = clone(SAMPLE)
      data.plugin_flag_sources = { ai: 'tree' }
      expect(convert('rpkval:since[command=rpk ai auditlog list]', { catalog: streaming(data) })).not.toContain('data-source')
    })
  })

  describe('Cloud', () => {
    test('a selfHostedOnly command is unavailable', () => {
      const warn = warnings()
      expect(valueOf(onCloud('rpkval:verbose[command=rpk cluster brokers]'))).toBe('<unknown default>')
      expect(warn.mock.calls[0][0]).toContain('is self-managed only')
      // Self-managed renders it.
      expect(valueOf(convert('rpkval:verbose[command=rpk cluster brokers]', { catalog: streaming() }))).toBe('false')
    })

    test('descriptionScope self-hosted hides the default on Cloud only, other fields still render', () => {
      warnings()
      expect(valueOf(onCloud('rpkval:force[command=rpk shadow delete]'))).toBe('<unknown default>')
      expect(valueOf(onCloud('rpkval:force[type,command=rpk shadow delete]'))).toBe('bool')
      expect(valueOf(convert('rpkval:force[command=rpk shadow delete]', { catalog: streaming() }))).toBe('false')
    })

    test('platforms and linux_only_commands are not gated', () => {
      expect(valueOf(onCloud('rpkval:timeout[command=rpk redpanda start]'))).toBe('10s')
    })

    test('a Cloud page never borrows a prerelease', () => {
      const warn = warnings()
      const catalog = catalogOf([attachment('streaming', '26.3', 'v26.3.1-rc1')], { 'cloud-data-platform': { 'env-cloud': true } })
      expect(valueOf(convert('rpkval:partitions[command=rpk topic create]', { catalog, component: 'cloud-data-platform', version: '' }))).toBe('<unknown default>')
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain('found only prerelease rpk data')
    })

    test('an Agentic Data Plane page (env-adp) reads the streaming lender', () => {
      const catalog = catalogOf([attachment('streaming', '26.2', 'v26.2.2')], { 'agentic-data-plane': { 'env-adp': true } })
      expect(valueOf(convert('rpkval:since[command=rpk ai auditlog list]', { catalog, component: 'agentic-data-plane', version: '' }))).toBe('24h')
    })

    test('a cloudOnly flag is unavailable on a self-managed page', () => {
      const data = clone(SAMPLE)
      data.tree.commands.find((c) => c.name === 'topic').commands.find((c) => c.name === 'create').flags.find((f) => f.name === 'dry').cloudOnly = true
      warnings()
      expect(valueOf(convert('rpkval:dry[command=rpk topic create]', { catalog: streaming(data) }))).toBe('<unknown default>')
      expect(valueOf(onCloud('rpkval:dry[command=rpk topic create]', { data }))).toBe('false')
    })
  })

  describe('dataset selection', () => {
    test('a page reads its own series, never the previous one', () => {
      const catalog = catalogOf([attachment('streaming', '26.2', 'v26.1.12', DECOY), attachment('streaming', '26.2', 'v26.2.2')])
      expect(rpkValues.loadRpkFor(catalog, 'streaming', '26.2').tag).toBe('v26.2.2')
    })

    test('a beta page with no file for its series gets a placeholder and the series warning, never 26.2 data', () => {
      const warn = warnings()
      const catalog = catalogOf([attachment('streaming', '26.3', 'v26.2.2')])
      expect(valueOf(convert('rpkval:partitions[command=rpk topic create]', { catalog, version: '26.3' }))).toBe('<unknown default>')
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain('streaming@26.3 publishes no rpk-v26.3.*.json attachment in its reference module')
    })

    test('a component with no data gets a placeholder and the no-data warning', () => {
      const warn = warnings()
      const catalog = catalogOf([attachment('streaming', '26.2', 'v26.2.2')], { connect: {} })
      expect(valueOf(convert('rpkval:partitions[command=rpk topic create]', { catalog, component: 'connect', version: '' }))).toBe('<unknown default>')
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain('no rpk-<version>.json attachment found')
    })
  })

  describe('validation modes', () => {
    test('off silences rendered-value warnings but still reports a placeholder', () => {
      const warn = warnings()
      convert('rpkval:partitions[command=rpk topic create,format=weird]', { catalog: streaming(), attributes: { 'rpk-validate': 'off' } })
      expect(warn).not.toHaveBeenCalled()
      convert('rpkval:nope[command=rpk topic create]', { catalog: streaming(), attributes: { 'rpk-validate': 'off' } })
      expect(warn).toHaveBeenCalledTimes(1)
    })

    test('warn logs and renders the placeholder', () => {
      const warn = warnings()
      expect(valueOf(convert('rpkval:nope[command=rpk topic create]', { catalog: streaming() }))).toBe('<unknown default>')
      expect(warn).toHaveBeenCalledTimes(1)
    })

    const mutated = () => {
      const data = clone(SAMPLE)
      const create = data.tree.commands.find((c) => c.name === 'topic').commands.find((c) => c.name === 'create')
      create.flags.find((f) => f.name === 'partitions').default = 2 ** 64
      create.flags.find((f) => f.name === 'dry').default = { a: 1 }
      delete create.flags.find((f) => f.name === 'replicas').type
      return data
    }
    const throwing = {
      'unknown-command': ['rpkval:partitions[command=rpk topic make]'],
      'unknown-flag': ['rpkval:nope[command=rpk topic create]'],
      'shorthand-target': ['rpkval:p[command=rpk topic create]'],
      'deprecated-command': ['rpkval:x[command=rpk redpanda admin brokers]'],
      'missing-field': ['rpkval:replicas[type,command=rpk topic create]', { data: mutated() }],
      'unsupported-field': ['rpkval:partitions[colour,command=rpk topic create]'],
      'cloud-hidden': ['rpkval:force[command=rpk shadow delete]', { cloud: true }],
      unavailable: ['rpkval:verbose[command=rpk cluster brokers]', { cloud: true }],
    }
    test('the throw list is exactly the authoring errors and Cloud gates', () => {
      expect([...THROW_KINDS].sort()).toEqual(Object.keys(throwing).sort())
    })
    test.each(Object.entries(throwing))('error mode throws for %s', (kind, [input, opts = {}]) => {
      const attributes = { 'rpk-validate': 'error' }
      const run = () => opts.cloud
        ? onCloud(input, { attributes })
        : convert(input, { catalog: streaming(opts.data), attributes })
      expect(run).toThrow()
      const registry = opts.cloud
        ? rpkValues.loadRpkFor(cloud(), 'cloud-data-platform', '')
        : rpkValues.loadRpkFor(streaming(opts.data), 'streaming', '26.2')
      const m = input.match(/^rpkval:([^[]+)\[([^\]]*)\]$/)
      const attrs = m[2].split(',')
      const field = attrs[0].startsWith('command=') ? 'default' : attrs[0]
      const command = (attrs.find((a) => a.startsWith('command=')) || '').slice('command='.length)
      expect(rpkValues.resolveRpkValue({ registry, flag: m[1], field, command }).kind).toBe(kind)
    })
    test.each([
      ['no-data', 'rpkval:partitions[command=rpk topic create]', { catalog: catalogOf([], { connect: {} }), component: 'connect', version: '' }],
      ['imprecise', 'rpkval:partitions[command=rpk topic create]', { data: true }],
      ['description-default', 'rpkval:output[command=rpk debug bundle]', {}],
      ['complex-default', 'rpkval:dry[command=rpk topic create]', { data: true }],
      ['plugin-unknown', 'rpkval:ttl[command=rpk ai agent credential create]', {}],
    ])('error mode never throws for the data gap %s', (kind, input, opts) => {
      const warn = warnings()
      const catalog = opts.catalog || streaming(opts.data ? mutated() : SAMPLE)
      expect(() => convert(input, { catalog, component: opts.component, version: opts.version, attributes: { 'rpk-validate': 'error' } })).not.toThrow()
      expect(warn).toHaveBeenCalled()
      if (!opts.catalog) {
        const registry = rpkValues.loadRpkFor(catalog, 'streaming', '26.2')
        const m = input.match(/^rpkval:([^[]+)\[command=([^\]]*)\]$/)
        expect(rpkValues.resolveRpkValue({ registry, flag: m[1], command: m[2] }).kind).toBe(kind)
      }
    })
  })

  describe('robustness', () => {
    test('two macros on one line, and inside backticks', () => {
      const html = convert('Use `rpkval:partitions[shorthand,command=rpk topic create]` or rpkval:replicas[shorthand,command=rpk topic create] for short.', { catalog: streaming() })
      expect(spans(html)).toEqual(['-p', '-r'])
      expect(html).toMatch(/<code><span class="rpk-value"[^>]*>-p<\/span><\/code>/)
    })

    test.each(['toString', 'constructor', '__proto__'])('%s is never a flag or a command', (name) => {
      warnings()
      expect(valueOf(convert(`rpkval:${name}[command=rpk topic create]`, { catalog: streaming() }))).toBe('<unknown default>')
      expect(valueOf(convert(`rpkval:partitions[command=rpk ${name}]`, { catalog: streaming() }))).toBe('<unknown default>')
      expect(valueOf(convert(`rpkval:${name}[]`, { catalog: streaming() }))).toBe('<unknown default>')
    })

    test('an unsupported format warns and falls back to human', () => {
      const warn = warnings()
      expect(valueOf(convert('rpkval:partitions[required,command=rpk topic create,format=json]', { catalog: streaming() }))).toBe('no')
      expect(warn.mock.calls[0][0]).toContain('format=json is not supported')
    })

    test('escapes interpolated attributes', () => {
      warnings()
      const html = convert('rpkval:a"b[command=rpk topic create]', { catalog: streaming() })
      expect(html).not.toContain('a"b"')
    })
  })

  describe('agreement with rpk --help (redpandadata/redpanda:v26.2.2)', () => {
    // Parse "Flags:" and "Global Flags:" entries: a flag line, then its
    // wrapped description lines, joined.
    const parseHelp = (text) => {
      const entries = []
      let current
      for (const line of text.split('\n')) {
        const m = line.match(/^\s{2,}(?:-(\w), )?--([\w.-]+)(?:\s+(\S+))?(?:\s{2,}(.*))?$/)
        if (m && /^\s{2,}(?:-\w, )?--/.test(line)) {
          current = { name: m[2], text: m[4] || '' }
          entries.push(current)
        } else if (current && /^\s{8,}\S/.test(line)) {
          current.text += ` ${line.trim()}`
        } else {
          current = undefined
        }
      }
      return entries
    }
    const files = fs.readdirSync(path.join(FIXTURES, 'help')).filter((f) => f.endsWith('.txt'))
    const cases = []
    for (const file of files) {
      const text = fs.readFileSync(path.join(FIXTURES, 'help', file), 'utf8')
      const command = text.split('\n')[0].match(/redpanda:v26\.2\.2 (.*) --help$/)[1]
      for (const entry of parseHelp(text)) {
        if (['help', 'version', 'print-tree'].includes(entry.name)) continue
        cases.push([`rpk ${command} --${entry.name}`, command, entry])
      }
    }

    test('the help files were captured from the released image', () => {
      expect(files.sort()).toEqual(['cluster-config-status.txt', 'cluster-self-test-start.txt', 'security-acl-list.txt', 'topic-create.txt'])
      expect(cases.length).toBeGreaterThan(30)
    })

    test.each(cases)('%s', (_name, command, entry) => {
      const registry = rpkValues.loadRpkFor(streaming(), 'streaming', '26.2')
      const result = rpkValues.resolveRpkValue({ registry, command: `rpk ${command}`, flag: entry.name })
      const help = entry.text.match(/\(default (.*)\)\s*$/)
      if (help) {
        expect(result.ok).toBe(true)
        expect(result.text).toBe(help[1].replace(/^"(.*)"$/, '$1'))
      } else {
        // pflag prints no (default ...) for a zero value.
        expect(result.ok).toBe(true)
        expect(['""', 'false', '0', '[]']).toContain(result.text)
      }
    })
  })
})
