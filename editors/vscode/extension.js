'use strict'

// Starts the docs language server from @redpanda-data/docs-extensions-and-macros
// for the AsciiDoc, JSON and YAML files of a docs repository. Every feature
// lives in the server, so this file only finds it, connects, and passes the
// settings through. The selectors, the file watcher and the settings below
// are deliberately broad: a new server feature needs no change here. Commands
// the server advertises are registered by the language client itself.

const fs = require('fs')
const path = require('path')
const vscode = require('vscode')
const { LanguageClient, TransportKind } = require('vscode-languageclient/node')

const PACKAGE = path.join('node_modules', '@redpanda-data', 'docs-extensions-and-macros')
const SERVER = path.join(PACKAGE, 'bin', 'docs-language-server.js')
// package.json jsonValidation points at this scheme, so the override schemas
// come from the workspace's installed package: the same version as the build.
const SCHEME = 'redpanda-docs-schema'

let client

function inWorkspace (relative) {
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const candidate = path.join(folder.uri.fsPath, relative)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function serverModule (config) {
  return config.get('serverPath') || inWorkspace(SERVER)
}

// A schema the workspace's package does not ship validates nothing.
const schemaProvider = {
  provideTextDocumentContent (uri) {
    const file = inWorkspace(path.join(PACKAGE, 'docs-data', path.basename(uri.path)))
    return file ? fs.readFileSync(file, 'utf8') : '{}'
  },
}

function settings (config) {
  return {
    docsPath: config.get('docsPath') || '',
    componentPaths: config.get('componentPaths') || [],
    standardsPath: config.get('standardsPath') || '',
  }
}

async function activate (context) {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, schemaProvider))
  const config = vscode.workspace.getConfiguration('redpandaDocs')
  const module = serverModule(config)
  if (!module) {
    vscode.window.showWarningMessage('Redpanda Docs: run npm install in this repository, or set redpandaDocs.serverPath, to start the docs language server.')
    return
  }
  const env = { ...process.env }
  const applyDocsPath = (c) => {
    if (c.get('docsPath')) env.REDPANDA_DOCS_PATH = c.get('docsPath')
    else delete env.REDPANDA_DOCS_PATH
  }
  applyDocsPath(config)
  const run = { module, transport: TransportKind.stdio, options: { env } }
  client = new LanguageClient('redpandaDocs', 'Redpanda Docs', { run, debug: run }, {
    documentSelector: ['asciidoc', 'json', 'yaml'].map((language) => ({ scheme: 'file', language })),
    // Read at each (re)start, so a settings change reaches the new server.
    initializationOptions: () => settings(vscode.workspace.getConfiguration('redpandaDocs')),
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/{antora.yml,*.json,*.yml,*.yaml,*.adoc}'),
    },
  })
  context.subscriptions.push(client)
  // Settings reach the server when it starts, so a change restarts it.
  // (A new serverPath takes effect when the window reloads.)
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('redpandaDocs') || !client) return
    applyDocsPath(vscode.workspace.getConfiguration('redpandaDocs'))
    client.restart()
  }))
  await client.start()
}

function deactivate () {
  return client ? client.stop() : undefined
}

module.exports = { activate, deactivate }
