'use strict'

const { GO_SLICE_RULE, QUOTED_FIELD_RULE, renderedSlice, quotedFieldNames } = require('../../../tools/lint-strings/rules/connect-literals')
const connect = require('../../../tools/lint-strings/surfaces/connect')
const { runRules } = require('../../../tools/lint-strings/engine')
const { rulesFor } = require('../../../tools/lint-strings')

const RULE_NAMES = ['connect-go-slice-format', 'connect-quoted-field-name']
const tokens = (text, fields) => quotedFieldNames(text, fields ? new Set(fields) : null).map((x) => x.token)

// benthos internal/impl/pure/processor_compress.go as it ships, and as it
// reads once the summary drops the %v list and the description uses inline
// code. Only the parts the rules read are kept.
const COMPRESS_BEFORE = `package pure

import (
	"fmt"

	"github.com/redpanda-data/benthos/v4/public/service"
)

func CompressionAlgsList() (v []string) {
	return v
}

func init() {
	compAlgs := CompressionAlgsList()
	service.MustRegisterBatchProcessor(
		"compress", service.NewConfigSpec().
			Summary(fmt.Sprintf("Compresses messages according to the selected algorithm. Supported compression algorithms are: %v", compAlgs)).
			Description(\`The 'level' field might not apply to all algorithms.\`).
			Fields(
				service.NewStringEnumField("algorithm", compAlgs...).
					Description("The compression algorithm to use."),
				service.NewIntField("level").
					Description("The level of compression to use. May not be applicable to all algorithms.").
					Default(-1),
			), nil)
}
`

const COMPRESS_AFTER = COMPRESS_BEFORE
  .replace('fmt.Sprintf("Compresses messages according to the selected algorithm. Supported compression algorithms are: %v", compAlgs)', '"Compresses messages according to the selected algorithm."')
  .replace("The 'level' field", 'The `+"`level`"+` field')

function lint (source, file = 'internal/impl/pure/processor_compress.go') {
  const declarations = connect.scanFile(source, file)
  const { findings } = runRules(declarations, rulesFor(connect), { onlyRules: RULE_NAMES })
  return findings.flatMap((f) => f.rules.map((r) => ({ name: f.name, kind: f.kind, ...r })))
}

describe('connect-go-slice-format', () => {
  test('the compress summary: a []string formatted with %v, found from the source though the list is unevaluable', () => {
    const issues = lint(COMPRESS_BEFORE).filter((i) => i.id === 'connect-go-slice-format')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ name: 'compress', severity: 'warning' })
    expect(issues[0].message).toContain('compAlgs ([]string) with %v')
  })

  test('negative control: the fixed compress processor has no findings', () => {
    expect(lint(COMPRESS_AFTER)).toEqual([])
  })

  test('slices and maps through literals, package vars, params, append and %s, %q, Sprint; not %d, strings or []byte with %s', () => {
    const source = `package p

import (
	"fmt"
	"strings"

	"github.com/redpanda-data/benthos/v4/public/service"
)

var names = []string{"a", "b"}
var labels = map[string]string{"a": "b"}
var raw = []byte("x")
var word = "gzip"

func spec(opts []string) *service.ConfigSpec {
	more := append(names, "c")
	return service.NewConfigSpec().
		Summary(fmt.Sprintf("One of %s, %q, %v and %v.", names, opts, labels, more)).
		Description(fmt.Sprint("Options: ", names)).
		Footnotes(fmt.Sprintf("Count %d of %v, %s, %s, joined %v.", 3, word, raw, word, strings.Join(names, ", ")))
}

func init() {
	service.MustRegisterProcessor("p", spec(nil), nil)
}
`
    const issues = lint(source, 'internal/impl/p/p.go').filter((i) => i.id === 'connect-go-slice-format')
    const described = issues.map((i) => i.message.match(/^(\S+) formats (.+?) with (\S+),/).slice(1).join(' '))
    expect(described).toEqual([
      'fmt.Sprintf names ([]string) %s',
      'fmt.Sprintf opts ([]string) %q',
      'fmt.Sprintf labels (map) %v',
      'fmt.Sprintf more ([]string) %v',
      'fmt.Sprint names ([]string) %v'
    ])
  })

  test('rendered text: a bracketed, space-separated list is flagged when no source call explains it', () => {
    expect(renderedSlice('Supported algorithms are: [flate gzip lz4 snappy]')).toBe('[flate gzip lz4 snappy]')
    expect(renderedSlice('One of (\n[a b] or none).')).toBe('[a b]')
    const [issue] = GO_SLICE_RULE.check({ string: 'Supported algorithms are: [flate gzip].', meta: {}, convention: {} })
    expect(issue.message).toContain('"[flate gzip]"')
  })

  test('rendered text: AsciiDoc and Markdown brackets are not slices', () => {
    for (const text of [
      'See xref:components:processors/compress.adoc[the compress processor] for details.',
      'Read link:https://example.com[the upstream docs^].',
      'A [Markdown link](https://example.com) here.',
      '[source,yaml]\n----\nalgorithms: [a b c]\n----',
      'Use `[a b c]` literally.',
      'Defaults to [none].',
      'Parts [ 2, 0, 1 ] in order.'
    ]) expect(renderedSlice(text)).toBeNull()
  })

  test('rendered text is not judged when the string is partly unresolved', () => {
    expect(GO_SLICE_RULE.check({ string: 'Algorithms: [a b] {{unresolved:1}}', meta: { unverifiable: true }, convention: {} })).toEqual([])
  })
})

