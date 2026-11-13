'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const { generateRpkDocs } = require('../../../tools/rpk-docs/generate-rpk-docs.js')
const { validateDirectory } = require('../../../tools/rpk-docs/validate-output.js')
const { buildDocsResolverContext } = require('../../../cli-utils/docs-links-to-xrefs')
const { makeAntoraCheckout } = require('../../helpers/antora-checkout')

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures')

// Trimmed from raw_tree in redpanda-data/docs docs-data/rpk-v26.2.2.json:
// every rpk command whose help text links to docs.redpanda.com.
const cmd = (name, description, commands) => ({
  name,
  description,
  usage: `rpk ${name} [flags]`,
  flags: [],
  ...(commands ? { commands } : {}),
})
const TREE = {
  name: 'rpk',
  description: 'rpk is the Redpanda CLI & toolbox',
  global_flags: [],
  commands: [
    cmd('connect', 'A stream processor for mundane tasks - https://docs.redpanda.com/redpanda-connect', [
      cmd('blobl', 'Provides a convenient tool for mapping JSON documents over the command line.\n\nFind out more about Bloblang at: https://docs.redpanda.com/redpanda-connect/guides/bloblang/about'),
      cmd('streams', 'Run Redpanda Connect in streams mode.\n\nFor more information check out the docs at:\nhttps://docs.redpanda.com/redpanda-connect/guides/streams_mode/about'),
      cmd('template', 'Allows linting and generating Redpanda Connect templates.\n\nFor more information check out the docs at:\nhttps://docs.redpanda.com/redpanda-connect/configuration/templating'),
      cmd('test', 'Execute any number of Redpanda Connect unit test definitions.\n\nFor more information check out the docs at:\nhttps://docs.redpanda.com/redpanda-connect/configuration/unit_testing'),
    ]),
    cmd('cluster', 'Interact with a Redpanda cluster.', [
      cmd('storage', 'Manage the cluster storage.', [
        cmd('restore', 'Interact with the topic restoration process.', [
          cmd('start', 'Start the cluster restoration process.\n\nUse --cluster-uuid-override if you want to specify an explicit cluster UUID\nto restore from. For more information, visit https://docs.redpanda.com/current/manage/disaster-recovery/whole-cluster-restore/.\n'),
        ]),
      ]),
      cmd('connections', 'Manage and monitor cluster connections.', [
        cmd('list', 'Display statistics about current kafka connections.\n\nTo understand the syntax of these arguments, refer to the admin API docs of the filter and order-by fields of the ListKafkaConnections endpoint: https://docs.redpanda.com/api/doc/admin/version/11f41833-5783-4f1a-ad64-5957267abd52/operation/operation-redpanda-core-admin-v2-clusterservice-listkafkaconnections'),
      ]),
    ]),
  ],
}

const read = (dir, ...parts) => fs.readFileSync(path.join(dir, ...parts), 'utf8')
const rawUrlMessages = (validation) =>
  validation.results.flatMap((r) => [...r.warnings, ...r.info].filter((i) => i.rule === 'raw-external-urls').map((i) => `${r.file}: ${i.message}`))

