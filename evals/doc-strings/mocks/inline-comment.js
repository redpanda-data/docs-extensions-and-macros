#!/usr/bin/env node
'use strict'

/**
 * Stand-in for claude-code-action's github_inline_comment MCP server.
 *
 * The production review posts each suggestion through
 * mcp__github_inline_comment__create_inline_comment. In the eval the same
 * tool name exists, but every call is appended to $INLINE_COMMENT_LOG as one
 * JSON line and nothing reaches GitHub. The harness then applies and verifies
 * the recorded bodies exactly as it did with model text before.
 *
 * Speaks MCP over stdio: newline-delimited JSON-RPC 2.0.
 */

const fs = require('fs')
const readline = require('readline')

const LOG = process.env.INLINE_COMMENT_LOG
if (!LOG) {
  process.stderr.write('INLINE_COMMENT_LOG is not set\n')
  process.exit(2)
}

const TOOL = {
  name: 'create_inline_comment',
  description: 'Create an inline comment on a line or line range of a file in the pull request. Use a ```suggestion block in the body to propose a replacement for the commented lines.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the repository root' },
      body: { type: 'string', description: 'Comment body, Markdown' },
      line: { type: 'number', description: 'Line number (the last line of a range)' },
      startLine: { type: 'number', description: 'First line of a multi-line range' },
      side: { type: 'string', enum: ['LEFT', 'RIGHT'] }
    },
    required: ['path', 'body', 'line']
  }
}

function send (msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return // notification
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'github_inline_comment', version: 'eval-stand-in' }
      }
    })
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [TOOL] } })
  } else if (msg.method === 'tools/call') {
    const args = (msg.params && msg.params.arguments) || {}
    // GitHub rejects a review comment with no line, so the stand-in does too.
    if (msg.params.name !== TOOL.name || typeof args.path !== 'string' || typeof args.body !== 'string' || !Number.isInteger(args.line)) {
      send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'path, body and line are required' }] } })
      return
    }
    fs.appendFileSync(LOG, JSON.stringify(args) + '\n')
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Inline comment created.' }] } })
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
  }
})
