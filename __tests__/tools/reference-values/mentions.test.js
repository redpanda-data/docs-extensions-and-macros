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

function scan (name, files, { lenders = LENDERS[name], lenderFiles = {}, data = RPK, nav, write = false, writeLinks = false, failOn = 'mismatch', kinds = ['rpk', 'connect'] } = {}) {
  const docsDir = checkout(name, files, { nav })
  const lenderDirs = lenders.map((n) => checkout(n, lenderFiles[n]))
  const result = scanAll({ docsDir, lenderDirs, dataFiles: [data], kinds, kindsExplicit: true, write, writeLinks, failOn })
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

describe('judged on the pages that render the line', () => {
  // The trimmed data has rpk ai but none of its subcommands these pages
  // name, so this copy adds them, as rpk v26.2.2 has them.
  const AI_DATA = path.join(path.dirname(RPK), 'ai', 'rpk-v26.2.2.json')
  const aiData = JSON.parse(fs.readFileSync(RPK, 'utf8'))
  const ai = aiData.tree.commands.find((c) => c.name === 'ai')
  const node = (name, commands = []) => ({ name, usage: `rpk ai ${name} [flags]`, aliases: [], flags: [], commands })
  ai.commands.push(node('upgrade'), node('auth', [node('login')]), node('env', [node('list')]))
  fs.mkdirSync(path.dirname(AI_DATA), { recursive: true })
  fs.writeFileSync(AI_DATA, JSON.stringify(aiData))

  // adp-docs 8af585a: two pages include the same two partials of the cli
  // module, after they link rpk ai and rpk ai upgrade.
  const UPGRADE_NOTE = 'NOTE: Upgrading `rpk` does not upgrade the plugin. The plugin is a separate binary that stays at its installed version, even across `rpk` upgrades, until you run `rpk ai upgrade`. New commands and flags in the reference marked "introduced in ai version X" require the plugin at that version or later.\n'
  const SIGNIN = [
    '[NOTE]',
    '====',
    '// Keep these comments inside the NOTE. The partial is included right after a + list continuation, and a comment line there detaches the NOTE and restarts the step numbering.',
    '// Shared by cli:index.adoc and gateway:connect-agent.adoc so both sign-in steps carry the same wording.',
    '// Source: the --email, --connection, and --no-browser flags are in the `rpk ai auth login` reference (docs repo modules/reference/partials/rpk-ai/rpk-ai-auth-login.adoc), which also states that a successful login rewrites the config in the current schema. The 0.2.90 plugin requirement was reported in the docs team Slack thread, 2026-10-19, and is not recorded in the reference.',
    'If the browser opens the wrong sign-in provider, or your email address belongs to more than one Redpanda Cloud organization, pass `--email <address>` so `rpk ai` looks up your sign-in provider before the browser opens, or `--connection <name>` to name the Auth0 connection directly. Both flags require the plugin at version 0.2.90 or later. If the browser keeps reusing an earlier session, add `--no-browser` and open the printed URL in a private window.',
    '',
    'After a plugin upgrade, `rpk ai env list` reports that no environments are configured until you run `rpk ai auth login` again. This is expected, because the login rewrites the config.',
    '====',
    '',
  ].join('\n')
  const ADP = {
    'modules/cli/partials/rpk-ai-upgrade-note.adoc': UPGRADE_NOTE,
    'modules/cli/partials/rpk-ai-signin-troubleshooting.adoc': SIGNIN,
    // index.adoc:14, :34, :36, :55, and the exit-code table row at :361.
    'modules/cli/pages/index.adoc': page(
      'The Agentic Data Plane CLI, also called the Redpanda AI CLI, runs as an xref:reference:rpk/rpk-ai/rpk-ai.adoc[`rpk`] plugin, so you install and run it through your existing `rpk` setup.',
      '',
      'Update the plugin later with xref:reference:rpk/rpk-ai/rpk-ai-upgrade.adoc[`rpk ai upgrade`], and remove it with xref:reference:rpk/rpk-ai/rpk-ai-uninstall.adoc[`rpk ai uninstall`].',
      '',
      'include::partial$rpk-ai-upgrade-note.adoc[]',
      '',
      'include::partial$rpk-ai-signin-troubleshooting.adoc[]',
      '',
      '|===',
      '|Exit code |Meaning',
      '',
      '|3',
      '|Not authenticated or not authorized. Either your credentials are missing or expired, or your account lacks a permission the command needs. Run `rpk ai auth login` and retry.',
      '|===',
    ),
    // connect-agent.adoc:10, :78, :80, :89 and :108.
    'modules/gateway/pages/connect-agent.adoc': page(
      'This guide shows how to connect your glossterm:AI agent[] or application to the AI Gateway. You construct the proxy URL for a provider you have already created, authenticate (with the xref:reference:rpk/rpk-ai/rpk-ai.adoc[`rpk ai`] CLI for local development, with OIDC client credentials for CI and application code, or with an <<authenticate-with-an-api-key,API key>> for a long-lived client), and send your first request with the SDK of your choice.',
      '',
      'Update later with xref:reference:rpk/rpk-ai/rpk-ai-upgrade.adoc[`rpk ai upgrade`]. Remove with xref:reference:rpk/rpk-ai/rpk-ai-uninstall.adoc[`rpk ai uninstall`].',
      '',
      'include::cli:partial$rpk-ai-upgrade-note.adoc[]',
      '',
      'include::cli:partial$rpk-ai-signin-troubleshooting.adoc[]',
      '',
      'If the cached token has expired, `rpk ai` returns a 401. Rerun `rpk ai auth login` to refresh it.',
    ),
  }
  const at = (found) => found.map((f) => [f.file, f.line, f.written])
  const BOTH = ['modules/cli/pages/index.adoc', 'modules/gateway/pages/connect-agent.adoc']

  test('adp-docs rpk-ai-upgrade-note.adoc:1 and rpk-ai-signin-troubleshooting.adoc:6: a partial every including page already links is not reported', () => {
    const { found } = scan('agentic-data-plane', ADP, { data: AI_DATA, kinds: ['rpk'] })
    expect(at(found)).toEqual([
      ['modules/cli/partials/rpk-ai-signin-troubleshooting.adoc', 8, '`rpk ai env list`'],
      ['modules/cli/partials/rpk-ai-signin-troubleshooting.adoc', 8, '`rpk ai auth login`'],
    ])
    // Reported at the partial, naming the pages it is the first mention on;
    // the pages' later rpk ai auth login (index.adoc:361,
    // connect-agent.adoc:108) is no longer their first.
    expect(found[1]).toMatchObject({ pages: BOTH, note: `the first mention on ${BOTH.join(', ')}, which do not link it`, proposed: 'rpkcmd:[rpk ai auth login]' })
  })

  test('a partial no page includes is judged on its own file', () => {
    const files = { 'modules/cli/partials/rpk-ai-upgrade-note.adoc': UPGRADE_NOTE, 'modules/cli/partials/rpk-ai-signin-troubleshooting.adoc': SIGNIN }
    const { found } = scan('agentic-data-plane', files, { data: AI_DATA, kinds: ['rpk'] })
    expect(at(found)).toEqual([
      ['modules/cli/partials/rpk-ai-signin-troubleshooting.adoc', 6, '`rpk ai`'],
      ['modules/cli/partials/rpk-ai-signin-troubleshooting.adoc', 8, '`rpk ai env list`'],
      ['modules/cli/partials/rpk-ai-signin-troubleshooting.adoc', 8, '`rpk ai auth login`'],
      ['modules/cli/partials/rpk-ai-upgrade-note.adoc', 1, '`rpk ai upgrade`'],
    ])
    expect(found.every((f) => f.pages === undefined && f.note === undefined)).toBe(true)
  })

  test('--write-links converts only the mentions reported on the pages', () => {
    const { docsDir } = scan('agentic-data-plane', ADP, { data: AI_DATA, kinds: ['rpk'], write: true, writeLinks: true })
    const read = (file) => fs.readFileSync(path.join(docsDir, file), 'utf8')
    expect(read('modules/cli/partials/rpk-ai-upgrade-note.adoc')).toBe(UPGRADE_NOTE)
    expect(read('modules/cli/partials/rpk-ai-signin-troubleshooting.adoc')).toBe(SIGNIN
      .replace('After a plugin upgrade, `rpk ai env list`', 'After a plugin upgrade, rpkcmd:[rpk ai env list]')
      .replace('until you run `rpk ai auth login` again', 'until you run rpkcmd:[rpk ai auth login] again'))
    // The pages' own later mentions stay as written. (--write also replaces
    // the pages' exact xrefs, which are not mentions.)
    expect(read('modules/cli/pages/index.adoc')).toContain('Run `rpk ai auth login` and retry.')
    expect(read('modules/gateway/pages/connect-agent.adoc')).toContain('If the cached token has expired, `rpk ai` returns a 401. Rerun `rpk ai auth login` to refresh it.')
  })

  // docs manage/partials/authentication.adoc:1459, included by
  // security/authentication.adoc:7 and k-authentication.adoc:8. Changed: the
  // Kubernetes page links rpk cluster info before the include.
  const K_AUTH_LINK = 'Check the brokers with xref:reference:rpk/rpk-cluster/rpk-cluster-info.adoc[`rpk cluster info`].'
  const authPages = (kLines) => ({
    'modules/manage/partials/authentication.adoc': page(AUTH_LIST),
    'modules/manage/pages/security/authentication.adoc': page('include::manage:partial$authentication.adoc[]'),
    'modules/manage/pages/kubernetes/security/authentication/k-authentication.adoc': page(':env-kubernetes: true', '', ...kLines, 'include::manage:partial$authentication.adoc[]'),
  })

  test('a partial two pages include, one of which links the target: reported, naming the other page', () => {
    const { found } = scan('streaming', authPages([K_AUTH_LINK, '']), { kinds: ['rpk'] })
    const byTarget = Object.fromEntries(found.map((f) => [f.target, f]))
    expect(Object.keys(byTarget)).toEqual(['rpk topic create', 'rpk topic consume', 'rpk cluster info', 'rpk security acl list'])
    expect(byTarget['rpk cluster info']).toMatchObject({ file: 'modules/manage/partials/authentication.adoc', line: 3, pages: ['modules/manage/pages/security/authentication.adoc'], note: 'the first mention on modules/manage/pages/security/authentication.adoc, which does not link it' })
    expect(byTarget['rpk topic consume'].pages).toEqual(['modules/manage/pages/kubernetes/security/authentication/k-authentication.adoc', 'modules/manage/pages/security/authentication.adoc'])
  })

  test('the same partial, when both pages link the target: not reported', () => {
    const files = authPages([K_AUTH_LINK, ''])
    files['modules/manage/pages/security/authentication.adoc'] = page(K_AUTH_LINK, '', 'include::manage:partial$authentication.adoc[]')
    expect(scan('streaming', files, { kinds: ['rpk'] }).found.map((f) => f.target)).toEqual(['rpk topic create', 'rpk topic consume', 'rpk security acl list'])
  })

  test('docs audit-logging.adoc:374: a conditional on an attribute the including page sets', () => {
    // manage/partials/audit-logging.adoc:373-375, included by
    // manage/pages/audit-logging.adoc:7 and k-audit-logging.adoc:6, which
    // sets env-kubernetes. Changed: the self-managed page links rpk cluster
    // config before the include, so only the Kubernetes page could report
    // it, and it never shows the line.
    const files = {
      'modules/manage/partials/audit-logging.adoc': page('ifndef::env-cloud,env-kubernetes[]', 'Use `rpk cluster config` to configure audit logs. Some options require a cluster restart. You can verify this using `rpk cluster config status`.', 'endif::[]'),
      'modules/manage/pages/audit-logging.adoc': page(':env-linux: true', '// tag::single-source[]', '', 'Configure with xref:reference:rpk/rpk-cluster/rpk-cluster-config.adoc[`rpk cluster config`].', '', 'include::manage:partial$audit-logging.adoc[]'),
      'modules/manage/pages/kubernetes/security/k-audit-logging.adoc': page(':env-kubernetes: true', '', 'include::manage:partial$audit-logging.adoc[]'),
    }
    const { found } = scan('streaming', files, { kinds: ['rpk'] })
    expect(at(found)).toEqual([['modules/manage/partials/audit-logging.adoc', 4, '`rpk cluster config status`']])
    expect(found[0].pages).toEqual(['modules/manage/pages/audit-logging.adoc'])
  })

  // cloud-docs reference/pages/properties/topic-properties.adoc:8 and :34,
  // which includes a category of the streaming partial less its deprecated
  // properties. Changed: rpk topic create for rpk topic alter-config, which
  // the trimmed data lacks, and the partial cut to the tag regions around
  // its link (docs reference/partials/properties/topic-properties.adoc:1911).
  const CLOUD_PROPS = page(
    'Unless a property says otherwise, you can set it with `rpk topic create`, the Kafka API, or Redpanda Cloud Console. Some properties have different limits on Serverless clusters.',
    '',
    'include::streaming:reference:partial$properties/topic-properties.adoc[tags=category-performance-cluster;!deprecated;!exclude-from-docs]',
  )
  const streamingProps = (linkTag) => ({
    streaming: {
      'modules/reference/partials/properties/topic-properties.adoc': [
        '// tag::category-performance-cluster[]',
        ...(linkTag ? [`// tag::${linkTag}[]`] : []),
        '* xref:reference:rpk/rpk-topic/rpk-topic-create.adoc[`rpk topic create`]',
        ...(linkTag ? [`// end::${linkTag}[]`] : []),
        '// end::category-performance-cluster[]',
        '',
      ].join('\n'),
    },
  })
  const CLOUD_FILE = 'modules/reference/pages/properties/topic-properties.adoc'

  test('cloud-docs topic-properties.adoc:8: a page whose lender partial links the target is not reported', () => {
    expect(scan('cloud-data-platform', { [CLOUD_FILE]: CLOUD_PROPS }, { kinds: ['rpk'], lenderFiles: streamingProps() }).found).toEqual([])
  })

  test('the link in a region the include leaves out (!deprecated) does not count', () => {
    const { found } = scan('cloud-data-platform', { [CLOUD_FILE]: CLOUD_PROPS }, { kinds: ['rpk'], lenderFiles: streamingProps('deprecated') })
    expect(at(found)).toEqual([[CLOUD_FILE, 3, '`rpk topic create`']])
    // Judged only as itself: no note.
    expect(found[0].note).toBeUndefined()
  })

  test('an include of a component the scan did not load is not followed', () => {
    const { found } = scan('cloud-data-platform', { [CLOUD_FILE]: CLOUD_PROPS }, { kinds: ['rpk'], lenders: ['connect'] })
    expect(at(found)).toEqual([[CLOUD_FILE, 3, '`rpk topic create`']])
  })

  // rp-connect-docs components/pages/rate_limits/about.adoc:18-31, and the
  // cloud-docs stub that includes its single-source region. Changed: the
  // kafka input for http_client, which the trimmed data lacks.
  const ABOUT = [
    '= Rate Limits',
    '// tag::single-source[]',
    '',
    'ifndef::env-cloud[]',
    'And most components that hit external services have a field `rate_limit` for specifying a rate limit resource to use, identified by the `label` field. For example, if we wanted to use our `foobar` rate limit with an xref:components:inputs/kafka.adoc[`kafka`] input it would look like this:',
    'endif::[]',
    'ifdef::env-cloud[]',
    'And most components that hit external services have a field `rate_limit` for specifying a rate limit resource to use, identified by the `label` field. For example, if we wanted to use our `foobar` rate limit with a `kafka` input it would look like this:',
    'endif::[]',
    '// end::single-source[]',
    '',
  ].join('\n')
  const STUB = { 'cloud-data-platform': { 'modules/develop/pages/connect/components/rate_limits/about.adoc': '= Rate Limits\n:page-aliases: components:rate_limits/about.adoc\ninclude::connect:components:rate_limits/about.adoc[tag=single-source]\n' } }

  test('rp-connect-docs rate_limits/about.adoc:31: a Cloud-only line on a page Cloud includes, whose link Cloud never shows', () => {
    const { found } = scan('connect', { 'modules/components/pages/rate_limits/about.adoc': ABOUT }, { kinds: ['connect'], lenderFiles: STUB })
    expect(at(found)).toEqual([['modules/components/pages/rate_limits/about.adoc', 8, '`kafka` input']])
    expect(found[0].pages).toEqual(['cloud-data-platform:modules/develop/pages/connect/components/rate_limits/about.adoc'])
  })

  test('the same page with no Cloud checkout: judged as today, and the file links the input', () => {
    expect(scan('connect', { 'modules/components/pages/rate_limits/about.adoc': ABOUT }, { kinds: ['connect'], lenders: ['streaming'] }).found).toEqual([])
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
