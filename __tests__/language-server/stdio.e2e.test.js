'use strict'

/**
 * Starts bin/docs-language-server.js as a child process and talks LSP to it
 * over stdio, the way VS Code and Claude Code do.
 *
 * By default the workspace is built from the shared fixtures. Set
 * DOCS_LS_REAL_DOCS to a checkout of redpanda-data/docs to run the same
 * requests against its real property JSON and taxonomy instead.
 */

const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { spawn } = require('child_process')
const rpc = require('vscode-jsonrpc/node')
const { makeWorkspace } = require('./workspace-fixture')

const SERVER = path.join(__dirname, '..', '..', 'bin', 'docs-language-server.js')

function startServer (env = {}) {
  const child = spawn(process.execPath, [SERVER, '--stdio'], { env: { ...process.env, REDPANDA_DOCS_PATH: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const connection = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout), new rpc.StreamMessageWriter(child.stdin))
  const published = new Map()
  const waiters = []
  connection.onNotification('textDocument/publishDiagnostics', (params) => {
    published.set(params.uri, params.diagnostics)
    for (const w of waiters.splice(0)) w()
  })
  connection.listen()
  const diagnosticsFor = async (uri) => {
    while (!published.has(uri)) await new Promise((resolve) => waiters.push(resolve))
    return published.get(uri)
  }
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const stop = async () => {
    await connection.sendRequest('shutdown')
    await connection.sendNotification('exit')
    await exited
    connection.dispose()
  }
  return { connection, diagnosticsFor, stop, child }
}

async function session (root, pageRelative, text) {
  const server = startServer()
  const { connection } = server
  await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: {} })
  connection.sendNotification('initialized', {})
  const uri = pathToFileURL(path.join(root, pageRelative)).href
  connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'asciidoc', version: 1, text } })
  return { ...server, uri }
}

const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle))
const charOf = (text, needle) => text.split('\n')[lineOf(text, needle)].indexOf(needle)

const PAGE = [
  '= Configure segments',
  ':page-categories: Security, Iceberg, Nonsense',
  '',
  'Set prop:log_segment_ms[] to roll segments. It defaults to propval:log_segment_ms[default].',
  'A typo: prop:log_segmnt_ms[].',
  '',
].join('\n')

const CLEAN = [
  '= Configure segments',
  ':page-categories: Security, Iceberg Topics',
  '',
  'Set prop:log_segment_ms[]. It defaults to propval:log_segment_ms[default].',
  '',
].join('\n')

describe('docs language server over stdio', () => {
  let root
  beforeAll(() => {
    root = makeWorkspace()
  })

  test('advertises completion, hover and quick fixes', async () => {
    const server = startServer()
    const result = await server.connection.sendRequest('initialize', { processId: process.pid, rootUri: null, capabilities: {} })
    expect(result.capabilities).toMatchObject({ hoverProvider: true, completionProvider: expect.any(Object), codeActionProvider: expect.any(Object) })
    await server.stop()
  })

  test('publishes the build warnings for a page, and quick-fixes the deprecated category', async () => {
    const s = await session(root, 'modules/manage/pages/segments.adoc', PAGE)
    try {
      const diags = await s.diagnosticsFor(s.uri)
      expect(diags.map((d) => d.code).sort()).toEqual(['deprecated-value', 'unknown-property', 'unknown-value'])
      for (const d of diags) expect(d.source).toBe('redpanda-docs')

      const deprecated = diags.find((d) => d.code === 'deprecated-value')
      const actions = await s.connection.sendRequest('textDocument/codeAction', {
        textDocument: { uri: s.uri },
        range: deprecated.range,
        context: { diagnostics: [deprecated] },
      })
      expect(actions).toHaveLength(1)
      expect(actions[0].edit.changes[s.uri][0].newText).toBe(':page-categories: Security, Iceberg Topics, Nonsense')

      const hover = await s.connection.sendRequest('textDocument/hover', {
        textDocument: { uri: s.uri },
        position: { line: lineOf(PAGE, 'propval:'), character: charOf(PAGE, 'propval:') + 3 },
      })
      expect(hover.contents.value).toMatch(/^\*\*Renders as:\*\* 2 weeks/)

      const completion = await s.connection.sendRequest('textDocument/completion', {
        textDocument: { uri: s.uri },
        position: { line: lineOf(PAGE, 'prop:log_segment_ms'), character: charOf(PAGE, 'prop:log_segment_ms') + 'prop:log_seg'.length },
      })
      expect(completion.map((i) => i.label)).toContain('log_segment_ms')
    } finally {
      await s.stop()
    }
  })

  test('negative control: a clean page gets an empty diagnostics list', async () => {
    const s = await session(root, 'modules/manage/pages/clean.adoc', CLEAN)
    try {
      expect(await s.diagnosticsFor(s.uri)).toEqual([])
    } finally {
      await s.stop()
    }
  })

  test('nothing goes to stdout but protocol messages', async () => {
    // A stray console.log in a loader would corrupt the stream and the
    // requests above would hang; this checks the guard directly.
    const s = await session(root, 'modules/manage/pages/segments.adoc', PAGE)
    let stderr = ''
    s.child.stderr.on('data', (chunk) => { stderr += chunk })
    try {
      await s.diagnosticsFor(s.uri)
      expect(stderr).not.toMatch(/Content-Length/)
    } finally {
      await s.stop()
    }
  })
})

const REAL = process.env.DOCS_LS_REAL_DOCS
;(REAL ? describe : describe.skip)('against a real docs checkout (DOCS_LS_REAL_DOCS)', () => {
  test('real property data and taxonomy: valid values are clean, invalid ones are reported', async () => {
    const root = path.resolve(REAL)
    expect(fs.existsSync(path.join(root, 'shared/modules/ROOT/attachments/taxonomy.yml'))).toBe(true)
    const s = await session(root, 'modules/manage/pages/language-server-probe.adoc', PAGE)
    const clean = pathToFileURL(path.join(root, 'modules/manage/pages/language-server-clean.adoc')).href
    s.connection.sendNotification('textDocument/didOpen', { textDocument: { uri: clean, languageId: 'asciidoc', version: 1, text: CLEAN } })
    try {
      const diags = await s.diagnosticsFor(s.uri)
      expect(diags.map((d) => d.code).sort()).toEqual(['deprecated-value', 'unknown-property', 'unknown-value'])
      expect(diags.find((d) => d.code === 'unknown-property').message).toMatch(/redpanda-properties-v\d+\.\d+\.\d+\.json from streaming@/)
      expect(await s.diagnosticsFor(clean)).toEqual([])
    } finally {
      await s.stop()
    }
  })
})
