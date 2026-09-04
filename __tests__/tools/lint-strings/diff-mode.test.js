'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync } = require('child_process')

const { parseUnifiedDiff, parseUnifiedDiffRemovals, routeFile, spanIntersects, classifyDiff } =
  require('../../../tools/lint-strings/diff')
const { lintStrings } = require('../../../tools/lint-strings')

describe('unified diff parsing', () => {
  test('maps hunks to post-image line numbers per file', () => {
    const diff = [
      'diff --git a/src/v/config/configuration.cc b/src/v/config/configuration.cc',
      '--- a/src/v/config/configuration.cc',
      '+++ b/src/v/config/configuration.cc',
      '@@ -100,2 +100,3 @@ ctx',
      '+line a',
      '+line b',
      '+line c',
      '@@ -200 +201 @@ ctx',
      '+line d',
      'diff --git a/gone.cc b/gone.cc',
      '--- a/gone.cc',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-x',
      'diff --git a/other.cc b/other.cc',
      '--- a/other.cc',
      '+++ b/other.cc',
      '@@ -5,0 +6,0 @@ pure deletion counted as zero lines',
      ''
    ].join('\n')

    const changed = parseUnifiedDiff(diff)
    expect([...changed.keys()]).toEqual(['src/v/config/configuration.cc'])
    expect([...changed.get('src/v/config/configuration.cc')].sort((a, b) => a - b)).toEqual([100, 101, 102, 201])
  })

  test('maps the pre-image side to deleted line numbers, keyed by old path', () => {
    const diff = [
      'diff --git a/src/v/config/configuration.cc b/src/v/config/configuration.cc',
      '--- a/src/v/config/configuration.cc',
      '+++ b/src/v/config/configuration.cc',
      '@@ -100,3 +99,0 @@ ctx',
      '-line a',
      '-line b',
      '-line c',
      'diff --git a/gone.cc b/gone.cc',
      '--- a/gone.cc',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-x',
      '-y',
      'diff --git a/added.cc b/added.cc',
      '--- /dev/null',
      '+++ b/added.cc',
      '@@ -0,0 +1,2 @@',
      '+new a',
      '+new b',
      ''
    ].join('\n')

    const removed = parseUnifiedDiffRemovals(diff)
    // A wholly deleted file counts; a wholly new file contributes nothing.
    expect([...removed.keys()].sort()).toEqual(['gone.cc', 'src/v/config/configuration.cc'])
    expect([...removed.get('src/v/config/configuration.cc')].sort((a, b) => a - b)).toEqual([100, 101, 102])
    expect([...removed.get('gone.cc')].sort((a, b) => a - b)).toEqual([1, 2])
  })

  test('a deleted source line starting with "-- " is not read as a file header', () => {
    const diff = [
      'diff --git a/src/v/config/configuration.cc b/src/v/config/configuration.cc',
      '--- a/src/v/config/configuration.cc',
      '+++ b/src/v/config/configuration.cc',
      '@@ -10,2 +9,0 @@ ctx',
      '--- a/not/a/header.cc',
      '-real deleted line',
      ''
    ].join('\n')

    const removed = parseUnifiedDiffRemovals(diff)
    expect([...removed.keys()]).toEqual(['src/v/config/configuration.cc'])
    expect([...removed.get('src/v/config/configuration.cc')].sort((a, b) => a - b)).toEqual([10, 11])
  })
})

describe('path -> surface routing', () => {
  test('routes each surface path shape', () => {
    expect(routeFile('src/v/config/configuration.cc')).toBe('properties')
    expect(routeFile('src/v/cluster/partition_probe.cc')).toBe('metrics')
    expect(routeFile('src/v/metrics/metrics.cc')).toBe('metrics')
    expect(routeFile('src/go/rpk/pkg/cli/cluster/health.go')).toBe('rpk')
    expect(routeFile('charts/redpanda/chart/values.yaml')).toBe('helm')
    expect(routeFile('operator/api/redpanda/v1alpha2/redpanda_types.go')).toBe('crd')
    expect(routeFile('internal/impl/kafka/input.go')).toBe('connect')
    expect(routeFile('src/v/raft/consensus.cc')).toBeNull()
    expect(routeFile('README.md')).toBeNull()
  })

  test('classifyDiff groups changed files by surface', () => {
    const changed = new Map([
      ['src/v/config/configuration.cc', new Set([10])],
      ['src/v/cluster/partition_probe.cc', new Set([20])],
      ['README.md', new Set([1])]
    ])
    const classified = classifyDiff(changed)
    expect(Object.keys(classified).sort()).toEqual(['metrics', 'properties'])
    expect([...classified.properties.keys()]).toEqual(['src/v/config/configuration.cc'])
  })

  test('spanIntersects is inclusive on both ends', () => {
    expect(spanIntersects(10, 15, new Set([15]))).toBe(true)
    expect(spanIntersects(10, 15, new Set([10]))).toBe(true)
    expect(spanIntersects(10, 15, new Set([9, 16]))).toBe(false)
    expect(spanIntersects(null, null, new Set([1]))).toBe(false)
  })
})

