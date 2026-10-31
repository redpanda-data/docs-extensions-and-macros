'use strict'

const fs = require('fs')
const path = require('path')
const { loadWorkspace } = require('../../language-server/workspace')
const { createDispatcher, forText } = require('../../language-server/dispatch')
const registry = require('../../language-server/features')
const { buildWorkspace, noFetch } = require('./fixture')

const doc = (text, extra = {}) => ({ uri: 'file:///page.adoc', languageId: 'asciidoc', version: 1, text, ...extra })
const TYPO = '= Page\n\nprop:log_segmnt_ms[]\n'

// A module that reports one diagnostic on every page, so its presence or
// absence in the results is visible.
const probe = (overrides = {}) => ({
  id: 'probe',
  diagnostics: () => [{ message: 'probe ran', code: 'probe' }],
  ...overrides,
})

const workspace = (modules) => loadWorkspace(buildWorkspace({ properties: true, taxonomy: true }), { env: {}, fetch: noFetch, modules })

describe('the registry', () => {
  test('lists every features/*.js file once, alphabetically, each with the id of its file name', () => {
    const files = fs.readdirSync(path.join(__dirname, '..', '..', 'language-server', 'features'))
      .filter((f) => f.endsWith('.js') && f !== 'index.js')
      .map((f) => f.replace(/\.js$/, ''))
      .sort()
    expect(registry.map((m) => m.id)).toEqual(files)
  })

  test('advertises what the server advertised before the split', () => {
    const caps = createDispatcher().capabilities()
    expect(caps.hoverProvider).toBe(true)
    expect(caps.codeActionProvider).toEqual({ codeActionKinds: ['quickfix'] })
    expect([...caps.completionProvider.triggerCharacters].sort()).toEqual([' ', ',', ':', '['])
    expect(caps).not.toHaveProperty('codeLensProvider')
    expect(caps).not.toHaveProperty('executeCommandProvider')
  })
})

describe('a module whose load throws', () => {
  test('is turned off for that workspace, says why, and the other modules keep working', async () => {
    const broken = probe({ load () { throw new Error('enterprise-features.yml is not valid YAML') } })
    const modules = [...registry, broken]
    const ws = await workspace(modules)
    expect(ws.disabled).toEqual({ probe: 'enterprise-features.yml is not valid YAML' })
    expect(ws.notes.join('\n')).toMatch(/probe is turned off for streaming: its data could not be loaded: enterprise-features\.yml is not valid YAML/)
    const codes = createDispatcher(modules).diagnostics(doc(TYPO), ws).map((d) => d.code)
    expect(codes).toEqual(['unknown-property'])
  })

  test('negative control: the same module with a load that succeeds contributes, and its data is at ws.data[id]', async () => {
    const working = probe({ load: async () => ({ loaded: true }) })
    const modules = [...registry, working]
    const ws = await workspace(modules)
    expect(ws.disabled).toEqual({})
    expect(ws.data.probe).toEqual({ loaded: true })
    const codes = createDispatcher(modules).diagnostics(doc(TYPO), ws).map((d) => d.code)
    expect(codes).toEqual(['unknown-property', 'probe'])
  })

  test('a rejected async load is isolated the same way', async () => {
    const ws = await workspace([...registry, probe({ load: async () => { throw new Error('no checkout') } })])
    expect(ws.disabled.probe).toBe('no checkout')
    expect(ws.properties).not.toBeNull()
  })
})

describe('a hook that throws at request time', () => {
  test('is reported and contributes nothing; the other modules still answer', async () => {
    const ws = await workspace(registry)
    const errors = []
    const modules = [...registry, probe({ diagnostics () { throw new Error('boom') }, hover () { throw new Error('boom') } })]
    const d = createDispatcher(modules, { onError: (id, hook, err) => errors.push(`${id}.${hook}: ${err.message}`) })
    expect(d.diagnostics(doc(TYPO), ws).map((x) => x.code)).toEqual(['unknown-property'])
    expect(d.hover(doc(TYPO), { line: 2, character: 8 }, ws).contents.value).toMatch(/not in the property data/)
    expect(errors).toEqual(['probe.diagnostics: boom', 'probe.hover: boom'])
  })

  test('an async hook that rejects is isolated too, and async results are merged', async () => {
    const ws = await workspace(registry)
    const errors = []
    const modules = [...registry, probe({ diagnostics: async () => [{ code: 'late' }] }), { id: 'rejects', diagnostics: async () => { throw new Error('nope') } }]
    const d = createDispatcher(modules, { onError: (id) => errors.push(id) })
    const result = d.diagnostics(doc(TYPO), ws)
    expect(typeof result.then).toBe('function')
    expect((await result).map((x) => x.code)).toEqual(['unknown-property', 'late'])
    expect(errors).toEqual(['rejects'])
  })
})

describe('dispatch', () => {
  test('a module sees only documents in its languages', async () => {
    const ws = await workspace(registry)
    const json = probe({ id: 'json-probe', languages: ['json'] })
    const d = createDispatcher([...registry, json])
    expect(d.diagnostics(doc('prop:log_segmnt_ms[]', { uri: 'file:///x.json', languageId: 'json' }), ws).map((x) => x.code)).toEqual(['probe'])
    // Negative control: on an AsciiDoc page the JSON module is silent.
    expect(d.diagnostics(doc(TYPO), ws).map((x) => x.code)).toEqual(['unknown-property'])
  })

  test('capabilities, watch patterns and commands are unioned from the modules', async () => {
    const extra = {
      id: 'extra',
      watch: [/enterprise-features\.yml$/],
      triggerCharacters: ['{'],
      codeLens: () => [],
      commands: { 'redpandaDocs.probe': async (args, ws) => ({ args, component: ws && ws.component.name }) },
    }
    const d = createDispatcher([...registry, extra])
    const caps = d.capabilities()
    expect(caps.completionProvider.triggerCharacters).toContain('{')
    expect(caps.codeLensProvider).toEqual({ resolveProvider: false })
    expect(caps.executeCommandProvider).toEqual({ commands: ['redpandaDocs.probe'] })
    expect(d.watch.some((rx) => rx.test('file:///docs/shared/modules/ROOT/partials/enterprise-features.yml'))).toBe(true)
    const ws = await workspace(registry)
    expect(await d.executeCommand('redpandaDocs.probe', ['a'], ws)).toEqual({ args: ['a'], component: 'streaming' })
  })

  test('two modules with the same id or command are rejected', () => {
    expect(() => createDispatcher([probe(), probe()])).toThrow(/two feature modules have the id 'probe'/)
    const cmd = (id) => ({ id, commands: { 'redpandaDocs.x': () => {} } })
    expect(() => createDispatcher([cmd('a'), cmd('b')])).toThrow(/'redpandaDocs.x' is registered by both a and b/)
  })

  test('forText runs the registry over plain text', async () => {
    const ws = await workspace(registry)
    expect(forText().diagnostics(TYPO, ws).map((x) => x.code)).toEqual(['unknown-property'])
  })
})
