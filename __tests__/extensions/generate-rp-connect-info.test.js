const fs = require('fs')
const os = require('os')
const path = require('path')

jest.mock('../../cli-utils/octokit-client', () => ({ rest: { repos: { getContent: jest.fn() } } }))

const octokit = require('../../cli-utils/octokit-client')
const catalogUtil = require('../../extensions/util/connect-catalog')
const ext = require('../../extensions/generate-rp-connect-info.js')

const CONNECT_URL = 'https://github.com/redpanda-data/connect'

const CSV = [
  'name,type,commercial_name,support,deprecated,cloud,cloud_with_gpu,cloud_unsupported_reason',
  'http_server,input,http_server,certified,n,y,y,',
  'http_server,output,http_server,certified,n,n,n,requires inbound listener',
  'ollama_chat,processor,ollama_chat,certified,n,n,y,AI build only',
  'jira,input,jira,certified,n,y,n,',
  'timeplus,output,timeplus,certified,n,y,y,',
  'sql_driver_postgres,sql_driver,PostgreSQL,certified,n,y,y,'
].join('\n')

const connectPage = (relative) => {
  const [dir, file] = relative.split('/')
  return {
    src: { component: 'connect', module: 'components', family: 'page', relative, stem: file.replace('.adoc', '') },
    path: `modules/components/pages/${relative}`,
    pub: { url: `/connect/components/${dir}/${file.replace('.adoc', '')}/` },
    out: {},
    asciidoc: { attributes: {} }
  }
}
const cloudPage = (relative) => {
  const [dir, file] = relative.split('/')
  return {
    src: { component: 'cloud-data-platform', module: 'develop', family: 'page', relative: `connect/components/${relative}`, stem: file.replace('.adoc', '') },
    path: `modules/develop/pages/connect/components/${relative}`,
    pub: { url: `/cloud/develop/connect/components/${dir}/${file.replace('.adoc', '')}/` },
    out: {},
    asciidoc: { attributes: {} }
  }
}
const connectPartial = (relative, origin, contents = '') => ({
  src: { component: 'connect', module: 'components', family: 'partial', relative, origin },
  contents: Buffer.from(contents)
})

function makeCatalog (files) {
  const components = ['connect', 'cloud-data-platform'].map((name) => ({ name, latest: { asciidoc: { attributes: {} } } }))
  return {
    components,
    getComponents: () => components,
    getPages: (filter) => files.filter((f) => f.src.family === 'page').filter(filter || (() => true)),
    findBy: (q) => files.filter((f) => Object.entries(q).every(([k, v]) => f.src[k] === v))
  }
}

function run (files, config = {}) {
  const handlers = {}
  const logs = []
  const log = (level) => (msg) => logs.push([level, msg])
  const ctx = {
    getLogger: () => ({ info: log('info'), warn: log('warn'), error: log('error'), debug: () => {} }),
    on: (event, fn) => { handlers[event] = fn }
  }
  ext.register.call(ctx, { config })
  const contentCatalog = makeCatalog(files)
  return Promise.resolve(handlers.contentClassified({ contentCatalog })).then(() => {
    handlers.documentsConverted({ contentCatalog })
    return { contentCatalog, logs, csvData: contentCatalog.components[0].latest.asciidoc.attributes.csvData }
  })
}

let tmp, csvFile, cwd
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-info-'))
  csvFile = path.join(tmp, 'info.csv')
  fs.writeFileSync(csvFile, CSV)
  // No antora.yml in the working directory, so latest-connect-version is unset
  cwd = process.cwd()
  process.chdir(tmp)
  catalogUtil.setResolvedConnectRef(null)
  octokit.rest.repos.getContent.mockReset()
  octokit.rest.repos.getContent.mockResolvedValue({ data: { content: Buffer.from(CSV).toString('base64') } })
})
afterEach(() => {
  process.chdir(cwd)
  fs.rmSync(tmp, { recursive: true, force: true })
  catalogUtil.setResolvedConnectRef(null)
})

// The generated reference a connector page needs: its fields and its
// description meta. The guard requires both.
const referencePartials = (origin) => [
  connectPartial('fields/inputs/http_server.adoc', origin),
  connectPartial('descriptions/inputs/http_server.adoc', origin)
]