describe('rpk docs link conversion', () => {
  jest.setTimeout(60000)
  let docsRoot
  let connectRoot
  let outDir

  beforeAll(() => {
    docsRoot = makeAntoraCheckout(path.join(FIXTURES, 'docs-links-component'))
    connectRoot = makeAntoraCheckout(path.join(FIXTURES, 'docs-links-connect'))
  })

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-docs-links-'))
  })

  afterEach(() => fs.rmSync(outDir, { recursive: true, force: true }))

  afterAll(() => {
    for (const root of [docsRoot, connectRoot]) fs.rmSync(root, { recursive: true, force: true })
  })

  const generate = (docsLinkContext) =>
    generateRpkDocs({ tree: TREE, outputDir: path.join(outDir, 'pages'), cloudSecretDir: path.join(outDir, 'partials'), rpkVersion: 'v26.2.2', docsLinkContext })

  test('without a docs checkout, pages keep the raw URLs and validation says why', async () => {
    const result = await generate(null)
    expect(result.docsLinks).toBeNull()
    const pages = path.join(outDir, 'pages')
    expect(read(pages, 'rpk-connect', 'rpk-connect-blobl.adoc')).toContain('https://docs.redpanda.com/redpanda-connect/guides/bloblang/about')
    const messages = rawUrlMessages(validateDirectory(pages, { showInfo: true }))
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.every((m) => m.includes('no docs checkout was given'))).toBe(true)
  })

  test('with the docs checkout only, converts the same-component URL and reports the Connect URLs as not loaded', async () => {
    const context = await buildDocsResolverContext(docsRoot, { cacheDir: path.join(outDir, '.cache') })
    const result = await generate(context)
    const pages = path.join(outDir, 'pages')
    expect(read(pages, 'rpk-cluster', 'rpk-cluster-storage-restore-start.adoc')).toContain('visit xref:manage:disaster-recovery/whole-cluster-restore.adoc[].')
    expect(read(pages, 'rpk-connect', 'rpk-connect-blobl.adoc')).toContain('https://docs.redpanda.com/redpanda-connect/guides/bloblang/about')
    expect(result.docsLinks.converted).toBe(1)
    expect(result.docsLinks.unmapped).toEqual(expect.arrayContaining([
      'https://docs.redpanda.com/redpanda-connect',
      'https://docs.redpanda.com/redpanda-connect/guides/bloblang/about',
    ]))

    const messages = rawUrlMessages(validateDirectory(pages, { showInfo: true, docsLinks: { result: result.docsLinks, context } }))
    const blobl = messages.find((m) => m.startsWith(path.join('rpk-connect', 'rpk-connect-blobl.adoc')) && m.endsWith('/guides/bloblang/about'))
    expect(blobl).toContain('it points at the connect component, which this run did not load')
    // The API reference URL is outside the catalog: still raw, and said so.
    expect(messages.find((m) => m.includes('/api/doc/admin/'))).toContain('outside the Antora catalog')
    // The converted URL is no longer reported anywhere in the page body.
    expect(messages.some((m) => m.startsWith(path.join('rpk-cluster', 'rpk-cluster-storage-restore-start.adoc')) && m.includes('whole-cluster-restore') && !m.includes('attribute entry'))).toBe(false)
  })

  test('with a Connect lender, converts every rpk docs URL except the API reference into an xref', async () => {
    const context = await buildDocsResolverContext(docsRoot, { lenders: [connectRoot], cacheDir: path.join(outDir, '.cache') })
    const result = await generate(context)
    const pages = path.join(outDir, 'pages')
    expect(read(pages, 'rpk-connect', 'rpk-connect.adoc')).toContain('A stream processor for mundane tasks - xref:connect:home:index.adoc[]')
    expect(read(pages, 'rpk-connect', 'rpk-connect-blobl.adoc')).toContain('xref:connect:guides:bloblang/about.adoc[]')
    expect(read(pages, 'rpk-connect', 'rpk-connect-streams.adoc')).toContain('xref:connect:guides:streams_mode/about.adoc[]')
    expect(read(pages, 'rpk-connect', 'rpk-connect-template.adoc')).toContain('xref:connect:configuration:templating.adoc[]')
    expect(read(pages, 'rpk-connect', 'rpk-connect-test.adoc')).toContain('xref:connect:configuration:unit_testing.adoc[]')
    expect(read(pages, 'rpk-cluster', 'rpk-cluster-storage-restore-start.adoc')).toContain('xref:manage:disaster-recovery/whole-cluster-restore.adoc[]')
    expect(read(pages, 'rpk-cluster', 'rpk-cluster-connections-list.adoc')).toContain('https://docs.redpanda.com/api/doc/admin/version/11f41833')
    expect(result.docsLinks).toEqual({ converted: 6, unmapped: [], withQueryString: [], withoutLinkText: [], missingAnchor: [] })

    const validation = validateDirectory(pages, { showInfo: true, docsLinks: { result: result.docsLinks, context } })
    const bodyMessages = rawUrlMessages(validation).filter((m) => !m.includes('attribute entry'))
    expect(bodyMessages).toEqual([
      `${path.join('rpk-cluster', 'rpk-cluster-connections-list.adoc')}: Raw docs.redpanda.com URL left as written (the path is served outside the Antora catalog (the API reference or the MCP endpoint)): https://docs.redpanda.com/api/doc/admin/version/11f41833-5783-4f1a-ad64-5957267abd52/operation/operation-redpanda-core-admin-v2-clusterservice-listkafkaconnections`,
    ])
    expect(validation.summary.totalWarnings).toBe(0)
  })
})
