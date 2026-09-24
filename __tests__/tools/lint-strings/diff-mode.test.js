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
    expect(routeFile('README.md')).toBeNull()
  })

  test('metrics route by content, not file name', () => {
    // Metrics registered outside *probe.cc files used to route nowhere, so a
    // bad description in any of these reported zero declarations.
    for (const file of [
      'src/v/raft/consensus.cc',
      'src/v/cluster/rm_stm.cc',
      'src/v/net/probes.cc',
      'src/v/kafka/server/kafka_probe.h'
    ]) {
      expect(routeFile(file)).toBe('metrics')
    }
    // Test sources stay out, as in the whole-repo scan, and config/ is
    // still properties.
    expect(routeFile('src/v/raft/tests/consensus_test.cc')).toBeNull()
    expect(routeFile('src/v/cluster/test/fixture.h')).toBeNull()
    expect(routeFile('src/v/config/node_config.cc')).toBe('properties')
    expect(routeFile('src/v/raft/BUILD')).toBeNull()
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

    // What keeps the gate open: the declaration itself, found by extracting
    // the merge-base side. Two of the five deleted lines are its anchors: the
    // sm::description(...) call and the name literal in make_counter(...).
    expect(result.summary.removedDeclarations).toEqual([
      expect.objectContaining({ surface: 'metrics', name: 'records_produced', file: REL })
    ])
    expect(result.summary.removedSurfaceLines).toBe(2)
    expect(result.summary.removedSurfaceFiles).toEqual([
      { surface: 'metrics', file: REL, lines: 2 }
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
      // Each removed metric's name line plus its sm::description(...) lines.
      expect(result.summary.removedDeclarations.map((d) => d.name).sort()).toEqual(
        ['buffer_size', 'committed_offset', 'records_produced', 'start_offset'].sort())
      expect(result.summary.removedSurfaceFiles).toEqual([
        { surface: 'metrics', file: REL, lines: 10 }
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

// A PR review runs on every push. These pin the two properties that keep it
// from re-reviewing or waking up for nothing: a deleted line only counts when
// it belonged to a doc-string declaration, and a string already reviewed on
// an earlier push is skipped until its text changes.
describe('review once (end-to-end, temp git repo)', () => {
  const FIXTURE = path.join(__dirname, '../../../tools/lint-strings/fixtures/metrics/lint_probe.cc')
  const REL = path.join('src', 'v', 'cluster', 'lint_probe.cc')
  let repo

  function git (args) {
    execSync(`git ${args}`, { cwd: repo, stdio: 'pipe' })
  }

  function commitEdit (from, to, message) {
    const target = path.join(repo, REL)
    const content = fs.readFileSync(target, 'utf8')
    expect(content).toContain(from)
    fs.writeFileSync(target, content.replace(from, to))
    git('add .')
    git(`commit --quiet -m "${message}"`)
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-once-'))
    const target = path.join(repo, REL)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(FIXTURE, target)
    git('init --quiet')
    git('config user.email lint-strings-test@example.invalid')
    git('config user.name "lint-strings test"')
    git('add .')
    git('commit --quiet -m base')
    git('tag base')
  })

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('deleting a line that is not part of a declaration is not a removal', () => {
    commitEdit('          [this] { return _buffer_size; },\n', '', 'drop a code line')
    const result = lintStrings({ repo, diffBase: 'base', log: () => {} })
    expect(result.summary.removedDeclarations).toEqual([])
    expect(result.summary.removedSurfaceLines).toBe(0)
    expect(result.summary.removedSurfaceFiles).toEqual([])
  })

  test('an edited declaration is reviewed, not reported as removed', () => {
    commitEdit('sm::description("start offset")', 'sm::description("Offset of the first record")', 'reword')
    const result = lintStrings({ repo, diffBase: 'base', log: () => {} })
    expect(result.summary.removedDeclarations).toEqual([])
    expect(result.declarations.map((d) => d.name)).toEqual(['start_offset'])
  })

  test('a renamed metric is a removal of the old name', () => {
    commitEdit('"records_produced"', '"records_written"', 'rename')
    const result = lintStrings({ repo, diffBase: 'base', log: () => {} })
    expect(result.summary.removedDeclarations.map((d) => d.name)).toEqual(['records_produced'])
    expect(result.declarations.map((d) => d.name)).toEqual(['records_written'])
  })

  test('a reviewed fingerprint is skipped until the string changes', () => {
    commitEdit('sm::description("start offset")', 'sm::description("start offset.")', 'first push')
    const first = lintStrings({ repo, diffBase: 'base', log: () => {} })
    expect(first.summary.totalDeclarations).toBe(1)
    const [pending] = first.declarations
    expect(pending.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(first.findings[0].fingerprint).toBe(pending.fingerprint)

    // Second push touches an unrelated line of the same declaration's file
    // and leaves the string alone: nothing new to review.
    commitEdit('[this] { return _start_offset; }', '[this] { return _start_offset + 0; }', 'second push')
    const second = lintStrings({ repo, diffBase: 'base', reviewedFingerprints: new Set([pending.fingerprint]), log: () => {} })
    expect(second.summary.totalDeclarations).toBe(0)
    expect(second.findings).toHaveLength(0)
    expect(second.declarations).toEqual([])
    expect(second.summary.alreadyReviewed).toBe(1)

    // Third push edits the string: a new fingerprint, reviewed again.
    commitEdit('sm::description("start offset.")', 'sm::description("Offset of the first record")', 'third push')
    const third = lintStrings({ repo, diffBase: 'base', reviewedFingerprints: new Set([pending.fingerprint]), log: () => {} })
    expect(third.summary.totalDeclarations).toBe(1)
    expect(third.declarations[0].fingerprint).not.toBe(pending.fingerprint)
  })

  test('a reviewed removal is not reported again', () => {
    commitEdit('"records_produced"', '"records_written"', 'rename')
    const first = lintStrings({ repo, diffBase: 'base', log: () => {} })
    const seen = new Set([...first.summary.removedDeclarations, ...first.declarations].map((d) => d.fingerprint))
    const again = lintStrings({ repo, diffBase: 'base', reviewedFingerprints: seen, log: () => {} })
    expect(again.summary.removedDeclarations).toEqual([])
    expect(again.summary.removedSurfaceLines).toBe(0)
    expect(again.summary.totalDeclarations).toBe(0)
    expect(again.summary.alreadyReviewed).toBe(2)
  })
})

// Names repeat within a surface: two proto messages both have `name` and
// `enabled`, two CRD structs both have `enabled`. Deleting one copy while the
// other survives is still a removal, so matching has to use the declaration's
// place (message path, struct) and not the bare name.
describe('removal detection with repeated names (end-to-end, temp git repo)', () => {
  const PROTO = path.join('proto', 'redpanda', 'api', 'dataplane', 'v1', 'lint_dupe.proto')
  const GO = path.join('operator', 'api', 'redpanda', 'v1alpha2', 'lint_dupe_types.go')
  const PROTO_SOURCE = [
    'syntax = "proto3";',
    '',
    'package redpanda.api.dataplane.v1;',
    '',
    '// A user account.',
    'message User {',
    '  // The user name.',
    '  string name = 1;',
    '  // Whether the user can sign in.',
    '  bool enabled = 2;',
    '}',
    '',
    '// A topic.',
    'message Topic {',
    '  // The topic name.',
    '  string name = 1;',
    '  // Whether the topic accepts writes.',
    '  bool enabled = 2;',
    '}',
    ''
  ].join('\n')
  const GO_SOURCE = [
    'package v1alpha2',
    '',
    '// ClusterSpec configures a cluster.',
    'type ClusterSpec struct {',
    '\t// Turns the cluster on.',
    '\tEnabled bool `json:"enabled"`',
    '}',
    '',
    '// ConsoleSpec configures Console.',
    'type ConsoleSpec struct {',
    '\t// Turns Console on.',
    '\tEnabled bool `json:"enabled"`',
    '}',
    ''
  ].join('\n')
  let repo

  function git (args) {
    execSync(`git ${args}`, { cwd: repo, stdio: 'pipe' })
  }

  function commitEdit (rel, from, to, message) {
    const target = path.join(repo, rel)
    const content = fs.readFileSync(target, 'utf8')
    expect(content).toContain(from)
    fs.writeFileSync(target, content.replace(from, to))
    git('add .')
    git(`commit --quiet -m "${message}"`)
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-dupe-'))
    for (const [rel, source] of [[PROTO, PROTO_SOURCE], [GO, GO_SOURCE]]) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
      fs.writeFileSync(path.join(repo, rel), source)
    }
    git('init --quiet')
    git('config user.email lint-strings-test@example.invalid')
    git('config user.name "lint-strings test"')
    git('add .')
    git('commit --quiet -m base')
    git('tag base')
  })

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('api: deleting one of two same-name fields is a removal', () => {
    commitEdit(PROTO, '  // Whether the topic accepts writes.\n  bool enabled = 2;\n', '', 'drop Topic.enabled')
    const result = lintStrings({ repo, diffBase: 'base', surfaces: ['api'], log: () => {} })
    expect(result.summary.totalDeclarations).toBe(0)
    expect(result.summary.removedDeclarations.map((d) => [d.name, d.line_start])).toEqual([['enabled', 17]])
  })

  test('api: deleting both same-name fields reports two removals with distinct fingerprints', () => {
    commitEdit(PROTO, '  // Whether the user can sign in.\n  bool enabled = 2;\n', '', 'drop User.enabled')
    commitEdit(PROTO, '  // Whether the topic accepts writes.\n  bool enabled = 2;\n', '', 'drop Topic.enabled')
    const result = lintStrings({ repo, diffBase: 'base', surfaces: ['api'], log: () => {} })
    const removed = result.summary.removedDeclarations
    expect(removed.map((d) => d.name)).toEqual(['enabled', 'enabled'])
    expect(new Set(removed.map((d) => d.fingerprint)).size).toBe(2)
  })

  test('api: moving a field within its message is not a removal', () => {
    commitEdit(PROTO, '  // The topic name.\n  string name = 1;\n  // Whether the topic accepts writes.\n  bool enabled = 2;\n',
      '  // Whether the topic accepts writes.\n  bool enabled = 2;\n  // The topic name.\n  string name = 1;\n', 'reorder Topic')
    const result = lintStrings({ repo, diffBase: 'base', surfaces: ['api'], log: () => {} })
    expect(result.summary.removedDeclarations).toEqual([])
  })

  test('crd: deleting one of two same-name struct fields is a removal', () => {
    commitEdit(GO, '\t// Turns Console on.\n\tEnabled bool `json:"enabled"`\n', '', 'drop ConsoleSpec.enabled')
    const result = lintStrings({ repo, diffBase: 'base', surfaces: ['crd'], log: () => {} })
    expect(result.summary.totalDeclarations).toBe(0)
    expect(result.summary.removedDeclarations.map((d) => [d.name, d.line_start])).toEqual([['enabled', 11]])
  })

  test('metrics: deleting one of two same-name metrics in one file is a removal', () => {
    const rel = path.join('src', 'v', 'cluster', 'lint_dupe_probe.cc')
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    fs.writeFileSync(path.join(repo, rel), [
      'void probe::setup() {',
      '  _metrics.add_group("produce", {',
      '    sm::make_counter("requests", [this] { return _produce; }, sm::description("Produce requests.")),',
      '  });',
      '  _metrics.add_group("fetch", {',
      '    sm::make_counter("requests", [this] { return _fetch; }, sm::description("Fetch requests.")),',
      '  });',
      '}',
      ''
    ].join('\n'))
    git('add .')
    git('commit --quiet -m "add probe"')
    git('tag -f base')
    commitEdit(rel, '    sm::make_counter("requests", [this] { return _fetch; }, sm::description("Fetch requests.")),\n', '', 'drop fetch requests')
    const result = lintStrings({ repo, diffBase: 'base', surfaces: ['metrics'], log: () => {} })
    expect(result.summary.removedDeclarations.map((d) => [d.name, d.line_start])).toEqual([['requests', 6]])
  })

  test('crd: an edited field is reviewed, not reported as removed', () => {
    commitEdit(GO, '\t// Turns Console on.\n', '\t// Turns on Console.\n', 'reword ConsoleSpec.enabled')
    const result = lintStrings({ repo, diffBase: 'base', surfaces: ['crd'], log: () => {} })
    expect(result.summary.removedDeclarations).toEqual([])
    expect(result.declarations.map((d) => d.name)).toEqual(['enabled'])
  })
})

describe('readFingerprints', () => {
  const { readFingerprints } = require('../../../tools/lint-strings')

  test('a missing file is an empty set, and non-fingerprint tokens are ignored', () => {
    expect(readFingerprints(path.join(os.tmpdir(), 'no-such-lint-strings-state'))).toEqual(new Set())
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-fp-')), 'reviewed.txt')
    fs.writeFileSync(file, '0123456789abcdef\nnot-a-fingerprint, fedcba9876543210\n\nABCDEF0123456789\n')
    expect(readFingerprints(file)).toEqual(new Set(['0123456789abcdef', 'fedcba9876543210']))
  })
})

describe('CLI output through a pipe', () => {
  test('a report larger than the pipe buffer arrives whole', () => {
    // runCli used to call process.exit() right after console.log, which
    // drops buffered output when stdout is a pipe: anything past the first
    // 64 KiB of a JSON report never reached the reader.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-pipe-'))
    try {
      const file = path.join(repo, 'src', 'v', 'cluster', 'big_probe.cc')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const metrics = []
      for (let i = 0; i < 1500; i++) {
        metrics.push(`        sm::make_gauge("m${i}", [] { return 0; }, sm::description("m${i}."), labels),`)
      }
      fs.writeFileSync(file, `void f() {\n  _metrics.add_group("g", {\n${metrics.join('\n')}\n  });\n}\n`)
      const cli = path.join(__dirname, '../../../tools/lint-strings/index.js')
      const r = require('child_process').spawnSync(process.execPath, [cli, '--repo', repo, '--surface', 'metrics', '--format', 'json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      expect(r.status).toBe(0)
      expect(r.stdout.length).toBeGreaterThan(256 * 1024)
      const report = JSON.parse(r.stdout)
      expect(report.summary.totalDeclarations).toBe(1500)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})
