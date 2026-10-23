'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { parseHeader, runCli, fixCategories } = require('../../../tools/check-metadata')
const { loadTaxonomyFrom, parseTaxonomy, PUBLIC_URL } = require('../../../extension-utils/taxonomy')

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'taxonomy')
const TAXONOMY = path.join(FIXTURES, 'taxonomy.yml')

const DOC_PAGE = `= Iceberg Topics
:description: About Iceberg Topics.
:page-categories: Iceberg, Security, Nonsense

Body.
`
const CLEAN_PAGE = `= Security
:page-categories: Security, Replication
:page-topic-type: concept

Body.
`
const SOLUTION_PAGE = `:page-layout: solution
= CDC to a lakehouse
:page-topic-type: concept
:page-categories: Iceberg Topics, Nonsense
:page-solution-use-cases: Change data capture, Data mesh
:page-solution-technologies: Postgres, Apache Iceberg, Kubernetes
:page-solution-platforms: self-managed, cloud
:page-solution-industries: iGaming

Body.
`

function makeRepo (files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-metadata-'))
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), content)
  }
  return root
}

function git (root, ...args) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout
}

/** Run the CLI and capture what it prints and its exit code. */
async function cli (paths, options) {
  const out = []
  const err = []
  const log = jest.spyOn(console, 'log').mockImplementation((m) => out.push(String(m)))
  const error = jest.spyOn(console, 'error').mockImplementation((m) => err.push(String(m)))
  const before = process.exitCode
  try {
    const result = await runCli(paths, options)
    return { result, stdout: out.join('\n'), stderr: err.join('\n'), code: process.exitCode }
  } finally {
    log.mockRestore()
    error.mockRestore()
    process.exitCode = before
  }
}

describe('parseHeader', () => {
  test('reads attribute entries until the blank line after the title, with line numbers', () => {
    const entries = parseHeader(`// a comment
:page-layout: solution
= Title
////
:page-categories: Hidden
////
ifdef::env-cloud[]
:page-categories: Cloud only
endif::[]
:page-categories: Security

:page-categories: Body text
`)
    expect(entries).toEqual([
      { name: 'page-layout', value: 'solution', line: 2, start: 2 },
      { name: 'page-categories', value: 'Cloud only', line: 8, start: 8 },
      { name: 'page-categories', value: 'Security', line: 10, start: 10 },
    ])
  })
})

