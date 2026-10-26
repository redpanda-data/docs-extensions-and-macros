'use strict'

const { loadWorkspace } = require('../../language-server/workspace')
const { findMacros } = require('../../language-server/features/properties')
const { forText } = require('../../language-server/dispatch')
const features = { findMacros, ...forText() }
const { makeWorkspace, noFetch } = require('./workspace-fixture')

const URI = 'file:///page.adoc'
let ws
let cloud

beforeAll(async () => {
  ws = await loadWorkspace(makeWorkspace(), { env: {}, fetch: noFetch })
  const docs = makeWorkspace({ taxonomy: false })
  cloud = await loadWorkspace(
    makeWorkspace({ name: 'redpanda-cloud', version: null, attributes: { 'env-cloud': true }, properties: false }),
    { env: { REDPANDA_DOCS_PATH: docs }, fetch: noFetch }
  )
})

const page = (header, body = '') => `= Page\n${header}\n\n${body}\n`
const at = (text, needle, offset = needle.length) => {
  const lines = text.split('\n')
  const line = lines.findIndex((l) => l.includes(needle))
  return { line, character: lines[line].indexOf(needle) + offset }
}
const codes = (diags) => diags.map((d) => d.code)

describe('findMacros', () => {
  test('finds prop: and propval: with ranges and attributes', () => {
    const found = features.findMacros('See prop:log_segment_ms[] and propval:log_segment_ms[min,format=raw].')
    expect(found.map((m) => [m.macro, m.name])).toEqual([['prop', 'log_segment_ms'], ['propval', 'log_segment_ms']])
    expect(found[1].attributes).toEqual({ 1: 'min', format: 'raw' })
    expect(found[0].nameRange.start.character).toBe(9)
  })

  test('skips comments and listing blocks, where macros never render', () => {
    const text = '// prop:nope_a[]\n////\nprop:nope_b[]\n////\n----\nprop:nope_c[]\n----\nprop:log_segment_ms[]'
    expect(features.findMacros(text).map((m) => m.name)).toEqual(['log_segment_ms'])
  })
})