describe('sticky-bar availability attributes', () => {
  const pages = () => ({
    httpIn: connectPage('inputs/http_server.adoc'),
    httpOut: connectPage('outputs/http_server.adoc'),
    ollama: connectPage('processors/ollama_chat.adoc'),
    jira: connectPage('inputs/jira.adoc'),
    cloudHttpIn: cloudPage('inputs/http_server.adoc'),
    cloudOllama: cloudPage('processors/ollama_chat.adoc'),
    cloudJira: cloudPage('inputs/jira.adoc')
  })

  it('decides the self-managed-only badge per type, not per connector', async () => {
    const p = pages()
    await run([...Object.values(p), ...referencePartials({ url: CONNECT_URL })], { csvpath: csvFile })
    expect(p.httpOut.asciidoc.attributes['page-self-managed-only']).toBe('true')
    expect(p.httpOut.asciidoc.attributes['page-cloud-available']).toBeUndefined()
    expect(p.httpIn.asciidoc.attributes['page-cloud-available']).toBe('true')
    expect(p.httpIn.asciidoc.attributes['page-self-managed-only']).toBeUndefined()
    // The Type dropdown still lists both types
    expect(JSON.parse(p.httpOut.asciidoc.attributes['page-context-switcher']).map((i) => i.name)).toEqual(['Output', 'Input'])
  })

  it('treats GPU-only components as Cloud-available and flags them', async () => {
    const p = pages()
    await run([...Object.values(p), ...referencePartials({ url: CONNECT_URL })], { csvpath: csvFile })
    const attrs = p.ollama.asciidoc.attributes
    expect(attrs['page-self-managed-only']).toBeUndefined()
    expect(attrs['page-cloud-available']).toBe('true')
    expect(attrs['page-cloud-available-url']).toBe(p.cloudOllama.pub.url)
    expect(attrs['page-cloud-gpu-only']).toBe('true')
    expect(p.cloudOllama.asciidoc.attributes['page-cloud-gpu-only']).toBe('true')
    expect(attrs['page-cloud-no-gpu']).toBeUndefined()
  })

  it('flags components that are not in GPU pipelines', async () => {
    const p = pages()
    await run([...Object.values(p), ...referencePartials({ url: CONNECT_URL })], { csvpath: csvFile })
    expect(p.jira.asciidoc.attributes['page-cloud-no-gpu']).toBe('true')
    expect(p.cloudJira.asciidoc.attributes['page-cloud-no-gpu']).toBe('true')
    expect(p.jira.asciidoc.attributes['page-cloud-gpu-only']).toBeUndefined()
    expect(p.httpIn.asciidoc.attributes['page-cloud-no-gpu']).toBeUndefined()
  })

  it('adds the flags to the translated rows', async () => {
    const { csvData } = await run([...referencePartials({ url: CONNECT_URL })], { csvpath: csvFile })
    const byKey = Object.fromEntries(csvData.data.map((r) => [`${r.connector}:${r.type}`, r]))
    expect(byKey['ollama_chat:processor']).toMatchObject({ is_cloud_supported: 'n', cloud_ai: 'y', gpu_only: 'y', no_gpu: 'n' })
    expect(byKey['jira:input']).toMatchObject({ is_cloud_supported: 'y', cloud_ai: 'n', gpu_only: 'n', no_gpu: 'y' })
  })
})

