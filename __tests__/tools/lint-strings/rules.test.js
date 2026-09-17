'use strict'

const { runRules } = require('../../../tools/lint-strings/engine')
const { COMMON_RULES, isNameEcho } = require('../../../tools/lint-strings/rules/common')
const { VERBATIM_ASCIIDOC_RULES } = require('../../../tools/lint-strings/rules/verbatim-asciidoc')

function decl (overrides = {}) {
  return {
    surface: 'properties',
    name: 'example_property',
    file: 'src/v/config/configuration.cc',
    line_start: 10,
    line_end: 15,
    string: 'A perfectly reasonable description of the property behavior.',
    declaration_text: 'example_property(...)',
    convention: {},
    meta: {},
    ...overrides
  }
}

function ruleByName (rules, name) {
  const rule = rules.find((r) => r.name === name)
  if (!rule) throw new Error(`No rule named ${name}`)
  return rule
}

describe('common rules', () => {
  test('empty-description flags null, empty, and whitespace-only strings', () => {
    const rule = ruleByName(COMMON_RULES, 'empty-description')
    expect(rule.severity).toBe('error')
    expect(rule.check(decl({ string: null }))).toHaveLength(1)
    expect(rule.check(decl({ string: '' }))).toHaveLength(1)
    expect(rule.check(decl({ string: '   ' }))).toHaveLength(1)
    expect(rule.check(decl())).toHaveLength(0)
  })

  test('starts-lowercase flags lowercase prose but not backtick-led or digit-led strings', () => {
    const rule = ruleByName(COMMON_RULES, 'starts-lowercase')
    expect(rule.check(decl({ string: 'proportional coefficient for upload PID controller' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Proportional coefficient.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: '`true` enables the thing.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: '2 hours between runs.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: null }))).toHaveLength(0)
  })

  test('name-echo detects tautologies with normalization, prefixes, and reordering', () => {
    expect(isNameEcho('cluster_id', 'Cluster identifier.')).toBe(true)
    expect(isNameEcho('start_offset', 'start offset')).toBe(true)
    expect(isNameEcho('start_offset', 'Offset start')).toBe(true)
    expect(isNameEcho('start-offset', 'Start offset.')).toBe(true)
    // Real descriptions are not echoes
    expect(isNameEcho('cluster_id', 'Unique identifier for this cluster, assigned at bootstrap.')).toBe(false)
    // Same token count but unrelated words
    expect(isNameEcho('start_offset', 'first record')).toBe(false)
    // Different token counts
    expect(isNameEcho('cloud_storage_upload_ctrl_p_coeff', 'proportional coefficient for upload PID controller')).toBe(false)

    const rule = ruleByName(COMMON_RULES, 'name-echo')
    expect(rule.check(decl({ name: 'cluster_id', string: 'Cluster identifier.' }))).toHaveLength(1)
    expect(rule.check(decl({ name: null, string: 'Cluster identifier.' }))).toHaveLength(0)
  })

  test('too-short flags under 20 characters but leaves empty to empty-description', () => {
    const rule = ruleByName(COMMON_RULES, 'too-short')
    expect(rule.check(decl({ string: '1234567890123456789' }))).toHaveLength(1) // 19
    expect(rule.check(decl({ string: '12345678901234567890' }))).toHaveLength(0) // 20
    expect(rule.check(decl({ string: '' }))).toHaveLength(0)
    expect(rule.check(decl({ string: null }))).toHaveLength(0)
  })

  test('unexpanded-jargon matches on word boundaries only', () => {
    const rule = ruleByName(COMMON_RULES, 'unexpanded-jargon')
    expect(rule.check(decl({ string: 'Timeout for each NTP to recover.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Uses the seastar reactor for scheduling.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Set to nullopt to disable.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Snapshot size of the stm state.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'One instance per smp core.' }))).toHaveLength(1)
    // Word characters (including _) around the term must not match
    expect(rule.check(decl({ string: 'Size of the archival_meta_stm snapshot in bytes plus more words.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'A stable stream of records.' }))).toHaveLength(0)
  })

  test('em-dash flags em dashes and counts them, and leaves hyphens alone', () => {
    const rule = ruleByName(COMMON_RULES, 'em-dash')
    expect(rule.severity).toBe('warning')
    expect(rule.check(decl({ string: 'Upgraded on first write \u2014 irreversibly \u2014 unless copy-on-write is set.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Upgraded on first write \u2014 irreversibly \u2014 unless set.' }))[0].message)
      .toMatch(/2 em dashes/)
    expect(rule.check(decl({ string: 'Upgraded on first write, irreversibly, unless copy-on-write is set.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'Use the copy-on-write merge strategy for version 1 tables.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: null }))).toHaveLength(0)
  })

  test('latin-abbreviation flags e.g. and i.e. but not words that merely contain them', () => {
    const rule = ruleByName(COMMON_RULES, 'latin-abbreviation')
    expect(rule.severity).toBe('warning')
    expect(rule.check(decl({ string: 'Set a prefix (e.g. `s3://my-bucket/`) since Glue assigns no location.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Set a prefix (E.g., `s3://my-bucket/`).' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'The signal table, i.e. the table used for signals.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Both forms, e.g. this and i.e. that, are flagged.' }))).toHaveLength(2)
    expect(rule.check(decl({ string: 'Set a prefix, for example `s3://my-bucket/`.' }))).toHaveLength(0)
    // Not a Latin abbreviation: part of a longer token.
    expect(rule.check(decl({ string: 'Fetch from https://example.g.co/path for the manifest.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'The page.g.field selector is resolved at startup.' }))).toHaveLength(0)
    // A host or identifier that contains the abbreviation is not one.
    expect(rule.check(decl({ string: 'Point the endpoint at https://e.g.example/path for the manifest.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'Set `i.e.identifier` to the resolved name.' }))).toHaveLength(0)
  })

  test('unbalanced-backticks flags odd counts', () => {
    const rule = ruleByName(COMMON_RULES, 'unbalanced-backticks')
    expect(rule.check(decl({ string: 'Accepted values: `config_file`, `sts, `other`.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Accepted values: `config_file`, `sts`.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'No backticks at all.' }))).toHaveLength(0)
  })
})

describe('verbatim-asciidoc rules', () => {
  test('raw-pipe flags unescaped | outside backticks', () => {
    const rule = ruleByName(VERBATIM_ASCIIDOC_RULES, 'raw-pipe')
    expect(rule.check(decl({ string: 'Use a | to separate values.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Use `a | b` syntax.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'Use a \\| to separate values.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'No pipes here.' }))).toHaveLength(0)
  })

  test('unknown-attribute flags {attr} that is not a known product attribute', () => {
    const rule = ruleByName(VERBATIM_ASCIIDOC_RULES, 'unknown-attribute')
    expect(rule.check(decl({ string: 'Path template {namespace}/{topic}/{partition_id}.' }))).toHaveLength(3)
    expect(rule.check(decl({ string: 'Requires {latest-redpanda-version} or newer.' }))).toHaveLength(0)
    // Not attribute-shaped: empty braces, digits, uppercase
    expect(rule.check(decl({ string: 'Uses {} and {0} and {FOO} placeholders.' }))).toHaveLength(0)
  })

  test('broken-macro flags xref/glossterm/config_ref with unbalanced brackets', () => {
    const rule = ruleByName(VERBATIM_ASCIIDOC_RULES, 'broken-macro')
    expect(rule.check(decl({ string: 'See xref:manage:cluster.adoc[Cluster guide] for details.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'See glossterm:partition[] for details.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'See config_ref:write_caching,true,properties/cluster-properties[] too.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'See xref:manage:cluster.adoc[Cluster guide for details.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'See glossterm:partition for details.' }))).toHaveLength(1)
  })
})

describe('engine', () => {
  test('collates findings per declaration with byRule and bySurface summary', () => {
    const declarations = [
      decl({ name: 'empty_prop', string: null }),
      decl({ name: 'fine_prop' })
    ]
    const { findings, summary } = runRules(declarations, COMMON_RULES)

    expect(findings).toHaveLength(1)
    expect(findings[0].name).toBe('empty_prop')
    expect(findings[0].rules.map((r) => r.id)).toEqual(['empty-description'])
    expect(findings[0].rules[0].severity).toBe('error')
    // Full JSON contract fields present
    for (const key of ['surface', 'name', 'file', 'line_start', 'line_end', 'string', 'declaration_text', 'rules', 'convention', 'in_pr_diff']) {
      expect(findings[0]).toHaveProperty(key)
    }

    expect(summary.totalDeclarations).toBe(2)
    expect(summary.flaggedDeclarations).toBe(1)
    expect(summary.errors).toBe(1)
    expect(summary.byRule['empty-description'].errors).toBe(1)
    expect(summary.bySurface.properties.declarations).toBe(2)
    expect(summary.bySurface.properties.flagged).toBe(1)
  })

  test('skipRules and onlyRules filter which rules run', () => {
    const bad = decl({ string: 'short and lowercase' }) // 19 chars, lowercase
    const all = runRules([bad], COMMON_RULES)
    expect(all.findings[0].rules.map((r) => r.id).sort()).toEqual(['starts-lowercase', 'too-short'])

    const skipped = runRules([bad], COMMON_RULES, { skipRules: ['too-short'] })
    expect(skipped.findings[0].rules.map((r) => r.id)).toEqual(['starts-lowercase'])

    const only = runRules([bad], COMMON_RULES, { onlyRules: ['too-short'] })
    expect(only.findings[0].rules.map((r) => r.id)).toEqual(['too-short'])
  })

  test('unverifiable declarations only run opt-in rules and never error', () => {
    const infoRule = {
      name: 'unverifiable-description',
      severity: 'info',
      runOnUnverifiable: true,
      check: (d) => (d.meta.unverifiable ? [{ message: 'cannot verify' }] : [])
    }
    const unverifiable = decl({ string: null, meta: { unverifiable: true } })
    const { findings, summary } = runRules([unverifiable], [...COMMON_RULES, infoRule])

    expect(findings).toHaveLength(1)
    expect(findings[0].rules.map((r) => r.id)).toEqual(['unverifiable-description'])
    expect(summary.errors).toBe(0)
    expect(summary.info).toBe(1)
  })

  test('a crashing rule becomes an error finding instead of aborting the run', () => {
    const crashing = { name: 'boom', severity: 'warning', check: () => { throw new Error('kaboom') } }
    const { findings } = runRules([decl()], [crashing])
    expect(findings[0].rules[0]).toMatchObject({ id: 'boom', severity: 'error' })
    expect(findings[0].rules[0].message).toContain('kaboom')
  })
})
