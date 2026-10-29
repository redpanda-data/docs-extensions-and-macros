'use strict'

jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

// Connect link findings: hand-written xrefs to Connect component pages,
// their field anchors, and the Bloblang anchors, judged on every surface
// that renders the line. The checkouts are built from the real page paths
// and page-aliases of rp-connect-docs b520063 and cloud-docs (the Cloud
// stubs), and connect publishes the trimmed connect-4.115.1.json
// (__tests__/fixtures/connect-links). Each prose line is quoted from
// rp-connect-docs b520063, cloud-docs d9be410 or docs 83f6be4d unless the
// test says it changed one.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { scanAll, failsAt } = require('../../../tools/reference-values')
const { SAMPLE, PAGES } = require('../../helpers/connect-links-catalog')

const temps = []
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
})
const put = (dir, file, content) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), content)
}
const page = (...lines) => ['= Page', '', ...lines, ''].join('\n')

const COMPONENTS = {
  connect: { version: '', attributes: {} },
  'cloud-data-platform': { version: '', attributes: { 'env-cloud': true } },
  streaming: { version: '26.2', attributes: {} },
}

// One checkout: the component's real Connect pages (connect's with their
// real source where the fixture has it, Cloud's as stubs that include the
// connect page), its page-aliases, and the given files.
function checkout (name, files = {}, { data = name === 'connect', nav } = {}) {
  const c = COMPONENTS[name]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-links-'))
  temps.push(dir)
  const attrs = Object.entries(c.attributes).map(([k, v]) => `    ${k}: ${v}`).join('\n')
  put(dir, 'antora.yml', `name: ${name}\nversion: ${c.version ? `'${c.version}'` : '~'}\n${nav ? `nav:\n${nav.map((n) => `- ${n}`).join('\n')}\n` : ''}${attrs ? `asciidoc:\n  attributes:\n${attrs}\n` : ''}`)
  for (const p of PAGES[name] || []) {
    const key = p.relative.replace(/\.adoc$/, '')
    const aliases = p.aliases.length ? `:page-aliases: ${p.aliases.join(', ')}\n` : ''
    const connectPath = p.aliases[0] ? p.aliases[0].replace(/^[\w-]+:/, '') : p.relative
    const body = name === 'connect'
      ? (PAGES.sources[key] || `= ${key}\n${aliases}\nGenerated.\n`)
      : `= ${key}\n${aliases}include::connect:${p.relative.includes('/guides/') ? 'guides' : 'components'}:${connectPath}[tag=single-source]\n`
    put(dir, `modules/${p.module}/pages/${p.relative}`, body)
  }
  if (data) put(dir, 'modules/components/attachments/connect-4.115.1.json', SAMPLE)
  for (const [file, content] of Object.entries(files)) put(dir, file, content)
  return dir
}

function scan (name, files, { lenders = ['connect', 'streaming'].filter((n) => n !== name), lenderFiles = {}, write = false, data, nav, dataFile } = {}) {
  const docsDir = checkout(name, files, { data, nav })
  const lenderDirs = lenders.map((n) => checkout(n, lenderFiles[n] || {}, { data: data === false ? false : undefined }))
  const result = scanAll({ docsDir, lenderDirs, dataFiles: dataFile ? [dataFile] : [], kinds: ['connect'], kindsExplicit: true, write })
  // Only the given files: the real page sources in the checkout have links too.
  return { result, docsDir, links: result.kinds.connect.findings.filter((f) => f.check === 'link' && Object.keys(files).includes(f.file)) }
}
const at = (links, line) => links.filter((f) => f.line === line)

