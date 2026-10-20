'use strict'

/**
 * Connect surface coverage: the string shapes the single-file scanner missed.
 * The fixture under tools/lint-strings/fixtures/connect/repo mirrors real
 * connect code: specs from helper constructors, cross-file constants and
 * helpers, reassignment, a helper package outside internal/impl, Bloblang,
 * ShortDescription, example titles, enum options, footnotes, urfave/cli
 * help, and info.csv.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync } = require('child_process')

const connect = require('../../../tools/lint-strings/surfaces/connect')
const { GoIndex, statementEnd } = require('../../../tools/lint-strings/go-index')
const { runRules } = require('../../../tools/lint-strings/engine')
const { lintStrings, rulesFor } = require('../../../tools/lint-strings')
const { findBareCodeTokens } = require('../../../tools/lint-strings/rules/common')
const { routeFile } = require('../../../tools/lint-strings/diff')

const FIXTURE = path.join(__dirname, '../../../tools/lint-strings/fixtures/connect/repo')

/** Copy the fixture into a fresh directory, with its go.mod in place. */
function makeRepo () {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-connect-repo-'))
  fs.cpSync(FIXTURE, repo, { recursive: true })
  fs.renameSync(path.join(repo, 'go.mod.txt'), path.join(repo, 'go.mod'))
  return repo
}

const find = (decls, kind, name, extra = () => true) => decls.filter((d) => d.meta.kind === kind && d.name === name && extra(d))
const componentsOf = (d) => (d.meta.components || []).map((c) => `${c.type}/${c.name}`).sort()

