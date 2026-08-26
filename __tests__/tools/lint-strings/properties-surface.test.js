'use strict'

const fs = require('fs')
const path = require('path')

const properties = require('../../../tools/lint-strings/surfaces/properties')
const { describeWithExtractor } = require('../../helpers/extractor-env')
const { runRules } = require('../../../tools/lint-strings/engine')
const { rulesFor } = require('../../../tools/lint-strings')

const FIXTURE_DIR = path.join(__dirname, '../../../tools/lint-strings/fixtures/properties')
const FIXTURE_CC = path.join(FIXTURE_DIR, 'lint_fixture.cc')
const fixtureSource = fs.readFileSync(FIXTURE_CC, 'utf8')

/** 1-indexed line of the first occurrence of a marker string. */
function lineOf (needle) {
  const index = fixtureSource.indexOf(needle)
  if (index === -1) throw new Error(`Marker not found in fixture: ${needle}`)
  return fixtureSource.slice(0, index).split('\n').length
}

describe('mapExtractorJson', () => {
  const json = {
    properties: {
      good_property: {
        description: 'A helpful description of the behavior. Default is 10.',
        defined_in: 'src/v/config/configuration.cc',
        line_start: 10,
        line_end: 15,
        default: 10
      },
      empty_property: {
        description: null,
        defined_in: 'src/v/config/configuration.cc',
        line_start: 20,
        line_end: 24,
        default: null
      },
      old_property: {
        description: 'Deprecated.',
        defined_in: 'src/v/config/configuration.cc',
        is_deprecated: true
      },
      'topic.property': {
        description: 'Synthesized topic property.',
        defined_in: 'src/v/config/configuration.cc',
        is_topic_property: true
      },
      other_file_property: {
        description: 'Lives elsewhere.',
        defined_in: 'src/v/config/node_config.cc',
        line_start: 5,
        line_end: 7
      }
    }
  }

  test('maps properties to declarations with spans and meta', () => {
    const declarations = properties.mapExtractorJson(json, '/nonexistent-repo')
    const names = declarations.map((d) => d.name).sort()
    expect(names).toEqual(['empty_property', 'good_property', 'other_file_property'])

    const good = declarations.find((d) => d.name === 'good_property')
    expect(good).toMatchObject({
      surface: 'properties',
      file: 'src/v/config/configuration.cc',
      line_start: 10,
      line_end: 15,
      string: 'A helpful description of the behavior. Default is 10.'
    })
    expect(good.meta.has_default).toBe(true)

    const empty = declarations.find((d) => d.name === 'empty_property')
    expect(empty.string).toBeNull()
    expect(empty.meta.has_default).toBe(false)
  })

  test('skips deprecated and topic properties (no user-facing description contract)', () => {
    const declarations = properties.mapExtractorJson(json, '/nonexistent-repo')
    expect(declarations.some((d) => d.name === 'old_property')).toBe(false)
    expect(declarations.some((d) => d.name === 'topic.property')).toBe(false)
  })

  test('diff mode restricts declarations to the given files', () => {
    const declarations = properties.mapExtractorJson(json, '/nonexistent-repo', {
      files: new Set(['src/v/config/node_config.cc'])
    })
    expect(declarations.map((d) => d.name)).toEqual(['other_file_property'])
  })
})

