'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const YAML = require('yaml')
const { spawnSync } = require('child_process')
const { execRun } = require('./helpers/exec-run')

/**
 * The docs PR review runs `doc-tools check-metadata` in its own job,
 * metadata_check, which holds no id-token, and adoc_review adds the result
 * to that branch's verdict and findings. These tests execute
 * the two steps' run: bodies (helpers/exec-run.js) with gh and npx stubbed,
 * and once with npx running this repository's own doc-tools on a real git
 * checkout, and check what reaches the review: an error is blocking, a
 * warning is a suggestion, a check that could not run is not_run (never a
 * pass), and a doc-tools without the subcommand changes nothing.
 */

const ROOT = path.join(__dirname, '..', '..')
const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'docs-pr-review-reusable.yml'), 'utf8'))
const stepNamed = (job, name) => {
  const step = job.steps.find((s) => s.name === name)
  if (!step) throw new Error(`no step named ${name}; steps: ${job.steps.map((s) => s.name || s.uses).join(', ')}`)
  return step
}
const CHECK = stepNamed(workflow.jobs.metadata_check, 'Deterministic checks (doc-tools check-metadata)')
const MERGE = stepNamed(workflow.jobs.adoc_review, 'Add the check-metadata findings to the review')

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-meta-'))
const GH = 'echo main'

const finding = (severity, message, file = 'modules/manage/pages/a.adoc') => ({ file, line: 2, attribute: 'page-categories', value: 'x', severity, rule: 'unknown-value', message })
const result = (findings) => {
  const errors = findings.filter((f) => f.severity === 'error').length
  return { files: 1, pages: 1, solutions: 0, findings, summary: { errors, warnings: findings.length - errors } }
}

// An npx that answers like doc-tools check-metadata: writes `json` to the
// --output path (unless null) and exits `rc`, with `stderr` on stderr.
const npxStub = ({ json, rc = 0, stderr = '' }) => `#!/bin/bash
echo "$PWD \${GH_TOKEN:-no-token} $*" >> "$RUNNER_TEMP/npx.log"
out=""; prev=""
for a in "$@"; do [ "$prev" = --output ] && out="$a"; prev="$a"; done
${json === null ? '' : `cat > "$out" <<'JSON'\n${JSON.stringify(json)}\nJSON`}
${stderr ? `echo "${stderr}" >&2` : ''}
exit ${rc}
`

function runCheck ({ npx, gh = GH, src } = {}) {
  const runnerTemp = tmpdir()
  const srcDir = src || tmpdir()
  const r = execRun(CHECK, {
    env: { RUNNER_TEMP: runnerTemp, GH_TOKEN: 'x', PR: '12', R: 'redpanda-data/docs', DOC_TOOLS_VERSION: '9.9.9', SRC: srcDir },
    stubs: { gh, npx },
  })
  const read = (f) => (fs.existsSync(path.join(runnerTemp, 'metadata-check', f)) ? fs.readFileSync(path.join(runnerTemp, 'metadata-check', f), 'utf8') : null)
  return { ...r, runnerTemp, srcDir, readOut: read, state: (read('state') || '').trim(), npxLog: () => fs.readFileSync(path.join(runnerTemp, 'npx.log'), 'utf8') }
}

function runMerge ({ state, json, reason, verdict, findingsMd, jobResult = 'success' } = {}) {
  const runnerTemp = tmpdir()
  const dir = path.join(runnerTemp, 'metadata-check')
  fs.mkdirSync(dir, { recursive: true })
  if (state) fs.writeFileSync(path.join(dir, 'state'), state + '\n')
  if (json) fs.writeFileSync(path.join(dir, 'check-metadata.json'), JSON.stringify(json))
  if (reason) fs.writeFileSync(path.join(dir, 'reason'), reason + '\n')
  const files = {}
  if (verdict !== undefined) files['review-output/verdict.json'] = typeof verdict === 'string' ? verdict : JSON.stringify(verdict)
  if (findingsMd) files['review-output/findings.md'] = findingsMd
  const r = execRun(MERGE, { env: { RUNNER_TEMP: runnerTemp, METADATA_CHECK_RESULT: jobResult }, files })
  const v = r.read('review-output/verdict.json')
  return { ...r, verdict: v && (() => { try { return JSON.parse(v) } catch { return v } })(), findings: r.read('review-output/findings.md') }
}