describe('doc-tools check-metadata', () => {
  test('text output names file, line, rule, and the replacement; warnings alone exit 0', async () => {
    const root = makeRepo({ 'modules/a/pages/iceberg.adoc': DOC_PAGE })
    const { stdout, code } = await cli([], { root, taxonomy: TAXONOMY, format: 'text' })
    expect(stdout).toContain("WARNING modules/a/pages/iceberg.adoc:3 [deprecated-value] page-categories value 'Iceberg' is deprecated; use 'Iceberg Topics' instead")
    expect(stdout).toContain("WARNING modules/a/pages/iceberg.adoc:3 [unknown-value] page-categories value 'Nonsense' is not in the taxonomy")
    expect(stdout).toMatch(/check-metadata: 1 page\(s\) with taxonomy metadata in 1 file\(s\) \(0 solutions\), taxonomy from .*taxonomy\.yml: 0 error\(s\), 2 warning\(s\)$/)
    expect(code).toBe(0)
  })

  test('JSON output has the stable fields', async () => {
    const root = makeRepo({ 'modules/a/pages/iceberg.adoc': DOC_PAGE })
    const { stdout } = await cli([], { root, taxonomy: TAXONOMY, format: 'json' })
    const json = JSON.parse(stdout)
    expect(json.summary).toEqual({ errors: 0, warnings: 2 })
    expect(json.taxonomy.source).toBe(TAXONOMY)
    expect(json.findings[0]).toEqual({
      file: 'modules/a/pages/iceberg.adoc',
      line: 3,
      attribute: 'page-categories',
      value: 'Iceberg',
      severity: 'warning',
      rule: 'deprecated-value',
      message: "page-categories value 'Iceberg' is deprecated; use 'Iceberg Topics' instead",
      replacement: 'Iceberg Topics',
      replacementIds: ['iceberg-topics'],
      kind: 'docs',
    })
    expect(json.findings[1]).toMatchObject({ value: 'Nonsense', rule: 'unknown-value', replacement: null })
  })

  test('--strict turns warnings into errors and exits 1', async () => {
    const root = makeRepo({ 'modules/a/pages/iceberg.adoc': DOC_PAGE })
    const { result, code } = await cli([], { root, taxonomy: TAXONOMY, strict: true })
    expect(result.summary).toEqual({ errors: 2, warnings: 0 })
    expect(code).toBe(1)
  })

  test('a clean page has no findings', async () => {
    const root = makeRepo({ 'modules/a/pages/security.adoc': CLEAN_PAGE })
    const { result, code } = await cli([], { root, taxonomy: TAXONOMY, strict: true })
    expect(result.findings).toEqual([])
    expect(code).toBe(0)
  })

  test('a solution overview errors on unknown values and warns on the rest', async () => {
    const root = makeRepo({ 'modules/cdc/pages/index.adoc': SOLUTION_PAGE })
    const { result, code } = await cli([], { root, taxonomy: TAXONOMY })
    const by = (value) => result.findings.find((f) => f.value === value)
    expect(by('Nonsense')).toMatchObject({ attribute: 'page-categories', severity: 'error', rule: 'unknown-value', line: 4, kind: 'solution' })
    expect(by('Data mesh')).toMatchObject({ attribute: 'page-solution-use-cases', severity: 'error', rule: 'unknown-value', line: 5 })
    expect(by('Kubernetes')).toMatchObject({ attribute: 'page-solution-technologies', severity: 'warning', rule: 'wrong-facet' })
    // Aliases resolve without a finding: Postgres, self-managed (docker), iGaming.
    expect(by('Postgres')).toBeUndefined()
    expect(by('self-managed')).toBeUndefined()
    expect(by('iGaming')).toBeUndefined()
    expect(result.solutions).toBe(1)
    expect(code).toBe(1)
  })

  test('the same value is an error on a solution and a warning on a Product Docs page', async () => {
    const root = makeRepo({
      'modules/a/pages/doc.adoc': '= Doc\n:page-categories: Nonsense\n',
      'modules/b/pages/index.adoc': ':page-layout: solution\n= Solution\n:page-categories: Nonsense\n',
    })
    const { result } = await cli([], { root, taxonomy: TAXONOMY })
    expect(result.findings.map((f) => [f.file, f.severity])).toEqual([
      ['modules/a/pages/doc.adoc', 'warning'],
      ['modules/b/pages/index.adoc', 'error'],
    ])
  })

  test('two values that resolve to one concept are a duplicate', async () => {
    const root = makeRepo({
      'modules/a/pages/doc.adoc': '= Doc\n:page-categories: Iceberg, Iceberg Topics\n',
      'modules/b/pages/index.adoc': ':page-layout: solution\n= Solution\n:page-categories: Stream processing\n:page-solution-use-cases: Stream processing\n',
    })
    const { result } = await cli([], { root, taxonomy: TAXONOMY })
    const dups = result.findings.filter((f) => f.rule === 'duplicate-concept')
    expect(dups.map((f) => [f.file, f.attribute, f.value, f.severity])).toEqual([
      ['modules/a/pages/doc.adoc', 'page-categories', 'Iceberg Topics', 'warning'],
      ['modules/b/pages/index.adoc', 'page-solution-use-cases', 'Stream processing', 'error'],
    ])
  })

  test('--changed checks only the pages changed since the merge base', async () => {
    const root = makeRepo({ 'modules/a/pages/old.adoc': DOC_PAGE, 'modules/a/pages/edit.adoc': CLEAN_PAGE })
    git(root, 'init', '-q', '-b', 'main')
    git(root, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'empty')
    git(root, 'add', '-A')
    git(root, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'base')
    git(root, 'checkout', '-q', '-b', 'topic')
    fs.writeFileSync(path.join(root, 'modules/a/pages/edit.adoc'), CLEAN_PAGE.replace('Security, Replication', 'Security, Management'))
    fs.writeFileSync(path.join(root, 'modules/a/pages/new.adoc'), '= New\n:page-categories: Data Replication\n')
    git(root, 'add', '-A')
    git(root, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'change')
    const { result } = await cli([], { root, taxonomy: TAXONOMY, changed: 'main' })
    expect(result.files).toBe(2)
    expect(result.findings.map((f) => [f.file, f.value, f.replacement])).toEqual([
      ['modules/a/pages/edit.adoc', 'Management', 'Operate'],
      ['modules/a/pages/new.adoc', 'Data Replication', 'Replication'],
    ])
    // Paths filter the changed set.
    const filtered = await cli(['modules/a/pages/new.adoc'], { root, taxonomy: TAXONOMY, changed: 'main' })
    expect(filtered.result.files).toBe(1)
  })

  test('paths may be files or directories', async () => {
    const root = makeRepo({ 'modules/a/pages/doc.adoc': DOC_PAGE, 'modules/b/pages/doc.adoc': DOC_PAGE })
    const { result } = await cli(['modules/b'], { root, taxonomy: TAXONOMY })
    expect(new Set(result.findings.map((f) => f.file))).toEqual(new Set(['modules/b/pages/doc.adoc']))
  })

  test('a legacy category the taxonomy lacks is a gap when the checkout has valid-categories.yml', async () => {
    const root = makeRepo({
      'modules/a/pages/doc.adoc': '= Doc\n:page-categories: Troubleshooting\n',
      'shared/modules/ROOT/partials/valid-categories.yml': fs.readFileSync(path.join(FIXTURES, 'valid-categories.yml'), 'utf8'),
    })
    const { result } = await cli([], { root, taxonomy: TAXONOMY })
    expect(result.findings[0]).toMatchObject({ rule: 'not-in-taxonomy', value: 'Troubleshooting', severity: 'warning' })
  })

  test('an invalid taxonomy or a bad option exits 2', async () => {
    const root = makeRepo({ 'modules/a/pages/doc.adoc': DOC_PAGE, 'bad.yml': 'schema-version: 1\nschemes: []\n', 'taxonomy.schema.json': fs.readFileSync(path.join(FIXTURES, 'taxonomy.schema.json')) })
    expect((await cli([], { root, taxonomy: path.join(root, 'bad.yml') })).code).toBe(2)
    expect((await cli([], { root, taxonomy: TAXONOMY, format: 'xml' })).code).toBe(2)
  })
})

