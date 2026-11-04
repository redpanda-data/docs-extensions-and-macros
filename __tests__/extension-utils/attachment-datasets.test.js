'use strict'

jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

const fs = require('fs')
const path = require('path')
const datasets = require('../../extension-utils/attachment-datasets')
const { PROPERTIES_KIND, loadPropertiesFor, describeDataset: describeProperties } = require('../../macros/prop')
const { RPK_KIND, loadRpkFor } = require('../../extension-utils/rpk-values')
const { CONNECT_KIND, loadConnect } = require('../../extension-utils/connect-values')

const FIXTURES = path.join(__dirname, '..', 'fixtures')
const PROPS = fs.readFileSync(path.join(FIXTURES, 'propval', 'redpanda-properties-v26.2.4-sample.json'), 'utf8')
const RPK = fs.readFileSync(path.join(FIXTURES, 'rpkval', 'rpk-v26.2.2-sample.json'), 'utf8')
const CONNECT = fs.readFileSync(path.join(FIXTURES, 'connectval', 'connect-4.114.0-sample.json'), 'utf8')

const file = (component, version, module, relative, contents) => ({
  src: { component, version, module, family: 'attachment', relative },
  contents: Buffer.from(contents),
})
const props = (component, version, tag, contents = PROPS) => file(component, version, 'reference', `redpanda-properties-${tag}.json`, contents)
const rpk = (component, version, tag, contents = RPK) => file(component, version, 'reference', `rpk-${tag}.json`, contents)
const connect = (tag, contents = CONNECT) => file('connect', '', 'components', `connect-${tag}.json`, contents)

function catalogOf (files, components = {}) {
  const names = new Set([...files.map((f) => f.src.component), ...Object.keys(components)])
  return {
    findBy: (query) => files.filter((f) => Object.entries(query).every(([key, value]) => f.src[key] === value)),
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

const warnings = () => jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})