describe('docs PR review: the check-metadata step', () => {
  test('runs check-metadata on the changed pages against the PR base, from RUNNER_TEMP with --root, without GH_TOKEN', () => {
    const r = runCheck({ npx: npxStub({ json: result([]) }) })
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.state).toBe('ran')
    expect(r.npxLog()).toBe(`${r.runnerTemp} no-token --yes --package @redpanda-data/docs-extensions-and-macros@9.9.9 doc-tools check-metadata --root ${r.srcDir} --changed origin/main --suggest --format json --output ${r.runnerTemp}/metadata-check/check-metadata.json\n`)
  })

  test('the job that runs it holds no id-token, and the review waits for it without being skipped by it', () => {
    expect(workflow.jobs.metadata_check.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' })
    expect(workflow.jobs.adoc_review.needs).toContain('metadata_check')
    expect(workflow.jobs.adoc_review.if).toMatch(/^!cancelled\(\) && /)
    expect(workflow.jobs.adoc_review.steps.some((s) => s.name === CHECK.name)).toBe(false)
  })

  test('no published taxonomy.yml is skipped with a notice, not reported', () => {
    const r = runCheck({ npx: npxStub({ json: null, rc: 2, stderr: 'check-metadata: no taxonomy.yml found; tried /src/shared/modules/ROOT/attachments/taxonomy.yml, https://docs.redpanda.com/shared/_attachments/taxonomy.yml' }) })
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.state).toBe('missing')
    expect(r.all).toMatch(/::notice::check-metadata found no taxonomy\.yml/)
  })

  test('exit 1 with a result is a result: errors found', () => {
    const r = runCheck({ npx: npxStub({ json: result([finding('error', 'bad')]), rc: 1 }) })
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.state).toBe('ran')
    expect(r.stdout).toMatch(/1 error\(s\), 0 warning\(s\)/)
  })

  test('a doc-tools without the subcommand is skipped, not reported', () => {
    const r = runCheck({ npx: npxStub({ json: null, rc: 1, stderr: "error: unknown command 'check-metadata'" }) })
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.state).toBe('missing')
    expect(r.all).toMatch(/::notice::doc-tools 9\.9\.9 has no check-metadata subcommand/)
  })

  test.each([
    ['exit 2', { json: null, rc: 2, stderr: 'check-metadata: could not load the taxonomy: 404' }, /could not run \(exit 2\): check-metadata: could not load the taxonomy: 404/],
    ['a taxonomy fetch that failed', { json: null, rc: 2, stderr: 'check-metadata: fetching https://docs.redpanda.com/shared/_attachments/taxonomy.yml failed with HTTP 503' }, /could not run \(exit 2\): .*HTTP 503/],
    ['exit 1 with no result', { json: null, rc: 1, stderr: 'npm error 404' }, /could not run \(exit 1\): npm error 404/],
    ['a result that is not its JSON', { json: { nope: true }, rc: 0 }, /could not run \(exit 0\)/],
  ])('%s is a check that could not run', (_name, stub, rx) => {
    const r = runCheck({ npx: npxStub(stub) })
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.state).toBe('failed')
    expect(r.readOut('reason')).toMatch(rx)
  })

  test('no base branch is a check that could not run', () => {
    const r = runCheck({ npx: npxStub({ json: result([]) }), gh: 'exit 1' })
    expect(r.state).toBe('failed')
    expect(r.readOut('reason')).toMatch(/base branch/)
  })
})

