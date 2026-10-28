'use strict'

jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

// --write applies only auto-safe exact findings, and only when the line
// renders the same visible text before and after through the real macros.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { scanAll } = require('../../../tools/reference-values')
const { makeRenderGuard, renderLine, visibleText } = require('../../../tools/reference-values/render-check')
const migrate = require('../../../tools/migrate-property-values')
const { RPK_KIND } = require('../../../extension-utils/rpk-values')
const { CONNECT_KIND } = require('../../../extension-utils/connect-values')
const { PROPERTIES_KIND } = require('../../../macros/prop')

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures')
const temps = []
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-write-'))
  temps.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
})
const put = (dir, file, content) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), content)
}

const block = (...lines) => ['[,bash]', '----', ...lines, '----', ''].join('\n')

// One repo publishing its rpk data as an attachment, and a connect lender.
function setup () {
  const docs = tmp()
  put(docs, 'antora.yml', "name: streaming\nversion: '26.2'\n")
  put(docs, 'modules/reference/attachments/rpk-v26.2.2.json', fs.readFileSync(path.join(FIXTURES, 'rpkval', 'rpk-v26.2.2-sample.json')))
  const connect = tmp()
  put(connect, 'antora.yml', 'name: connect\nversion: ~\n')
  put(connect, 'modules/components/attachments/connect-4.114.0.json', fs.readFileSync(path.join(FIXTURES, 'connectval', 'connect-4.114.0-sample.json')))

  const cdcYaml = ['[,yaml]', '----', 'input:', '  postgres_cdc:', '    incremental_snapshot:', '      chunk_size: 1024 # <1>', '----']
  const files = {
    // Auto-safe: a core flag, same sentence, sole target.
    'modules/develop/pages/safe.adoc': ['= Safe', '', '== Create', '', block('rpk topic create orders'), 'The `--partitions` flag defaults to -1.', ''].join('\n'),
    // Withheld: another flag on the line.
    'modules/develop/pages/two-flags.adoc': ['= Two', '', '== Create', '', block('rpk topic create orders'), 'The `--partitions` flag defaults to -1, and `--replicas` too.', ''].join('\n'),
    // Withheld: a table cell, even with the statement in one sentence.
    'modules/develop/pages/table.adoc': ['= Table', '', '== Create', '', block('rpk topic create orders'), '|===', '| Flag | Description', '', '| `--partitions`', '| The `--partitions` flag defaults to -1.', '|===', ''].join('\n'),
    // Withheld: the statement is in the sentence after the flag.
    'modules/develop/pages/previous.adoc': ['= Previous', '', '== Create', '', block('rpk topic create orders'), 'Set `--partitions` when you create the topic. The default is -1.', ''].join('\n'),
    // Withheld: a scraped plugin flag.
    'modules/develop/pages/plugin.adoc': ['= Plugin', '', '== List', '', block('rpk ai auditlog list'), 'The `--limit` flag defaults to 50.', ''].join('\n'),
    // Withheld: an empty default.
    'modules/develop/pages/empty.adoc': ['= Empty', '', '== Select', '', block('rpk cloud cluster select'), 'The `--profile` flag defaults to `""`.', ''].join('\n'),
    // Withheld: release notes.
    'modules/get-started/pages/release-notes/redpanda.adoc': ['= Notes', '', '== Create', '', block('rpk topic create orders'), 'The `--partitions` flag defaults to -1.', ''].join('\n'),
    // Withheld: a partial, outside ifndef::env-cloud, with a selfHostedOnly target.
    'modules/manage/partials/self-test.adoc': ['== Self test', '', block('rpk cluster self-test start'), 'The `--disk-duration-ms` flag defaults to 30000.', ''].join('\n'),
    // Withheld: a tagged page, same target.
    'modules/manage/pages/tagged.adoc': ['= Tagged', '', '// tag::self-test[]', '== Self test', '', block('rpk cluster self-test start'), 'The `--disk-duration-ms` flag defaults to 30000.', '// end::self-test[]', ''].join('\n'),
    // Allowed: the same partial content inside ifndef::env-cloud.
    'modules/manage/partials/self-test-guarded.adoc': ['== Self test', '', block('rpk cluster self-test start'), 'ifndef::env-cloud[]', 'The `--disk-duration-ms` flag defaults to 30000.', 'endif::[]', ''].join('\n'),
    // Auto-safe: a Connect callout.
    'modules/develop/pages/cdc.adoc': ['= CDC', '', '[,yaml]', '----', 'input:', '  postgres_cdc:', '    incremental_snapshot:', '      chunk_size: 1024 # <1>', '----', '<1> The number of rows to read in each chunk. The default is `1024`.', ''].join('\n'),
    // Withheld Connect lines, one per rule.
    // Association: the statement is in the sentence after the field.
    'modules/develop/pages/c-assoc.adoc': ['= A', '', ...cdcYaml, '<1> The number of rows to read in each chunk.', '', 'Tune `incremental_snapshot.chunk_size` for large tables. The default is `1024`.', ''].join('\n'),
    // Sole target: another field on the line.
    'modules/develop/pages/c-sole.adoc': ['= A', '', ...cdcYaml, '<1> The number of rows to read in each chunk, unlike `incremental_snapshot.enabled`. The default is `1024`.', ''].join('\n'),
    // An empty default.
    'modules/develop/pages/c-empty.adoc': ['= A', '', '[,yaml]', '----', 'input:', '  aws_dynamodb_cdc:', '    table_tag_filter: "" # <1>', '----', '<1> The tag filter. The default is `""`.', ''].join('\n'),
    // A table cell.
    'modules/develop/pages/c-table.adoc': ['= A', '', ...cdcYaml, '<1> The chunk.', '', '|===', '| Field | Description', '', '| `incremental_snapshot.chunk_size`', '| The `incremental_snapshot.chunk_size` field defaults to `1024`.', '|===', ''].join('\n'),
    // Historical: migration notes.
    'modules/develop/pages/migration/v4.adoc': ['= A', '', ...cdcYaml, '<1> The number of rows to read in each chunk. The default is `1024`.', ''].join('\n'),
    // A partial, outside ifndef::env-cloud, about a component Cloud does not run.
    'modules/develop/partials/stdin.adoc': ['== A', '', '[,yaml]', '----', 'input:', '  stdin:', '    max_buffer: 1000000 # <1>', '----', '<1> The buffer size. The default is `1000000`.', ''].join('\n'),
  }
  for (const [file, content] of Object.entries(files)) put(docs, file, content)
  return { docs, connect, files }
}

