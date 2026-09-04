'use strict'

const fs = require('fs')
const path = require('path')

const api = require('../../../tools/lint-strings/surfaces/api')
const { runRules } = require('../../../tools/lint-strings/engine')
const { rulesFor, SURFACES } = require('../../../tools/lint-strings')
const { findBareCodeTokens } = require('../../../tools/lint-strings/rules/common')
const { routeFile } = require('../../../tools/lint-strings/diff')

const FIXTURE_PATH = path.join(__dirname, '../../../tools/lint-strings/fixtures/api/lint_api.proto')
const fixture = fs.readFileSync(FIXTURE_PATH, 'utf8')
const REL = 'proto/redpanda/api/fixture/v1/lint_api.proto'

/** 1-indexed line of the first occurrence of a marker string. */
function lineOf (needle) {
  const index = fixture.indexOf(needle)
  if (index === -1) throw new Error(`Marker not found in fixture: ${needle}`)
  return fixture.slice(0, index).split('\n').length
}

const declarations = api.scanFile(fixture, REL)
const byKey = new Map(declarations.map((d) => [`${d.meta.kind}:${d.meta.path || d.name}`, d]))

describe('api scanner: the two string forms', () => {
  test('a leading // comment on a field resolves as its description', () => {
    const decl = byKey.get('field:FixtureTopic.name')
    expect(decl.string).toBe('A topic-level config key (e.g. `segment.bytes`).')
    expect(decl.line_start).toBe(lineOf('// A topic-level config key'))
  })

  test('a multi-line comment joins rather than keeping only the first line', () => {
    const decl = byKey.get('field:FixtureTopic.wrapped_comment')
    expect(decl.string).toBe('A comment can wrap over several lines, and the resolved prose joins them\nrather than keeping only the first.')
  })

  test('openapiv2 summary and description are separate declarations, named after the rpc', () => {
    const summary = byKey.get('operation-summary:CreateFixture')
    const description = byKey.get('operation-description:CreateFixture')
    expect(summary.string).toBe('Create fixture.')
    expect(description.string).toContain('[fixture](https://docs.redpanda.com/fixture/)')
    // Named after the rpc, not the file. The basename fallback reported every
    // operation string in a file under one name, which is useless in a review.
    expect(summary.name).toBe('CreateFixture')
    expect(description.name).toBe('CreateFixture')
  })

  test('adjacent string literals concatenate, and the span covers both lines', () => {
    const decl = byKey.get('operation-description:JoinFixtures')
    expect(decl.string).toBe('Joins two fixtures together and returns the result.')
    expect(decl.line_end).toBe(decl.line_start + 1)
  })
})

describe('api scanner: what it must NOT extract', () => {
  test('response descriptions are out of scope', () => {
    // "OK" and "Fixture created" are HTTP status prose. Holding two-word
    // status labels to the quality bar would bury every real finding.
    const strings = declarations.map((d) => d.string)
    expect(strings).not.toContain('OK')
    expect(strings).not.toContain('Fixture created')
  })

  test('fields inside an extend block are not published schema', () => {
    expect(declarations.find((d) => d.name === 'fixture_extension')).toBeUndefined()
  })

  test('a service is not a declaration', () => {
    expect(declarations.find((d) => d.name === 'FixtureService')).toBeUndefined()
  })
})

describe('api scanner: brace depth', () => {
  test('oneof members belong to the enclosing message, not to the oneof', () => {
    // The defect: matching a bare `}` popped FixtureTopic when the oneof
    // closed, so every later declaration in the file was mis-parented.
    expect(byKey.get('field:FixtureTopic.by_name').string).toBe('Selects by name.')
    expect(byKey.get('field:FixtureTopic.by_id')).toBeDefined()
  })

  test('a sibling message is not reported as nested', () => {
    expect(byKey.get('message:FixtureSibling')).toBeDefined()
    expect(byKey.get('field:FixtureSibling.name')).toBeDefined()
    const paths = declarations.map((d) => d.meta.path).filter(Boolean)
    expect(paths).not.toContain('FixtureTopic.FixtureSibling.name')
  })

  test('a genuinely nested message reports a dotted path', () => {
    expect(byKey.get('field:FixtureTopic.Nested.value')).toBeDefined()
  })

  test('a brace inside a description string does not close the option block', () => {
    // `{prefix}` in CreateFixture's description sits before two later rpcs.
    // Counting braces inside string literals dropped both of them.
    expect(byKey.get('operation-summary:ListFixtures')).toBeDefined()
    expect(byKey.get('operation-summary:JoinFixtures')).toBeDefined()
  })

  test('a wrapped option list is covered by the declaration span', () => {
    const decl = byKey.get('field:FixtureTopic.wrapped')
    // The span must reach the terminating `];` so a suggestion block can
    // replace the whole statement.
    expect(decl.line_end).toBe(lineOf('  ];'))
  })

  test('an enum is labelled as an enum, not a message', () => {
    expect(byKey.get('enum:FixtureMode')).toBeDefined()
    expect(byKey.get('message:FixtureMode')).toBeUndefined()
  })
})

