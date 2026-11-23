'use strict'

const { runRules } = require('../../../tools/lint-strings/engine')
const { rulesFor, SURFACES } = require('../../../tools/lint-strings')
const { CLI_HELP_KINDS } = require('../../../tools/lint-strings/rules/common')

const CONVENTION_OF = {
  rpk: () => SURFACES.rpk.convention,
  operator: () => SURFACES.operator.convention,
  // The connect CLI kinds carry their own convention.
  connect: () => SURFACES.connect.cliConvention
}

const decl = (surface, kind, string, convention = CONVENTION_OF[surface]()) => ({
  surface, name: 'x', file: 'x.go', line_start: 1, line_end: 1, string, convention, meta: { kind }
})

const ruleIds = (surface, kind, string, convention) =>
  runRules([decl(surface, kind, string, convention)], rulesFor(SURFACES[surface])).findings.flatMap((f) => f.rules.map((r) => r.id))

const issues = (surface, kind, string) =>
  runRules([decl(surface, kind, string)], rulesFor(SURFACES[surface]), { onlyRules: ['cli-backtick'] }).findings.flatMap((f) => f.rules)

describe('cli-backtick', () => {
  const rule = rulesFor(SURFACES.rpk).find((r) => r.name === 'cli-backtick')

  test('is one common error rule with a why and a standard', () => {
    expect(rule.severity).toBe('error')
    expect(rule.why).toMatch(/value placeholder/)
    expect(rule.why).toMatch(/snake_case names, paths and URLs/)
    expect(rule.standard).toMatch(/^https:\/\//)
    for (const surface of ['rpk', 'operator', 'connect']) {
      expect(rulesFor(SURFACES[surface]).map((r) => r.name)).toContain('cli-backtick')
    }
  })

  test('names the CLI help kinds of each surface', () => {
    expect(CLI_HELP_KINDS).toEqual({
      rpk: ['short', 'long', 'flag'],
      operator: ['flag', 'deprecation'],
      connect: ['cli-flag', 'cli-usage', 'cli-usage-text', 'cli-description']
    })
  })

  test.each(
    Object.entries(CLI_HELP_KINDS).flatMap(([surface, kinds]) => kinds.map((kind) => [surface, kind]))
  )('fires on %s %s', (surface, kind) => {
    const found = issues(surface, kind, 'If no prefix is given, `User:` is used')
    expect(found).toHaveLength(1)
    expect(found[0].message).toMatch(/\(`User:`\)/)
    expect(found[0].severity).toBe('error')
  })

  test('the message for a flag names the value placeholder; for command help, literal backticks', () => {
    expect(issues('rpk', 'flag', 'Uses `User:`')[0].message).toMatch(/value placeholder/)
    expect(issues('connect', 'cli-flag', 'Uses `User:`')[0].message).toMatch(/value placeholder/)
    expect(issues('rpk', 'short', 'Uses `User:`')[0].message).toMatch(/prints backticks literally/)
    expect(issues('connect', 'cli-description', 'Uses `User:`')[0].message).toMatch(/prints backticks literally/)
  })

  test('ignores strings with no backtick', () => {
    expect(issues('rpk', 'flag', 'If no prefix is given, User: is used')).toEqual([])
  })

  test('ignores kinds that are not CLI help', () => {
    expect(issues('connect', 'field', 'Set `topic` here.')).toEqual([])
    expect(issues('connect', 'cli-args-usage', '`file`')).toEqual([])
  })

  test('ignores surfaces that are not CLI help', () => {
    const d = { surface: 'properties', name: 'x', file: 'x.cc', line_start: 1, line_end: 1, string: 'Uses `x_y`.', convention: SURFACES.properties.convention, meta: { kind: 'flag' } }
    const ids = runRules([d], rulesFor(SURFACES.properties)).findings.flatMap((f) => f.rules.map((r) => r.id))
    expect(ids).not.toContain('cli-backtick')
  })

  test('a backtick on an indented code line of Long is part of the code', () => {
    const long = 'Plugins print the following:\n\n  type pluginHelp struct {\n    Path string `json:"path,omitempty"`\n  }'
    expect(issues('rpk', 'long', long)).toEqual([])
    expect(issues('rpk', 'long', `${long}\n\nThe \`client_id\` field.`)).toHaveLength(1)
  })

  test('reports every span, so diff mode keeps the one a PR changed', () => {
    const [issue] = rule.check(decl('rpk', 'flag', 'Use `a` or `b`'))
    expect(issue.at.map((a) => a.index)).toEqual([4, 11])
  })
})

describe('missing-inline-code on CLI help', () => {
  const BARE = 'Set default_topic_partitions with --partitions from /v1/brokers'

  test.each(
    Object.entries(CLI_HELP_KINDS).flatMap(([surface, kinds]) => kinds.map((kind) => [surface, kind]))
  )('never fires on %s %s', (surface, kind) => {
    expect(ruleIds(surface, kind, BARE)).not.toContain('missing-inline-code')
  })

  test('every CLI help convention declares every kind the generator formats', () => {
    for (const convention of [SURFACES.rpk.convention, SURFACES.operator.convention, SURFACES.connect.cliConvention]) {
      expect(convention.auto_inline_code.kinds).toEqual(['identifier', 'flag', 'path'])
    }
  })

  test('still fires on a connect field description, which is not CLI help', () => {
    expect(ruleIds('connect', 'field', 'Set default_topic_partitions here.', SURFACES.connect.convention)).toContain('missing-inline-code')
  })
})