const catalogFor = (docs, connect) => migrate.catalogFor([
  migrate.readComponent(docs, [PROPERTIES_KIND, RPK_KIND, CONNECT_KIND]),
  migrate.readComponent(connect, [PROPERTIES_KIND, RPK_KIND, CONNECT_KIND]),
])

describe('check-reference-values --write', () => {
  test('changes only the auto-safe lines', () => {
    const { docs, connect, files } = setup()
    const result = scanAll({ docsDir: docs, lenderDirs: [connect], kinds: ['rpk', 'connect'], kindsExplicit: true, write: true })
    const changed = Object.keys(files).filter((file) => fs.readFileSync(path.join(docs, file), 'utf8') !== files[file]).sort()
    expect(changed).toEqual(['modules/develop/pages/cdc.adoc', 'modules/develop/pages/safe.adoc', 'modules/manage/partials/self-test-guarded.adoc'])
    expect(fs.readFileSync(path.join(docs, 'modules/develop/pages/safe.adoc'), 'utf8')).toContain('The `--partitions` flag defaults to rpkval:partitions[command=rpk topic create].')
    expect(fs.readFileSync(path.join(docs, 'modules/develop/pages/cdc.adoc'), 'utf8')).toContain('<1> The number of rows to read in each chunk. The default is `connectval:incremental_snapshot.chunk_size[component=inputs/postgres_cdc]`.')
    const notes = Object.fromEntries(result.kinds.rpk.findings.filter((f) => f.status === 'exact').map((f) => [f.file, f.note]))
    expect(notes['modules/develop/pages/two-flags.adoc']).toBe('another flag or command is named on the line: proposed only')
    expect(notes['modules/develop/pages/table.adoc']).toBe('in a table: proposed only')
    expect(notes['modules/develop/pages/previous.adoc']).toBe('tied to the flag by previous-sentence: proposed only')
    expect(notes['modules/develop/pages/plugin.adoc']).toBe('a plugin flag scraped from --help: proposed only')
    expect(notes['modules/develop/pages/empty.adoc']).toBe('an empty default: proposed only')
    expect(notes['modules/get-started/pages/release-notes/redpanda.adoc']).toBe('release or upgrade notes: proposed only')
    expect(notes['modules/manage/partials/self-test.adoc']).toBe('page may be single-sourced; wrap in ifndef::env-cloud[] first')
    expect(notes['modules/manage/pages/tagged.adoc']).toBe('page may be single-sourced; wrap in ifndef::env-cloud[] first')
    expect(result.kinds.rpk.findings.filter((f) => f.applied).map((f) => f.file).sort()).toEqual(['modules/develop/pages/safe.adoc', 'modules/manage/partials/self-test-guarded.adoc'])
  })

  test('withheld Connect lines stay as written while the auto-safe callout is rewritten', () => {
    const { docs, connect, files } = setup()
    const result = scanAll({ docsDir: docs, lenderDirs: [connect], kinds: ['rpk', 'connect'], kindsExplicit: true, write: true })
    const withheld = {
      'modules/develop/pages/c-assoc.adoc': 'tied to the field by previous-sentence: proposed only',
      'modules/develop/pages/c-sole.adoc': 'another field is named on the line: proposed only',
      'modules/develop/pages/c-empty.adoc': 'an empty default: proposed only',
      'modules/develop/pages/c-table.adoc': 'in a table: proposed only',
      'modules/develop/pages/migration/v4.adoc': 'release, upgrade or migration notes: proposed only',
      'modules/develop/partials/stdin.adoc': 'page may be single-sourced; wrap in ifndef::env-cloud[] first',
    }
    const exact = result.kinds.connect.findings.filter((f) => f.status === 'exact')
    for (const [file, note] of Object.entries(withheld)) {
      expect(fs.readFileSync(path.join(docs, file), 'utf8')).toBe(files[file])
      expect(exact.filter((f) => f.file === file).map((f) => [f.autoSafe, f.note])).toEqual([[false, note]])
    }
    expect(fs.readFileSync(path.join(docs, 'modules/develop/pages/cdc.adoc'), 'utf8')).toContain('connectval:incremental_snapshot.chunk_size[component=inputs/postgres_cdc]')
    expect(result.kinds.connect.findings.filter((f) => f.applied).map((f) => f.file)).toEqual(['modules/develop/pages/cdc.adoc'])
  })

  test('every written file renders the same visible text before and after, through the real macros', () => {
    const { docs, connect, files } = setup()
    scanAll({ docsDir: docs, lenderDirs: [connect], kinds: ['rpk', 'connect'], kindsExplicit: true, write: true })
    const catalog = catalogFor(docs, connect)
    for (const [file, before] of Object.entries(files)) {
      const after = fs.readFileSync(path.join(docs, file), 'utf8')
      if (after === before) continue
      const src = { component: 'streaming', version: '26.2', module: file.split('/')[1], path: file }
      expect(visibleText(renderLine(after, { catalog, src }))).toBe(visibleText(renderLine(before, { catalog, src })))
      expect(renderLine(after, { catalog, src })).toMatch(/class="(?:rpk|connect)-value"/)
    }
  })

  test('the render guard reverts a replacement that changes visible text', () => {
    const { docs, connect } = setup()
    const guard = makeRenderGuard({ catalog: catalogFor(docs, connect), component: 'streaming', version: '26.2' })
    expect(guard('modules/x/pages/y.adoc', 'It defaults to -1.', 'It defaults to rpkval:partitions[command=rpk topic create].')).toBe(true)
    expect(guard('modules/x/pages/y.adoc', 'It defaults to 3.', 'It defaults to rpkval:partitions[command=rpk topic create].')).toBe(false)
    // A placeholder changes the text too.
    expect(guard('modules/x/pages/y.adoc', 'It defaults to -1.', 'It defaults to rpkval:partitions[command=rpk topic make].')).toBe(false)
  })

  test('a reverted replacement is reported as render-changed and leaves the file alone', () => {
    // A data value the scan accepts but the build renders differently: the
    // page's own version selects no data, so the macro renders a placeholder.
    const { docs, connect } = setup()
    fs.writeFileSync(path.join(docs, 'antora.yml'), "name: streaming\nversion: '26.3'\n")
    const data = path.join(docs, 'rpk-v26.2.2.json')
    fs.copyFileSync(path.join(FIXTURES, 'rpkval', 'rpk-v26.2.2-sample.json'), data)
    fs.rmSync(path.join(docs, 'modules/reference/attachments'), { recursive: true })
    const before = fs.readFileSync(path.join(docs, 'modules/develop/pages/safe.adoc'), 'utf8')
    const result = scanAll({ docsDir: docs, lenderDirs: [connect], dataFiles: [data], kinds: ['rpk'], kindsExplicit: true, write: true })
    expect(fs.readFileSync(path.join(docs, 'modules/develop/pages/safe.adoc'), 'utf8')).toBe(before)
    const f = result.kinds.rpk.findings.find((x) => x.file === 'modules/develop/pages/safe.adoc')
    expect(f).toMatchObject({ status: 'exact', applied: false, autoSafe: false, note: 'render-changed' })
  })
})