describe('loadTaxonomyFrom', () => {
  const text = fs.readFileSync(TAXONOMY, 'utf8')
  const schema = fs.readFileSync(path.join(FIXTURES, 'taxonomy.schema.json'), 'utf8')
  const checkout = () => makeRepo({
    'shared/modules/ROOT/attachments/taxonomy.yml': text,
    'shared/modules/ROOT/attachments/taxonomy.schema.json': schema,
  })
  const noFetch = () => { throw new Error('should not fetch') }

  test('an explicit path wins', async () => {
    const r = await loadTaxonomyFrom({ source: TAXONOMY, root: checkout(), fetch: noFetch })
    expect(r.source).toBe(TAXONOMY)
    expect(r.schemaSource).toBe(path.join(FIXTURES, 'taxonomy.schema.json'))
  })

  test('then the docs checkout at root', async () => {
    const root = checkout()
    const r = await loadTaxonomyFrom({ root, env: {}, fetch: noFetch })
    expect(r.source).toBe(path.join(root, 'shared/modules/ROOT/attachments/taxonomy.yml'))
  })

  test('then $REDPANDA_DOCS_PATH', async () => {
    const docs = checkout()
    const r = await loadTaxonomyFrom({ root: makeRepo({}), env: { REDPANDA_DOCS_PATH: docs }, fetch: noFetch })
    expect(r.source).toBe(path.join(docs, 'shared/modules/ROOT/attachments/taxonomy.yml'))
  })

  test('then the published URL, with the schema beside it', async () => {
    const fetched = []
    const fetch = async (url) => {
      fetched.push(url)
      const body = url.endsWith('.json') ? schema : text
      return { ok: true, status: 200, headers: { get: () => 'text/yaml' }, text: async () => body }
    }
    const r = await loadTaxonomyFrom({ root: makeRepo({}), env: {}, fetch })
    expect(r.source).toBe(PUBLIC_URL)
    expect(fetched).toEqual([PUBLIC_URL, 'https://docs.redpanda.com/shared/_attachments/taxonomy.schema.json'])
  })

  test('an HTML answer counts as not found', async () => {
    const fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => '<html>' })
    await expect(loadTaxonomyFrom({ root: makeRepo({}), env: {}, fetch })).rejects.toThrow(/no taxonomy\.yml found/)
  })
})

