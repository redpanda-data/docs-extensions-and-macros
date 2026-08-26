'use strict'

const fs = require('fs')
const path = require('path')

const crd = require('../../../tools/lint-strings/surfaces/crd')
const { runRules } = require('../../../tools/lint-strings/engine')
const { rulesFor } = require('../../../tools/lint-strings')

const FIXTURE_DIR = path.join(__dirname, '../../../tools/lint-strings/fixtures/crd')
const FIXTURE_GO = path.join(FIXTURE_DIR, 'lint_types.go')
const fixture = fs.readFileSync(FIXTURE_GO, 'utf8')

/** 1-indexed line of the first occurrence of a marker string. */
function lineOf (needle) {
  const index = fixture.indexOf(needle)
  if (index === -1) throw new Error(`Marker not found in fixture: ${needle}`)
  return fixture.slice(0, index).split('\n').length
}

/** Stage the fixture pair as a minimal repo shaped like redpanda-operator. */
function stageRepo () {
  const os = require('os')
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-crd-'))
  const apiDir = path.join(repo, 'operator', 'api', 'redpanda', 'v1alpha2')
  fs.mkdirSync(apiDir, { recursive: true })
  fs.copyFileSync(FIXTURE_GO, path.join(apiDir, 'lint_types.go'))
  fs.copyFileSync(
    path.join(FIXTURE_DIR, 'crd-ref-docs-config.yaml'),
    path.join(repo, 'operator', 'crd-ref-docs-config.yaml')
  )
  return repo
}

describe('crd surface end-to-end (fixture repo with crd-ref-docs config)', () => {
  let repo
  let declarations
  let findings
  let summary

  beforeAll(() => {
    repo = stageRepo()
    declarations = crd.extract({ repo })
    const result = runRules(declarations, rulesFor(crd))
    findings = result.findings
    summary = result.summary
  })

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('declarations are named by json tag, span comment through field, and strip +markers', () => {
    const byName = new Map(declarations.map((d) => [`${d.meta.struct}.${d.name}`, d]))
    expect([...byName.keys()].sort()).toEqual([
      'WidgetReference.name', 'WidgetReference.subject', 'WidgetReference.version',
      'WidgetSpec.cluster', 'WidgetSpec.replicas', 'WidgetSpec.text'
    ])

    const cluster = byName.get('WidgetSpec.cluster')
    expect(cluster.name).toBe('cluster') // json tag, not the Go name
    expect(cluster.meta.go_name).toBe('ClusterSource')
    expect(cluster.line_start).toBe(lineOf('// ClusterSource is a reference'))
    expect(cluster.line_end).toBe(lineOf('ClusterSource *ClusterSource'))
    // +required and +kubebuilder markers are stripped from the prose
    expect(cluster.string).not.toContain('+required')
    expect(cluster.string).not.toContain('+kubebuilder')
  })

  test('crd-ref-docs config filtering: ignoreTypes, +hidefromdoc, and json:"-" never lint', () => {
    const structs = new Set(declarations.map((d) => d.meta.struct))
    expect(structs.has('WidgetList')).toBe(false) // ignoreTypes 'List$'
    expect(structs.has('DeprecatedWidget')).toBe(false) // ignoreTypes 'Deprecated.*$'
    expect(structs.has('HiddenStruct')).toBe(false) // +hidefromdoc on the type
    const names = new Set(declarations.map((d) => d.name))
    expect(names.has('hiddenKnob')).toBe(false) // +hidefromdoc on the field
    expect(declarations.some((d) => d.meta.go_name === 'NotSerialized')).toBe(false) // json:"-"
  })

  test('go-field-name-first flags "ClusterSource is..." but not a case-only match', () => {
    const byName = new Map(findings.map((f) => [f.name, f]))
    const cluster = byName.get('cluster')
    expect(cluster.rules.map((r) => r.id)).toEqual(['go-field-name-first'])
    expect(cluster.rules[0].severity).toBe('warning')
    expect(cluster.rules[0].message).toContain('ClusterSource')
    expect(cluster.rules[0].message).toContain('"cluster"')

    // "Text is..." matches the json name up to case: conforming
    expect(byName.has('text')).toBe(false)
  })

  test('undocumented exported fields in a user-facing struct are warnings', () => {
    const undocumented = findings
      .filter((f) => f.rules.some((r) => r.id === 'undocumented-field'))
      .map((f) => f.name)
      .sort()
    expect(undocumented).toEqual(['name', 'subject', 'version'])
    // undocumented-field is the warning-level owner of missing prose: the
    // generic empty-description error must never double-report it.
    expect(summary.byRule['empty-description']).toBeUndefined()
    expect(summary.errors).toBe(0)
  })

  test('conforming field produces zero findings (false-positive guard)', () => {
    expect(findings.some((f) => f.name === 'replicas')).toBe(false)
  })
})
