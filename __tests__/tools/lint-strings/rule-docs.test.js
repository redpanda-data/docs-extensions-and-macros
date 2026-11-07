'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  SURFACES,
  rulesFor,
  listRules,
  formatHuman,
  formatRulesAsciidoc
} = require('../../../tools/lint-strings')
const { runRules } = require('../../../tools/lint-strings/engine')

/**
 * Every lint-strings rule documents itself: what it checks (description),
 * what breaks for readers when it is violated (why), and the section of the
 * docs team standard it enforces (standard). --list-rules, the Why line on
 * findings and the Rules section of CLI_REFERENCE.adoc all read these fields,
 * so a rule without them is undocumented everywhere at once.
 */

const REPO_ROOT = path.join(__dirname, '..', '..', '..')
const BIN = path.join(REPO_ROOT, 'bin', 'doc-tools.js')
const STANDARD_URL = /^https:\/\/github\.com\/redpanda-data\/docs-team-standards\/blob\/main\/\S+\.md(#[a-z0-9-]+)?$/

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== ''

describe('every rule documents its reason and standard', () => {
  const cases = []
  for (const [surfaceName, surface] of Object.entries(SURFACES)) {
    for (const rule of rulesFor(surface)) cases.push([surfaceName, rule.name, rule])
  }

  test('found the rules', () => {
    // Guard the guard: an empty registry would pass every check below.
    expect(Object.keys(SURFACES).length).toBeGreaterThanOrEqual(7)
    expect(new Set(cases.map(([, name]) => name)).size).toBeGreaterThanOrEqual(40)
  })

  test.each(cases)('%s: %s has a description, a why and a standard', (surfaceName, name, rule) => {
    const missing = ['description', 'why', 'standard'].filter((field) => !nonEmpty(rule[field]))
    expect({ rule: name, missing }).toEqual({ rule: name, missing: [] })
    expect(rule.standard).toMatch(STANDARD_URL)
  })

  // The PR review reads the tier to decide what is posted on the PR and what
  // goes to the job summary only, so every rule must state one. A missing
  // tier would fall back to unclear and post a style nit as a PR comment.
  test.each(cases)('%s: %s has a tier', (surfaceName, name, rule) => {
    expect({ rule: name, tier: rule.tier }).toEqual({ rule: name, tier: expect.stringMatching(/^(wrong|unclear|style)$/) })
  })
})

describe('--list-rules', () => {
  test('lists each rule once with the surfaces it runs on', () => {
    const rules = listRules()
    const ids = rules.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    const all = new Set(Object.values(SURFACES).flatMap((s) => rulesFor(s).map((r) => r.name)))
    expect(new Set(ids)).toEqual(all)
    // Skip lists are honored: rpk skips too-short, connect skips raw-pipe.
    expect(rules.find((r) => r.id === 'too-short').surfaces).not.toContain('rpk')
    expect(rules.find((r) => r.id === 'raw-pipe').surfaces).not.toContain('connect')
  })

  test('--surface narrows the list', () => {
    const ids = listRules({ surfaces: ['helm'] }).map((r) => r.id)
    expect(ids).toContain('dead-marker')
    expect(ids).not.toContain('rpk-short-multiline')
    expect(() => listRules({ surfaces: ['nope'] })).toThrow(/Unknown surface "nope"/)
  })

  test('runs from the CLI without --repo and prints JSON', () => {
    const result = spawnSync('node', [BIN, 'lint-strings', '--list-rules', '--format', 'json', '--surface', 'rpk'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    const rules = JSON.parse(result.stdout)
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(Object.keys(rule)).toEqual(['id', 'surfaces', 'severity', 'tier', 'description', 'why', 'standard'])
      expect(rule.surfaces).toContain('rpk')
    }
  })

  test('text output carries every field', () => {
    const result = spawnSync('node', [BIN, 'lint-strings', '--list-rules', '--surface', 'metrics'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^trailing-period \(warning, style\)$/m)
    expect(result.stdout).toMatch(/^ {2}Why: Metric help is a label/m)
    expect(result.stdout).toMatch(/^ {2}Standard: https:\/\/github\.com\/redpanda-data\/docs-team-standards\//m)
  })

  test('a lint run still requires --repo', () => {
    const result = spawnSync('node', [BIN, 'lint-strings'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("required option '--repo <path>' not specified")
  })
})

describe('findings carry the reason', () => {
  const decl = {
    surface: 'metrics',
    name: 'requests_total',
    file: 'src/v/probe.cc',
    line_start: 10,
    line_end: 12,
    string: 'Number of requests served by this broker.',
    convention: {},
    meta: {}
  }

  test('JSON issues gain why and standard, existing fields unchanged', () => {
    const { findings } = runRules([decl], rulesFor(SURFACES.metrics), { onlyRules: ['trailing-period'] })
    expect(findings).toHaveLength(1)
    const [issue] = findings[0].rules
    const rule = rulesFor(SURFACES.metrics).find((r) => r.name === 'trailing-period')
    expect(issue).toEqual({
      id: 'trailing-period',
      severity: 'warning',
      tier: 'style',
      message: expect.stringContaining('ends with a period'),
      why: rule.why,
      standard: rule.standard
    })
  })

  test('human output prints a Why line under the message', () => {
    const result = runRules([decl], rulesFor(SURFACES.metrics), { onlyRules: ['trailing-period'] })
    const lines = formatHuman({ ...result, unsupported_surfaces: [] }).split('\n')
    const at = lines.findIndex((l) => l.includes('[trailing-period]'))
    expect(at).toBeGreaterThan(-1)
    expect(lines[at + 1]).toBe(`          Why: ${result.findings[0].rules[0].why}`)
  })
})

describe('CLI_REFERENCE.adoc Rules section', () => {
  test('matches --list-rules', () => {
    // tools/generate-cli-docs.js writes this section from the same command.
    // Fails when a rule changes and the reference was not regenerated
    // (npm run generate:cli-docs).
    const result = spawnSync('node', [BIN, 'lint-strings', '--list-rules', '--format', 'json'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    const expected = formatRulesAsciidoc(JSON.parse(result.stdout))
    const reference = fs.readFileSync(path.join(REPO_ROOT, 'CLI_REFERENCE.adoc'), 'utf8')
    const section = reference.slice(reference.indexOf('\n== lint-strings\n'))
    const end = section.indexOf('\n== ', 1)
    expect(section.slice(0, end === -1 ? undefined : end + 1)).toContain(expected)
  })
})

describe('issue tiers', () => {
  const { issueTier } = require('../../../tools/lint-strings/engine')

  test('--list-rules prints the tier a finding lands in, not the rule\'s declared one', () => {
    const rules = listRules()
    const tierOf = (id) => rules.find((r) => r.id === id).tier
    // undocumented-key declares unclear, but it is info-level, so its
    // findings are style.
    expect(SURFACES.helm.rules.find((r) => r.name === 'undocumented-key').tier).toBe('unclear')
    expect(tierOf('undocumented-key')).toBe('style')
    for (const r of rules) expect([r.id, r.tier]).toEqual([r.id, issueTier(r, r.severity)])
  })

  test('the routing the review depends on: what posts inline by default and what stays in the job summary', () => {
    const rules = listRules()
    const tierOf = (id) => rules.find((r) => r.id === id).tier
    // Inline by default: a reader is misled, or the output breaks.
    for (const id of ['sentinel-default-unexplained', 'rpk-short-multiline', 'connect-cli-usage-multiline', 'go-field-name-first']) {
      expect([id, tierOf(id)]).toEqual([id, 'unclear'])
    }
    // The style list: sentence length, Latin abbreviations, em dashes,
    // inline code, and punctuation nits.
    for (const id of ['long-sentence', 'latin-abbreviation', 'em-dash', 'missing-inline-code', 'connect-quoted-field-name', 'starts-lowercase',
      'missing-terminal-period', 'trailing-period', 'rpk-terminal-period', 'api-missing-terminal-period', 'api-summary-terminal-period']) {
      expect([id, tierOf(id)]).toEqual([id, 'style'])
    }
    // No error is style: an error is never below unclear.
    for (const r of rules) if (r.severity === 'error') expect([r.id, r.tier]).not.toEqual([r.id, 'style'])
  })

  test('an issue takes its rule\'s tier', () => {
    expect(issueTier({ tier: 'style' }, 'warning')).toBe('style')
    expect(issueTier({ tier: 'unclear' }, 'warning')).toBe('unclear')
    expect(issueTier({ tier: 'wrong' }, 'warning')).toBe('wrong')
  })

  test('an error is never below unclear, and an info finding is always style', () => {
    expect(issueTier({ tier: 'style' }, 'error')).toBe('unclear')
    expect(issueTier({ tier: 'wrong' }, 'error')).toBe('wrong')
    expect(issueTier({ tier: 'unclear' }, 'info')).toBe('style')
  })

  test('a rule with no tier falls back to unclear, never to style', () => {
    expect(issueTier({}, 'warning')).toBe('unclear')
  })
})