describe('prop: and propval: diagnostics', () => {
  test('negative control: known names and fields produce no diagnostics', () => {
    const text = page(':page-categories: Security', 'prop:log_segment_ms[] defaults to propval:log_segment_ms[default].')
    expect(features.diagnostics(text, ws)).toEqual([])
  })

  test('an unknown prop: name gets the build warning, with suggestions', () => {
    const text = page('', 'prop:log_segmnt_ms[]')
    const [d] = features.diagnostics(text, ws)
    expect(d.code).toBe('unknown-property')
    expect(d.severity).toBe(2)
    expect(d.message).toMatch(/not in the property data this page validates against \(redpanda-properties-v26\.2\.4\.json/)
    expect(d.message).toMatch(/Did you mean: log_segment_ms/)
    expect(d.range.start).toEqual(at(text, 'log_segmnt_ms', 0))
  })

  test(':property-validate: error makes an unknown name an error, and off silences prop:', () => {
    expect(features.diagnostics(page(':property-validate: error', 'prop:nope[]'), ws)[0].severity).toBe(1)
    expect(features.diagnostics(page(':property-validate: off', 'prop:nope[]'), ws)).toEqual([])
  })

  test('propval: with an unsupported field reports what the build reports', () => {
    const [d] = features.diagnostics(page('', 'propval:log_segment_ms[bogus]'), ws)
    expect(d.code).toBe('unsupported-field')
    expect(d.message).toMatch(/'bogus' is not a field propval: supports/)
  })

  test('on Cloud, a cluster property with cloud_supported: false is unavailable', () => {
    const codesFor = (body) => codes(features.diagnostics(page('', body), cloud))
    expect(codesFor('prop:cloud_storage_enabled[]')).toEqual(['unavailable-property'])
    expect(codesFor('propval:cloud_storage_enabled[type]')).toEqual(['unavailable'])
    expect(codesFor('propval:log_segment_ms[default]')).toEqual(['cloud-hidden'])
    // Negative control: the same page in self-managed is clean.
    expect(codes(features.diagnostics(page('', 'prop:cloud_storage_enabled[]'), ws))).toEqual([])
  })

  test('without property data nothing is checked', () => {
    const none = { ...ws, properties: null }
    expect(features.diagnostics(page('', 'prop:nope[]'), none)).toEqual([])
  })
})

describe(':page-categories: diagnostics and quick fixes', () => {
  test('negative control: valid categories produce no diagnostics', () => {
    expect(features.diagnostics(page(':page-categories: Security, Iceberg Topics, Apache Iceberg'), ws)).toEqual([])
  })

  test('an unknown value is a warning on exactly that value', () => {
    const text = page(':page-categories: Security, Nonsense')
    const [d] = features.diagnostics(text, ws)
    expect(d).toMatchObject({ code: 'unknown-value', severity: 2 })
    expect(d.range.start).toEqual(at(text, 'Nonsense', 0))
    expect(d.range.end).toEqual(at(text, 'Nonsense'))
  })

  test('a legacy category the taxonomy lacks is not-in-taxonomy', () => {
    expect(codes(features.diagnostics(page(':page-categories: Troubleshooting'), ws))).toEqual(['not-in-taxonomy'])
  })

  test('a deprecated value is a warning with a quick fix to its replacement', () => {
    const text = page(':page-categories: Security, Iceberg, Replication')
    const diags = features.diagnostics(text, ws)
    expect(codes(diags)).toEqual(['deprecated-value'])
    expect(diags[0].message).toMatch(/'Iceberg' is deprecated; use 'Iceberg Topics' instead/)
    const [action] = features.codeActions(text, diags, ws, URI)
    expect(action.title).toBe("Replace 'Iceberg' with 'Iceberg Topics'")
    const [edit] = action.edit.changes[URI]
    expect(edit.newText).toBe(':page-categories: Security, Iceberg Topics, Replication')
    // Applying the fix leaves a clean page: the fix and the check agree.
    const lines = text.split('\n')
    lines[edit.range.start.line] = edit.newText
    expect(features.diagnostics(lines.join('\n'), ws)).toEqual([])
  })

  test('a deprecated value replaced by one already present is merged, not duplicated', () => {
    const text = page(':page-categories: Data Replication, Replication')
    const diags = features.diagnostics(text, ws).filter((d) => d.code === 'deprecated-value')
    const [action] = features.codeActions(text, diags, ws, URI)
    expect(action.edit.changes[URI][0].newText).toBe(':page-categories: Replication')
  })

  test('a deprecated value replaced by a task is removed, as check-metadata --fix does', () => {
    const text = page(':page-categories: Management, Security')
    const diags = features.diagnostics(text, ws)
    const [action] = features.codeActions(text, diags, ws, URI)
    expect(action.title).toMatch(/^Remove 'Management'/)
    expect(action.edit.changes[URI][0].newText).toBe(':page-categories: Security')
  })

  test('a deprecated value with no replacement gets no quick fix', () => {
    const text = page(':page-categories: Integration')
    const diags = features.diagnostics(text, ws)
    expect(codes(diags)).toEqual(['deprecated-value'])
    expect(features.codeActions(text, diags, ws, URI)).toEqual([])
  })

  test('a categories line in the body is not the header and is not checked', () => {
    expect(features.diagnostics('= Page\n:description: x\n\n:page-categories: Nonsense\n', ws)).toEqual([])
  })
})

describe('completion', () => {
  test('property names after prop:, inserting the brackets', () => {
    const text = 'Set prop:log_seg'
    const items = features.completion(text, { line: 0, character: text.length }, ws)
    const item = items.find((i) => i.label === 'log_segment_ms')
    expect(item.textEdit).toEqual({ range: { start: { line: 0, character: 9 }, end: { line: 0, character: 16 } }, newText: 'log_segment_ms[]' })
    expect(item.documentation.value).toMatch(/\| default \| 2 weeks \|/)
  })

  test('Cloud completion leaves out properties Cloud readers cannot set', () => {
    const text = 'prop:'
    const labels = (w) => features.completion(text, { line: 0, character: 5 }, w).map((i) => i.label)
    expect(labels(ws)).toContain('cloud_storage_enabled')
    expect(labels(cloud)).not.toContain('cloud_storage_enabled')
    expect(labels(cloud)).toContain('log_segment_ms')
  })

  test('propval: fields inside the brackets, with the value each renders', () => {
    const text = 'propval:log_segment_ms['
    const items = features.completion(text, { line: 0, character: text.length }, ws)
    expect(items.find((i) => i.label === 'default').detail).toBe('2 weeks')
    expect(items.find((i) => i.label === 'min').detail).toBe('1 minute')
    expect(items.find((i) => i.label === 'values').detail).toBe('<unknown values>')
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(['default', 'type', 'unit', 'min', 'max', 'restart', 'cloud-access']))
  })

  test('format= after the field', () => {
    const text = 'propval:log_segment_ms[default,'
    expect(features.completion(text, { line: 0, character: text.length }, ws).map((i) => i.label)).toEqual(['format=raw', 'format=human'])
  })

  test('taxonomy labels on :page-categories:, without deprecated concepts, tasks, or values already set', () => {
    const text = page(':page-categories: Security, Ice')
    const items = features.completion(text, at(text, 'Ice'), ws)
    const labels = items.map((i) => i.label)
    expect(labels).toEqual(expect.arrayContaining(['Iceberg Topics', 'Apache Iceberg', 'Change data capture']))
    expect(labels).not.toContain('Iceberg') // deprecated
    expect(labels).not.toContain('Operate') // a task: derived from the module
    expect(labels).not.toContain('Security') // already on the page
    const item = items.find((i) => i.label === 'Change data capture')
    expect(item.filterText).toMatch(/CDC/)
    expect(item.textEdit.range.start).toEqual(at(text, 'Ice', 0))
  })

  test('no completion inside a comment', () => {
    const text = '// prop:log'
    expect(features.completion(text, { line: 0, character: text.length }, ws)).toEqual([])
  })
})