describe('properties convention rules', () => {
  function decl (overrides = {}) {
    return {
      surface: 'properties',
      name: 'example',
      file: 'src/v/config/configuration.cc',
      line_start: 1,
      line_end: 1,
      string: 'A description.',
      declaration_text: '',
      convention: properties.convention,
      meta: { has_default: false, default: null },
      ...overrides
    }
  }

  test('missing-terminal-period', () => {
    const rule = properties.rules.find((r) => r.name === 'missing-terminal-period')
    expect(rule.check(decl({ string: 'No period here' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Has a period.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: null }))).toHaveLength(0)
  })

  test('default-not-stated fires at info level only when a default exists and is unmentioned', () => {
    const rule = properties.rules.find((r) => r.name === 'default-not-stated')
    expect(rule.severity).toBe('info')
    expect(rule.check(decl({ string: 'Does things.', meta: { has_default: true, default: 30 } }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Does things. Default is 30.', meta: { has_default: true, default: 30 } }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'Does things for 30 seconds.', meta: { has_default: true, default: 30 } }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'Does things.', meta: { has_default: false, default: null } }))).toHaveLength(0)
  })
})

/**
 * The properties surface bootstraps the extractor environment itself, mirroring
 * the Makefile's `venv` and `treesitter` targets. That makes the Makefile and
 * this module two statements of the same pins, and a bump on one side would
 * silently disagree with the other: the linter would check out a different
 * grammar than the generator, or look for a venv the Makefile never built.
 *
 * Nothing here manufactures a registry to maintain by hand - the test reads
 * both files and fails at the moment they diverge.
 */
describe('the extractor bootstrap agrees with the Makefile', () => {
  const MAKEFILE_PATH = path.join(__dirname, '../../../tools/property-extractor/Makefile')
  const makefile = fs.readFileSync(MAKEFILE_PATH, 'utf8')
  const treesitterTarget = makefile.slice(makefile.indexOf('\ntreesitter:') + 1)
    .split(/\n(?=[a-zA-Z][\w-]*:)/)[0]

  test('the grammar tag lives in exactly one place', () => {
    // The Makefile reads TREESITTER_TAG from this module rather than repeating
    // it, so the two bootstraps cannot check out different grammars.
    expect(makefile).toContain("require('$(MODULE_ROOT)/tools/lint-strings/surfaces/properties.js').TREESITTER_TAG")
    expect(properties.TREESITTER_TAG).toMatch(/^v\d+\.\d+\.\d+$/)
    // Guard the guard: an empty target slice would make the next assertion
    // vacuous.
    expect(treesitterTarget).toContain('tree-sitter-cpp.git')
    expect(treesitterTarget).not.toMatch(/\bv\d+\.\d+\.\d+\b/)
    expect(treesitterTarget).toContain('$(TREESITTER_TAG)')
  })

  test('the venv and grammar paths match the Makefile', () => {
    const toolRoot = path.join(__dirname, '../../../tools/property-extractor')
    const venvName = makefile.match(/^VENV\s*:?=\s*\$\(TOOL_ROOT\)\/(.+)$/m)[1].trim()
    expect(properties.VENV_PYTHON).toBe(path.join(toolRoot, venvName, 'bin', 'python'))
    const tsName = makefile.match(/^TREESITTER_DIR\s*:?=\s*\$\(TOOL_ROOT\)\/(.+)$/m)[1].trim()
    expect(properties.TREESITTER_DIR).toBe(path.join(toolRoot, tsName))
  })
})

// Integration: run the REAL Python extractor over the fixture .h/.cc pair and
// assert rule ids AND line spans. Requires the property-extractor venv and
// tree-sitter grammar (built by the Makefile / doc-tools property-docs, or by
// a previous lint-strings run). Skipped LOUDLY when they are absent so a
// local run stays hermetic, and failed outright in CI, where a silent skip is
// indistinguishable from a pass. See __tests__/helpers/extractor-env.js.
const describeIntegration = describeWithExtractor(properties)

describeIntegration('properties surface integration (real extractor over fixtures)', () => {
  jest.setTimeout(240000)

  const os = require('os')
  let repo
  let findings
  let byName
  let declarations

  beforeAll(() => {
    // The extractor only reads the known config files
    // (src/v/config/configuration.cc and friends), so stage the fixture pair
    // as a minimal repo shaped like redpanda.
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-props-fixture-'))
    fs.mkdirSync(path.join(repo, 'src', 'v', 'config'), { recursive: true })
    fs.copyFileSync(path.join(FIXTURE_DIR, 'lint_fixture.h'), path.join(repo, 'src', 'v', 'config', 'configuration.h'))
    fs.copyFileSync(FIXTURE_CC, path.join(repo, 'src', 'v', 'config', 'configuration.cc'))

    declarations = properties.extract({ repo, log: () => {} })
    const result = runRules(declarations, rulesFor(properties))
    findings = result.findings
    byName = new Map(findings.map((f) => [f.name, f]))
  })

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('extracts every fixture property with full-declaration line spans', () => {
    expect(declarations.length).toBeGreaterThanOrEqual(6)

    const compaction = declarations.find((d) => d.name === 'compaction_ctrl_update_interval_ms')
    expect(compaction.line_start).toBe(lineOf('compaction_ctrl_update_interval_ms('))
    expect(compaction.line_end).toBe(lineOf('30s)'))
    expect(compaction.declaration_text).toContain('"compaction_ctrl_update_interval_ms"')

    const credentials = declarations.find((d) => d.name === 'cloud_storage_credentials_source')
    expect(credentials.line_start).toBe(lineOf('cloud_storage_credentials_source('))
    expect(credentials.line_end).toBe(lineOf('std::nullopt)'))
    // Wrapped adjacent literals concatenate into one string
    expect(credentials.string).toContain('The source of credentials used to connect to cloud services. Accepted values:')
  })

  test('known-bad properties are flagged with the expected rule ids', () => {
    expect(byName.get('compaction_ctrl_update_interval_ms').rules.map((r) => r.id)).toEqual(['empty-description'])
    expect(byName.get('compaction_ctrl_update_interval_ms').rules[0].severity).toBe('error')

    expect(byName.get('cloud_storage_credentials_source').rules.map((r) => r.id)).toContain('unbalanced-backticks')

    const pCoeff = byName.get('cloud_storage_upload_ctrl_p_coeff')
    expect(pCoeff.rules.map((r) => r.id)).toEqual(expect.arrayContaining(['starts-lowercase', 'missing-terminal-period']))

    expect(byName.get('cluster_id').rules.map((r) => r.id)).toContain('name-echo')

    const typo = byName.get('write_caching_default_bytes')
    expect(typo.rules.map((r) => r.id)).toEqual(expect.arrayContaining(['starts-lowercase', 'too-short']))
  })

  test('conforming counterpart produces zero findings (false-positive guard)', () => {
    expect(byName.has('kafka_batch_max_bytes')).toBe(false)
  })
})
