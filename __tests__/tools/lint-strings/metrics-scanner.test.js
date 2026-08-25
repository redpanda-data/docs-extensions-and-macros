'use strict'

const fs = require('fs')
const path = require('path')

const metrics = require('../../../tools/lint-strings/surfaces/metrics')
const { runRules } = require('../../../tools/lint-strings/engine')
const { rulesFor } = require('../../../tools/lint-strings')

const FIXTURE_PATH = path.join(__dirname, '../../../tools/lint-strings/fixtures/metrics/lint_probe.cc')
const fixture = fs.readFileSync(FIXTURE_PATH, 'utf8')

/** 1-indexed line of the first occurrence of a marker string. */
function lineOf (needle) {
  const index = fixture.indexOf(needle)
  if (index === -1) throw new Error(`Marker not found in fixture: ${needle}`)
  return fixture.slice(0, index).split('\n').length
}

describe('metrics scanner (scanFile)', () => {
  const declarations = metrics.scanFile(fixture, 'src/v/cluster/lint_probe.cc')
  const byName = new Map(declarations.map((d) => [d.name, d]))

  test('finds every sm::description call and resolves metric names from the enclosing make_* call', () => {
    expect(declarations).toHaveLength(4)
    expect([...byName.keys()].sort()).toEqual(['buffer_size', 'committed_offset', 'records_produced', 'start_offset'])
  })

  test('single-literal description records its exact line span', () => {
    const d = byName.get('start_offset')
    const line = lineOf('sm::description("start offset")')
    expect(d.string).toBe('start offset')
    expect(d.line_start).toBe(line)
    expect(d.line_end).toBe(line)
  })

  test('wrapped adjacent literals are concatenated and span all call lines', () => {
    const d = byName.get('committed_offset')
    expect(d.string).toBe('Partition commited offset. i.e. safely persisted on majority of replicas.')
    expect(d.line_start).toBe(lineOf('sm::description(\n'))
    expect(d.line_end).toBe(lineOf('majority of replicas."'))
    expect(d.line_end).toBe(d.line_start + 2)
  })

  test('non-literal argument is captured as unverifiable, with string null', () => {
    const d = byName.get('buffer_size')
    expect(d.meta.unverifiable).toBe(true)
    expect(d.string).toBeNull()
  })
})

describe('metrics surface end-to-end (fixture file)', () => {
  // Copy the fixture into a temp "repo" so extract() also exercises
  // declaration_text slicing.
  const os = require('os')
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-metrics-'))
  const relPath = path.join('src', 'v', 'cluster', 'lint_probe.cc')

  beforeAll(() => {
    fs.mkdirSync(path.join(repo, 'src', 'v', 'cluster'), { recursive: true })
    fs.copyFileSync(FIXTURE_PATH, path.join(repo, relPath))
  })

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('known-bads are flagged with the expected rule ids; conforming metric stays clean', () => {
    const declarations = metrics.extract({ repo })
    const { findings, summary } = runRules(declarations, rulesFor(metrics))
    const byName = new Map(findings.map((f) => [f.name, f]))

    // start offset: name-echo + lowercase start (+ under 20 chars)
    const startOffset = byName.get('start_offset')
    expect(startOffset).toBeDefined()
    const startOffsetRules = startOffset.rules.map((r) => r.id)
    expect(startOffsetRules).toEqual(expect.arrayContaining(['name-echo', 'starts-lowercase', 'too-short']))

    // "commited" typo string is FINE (typo detection is not a rule), but the
    // terminal period violates the metrics convention.
    const committed = byName.get('committed_offset')
    expect(committed).toBeDefined()
    expect(committed.rules.map((r) => r.id)).toEqual(['trailing-period'])
    expect(committed.rules[0].severity).toBe('warning')

    // Unverifiable stays info-level, never error
    const buffer = byName.get('buffer_size')
    expect(buffer).toBeDefined()
    expect(buffer.rules.map((r) => r.id)).toEqual(['unverifiable-description'])
    expect(buffer.rules[0].severity).toBe('info')

    // Conforming counterpart: zero findings (false-positive guard)
    expect(byName.has('records_produced')).toBe(false)

    // declaration_text carries the exact source lines of the span
    expect(committed.declaration_text).toContain('sm::description(')
    expect(committed.declaration_text).toContain('"majority of replicas."),')
    expect(summary.errors).toBe(0)
  })
})
