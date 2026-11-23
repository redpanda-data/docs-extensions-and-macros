'use strict'

jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

const fs = require('fs')
const path = require('path')
const { register } = require('../../macros/prop')
const operatorFlags = require('../../extension-utils/operator-flags')

const SAMPLE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'operator-flags', 'operator-flags-v26.2.5.json'))

function catalogOf ({ data = true, page = true, attributes = {} } = {}) {
  const files = []
  if (data) files.push({ src: { component: 'streaming', version: '26.2', module: 'reference', family: 'attachment', relative: 'operator-flags-v26.2.5.json' }, contents: SAMPLE })
  if (page) files.push({ src: { component: 'streaming', version: '26.2', module: 'reference', family: 'page', relative: 'k-operator-flags.adoc' } })
  const match = (query) => files.filter((file) => Object.entries(query).every(([key, value]) => file.src[key] === value))
  return {
    findBy: match,
    getById: (id) => match(id)[0],
    getComponent: (name) => ({ name, versions: [{ version: '26.2', asciidoc: { attributes } }], latest: { version: '26.2', asciidoc: { attributes } } }),
  }
}

function convert (input, { catalog = catalogOf(), attributes = {}, version = '26.2' } = {}) {
  const Asciidoctor = require('@asciidoctor/core')()
  const registry = Asciidoctor.Extensions.create()
  register(registry, { contentCatalog: catalog, file: { src: { path: 'modules/manage/pages/example.adoc', component: 'streaming', version, module: 'manage' } } })
  return Asciidoctor.convert(input, { extension_registry: registry, attributes })
}

const warnings = () => jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})

