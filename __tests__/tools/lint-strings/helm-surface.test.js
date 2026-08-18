'use strict'

const fs = require('fs')
const path = require('path')

const helm = require('../../../tools/lint-strings/surfaces/helm')
const { runRules } = require('../../../tools/lint-strings/engine')
const { rulesFor } = require('../../../tools/lint-strings')

const FIXTURE_PATH = path.join(__dirname, '../../../tools/lint-strings/fixtures/helm/lint_values.yaml')
const fixture = fs.readFileSync(FIXTURE_PATH, 'utf8')

/** 1-indexed line of the first occurrence of a marker string. */
function lineOf (needle) {
  const index = fixture.indexOf(needle)
  if (index === -1) throw new Error(`Marker not found in fixture: ${needle}`)
  return fixture.slice(0, index).split('\n').length
}

describe('helm values.yaml parser (parseValuesFile)', () => {
  const declarations = helm.parseValuesFile(fixture, 'charts/fixture/chart/values.yaml')
  const byName = new Map(declarations.filter((d) => d.name).map((d) => [d.name, d]))

  test('helm-docs # -- markers attach to the real key directly below, with nested paths', () => {
    expect(byName.get('enabled').string).toContain('Enable or disable the thing entirely.')
    expect(byName.get('enabled').line_start).toBe(lineOf('# -- Enable or disable'))
    expect(byName.get('enabled').line_end).toBe(lineOf('enabled: true'))
    expect(byName.get('image.repository').string).toBe('The container image repository to pull from.')
    expect(byName.get('image.repository').meta.top_level).toBe(false)
  })

  test('a documented commented-out key attaches (helm-spec convention) and suppresses its subtree', () => {
    const service = byName.get('service')
    expect(service.meta.commented_out).toBe(true)
    expect(service.string).toContain('Service settings that were commented out wholesale.')
    // Markers buried inside the commented-out subtree are dead
    const dead = declarations.filter((d) => d.meta.kind === 'dead-marker')
    expect(dead.length).toBe(3)
    expect(dead[0].line_start).toBe(lineOf('#   -- set service.name'))
    expect(dead[1].line_start).toBe(lineOf('#   -- internal Service settings'))
    // A marker separated from any key by a blank line is dead too
    expect(dead[2].line_start).toBe(lineOf('# -- This orphaned description'))
  })

  test('@doc documents an explicit path and @default annotates it', () => {
    const external = byName.get('external.domain')
    expect(external.string).toContain('Optional domain advertised to external clients.')
    expect(external.meta.default_annotation).toBe('`nil`')
  })

  test('@ignored keys are skipped; block scalars never leak markers', () => {
    expect(byName.has('internalHiddenKey')).toBe(false)
    // The "# --" inside the config block scalar is content, not a marker
    expect(declarations.some((d) => (d.string || '').includes('inside a block scalar'))).toBe(false)
  })

  test('undocumented top-level keys are surfaced as declarations', () => {
    expect(byName.get('undocumentedTopLevel').meta.undocumented).toBe(true)
    expect(byName.get('config').meta.undocumented).toBe(true)
  })
})

describe('helm surface end-to-end (fixture file)', () => {
  const os = require('os')
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-helm-'))
  const relPath = path.join('charts', 'fixture', 'chart', 'values.yaml')

  beforeAll(() => {
    fs.mkdirSync(path.join(repo, path.dirname(relPath)), { recursive: true })
    fs.copyFileSync(FIXTURE_PATH, path.join(repo, relPath))
  })

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('dead markers are errors, undocumented top-level keys info; documented keys stay clean', () => {
    const declarations = helm.extract({ repo })
    const { findings, summary } = runRules(declarations, rulesFor(helm))

    const dead = findings.filter((f) => f.rules.some((r) => r.id === 'dead-marker'))
    expect(dead).toHaveLength(3)
    for (const f of dead) {
      expect(f.rules.find((r) => r.id === 'dead-marker').severity).toBe('error')
    }

    const undocumented = findings
      .filter((f) => f.rules.some((r) => r.id === 'undocumented-top-level-key'))
      .map((f) => f.name)
      .sort()
    expect(undocumented).toEqual(['config', 'resources', 'undocumentedTopLevel'])

    // Conforming counterparts: zero findings (false-positive guard).
    // Terminal periods are optional prose style on this surface, so the
    // period-less @doc description must stay clean too.
    const flagged = new Set(findings.map((f) => f.name))
    for (const clean of ['enabled', 'image', 'image.repository', 'service', 'external.domain', 'resources.cpu']) {
      expect(flagged.has(clean)).toBe(false)
    }

    expect(summary.errors).toBe(3)
  })
})
