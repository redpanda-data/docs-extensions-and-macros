'use strict'

/**
 * The docs language server: LSP over stdio for pages and data files in a
 * Redpanda docs repository. Start it with `npx docs-language-server --stdio`;
 * the VS Code extension in editors/vscode and Claude Code's LSP tool both do.
 *
 * Each document is checked against the build data of the component it
 * belongs to (the nearest antora.yml above it), loaded once per component and
 * reloaded when the client reports a change to a file that the workspace or a
 * feature module watches. See workspace.js for where the data comes from,
 * features/index.js for the feature modules, and dispatch.js for how each
 * request reaches them. Adding a feature never changes this file.
 */

const { fileURLToPath } = require('url')
const {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} = require('vscode-languageserver/node')
const { TextDocument } = require('vscode-languageserver-textdocument')
const { findComponentRoot, loadWorkspace, CORE_WATCH } = require('./workspace')
const { createDispatcher } = require('./dispatch')
const registry = require('./features')

function startServer ({ connection = createConnection(ProposedFeatures.all), env = process.env, modules = registry } = {}) {
  // stdout carries the protocol: anything else written there corrupts it.
  console.log = (...args) => connection.console.log(args.join(' '))
  const documents = new TextDocuments(TextDocument)
  const workspaces = new Map() // component root -> Promise<workspace>
  const features = createDispatcher(modules, {
    onError: (id, hook, err) => connection.console.error(`docs language server: ${id} ${hook} failed: ${(err && err.stack) || err}`),
  })
  const watch = [...CORE_WATCH, ...features.watch]
  let settings = {}

  const workspaceFor = (uri) => {
    if (!uri || !uri.startsWith('file:')) return Promise.resolve(null)
    const file = fileURLToPath(uri)
    const root = findComponentRoot(file)
    if (!root) return Promise.resolve(null)
    if (!workspaces.has(root)) {
      const loading = loadWorkspace(root, { env, modules, settings }).then((ws) => {
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

  const docOf = (document) => ({ uri: document.uri, languageId: document.languageId, version: document.version, text: document.getText() })

  const validate = async (document) => {
    const ws = await workspaceFor(document.uri)
    const diagnostics = ws ? await features.diagnostics(docOf(document), ws) : []
    connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics })
  }

  connection.onInitialize((params) => {
    settings = (params && params.initializationOptions) || {}
    return {
      capabilities: { textDocumentSync: TextDocumentSyncKind.Incremental, ...features.capabilities() },
      serverInfo: { name: 'redpanda-docs-language-server' },
    }
  })

  documents.onDidChangeContent((change) => validate(change.document))
  documents.onDidClose((event) => connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] }))

  connection.onDidChangeWatchedFiles(({ changes }) => {
    if (!changes.some((c) => watch.some((rx) => rx.test(c.uri)))) return
    workspaces.clear()
    for (const document of documents.all()) validate(document)
  })

  const withDocument = (handler, empty) => async (params) => {
    const document = documents.get(params.textDocument.uri)
    if (!document) return empty
    const ws = await workspaceFor(document.uri)
    return ws ? handler(docOf(document), ws, params) : empty
  }

  connection.onCompletion(withDocument((doc, ws, p) => features.completion(doc, p.position, ws, p), []))
  connection.onHover(withDocument((doc, ws, p) => features.hover(doc, p.position, ws, p), null))
  connection.onCodeAction(withDocument((doc, ws, p) => features.codeActions(doc, p.context.diagnostics, ws, p), []))
  connection.onCodeLens(withDocument((doc, ws, p) => features.codeLens(doc, ws, p), []))
  connection.onDefinition(withDocument((doc, ws, p) => features.definition(doc, p.position, ws, p), null))
  connection.onDocumentLinks(withDocument((doc, ws, p) => features.documentLinks(doc, ws, p), []))

  // A command's workspace is the component of the first file URI among its
  // arguments, given as a string or as an object's `uri`.
  connection.onExecuteCommand(async ({ command, arguments: args = [] }) => {
    const uri = args.map((a) => (typeof a === 'string' ? a : a && a.uri)).find((u) => typeof u === 'string' && u.startsWith('file:'))
    const ws = uri ? await workspaceFor(uri) : null
    return features.executeCommand(command, args, ws, { connection, documents, workspaceFor, settings })
  })

  documents.listen(connection)
  connection.listen()
  return connection
}

module.exports = { startServer }
