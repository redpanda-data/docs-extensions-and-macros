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

// The connect-openapi corpus: Admin API v2 in redpanda/streaming-enterprise.
// A separate fixture because the generator derives the operation summary and
// description from the rpc's own comment rather than an option block.
const ADMIN_PATH = path.join(__dirname, '../../../tools/lint-strings/fixtures/api/lint_admin_v2.proto')
const adminFixture = fs.readFileSync(ADMIN_PATH, 'utf8')
const ADMIN_REL = 'proto/redpanda/core/admin/v2/lint_admin_v2.proto'

function adminLineOf (needle) {
  const index = adminFixture.indexOf(needle)
  if (index === -1) throw new Error(`Marker not found in admin fixture: ${needle}`)
  return adminFixture.slice(0, index).split('\n').length
}

const adminDeclarations = api.scanFile(adminFixture, ADMIN_REL)
const adminByKey = new Map(adminDeclarations.map((d) => [`${d.meta.kind}:${d.meta.path || d.name}`, d]))

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
    // Admin v2: the two trees the api-docs bundler feeds into the published
    // spec, and nothing else in proto/redpanda/core.
    ['proto/redpanda/core/admin/v2/shadow_link.proto', 'api'],
    ['proto/redpanda/core/common/v1/acl.proto', 'api'],
    // Excluded by streaming-enterprise's own buf.yaml, so they generate
    // nothing at all.
    ['proto/redpanda/core/admin/internal/v1/debug.proto', null],
    ['proto/redpanda/core/testing/example.proto', null],
    // Generates a fragment, but the bundler never picks it up, so it does not
    // reach readers.
    ['proto/redpanda/core/rest/iceberg.proto', null],
    // cloudv2's descriptors tree is internal, and vendored google/api protos
    // are not ours to lint.
    ['proto/descriptors/redpanda/api/private/x.proto', null],
    ['tools/proto/wellknown/google/api/annotations.proto', null],
    ['proto/redpanda/api/dataplane/v1/topic.go', null]
  ])('routes %s -> %s', (file, surface) => {
    expect(routeFile(file)).toBe(surface)
  })
})

describe('api scanner: openapiv2_field descriptions', () => {
  test('an openapiv2_field description overrides the field comment', () => {
    // Verified against the generator: console has 81 fields carrying both, and
    // MCPServer.resources ships the option's text, not the comment's.
    const decl = byKey.get('field:FixtureTopic.option_documented')
    expect(decl.string).toBe('The string the generator actually publishes.')
    expect(decl.meta.source).toBe('openapiv2_field')
  })

  test('a field documented only by the option is not an undocumented field', () => {
    // The option carries no `option` keyword inside a `[...]` list, so the
    // block regex never matched it and 73 of console's fields were reported
    // as shipping a blank description when they ship real prose.
    const decl = byKey.get('field:FixtureTopic.option_only')
    expect(decl.string).toBe('Documented by the option alone.')
    const { findings } = runRules([decl], rulesFor(api))
    expect(findings).toEqual([])
  })

  test('a field with neither form is still reported', () => {
    const decl = byKey.get('field:FixtureTopic.undocumented')
    expect(decl.string).toBeNull()
    expect(decl.meta.source).toBeNull()
  })
})

describe('api scanner: connect-openapi rpc comments', () => {
  test('the rpc comment splits into a summary and a description', () => {
    const summary = adminByKey.get('rpc-summary:GetFixture')
    const description = adminByKey.get('rpc-description:GetFixture')
    expect(summary.string).toBe('GetFixture')
    expect(description.string).toBe('Returns a single fixture.')
    // Each part is anchored on its own comment lines, not on the whole block,
    // so a suggestion edits only the half that is wrong.
    expect(summary.line_start).toBe(adminLineOf('// GetFixture'))
    expect(description.line_start).toBe(adminLineOf('// Returns a single fixture.'))
  })

  test('a description keeps its paragraph breaks and joins its wrapped lines', () => {
    const decl = adminByKey.get('rpc-description:CreateFixture')
    expect(decl.string).toBe(
      'Creates a fixture. The description can run over several comment\n' +
      'lines, and the resolved prose joins them.\n' +
      '\n' +
      'A blank comment line inside the description is a paragraph break and\n' +
      'stays part of the description.'
    )
  })

  test('a wrapped rpc signature still names its operation', () => {
    // Admin v2 clang-formats the signature over two lines, so the `rpc` line's
    // own brace delta is 0 and testing only that line left the rpc unrecorded.
    expect(adminByKey.get('rpc-summary:CreateFixture').string).toBe('CreateFixture')
  })

  test('with no blank line the whole comment is the summary, and there is no separate description', () => {
    const summary = adminByKey.get('rpc-summary:CollapsedFixture')
    expect(summary.meta.collapsed).toBe(true)
    expect(summary.string).toContain('Reports the collapsed case')
    // The generator ships this same text as both, so emitting a second
    // declaration would report one defect twice.
    expect(adminByKey.get('rpc-description:CollapsedFixture')).toBeUndefined()
  })

  test('a license header does not attach to the first declaration', () => {
    const strings = adminDeclarations.map((d) => d.string || '')
    expect(strings.some((s) => s.includes('Apache License'))).toBe(false)
  })

  test('a body-less rpc does not swallow the declarations after it', () => {
    expect(adminByKey.get('rpc-summary:BodylessFixture')).toBeDefined()
    expect(adminByKey.get('rpc-summary:WatchFixture')).toBeDefined()
    expect(adminByKey.get('message:GetFixtureRequest')).toBeDefined()
  })

  test('an inline empty body does not swallow the declarations after it', () => {
    // `rpc X(A) returns (B) {}` nets a brace delta of zero. Ending the
    // signature scan on a positive delta ran it into the following lines and
    // dropped them - console has four rpcs written this way.
    const declared = api.scanFile([
      'service S {',
      '    // DoFoo',
      '    //',
      '    // Does foo.',
      '    rpc DoFoo(A) returns (B) {}',
      '    // DoBar',
      '    //',
      '    // Does bar.',
      '    rpc DoBar(C) returns (D) {}',
      '}',
      '// A message.',
      'message M {',
      '    // The name.',
      '    string name = 1;',
      '}'
    ].join('\n'), ADMIN_REL)
    const keys = declared.map((d) => `${d.meta.kind}:${d.name}`)
    expect(keys).toEqual([
      'rpc-summary:DoFoo', 'rpc-description:DoFoo',
      'rpc-summary:DoBar', 'rpc-description:DoBar',
      'message:M', 'field:name'
    ])
  })

  test('per-value enum comments are not extracted', () => {
    // protoc-gen-connect-openapi discards them: ScramMechanism's two per-value
    // comments do not appear in its generated spec, which is why the process
    // doc tells authors to describe the values on the enum itself.
    expect(adminByKey.get('enum:FixtureMode').string).toContain('- Runs fast')
    expect(adminDeclarations.find((d) => d.name === 'FIXTURE_MODE_FAST')).toBeUndefined()
  })
})

