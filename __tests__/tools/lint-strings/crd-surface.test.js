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
      'FallbackSpec.both', 'FallbackSpec.external', 'FallbackSpec.fromUndocumented',
      'FallbackSpec.inherited', 'FallbackSpec.primitive', 'FallbackSpec.sliceOfDocumented',
      'UndocumentedTarget.only', 'ValueSource.value',
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
    // fromUndocumented, primitive and sliceOfDocumented are the three shapes
    // that genuinely ship blank; `inherited` and `external` publish their
    // type's comment and so are deliberately absent.
    expect(undocumented).toEqual([
      'fromUndocumented', 'name', 'primitive', 'sliceOfDocumented', 'subject', 'version'
    ])
    // undocumented-field is the warning-level owner of missing prose: the
    // generic empty-description error must never double-report it.
    expect(summary.byRule['empty-description']).toBeUndefined()
    expect(summary.errors).toBe(0)
  })

  test('conforming field produces zero findings (false-positive guard)', () => {
    expect(findings.some((f) => f.name === 'replicas')).toBe(false)
  })
})

describe('crd scanner: a one-line empty struct must not desynchronize the parser', () => {
  const config = { ignoreTypes: [], ignoreFields: [], hiddenMarker: 'hidefromdoc' }

  test('declarations after `type X struct{}` are still found', () => {
    // `type X struct{}` opens and closes on one line. Assuming depth 1 left
    // the parser inside a struct that had already ended, so the next `type
    // ... struct {` read as a field line and its fields sat at depth 2, which
    // the depth === 1 gate drops. One of these blanked a whole file.
    const declared = crd.scanFile([
      'package v1alpha2',
      '',
      '// Empty on one line.',
      'type Empty struct{}',
      '',
      '// Later has fields.',
      'type Later struct {',
      '\t// The name.',
      '\tName string `json:"name"`',
      '}',
      '',
      '// EvenLater too.',
      'type EvenLater struct {',
      '\t// The size.',
      '\tSize int `json:"size"`',
      '}'
    ].join('\n'), 'operator/api/redpanda/v1alpha2/x.go', config)
    expect(declared.map((d) => `${d.meta.struct}.${d.name}`)).toEqual(['Later.name', 'EvenLater.size'])
  })

  test('the real fixture keeps the types declared after its empty struct', () => {
    const declared = crd.scanFile(fixture, 'operator/api/redpanda/v1alpha2/lint_types.go', config)
    const structs = new Set(declared.map((d) => d.meta.struct))
    for (const name of ['ValueSource', 'UndocumentedTarget', 'FallbackSpec']) {
      expect(structs.has(name)).toBe(true)
    }
  })
})

describe('crd scanner: what an uncommented field actually publishes', () => {
  const config = { ignoreTypes: [], ignoreFields: [], hiddenMarker: 'hidefromdoc' }
  const declared = crd.scanFile(fixture, 'operator/api/redpanda/v1alpha2/lint_types.go', config)
  const byName = new Map(declared.map((d) => [`${d.meta.struct}.${d.name}`, d]))

  // Each expectation below was verified by running controller-gen v0.20.1
  // over a fixture module and reading the generated schema.
  test.each([
    ['a direct ref to a documented type inherits its comment', 'FallbackSpec.inherited', 'ValueSource', false],
    ['an external type inherits an upstream comment not visible here', 'FallbackSpec.external', 'metav1.Duration', true]
  ])('%s', (_label, key, from, external) => {
    expect(byName.get(key).string).toBeNull()
    expect(byName.get(key).meta.inherited_from).toBe(from)
    expect(byName.get(key).meta.inherited_external).toBe(external)
  })

  test.each([
    ['a ref to an undocumented type has nothing to inherit', 'FallbackSpec.fromUndocumented'],
    ['a primitive has nothing to inherit', 'FallbackSpec.primitive'],
    // controller-gen puts the type's comment on items, never on the field, so
    // the field's own description is blank.
    ['a slice inherits onto items, not onto the field', 'FallbackSpec.sliceOfDocumented']
  ])('%s', (_label, key) => {
    expect(byName.get(key).string).toBeNull()
    expect(byName.get(key).meta.inherited_from).toBeNull()
  })

  test("a field's own comment beats the type's, so nothing is inherited", () => {
    expect(byName.get('FallbackSpec.both').string).toContain('How long to wait')
    expect(byName.get('FallbackSpec.both').meta.inherited_from).toBeNull()
  })
})

describe('crd rules: blank versus inherited', () => {
  const rules = rulesFor(crd)
  const config = { ignoreTypes: [], ignoreFields: [], hiddenMarker: 'hidefromdoc' }
  const declared = crd.scanFile(fixture, 'operator/api/redpanda/v1alpha2/lint_types.go', config)
  const byName = new Map(declared.map((d) => [`${d.meta.struct}.${d.name}`, d]))
  const idsFor = (key) => {
    const { findings } = runRules([byName.get(key)], rules)
    return findings.length === 0 ? [] : findings[0].rules.map((r) => r.id)
  }

  test('an inherited description is not reported as an undocumented field', () => {
    // It does not ship blank, so "ships blank in the CRD reference" was
    // simply false - it was wrong on 37 of 208 findings on operator main.
    const ids = idsFor('FallbackSpec.inherited')
    expect(ids).not.toContain('undocumented-field')
    expect(ids).toContain('inherited-type-description')
  })

  test('the inherited-description message names the type and the json key', () => {
    const { findings } = runRules([byName.get('FallbackSpec.inherited')], rules)
    const message = findings[0].rules.find((r) => r.id === 'inherited-type-description').message
    expect(message).toContain('ValueSource')
    expect(message).toContain('inherited')
  })

  test('an external inherited description is left alone entirely', () => {
    // Upstream prose we do not own and cannot see from this checkout.
    expect(idsFor('FallbackSpec.external')).toEqual([])
  })

  test.each([
    ['a ref to an undocumented type', 'FallbackSpec.fromUndocumented'],
    ['a primitive', 'FallbackSpec.primitive'],
    ['a slice', 'FallbackSpec.sliceOfDocumented'],
    ['a plain undocumented string field', 'WidgetReference.name']
  ])('%s does ship blank and is still reported', (_label, key) => {
    expect(idsFor(key)).toContain('undocumented-field')
  })
})