describe('rp-connect-docs, scanned as connect', () => {
  // modules/cookbooks/pages/gcp_bigquery_write_api.adoc:78
  const FIELD = 'Set xref:components:outputs/gcp_bigquery_write_api.adoc#write_mode[`write_mode`] to `pending` (the default) to buffer writes.'
  // modules/configuration/pages/error_handling.adoc:96
  const FUNCTION = '* xref:guides:bloblang/functions.adoc#error_source_label[`error_source_label`]'
  // modules/get-started/pages/quickstarts/helm-chart.adoc:68 and :192
  const METHOD = 'This mapping uses the xref:guides:bloblang/methods.adoc#uppercase[`uppercase()`] method in Bloblang to convert the message to uppercase.'
  const CALL = '<1> Generates a unique, incrementing ID for each message using the xref:guides:bloblang/functions.adoc#counter[`counter()`] function.'

  test('a field xref is exact, and connect: links the same anchor', () => {
    const { links } = scan('connect', { 'modules/cookbooks/pages/gcp_bigquery_write_api.adoc': page(FIELD) })
    expect(links).toEqual([expect.objectContaining({ status: 'exact', autoSafe: true, proposed: 'connect:[outputs/gcp_bigquery_write_api.write_mode]', dataValue: 'connect:components:outputs/gcp_bigquery_write_api.adoc' })])
  })

  test('Bloblang xrefs are exact; the label carries over when the macro would show something else', () => {
    const { links } = scan('connect', { 'modules/configuration/pages/error_handling.adoc': page(FUNCTION, '', METHOD, '', CALL) })
    expect(links.map((f) => f.proposed)).toEqual(['blobl:[error_source_label(),`error_source_label`]', 'blobl:[.uppercase(),`uppercase()`]', 'blobl:[counter()]'])
    expect(links.every((f) => f.autoSafe)).toBe(true)
  })

  test('a component xref whose label is the name and its type is exact, with the macro\'s own label', () => {
    // modules/components/pages/inputs/kafka.adoc:65
    const { links } = scan('connect', { 'modules/guides/pages/x.adoc': page("If you're seeing issues writing to or reading from Kafka with this component then it's worth trying out the newer xref:components:inputs/kafka_franz.adoc[`kafka_franz` input].") })
    expect(links.map((f) => f.proposed)).toEqual(['connect:[inputs/kafka_franz]'])
  })

  test('--write replaces the exact xrefs, and the line renders the same', () => {
    const { docsDir, links } = scan('connect', { 'modules/configuration/pages/error_handling.adoc': page(FUNCTION, '', FIELD) }, { write: true })
    expect(links.every((f) => f.applied)).toBe(true)
    const text = fs.readFileSync(path.join(docsDir, 'modules/configuration/pages/error_handling.adoc'), 'utf8')
    expect(text).toContain('* blobl:[error_source_label(),`error_source_label`]')
    expect(text).toContain('Set connect:[outputs/gcp_bigquery_write_api.write_mode] to `pending`')
  })

  test('release notes are proposed only, and their mislabels are warnings that never fail', () => {
    // modules/get-started/pages/whats-new.adoc:3113, :3000 and :1500
    const { links } = scan('connect', {
      'modules/get-started/pages/whats-new.adoc': page(
        '* xref:components:outputs/ockam_kafka.adoc[`kafka_franz` output]',
        '',
        '- The xref:components:inputs/postgres_cdc.adoc[`pg_stream` input], which captures data changes made to a PostgreSQL database in real time and streams them to Redpanda Connect.',
        '',
        '* xref:guides:bloblang/methods.adoc#escape_url_path[`escape_url_path`]',
      ),
    })
    expect(at(links, 3)).toEqual([expect.objectContaining({ status: 'reference', reason: 'link-label-mismatch', severity: 'warning', note: "the label names `kafka_franz`, but the link goes to the output 'ockam_kafka'" })])
    expect(failsAt('connect', at(links, 3)[0], 'any')).toBe(false)
    // pg_stream is a page alias of postgres_cdc: the old name is the same component.
    expect(at(links, 5)).toEqual([])
    expect(at(links, 7)).toEqual([expect.objectContaining({ status: 'exact', autoSafe: false, note: 'release, upgrade or migration notes: proposed only' })])
  })

  test('a label that calls a component by another type is a mislabel', () => {
    // modules/components/pages/inputs/spicedb_watch.adoc:50
    const { links } = scan('connect', { 'modules/components/pages/inputs/spicedb_watch.adoc': page('The following example uses a xref:components:rate_limits/redis.adoc[`redis` cache] to store the ZedToken.') })
    expect(links).toEqual([expect.objectContaining({ reason: 'link-label-mismatch', note: "the label calls 'redis' a cache, but the link goes to the rate_limit page" })])
  })

  describe('broken links (each line changed from a real one)', () => {
    test.each([
      ['a field anchor that is not on the page', 'Set xref:components:outputs/gcp_bigquery_write_api.adoc#write_modes[`write_mode`] to `pending`.', 'the output page has no anchor #write_modes'],
      ['a deprecated field, which the reference does not list', 'Set xref:components:inputs/kafka_franz.adoc#regexp_topics[`regexp_topics`].', 'the input page has no anchor #regexp_topics'],
      ['a component with no page', 'Use the xref:components:inputs/kafka_frans.adoc[`kafka_frans` input].', 'connect@unversioned has no page connect:components:inputs/kafka_frans.adoc'],
      ['a numbered parameters heading', 'See xref:guides:bloblang/functions.adoc#parameters-2[the parameters].', 'has no anchor #parameters-2: a numbered heading id'],
      ['a hidden function', 'See xref:guides:bloblang/functions.adoc#var[`var`].', 'var is hidden'],
    ])('%s', (_name, line, note) => {
      const { links } = scan('connect', { 'modules/guides/pages/x.adoc': page(line) })
      expect(links).toEqual([expect.objectContaining({ status: 'reference', reason: 'broken-link', severity: 'error', failing: true })])
      expect(links[0].note).toContain(note)
    })

    test('the field anchor hint names the numbered anchor', () => {
      const { links } = scan('connect', { 'modules/guides/pages/x.adoc': page('See xref:components:outputs/amqp_1.adoc#metadata-3[`metadata`].') })
      expect(links[0].note).toContain('the field is #metadata-2')
    })
  })

  test('a numbered field anchor the reference generates is right', () => {
    const { links } = scan('connect', { 'modules/guides/pages/x.adoc': page('Set xref:components:outputs/amqp_1.adoc#metadata-2[`metadata`].') })
    expect(links).toEqual([expect.objectContaining({ status: 'exact', proposed: 'connect:[outputs/amqp_1.metadata]' })])
  })

  test('nav files, xrefs in code, and other pages are not checked', () => {
    const { links } = scan('connect', {
      'modules/ROOT/nav.adoc': '* xref:components:inputs/kafka_frans.adoc[]\n',
      'modules/guides/pages/x.adoc': page('Write `xref:components:inputs/kafka_frans.adoc[]` to link it, and see xref:guides:bloblang/about.adoc[Bloblang].'),
    }, { nav: ['modules/ROOT/nav.adoc'] })
    expect(links).toEqual([])
  })

  describe('judged on every surface that renders the file', () => {
    // modules/guides/partials/cloud/gateway.adoc:193, which only cloud-docs
    // modules/develop/pages/connect/guides/cloud/gateway.adoc includes.
    const GATEWAY = { 'modules/guides/partials/cloud/gateway.adoc': '- xref:components:inputs/gateway.adoc[`gateway` input reference]\n' }
    const CLOUD_PAGE = { 'modules/develop/pages/connect/guides/cloud/gateway.adoc': '= Gateway\n\ninclude::connect:guides:partial$cloud/gateway.adoc[]\n' }

    test('a partial no page in the scan includes is not judged', () => {
      const { links } = scan('connect', GATEWAY)
      expect(links).toEqual([expect.objectContaining({ status: 'unverifiable', reason: 'link-target-not-loaded' })])
    })

    test('a partial Cloud includes is judged as Cloud renders it: the Cloud page exists', () => {
      const stub = { 'modules/develop/pages/connect/components/inputs/gateway.adoc': '= gateway\n:page-aliases: components:inputs/gateway.adoc\n\nCloud only.\n' }
      const { links } = scan('connect', GATEWAY, { lenders: ['streaming', 'cloud-data-platform'], lenderFiles: { 'cloud-data-platform': { ...CLOUD_PAGE, ...stub } } })
      expect(links).toEqual([])
    })

    test('and broken when Cloud has no such page', () => {
      const { links } = scan('connect', GATEWAY, { lenders: ['streaming', 'cloud-data-platform'], lenderFiles: { 'cloud-data-platform': CLOUD_PAGE } })
      expect(links).toEqual([expect.objectContaining({ reason: 'broken-link', note: 'cloud-data-platform@unversioned has no page cloud-data-platform:components:inputs/gateway.adoc' })])
    })

    test('a page Cloud single-sources is judged on both, and ifndef::env-cloud[] keeps a line off Cloud', () => {
      const own = { 'modules/guides/pages/shared.adoc': page('// tag::single-source[]', 'Send to the xref:components:outputs/amqp_1.adoc[`amqp_1` output].', '', 'ifndef::env-cloud[]', 'Or the xref:components:outputs/amqp_1.adoc[`amqp_1` output].', 'endif::[]', '// end::single-source[]') }
      const cloud = { 'modules/develop/pages/connect/guides/shared.adoc': '= Shared\n\ninclude::connect:guides:shared.adoc[tag=single-source]\n' }
      const { links } = scan('connect', own, { lenders: ['cloud-data-platform'], lenderFiles: { 'cloud-data-platform': cloud } })
      expect(at(links, 4)).toEqual([expect.objectContaining({ reason: 'broken-link', note: 'cloud-data-platform@unversioned has no page cloud-data-platform:components:outputs/amqp_1.adoc' })])
      expect(at(links, 7)).toEqual([expect.objectContaining({ status: 'exact', proposed: 'connect:[outputs/amqp_1]' })])
    })

    test('an xref that sends Cloud readers to the connect page is not exact: on Cloud, connect: links the stub', () => {
      const own = { 'modules/guides/pages/shared.adoc': page('Read with the xref:connect:components:inputs/kafka_franz.adoc[`kafka_franz` input].') }
      const cloud = { 'modules/develop/pages/connect/guides/shared.adoc': '= Shared\n\ninclude::connect:guides:shared.adoc[]\n' }
      expect(scan('connect', own).links).toEqual([expect.objectContaining({ status: 'exact', proposed: 'connect:[inputs/kafka_franz]' })])
      expect(scan('connect', own, { lenders: ['cloud-data-platform'], lenderFiles: { 'cloud-data-platform': cloud } }).links).toEqual([])
    })
  })
})