describe('--write and // value-check: ignore', () => {
  const IGNORE = '// value-check: ignore'

  test('rpk and Connect lines the comment covers are left as written', () => {
    const { docs, connect } = setup()
    const rpkPage = ['= Safe', '', '== Create', '', block('rpk topic create orders'), IGNORE, 'The `--partitions` flag defaults to -1.', ''].join('\n')
    const cdcPage = ['= CDC', '', '[,yaml]', '----', 'input:', '  postgres_cdc:', '    incremental_snapshot:', '      chunk_size: 1024 # <1>', '----', IGNORE, '<1> The number of rows to read in each chunk. The default is `1024`.', ''].join('\n')
    put(docs, 'modules/develop/pages/safe.adoc', rpkPage)
    put(docs, 'modules/develop/pages/cdc.adoc', cdcPage)
    const result = scanAll({ docsDir: docs, lenderDirs: [connect], kinds: ['rpk', 'connect'], kindsExplicit: true, write: true, files: ['modules/develop/pages/safe.adoc', 'modules/develop/pages/cdc.adoc'] })
    expect(fs.readFileSync(path.join(docs, 'modules/develop/pages/safe.adoc'), 'utf8')).toBe(rpkPage)
    expect(fs.readFileSync(path.join(docs, 'modules/develop/pages/cdc.adoc'), 'utf8')).toBe(cdcPage)
    expect(result.ignored).toBe(2)
    expect(result.kinds.rpk.changedFiles + result.kinds.connect.changedFiles).toBe(0)
  })

  describe('properties', () => {
    const page = (ignore) => ['= A', '', ...(ignore ? [IGNORE] : []), 'Set prop:log_segment_ms[], which defaults to 2 weeks.', '', 'Also, prop:log_segment_ms[] defaults to 2 weeks.', ''].join('\n')
    const repoWith = (content) => {
      const docs = tmp()
      put(docs, 'antora.yml', "name: streaming\nversion: '26.2'\n")
      put(docs, 'modules/reference/attachments/redpanda-properties-v26.2.4.json', fs.readFileSync(path.join(FIXTURES, 'propval', 'redpanda-properties-v26.2.4-sample.json')))
      put(docs, 'modules/manage/pages/a.adoc', content)
      return docs
    }

    test('a line the comment covers is put back, and the rest of the page is written', () => {
      const docs = repoWith(page(true))
      const result = scanAll({ docsDir: docs, kinds: ['properties'], kindsExplicit: true, write: true })
      const lines = fs.readFileSync(path.join(docs, 'modules/manage/pages/a.adoc'), 'utf8').split('\n')
      expect(lines[3]).toBe('Set prop:log_segment_ms[], which defaults to 2 weeks.')
      expect(lines[5]).toContain('defaults to propval:log_segment_ms[default].')
      expect(result.ignored).toBe(1)
      expect(result.kinds.properties.changedFiles).toBe(1)
    })

    test('a page whose only replacement is ignored counts as unchanged', () => {
      const content = ['= A', '', IGNORE, 'Set prop:log_segment_ms[], which defaults to 2 weeks.', ''].join('\n')
      const docs = repoWith(content)
      const result = scanAll({ docsDir: docs, kinds: ['properties'], kindsExplicit: true, write: true })
      expect(fs.readFileSync(path.join(docs, 'modules/manage/pages/a.adoc'), 'utf8')).toBe(content)
      expect(result.kinds.properties.changedFiles).toBe(0)
    })

    test('findings --write applied are marked applied and never fail', () => {
      const docs = repoWith(page(false))
      expect(scanAll({ docsDir: docs, kinds: ['properties'], kindsExplicit: true, failOn: 'any' }).failing).toBe(2)
      const result = scanAll({ docsDir: docs, kinds: ['properties'], kindsExplicit: true, write: true, failOn: 'any' })
      expect(result.kinds.properties.findings.map((f) => [f.autoSafe, f.applied, f.failing])).toEqual([[true, true, false], [true, true, false]])
      expect(result.failing).toBe(0)
    })
  })
})
