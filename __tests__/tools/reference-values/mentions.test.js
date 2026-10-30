'use strict'

jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

// Unlinked mentions: rpk commands, Connect components and Bloblang calls in
// inline code with no link on the page. The checkouts are built from the real
// rpk page paths of docs, cloud-docs and adp-docs (rpk-pages-sample.json) and
// the real Connect pages of rp-connect-docs and the Cloud stubs
// (connect-links/pages-sample.json), with the trimmed rpk and Connect data.
// Each prose line is quoted from docs 2eb070ff, cloud-docs aab67ef or
// rp-connect-docs 62216a2 unless the test says it changed one.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { scanAll, failsAt, renderMarkdown, runCli, SetupError } = require('../../../tools/reference-values')
const mentions = require('../../../tools/reference-values/mentions')
const { SAMPLE: CONNECT_SAMPLE, PAGES: CONNECT_PAGES } = require('../../helpers/connect-links-catalog')

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'rpkval')
const RPK = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mentions-data-')), 'rpk-v26.2.2.json')
fs.copyFileSync(path.join(FIXTURES, 'rpk-v26.2.2-sample.json'), RPK)
const RPK_PAGES = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'rpk-pages-sample.json'), 'utf8'))

const temps = [path.dirname(RPK)]
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
})
const put = (dir, file, content) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), content)
}
const page = (...lines) => ['= Page', '', ...lines, ''].join('\n')

const COMPONENTS = {
  streaming: { version: '26.2', attributes: {} },
  'cloud-data-platform': { version: '', attributes: { 'env-cloud': true } },
  'agentic-data-plane': { version: '', attributes: { 'env-adp': true } },
  connect: { version: '', attributes: {} },
}

// One checkout: its real rpk pages, its real Connect pages (Cloud's as stubs
// that include the connect page), the data it publishes, and the files.
function checkout (name, files = {}, { nav } = {}) {
  const c = COMPONENTS[name]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentions-'))
  temps.push(dir)
  const attrs = Object.entries(c.attributes).map(([k, v]) => `    ${k}: ${v}`).join('\n')
  put(dir, 'antora.yml', `name: ${name}\nversion: ${c.version ? `'${c.version}'` : '~'}\n${nav ? `nav:\n${nav.map((n) => `- ${n}`).join('\n')}\n` : ''}${attrs ? `asciidoc:\n  attributes:\n${attrs}\n` : ''}`)
  for (const relative of (RPK_PAGES.components.find((x) => x.name === name) || { pages: [] }).pages) {
    put(dir, `modules/reference/pages/${relative}`, `= ${relative}\n\nGenerated.\n`)
  }
  for (const p of CONNECT_PAGES[name] || []) {
    const key = p.relative.replace(/\.adoc$/, '')
    const aliases = p.aliases.length ? `:page-aliases: ${p.aliases.join(', ')}\n` : ''
    const connectPath = p.aliases[0] ? p.aliases[0].replace(/^[\w-]+:/, '') : p.relative
    const body = name === 'connect'
      ? `= ${key}\n${aliases}\nGenerated.\n`
      : `= ${key}\n${aliases}include::connect:${p.relative.includes('/guides/') ? 'guides' : 'components'}:${connectPath}[tag=single-source]\n`
    put(dir, `modules/${p.module}/pages/${p.relative}`, body)
  }
  if (name === 'streaming') put(dir, 'modules/reference/attachments/rpk-v26.2.2.json', fs.readFileSync(RPK))
  if (name === 'connect') put(dir, 'modules/components/attachments/connect-4.115.1.json', CONNECT_SAMPLE)
  for (const [file, content] of Object.entries(files)) put(dir, file, content)
  return dir
}

const LENDERS = { streaming: ['cloud-data-platform', 'connect'], 'cloud-data-platform': ['streaming', 'connect'], connect: ['streaming', 'cloud-data-platform'], 'agentic-data-plane': ['streaming', 'connect'] }

function scan (name, files, { lenders = LENDERS[name], nav, write = false, writeLinks = false, failOn = 'mismatch', kinds = ['rpk', 'connect'] } = {}) {
  const docsDir = checkout(name, files, { nav })
  const lenderDirs = lenders.map((n) => checkout(n))
  const result = scanAll({ docsDir, lenderDirs, dataFiles: [RPK], kinds, kindsExplicit: true, write, writeLinks, failOn })
  const all = Object.values(result.kinds).flatMap((r) => r.findings)
  return { result, docsDir, found: all.filter((f) => f.status === mentions.STATUS && Object.keys(files).includes(f.file)) }
}
const summary = (found) => found.map((f) => [f.line, f.mention, f.written])

