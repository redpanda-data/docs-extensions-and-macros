'use strict'

/**
 * Snippet completions over stdio: starts bin/docs-language-server.js with
 * redpandaDocs.standardsPath in initializationOptions, as the VS Code client
 * sends it, and checks the items a real client receives.
 */

const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { spawn } = require('child_process')
const rpc = require('vscode-jsonrpc/node')
const { renderSnippet } = require('../../../language-server/features/snippets')
const { buildWorkspace } = require('../fixture')

const SERVER = path.join(__dirname, '..', '..', '..', 'bin', 'docs-language-server.js')
const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'snippets')
const STANDARDS = path.join(FIXTURES, 'standards')
const SNIPPET = 15

async function start (root, initializationOptions) {
  const child = spawn(process.execPath, [SERVER, '--stdio'], { env: { ...process.env, REDPANDA_DOCS_PATH: '' }, stdio: ['pipe', 'pipe', 'pipe'] })
  const connection = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout), new rpc.StreamMessageWriter(child.stdin))
  connection.listen()
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const init = await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: {}, initializationOptions })
  connection.sendNotification('initialized', {})
  const open = (relative, text) => {
    const uri = pathToFileURL(path.join(root, relative)).href
    connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'asciidoc', version: 1, text } })
    return uri
  }
  const complete = async (uri, position) => {
    const result = await connection.sendRequest('textDocument/completion', { textDocument: { uri }, position })
    return (Array.isArray(result) ? result : result.items).filter((i) => i.kind === SNIPPET)
  }
  const stop = async () => {
    await connection.sendRequest('shutdown')
    await connection.sendNotification('exit')
    await exited
    connection.dispose()
  }
  return { init, open, complete, stop }
}

describe('snippets over stdio', () => {
  let server
  beforeAll(async () => {
    const root = buildWorkspace({})
    server = await start(root, { standardsPath: STANDARDS })
  })
  afterAll(() => server.stop())

  test('a page with no title gets the page templates, exactly as the files', async () => {
    const uri = server.open('modules/ROOT/pages/new.adoc', '')
    const items = await server.complete(uri, { line: 0, character: 0 })
    const howTo = items.find((i) => i.label === 'page: how-to')
    expect(howTo.insertTextFormat).toBe(2)
    expect(renderSnippet(howTo.textEdit.newText)).toBe(fs.readFileSync(path.join(STANDARDS, 'resources', 'templates', 'how-to-template.adoc'), 'utf8'))
  })

  test('the body gets block snippets; the header and mid-line get none', async () => {
    const text = '= A page\n:description: Something.\n\nSome text.\n\n\n'
    const uri = server.open('modules/ROOT/pages/a.adoc', text)
    const body = (await server.complete(uri, { line: 5, character: 0 })).map((i) => i.label)
    expect(body).toEqual(expect.arrayContaining(['tabs', 'NOTE', '// Source:', 'prop: reference', 'propval: sentence']))
    expect(body.filter((l) => l.startsWith('page:'))).toEqual([])
    expect(await server.complete(uri, { line: 3, character: 4 })).toEqual([])
  })
})