describe('connect extractor over a multi-package repo', () => {
  let repo
  let decls

  beforeAll(() => {
    repo = makeRepo()
    decls = connect.extract({ repo, external: false })
  })

  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }))

  test('a spec built by a helper constructor resolves cross-file constants and helper calls', () => {
    const [summary] = find(decls, 'summary', 'azure_thing', (d) => d.file.endsWith('input_thing.go'))
    expect(summary.string).toBe('Reads things from Azure Thing Storage.')
    const [description] = find(decls, 'description', 'azure_thing')
    expect(description.string).toMatch(/^Reads every thing in a container\./)
    expect(description.meta.unverifiable).toBeUndefined()
  })

  test('footnotes, example titles and summaries, and enum options are declarations', () => {
    expect(find(decls, 'footnotes', 'azure_thing')[0].string).toContain('== Throughput')
    expect(find(decls, 'example-title', 'azure_thing')[0].string).toBe('Read every thing')
    expect(find(decls, 'example-summary', 'azure_thing')[0].string).toBe('Reads each thing once and stops.')
    expect(find(decls, 'enum-option', 'mode=follow')[0].string).toBe('Keeps reading new things as they arrive.')
  })

  test('a chain broken by a blank line and a comment keeps every field on the component', () => {
    const [field] = find(decls, 'field', 'storage_account', (d) => d.meta.call_site && d.meta.call_site.includes('input_thing'))
    expect(componentsOf(field)).toEqual(['input/azure_thing'])
  })

  test('reassignment documents a field; no false missing-description', () => {
    const prefix = decls.filter((d) => d.name === 'prefix')
    expect(prefix).toHaveLength(1)
    expect(prefix[0].string).toBe('Only things whose name starts with this prefix are read.')
    expect(prefix[0].meta.missing_description).toBeUndefined()
    // The annotated enum really has no Description: that one is a finding.
    expect(find(decls, 'field', 'mode')[0].meta.missing_description).toBe(true)
  })

  test('a field helper called per component expands to one declaration per call site', () => {
    const fields = find(decls, 'field', 'storage_account')
    expect(fields.map((d) => d.string).sort()).toEqual([
      'The storage account to access for Azure Thing input.',
      'The storage account to access for Azure Thing output.'
    ])
    for (const d of fields) {
      // The declaration stays on the helper's lines, where a fix goes.
      expect(d.file).toBe('internal/impl/azure/common.go')
      expect(d.meta.template).toBe('The storage account to access for {{unresolved:1}}.')
      expect(d.meta.unverifiable).toBeUndefined()
    }
    const output = fields.find((d) => d.string.includes('output'))
    expect(output.meta.call_site).toBe('internal/impl/azure/output_thing.go:8')
    expect(componentsOf(output)).toEqual(['output/azure_thing'])
  })

  test('a field added in place, without reassignment, belongs to its component', () => {
    expect(componentsOf(find(decls, 'field', 'container')[0])).toEqual(['output/azure_thing'])
  })

  test('helper packages outside internal/impl are scanned and attributed through their importers', () => {
    const [retries] = find(decls, 'field', 'max_retries')
    expect(retries.file).toBe('internal/retries/retries.go')
    expect(componentsOf(retries)).toEqual(['input/azure_thing'])
  })

  test('each component carries its info.csv row', () => {
    const [input] = find(decls, 'summary', 'azure_thing', (d) => d.file.endsWith('input_thing.go'))
    expect(input.meta.components[0]).toMatchObject({ type: 'input', name: 'azure_thing', support: 'certified', cloud: true, cloud_ai: false })
    const [output] = find(decls, 'summary', 'azure_thing', (d) => d.file.endsWith('output_thing.go'))
    expect(output.meta.components[0]).toMatchObject({ support: 'community', cloud: false, cloud_unsupported_reason: 'needs local disk' })
  })

  test('ShortDescription is its own declaration kind', () => {
    const [short] = find(decls, 'field-short', 'storage_account')
    expect(short.string).toBe('The `storage account` to access.')
    expect(componentsOf(short)).toEqual(['input/azure_thing', 'output/azure_thing'])
  })

  test('Bloblang specs, params and examples are declarations', () => {
    expect(find(decls, 'bloblang', 'encode_widget')[0].string).toBe('Encodes a widget as a string.')
    expect(find(decls, 'bloblang-param', 'format')[0].string).toBe('The format to encode the widget in.')
    expect(find(decls, 'bloblang-example', 'encode_widget')[0].string).toBe('Encode a widget as JSON.')
    expect(componentsOf(find(decls, 'bloblang', 'encode_widget')[0])).toEqual(['bloblang-method/encode_widget'])
  })

  test('urfave/cli command and flag help are declarations with the CLI convention', () => {
    const [usage] = find(decls, 'cli-usage', 'lint')
    expect(usage.string).toBe('Parse configs and report any linting errors')
    expect(usage.convention.verbatim_asciidoc).toBe(false)
    expect(find(decls, 'cli-description', 'lint')[0].string).toMatch(/^Exits with a status code 1/)
    expect(find(decls, 'cli-flag', 'deprecated')[0].string).toBe('Print linting errors for the presence of deprecated fields.')
    expect(find(decls, 'cli-flag', 'format')[0].string).toBe('Output format')
  })

  test('scanner creators are registrations', () => {
    expect(componentsOf(find(decls, 'summary', 'widget_lines')[0])).toEqual(['scanner/widget_lines'])
  })

  test('a doc-method call on something that is not a benthos spec is reported, never dropped', () => {
    expect(decls.some((d) => d.string === 'Not a published string.')).toBe(false)
    expect(decls.skipped).toEqual([expect.objectContaining({
      file: 'internal/impl/widget/bloblang.go',
      method: 'Description',
      reason: expect.stringContaining('not a traceable expression')
    })])
  })

  test('connect rules flag ShortDescription markup and module-less xrefs', () => {
    const { findings } = runRules(decls, rulesFor(connect))
    const rulesFor_ = (kind, name) => findings.filter((f) => f.name === name).flatMap((f) => f.rules.map((r) => r.id))
    expect(rulesFor_('field-short', 'storage_account')).toContain('connect-short-description-markup')
    const description = findings.find((f) => f.name === 'azure_thing' && f.string.startsWith('Reads every thing'))
    const xrefIssues = description.rules.filter((r) => r.id === 'connect-xref-module')
    // xref:components:... resolves; xref:outputs/... has no module.
    expect(xrefIssues).toHaveLength(1)
    expect(xrefIssues[0].message).toContain('xref:outputs/azure_thing.adoc[')
    // CLI help is not AsciiDoc page prose: a flag usage is a short label
    // by convention, so the CLI declarations skip too-short and the
    // AsciiDoc-only rules.
    expect(findings.filter((f) => f.file === 'internal/cli/lint.go').flatMap((f) => f.rules.map((r) => r.id)))
      .not.toContain('too-short')
  })
})

