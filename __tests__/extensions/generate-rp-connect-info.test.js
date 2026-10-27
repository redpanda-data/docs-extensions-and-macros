'use strict'

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

const connectExample = (relative, origin) => ({
  src: { component: 'connect', module: 'components', family: 'example', relative, origin },
  contents: Buffer.from('')
})

// The generated reference a connector page needs: its fields, description
// meta, availability, and config examples. The guard requires each set.
const referencePartials = (origin) => [
  connectPartial('fields/inputs/http_server.adoc', origin),
  connectPartial('descriptions/inputs/http_server.adoc', origin),
  connectPartial('availability/inputs/http_server.adoc', origin),
  connectExample('common/inputs/http_server.yaml', origin),
  connectExample('advanced/inputs/http_server.yaml', origin)
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

  it('keeps the SQL drivers when info.csv pads its columns, as connect\'s does', async () => {
    const padded = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-csv-')), 'info.csv')
    fs.writeFileSync(padded, [
      'name                  ,type      ,commercial_name     ,support    ,deprecated ,cloud ,cloud_with_gpu ,cloud_unsupported_reason',
      'http_server           ,input     ,http_server         ,certified  ,n          ,y     ,y              ,',
      'sql_driver_clickhouse ,sql_driver,ClickHouse          ,community  ,n          ,y     ,y              ,'
    ].join('\n'))
    const files = [...referencePartials({ url: CONNECT_URL }), connectPartial('platforms/catalog.json', { url: CONNECT_URL }, catalogJson)]
    const { csvData } = await run(files, { csvpath: padded })
    const driver = csvData.data.find((r) => r.connector === 'sql_driver_clickhouse')
    expect(driver).toMatchObject({ type: 'sql_driver', commercial_name: 'ClickHouse', support_level: 'community' })
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

const { extractDescription } = ext

const page = (adoc, attributes) => ({
  asciidoc: attributes ? { attributes } : undefined,
  contents: Buffer.from(adoc, 'utf8')
})

describe('generate-rp-connect-info extractDescription', () => {
  test('returns empty string when no page is available', () => {
    expect(extractDescription(null)).toBe('')
    expect(extractDescription(undefined)).toBe('')
    expect(extractDescription({})).toBe('')
  })

  test('prefers the parsed asciidoc description attribute', () => {
    const src = page('= Kafka\n\ncomponent_type_dropdown::[]\n\nBody paragraph that should be ignored.\n', {
      description: 'Attribute description wins'
    })
    expect(extractDescription(src)).toBe('Attribute description wins')
  })

  // The :description: attribute is AsciiDoc too, and it is the source almost
  // every card uses, so it needs the same cleaning as the body fallback.
  describe('the description attribute path', () => {
    const body = '= Kafka\n\ncomponent_type_dropdown::[]\n\nIgnored body paragraph.\n'

    test('strips URL macros, xrefs, backticks and attribute references', () => {
      const src = page(body, {
        description: 'Executes a http://jmespath.org/[JMESPath query] on `code` docs, see xref:reference:about.adoc[the reference] with {page-component-title}.'
      })
      expect(extractDescription(src)).toBe('Executes a JMESPath query on code docs, see the reference with.')
    })

    test('truncates at the first sentence and stays within the cap', () => {
      const long = 'Streams change data capture events from the upstream database into the pipeline with configurable batching and checkpointing. It also does a great deal more that no card should try to show.'
      expect(long.length).toBeGreaterThan(150)
      const description = extractDescription(page(body, { description: long }))
      expect(description).toBe('Streams change data capture events from the upstream database into the pipeline with configurable batching and checkpointing.')
      expect(description.length).toBeLessThanOrEqual(150)
    })

    test('cuts a single long sentence at a word boundary, ellipsis included in the cap', () => {
      const description = extractDescription(page(body, { description: 'A '.concat('very long single sentence with no punctuation at all '.repeat(6)) }))
      expect(description.length).toBeLessThanOrEqual(150)
      expect(description.endsWith('...')).toBe(true)
      expect(description).not.toMatch(/\s\.\.\.$/)
    })

    test('keeps underscored identifiers intact while dropping formatting', () => {
      const src = page(body, { description: 'Writes to redpanda_migrator_offsets using the *native* client.' })
      expect(extractDescription(src)).toBe('Writes to redpanda_migrator_offsets using the native client.')
    })
  })

  test('falls back to an explicit :description: attribute in the raw contents', () => {
    const src = page('= Kafka\n:type: input\n:description: Reads records from Kafka topics.\n\ncomponent_type_dropdown::[]\n\nSomething else.\n')
    expect(extractDescription(src)).toBe('Reads records from Kafka topics.')
  })

  test('extracts the first paragraph after component_type_dropdown::[]', () => {
    const src = page([
      '= Kafka',
      ':type: input',
      '',
      'component_type_dropdown::[]',
      '',
      'Consumes messages from Kafka topics with consumer groups.',
      '',
      '== Fields'
    ].join('\n'))
    expect(extractDescription(src)).toBe('Consumes messages from Kafka topics with consumer groups.')
  })

  test('returns empty string when the page has no component_type_dropdown marker', () => {
    const src = page('= Kafka\n\nJust a paragraph with no dropdown macro in sight, sadly.\n')
    expect(extractDescription(src)).toBe('')
  })

  test('strips xref and URL macros, formatting, and attribute references', () => {
    const src = page([
      '= Kafka',
      '',
      'component_type_dropdown::[]',
      '',
      'Consumes data from xref:components/inputs/kafka.adoc[Apache Kafka] using the *native* `client` with _tuned_ {max-batch} batching.',
      ''
    ].join('\n'))
    expect(extractDescription(src)).toBe('Consumes data from Apache Kafka using the native client with tuned batching.')
  })

  // Same body, but the page actually defines {max-batch} -- the value must
  // survive into the card, not just leave a gap where it was dropped.
  test('substitutes an attribute reference the page actually defines', () => {
    const src = page([
      '= Kafka',
      '',
      'component_type_dropdown::[]',
      '',
      'Consumes data from xref:components/inputs/kafka.adoc[Apache Kafka] using the *native* `client` with _tuned_ {max-batch} batching.',
      ''
    ].join('\n'), { 'max-batch': '100msgs' })
    expect(extractDescription(src)).toBe('Consumes data from Apache Kafka using the native client with tuned 100msgs batching.')
  })

  test('converts external links spanning source lines to their text', () => {
    const src = page([
      '= Kafka',
      '',
      'component_type_dropdown::[]',
      '',
      'Streams change events from',
      'https://www.mongodb.com/[MongoDB^] collections into downstream systems.',
      ''
    ].join('\n'))
    expect(extractDescription(src)).toBe('Streams change events from MongoDB collections into downstream systems.')
  })

  test('skips admonition blocks, conditionals, and include directives', () => {
    const src = page([
      '= Kafka',
      '',
      'component_type_dropdown::[]',
      '',
      '[WARNING]',
      '====',
      'Scary warning that must not leak into the description.',
      '====',
      '',
      'ifndef::env-cloud[]',
      'include::partial$deprecated.adoc[]',
      'endif::[]',
      '',
      'The real first paragraph describing the connector behavior.',
      ''
    ].join('\n'))
    expect(extractDescription(src)).toBe('The real first paragraph describing the connector behavior.')
  })

  test('truncates long descriptions at the first sentence boundary', () => {
    const longPara = 'This connector reads a very large number of records from the upstream system and applies a long series of documented transformations before delivery. It also does much more that should be cut.'
    const src = page(`= Kafka\n\ncomponent_type_dropdown::[]\n\n${longPara}\n`)
    expect(extractDescription(src)).toBe('This connector reads a very large number of records from the upstream system and applies a long series of documented transformations before delivery.')
  })

  test('drops the "Introduced in version" suffix', () => {
    const src = page('= Kafka\n\ncomponent_type_dropdown::[]\n\nDoes something useful with streams. Introduced in version 4.53.0.\n')
    expect(extractDescription(src)).toBe('Does something useful with streams')
  })
})
