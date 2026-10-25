'use strict'

// Starts the docs language server from @redpanda-data/docs-extensions-and-macros
// for AsciiDoc files. Every feature lives in the server, so this file only
// finds it and connects.

const fs = require('fs')
const path = require('path')
const vscode = require('vscode')
const { LanguageClient, TransportKind } = require('vscode-languageclient/node')

const SERVER = path.join('node_modules', '@redpanda-data', 'docs-extensions-and-macros', 'bin', 'docs-language-server.js')

let client

function serverModule (config) {
  const configured = config.get('serverPath')
  if (configured) return configured
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const candidate = path.join(folder.uri.fsPath, SERVER)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

async function activate (context) {
  const config = vscode.workspace.getConfiguration('redpandaDocs')
  const module = serverModule(config)
  if (!module) {
    vscode.window.showWarningMessage('Redpanda Docs: run npm install in this repository, or set redpandaDocs.serverPath, to start the docs language server.')
    return
  }
  const env = { ...process.env }
  if (config.get('docsPath')) env.REDPANDA_DOCS_PATH = config.get('docsPath')
  const run = { module, transport: TransportKind.stdio, options: { env } }
  client = new LanguageClient('redpandaDocs', 'Redpanda Docs', { run, debug: run }, {
    documentSelector: [{ scheme: 'file', language: 'asciidoc' }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/{antora.yml,taxonomy.yml,taxonomy.schema.json,valid-categories.yml,redpanda-properties-*.json}'),
    },
  })
  context.subscriptions.push(client)
  await client.start()
}

function deactivate () {
  return client ? client.stop() : undefined
}

module.exports = { activate, deactivate }