describe('check-metadata --fix', () => {
  const taxonomy = parseTaxonomy(fs.readFileSync(TAXONOMY, 'utf8'))
  const header = (categories) => `= Page\n:description: A page.\n:page-categories: ${categories}\n\nBody.\n`
  const fix = (categories) => fixCategories(header(categories), taxonomy)

  test('replaces deprecated values and drops a replacement that is a task', () => {
    const r = fix('Iceberg, Management, Security')
    expect(r.content).toBe(header('Iceberg Topics, Security'))
    expect(r.changes[0].edits).toEqual([
      { value: 'Iceberg', action: 'replace', to: ['Iceberg Topics'] },
      { value: 'Management', action: 'drop', to: [] },
    ])
  })

  test('removes the attribute when nothing is left', () => {
    const r = fix('Management')
    expect(r.content).toBe('= Page\n:description: A page.\n\nBody.\n')
    expect(r.changes[0].after).toBeNull()
  })

  test('leaves a deprecated value with no replacement, and an unknown value, for a person', () => {
    const r = fix('Integration, Data Replication, Nonsense')
    expect(r.content).toBe(header('Integration, Replication, Nonsense'))
    expect(r.kept.map((k) => k.value)).toEqual(['Integration', 'Nonsense'])
  })

  test('writes the preferred label of a live concept', () => {
    expect(fix('Disaster Recovery, Postgres').content).toBe(header('Disaster recovery, PostgreSQL'))
  })

  test('keeps one value per concept', () => {
    expect(fix('Iceberg, Iceberg Topics').content).toBe(header('Iceberg Topics'))
  })

  test('a page that is already current is unchanged', () => {
    const r = fix('Iceberg Topics, Security')
    expect(r.changes).toEqual([])
    expect(r.content).toBe(header('Iceberg Topics, Security'))
  })

  test('fixes each conditional branch and leaves values with attribute references', () => {
    const page = '= Page\nifdef::env-cloud[]\n:page-categories: Management, Iceberg\nendif::[]\nifndef::env-cloud[]\n:page-categories: {x}, Data Replication\nendif::[]\n\nBody.\n'
    const r = fixCategories(page, taxonomy)
    expect(r.content).toBe('= Page\nifdef::env-cloud[]\n:page-categories: Iceberg Topics\nendif::[]\nifndef::env-cloud[]\n:page-categories: {x}, Replication\nendif::[]\n\nBody.\n')
  })

  test('leaves categories in the body alone', () => {
    const page = header('Security') + '\n:page-categories: Management\n'
    expect(fixCategories(page, taxonomy).content).toBe(page)
  })

  test('the CLI rewrites files, reports the fixes, and checks the result', async () => {
    const root = makeRepo({ 'modules/a/pages/a.adoc': header('Iceberg, Management'), 'modules/a/pages/b.adoc': header('Integration') })
    const { result, stdout, code } = await cli([], { root, taxonomy: TAXONOMY, fix: true })
    expect(fs.readFileSync(path.join(root, 'modules/a/pages/a.adoc'), 'utf8')).toBe(header('Iceberg Topics'))
    expect(fs.readFileSync(path.join(root, 'modules/a/pages/b.adoc'), 'utf8')).toBe(header('Integration'))
    expect(result.fixes.map((f) => f.file)).toEqual(['modules/a/pages/a.adoc', 'modules/a/pages/b.adoc'])
    expect(result.findings.map((f) => `${f.file} ${f.value}`)).toEqual(['modules/a/pages/b.adoc Integration'])
    expect(stdout).toMatch(/FIXED {3}modules\/a\/pages\/a\.adoc:3 :page-categories: Iceberg, Management -> :page-categories: Iceberg Topics/)
    expect(code).toBe(0)
  })

  test('without --fix nothing is written', async () => {
    const root = makeRepo({ 'modules/a/pages/a.adoc': header('Iceberg') })
    const { result } = await cli([], { root, taxonomy: TAXONOMY })
    expect(result.fixes).toBeUndefined()
    expect(fs.readFileSync(path.join(root, 'modules/a/pages/a.adoc'), 'utf8')).toBe(header('Iceberg'))
  })
})

