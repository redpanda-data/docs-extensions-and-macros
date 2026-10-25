'use strict'

/**
 * The docs language server: LSP over stdio for AsciiDoc pages in a Redpanda
 * docs repository. Start it with `npx docs-language-server --stdio`; the VS
 * Code extension in editors/vscode and Claude Code's LSP tool both do.
 *
 * Each page is checked against the build data of the component it belongs to
 * (the nearest antora.yml above it), loaded once per component and reloaded
 * when the client reports a change to antora.yml, a property JSON, or the
 * taxonomy. See workspace.js for where the data comes from and features.js
 * for what each request returns.
 */

const { fileURLToPath } = require('url')
const {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  CodeActionKind,
} = require('vscode-languageserver/node')
const { TextDocument } = require('vscode-languageserver-textdocument')
const { findComponentRoot, loadWorkspace } = require('./workspace')
const features = require('./features')

const RELOAD_RX = /(^|\/)(antora\.yml|taxonomy\.yml|taxonomy\.schema\.json|valid-categories\.yml|redpanda-properties-[^/]+\.json)$/

function startServer ({ connection = createConnection(ProposedFeatures.all), env = process.env } = {}) {
  // stdout carries the protocol: anything else written there corrupts it.
  console.log = (...args) => connection.console.log(args.join(' '))
  const documents = new TextDocuments(TextDocument)
  const workspaces = new Map() // component root -> Promise<workspace>

  const workspaceFor = (uri) => {
    if (!uri.startsWith('file:')) return Promise.resolve(null)
    const file = fileURLToPath(uri)
    const root = findComponentRoot(file)
    if (!root) return Promise.resolve(null)
    if (!workspaces.has(root)) {
      const loading = loadWorkspace(root, { env }).then((ws) => {
        connection.console.info(`docs language server: ${ws.component.name}@${ws.component.version || 'unversioned'} at ${root}; ` +
          `properties ${ws.properties ? ws.properties.tag : 'none'}; taxonomy ${ws.taxonomySource || 'none'}`)
        for (const note of ws.notes) connection.console.warn(`docs language server: ${note}`)
        return ws
      }).catch((err) => {
        connection.console.error(`docs language server: could not load ${root}: ${err.message}`)
        workspaces.delete(root)
        return null
      })
      workspaces.set(root, loading)
    }
    return workspaces.get(root)
  }

  const validate = async (document) => {
    const ws = await workspaceFor(document.uri)
    const diagnostics = ws ? features.diagnostics(document.getText(), ws) : []
    connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics })
  }

  connection.onInitialize(() => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: [':', '[', ',', ' '] },
      hoverProvider: true,
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
    },
    serverInfo: { name: 'redpanda-docs-language-server' },
  }))

  documents.onDidChangeContent((change) => validate(change.document))
  documents.onDidClose((event) => connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] }))

  connection.onDidChangeWatchedFiles(({ changes }) => {
    if (!changes.some((c) => RELOAD_RX.test(c.uri))) return
    workspaces.clear()
    for (const document of documents.all()) validate(document)
  })

  const withDocument = (handler, empty) => async (params) => {
    const document = documents.get(params.textDocument.uri)
    if (!document) return empty
    const ws = await workspaceFor(document.uri)
    return ws ? handler(document, ws, params) : empty
  }

  connection.onCompletion(withDocument((doc, ws, p) => features.completion(doc.getText(), p.position, ws), []))
  connection.onHover(withDocument((doc, ws, p) => features.hover(doc.getText(), p.position, ws), null))
  connection.onCodeAction(withDocument((doc, ws, p) => features.codeActions(doc.getText(), p.context.diagnostics, ws, doc.uri), []))

  documents.listen(connection)
  connection.listen()
  return connection
}

module.exports = { startServer }
