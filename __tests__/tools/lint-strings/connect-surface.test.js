'use strict'

const fs = require('fs')
const path = require('path')

const connect = require('../../../tools/lint-strings/surfaces/connect')
const { runRules } = require('../../../tools/lint-strings/engine')
const { rulesFor } = require('../../../tools/lint-strings')

const FIXTURE_PATH = path.join(__dirname, '../../../tools/lint-strings/fixtures/connect/lint_connect.go')
const fixture = fs.readFileSync(FIXTURE_PATH, 'utf8')

/** 1-indexed line of the first occurrence of a marker string. */
function lineOf (needle) {
  const index = fixture.indexOf(needle)
  if (index === -1) throw new Error(`Marker not found in fixture: ${needle}`)
  return fixture.slice(0, index).split('\n').length
}

describe('connect scanner (scanFile)', () => {
  const declarations = connect.scanFile(fixture, 'internal/impl/fixture/lint_connect.go')
  const byKey = new Map(declarations.map((d) => [`${d.meta.kind}:${d.name}`, d]))

  test('ConfigSpec Summary and Description resolve, named from the single registration', () => {
    const summary = byKey.get('summary:fixture_input')
    expect(summary.string).toBe('A fixture input using the https://example.com[example client library^].')
    expect(summary.line_start).toBe(lineOf('Summary(`A fixture input'))

    const description = byKey.get('description:fixture_input')
    // The `raw` + "`literal`" + `raw` concatenation idiom resolves to the
    // exact shipped text, backticks intact
    expect(description.string).toContain('the `raw` + interpreted + `raw` concatenation idiom')
    expect(description.string).toContain('== Metadata')
    expect(description.line_end).toBe(lineOf('Fields(fixtureConfigFields()') - 1)
  })

  test('field descriptions resolve through same-file constants and concatenation', () => {
    const seedBrokers = byKey.get('field:seed_brokers')
    expect(seedBrokers.string).toBe('A list of broker addresses to connect to in order to establish the connection. When omitted the global block is referenced.')
  })

  test('bare constructors with no Description are captured; composite helpers and Deprecated fields are not', () => {
    expect(byKey.get('field:naked_field').meta.missing_description).toBe(true)
    expect(byKey.has('field:tls')).toBe(false) // NewTLSToggledField carries its own docs
    expect(byKey.has('field:old_token')).toBe(false) // Deprecated
  })

  test('a description that cannot be evaluated is reported with a placeholder, never dropped or guessed', () => {
    const dynamic = byKey.get('field:dynamic_field')
    expect(dynamic.string).toBe('{{unresolved:1}}')
    expect(dynamic.meta.unverifiable).toBe(true)
    expect(dynamic.meta.unresolved).toEqual(['dynamicDescription()'])
  })
})

describe('connect surface end-to-end (fixture file)', () => {
  const os = require('os')
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-connect-'))
  const relPath = path.join('internal', 'impl', 'fixture', 'lint_connect.go')

  beforeAll(() => {
    fs.mkdirSync(path.join(repo, path.dirname(relPath)), { recursive: true })
    fs.copyFileSync(FIXTURE_PATH, path.join(repo, relPath))
  })

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('known-bads are flagged; AsciiDoc-rich conforming declarations stay clean', () => {
    const declarations = connect.extract({ repo })
    const { findings, summary } = runRules(declarations, rulesFor(connect))
    const byName = new Map(findings.map((f) => [f.name, f]))

    const naked = byName.get('naked_field')
    expect(naked.rules.map((r) => r.id)).toEqual(['missing-field-description'])
    expect(naked.rules[0].severity).toBe('warning')

    const echo = byName.get('poll_interval')
    expect(echo.rules.map((r) => r.id).sort()).toEqual(['name-echo', 'too-short'])

    // AsciiDoc constructs (== headings, |=== tables, links) in the page-body
    // description must NOT trip the verbatim rules (false-positive guard,
    // calibrated on kafka/franz_client.go and input_kafka_franz.go).
    expect(byName.has('fixture_input')).toBe(false)
    expect(byName.has('seed_brokers')).toBe(false)
    expect(byName.has('client_id')).toBe(false)

    expect(summary.errors).toBe(0)
  })

  test('the fixture description carries well-formed env-cloud blocks and the conditional rule is enabled for the surface', () => {
    const declarations = connect.extract({ repo })
    const description = declarations.find((d) => d.meta.kind === 'description' && d.name === 'fixture_input')
    expect(description.string).toContain('ifndef::env-cloud[]\nSet the consumer group')
    expect(description.string).toContain('ifdef::env-cloud[]\nThe consumer group is managed')
    expect(rulesFor(connect).map((r) => r.name)).toContain('conditional')
    expect(rulesFor(connect).map((r) => r.name)).not.toContain('connect-env-conditional')
  })
})