describe('cloud-docs, scanned as Cloud', () => {
  test('a table cell xref through a stub alias is exact, and connect: links the same stub', () => {
    // modules/develop/pages/connect/connect-quickstart.adoc:36
    const { links } = scan('cloud-data-platform', { 'modules/develop/pages/connect/connect-quickstart.adoc': page('|===', '|Component |Purpose', '', '|xref:components:inputs/generate.adoc[`generate`]', '|Generates data.', '|===') })
    expect(links).toEqual([expect.objectContaining({ status: 'exact', autoSafe: true, proposed: 'connect:[inputs/generate,`generate`]', dataValue: 'cloud-data-platform:develop:connect/components/inputs/generate.adoc' })])
  })

  test('an xref to a stub by its own path is recognized through the stub\'s alias', () => {
    // modules/get-started/pages/whats-new-cloud.adoc:312
    const { links } = scan('cloud-data-platform', { 'modules/get-started/pages/whats-new-cloud.adoc': page('** xref:develop:connect/guides/bloblang/methods.adoc#escape_url_path[`escape_url_path`]: Escapes a string for safe use in URL path segments using percent-encoding.') })
    expect(links).toEqual([expect.objectContaining({ status: 'exact', proposed: 'blobl:[.escape_url_path(),`escape_url_path`]', note: 'release, upgrade or migration notes: proposed only' })])
  })

  test('an impure function anchor is broken on Cloud (changed from a real line)', () => {
    const { links } = scan('cloud-data-platform', { 'modules/develop/pages/connect/x.adoc': page('Read xref:guides:bloblang/functions.adoc#env[environment variables].') })
    expect(links).toEqual([expect.objectContaining({ reason: 'broken-link' })])
    expect(links[0].note).toContain('env() is impure, and the Cloud page leaves it out')
  })

  test('the SQL reference is never read for Bloblang links', () => {
    // modules/reference/pages/sql/sql-functions/aggregate-functions/sum.adoc, with a Bloblang xref added
    const { links } = scan('cloud-data-platform', { 'modules/reference/pages/sql/sql-functions/aggregate-functions/sum.adoc': page('The `sum()` function adds the values. Unlike xref:guides:bloblang/methods.adoc#sum[`sum`] in Bloblang, it ignores nulls.') })
    expect(links).toEqual([])
  })
})

