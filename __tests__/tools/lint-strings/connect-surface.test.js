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

  test('bare constructors with no Description are captured; composite helpers, Deprecated fields, and dynamic descriptions are not', () => {
    expect(byKey.get('field:naked_field').meta.missing_description).toBe(true)
    expect(byKey.has('field:tls')).toBe(false) // NewTLSToggledField carries its own docs
    expect(byKey.has('field:old_token')).toBe(false) // Deprecated
    expect(byKey.has('field:dynamic_field')).toBe(false) // dynamicDescription() call
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
})