// docs modules/manage/partials/authentication.adoc:930 and :1459.
const AUTH_LINKED = 'Create a topic as the `myuser` user by running xref:reference:rpk/rpk-topic/rpk-topic-create.adoc[`rpk topic create`]:'
const AUTH_LIST = 'The same `-X sasl.mechanism` and `-X pass` options work for any `rpk` command that talks to the Kafka API (for example, `rpk topic create`, `rpk topic produce`, `rpk topic consume`, `rpk group list`, `rpk cluster info`, and `rpk security acl list`).'

describe('rpk commands', () => {
  test('docs authentication.adoc: each command once, except the one the page links, and none the data lacks', () => {
    const { found } = scan('streaming', { 'modules/manage/partials/authentication.adoc': page(AUTH_LIST, '', AUTH_LINKED, '', AUTH_LIST) })
    // rpk topic produce and rpk group list are not in the trimmed data.
    expect(summary(found)).toEqual([
      [3, 'rpk-command', '`rpk topic consume`'],
      [3, 'rpk-command', '`rpk cluster info`'],
      [3, 'rpk-command', '`rpk security acl list`'],
    ])
    expect(found[0]).toMatchObject({ kind: 'rpk', check: 'mention', reason: 'unlinked-mention', target: 'rpk topic consume', dataValue: '26.2@streaming:reference:rpk/rpk-topic/rpk-topic-consume.adoc', proposed: 'rpkcmd:[rpk topic consume]', linkable: true, failing: false })
  })

  test('an rpkcmd: link counts as a link, wherever it is on the page', () => {
    const { found } = scan('streaming', { 'modules/manage/pages/x.adoc': page(AUTH_LIST, '', 'Run rpkcmd:[rpk cluster info] to check.') })
    expect(found.map((f) => f.target)).toEqual(['rpk topic create', 'rpk topic consume', 'rpk security acl list'])
  })

  test('docs deferred-finalization.adoc:209: flags are a mention, but a second flag has no rpkcmd: form', () => {
    // Moved out of modules/upgrade/, whose pages are upgrade notes and never read.
    const line = '* *Brokers advertise the new release version during the soak.* The Admin API, health reports, `rpk cluster info -b --detailed`, and the Redpanda Console broker view all show the new release string while unfinalized; only the logical version and feature activation are held back.'
    const [f] = scan('streaming', { 'modules/manage/pages/deferred-finalization.adoc': page(line) }).found
    expect(f).toMatchObject({ written: '`rpk cluster info -b --detailed`', linkable: false, note: expect.stringContaining('link the command page by hand') })
    expect(f.proposed).toBeUndefined()
  })

  test('one flag is written as rpkcmd: with the flag', () => {
    // Changed: the command in deferred-finalization.adoc:209 with one flag.
    const [f] = scan('streaming', { 'modules/x/pages/x.adoc': page('Health reports and `rpk cluster info --detailed` show the new release string.') }).found
    expect(f.proposed).toBe('rpkcmd:[rpk cluster info --detailed]')
  })

  test('cloud-docs get-started-serverless.adoc:17: a command with an argument is an example to run, not a mention', () => {
    expect(scan('cloud-data-platform', { 'modules/get-started/partials/get-started-serverless.adoc': page('. Consume from the `hello-world` topic with `rpk topic consume hello-world`.') }).found).toEqual([])
  })

  test('docs acl.adoc:455: a placeholder flag value is a flag value, reported with no proposal', () => {
    const [f] = scan('streaming', { 'modules/manage/pages/security/authorization/acl.adoc': page('3. *Verify access*: `rpk security acl list --allow-principal <username>`') }).found
    expect(f).toMatchObject({ target: 'rpk security acl list', written: '`rpk security acl list --allow-principal <username>`', linkable: false, note: expect.stringContaining('a placeholder') })
    expect(f.proposed).toBeUndefined()
  })

  test('a positional placeholder is a syntax line, not an example to run', () => {
    // Changed: cluster-property-configuration.adoc:74, `rpk cluster config get <property_name>`, with a command the trimmed data has.
    const { found } = scan('streaming', { 'modules/manage/pages/x.adoc': page('To see the messages in a topic, run `rpk topic consume <topic_name>`. For example:') })
    expect(summary(found)).toEqual([[3, 'rpk-command', '`rpk topic consume <topic_name>`']])
    expect(found[0].proposed).toBeUndefined()
  })

  test('docs http-proxy.adoc:66: a command streaming has no page for links the Cloud page', () => {
    const [f] = scan('streaming', { 'modules/develop/partials/http-proxy.adoc': page('To log in to your Redpanda Cloud account, run `rpk cloud login`.') }).found
    expect(f.dataValue).toBe('cloud-data-platform:reference:rpk/rpk-cloud/rpk-cloud-login.adoc')
  })

  test('cloud-docs cloud-overview.adoc:377: a command Cloud has no page for is never reported on Cloud', () => {
    expect(scan('cloud-data-platform', { 'modules/get-started/pages/cloud-overview.adoc': page('** `rpk cluster self-test`', '** `rpk cluster info`') }).found.map((f) => f.target)).toEqual(['rpk cluster info'])
  })
})