describe('docs, scanned as streaming', () => {
  test('a qualified field xref is exact', () => {
    // modules/migrate/pages/migrate-from-kafka.adoc:61
    const { links } = scan('streaming', { 'modules/migrate/pages/migrate-from-kafka.adoc': page('The xref:connect:components:outputs/redpanda_migrator.adoc#offset_header[`offset_header`] field, available in Redpanda Connect 4.71.0 and later, names this header.') })
    expect(links).toEqual([expect.objectContaining({ status: 'exact', autoSafe: true, proposed: 'connect:[outputs/redpanda_migrator.offset_header]' })])
  })

  test('without connect in the scan, the target is not loaded', () => {
    const { links } = scan('streaming', { 'modules/migrate/pages/migrate-from-kafka.adoc': page('The xref:connect:components:outputs/redpanda_migrator.adoc#offset_header[`offset_header`] field.') }, { lenders: [], dataFile: (() => { const f = path.join(checkout('streaming'), 'connect-4.115.1.json'); fs.writeFileSync(f, SAMPLE); return f })() })
    expect(links).toEqual([expect.objectContaining({ status: 'unverifiable', reason: 'link-target-not-loaded' })])
  })
})

describe('the value checks read the new macros', () => {
  test('connect:[...] names the component a stated default belongs to', () => {
    const { result } = scan('connect', { 'modules/guides/pages/x.adoc': page('The connect:[inputs/kafka_franz.client_id] field defaults to `redpanda-connect`.') })
    expect(result.kinds.connect.findings.filter((f) => f.file === 'modules/guides/pages/x.adoc')).toEqual([expect.objectContaining({ status: 'exact', field: 'default', fieldPath: 'client_id', component: 'kafka_franz', target: 'connectval:client_id[component=inputs/kafka_franz]' })])
  })

  test('a bloblval: value is a macro, not a hand-written value', () => {
    const { result } = scan('connect', { 'modules/guides/pages/x.adoc': page('The `min` of counter defaults to bloblval:[counter(min)] and `client_id` defaults to connect:[inputs/kafka_franz.client_id].') })
    expect(result.kinds.connect.findings.filter((f) => f.file === 'modules/guides/pages/x.adoc' && f.check !== 'link')).toEqual([])
  })
})