describe('connect surface: conditional rule on Summary, Description and field strings', () => {
  const source = `package condfixture

import (
	"github.com/redpanda-data/benthos/v4/public/service"
)

func condProcessorConfig() *service.ConfigSpec {
	return service.NewConfigSpec().
		Summary("Transforms records.\\n\\nifdef::env-cloud[]\\nRuns on a managed cluster.\\nendif::[]").
		Description(\`
Transforms each record with the configured mapping.

ifndef::env-cloud[]
Set the mapping file path on the broker host so the processor can read it.
endif::[]

ifdef::env-cloud[]
Upload the mapping file in the Cloud UI; the processor reads it from there.
endif::[]
\`).
		Fields(
			service.NewStringField("region").
				Description("The region to target. ifndef::env-cloud[Defaults to the broker's region.]"),
			service.NewStringField("mode").
				Description("The mode to run in.\\n\\n  ifdef::env-cloud[]\\nManaged mode.\\n\\nendif::[]\\n\\nSee above."),
			service.NewStringField("unclosed").
				Description("Prose.\\n\\nifndef::env-cloud[]\\nNever closed."),
		)
}

func init() {
	service.MustRegisterProcessor("cond_processor", condProcessorConfig(),
		func(conf *service.ParsedConfig, mgr *service.Resources) (service.Processor, error) {
			return nil, nil
		})
}
`
  const declarations = connect.scanFile(source, 'internal/impl/condfixture/processor.go')
  const { findings, summary } = runRules(declarations, rulesFor(connect), { onlyRules: ['conditional'] })
  const conditional = (name, kind) => {
    const f = findings.find((x) => x.name === name && x.rules.some((r) => r.id === 'conditional') && declarations.find((d) => d.name === name && d.meta.kind === kind && d.line_start === x.line_start))
    return f ? f.rules.filter((r) => r.id === 'conditional') : []
  }

  test('a Summary with a conditional is reported with the Summary reason; the surface identifies it by meta.kind', () => {
    const summaryDecl = declarations.find((d) => d.name === 'cond_processor' && d.meta.kind === 'summary')
    expect(summaryDecl).toBeDefined()
    const issues = conditional('cond_processor', 'summary')
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('in a Summary')
    expect(issues[0].message).toContain('See docs/README.md in the connect repo.')
  })

  test('a conforming Description is not flagged', () => {
    expect(conditional('cond_processor', 'description')).toEqual([])
  })

  test('field descriptions: single-line form, indented directive, and an unclosed block', () => {
    expect(conditional('region', 'field')).toEqual([expect.objectContaining({ message: expect.stringContaining('not a directive on a line of its own at column 0') })])
    const mode = conditional('mode', 'field')
    expect(mode.map((r) => r.message)).toEqual([expect.stringContaining('is indented')])
    const unclosed = conditional('unclosed', 'field')
    expect(unclosed).toEqual([expect.objectContaining({ severity: 'error', message: expect.stringContaining('never closed') })])
    expect(summary.byRule.conditional.errors).toBe(1)
  })
})