describe('Connect components and Bloblang calls', () => {
  test('rp-connect-docs jira.adoc:43 and cdc_schema_registry.adoc:151: a component named with its type', () => {
    const { found } = scan('connect', {
      'modules/cookbooks/pages/jira.adoc': page('To use Jira as an input, combine the `generate` input with the Jira processor. This pattern triggers Jira queries at regular intervals or on-demand.'),
      'modules/cookbooks/pages/cdc_schema_registry.adoc': page('The `mapping` processor changes only metadata, so the message body and its `schema` metadata reach `schema_registry_encode` unchanged.'),
    })
    expect(found.map((f) => [f.file, f.written, f.proposed, f.dataValue])).toEqual([
      ['modules/cookbooks/pages/cdc_schema_registry.adoc', '`mapping` processor', 'connect:[processors/mapping]', 'connect:components:processors/mapping.adoc'],
      ['modules/cookbooks/pages/jira.adoc', '`generate` input', 'connect:[inputs/generate]', 'connect:components:inputs/generate.adoc'],
    ])
  })

  test('postgres_cdc.adoc:181: the type must be the component\'s, and the label carries over when it is not the default', () => {
    const line = '* Set `incremental_snapshot.checkpoint_cache` to a xref:components:caches/about.adoc[cache resource]. The input stores snapshot progress in this cache, so a restart resumes the snapshot instead of starting over. Use a cache that persists across restarts, such as `redis`. With a `memory` cache, a restart starts the snapshot over.'
    // Changed: a second page with a type that is not the component's.
    const { found } = scan('connect', { 'modules/cookbooks/pages/postgres_cdc.adoc': page(line), 'modules/cookbooks/pages/x.adoc': page('The `memory` output does not exist, and the `mapping` Processor does.') })
    expect(found.map((f) => [f.file, f.written, f.proposed])).toEqual([
      ['modules/cookbooks/pages/postgres_cdc.adoc', '`memory` cache', 'connect:[caches/memory]'],
      ['modules/cookbooks/pages/x.adoc', '`mapping` Processor', 'connect:[processors/mapping,`mapping` Processor]'],
    ])
  })

  test('a name with an underscore outside code is a mention too, with its text as the label', () => {
    // Changed: the :description: of bigquery_cdc_migration.adoc, as prose.
    const { found } = scan('connect', { 'modules/components/pages/outputs/bigquery_cdc_migration.adoc': page('Migrate a CDC pipeline from the load-jobs based gcp_bigquery output to the Storage Write API gcp_bigquery_write_api output.') })
    expect(found.map((f) => [f.written, f.proposed])).toEqual([['gcp_bigquery_write_api output', 'connect:[outputs/gcp_bigquery_write_api,gcp_bigquery_write_api output]']])
  })

  test('dynamodb_cdc.adoc:90 and :153, scheduled_pipelines.adoc:71, advanced.adoc:125: Bloblang calls in Connect content', () => {
    const { found } = scan('connect', {
      'modules/cookbooks/pages/dynamodb_cdc.adoc': page('- Filters out `REMOVE` events using `deleted()`', '', 'NOTE: This pattern requires the `NEW_AND_OLD_IMAGES` stream view type. The `.key_values()` method converts an object to an array of key-value pairs that can be filtered and mapped.'),
      'modules/cookbooks/pages/scheduled_pipelines.adoc': page('The schedule is in UTC, but the `now()` function returns the time in the time zone of the machine that runs the pipeline.'),
      'modules/guides/pages/bloblang/advanced.adoc': page("Here's a mapping that achieves this by using a `count` function to detect the very first invocation of the mapping in a stream pipeline:"),
    })
    expect(found.map((f) => [f.mention, f.written, f.proposed])).toEqual([
      ['bloblang-function', '`deleted()`', 'blobl:[deleted()]'],
      ['bloblang-method', '`.key_values()`', 'blobl:[.key_values()]'],
      ['bloblang-function', '`now()`', 'blobl:[now()]'],
      ['bloblang-function', '`count` function', 'blobl:[count(),`count` function]'],
    ])
  })

  test('cloud-docs SQL reference distinct.adoc:103 and docs monitor-health.adoc:553: SQL and PromQL calls are not Bloblang', () => {
    const sql = scan('cloud-data-platform', { 'modules/reference/pages/sql/sql-functions/aggregate-functions/distinct.adoc': page('The following example uses `DISTINCT` qualifier combined with `count()` function to calculate the number of unique car brands in rentals:') })
    expect(sql.found).toEqual([])
    // Changed: now() in place of max(), which the trimmed data lacks.
    const promql = scan('streaming', { 'modules/manage/partials/monitor-health.adoc': page('Use `now()`, not `sum()`. Every broker reports its own copy.') })
    expect(promql.found).toEqual([])
  })

  test('a Cloud Connect page is Connect content, and links its stubs', () => {
    // cloud-docs modules/develop/pages/connect/cookbooks/jira.adoc:34
    const { found } = scan('cloud-data-platform', { 'modules/develop/pages/connect/cookbooks/jira.adoc': page('To use Jira as an input, combine the `generate` input with the Jira processor.', '', 'Filter with `deleted()`.') })
    expect(found.map((f) => f.dataValue)).toEqual(['cloud-data-platform:develop:connect/components/inputs/generate.adoc', 'cloud-data-platform:develop:connect/guides/bloblang/functions.adoc'])
  })

  test('the page links the target: an xref with a fragment, a Cloud stub path, connect: or blobl:', () => {
    const { found } = scan('connect', {
      'modules/cookbooks/pages/a.adoc': page('The `generate` input.', '', 'See xref:components:inputs/generate.adoc#fields[the fields].'),
      'modules/cookbooks/pages/b.adoc': page('The `mapping` processor and `now()`.', '', 'Use connect:[processors/mapping] with blobl:[now()].'),
      'modules/cookbooks/pages/c.adoc': page('The `.uppercase()` method.', '', 'See xref:guides:bloblang/methods.adoc#uppercase[uppercase].'),
      // rp-connect-docs unit_testing.adoc:9 and :358, which links mapping
      // through the attribute at :260.
      'modules/configuration/pages/unit_testing.adoc': [
        '= Unit testing',
        ':processors-mapping-url: xref:components:processors/mapping.adoc',
        '',
        "Most of the time you'll want to use a [`mapping` processor][processors.mapping] here, and use it to create a result that emulates the target processor.",
        '',
      ].join('\n'),
    })
    expect(found).toEqual([])
  })

  test('the target\'s own page and its partials are skipped', () => {
    const { found } = scan('connect', {
      'modules/components/pages/inputs/generate.adoc': page('The `generate` input creates messages.'),
      'modules/components/partials/components/processors/mapping.adoc': page('The `mapping` processor maps.'),
      'modules/guides/pages/bloblang/functions.adoc': page('The `now()` function.'),
    })
    expect(found).toEqual([])
  })
})