describe('opflag:', () => {
  afterEach(() => jest.restoreAllMocks())

  test('links the flag entry on the reference page of the same version', () => {
    const warn = warnings()
    const html = convert('Set opflag:[--unbind-pvcs-after].')
    expect(html).toContain('<a href="#26.2@streaming:reference:k-operator-flags.adoc#unbind-pvcs-after"')
    expect(html).toContain('<code class="operator-flag" data-operator-flag="unbind-pvcs-after">--unbind-pvcs-after</code>')
    expect(warn).not.toHaveBeenCalled()
  })

  test('keeps a value written after =', () => {
    expect(convert('Pass opflag:[--unbind-pvcs-after=60s].')).toContain('>--unbind-pvcs-after=60s</code>')
  })

  test('accepts a global logging flag', () => {
    expect(convert('opflag:[--log-level]')).toContain('k-operator-flags.adoc#log-level')
  })

  test('an unknown flag warns with the nearest names and renders plain code', () => {
    const warn = warnings()
    const html = convert('opflag:[--unbind-pvc-after]')
    expect(html).toContain('<code>--unbind-pvc-after</code>')
    expect(warn.mock.calls[0][0]).toMatch(/--unbind-pvc-after is not a flag of redpanda-operator run in operator-flags-v26\.2\.5\.json.*Did you mean --unbind-pvcs-after/)
  })

  test('an unknown flag fails the build in error mode', () => {
    expect(() => convert('opflag:[--nope]', { attributes: { 'operator-validate': 'error' } })).toThrow(/--nope is not a flag/)
  })

  test('a deprecated flag warns with its message unless deprecated=ok', () => {
    const warn = warnings()
    convert('opflag:[--allow-pv-rebinding]')
    expect(warn.mock.calls[0][0]).toMatch(/--allow-pv-rebinding is deprecated: the PVCUnbinder's safety checks replace it/)
    warn.mockClear()
    const html = convert('opflag:[--allow-pv-rebinding,deprecated=ok]')
    expect(warn).not.toHaveBeenCalled()
    expect(html).toContain('k-operator-flags.adoc#allow-pv-rebinding')
  })

  test('a hidden flag warns, and renders plain because the reference page leaves it out', () => {
    const warn = warnings()
    const html = convert('opflag:[--unsafe-decommission-failed-brokers]')
    expect(warn.mock.calls[0][0]).toMatch(/hidden from redpanda-operator run --help/)
    expect(html).toContain('<code>--unsafe-decommission-failed-brokers</code>')
  })

  test('no reference page: plain code and a warning', () => {
    const warn = warnings()
    const html = convert('opflag:[--namespace]', { catalog: catalogOf({ page: false }) })
    expect(html).toContain('<code>--namespace</code>')
    expect(warn.mock.calls[0][0]).toMatch(/has no reference:k-operator-flags\.adoc/)
  })

  test('no data for the series: plain code and the dataset warning, never a borrowed release', () => {
    const warn = warnings()
    const html = convert('opflag:[--namespace]', { version: '26.3' })
    expect(html).toContain('<code>--namespace</code>')
    expect(warn).toHaveBeenCalled()
  })
})

describe('opflagval:', () => {
  afterEach(() => jest.restoreAllMocks())

  test.each([
    ['opflagval:[--unbind-pvcs-after]', '0s'],
    ['opflagval:[--unbind-pvcs-after,default]', '0s'],
    ['opflagval:[--unbind-pvcs-after,type]', 'duration'],
    ['opflagval:[--namespace]', '""'],
    ['opflagval:[--log-level]', 'info'],
    ['opflagval:[--cluster-domain,deprecated]', 'no'],
    ['opflagval:[--cluster-domain,deprecated,format=raw]', 'false'],
  ])('%s renders %s', (call, expected) => {
    const warn = warnings()
    const html = convert(call)
    expect(html).toContain(`<code>${expected.replace(/"/g, '&quot;')}</code>`)
    expect(warn).not.toHaveBeenCalled()
  })

  test('description renders the help text as AsciiDoc', () => {
    expect(convert('opflagval:[--cluster-domain,description]')).toContain('Kubernetes cluster domain, as set by the kubelet&#8217;s <code>--cluster-domain</code>')
  })

  test('desc is an alias of description, as in every value macro', () => {
    expect(convert('opflagval:[--cluster-domain,desc]')).toContain('data-field="description"')
  })

  test('an unsupported field lists the supported ones', () => {
    const warn = warnings()
    expect(convert('opflagval:[--namespace,unit]')).toContain('&lt;unknown unit&gt;')
    expect(warn.mock.calls[0][0]).toMatch(/Supported fields: default, type, description, deprecated/)
  })

  test('deprecated on a deprecated flag says yes, and asks for the acknowledgement', () => {
    const warn = warnings()
    expect(convert('opflagval:[--allow-pv-rebinding,deprecated]')).toContain('<code>yes</code>')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockClear()
    convert('opflagval:[--allow-pv-rebinding,deprecated,deprecated=ok]')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('extension-utils/operator-flags', () => {
  test('parseFlagText reads --name, --name=value and a bare name', () => {
    expect(operatorFlags.parseFlagText('--a-b=1')).toMatchObject({ ok: true, name: 'a-b', value: '1', separator: '=' })
    expect(operatorFlags.parseFlagText('a-b')).toMatchObject({ ok: true, name: 'a-b', value: undefined })
    expect(operatorFlags.parseFlagText('--')).toMatchObject({ ok: false })
  })

  test('the kind validates the schema and the flags array', () => {
    const { validate } = operatorFlags.OPERATOR_FLAGS_KIND
    expect(validate(JSON.parse(SAMPLE))).toBe(true)
    expect(validate({ schema: 2, flags: [] })).toMatch(/newer schema/)
    expect(validate({ schema: 1 })).toMatch(/no flags array/)
  })

  test('file names carry the operator version, prereleases included', () => {
    const rx = operatorFlags.OPERATOR_FLAGS_JSON_RX
    expect('operator-flags-v26.2.5.json'.match(rx)[1]).toBe('v26.2.5')
    expect('operator-flags-v26.3.1-beta.1.json'.match(rx)[1]).toBe('v26.3.1-beta.1')
    expect(rx.test('operator-flags-26.2.5.json')).toBe(false)
  })
})
