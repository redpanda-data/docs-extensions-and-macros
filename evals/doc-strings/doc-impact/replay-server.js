#!/usr/bin/env node

'use strict'

/**
 * Stdio MCP server that replays recorded redpanda-docs responses.
 *
 * The harness registers it under the production server name, so the model
 * sees the same tool names and schemas it gets in CI. A tools/call returns
 * the recorded result of the exact or nearest recorded call (see
 * createReplayer in lib.js); with nothing close enough it returns an
 * explicit "no recording" tool error. Every call is appended to the replay
 * log with its match kind, which the harness counts per item. Nothing is
 * ever fetched.
 *
 * Environment:
 *   DOC_IMPACT_RECORDING  recording JSON for the item (calls[])
 *   DOC_IMPACT_TOOLS      tools/list snapshot (tools[])
 *   DOC_IMPACT_LOG        JSONL file that receives one line per tools/call
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout.
 */

const fs = require('fs')
const readline = require('readline')
const { createReplayer } = require('./lib')

function readJson (file, fallback) {
  if (!file) return fallback
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const recording = readJson(process.env.DOC_IMPACT_RECORDING, { calls: [] })
const tools = readJson(process.env.DOC_IMPACT_TOOLS, { tools: [] }).tools || []
const logFile = process.env.DOC_IMPACT_LOG
const lookup = createReplayer(recording)

function send (msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function handle (req) {
  const { id, method, params } = req
  if (id === undefined || id === null) return // notification
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'redpanda-docs-replay', version: '1.0.0' }
      }
    })
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } })
  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    const hit = lookup(name, args)
    if (logFile) {
      fs.appendFileSync(logFile, JSON.stringify({
        tool: name,
        arguments: args,
        match: hit ? hit.match : 'miss',
        ...(hit && hit.match === 'nearest' ? { recorded_arguments: hit.entry.arguments, overlap: hit.overlap } : {})
      }) + '\n')
    }
    if (hit) {
      return send({ jsonrpc: '2.0', id, result: { content: hit.entry.content, isError: Boolean(hit.entry.is_error) } })
    }
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [{ type: 'text', text: `NO RECORDING: this eval replays recorded docs responses and has none close to this ${name} call. Re-record the item with --mcp record.` }]
      }
    })
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }
  handle(req)
})