describe('docs PR review: adding check-metadata to the review', () => {
  const findings = [finding('error', "page-solution-use-cases value 'Data mesh' is not in the taxonomy"), finding('warning', "page-categories value 'Iceberg' is deprecated; use 'Iceberg Topics' instead")]

  test('errors are blocking and fail the branch, warnings are suggestions, all are in findings.md', () => {
    const r = runMerge({ state: 'ran', json: result(findings), verdict: { verdict: 'pass', blocking: [], suggestions: ['prose'] }, findingsMd: '# Review\n' })
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.verdict).toEqual({
      verdict: 'fail',
      blocking: ["page metadata: `modules/manage/pages/a.adoc:2` page-solution-use-cases value 'Data mesh' is not in the taxonomy"],
      suggestions: ['prose', "page metadata: `modules/manage/pages/a.adoc:2` page-categories value 'Iceberg' is deprecated; use 'Iceberg Topics' instead"],
      // Deterministic: an incremental re-review recomputes these instead of
      // carrying them over (docs-team-standards' aggregate-review.sh).
      check_blocking: ["page metadata: `modules/manage/pages/a.adoc:2` page-solution-use-cases value 'Data mesh' is not in the taxonomy"],
    })
    expect(r.findings).toMatch(/^# Review\n\n### Page metadata \(doc-tools check-metadata\)\n\n- error: `modules\/manage\/pages\/a\.adoc:2` page-solution-use-cases/)
    expect(r.exists('review-output/check-metadata.json')).toBe(true)
  })

  test('warnings alone keep a passing review passing', () => {
    const r = runMerge({ state: 'ran', json: result([findings[1]]), verdict: { verdict: 'pass', blocking: [], suggestions: [] } })
    expect(r.verdict.verdict).toBe('pass')
    expect(r.verdict.suggestions).toHaveLength(1)
  })

  test('a model-written verdict of the wrong shape is coerced, not crashed on', () => {
    const r = runMerge({ state: 'ran', json: result(findings), verdict: { verdict: 'pass', blocking: 'one string', suggestions: null } })
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.verdict.blocking).toEqual(['one string', expect.stringMatching(/Data mesh/)])
    expect(r.verdict.suggestions).toEqual([expect.stringMatching(/Iceberg/)])
  })

  test('without a review verdict the branch stays unavailable, and findings.md still lists the findings', () => {
    const r = runMerge({ state: 'ran', json: result(findings) })
    expect(r.exists('review-output/verdict.json')).toBe(false)
    expect(r.findings).toMatch(/### Page metadata/)
    const garbled = runMerge({ state: 'ran', json: result(findings), verdict: '["not an object"]' })
    expect(garbled.verdict).toEqual(['not an object'])
  })

  test('a check that could not run is not_run, never a pass', () => {
    const r = runMerge({ state: 'failed', reason: 'doc-tools check-metadata could not run (exit 2): no taxonomy', verdict: { verdict: 'pass', blocking: [], suggestions: [], not_run: ['earlier'] } })
    expect(r.verdict.verdict).toBe('pass')
    expect(r.verdict.not_run).toEqual(['earlier', 'Page metadata (doc-tools check-metadata): doc-tools check-metadata could not run (exit 2): no taxonomy'])
  })

  test.each([
    ['failure', /the metadata_check job left no result \(failure\)/],
    ['success', /the metadata_check job left no result \(success\)/],
  ])('no result from a metadata_check job with result %s is not_run, never a pass', (jobResult, rx) => {
    const r = runMerge({ jobResult, verdict: { verdict: 'pass', blocking: [], suggestions: [] } })
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.verdict.verdict).toBe('pass')
    expect(r.verdict.not_run).toEqual([expect.stringMatching(rx)])
  })

  test('markdown in a finding message is escaped', () => {
    const r = runMerge({ state: 'ran', json: result([finding('error', "page-categories value 'a `b` [c](d) <e>' is not in the taxonomy")]), verdict: { verdict: 'pass', blocking: [], suggestions: [] } })
    expect(r.verdict.blocking).toEqual(["page metadata: `modules/manage/pages/a.adoc:2` page-categories value 'a \\`b\\` \\[c\\](d) \\<e\\>' is not in the taxonomy"])
    expect(r.findings).toContain("- error: `modules/manage/pages/a.adoc:2` page-categories value 'a \\`b\\` \\[c\\](d) \\<e\\>' is not in the taxonomy")
  })

  const suggestion = (over = {}) => ({ file: 'modules/manage/pages/a.adoc', kind: 'docs', line: 1, uncategorized: true, facet: 'topic', attribute: 'page-categories', conceptId: 'tiered-storage', label: 'Tiered Storage', score: 14, reason: 'named in the title', implies: [], evidence: [], ...over })
  const withSuggestions = (findingsList, suggestions) => ({ ...result(findingsList), suggest: { minScore: { docs: 5, solution: 3 }, suggestions, needs: [], candidates: [], uncategorized: [] } })

  test('suggestions join the suggestions list, never blocking, and findings.md lists them', () => {
    const r = runMerge({
      state: 'ran',
      json: withSuggestions([findings[1]], [suggestion(), suggestion({ file: 'modules/b/pages/b.adoc', line: 3, uncategorized: false, conceptId: 'replication', label: 'Replication', score: 6.5, reason: 'named in 1 heading' })]),
      verdict: { verdict: 'pass', blocking: [], suggestions: ['prose'] },
      findingsMd: '# Review\n',
    })
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.verdict).toEqual({
      verdict: 'pass',
      blocking: [],
      suggestions: [
        'prose',
        "page metadata: `modules/manage/pages/a.adoc:2` page-categories value 'Iceberg' is deprecated; use 'Iceberg Topics' instead",
        'page metadata suggestion: `modules/manage/pages/a.adoc:1` consider Tiered Storage (`tiered-storage`) in `:page-categories:`, score 14: named in the title',
        'page metadata suggestion: `modules/b/pages/b.adoc:3` consider Replication (`replication`) in `:page-categories:`, score 6.5: named in 1 heading',
      ],
    })
    expect(r.findings).toContain('### Suggested taxonomy values (doc-tools check-metadata --suggest)\n\n- `modules/b/pages/b.adoc:3`: Replication (`replication`) in `:page-categories:`, score 6.5: named in 1 heading\n- `modules/manage/pages/a.adoc:1` (no page-categories yet): Tiered Storage (`tiered-storage`) in `:page-categories:`, score 14: named in the title\n')
    expect(r.stdout).toMatch(/added 0 error\(s\), 1 warning\(s\), and 2 suggestion\(s\) to the review/)
  })

  test('suggestions alone never fail the branch; at most 10 reach the list, with a count of the rest', () => {
    const many = Array.from({ length: 13 }, (_, i) => suggestion({ file: `modules/a/pages/p${i}.adoc`, score: 20 - i }))
    const r = runMerge({ state: 'ran', json: withSuggestions([], many), verdict: { verdict: 'pass', blocking: [], suggestions: [] } })
    expect(r.verdict.verdict).toBe('pass')
    expect(r.verdict.blocking).toEqual([])
    expect(r.verdict.suggestions).toHaveLength(11)
    expect(r.verdict.suggestions[0]).toMatch(/p0\.adoc:1` .*score 20/)
    expect(r.verdict.suggestions[10]).toBe('page metadata: 3 more suggestion(s) in check-metadata.json')
    expect(r.findings.split('\n').filter((l) => l.startsWith('- `modules/a/pages/'))).toHaveLength(13)
  })

  test('a result without suggestions (an older doc-tools) adds none', () => {
    const r = runMerge({ state: 'ran', json: result([]), verdict: { verdict: 'pass', blocking: [], suggestions: [] }, findingsMd: '# Review\n' })
    expect(r.verdict).toEqual({ verdict: 'pass', blocking: [], suggestions: [] })
    expect(r.findings).toBe('# Review\n')
  })

  test.each([['missing', 'success'], [null, 'skipped']])('state %s (job %s) changes nothing', (state, jobResult) => {
    const verdict = { verdict: 'pass', blocking: [], suggestions: [] }
    const r = runMerge({ state, jobResult, verdict, findingsMd: '# Review\n' })
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.verdict).toEqual(verdict)
    expect(r.findings).toBe('# Review\n')
    expect(r.exists('review-output/check-metadata.json')).toBe(false)
  })
})

