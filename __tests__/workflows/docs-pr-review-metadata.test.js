'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const YAML = require('yaml')
const { spawnSync } = require('child_process')
const { execRun } = require('./helpers/exec-run')

/**
 * The docs PR review runs `doc-tools check-metadata` in adoc_review and adds
 * its findings to that branch's verdict and findings. These tests execute
 * the two steps' run: bodies (helpers/exec-run.js) with gh and npx stubbed,
 * and once with npx running this repository's own doc-tools on a real git
 * checkout, and check what reaches the review: an error is blocking, a
 * warning is a suggestion, a check that could not run is not_run (never a
 * pass), and a doc-tools without the subcommand changes nothing.
 */

const ROOT = path.join(__dirname, '..', '..')
const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'docs-pr-review-reusable.yml'), 'utf8'))
const job = workflow.jobs.adoc_review
const stepNamed = (name) => {
  const step = job.steps.find((s) => s.name === name)
  if (!step) throw new Error(`no step named ${name}; steps: ${job.steps.map((s) => s.name || s.uses).join(', ')}`)
  return step
}
const CHECK = stepNamed('Deterministic checks (doc-tools check-metadata)')
const MERGE = stepNamed('Add the check-metadata findings to the review')

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
echo "$PWD $*" >> "$RUNNER_TEMP/npx.log"
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

function runMerge ({ state, json, reason, verdict, findingsMd } = {}) {
  const runnerTemp = tmpdir()
  const dir = path.join(runnerTemp, 'metadata-check')
  fs.mkdirSync(dir, { recursive: true })
  if (state) fs.writeFileSync(path.join(dir, 'state'), state + '\n')
  if (json) fs.writeFileSync(path.join(dir, 'check-metadata.json'), JSON.stringify(json))
  if (reason) fs.writeFileSync(path.join(dir, 'reason'), reason + '\n')
  const files = {}
  if (verdict !== undefined) files['review-output/verdict.json'] = typeof verdict === 'string' ? verdict : JSON.stringify(verdict)
  if (findingsMd) files['review-output/findings.md'] = findingsMd
  const r = execRun(MERGE, { env: { RUNNER_TEMP: runnerTemp }, files })
  const v = r.read('review-output/verdict.json')
  return { ...r, verdict: v && (() => { try { return JSON.parse(v) } catch { return v } })(), findings: r.read('review-output/findings.md') }
}

describe('docs PR review: the check-metadata step', () => {
  test('runs check-metadata on the changed pages against the PR base, in the PR checkout', () => {
    const r = runCheck({ npx: npxStub({ json: result([]) }) })
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.state).toBe('ran')
    expect(r.npxLog()).toBe(`${r.srcDir} --yes --package @redpanda-data/docs-extensions-and-macros@9.9.9 doc-tools check-metadata --changed origin/main --format json --output ${r.runnerTemp}/metadata-check/check-metadata.json\n`)
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

  test.each([['missing'], [null]])('state %s changes nothing', (state) => {
    const verdict = { verdict: 'pass', blocking: [], suggestions: [] }
    const r = runMerge({ state, verdict, findingsMd: '# Review\n' })
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
    git(src, 'add', '-A')
    git(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'pr')

    // npx runs this checkout's bin, as the published package would.
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
  })
})