describe('api scanner: the generator decides what an rpc comment means', () => {
  test.each([
    ['proto/redpanda/api/dataplane/v1/topic.proto', 'openapiv2'],
    ['proto/public/cloud/redpanda/api/controlplane/v1/cluster.proto', 'openapiv2'],
    ['proto/redpanda/core/admin/v2/broker.proto', 'connect-openapi'],
    ['proto/redpanda/core/common/v1/acl.proto', 'connect-openapi'],
    // Unrecognized paths fall back to the option-block form, which yields
    // nothing rather than reading every code comment as a published summary.
    ['proto/somewhere/else/x.proto', 'openapiv2']
  ])('%s is built with %s', (file, generator) => {
    expect(api.generatorFor(file)).toBe(generator)
  })

  test('under openapiv2 an rpc comment is a code comment, not an operation string', () => {
    // 159 of console's 271 rpcs carry a Go-style comment. Reading those as
    // form 3 would report every one of them against a contract they were
    // never written for.
    const asOpenapiv2 = api.scanFile(adminFixture, ADMIN_REL, 'openapiv2')
    expect(asOpenapiv2.filter((d) => /^rpc-/.test(d.meta.kind))).toEqual([])
    // The message and field comments are still extracted: both generators
    // publish those.
    expect(asOpenapiv2.find((d) => d.meta.kind === 'message')).toBeDefined()
  })

  test('the api fixture yields no rpc declarations, since console uses option blocks', () => {
    expect(declarations.filter((d) => /^rpc-/.test(d.meta.kind))).toEqual([])
  })
})

describe('api rules: connect-openapi', () => {
  const rules = rulesFor(api)
  const findingsFor = (decl) => {
    const { findings } = runRules([decl], rules)
    return findings.length === 0 ? [] : findings[0].rules.map((r) => r.id)
  }

  test('a missing blank line is an error, and is the only finding on it', () => {
    const ids = findingsFor(adminByKey.get('rpc-summary:CollapsedFixture'))
    expect(ids).toEqual(['api-rpc-summary-not-separated'])
    // api-summary-multiline would otherwise fire on the same declaration and
    // report one defect twice with the less actionable message.
    expect(ids).not.toContain('api-summary-multiline')
    expect(ids).not.toContain('api-summary-terminal-period')
  })

  test('a summary that is just the rpc name is clean', () => {
    // The documented convention, and 28 of admin/v2's 29 rpcs follow it. The
    // generic name-echo fires on every one of them, which is why it is
    // replaced by api-name-echo.
    const ids = findingsFor(adminByKey.get('rpc-summary:GetFixture'))
    expect(ids).toEqual([])
    expect(ids).not.toContain('name-echo')
    expect(ids).not.toContain('api-name-echo')
    expect(ids).not.toContain('too-short')
    expect(ids).not.toContain('api-missing-terminal-period')
  })

  test('api-name-echo still catches a tautology on a field', () => {
    // The replacement must not weaken the rule everywhere else: `partition_id`
    // described as "Partition ID" is exactly what it was written for.
    expect(findingsFor(adminByKey.get('field:GetFixtureRequest.partition_id'))).toContain('api-name-echo')
  })

  test('a summary with a terminal period or a second line is an error', () => {
    expect(findingsFor(adminByKey.get('rpc-summary:DeleteFixture'))).toContain('api-summary-terminal-period')
    expect(findingsFor(adminByKey.get('rpc-summary:ListFixtures'))).toContain('api-summary-multiline')
  })

  test('an rpc description is prose and takes a full stop', () => {
    expect(findingsFor(adminByKey.get('rpc-description:GetFixture'))).not.toContain('api-missing-terminal-period')
    expect(findingsFor(adminByKey.get('field:GetFixtureRequest.name'))).toContain('api-missing-terminal-period')
  })

  test('a bulleted list or a trailing URL is not a sentence missing punctuation', () => {
    // Enum descriptions are written as bulleted value lists precisely because
    // the generator discards per-value comments, and a full stop after a bare
    // URL becomes part of the link.
    expect(findingsFor(adminByKey.get('enum:FixtureMode'))).not.toContain('api-missing-terminal-period')
    expect(findingsFor(adminByKey.get('field:GetFixtureRequest.api_versions'))).not.toContain('api-missing-terminal-period')
  })
})
