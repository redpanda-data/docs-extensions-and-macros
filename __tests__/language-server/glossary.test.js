'use strict'

const { loadWorkspace } = require('../../language-server/workspace')
const { forText } = require('../../language-server/dispatch')
const glossary = require('../../language-server/features/glossary')
const { makeWorkspace, noFetch } = require('./workspace-fixture')
const { buildWorkspace } = require('./fixture')

const features = forText()
const URI = 'file:///page.adoc'
const term = (name, extra = '') => `=== ${name}\n:term-name: ${name}\n:hover-text: About ${name}.\n:category: Redpanda Cloud\n${extra}\nBody.\n`
const TERMS = {
  byoc: term('BYOC', ':alt-labels: Bring Your Own Cloud\n:do-not-use: bring your own cloud, Bring your own cloud\n'),
  broker: term('broker'),
}
let ws

beforeAll(async () => {
  ws = await loadWorkspace(buildWorkspace({ component: {}, terms: TERMS }), { env: {}, fetch: noFetch })
})

const at = (text, needle, offset = 0) => {
  const lines = text.split('\n')
  const line = lines.findIndex((l) => l.includes(needle))
  return { line, character: lines[line].indexOf(needle) + offset }
}
const glossaryDiags = (text) => features.diagnostics(text, ws).filter((d) => /glossary/.test(d.code))

describe('glossterm diagnostics', () => {
  test('negative control: terms, alt labels, any case, and inline definitions are fine', () => {
    const text = '= P\n\nA glossterm:broker[], glossterm:Broker[], glossterm:Bring Your Own Cloud[] and glossterm:widget[A part.]\n'
    expect(glossaryDiags(text)).toEqual([])
  })

  test('an unknown target warns on the target, the way the build does', () => {
    const text = '= P\n\nSee glossterm:widgetron[].\n'
    const [d] = glossaryDiags(text)
    expect(d.code).toBe('unknown-glossary-term')
    expect(d.severity).toBe(2)
    expect(d.message).toMatch(/not yet defined/)
    expect(d.range.start).toEqual(at(text, 'widgetron'))
  })

  test('a do-not-use form says what to write and offers the fix', () => {
    const text = '= P\n\nIn glossterm:Bring your own cloud[] clusters.\n'
    const [d] = glossaryDiags(text)
    expect(d.code).toBe('avoided-glossary-form')
    expect(d.message).toBe("The docs avoid 'Bring your own cloud'. Write 'Bring Your Own Cloud' (glossary term BYOC).")
    const [fix] = features.codeActions(text, [d], ws, URI)
    expect(fix.title).toBe("Replace with 'Bring Your Own Cloud'")
    expect(fix.edit.changes[URI][0]).toEqual({ range: d.range, newText: 'Bring Your Own Cloud' })
  })

  test('skips comments and listing blocks', () => {
    expect(glossaryDiags('= P\n\n// glossterm:nope[]\n----\nglossterm:nope2[]\n----\n')).toEqual([])
  })
})

describe('glossterm completion and hover', () => {
  test('completes term names and alt labels after glossterm:', () => {
    const text = '= P\n\nA glossterm:Bri\n'
    const items = features.completion(text, at(text, 'Bri', 3), ws, URI)
    const byoc = items.find((i) => i.label === 'Bring Your Own Cloud')
    expect(byoc.detail).toBe('other name for BYOC')
    expect(byoc.textEdit.newText).toBe('Bring Your Own Cloud[]')
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(['BYOC', 'broker']))
  })

  test('hover shows the definition, other names, and forms to avoid', () => {
    const text = '= P\n\nA glossterm:BYOC[] cluster.\n'
    const h = features.hover(text, at(text, 'BYOC', 1), ws, URI)
    expect(h.contents.value).toMatch(/\*\*BYOC\*\* \(Redpanda Cloud\)/)
    expect(h.contents.value).toMatch(/About BYOC\./)
    expect(h.contents.value).toMatch(/Also called: Bring Your Own Cloud/)
    expect(h.contents.value).toMatch(/Avoid: 'bring your own cloud' \(write 'Bring Your Own Cloud'\)/)
  })
})

describe('without a glossary', () => {
  test('leaves a note, stays enabled, and checks nothing', async () => {
    const bare = await loadWorkspace(makeWorkspace(), { env: {}, fetch: noFetch })
    expect(bare.disabled.glossary).toBeUndefined()
    expect(bare.notes.join('\n')).toMatch(/glossary not loaded, so glossterm: is not checked/)
    expect(features.diagnostics('= P\n\nglossterm:widgetron[]\n', bare).filter((d) => /glossary/.test(d.code))).toEqual([])
  })

  test('reads the published terms.json when there is no checkout', async () => {
    const json = { schema: 1, terms: [{ id: 'broker', term: 'broker', definition: 'About broker.', altLabels: [], doNotUse: [] }] }
    const fetch = async () => ({ ok: true, status: 200, json: async () => json })
    const remote = await loadWorkspace(makeWorkspace(), { env: {}, fetch })
    expect(remote.data.glossary.source).toMatch(/terms\.json$/)
    expect(features.diagnostics('= P\n\nglossterm:broker[] glossterm:nope[]\n', remote).filter((d) => /glossary/.test(d.code)).map((d) => d.code)).toEqual(['unknown-glossary-term'])
  })
})

test('findTerms keeps spaces in targets, like the macro', () => {
  expect(glossary._findTerms('glossterm:Schema Registry[] and glossterm:x[def]').map((g) => [g.target, g.definition])).toEqual([['Schema Registry', ''], ['x', 'def']])
})