describe('connect-quoted-field-name', () => {
  test('the compress description: a field of the same component in single quotes', () => {
    const issues = lint(COMPRESS_BEFORE).filter((i) => i.id === 'connect-quoted-field-name')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ name: 'compress', severity: 'warning' })
    expect(issues[0].message).toContain("'level' is a field of this component")
    expect(issues[0].message).toContain('`+"`level`"+`')
  })

  test('field names of the component, snake_case identifiers, dotted paths and curly quotes', () => {
    expect(tokens("The 'level' field and the \"path\" field.", ['level', 'path'])).toEqual(['level', 'path'])
    expect(tokens('Set "batch_size" and \'max_in_flight\'.')).toEqual(['batch_size', 'max_in_flight'])
    expect(tokens('Set "tls.enabled" to true.', ['tls'])).toEqual(['tls.enabled'])
    expect(tokens('The ‘level’ and “update_before” values.', ['level'])).toEqual(['level', 'update_before'])
  })

  test('negatives: plain words, values, contractions, numbers and code are left alone', () => {
    expect(tokens('Set it to "gzip" or \'2\'.', ['level'])).toEqual([])
    expect(tokens("It doesn't apply, and it's the level's default.", ['level'])).toEqual([])
    expect(tokens('Write `"level"` or +\'level\'+ literally.', ['level'])).toEqual([])
    expect(tokens('[source,yaml]\n----\nlevel: "batch_size"\n----\n', ['level'])).toEqual([])
    expect(tokens('```json\n{"batch_size": 1}\n```', ['level'])).toEqual([])
    expect(tokens('[,yaml,role="no_placeholders"]\n----\nx\n----', [])).toEqual([])
  })

  test('a backtick left open on its line marks the rest of the line as code', () => {
    // From connect internal/impl/snowflake/output_snowflake_streaming.go,
    // whose example JSON lost its closing backtick.
    expect(tokens('For example: `{"value": 42.3, "name":"new_data_field", "schema": "MY_SCHEMA"}', ['schema'])).toEqual([])
  })

  test('plain-text strings are skipped: ShortDescription and CLI help', () => {
    const decl = { string: "The 'level' field.", meta: { component_fields: new Set(['level']) } }
    expect(QUOTED_FIELD_RULE.check({ ...decl, meta: { ...decl.meta, kind: 'field-short' }, convention: {} })).toEqual([])
    expect(QUOTED_FIELD_RULE.check({ ...decl, meta: { kind: 'cli-usage' }, convention: { verbatim_asciidoc: false } })).toEqual([])
    expect(QUOTED_FIELD_RULE.check({ ...decl, meta: { kind: 'description', component_fields: new Set(['level']) }, convention: {} })).toHaveLength(1)
  })

  test('component fields come from the declarations of the same component only', () => {
    const declarations = connect.scanFile(COMPRESS_BEFORE, 'internal/impl/pure/processor_compress.go')
    const summary = declarations.find((d) => d.meta.kind === 'summary')
    expect([...summary.meta.component_fields].sort()).toEqual(['algorithm', 'level'])
    // Not enumerable, so JSON output does not carry it.
    expect(JSON.parse(JSON.stringify(summary.meta)).component_fields).toBeUndefined()
  })
})

describe('registration', () => {
  test('both rules run on the connect surface and warn, never error', () => {
    const names = rulesFor(connect).map((r) => r.name)
    for (const name of RULE_NAMES) expect(names).toContain(name)
    expect(lint(COMPRESS_BEFORE).every((i) => i.severity === 'warning')).toBe(true)
  })
})
