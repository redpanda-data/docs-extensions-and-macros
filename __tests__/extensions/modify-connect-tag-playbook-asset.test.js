const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals')
const EventEmitter = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const tar = require('tar')

// The GitHub API lookup and the git fallback both return v4.113.0, so the
// tests do not depend on which one the extension reaches.
jest.mock('../../extensions/version-fetcher/get-latest-connect', () => jest.fn(async () => '4.113.0'))
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFileSync: jest.fn(() => 'abc\trefs/tags/v4.113.0\n')
}))
// The releases listing the fallback reads when the latest release has no
// asset. Each test that reaches the fallback sets its own releases.
jest.mock('../../extensions/version-fetcher/list-connect-releases', () => jest.fn(async () => []))
// Dynamic imports fail under Jest, so the API client is a stand-in; the
// lookups that use it are mocked above.
jest.mock('../../extensions/util/connect-github', () => ({ createGitHub: jest.fn(async () => ({})) }))
jest.mock('../../cli-utils/octokit-client', () => ({ rest: { repos: { getContent: jest.fn() } } }))

const ContentCatalog = require('@antora/content-classifier/content-catalog')
const getLatestConnectTag = require('../../extensions/version-fetcher/get-latest-connect')
const listConnectReleases = require('../../extensions/version-fetcher/list-connect-releases')
const { execFileSync } = require('child_process')
const octokit = require('../../cli-utils/octokit-client')
const catalogUtil = require('../../extensions/util/connect-catalog')
const asset = require('../../extensions/util/connect-docs-asset')
const tagExt = require('../../extensions/modify-connect-tag-playbook.js')
const infoExt = require('../../extensions/generate-rp-connect-info.js')

const ENV = tagExt._internal.LOCAL_DIR_ENV
const DOCS_URL = 'https://github.com/redpanda-data/rp-connect-docs'
const CATALOG_JSON = JSON.stringify([
  { type: 'input', name: 'kafka', status: 'stable', support: 'certified', cloud: true, cloud_ai: true, commercial_names: ['Kafka'] }
])
const LONG_NAME = `${'very_long_component_name_'.repeat(5)}.adoc`
const TREE = {
  'modules/components/partials/fields/inputs/kafka.adoc': '// fields of kafka',
  'modules/components/partials/descriptions/inputs/kafka.adoc': '// description of kafka',
  'modules/components/partials/availability/inputs/kafka.adoc': '// availability of kafka',
  'modules/components/partials/examples/inputs/kafka.adoc': '// examples of kafka',
  'modules/components/partials/platforms/catalog.json': CATALOG_JSON,
  [`modules/components/partials/fields/processors/${LONG_NAME}`]: '// a path longer than 100 bytes',
  'modules/components/examples/common/inputs/kafka.yaml': 'input:\n  kafka: {}\n',
  'modules/components/examples/advanced/inputs/kafka.yaml': 'input:\n  kafka: {}\n',
  'modules/components/pages/inputs/kafka.adoc': '= Not part of the reference'
}

// An Antora-like generator context: one shared EventEmitter whose notify runs
// listeners one at a time in registration order, as Antora 3 does.
class Context extends EventEmitter {
  constructor () {
    super()
    this.logs = []
  }

  getLogger () {
    const log = (level) => (msg) => this.logs.push([level, msg])
    return { info: log('info'), warn: log('warn'), error: log('error'), debug: () => {} }
  }

  updateVariables () {}

  async notify (event, vars) {
    for (const listener of this.rawListeners(event)) await listener.call(this, vars)
  }
}

function writeTree (dir, tree = TREE) {
  for (const [rel, contents] of Object.entries(tree)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), contents)
  }
}

function makeTarGz (dir) {
  const out = path.join(dir, '..', `asset-${path.basename(dir)}.tar.gz`)
  tar.c({ gzip: true, sync: true, file: out, cwd: dir, portable: true }, ['modules'])
  return fs.readFileSync(out)
}

// A content catalog with the connect component from rp-connect-docs.
function makeCatalog (extraFiles = []) {
  const catalog = new ContentCatalog()
  catalog.registerComponentVersion('connect', '', { title: 'Connect' })
  const origin = { type: 'git', url: DOCS_URL, reftype: 'branch', refname: 'main', branch: 'main' }
  const add = (family, relative, contents) => {
    const dir = { page: 'pages', partial: 'partials', example: 'examples', attachment: 'attachments' }[family]
    const p = `modules/components/${dir}/${relative}`
    catalog.addFile({ path: p, contents: Buffer.from(contents), src: { component: 'connect', version: '', module: 'components', family, relative, path: p, origin } })
  }
  // A connector page that includes every generated set, as the migrated pages do.
  add('page', 'inputs/kafka.adoc', '= Kafka\n\ninclude::connect:components:partial$descriptions/inputs/kafka.adoc[tag=meta]\ninclude::connect:components:partial$availability/inputs/kafka.adoc[]\ninclude::components:example$common/inputs/kafka.yaml[]\ninclude::components:example$advanced/inputs/kafka.yaml[]\ninclude::connect:components:partial$fields/inputs/kafka.adoc[]\n')
  for (const [family, relative, contents] of extraFiles) add(family, relative, contents)
  return catalog
}