describe('declaration-anchored diff mode (end-to-end, temp git repo)', () => {
  const FIXTURE = path.join(__dirname, '../../../tools/lint-strings/fixtures/metrics/lint_probe.cc')
  let repo

  function git (args) {
    execSync(`git ${args}`, { cwd: repo, stdio: 'pipe' })
  }

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-diff-'))
    const target = path.join(repo, 'src', 'v', 'cluster', 'lint_probe.cc')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(FIXTURE, target)

    git('init --quiet')
    git('config user.email lint-strings-test@example.invalid')
    git('config user.name "lint-strings test"')
    git('add .')
    git('commit --quiet -m base')

    // Touch ONE line of the clang-format-wrapped multi-line description:
    // the second adjacent literal of committed_offset.
    const content = fs.readFileSync(target, 'utf8')
    const edited = content.replace('"majority of replicas."', '"the majority of replicas."')
    expect(edited).not.toBe(content)
    fs.writeFileSync(target, edited)
    git('add .')
    git('commit --quiet -m "reword one wrapped description line"')
  })

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('a one-line edit inside a wrapped description surfaces the FULL declaration span with in_pr_diff', () => {
    const result = lintStrings({ repo, diffBase: 'HEAD~1', log: () => {} })

    // Only the touched declaration is linted: start_offset's known-bads and
    // buffer_size's unverifiable finding are outside the diff.
    expect(result.findings).toHaveLength(1)
    const finding = result.findings[0]
    expect(finding.name).toBe('committed_offset')
    expect(finding.surface).toBe('metrics')
    expect(finding.in_pr_diff).toBe(true)
    // The fixture's description also spells its aside as "i.e.".
    expect(finding.rules.map((r) => r.id).sort()).toEqual(['latin-abbreviation', 'trailing-period'])

    // Full-span anchoring: the finding covers the whole sm::description(...)
    // call, not just the edited line.
    const source = fs.readFileSync(path.join(repo, 'src', 'v', 'cluster', 'lint_probe.cc'), 'utf8')
    const callLine = source.slice(0, source.indexOf('sm::description(\n')).split('\n').length
    const lastLine = source.slice(0, source.indexOf('the majority of replicas."')).split('\n').length
    expect(finding.line_start).toBe(callLine)
    expect(finding.line_end).toBe(lastLine)
    expect(finding.line_end - finding.line_start).toBe(2)
    expect(finding.declaration_text.split('\n')).toHaveLength(3)
  })
})

// Regression: a deletion-only PR used to bypass the whole review gate.
// Declarations are extracted from HEAD and the post-image parser discards
// pure-deletion hunks, so removing a metric reported declarations=0 and the
// workflow skipped every downstream step, including the published-content
// check that treats a removed surface as high impact.
describe('deletion-only diff (end-to-end, temp git repo)', () => {
  const FIXTURE = path.join(__dirname, '../../../tools/lint-strings/fixtures/metrics/lint_probe.cc')
  const REL = path.join('src', 'v', 'cluster', 'lint_probe.cc')
  let repo

  function git (args) {
    execSync(`git ${args}`, { cwd: repo, stdio: 'pipe' })
  }

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-deletion-'))
    const target = path.join(repo, REL)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(FIXTURE, target)

    git('init --quiet')
    git('config user.email lint-strings-test@example.invalid')
    git('config user.name "lint-strings test"')
    git('add .')
    git('commit --quiet -m base')

    // Remove the records_produced metric outright, adding nothing back.
    const content = fs.readFileSync(target, 'utf8')
    const block = [
      '        sm::make_counter(',
      '          "records_produced",',
      '          [this] { return _records_produced; },',
      '          sm::description("Total number of records produced"),',
      '          labels),',
      ''
    ].join('\n')
    expect(content).toContain(block)
    fs.writeFileSync(target, content.replace(block, ''))
    git('add .')
    git('commit --quiet -m "remove the records_produced metric"')
  })

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('reports the removal even though nothing can be extracted at HEAD', () => {
    const result = lintStrings({ repo, diffBase: 'HEAD~1', log: () => {} })

    // The blind spot itself: the removed declaration is gone from HEAD, and a
    // pure-deletion hunk leaves no post-image line to anchor on.
    expect(result.summary.totalDeclarations).toBe(0)
    expect(result.findings).toHaveLength(0)

    // What keeps the gate open.
    expect(result.summary.removedSurfaceLines).toBe(5)
    expect(result.summary.removedSurfaceFiles).toEqual([
      { surface: 'metrics', file: REL, lines: 5 }
    ])
  })

  test('a wholly deleted surface file is reported too', () => {
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-deleted-file-'))
    const run = (args) => execSync(`git ${args}`, { cwd: solo, stdio: 'pipe' })
    try {
      const target = path.join(solo, REL)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(FIXTURE, target)
      run('init --quiet')
      run('config user.email lint-strings-test@example.invalid')
      run('config user.name "lint-strings test"')
      run('add .')
      run('commit --quiet -m base')
      fs.rmSync(target)
      run('add -A')
      run('commit --quiet -m "drop the probe"')

      const result = lintStrings({ repo: solo, diffBase: 'HEAD~1', log: () => {} })
      expect(result.summary.totalDeclarations).toBe(0)
      expect(result.summary.removedSurfaceFiles).toEqual([
        { surface: 'metrics', file: REL, lines: 41 }
      ])
    } finally {
      fs.rmSync(solo, { recursive: true, force: true })
    }
  })

  test('non-diff mode leaves the removal fields at their empty defaults', () => {
    // Scoped to metrics: whole-repo mode would also run the python properties
    // extractor, which has no h/cc pairs to find in this fixture repo.
    const result = lintStrings({ repo, surfaces: ['metrics'], log: () => {} })
    expect(result.summary.removedSurfaceLines).toBe(0)
    expect(result.summary.removedSurfaceFiles).toEqual([])
  })
})
