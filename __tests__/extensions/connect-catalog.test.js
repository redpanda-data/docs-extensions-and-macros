const { describe, it, expect } = require('@jest/globals')
const util = require('../../extensions/util/connect-catalog')

const connectUrl = 'https://github.com/redpanda-data/connect'
const catalog = (files) => ({
  findBy: (q) => files.filter((f) => Object.entries(q).every(([k, v]) => f.src[k] === v))
})
const partial = (relative, origin, contents = '') => ({
  src: { component: 'connect', module: 'components', family: 'partial', relative, origin },
  contents: Buffer.from(contents)
})

describe('connect-catalog util', () => {
  it('shares the resolved connect ref and clears it', () => {
    util.setResolvedConnectRef('v4.111.1')
    expect(util.getResolvedConnectRef()).toBe('v4.111.1')
    util.setResolvedConnectRef(null)
    expect(util.getResolvedConnectRef()).toBeNull()
  })

  it('reads the tag of the connect content source', () => {
    const files = [partial('fields/inputs/kafka.adoc', { url: connectUrl, reftype: 'tag', refname: 'v4.110.0', tag: 'v4.110.0' })]
    expect(util.connectOriginRef(catalog(files))).toEqual({ ref: 'v4.110.0', owner: 'redpanda-data', repo: 'connect' })
  })

  it('reads the owner and branch of a remote fork, but not a local clone branch', () => {
    const fork = [partial('fields/inputs/kafka.adoc', { url: 'https://github.com/someone/connect.git', reftype: 'branch', refname: 'docs-fix', branch: 'docs-fix' })]
    expect(util.connectOriginRef(catalog(fork))).toEqual({ ref: 'docs-fix', owner: 'someone', repo: 'connect' })
    const local = [partial('fields/inputs/kafka.adoc', { url: connectUrl, worktree: '/src/connect', reftype: 'branch', refname: 'wip', branch: 'wip' })]
    expect(util.connectOriginRef(catalog(local))).toBeNull()
  })

  it('ignores content from other sources', () => {
    const files = [partial('fields/inputs/kafka.adoc', { url: 'https://github.com/redpanda-data/rp-connect-docs', reftype: 'branch', branch: 'main' })]
    expect(util.connectOriginRef(catalog(files))).toBeNull()
  })

  it('prefers the catalog.json from the connect source', () => {
    const other = partial('platforms/catalog.json', { url: 'https://github.com/redpanda-data/rp-connect-docs' })
    const fromConnect = partial('platforms/catalog.json', { url: connectUrl, tag: 'v4.112.0' })
    expect(util.findConnectCatalogFile(catalog([other, fromConnect]))).toBe(fromConnect)
    expect(util.findConnectCatalogFile(catalog([other]))).toBe(other)
    expect(util.findConnectCatalogFile(catalog([partial('fields/inputs/kafka.adoc', {})]))).toBeNull()
  })

  it('maps page directories to data types', () => {
    expect(util.typeFromRelative('inputs/kafka.adoc')).toBe('input')
    expect(util.typeFromRelative('rate_limits/local.adoc')).toBe('rate_limit')
    expect(util.typeFromRelative('metrics/prometheus.adoc')).toBe('metric')
    expect(util.typeFromRelative('develop/connect/components/caches/sql.adoc')).toBe('cache')
    expect(util.typeFromRelative('about.adoc')).toBeNull()
    expect(util.typeFromRelative('guides/kafka.adoc')).toBeNull()
    expect(util.normalizeType('metrics')).toBe('metric')
    expect(util.normalizeType('input')).toBe('input')
  })

  it('converts catalog.json entries into info.csv shaped rows', () => {
    const rows = util.catalogEntriesToCsvRows([
      { type: 'output', name: 'kafka', status: 'deprecated', version: '', categories: ['Services'], summary: 's', cloud: true, cloud_ai: true, cgo_only: false, support: 'certified', commercial_names: ['Kafka', 'Apache Kafka'] },
      { type: 'processor', name: 'ollama_chat', status: 'stable', cloud: false, cloud_ai: true, support: 'certified', commercial_names: [] }
    ])
    expect(rows[0]).toMatchObject({ name: 'kafka', type: 'output', commercial_name: 'Kafka', commercial_names: ['Kafka', 'Apache Kafka'], deprecated: 'y', cloud: 'y', cloud_with_gpu: 'y', cgo_only: 'n', categories: ['Services'] })
    expect(rows[1]).toMatchObject({ commercial_name: 'ollama_chat', deprecated: 'n', cloud: 'n', cloud_with_gpu: 'y' })
    expect(() => util.catalogEntriesToCsvRows({})).toThrow(/not a JSON array/)
  })

  it('treats either Cloud pipeline flavor as Cloud-available and flags the difference', () => {
    expect(util.isCloudAvailable({ is_cloud_supported: 'n', cloud_ai: 'y' })).toBe(true)
    expect(util.isCloudAvailable({ is_cloud_supported: 'y', cloud_ai: 'n' })).toBe(true)
    expect(util.isCloudAvailable({ is_cloud_supported: 'n', cloud_ai: 'n' })).toBe(false)
    expect(util.gpuFlags('n', 'y')).toEqual({ gpu_only: 'y', no_gpu: 'n' })
    expect(util.gpuFlags('y', 'n')).toEqual({ gpu_only: 'n', no_gpu: 'y' })
    expect(util.gpuFlags('y', 'y')).toEqual({ gpu_only: 'n', no_gpu: 'n' })
  })
})