// Every generated set the guard requires, as committed copies in
// rp-connect-docs, for builds that add nothing from the release asset.
const COMMITTED_SETS = [
  ['partial', 'fields/inputs/kafka.adoc', '// committed'],
  ['partial', 'descriptions/inputs/kafka.adoc', '// committed'],
  ['partial', 'availability/inputs/kafka.adoc', '// committed'],
  ['example', 'common/inputs/kafka.yaml', '# committed'],
  ['example', 'advanced/inputs/kafka.yaml', '# committed']
]
// A local tree with every set the guard requires.
const LOCAL_TREE = {
  'modules/components/partials/fields/inputs/kafka.adoc': '// local fields',
  'modules/components/partials/descriptions/inputs/kafka.adoc': '// local description',
  'modules/components/partials/availability/inputs/kafka.adoc': '// local availability',
  'modules/components/examples/common/inputs/kafka.yaml': '# local common',
  'modules/components/examples/advanced/inputs/kafka.yaml': '# local advanced'
}

// Registers both extensions and runs a build up to contentClassified.
// generate-rp-connect-info is registered first, which is the wrong order in a
// playbook, to show the asset files still arrive before its guard.
async function build ({ sources = [{ url: DOCS_URL, branches: 'main' }], config = {}, catalog = makeCatalog(), infoFirst = true } = {}) {
  const ctx = new Context()
  const registerInfo = () => infoExt.register.call(ctx, { config: {} })
  const registerTag = () => tagExt.register.call(ctx, { config })
  if (infoFirst) { registerInfo(); registerTag() } else { registerTag(); registerInfo() }
  const playbook = { content: { sources } }
  await ctx.notify('contextStarted', { playbook })
  await ctx.notify('contentAggregated', { playbook, contentAggregate: [] })
  let error = null
  try {
    await ctx.notify('contentClassified', { playbook, contentCatalog: catalog })
  } catch (e) {
    error = e
  }
  return { catalog, logs: ctx.logs, error, playbook }
}

const fromConnect = (catalog) => catalog.findBy({ component: 'connect' }).filter((f) => catalogUtil.isConnectOrigin(f.src.origin))
const response = (status, body = Buffer.alloc(0)) => ({
  status,
  ok: status >= 200 && status < 300,
  statusText: String(status),
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
})

// The download takes the authenticated API path when a token is set, so keep
// the runner's own tokens out of these tests.
const TOKEN_VARS = ['REDPANDA_GITHUB_TOKEN', 'ACTIONS_BOT_TOKEN', 'GITHUB_TOKEN', 'VBOT_GITHUB_API_TOKEN', 'GH_TOKEN', 'GIT_CREDENTIALS']
let savedTokens = {}