describe('where mentions are never read', () => {
  const LINE = 'To use Jira as an input, combine the `generate` input with the Jira processor.'

  test.each([
    ['a heading', ['== The `generate` input']],
    ['a block title', ['.The `generate` input', '----', 'x', '----']],
    ['a listing', ['----', LINE, '----']],
    ['a comment', [`// ${LINE}`]],
    ['a description list term', ['`generate` input:: Creates messages.']],
    ['a link label', ['See xref:components:inputs/about.adoc[the `generate` input].']],
    ['a URL label in an attribute', ['Replace it with a {processors-mapping-url}[`mapping` processor].']],
    ['an explicit table header row', ['[%header]', '|===', '| The `generate` input | Notes', '', '| a | b', '|==='].concat()],
    ['an implicit table header row', ['|===', '| The `generate` input | Notes', '', '| a | b', '|===']],
  ])('%s', (name, lines) => {
    expect(scan('connect', { 'modules/cookbooks/pages/x.adoc': page(...lines) }, { kinds: ['connect'] }).found).toEqual([])
  })

  test('a table body row is read', () => {
    const { found } = scan('connect', { 'modules/cookbooks/pages/x.adoc': page('|===', '| Component | Notes', '', '| The `generate` input | b', '|===') }, { kinds: ['connect'] })
    expect(found.map((f) => f.line)).toEqual([6])
  })

  test('release notes, upgrade notes and nav files', () => {
    const { found } = scan('connect', {
      'modules/get-started/pages/whats-new.adoc': page(LINE),
      'modules/upgrade/pages/x.adoc': page(LINE),
      'modules/ROOT/nav.adoc': page(LINE),
    }, { nav: ['modules/ROOT/nav.adoc'], kinds: ['connect'] })
    expect(found).toEqual([])
  })

  test('// value-check: ignore skips the line, and the next mention is the first', () => {
    const { found } = scan('connect', { 'modules/cookbooks/pages/x.adoc': page('// value-check: ignore', LINE, '', LINE) }, { kinds: ['connect'] })
    expect(found.map((f) => f.line)).toEqual([6])
  })
})