describe('attachment-datasets', () => {
  afterEach(() => jest.restoreAllMocks())

  test('discovery finds each kind by module and file name only', () => {
    const catalog = catalogOf([
      props('streaming', '26.2', 'v26.2.4'),
      rpk('streaming', '26.2', 'v26.2.2'),
      rpk('streaming', '26.2', 'vlocal'),
      connect('4.114.0'),
      file('connect', '', 'reference', 'connect-4.113.0.json', CONNECT),
      file('streaming', '26.2', 'ROOT', 'rpk-v26.2.1.json', RPK),
    ])
    expect(datasets.datasetsMatching(catalog, PROPERTIES_KIND).map((d) => d.tag)).toEqual(['v26.2.4'])
    expect(datasets.datasetsMatching(catalog, RPK_KIND).map((d) => d.tag)).toEqual(['v26.2.2'])
    expect(datasets.datasetsMatching(catalog, CONNECT_KIND).map((d) => d.tag)).toEqual(['4.114.0'])
  })

  describe('rpk series rule', () => {
    test('main reads its own series and never the previous series decoy', () => {
      const catalog = catalogOf([rpk('streaming', '26.2', 'v26.1.12'), rpk('streaming', '26.2', 'v26.2.2')])
      expect(loadRpkFor(catalog, 'streaming', '26.2').tag).toBe('v26.2.2')
      const only = catalogOf([rpk('streaming', '26.2', 'v26.1.12')])
      expect(loadRpkFor(only, 'streaming', '26.2')).toBeUndefined()
    })

    test('a beta branch with no file of its series gets nothing and records a series gap', () => {
      const warn = warnings()
      const catalog = catalogOf([rpk('streaming', '26.3', 'v26.2.2')])
      expect(loadRpkFor(catalog, 'streaming', '26.3')).toBeUndefined()
      datasets.warnDatasetMissing(catalog, 'streaming', '26.3', RPK_KIND)
      expect(warn.mock.calls[0][0]).toBe(
        'rpkval macro: streaming@26.3 publishes no rpk-v26.3.*.json attachment in its reference module (found for other series: v26.2.2). ' +
        "rpkval: values on 26.3 pages therefore render as placeholders, rather than being checked against another release's commands. " +
        'Generate it with the docs rpk workflows (update-rpk-docs.yml) for v26.3.<patch> on that branch, or leave rpkval: out of 26.3 content.')
    })

    test('a GA beats its own RC, and the newest RC wins before GA', () => {
      expect(loadRpkFor(catalogOf([rpk('streaming', '26.3', 'v26.3.1-rc1'), rpk('streaming', '26.3', 'v26.3.1')]), 'streaming', '26.3').tag).toBe('v26.3.1')
      expect(loadRpkFor(catalogOf([rpk('streaming', '26.3', 'v26.3.1-rc2'), rpk('streaming', '26.3', 'v26.3.1-rc10')]), 'streaming', '26.3').tag).toBe('v26.3.1-rc10')
    })
  })

  describe('borrowing', () => {
    test('Cloud and ADP pages borrow GA rpk data from streaming', () => {
      const catalog = catalogOf([rpk('streaming', '26.2', 'v26.2.2'), rpk('streaming', '26.3', 'v26.3.1-rc1')], {
        'cloud-data-platform': { 'env-cloud': true },
        'agentic-data-plane': { 'env-adp': true },
      })
      for (const component of ['cloud-data-platform', 'agentic-data-plane']) {
        const registry = loadRpkFor(catalog, component, '')
        expect(registry.tag).toBe('v26.2.2')
        expect(registry.surface).toBe('cloud')
      }
    })

    test('env-adp borrows for rpk only: properties on an ADP page get nothing', () => {
      const catalog = catalogOf([props('streaming', '26.2', 'v26.2.4'), rpk('streaming', '26.2', 'v26.2.2')], { 'agentic-data-plane': { 'env-adp': true } })
      expect(loadPropertiesFor(catalog, 'agentic-data-plane', '')).toBeUndefined()
      expect(loadRpkFor(catalog, 'agentic-data-plane', '')).toBeDefined()
    })

    test('env-adp: false does not borrow', () => {
      const catalog = catalogOf([rpk('streaming', '26.2', 'v26.2.2')], { 'agentic-data-plane': { 'env-adp': false } })
      expect(loadRpkFor(catalog, 'agentic-data-plane', '')).toBeUndefined()
    })
  })

  describe('Connect', () => {
    test('ignores the page version: streaming and Cloud pages pick the newest connect file', () => {
      const newer = JSON.parse(CONNECT)
      newer.version = '4.115.1'
      const catalog = catalogOf([connect('4.114.0'), connect('4.115.1', JSON.stringify(newer))], { streaming: {}, 'cloud-data-platform': { 'env-cloud': true } })
      expect(loadConnect(catalog).tag).toBe('4.115.1')
      expect(datasets.describeDataset(loadConnect(catalog))).toBe('connect-4.115.1.json from connect@unversioned')
    })

    test('no connect component gives nothing', () => {
      expect(loadConnect(catalogOf([], { streaming: {} }))).toBeUndefined()
    })
  })

  describe('corrupt files', () => {
    test('fall back within the kind and series, naming the file', () => {
      const warn = warnings()
      const catalog = catalogOf([rpk('streaming', '26.2', 'v26.2.2', '{not json'), rpk('streaming', '26.2', 'v26.2.1'), rpk('streaming', '26.2', 'v26.1.12')])
      expect(loadRpkFor(catalog, 'streaming', '26.2').tag).toBe('v26.2.1')
      expect(warn.mock.calls[0][0]).toMatch(/^rpkval macro: rpk-v26\.2\.2\.json in streaming@26\.2 is not valid JSON/)
    })

    test('every candidate unusable records an unusable gap', () => {
      const warn = warnings()
      const catalog = catalogOf([connect('4.114.0', '[]')])
      expect(loadConnect(catalog)).toBeUndefined()
      datasets.warnDatasetMissing(catalog, 'connect', '', CONNECT_KIND)
      expect(warn.mock.calls.map((c) => c[0])).toEqual([
        "connectval macro: connect-4.114.0.json in connect@unversioned is not a JSON object, so it is ignored. Regenerate it with 'npx doc-tools generate rpcn-connector-docs'.",
        'connectval macro: every Connect attachment for connect@ is unusable (4.114.0); see the per-file warning above for why. ' +
        "connectval: values therefore render as placeholders. Regenerate the file with 'npx doc-tools generate rpcn-connector-docs' rather than treating this as missing data.",
      ])
    })
  })

  test('caches do not collide across kinds on one catalog', () => {
    const catalog = catalogOf([props('streaming', '26.2', 'v26.2.4'), rpk('streaming', '26.2', 'v26.2.2')])
    const p = loadPropertiesFor(catalog, 'streaming', '26.2')
    const r = loadRpkFor(catalog, 'streaming', '26.2')
    expect(p.tag).toBe('v26.2.4')
    expect(r.tag).toBe('v26.2.2')
    expect(loadPropertiesFor(catalog, 'streaming', '26.2')).toBe(p)
    expect(loadRpkFor(catalog, 'streaming', '26.2')).toBe(r)
    expect(p.properties).toBe(p.data.properties)
  })

  test('warnOnce is namespaced by key and resets per catalog', () => {
    const warn = warnings()
    const a = catalogOf([])
    const b = catalogOf([])
    const logger = require('@antora/logger')()
    expect(datasets.warnOnce(a, 'rpk:nodata:x@', 'one', logger)).toBe(true)
    expect(datasets.warnOnce(a, 'rpk:nodata:x@', 'one', logger)).toBe(false)
    expect(datasets.warnOnce(a, 'connect:nodata:x@', 'two', logger)).toBe(true)
    expect(datasets.warnOnce(b, 'rpk:nodata:x@', 'one', logger)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(3)
  })

  describe('properties wording is unchanged', () => {
    test('describeDataset', () => {
      const catalog = catalogOf([props('streaming', '26.2', 'v26.2.4')])
      expect(describeProperties(loadPropertiesFor(catalog, 'streaming', '26.2'))).toBe('redpanda-properties-v26.2.4.json from streaming@26.2')
      expect(describeProperties({ tag: 'v1.0.0' })).toBe('redpanda-properties-v1.0.0.json from unknown component')
    })

    // The strings prop: printed on origin/main 328a2e4, copied verbatim.
    test.each([
      ['series', [props('streaming', '25.3', 'v25.2.1')], 'streaming', '25.3', {},
        "prop macro: streaming@25.3 publishes no redpanda-properties-v25.3.*.json attachment in its reference module (found for other series: v25.2.1). prop: targets on 25.3 pages are therefore not validated and their tooltips carry no data, rather than being checked against another release's properties. Generate it with 'npx doc-tools generate property-docs --tag v25.3.<patch>' on that branch, or leave prop: out of 25.3 content."],
      ['cloud-prerelease-only', [props('streaming', '26.3', 'v26.3.1-rc1')], 'cloud-data-platform', '', { 'cloud-data-platform': { 'env-cloud': true } },
        'prop macro: cloud-data-platform found only prerelease property data (v26.3.1-rc1). Cloud runs released Redpanda, so it uses GA property data and will not validate against a release candidate. prop: targets on Cloud pages are therefore not validated and their tooltips carry no data. Include a GA self-managed branch in the build, or leave prop: out of Cloud content until the release ships.'],
      ['unusable', [props('streaming', '26.2', 'v26.2.4', '{"properties": []}')], 'streaming', '26.2', {},
        "prop macro: every property attachment for streaming@26.2 is unusable (v26.2.4); see the per-file warning above for why. prop: targets are therefore not validated and their tooltips carry no data. Regenerate the file with 'npx doc-tools generate property-docs' rather than treating this as missing data."],
      ['nodata', [], 'connect', '', { connect: {} },
        "prop macro: no redpanda-properties-<tag>.json attachment found in any component's reference module for connect@unversioned; prop: targets are not validated and their tooltips carry no data. Publish the property JSON as a reference-module attachment in this component or in streaming."],
    ])('%s', (_kind, files, component, version, components, expected) => {
      const warn = warnings()
      const catalog = catalogOf(files, components)
      expect(loadPropertiesFor(catalog, component, version)).toBeUndefined()
      datasets.warnDatasetMissing(catalog, component, version, PROPERTIES_KIND)
      expect(warn.mock.calls[warn.mock.calls.length - 1][0]).toBe(expected)
    })

    test('the per-file messages', () => {
      const warn = warnings()
      loadPropertiesFor(catalogOf([props('streaming', '26.2', 'v26.2.4', '[]')]), 'streaming', '26.2')
      expect(warn.mock.calls[0][0]).toBe("prop macro: redpanda-properties-v26.2.4.json in streaming@26.2 has no usable 'properties' object, so it is ignored. Regenerate it with 'npx doc-tools generate property-docs'.")
    })
  })

  describe('rpk validate', () => {
    test('accepts the raw docs-data snapshot, which has no schema key', () => {
      const raw = JSON.parse(RPK)
      delete raw.schema
      raw.raw_tree = { name: 'rpk', commands: [] }
      expect(RPK_KIND.validate(raw)).toBe(true)
    })

    test('rejects a newer schema and a tree without commands', () => {
      expect(RPK_KIND.validate({ schema: 2, tree: { commands: [] } })).toBe('has schema 2, a newer schema than this DEM understands')
      expect(RPK_KIND.validate({ schema: 1, tree: {} })).toBe('has no tree.commands array')
    })
  })

  test('suggest uses shared prefixes, then edit distance', () => {
    expect(datasets.suggest('movement-cancel', ['move-cancel', 'move', 'list'])).toEqual(['move-cancel'])
    expect(datasets.suggest('partiton', ['partitions', 'replicas'])).toEqual(['partitions'])
    expect(datasets.suggest('zzz', ['partitions'])).toEqual([])
  })
})