let tmp, archive, realFetch
beforeEach(() => {
  savedTokens = {}
  for (const v of TOKEN_VARS) {
    savedTokens[v] = process.env[v]
    delete process.env[v]
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-asset-'))
  fs.mkdirSync(path.join(tmp, 'tree'))
  writeTree(path.join(tmp, 'tree'))
  archive = makeTarGz(path.join(tmp, 'tree'))
  realFetch = global.fetch
  global.fetch = jest.fn(async () => response(200, archive))
  asset.retryDelayMs = 0
  delete process.env[ENV]
  catalogUtil.setResolvedConnectRef(null)
  getLatestConnectTag.mockClear()
  getLatestConnectTag.mockImplementation(async () => '4.113.0')
  listConnectReleases.mockReset()
  listConnectReleases.mockResolvedValue([])
  execFileSync.mockClear()
  execFileSync.mockImplementation(() => 'abc\trefs/tags/v4.113.0\n')
  octokit.rest.repos.getContent.mockReset()
  octokit.rest.repos.getContent.mockResolvedValue({ data: { content: Buffer.from('name,type\nsql_driver_postgres,sql_driver\n').toString('base64') } })
})
afterEach(() => {
  for (const v of TOKEN_VARS) {
    if (savedTokens[v] === undefined) delete process.env[v]
    else process.env[v] = savedTokens[v]
  }
  global.fetch = realFetch
  delete process.env[ENV]
  fs.rmSync(tmp, { recursive: true, force: true })
  catalogUtil.setResolvedConnectRef(null)
})

describe('connect-docs-asset tar reader', () => {
  it('reads every regular file of a gzipped tar, including long paths', async () => {
    const files = await asset.readTarGz(archive)
    expect(files.map((f) => f.path).sort()).toEqual(Object.keys(TREE).sort())
    const catalogJson = files.find((f) => f.path.endsWith('platforms/catalog.json'))
    expect(catalogJson.contents.toString()).toBe(CATALOG_JSON)
  })

  it('rejects data that is not gzip, gzip that is not tar, and a truncated archive', async () => {
    await expect(asset.readTarGz(Buffer.from('not gzip'))).rejects.toThrow(/not a valid gzip archive/)
    const limit = asset.maxUnpackedBytes
    asset.maxUnpackedBytes = 1000
    try {
      await expect(asset.readTarGz(zlib.gzipSync(Buffer.alloc(4096)))).rejects.toThrow(/unpacks to more than 1000 bytes/)
    } finally {
      asset.maxUnpackedBytes = limit
    }
    await expect(asset.readTarGz(zlib.gzipSync(Buffer.from('x'.repeat(4096))))).rejects.toThrow(/not a valid tar archive/)
    const tarBytes = zlib.gunzipSync(archive)
    // Cut at an entry boundary and mid-entry, inside an intact gzip stream
    await expect(asset.readTarGz(zlib.gzipSync(tarBytes.subarray(0, 1024)))).rejects.toThrow(/not a valid tar archive: .*truncated/)
    await expect(asset.readTarGz(zlib.gzipSync(tarBytes.subarray(0, 1000)))).rejects.toThrow(/not a valid tar archive/)
    // A download cut short
    await expect(asset.readTarGz(archive.subarray(0, archive.length - 20))).rejects.toThrow(/not a valid gzip archive/)
  })

  // The realistic fixture of a release asset, when available locally.
  const fixture = process.env.CONNECT_DOCS_ASSET_FIXTURE
  ;(fixture ? it : it.skip)('reads the realistic release asset fixture', async () => {
    const files = await asset.readTarGz(fs.readFileSync(fixture))
    const resources = files.map((f) => asset.toResource(f.path)).filter(Boolean)
    expect(resources.length).toBe(files.length)
    expect(resources.length).toBeGreaterThan(2000)
    expect(resources).toContainEqual(expect.objectContaining({ family: 'partial', relative: 'platforms/catalog.json' }))
    expect(resources).toContainEqual(expect.objectContaining({ family: 'partial', relative: 'fields/inputs/kafka_franz.adoc' }))
    expect(resources.some((r) => r.family === 'example')).toBe(true)
  })

  it('maps tree paths to partial and example resources and ignores the rest', () => {
    expect(asset.toResource('modules/components/partials/fields/inputs/kafka.adoc')).toEqual({ family: 'partial', relative: 'fields/inputs/kafka.adoc', path: 'modules/components/partials/fields/inputs/kafka.adoc' })
    expect(asset.toResource('./modules/components/examples/common/x.yaml')).toMatchObject({ family: 'example', relative: 'common/x.yaml' })
    expect(asset.toResource('modules/components/pages/inputs/kafka.adoc')).toBeNull()
    expect(asset.toResource('modules/components/partials/../pages/x.adoc')).toBeNull()
    expect(asset.toResource('modules/components/partials/')).toBeNull()
    expect(asset.toResource('modules/components/attachments/connect-4.113.0.json')).toEqual({ family: 'attachment', relative: 'connect-4.113.0.json', path: 'modules/components/attachments/connect-4.113.0.json' })
  })
})

describe('modify-connect-tag-playbook with the release asset', () => {
  it('adds the release connector data as an attachment, which set-available-attachment-versions then picks', async () => {
    const dir = path.join(tmp, 'with-json')
    fs.mkdirSync(dir)
    writeTree(dir, { ...TREE, 'modules/components/attachments/connect-4.113.0.json': '{"version":"4.113.0"}' })
    const withJson = makeTarGz(dir)
    global.fetch = jest.fn(async () => response(200, withJson))
    // rp-connect-docs still commits the previous release's file.
    const catalog = makeCatalog([['attachment', 'connect-4.112.0.json', '{"version":"4.112.0"}']])
    const { error } = await build({ catalog })
    expect(error).toBeNull()
    const json = catalog.getById({ component: 'connect', version: '', module: 'components', family: 'attachment', relative: 'connect-4.113.0.json' })
    expect(json.contents.toString()).toBe('{"version":"4.113.0"}')
    expect(json.pub.url).toBe('/connect/components/_attachments/connect-4.113.0.json')

    const available = require('../../extensions/set-available-attachment-versions')
    const ctx = new Context()
    available.register.call(ctx, { config: {} })
    await ctx.notify('contentClassified', { contentCatalog: catalog, siteCatalog: {} })
    const attrs = catalog.getComponent('connect').versions[0].asciidoc.attributes
    expect(attrs['available-connect-version']).toBe('4.113.0')
  })

  it('downloads the latest release asset and adds its partials and examples to the connect component', async () => {
    const { catalog, error, logs } = await build()
    expect(error).toBeNull()
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch.mock.calls[0][0]).toBe('https://github.com/redpanda-data/connect/releases/download/v4.113.0/redpanda-connect-docs.tar.gz')
    const fields = catalog.getById({ component: 'connect', version: '', module: 'components', family: 'partial', relative: 'fields/inputs/kafka.adoc' })
    expect(fields.contents.toString()).toBe('// fields of kafka')
    expect(catalog.getById({ component: 'connect', version: '', module: 'components', family: 'example', relative: 'common/inputs/kafka.yaml' })).toBeTruthy()
    // The page in the tarball is not part of the reference.
    expect(fromConnect(catalog).map((f) => f.src.family)).not.toContain('page')
    expect(fromConnect(catalog)).toHaveLength(8)
    expect(logs).toContainEqual(['info', expect.stringMatching(/added 8 files .* skipped 0 already provided by another source and 1 outside/)])
  })

  it('resolves includes of the added partials through the content catalog', async () => {
    const { catalog } = await build()
    const page = catalog.getById({ component: 'connect', version: '', module: 'components', family: 'page', relative: 'inputs/kafka.adoc' })
    expect(catalog.resolveResource('components:partial$fields/inputs/kafka.adoc', page.src, 'page').contents.toString()).toBe('// fields of kafka')
  })

  it('shares the tag, and generate-rp-connect-info reads catalog.json and info.csv for it', async () => {
    const { catalog, error, logs } = await build()
    expect(error).toBeNull()
    expect(catalogUtil.getResolvedConnectRef()).toBe('v4.113.0')
    expect(catalogUtil.connectOriginRef(catalog)).toEqual({ ref: 'v4.113.0', owner: 'redpanda-data', repo: 'connect' })
    const catalogFile = catalogUtil.findConnectCatalogFile(catalog)
    expect(catalogFile.src.origin).toMatchObject({ url: 'https://github.com/redpanda-data/connect', tag: 'v4.113.0' })
    expect(logs).toContainEqual(['info', 'Loaded 1 components from connect:components:partial$platforms/catalog.json (v4.113.0)'])
    expect(octokit.rest.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ ref: 'v4.113.0', path: 'internal/plugins/info.csv' }))
  })

  it('runs before generate-rp-connect-info in either registration order', async () => {
    for (const infoFirst of [true, false]) {
      const { error } = await build({ infoFirst })
      expect(error).toBeNull()
    }
  })

  it('uses the tag config instead of the latest release', async () => {
    const { error } = await build({ config: { tag: '4.200.0' } })
    expect(error).toBeNull()
    expect(getLatestConnectTag).not.toHaveBeenCalled()
    expect(global.fetch.mock.calls[0][0]).toContain('/releases/download/v4.200.0/')
    expect(catalogUtil.getResolvedConnectRef()).toBe('v4.200.0')
  })

  it('fails the build when the release picked with the tag config has no asset (404)', async () => {
    global.fetch = jest.fn(async () => response(404))
    const { catalog, error } = await build({ config: { tag: 'v4.112.0' } })
    expect(error.message).toMatch(/^Redpanda Connect release v4\.112\.0 has no redpanda-connect-docs\.tar\.gz asset/)
    expect(error.message).toMatch(/`tag`/)
    expect(fromConnect(catalog)).toHaveLength(0)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(listConnectReleases).not.toHaveBeenCalled()
  })

  it('rejects `tag: latest`, which is the default and would become vlatest', () => {
    for (const tag of ['latest', ' Latest ']) {
      const ctx = new Context()
      expect(() => tagExt.register.call(ctx, { config: { tag } })).toThrow(/`tag` config of modify-connect-tag-playbook is `latest`.*remove `tag`/)
    }
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('stops the build when the asset is incomplete, naming every missing set', async () => {
    const partial = path.join(tmp, 'partial-tree')
    writeTree(partial, {
      'modules/components/partials/fields/inputs/kafka.adoc': '// fields',
      'modules/components/partials/descriptions/inputs/kafka.adoc': '// description'
    })
    global.fetch = jest.fn(async () => response(200, makeTarGz(partial)))
    const { error } = await build()
    expect(error.message).toMatch(/no generated components:partial\$availability\/\* or components:example\$common\/\* or components:example\$advanced\/\* files/)
    expect(error.message).not.toMatch(/partial\$fields/)
    expect(error.message).not.toMatch(/lists a connect content source/)
  })

  it('fails the build on a server error after retrying', async () => {
    global.fetch = jest.fn(async () => response(502))
    const { error } = await build()
    expect(global.fetch).toHaveBeenCalledTimes(3)
    expect(error.message).toMatch(/Could not download the Redpanda Connect reference docs for v4\.113\.0: .*HTTP 502/)
  })

  it('fails the build on a network error', async () => {
    global.fetch = jest.fn(async () => { throw new Error('getaddrinfo ENOTFOUND github.com') })
    const { error } = await build()
    expect(error.message).toMatch(/Could not download .*ENOTFOUND/)
  })

  it('fails the build on a corrupt archive', async () => {
    global.fetch = jest.fn(async () => response(200, Buffer.from('<html>not a tarball</html>')))
    const { catalog, error } = await build()
    expect(error.message).toMatch(/release asset of Redpanda Connect v4\.113\.0 is corrupt: not a valid gzip archive/)
    expect(fromConnect(catalog)).toHaveLength(0)
  })

  it('skips files another source already provides and counts them', async () => {
    const catalog = makeCatalog([['partial', 'fields/inputs/kafka.adoc', '// committed copy']])
    const { error, logs } = await build({ catalog })
    expect(error).toBeNull()
    const fields = catalog.getById({ component: 'connect', version: '', module: 'components', family: 'partial', relative: 'fields/inputs/kafka.adoc' })
    expect(fields.contents.toString()).toBe('// committed copy')
    expect(fields.src.origin.url).toBe(DOCS_URL)
    expect(logs).toContainEqual(['info', expect.stringMatching(/added 7 files .* skipped 1 already provided by another source/)])
  })

  it('reads a local directory from REDPANDA_CONNECT_DOCS_DIR over the tag and the latest release', async () => {
    const local = path.join(tmp, 'local')
    writeTree(local, LOCAL_TREE)
    process.env[ENV] = local
    const { catalog, error } = await build({ config: { tag: 'v4.200.0' } })
    expect(error).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(getLatestConnectTag).not.toHaveBeenCalled()
    const fields = catalog.getById({ component: 'connect', version: '', module: 'components', family: 'partial', relative: 'fields/inputs/kafka.adoc' })
    expect(fields.contents.toString()).toBe('// local fields')
    expect(catalogUtil.isConnectOrigin(fields.src.origin)).toBe(true)
    // The local files have no release ref; info.csv follows the tag config.
    expect(catalogUtil.connectOriginRef(catalog)).toBeNull()
    expect(catalogUtil.getResolvedConnectRef()).toBe('v4.200.0')
  })

  it('replaces files another source provides with the REDPANDA_CONNECT_DOCS_DIR copies and counts them', async () => {
    const local = path.join(tmp, 'local')
    writeTree(local, LOCAL_TREE)
    process.env[ENV] = local
    const catalog = makeCatalog([['partial', 'fields/inputs/kafka.adoc', '// committed copy'], ['partial', 'secret_warning.adoc', '// only in rp-connect-docs']])
    const { error, logs } = await build({ catalog })
    expect(error).toBeNull()
    const fields = catalog.getById({ component: 'connect', version: '', module: 'components', family: 'partial', relative: 'fields/inputs/kafka.adoc' })
    expect(fields.contents.toString()).toBe('// local fields')
    expect(fields.src.origin).toMatchObject({ type: 'local', localDir: local })
    expect(catalog.findBy({ component: 'connect', family: 'partial' }).filter((f) => f.src.relative === 'fields/inputs/kafka.adoc')).toHaveLength(1)
    // Files only rp-connect-docs has stay.
    expect(catalog.getById({ component: 'connect', version: '', module: 'components', family: 'partial', relative: 'secret_warning.adoc' })).toBeTruthy()
    expect(logs).toContainEqual(['info', expect.stringMatching(/added 4 files .*; replaced 1 provided by another source; skipped 0 outside/)])
  })

  it('accepts a connect checkout root and a local tarball in REDPANDA_CONNECT_DOCS_DIR', async () => {
    const checkout = path.join(tmp, 'connect')
    writeTree(path.join(checkout, 'docs'))
    process.env[ENV] = checkout
    expect((await build()).error).toBeNull()
    const file = path.join(tmp, 'local.tar.gz')
    fs.writeFileSync(file, archive)
    process.env[ENV] = file
    const { catalog, error } = await build()
    expect(error).toBeNull()
    expect(fromConnect(catalog)).toHaveLength(8)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('fails clearly when REDPANDA_CONNECT_DOCS_DIR has no reference tree or is a corrupt tarball', async () => {
    process.env[ENV] = path.join(tmp, 'missing')
    expect((await build()).error.message).toMatch(/Could not read the Redpanda Connect reference docs from REDPANDA_CONNECT_DOCS_DIR .*does not exist/)
    fs.mkdirSync(path.join(tmp, 'empty'))
    process.env[ENV] = path.join(tmp, 'empty')
    expect((await build()).error.message).toMatch(/has no modules\/components directory/)
    fs.writeFileSync(path.join(tmp, 'bad.tar.gz'), 'garbage')
    process.env[ENV] = path.join(tmp, 'bad.tar.gz')
    expect((await build()).error.message).toMatch(/REDPANDA_CONNECT_DOCS_DIR .*not a valid gzip archive/)
  })

  it('does nothing, and makes no network calls, without the connect component', async () => {
    const catalog = new ContentCatalog()
    catalog.registerComponentVersion('streaming', '26.2', {})
    const { error } = await build({ catalog })
    expect(error).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(getLatestConnectTag).not.toHaveBeenCalled()
  })
})

describe('modify-connect-tag-playbook with a connect content source', () => {
  it('removes the upstream connect source with tags: latest, warns, and uses the release asset', async () => {
    const connect = { url: 'https://github.com/redpanda-data/connect', tags: 'latest', start_path: 'docs' }
    const sources = [{ url: DOCS_URL, branches: 'main' }, connect]
    const ctx = new Context()
    const updated = jest.spyOn(ctx, 'updateVariables')
    tagExt.register.call(ctx, { config: {} })
    const playbook = { content: { sources } }
    await ctx.notify('contextStarted', { playbook })
    expect(playbook.content.sources).toEqual([{ url: DOCS_URL, branches: 'main' }])
    expect(updated).toHaveBeenCalledWith({ playbook })
    expect(ctx.logs).toContainEqual(['warn', expect.stringMatching(/content source \(https:\/\/github\.com\/redpanda-data\/connect with tags: latest\) is no longer needed and was removed .*release asset/)])

    const { catalog, error, logs } = await build({ sources: [{ url: DOCS_URL, branches: 'main' }, { ...connect }] })
    expect(error).toBeNull()
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(fromConnect(catalog)).toHaveLength(8)
    expect(catalogUtil.getResolvedConnectRef()).toBe('v4.113.0')
    expect(logs).toContainEqual(['info', expect.stringMatching(/from the v4\.113\.0 redpanda-connect-docs\.tar\.gz release asset: added 8 files/)])
  })

  it('keeps a connect source with explicit refs, filters it, and adds no asset files', async () => {
    const pr = { url: 'https://github.com/redpanda-data/connect', branches: ['docs/some-change'], start_path: 'docs' }
    const fork = { url: 'https://github.com/someone/connect', tags: 'latest', start_path: 'docs' }
    for (const source of [pr, fork, { url: 'https://github.com/redpanda-data/connect', tags: 'v4.110.0', start_path: 'docs' }]) {
      process.env[ENV] = path.join(tmp, 'tree')
      const sources = [{ url: DOCS_URL, branches: 'main' }, { ...source }]
      const { error, logs, playbook } = await build({ sources, catalog: makeCatalog(COMMITTED_SETS) })
      expect(error).toBeNull()
      expect(playbook.content.sources).toEqual([{ url: DOCS_URL, branches: 'main' }, source])
      expect(global.fetch).not.toHaveBeenCalled()
      expect(getLatestConnectTag).not.toHaveBeenCalled()
      expect(logs).toContainEqual(['warn', expect.stringMatching(/REDPANDA_CONNECT_DOCS_DIR is ignored/)])
      expect(logs).not.toContainEqual(['warn', expect.stringMatching(/no longer needed/)])
    }
  })

  it('keeps a local clone named connect as a content source', async () => {
    const sources = [{ url: DOCS_URL, branches: 'main' }, { url: '/Users/me/repos/connect', branches: 'HEAD', start_path: 'docs' }]
    const { error, playbook } = await build({ sources, catalog: makeCatalog(COMMITTED_SETS) })
    expect(error).toBeNull()
    expect(playbook.content.sources).toHaveLength(2)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(getLatestConnectTag).not.toHaveBeenCalled()
  })

  it('names the connect source in the guard error when its ref lacks the generated docs', async () => {
    const sources = [{ url: DOCS_URL, branches: 'main' }, { url: 'https://x-access-token:s3cret@github.com/redpanda-data/connect', branches: 'my-fix', start_path: 'docs' }]
    const { error } = await build({ sources })
    expect(error.message).toMatch(/lists a connect content source \(https:\/\/github\.com\/redpanda-data\/connect\), so no release asset was downloaded/)
    expect(error.message).not.toMatch(/s3cret/)
  })
})

describe('connect-docs-asset download', () => {
  const API = 'https://api.github.com/repos/redpanda-data/connect'
  const ASSET_API = `${API}/releases/assets/7`
  const SIGNED = 'https://objects.githubusercontent.com/signed?x=1'
  const json = (status, value) => ({ ...response(status), json: async () => value })
  const redirect = (location) => ({ ...response(302), headers: { get: (h) => (h.toLowerCase() === 'location' ? location : null) } })
  const routes = (map) => jest.fn(async (url) => {
    if (!(url in map)) throw new Error(`unexpected fetch ${url}`)
    return map[url]
  })

  it('with a token, downloads through the releases API and keeps the token off the signed URL', async () => {
    const fetchImpl = routes({
      [`${API}/releases/tags/v4.200.0`]: json(200, { assets: [{ name: 'other.tar.gz', url: `${API}/releases/assets/6` }, { name: 'redpanda-connect-docs.tar.gz', url: ASSET_API }] }),
      [ASSET_API]: redirect(SIGNED),
      [SIGNED]: response(200, archive)
    })
    const body = await asset.downloadAsset('v4.200.0', { fetchImpl, token: 't0ken' })
    expect(Buffer.compare(body, archive)).toBe(0)
    const headersFor = (url) => fetchImpl.mock.calls.find(([u]) => u === url)[1].headers
    expect(headersFor(`${API}/releases/tags/v4.200.0`).Authorization).toBe('Bearer t0ken')
    expect(headersFor(ASSET_API)).toMatchObject({ Authorization: 'Bearer t0ken', Accept: 'application/octet-stream' })
    expect(fetchImpl.mock.calls.find(([u]) => u === ASSET_API)[1].redirect).toBe('manual')
    expect(headersFor(SIGNED).Authorization).toBeUndefined()
    expect(fetchImpl.mock.calls.some(([u]) => u.startsWith('https://github.com/'))).toBe(false)
  })

  it('with a token, returns null for a release without the asset or a missing release', async () => {
    const noAsset = routes({ [`${API}/releases/tags/v4.200.0`]: json(200, { assets: [{ name: 'other.tar.gz', url: `${API}/releases/assets/6` }] }) })
    await expect(asset.downloadAsset('v4.200.0', { fetchImpl: noAsset, token: 't' })).resolves.toBeNull()
    const noRelease = routes({ [`${API}/releases/tags/v4.200.0`]: json(404, {}), [asset.assetUrl('v4.200.0')]: response(404) })
    await expect(asset.downloadAsset('v4.200.0', { fetchImpl: noRelease, token: 't' })).resolves.toBeNull()
  })

  it.each([401, 403])('falls back to the public download when the token is rejected (%s)', async (status) => {
    const fetchImpl = routes({
      [`${API}/releases/tags/v4.200.0`]: json(status, {}),
      [asset.assetUrl('v4.200.0')]: response(200, archive)
    })
    const body = await asset.downloadAsset('v4.200.0', { fetchImpl, token: 'expired' })
    expect(Buffer.compare(body, archive)).toBe(0)
    expect(fetchImpl.mock.calls.find(([u]) => u === asset.assetUrl('v4.200.0'))[1].headers.Authorization).toBeUndefined()
  })

  it('falls back to the public download when the asset endpoint rejects the token', async () => {
    for (const status of [401, 403]) {
      const fetchImpl = routes({
        [`${API}/releases/tags/v4.200.0`]: json(200, { assets: [{ name: 'redpanda-connect-docs.tar.gz', url: ASSET_API }] }),
        [ASSET_API]: response(status),
        [asset.assetUrl('v4.200.0')]: response(200, archive)
      })
      const body = await asset.downloadAsset('v4.200.0', { fetchImpl, token: 't' })
      expect(Buffer.compare(body, archive)).toBe(0)
    }
  })

  it('falls back to the public download when the token cannot see the release (404)', async () => {
    const fetchImpl = routes({
      [`${API}/releases/tags/v4.200.0`]: json(404, {}),
      [asset.assetUrl('v4.200.0')]: response(200, archive)
    })
    const body = await asset.downloadAsset('v4.200.0', { fetchImpl, token: 't' })
    expect(Buffer.compare(body, archive)).toBe(0)
  })

  it('says why when neither the token nor the public download finds the release', async () => {
    const fetchImpl = routes({
      [`${API}/releases/tags/v4.200.0`]: json(404, {}),
      [asset.assetUrl('v4.200.0')]: response(404)
    })
    const warn = jest.fn()
    await expect(asset.downloadAsset('v4.200.0', { fetchImpl, token: 't', logger: { warn } })).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/found no v4\.200\.0 release of redpanda-data\/connect with the GitHub token.*read access/))
  })

  it('stays quiet for a release that exists without the asset', async () => {
    const fetchImpl = routes({ [`${API}/releases/tags/v4.200.0`]: json(200, { assets: [] }) })
    const warn = jest.fn()
    await expect(asset.downloadAsset('v4.200.0', { fetchImpl, token: 't', logger: { warn } })).resolves.toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('without a token, uses the public download URL', async () => {
    const fetchImpl = routes({ [asset.assetUrl('v4.200.0')]: response(200, archive) })
    const body = await asset.downloadAsset('v4.200.0', { fetchImpl })
    expect(Buffer.compare(body, archive)).toBe(0)
  })

  it('retries when the connection drops while reading the body', async () => {
    const dropped = { ...response(200), arrayBuffer: async () => { throw new Error('terminated') } }
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(dropped)
      .mockResolvedValueOnce(response(200, archive))
    const body = await asset.downloadAsset('v4.200.0', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(Buffer.compare(body, archive)).toBe(0)
  })

  it('fails with the body error after every attempt drops', async () => {
    const dropped = { ...response(200), arrayBuffer: async () => { throw new Error('terminated') } }
    const fetchImpl = jest.fn(async () => dropped)
    await expect(asset.downloadAsset('v4.200.0', { fetchImpl })).rejects.toThrow(/could not download .*: terminated/)
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1)
  })
})

// A release as the GitHub releases API lists it.
const release = (tag, { withAsset = false, prerelease = false, draft = false } = {}) => ({
  tag_name: tag,
  prerelease,
  draft,
  assets: withAsset ? [{ name: 'redpanda-connect-docs.tar.gz' }, { name: 'redpanda-connect_linux_amd64.tar.gz' }] : [{ name: 'redpanda-connect_linux_amd64.tar.gz' }]
})
// fetch that answers 404 for the release tags given and serves the archive
// for every other release.
const notFoundFor = (...tags) => jest.fn(async (url) => (tags.some((t) => url.includes(`/download/${t}/`)) ? response(404) : response(200, archive)))
const downloadedTags = () => global.fetch.mock.calls.map(([url]) => url.match(/\/download\/([^/]+)\//)[1])

describe('modify-connect-tag-playbook falls back when the latest release has no asset yet', () => {
  it('uses the newest older stable release that has the asset, and warns naming both', async () => {
    global.fetch = notFoundFor('v4.113.0')
    listConnectReleases.mockResolvedValue([
      // A backport published after v4.112.0 is listed first but is older.
      release('v4.110.5', { withAsset: true }),
      release('v4.113.0'),
      release('v4.113.0-rc1', { withAsset: true, prerelease: true }),
      release('v4.112.1', { withAsset: true, draft: true }),
      release('v4.112.0', { withAsset: true }),
      release('v4.111.0', { withAsset: true })
    ])
    const { catalog, error, logs } = await build()
    expect(error).toBeNull()
    expect(listConnectReleases).toHaveBeenCalledWith(expect.anything(), 'redpanda-data', 'connect', 10)
    // Only the latest and the chosen release are downloaded.
    expect(downloadedTags()).toEqual(['v4.113.0', 'v4.112.0'])
    expect(logs).toContainEqual(['warn', 'Redpanda Connect v4.113.0 has no redpanda-connect-docs.tar.gz asset yet; using v4.112.0'])
    expect(fromConnect(catalog)).toHaveLength(8)
    expect(logs).toContainEqual(['info', expect.stringMatching(/^Redpanda Connect reference docs from the v4\.112\.0 redpanda-connect-docs\.tar\.gz release asset: added 8 files/)])
  })

  it('shares the fallback release, and generate-rp-connect-info reads catalog.json and info.csv for it', async () => {
    global.fetch = notFoundFor('v4.113.0')
    listConnectReleases.mockResolvedValue([release('v4.113.0'), release('v4.112.0', { withAsset: true })])
    const { catalog, error, logs } = await build()
    expect(error).toBeNull()
    expect(catalogUtil.getResolvedConnectRef()).toBe('v4.112.0')
    expect(catalogUtil.connectOriginRef(catalog)).toEqual({ ref: 'v4.112.0', owner: 'redpanda-data', repo: 'connect' })
    const fields = catalog.getById({ component: 'connect', version: '', module: 'components', family: 'partial', relative: 'fields/inputs/kafka.adoc' })
    expect(fields.src.origin).toMatchObject({ type: 'release-asset', tag: 'v4.112.0', refname: 'v4.112.0', asset: asset.assetUrl('v4.112.0') })
    expect(catalogUtil.findConnectCatalogFile(catalog).src.origin).toMatchObject({ tag: 'v4.112.0' })
    expect(logs).toContainEqual(['info', 'Loaded 1 components from connect:components:partial$platforms/catalog.json (v4.112.0)'])
    expect(octokit.rest.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ ref: 'v4.112.0', path: 'internal/plugins/info.csv' }))
    expect(octokit.rest.repos.getContent).not.toHaveBeenCalledWith(expect.objectContaining({ ref: 'v4.113.0' }))
  })

  it('never falls back from a release picked with the tag config', async () => {
    global.fetch = notFoundFor('v4.113.0')
    listConnectReleases.mockResolvedValue([release('v4.113.0'), release('v4.112.0', { withAsset: true })])
    const { catalog, error, logs } = await build({ config: { tag: 'v4.113.0' } })
    expect(listConnectReleases).not.toHaveBeenCalled()
    expect(execFileSync).not.toHaveBeenCalled()
    expect(downloadedTags()).toEqual(['v4.113.0'])
    expect(logs.filter(([level]) => level === 'warn')).toEqual([])
    expect(fromConnect(catalog)).toHaveLength(0)
    expect(error.message).toMatch(/^Redpanda Connect release v4\.113\.0 has no redpanda-connect-docs\.tar\.gz asset/)
  })

  it('adds nothing when no listed release has the asset, and the guard stops the build', async () => {
    global.fetch = jest.fn(async () => response(404))
    listConnectReleases.mockResolvedValue([release('v4.113.0'), release('v4.112.0'), release('v4.111.0')])
    const { catalog, error, logs } = await build()
    expect(downloadedTags()).toEqual(['v4.113.0'])
    expect(execFileSync).not.toHaveBeenCalled()
    expect(logs).toContainEqual(['info', 'None of the 3 most recent Redpanda Connect releases has a redpanda-connect-docs.tar.gz release asset'])
    expect(logs).toContainEqual(['info', expect.stringMatching(/v4\.113\.0 has no redpanda-connect-docs\.tar\.gz release asset \(404\)/)])
    expect(logs.filter(([level]) => level === 'warn')).toEqual([])
    expect(fromConnect(catalog)).toHaveLength(0)
    expect(catalogUtil.getResolvedConnectRef()).toBe('v4.113.0')
    expect(error.message).toMatch(/no generated components:partial\$fields\/\*/)
  })

  it('probes the next lower stable git tags when the releases API fails', async () => {
    getLatestConnectTag.mockImplementation(async () => null)
    listConnectReleases.mockRejectedValue(new Error('API rate limit exceeded'))
    execFileSync.mockImplementation(() => [
      'a\trefs/tags/v4.113.0', 'b\trefs/tags/v4.113.0-rc1', 'c\trefs/tags/v4.112.0', 'd\trefs/tags/v4.111.0', 'e\trefs/tags/v4.110.0', 'f\trefs/tags/v4.9.0'
    ].join('\n'))
    global.fetch = notFoundFor('v4.113.0', 'v4.112.0')
    const { catalog, error, logs } = await build()
    expect(error).toBeNull()
    expect(downloadedTags()).toEqual(['v4.113.0', 'v4.112.0', 'v4.111.0'])
    expect(logs).toContainEqual(['warn', expect.stringMatching(/GitHub API listing of Redpanda Connect releases failed: API rate limit exceeded; probing the next 3 lower release tags from git/)])
    expect(logs).toContainEqual(['warn', 'Redpanda Connect v4.113.0 has no redpanda-connect-docs.tar.gz asset yet; using v4.111.0'])
    expect(catalogUtil.getResolvedConnectRef()).toBe('v4.111.0')
    expect(catalogUtil.connectOriginRef(catalog)).toEqual({ ref: 'v4.111.0', owner: 'redpanda-data', repo: 'connect' })
    expect(octokit.rest.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ ref: 'v4.111.0', path: 'internal/plugins/info.csv' }))
  })

  it('stops probing git tags after the limit and adds nothing when none has the asset', async () => {
    listConnectReleases.mockRejectedValue(new Error('API rate limit exceeded'))
    execFileSync.mockImplementation(() => ['v4.113.0', 'v4.112.0', 'v4.111.0', 'v4.110.0', 'v4.109.0'].map((t) => `x\trefs/tags/${t}`).join('\n'))
    global.fetch = jest.fn(async () => response(404))
    const { catalog, error, logs } = await build()
    expect(downloadedTags()).toEqual(['v4.113.0', 'v4.112.0', 'v4.111.0', 'v4.110.0'])
    expect(logs).toContainEqual(['info', 'None of the next 3 lower Redpanda Connect release tags (v4.112.0, v4.111.0, v4.110.0) has a redpanda-connect-docs.tar.gz release asset'])
    expect(fromConnect(catalog)).toHaveLength(0)
    expect(catalogUtil.getResolvedConnectRef()).toBe('v4.113.0')
    expect(error.message).toMatch(/no generated components:partial\$fields\/\*/)
  })

  it('fails the build, naming the fallback release, when its download fails', async () => {
    global.fetch = jest.fn(async (url) => response(url.includes('/v4.113.0/') ? 404 : 502))
    listConnectReleases.mockResolvedValue([release('v4.113.0'), release('v4.112.0', { withAsset: true })])
    const { error } = await build()
    expect(error.message).toMatch(/Could not download the Redpanda Connect reference docs for v4\.112\.0: .*HTTP 502/)
  })
})

describe('list-connect-releases', () => {
  const list = jest.requireActual('../../extensions/version-fetcher/list-connect-releases')
  it('asks for one page of at most the limit and never returns more', async () => {
    const listReleases = jest.fn(async () => ({ data: Array.from({ length: 12 }, (_, i) => release(`v4.${100 - i}.0`)) }))
    const releases = await list({ rest: { repos: { listReleases } } }, 'redpanda-data', 'connect', 10)
    expect(listReleases).toHaveBeenCalledTimes(1)
    expect(listReleases).toHaveBeenCalledWith({ owner: 'redpanda-data', repo: 'connect', per_page: 10 })
    expect(releases).toHaveLength(10)
  })
  it('throws when the API fails, so the caller can probe git tags', async () => {
    const listReleases = jest.fn(async () => { throw new Error('Bad credentials') })
    await expect(list({ rest: { repos: { listReleases } } }, 'redpanda-data', 'connect', 10)).rejects.toThrow(/Bad credentials/)
  })
})