describe('failing, reporting and writing', () => {
  const FILES = { 'modules/manage/partials/authentication.adoc': page(AUTH_LIST) }

  test('never fails at mismatch or any; fails at links', () => {
    const { found } = scan('streaming', FILES)
    expect(found.length).toBeGreaterThan(0)
    for (const level of ['none', 'mismatch', 'any']) expect(failsAt('rpk', found[0], level)).toBe(false)
    expect(failsAt('rpk', found[0], 'links')).toBe(true)
    // rpk topic produce and rpk group list, which the trimmed data lacks, are
    // unknown-command errors at every level.
    expect(scan('streaming', FILES).result.failing).toBe(2)
    expect(scan('streaming', FILES, { failOn: 'links' }).result.failing).toBe(6)
  })

  test('counts by kind in the result and the Markdown report', () => {
    const { result } = scan('connect', { 'modules/cookbooks/pages/x.adoc': page('The `generate` input with `now()`.') })
    expect(result.kinds.connect.counts).toMatchObject({ unlinkedMentions: 2, unlinkedMentionsByKind: { 'connect-component': 1, 'bloblang-function': 1 } })
    const md = renderMarkdown(result)
    expect(md).toContain('### Unlinked mentions (2: 1 connect-component, 1 bloblang-function)')
    expect(md).toContain('| modules/cookbooks/pages/x.adoc:3 | connect-component | `generate` input | connect:components:inputs/generate.adoc | `connect:[inputs/generate]` |')
  })

  test('--write alone leaves mentions as written', () => {
    const { docsDir, found } = scan('streaming', FILES, { write: true })
    expect(found.some((f) => f.applied)).toBe(false)
    expect(fs.readFileSync(path.join(docsDir, 'modules/manage/partials/authentication.adoc'), 'utf8')).toContain('`rpk topic consume`')
  })

  test('--write --write-links turns them into links that render the same text', () => {
    const { docsDir, found } = scan('streaming', FILES, { write: true, writeLinks: true })
    expect(found.every((f) => f.applied)).toBe(true)
    expect(fs.readFileSync(path.join(docsDir, 'modules/manage/partials/authentication.adoc'), 'utf8')).toContain('(for example, rpkcmd:[rpk topic create], `rpk topic produce`, rpkcmd:[rpk topic consume], `rpk group list`, rpkcmd:[rpk cluster info], and rpkcmd:[rpk security acl list]).')
  })

  test('--write --write-links keeps a Connect label as written', () => {
    const { docsDir } = scan('connect', { 'modules/cookbooks/pages/x.adoc': page('The `mapping` Processor and the `count` function.') }, { write: true, writeLinks: true })
    expect(fs.readFileSync(path.join(docsDir, 'modules/cookbooks/pages/x.adoc'), 'utf8')).toContain('The connect:[processors/mapping,`mapping` Processor] and the blobl:[count(),`count` function].')
  })

  test('--write-links without --write is a setup error, exit 2', () => {
    expect(() => scan('streaming', FILES, { writeLinks: true })).toThrow(SetupError)
    const errors = []
    const dir = checkout('streaming', FILES)
    expect(runCli({ docsDir: dir, dataFile: [RPK], writeLinks: true, reportDir: dir }, { log: () => {}, error: (m) => errors.push(m) })).toBe(2)
    expect(errors[0]).toBe('Error: --write-links converts unlinked mentions only with --write')
  })
})

describe('skippedLines', () => {
  test('marks header rows and description list terms only', () => {
    const lines = ['[cols="1,1",options="header"]', '|===', '| A | B', '| c | d', '|===', '', 'term:: text', '* item:: not a term', '|===', '| e | f', '| g | h', '|===']
    expect([...mentions.skippedLines(lines)]).toEqual([2, 6])
  })
})