describe('docs PR review: check-metadata with this repository\'s doc-tools', () => {
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
  }
  const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }

  test('reports only the pages the PR changed, and the merge turns them into the review', () => {
    // A docs checkout: the taxonomy at its published path, a bad page already
    // on main, and a PR branch that changes two pages.
    const src = tmpdir()
    git(src, 'init', '-q', '-b', 'main')
    write(src, 'shared/modules/ROOT/attachments/taxonomy.yml', fs.readFileSync(path.join(ROOT, '__tests__', 'fixtures', 'taxonomy', 'taxonomy.yml'), 'utf8'))
    write(src, 'shared/modules/ROOT/attachments/taxonomy.schema.json', fs.readFileSync(path.join(ROOT, '__tests__', 'fixtures', 'taxonomy', 'taxonomy.schema.json'), 'utf8'))
    write(src, 'modules/manage/pages/old.adoc', '= Old\n:page-categories: Iceberg\n\nAlready on main.\n')
    git(src, 'add', '-A')
    git(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
    git(src, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(src, 'checkout', '-q', '-b', 'pr')
    write(src, 'modules/manage/pages/iceberg.adoc', '= Iceberg\n:page-categories: Iceberg\n\nBody.\n')
    write(src, 'modules/solutions/pages/index.adoc', '= A solution\n:page-layout: solution\n:page-solution-use-cases: Data mesh\n\nBody.\n')
    write(src, 'modules/manage/pages/tiered.adoc', '= Tiered Storage\n:description: Offload Tiered Storage segments.\n\nTiered Storage keeps older segments.\n')
    git(src, 'add', '-A')
    git(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'pr')

    // npx runs this checkout's bin, as the published package would. It runs
    // from RUNNER_TEMP, so this also checks that --root and --changed reach
    // the checkout from outside it.
    const npx = `#!/bin/bash
while [ "$1" = --yes ] || [ "$1" = --package ]; do [ "$1" = --package ] && shift; shift; done
[ "$1" = doc-tools ] && shift
exec node "${path.join(ROOT, 'bin', 'doc-tools.js')}" "$@"
`
    const r = runCheck({ npx, src })
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.state).toBe('ran')
    const json = JSON.parse(r.readOut('check-metadata.json'))
    expect([...new Set(json.findings.map((f) => f.file))].sort()).toEqual(['modules/manage/pages/iceberg.adoc', 'modules/solutions/pages/index.adoc'])
    expect(json.summary.errors).toBeGreaterThan(0)

    const merged = runMerge({ state: 'ran', json, verdict: { verdict: 'pass', blocking: [], suggestions: [] } })
    expect(merged.verdict.verdict).toBe('fail')
    expect(merged.verdict.blocking.join('\n')).toMatch(/modules\/solutions\/pages\/index\.adoc:\d+` .*Data mesh/)
    expect(merged.verdict.suggestions.join('\n')).toMatch(/modules\/manage\/pages\/iceberg\.adoc:2` .*'Iceberg' is deprecated/)
    expect(merged.findings).not.toMatch(/old\.adoc/)
    expect(merged.verdict.suggestions).toContainEqual(expect.stringMatching(/^page metadata suggestion: `modules\/manage\/pages\/tiered\.adoc:1` consider Tiered Storage \(`tiered-storage`\) in `:page-categories:`/))
    expect(merged.verdict.blocking.join('\n')).not.toMatch(/tiered/)
  })
})