describe('check-metadata --suggest', () => {
  const TIERED = `= Tiered Storage
:description: Offload Tiered Storage segments.

include::manage:partial$tiered.adoc[]
`
  const repo = () => makeRepo({
    'modules/manage/pages/tiered.adoc': TIERED,
    'modules/manage/partials/tiered.adoc': '== Replication\n\nTiered Storage and Replication.\n',
    'modules/manage/pages/tagged.adoc': '= Tiered Storage\n:page-categories: Tiered Storage\n\nx\n',
    'modules/manage/pages/plain.adoc': '= Plain\n\nNothing to see.\n',
  })

  test('JSON lists each suggestion with file, facet, conceptId, label, score, and evidence', async () => {
    const { result, code } = await cli([], { root: repo(), taxonomy: TAXONOMY, format: 'json', suggest: true })
    expect(code).toBe(0)
    const s = result.suggest
    expect(s.minScore).toEqual({ docs: 5, solution: 3 })
    expect(s.suggestions.map((x) => `${x.file} ${x.conceptId}`)).toEqual(['modules/manage/pages/tiered.adoc tiered-storage'])
    const [first] = s.suggestions
    expect(Object.keys(first)).toEqual(expect.arrayContaining(['file', 'kind', 'facet', 'attribute', 'conceptId', 'label', 'score', 'reason', 'implies', 'evidence']))
    expect(first.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ term: 'Tiered Storage', location: 'title', line: 1 }),
      expect.objectContaining({ location: 'body', line: 3, source: 'modules/manage/partials/tiered.adoc' }),
    ]))
  })

  test('--min-score lowers the bar, and text output shows the evidence', async () => {
    const { result, stdout } = await cli(['modules/manage/pages/tiered.adoc'], { root: repo(), taxonomy: TAXONOMY, suggest: true, minScore: '1' })
    expect(result.suggest.suggestions.map((x) => x.conceptId)).toEqual(['tiered-storage', 'replication'])
    expect(stdout).toMatch(/SUGGEST modules\/manage\/pages\/tiered\.adoc/)
    expect(stdout).toMatch(/page-categories: Replication \[topic replication\] score [\d.]+, named in 1 heading and 1 body mention; implies High Availability/)
    expect(stdout).toMatch(/"Replication" \(Replication\) at modules\/manage\/partials\/tiered\.adoc:1 heading/)
  })

  test('--suggest-empty-only skips pages that carry categories', async () => {
    const root = repo()
    const all = await cli([], { root, taxonomy: TAXONOMY, suggest: true, minScore: '0' })
    const empty = await cli([], { root, taxonomy: TAXONOMY, suggest: true, minScore: '0', suggestEmptyOnly: true })
    expect(all.result.suggest.suggestions.some((x) => x.file.endsWith('tagged.adoc'))).toBe(false) // carried already
    expect(empty.result.suggest.suggestions.every((x) => !x.file.endsWith('tagged.adoc'))).toBe(true)
    const root2 = makeRepo({ 'modules/a/pages/t.adoc': '= Replication\n:page-categories: Security\n\nx\n' })
    expect((await cli([], { root: root2, taxonomy: TAXONOMY, suggest: true })).result.suggest.suggestions).toHaveLength(1)
    expect((await cli([], { root: root2, taxonomy: TAXONOMY, suggest: true, suggestEmptyOnly: true })).result.suggest.suggestions).toHaveLength(0)
  })

  test('without --suggest there is no suggest block', async () => {
    const { result } = await cli([], { root: repo(), taxonomy: TAXONOMY })
    expect(result.suggest).toBeUndefined()
  })

  test('a bad --min-score or --limit, or either without --suggest, exits 2', async () => {
    for (const options of [{ suggest: true, minScore: 'x' }, { suggest: true, limit: '0' }, { minScore: '3' }, { suggestEmptyOnly: true }]) {
      const { code, stderr } = await cli([], { root: repo(), taxonomy: TAXONOMY, ...options })
      expect(code).toBe(2)
      expect(stderr).toMatch(/--(min-score|limit|suggest)/)
    }
  })

  test('the doc-tools binary accepts the options', () => {
    const root = repo()
    const bin = path.join(__dirname, '..', '..', '..', 'bin', 'doc-tools.js')
    const res = spawnSync(process.execPath, [bin, 'check-metadata', '--root', root, '--taxonomy', TAXONOMY, '--suggest', '--min-score', '1', '--limit', '1', '--format', 'json'], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    const out = JSON.parse(res.stdout)
    expect(out.suggest.limit).toEqual({ docs: 1, solution: 1 })
    expect(out.suggest.suggestions.filter((x) => x.file.endsWith('tiered.adoc'))).toHaveLength(1)
  })
})