describe('hover', () => {
  test('prop: shows the reference summary and the dataset', () => {
    const text = 'See prop:log_segment_ms[].'
    const { contents } = features.hover(text, { line: 0, character: 12 }, ws)
    expect(contents.value).toMatch(/\*\*log_segment_ms\*\*/)
    expect(contents.value).toMatch(/\| min \| 1 minute \|/)
    expect(contents.value).toMatch(/redpanda-properties-v26\.2\.4\.json from streaming@26\.2/)
  })

  test('prop: on an enterprise property says when a license is needed', () => {
    const { contents } = features.hover('prop:cloud_storage_enabled[]', { line: 0, character: 6 }, ws)
    expect(contents.value).toMatch(/Enterprise Edition license when set to `true`/)
  })

  test('propval: shows what the page renders', () => {
    const value = (body) => features.hover(body, { line: 0, character: 3 }, ws).contents.value
    expect(value('propval:log_segment_ms[default]')).toMatch(/^\*\*Renders as:\*\* 2 weeks/)
    expect(value('propval:log_segment_ms[default,format=raw]')).toMatch(/^\*\*Renders as:\*\* 1209600000/)
    expect(value('propval:log_segment_ms[values]')).toMatch(/`<unknown values>`/)
  })

  test('a category value shows its definition, and its replacement when deprecated', () => {
    const text = page(':page-categories: Security, Iceberg')
    expect(features.hover(text, at(text, 'Security', 2), ws).contents.value).toMatch(/\*\*Security\*\* \(topic\)\n\nProtecting a cluster/)
    expect(features.hover(text, at(text, 'Iceberg', 2), ws).contents.value).toMatch(/Deprecated: use 'Iceberg Topics'/)
  })

  test('nothing to say outside a macro or header value', () => {
    expect(features.hover('plain text', { line: 0, character: 3 }, ws)).toBeNull()
  })
})