describe('api rules', () => {
  const rules = rulesFor(api)
  // runRules takes a LIST and returns { findings, summary }; a declaration with
  // no issues produces no finding at all, so an absent finding means clean.
  const findingsFor = (decl) => {
    const { findings } = runRules([decl], rules)
    return findings.length === 0 ? [] : findings[0].rules.map((r) => r.id)
  }

  test('a summary with a terminal period is an error; a label without one is clean', () => {
    expect(findingsFor(byKey.get('operation-summary:CreateFixture'))).toContain('api-summary-terminal-period')
    expect(findingsFor(byKey.get('operation-summary:ListFixtures'))).not.toContain('api-summary-terminal-period')
  })

  test('a summary is never held to the prose rules that would fight it', () => {
    // "List fixtures" is 13 characters and correct. 151 of console's 216
    // summaries are under the generic 20-character threshold.
    const ids = findingsFor(byKey.get('operation-summary:ListFixtures'))
    expect(ids).not.toContain('too-short')
    expect(ids).not.toContain('api-description-too-short')
    expect(ids).not.toContain('api-missing-terminal-period')
  })

  test('prose without a terminal period is flagged', () => {
    expect(findingsFor(byKey.get('operation-description:ListFixtures'))).toContain('api-missing-terminal-period')
    expect(findingsFor(byKey.get('field:FixtureTopic.name'))).not.toContain('api-missing-terminal-period')
  })

  test('an uncommented field is a warning, not the generic empty-description error', () => {
    const ids = findingsFor(byKey.get('field:FixtureTopic.undocumented'))
    expect(ids).toContain('api-undocumented-field')
    // empty-description is an ERROR and 823 of console's fields would trip it.
    expect(ids).not.toContain('empty-description')
  })

  test('a Markdown link to docs.redpanda.com is not a finding', () => {
    // The existing convention in these files. A link that resolves in the
    // output format is not an `xref:` stranded in a C++ string.
    const ids = findingsFor(byKey.get('operation-description:CreateFixture'))
    expect(ids).not.toContain('broken-macro')
    expect(ids).not.toContain('unknown-attribute')
    expect(ids).not.toContain('missing-inline-code')
  })

  test('the AsciiDoc-only rules do not apply to a Markdown surface', () => {
    const ids = rules.map((r) => r.name)
    expect(ids).not.toContain('raw-pipe')
    expect(ids).not.toContain('unknown-attribute')
    expect(ids).not.toContain('broken-macro')
  })
})

describe('missing-inline-code', () => {
  test('a bare field name in prose is flagged', () => {
    const decl = byKey.get('field:FixtureTopic.partitions')
    const { findings } = runRules([decl], rulesFor(api))
    expect(findings[0].rules.map((r) => r.id)).toContain('missing-inline-code')
  })

  test.each([
    ['bare snake_case identifier', 'Sets default_topic_partitions for new topics.', ['default_topic_partitions']],
    ['already backticked', 'Sets `default_topic_partitions` for new topics.', []],
    ['long flag', 'Pass --tolerate-data-loss to override.', ['--tolerate-data-loss']],
    ['absolute path', 'Config lives in /etc/redpanda/redpanda.yaml on each broker.', ['/etc/redpanda/redpanda.yaml']],
    ['markdown link target', 'Create a [topic](https://docs.redpanda.com/get-started/create-topic/).', []],
    ['bare URL with underscores', 'See https://example.com/some_path/with_underscores for detail.', []],
    ['backticked dotted key', 'A topic-level config key (e.g. `segment.bytes`).', []],
    ['ordinary prose with a number', 'Maximum size of a batch. Default is 1048576 bytes.', []],
    ['hyphenated prose is not a flag', 'Whether the config is read-only, or is dynamic.', []]
  ])('%s', (_label, text, expected) => {
    expect(findBareCodeTokens(text).map((b) => b.token)).toEqual(expected)
  })

  test("the declaration's own name is name-echo's finding, not a markup one", () => {
    expect(findBareCodeTokens('read_only is read_only.', 'read_only')).toEqual([])
  })
})

describe('api surface registration', () => {
  test('the surface is registered, so a routed proto file is not reported as unsupported', () => {
    expect(SURFACES.api).toBe(api)
  })

  test.each([
    ['proto/redpanda/api/dataplane/v1/topic.proto', 'api'],
    ['proto/public/cloud/redpanda/api/controlplane/v1/cluster.proto', 'api'],
    // cloudv2's descriptors tree is internal, and vendored google/api protos
    // are not ours to lint.
    ['proto/descriptors/redpanda/api/private/x.proto', null],
    ['tools/proto/wellknown/google/api/annotations.proto', null],
    ['proto/redpanda/api/dataplane/v1/topic.go', null]
  ])('routes %s -> %s', (file, surface) => {
    expect(routeFile(file)).toBe(surface)
  })
})