describe('connect parameter expansion and variadic helpers', () => {
  test('a variadic string parameter binds to the call arguments', () => {
    const files = new Map([
      ['go.mod', 'module github.com/redpanda-data/connect/v4\n'],
      ['internal/impl/mongo/common.go', [
        'package mongo',
        'import (',
        '\t"strings"',
        '\t"github.com/redpanda-data/benthos/v4/public/service"',
        ')',
        'func sessionField(notes ...string) *service.ConfigField {',
        '\tdesc := strings.Join(append([]string{"The STS session duration."}, notes...), " ")',
        '\treturn service.NewDurationField("session_duration").Description(desc)',
        '}',
        'func init() {',
        '\tservice.MustRegisterInput("mongo_cdc", service.NewConfigSpec().Field(sessionField("Snapshots can outlast it.")), nil)',
        '\tservice.MustRegisterOutput("mongo", service.NewConfigSpec().Field(sessionField()), nil)',
        '}'
      ].join('\n')]
    ])
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-connect-variadic-'))
    try {
      for (const [file, content] of files) {
        fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true })
        fs.writeFileSync(path.join(repo, file), content)
      }
      const decls = connect.extract({ repo, external: false }).filter((d) => d.name === 'session_duration')
      expect(decls.map((d) => [componentsOf(d)[0], d.string]).sort()).toEqual([
        ['input/mongo_cdc', 'The STS session duration. Snapshots can outlast it.'],
        ['output/mongo', 'The STS session duration.']
      ])
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  test('strconv.Itoa over integer constants resolves', () => {
    const index = new GoIndex(path.join(path.sep, '__virtual_itoa__'), {
      external: false,
      overlay: new Map([['a.go', 'package a\nimport "strconv"\nconst maxTries = 5\nconst s = "After " + strconv.Itoa(maxTries-1) + " retries."\n']])
    })
    const file = index.file(path.join(path.sep, '__virtual_itoa__', 'a.go'))
    const r = index.evalString('s', { file, depth: 0 })
    expect(r.parts).toEqual([{ text: 'After 4 retries.' }])
  })

  test('fmt.Sprintf with a verb the parser cannot render is unresolved', () => {
    const src = [
      'package a',
      'import "fmt"',
      'const name = "rows"',
      'var ok = fmt.Sprintf("100%% of %s.", name)',
      'var float = fmt.Sprintf("%.1f%% of %s.", 0.5, name)',
      'var wrapped = fmt.Sprintf("failed: %w", name)',
      'var indexed = fmt.Sprintf("%[1]s and %[1]s.", name)',
      ''
    ].join('\n')
    const root = path.join(path.sep, '__virtual_sprintf__')
    const index = new GoIndex(root, { external: false, overlay: new Map([['a.go', src]]) })
    const file = index.file(path.join(root, 'a.go'))
    const ev = (n) => index.evalString(n, { file, depth: 0 })
    expect(ev('ok').parts).toEqual([{ text: '100% of rows.' }])
    for (const n of ['float', 'wrapped', 'indexed']) {
      expect(ev(n).parts.some((p) => p.unresolved !== undefined)).toBe(true)
    }
  })

  test('info.csv is parsed as CSV, so a quoted comma keeps the columns aligned', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'info-csv-'))
    try {
      fs.mkdirSync(path.join(repo, 'internal', 'plugins'), { recursive: true })
      fs.writeFileSync(path.join(repo, 'internal', 'plugins', 'info.csv'), [
        'name ,type ,commercial_name ,support ,deprecated ,cloud ,cloud_with_gpu ,cloud_unsupported_reason',
        'acme ,input ,"Acme, Inc." ,certified ,n ,y ,n ,',
        ''
      ].join('\n'))
      expect(connect.readInfoCsv(repo).get('input/acme')).toMatchObject({
        commercial_name: 'Acme, Inc.', support: 'certified', cloud: true, cloud_ai: false
      })
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  test('statementEnd carries a chain across a blank line or a comment line', () => {
    const src = 'x := a.\n\tB().\n\n\t      \n\tC()\ny := 1'
    expect(src.slice(0, statementEnd(src, 0))).toBe('x := a.\n\tB().\n\n\t      \n\tC()')
  })
})

describe('missing-inline-code ignores AsciiDoc link targets', () => {
  test('xref targets and anchor ids are not prose', () => {
    const text = 'See xref:components:processors/schema_registry_encode.adoc[the encoder] and <<avro_raw_json,`avro_raw_json`>> and [[field_paths]] for details.'
    expect(findBareCodeTokens(text)).toEqual([])
  })

  test('the same token in prose is still flagged', () => {
    const text = 'See xref:components:processors/schema_registry_encode.adoc[the encoder], then set schema_registry_encode.'
    expect(findBareCodeTokens(text).map((t) => t.token)).toEqual(['schema_registry_encode'])
  })
})

describe('connect diff routing', () => {
  test('routes helper packages, the public schema, the CLI and config templates', () => {
    expect(routeFile('internal/httpclient/config.go')).toBe('connect')
    expect(routeFile('internal/retries/retries.go')).toBe('connect')
    expect(routeFile('public/schema/schema.go')).toBe('connect')
    expect(routeFile('internal/cli/lint.go')).toBe('connect')
    expect(routeFile('internal/impl/kafka/resources/redpanda_migrator.tmpl.yaml')).toBe('connect')
  })

  test('leaves tests, testdata and generated docs alone', () => {
    expect(routeFile('internal/impl/kafka/input_test.go')).toBe(null)
    expect(routeFile('internal/impl/kafka/testdata/x.go')).toBe(null)
    expect(routeFile('docs/modules/components/partials/fields/inputs/kafka.adoc')).toBe(null)
  })
})

describe('connect diff mode (temp git repo)', () => {
  let repo
  let result
  const git = (args) => execSync(`git ${args}`, { cwd: repo, stdio: 'pipe' })

  beforeAll(() => {
    repo = makeRepo()
    git('init --quiet')
    git('config user.email lint-strings-test@example.invalid')
    git('config user.name "lint-strings test"')
    git('add .')
    git('commit --quiet -m base')
    // Edit the shared helper text and the untraceable call.
    const common = path.join(repo, 'internal/impl/azure/common.go')
    fs.writeFileSync(common, fs.readFileSync(common, 'utf8').replace('The storage account to access for', 'The storage account that holds'))
    const widget = path.join(repo, 'internal/impl/widget/bloblang.go')
    fs.writeFileSync(widget, fs.readFileSync(widget, 'utf8').replace('Not a published string.', 'Still not a published string.'))
    git('commit --quiet -am change')
    const prev = process.env.GOMODCACHE
    process.env.GOMODCACHE = path.join(repo, 'no-module-cache')
    try {
      result = lintStrings({ repo, surfaces: ['connect'], diffBase: 'HEAD~1', log: () => {} })
    } finally {
      if (prev === undefined) delete process.env.GOMODCACHE
      else process.env.GOMODCACHE = prev
    }
  })

  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }))

  test('each reviewed declaration carries its components, info.csv row and call site', () => {
    const fields = result.declarations.filter((d) => d.name === 'storage_account' && d.detail.kind === 'field')
    expect(fields).toHaveLength(2)
    const input = fields.find((d) => d.detail.call_site.includes('input_thing'))
    expect(input.detail.components).toEqual([expect.objectContaining({ type: 'input', name: 'azure_thing', cloud: true, cloud_ai: false, support: 'certified' })])
    expect(input.detail.template).toBe('The storage account that holds {{unresolved:1}}.')
  })

  test('an untraceable doc-method call on a changed line is reported in the summary', () => {
    expect(result.summary.skippedDeclarations).toEqual([expect.objectContaining({ file: 'internal/impl/widget/bloblang.go', method: 'Description' })])
    expect(result.summary.unverifiableDeclarations).toBe(0)
  })
})
