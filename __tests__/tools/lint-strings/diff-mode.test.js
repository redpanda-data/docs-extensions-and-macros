'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync } = require('child_process')

const { parseUnifiedDiff, routeFile, spanIntersects, classifyDiff } = require('../../../tools/lint-strings/diff')
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
    expect(finding.rules.map((r) => r.id)).toEqual(['trailing-period'])

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