describe('catalog source', () => {
  const catalogJson = JSON.stringify([
    { type: 'input', name: 'http_server', status: 'stable', version: '', categories: ['Network'], summary: '', cloud: true, cloud_ai: true, cgo_only: false, support: 'certified', commercial_names: ['HTTP Server'] },
    { type: 'output', name: 'kafka', status: 'deprecated', version: '', categories: ['Services'], summary: '', cloud: true, cloud_ai: true, cgo_only: false, support: 'certified', commercial_names: ['Kafka'] },
    { type: 'input', name: 'zmq4', status: 'stable', version: '', categories: [], summary: '', cloud: false, cloud_ai: false, cgo_only: true, support: 'community', commercial_names: [] }
  ])

  it('reads catalog.json from the connect content source and adds only the SQL drivers from info.csv', async () => {
    const files = [
      ...referencePartials({ url: CONNECT_URL, reftype: 'tag', tag: 'v4.200.0' }),
      connectPartial('platforms/catalog.json', { url: CONNECT_URL, reftype: 'tag', tag: 'v4.200.0' }, catalogJson)
    ]
    const { csvData, logs } = await run(files, { csvpath: csvFile })
    const keys = csvData.data.map((r) => `${r.connector}:${r.type}`)
    // The info.csv timeplus row that no binary registers stays out
    expect(keys).toEqual(['http_server:input', 'kafka:output', 'zmq4:input', 'sql_driver_postgres:sql_driver'])
    const kafka = csvData.data[1]
    expect(kafka).toMatchObject({ deprecated: 'y', status: 'deprecated', categories: ['Services'], commercial_name: 'Kafka' })
    expect(csvData.data[2]).toMatchObject({ cgo_only: 'y', is_cloud_supported: 'n' })
    expect(logs.some(([l, m]) => l === 'info' && /Loaded 3 components from connect:components:partial\$platforms\/catalog\.json \(v4\.200\.0\)/.test(m))).toBe(true)
  })

  it('falls back to info.csv when catalog.json is not valid', async () => {
    const files = [...referencePartials({ url: CONNECT_URL }), connectPartial('platforms/catalog.json', { url: CONNECT_URL }, '{"not":"an array"}')]
    const { csvData, logs } = await run(files, { csvpath: csvFile })
    expect(csvData.data.map((r) => r.connector)).toContain('timeplus')
    expect(logs.some(([l, m]) => l === 'warn' && /falling back to info\.csv/.test(m))).toBe(true)
  })

  it('keeps the catalog rows when info.csv cannot be fetched', async () => {
    octokit.rest.repos.getContent.mockRejectedValue(new Error('rate limited'))
    const files = [...referencePartials({ url: CONNECT_URL }), connectPartial('platforms/catalog.json', { url: CONNECT_URL }, catalogJson)]
    const { csvData, logs } = await run(files)
    expect(csvData.data.map((r) => r.connector)).toEqual(['http_server', 'kafka', 'zmq4'])
    expect(logs.some(([l, m]) => l === 'warn' && /SQL driver/.test(m))).toBe(true)
  })

  it('uses every catalog commercial name that differs from the connector name', async () => {
    const files = [
      ...referencePartials({ url: CONNECT_URL }),
      connectPartial('platforms/catalog.json', { url: CONNECT_URL }, JSON.stringify([
        { type: 'input', name: 'kafka', status: 'stable', cloud: true, cloud_ai: true, support: 'certified', commercial_names: ['Kafka', 'Apache Kafka'] }
      ])),
      connectPage('inputs/kafka.adoc')
    ]
    const { contentCatalog } = await run(files, { csvpath: csvFile })
    expect(contentCatalog.components[0].latest.asciidoc.attributes.commercialNamesMap.kafka).toEqual(['Apache Kafka'])
  })
})

describe('info.csv ref', () => {
  const refOf = () => octokit.rest.repos.getContent.mock.calls[0][0]

  it('reads info.csv at the tag modify-connect-tag-playbook resolved', async () => {
    catalogUtil.setResolvedConnectRef('v4.111.1')
    const { logs } = await run([...referencePartials({ url: CONNECT_URL, reftype: 'tag', tag: 'v4.0.0' })])
    expect(refOf()).toMatchObject({ owner: 'redpanda-data', repo: 'connect', path: 'internal/plugins/info.csv', ref: 'v4.111.1' })
    expect(logs.some(([l, m]) => l === 'warn' && /connect main/.test(m))).toBe(false)
  })

  it('falls back to the ref of the connect content source', async () => {
    await run([...referencePartials({ url: CONNECT_URL, reftype: 'tag', refname: 'v4.110.0', tag: 'v4.110.0' })])
    expect(refOf()).toMatchObject({ ref: 'v4.110.0' })
  })

  it('reads a fork from its own repository', async () => {
    await run([...referencePartials({ url: 'https://github.com/someone/connect.git', reftype: 'branch', refname: 'fix', branch: 'fix' })])
    expect(refOf()).toMatchObject({ owner: 'someone', repo: 'connect', ref: 'fix' })
  })

  it('uses latest-connect-version from antora.yml next', async () => {
    fs.writeFileSync(path.join(tmp, 'antora.yml'), 'name: connect\nasciidoc:\n  attributes:\n    latest-connect-version: 4.109.0\n')
    await run([...referencePartials({ url: CONNECT_URL, worktree: '/src/connect', reftype: 'branch', branch: 'wip' })])
    expect(refOf()).toMatchObject({ ref: 'v4.109.0' })
  })

  it('warns when it has to fall back to main', async () => {
    const { logs, csvData } = await run([...referencePartials({ url: CONNECT_URL, worktree: '/src/connect', reftype: 'branch', branch: 'wip' })])
    expect(refOf()).toMatchObject({ ref: 'main' })
    expect(logs.some(([l, m]) => l === 'warn' && /read from connect main/.test(m))).toBe(true)
    expect(csvData.data.length).toBe(6)
  })
})
