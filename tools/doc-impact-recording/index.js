'use strict'

/**
 * Turn a Claude Code transcript into a doc-impact MCP recording.
 *
 * The doc-strings review asks the docs MCP server (docs.redpanda.com/mcp)
 * whether published pages already cover a changed string. The doc-impact
 * eval replays those answers per item, so an eval run sees the docs as they
 * were when the review ran, not as they are today. A recording made later
 * would already contain the writer's fix for the PR, and the pass would
 * then correctly say "already documented" for a PR that needed docs.
 *
 * This reads the transcript the review step leaves behind and keeps only
 * what a replay needs: the tool name, its arguments, and the result content.
 * Nothing else from the transcript is copied, so the session's tokens,
 * headers, environment and identity never reach the recording.
 *
 * Accepted input:
 *   - the execution file anthropics/claude-code-action writes: one JSON
 *     array of SDK messages;
 *   - `claude -p --output-format stream-json` output: one message per line.
 * Both carry the same message shapes, so one parser serves both.
 */

const fs = require('fs')
const path = require('path')

const DEFAULT_SERVER = 'redpanda-docs'

/** Messages from a transcript, in order. Lines that are not JSON are skipped. */
function parseTranscript (text) {
  const raw = String(text || '')
  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    try {
      const all = JSON.parse(trimmed)
      if (Array.isArray(all)) return all.filter((m) => m && typeof m === 'object')
    } catch {
      // Not one JSON document; read it line by line below.
    }
  }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const m = JSON.parse(line)
      if (m && typeof m === 'object' && !Array.isArray(m)) out.push(m)
    } catch {
      // Progress lines and other non-JSON output are not messages.
    }
  }
  return out
}

/** Tool-result content as an array of MCP content blocks. */
function contentBlocks (content) {
  if (content == null) return []
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? { type: 'text', text: b } : b))
  return [{ type: 'text', text: JSON.stringify(content) }]
}

function blocksOf (message) {
  const content = message && message.message && message.message.content
  return Array.isArray(content) ? content : []
}

/**
 * Every call to one MCP server's tools, paired with its result, in call
 * order. A call with no result (the run stopped first) is left out: a
 * replay of it would answer with nothing the server ever said.
 */
function extractCalls (messages, { server = DEFAULT_SERVER } = {}) {
  const prefix = `mcp__${server}__`
  const calls = []
  const byId = new Map()
  for (const m of messages || []) {
    if (m.type === 'assistant') {
      for (const b of blocksOf(m)) {
        if (b && b.type === 'tool_use' && typeof b.name === 'string' && b.name.startsWith(prefix)) {
          const call = { tool: b.name.slice(prefix.length), arguments: b.input || {}, content: null, is_error: false }
          calls.push(call)
          byId.set(b.id, call)
        }
      }
    } else if (m.type === 'user') {
      for (const b of blocksOf(m)) {
        if (b && b.type === 'tool_result' && byId.has(b.tool_use_id)) {
          const call = byId.get(b.tool_use_id)
          call.content = contentBlocks(b.content)
          call.is_error = Boolean(b.is_error)
        }
      }
    }
  }
  return calls.filter((c) => c.content !== null)
}

/** The model the session ran on, from its init message. */
function sessionModel (messages) {
  const init = (messages || []).find((m) => m.type === 'system' && m.subtype === 'init')
  return (init && typeof init.model === 'string' && init.model) || null
}

/**
 * A recording in the shape the doc-impact eval replays:
 * { item, recorded_at, server_url, model, source, calls: [{ tool, arguments, content, is_error }] }
 */
function buildRecording (messages, { item = null, recordedAt, serverUrl = null, model = null, server = DEFAULT_SERVER } = {}) {
  return {
    item,
    recorded_at: recordedAt || new Date().toISOString(),
    server_url: serverUrl,
    model: model || sessionModel(messages),
    source: 'production',
    calls: extractCalls(messages, { server })
  }
}

/**
 * CLI entry: read --execution-file, write --output. Writes nothing when the
 * session made no docs calls, so the caller can tell "no calls" from "a
 * recording" by the file's presence. Exits 0 either way; a missing or
 * unreadable transcript is exit 1.
 */
function runCli (options, { log = console.log, error = console.error } = {}) {
  const file = options.executionFile
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    error(`Cannot read the transcript at ${file}: ${e.message}`)
    return 1
  }
  const messages = parseTranscript(text)
  const recording = buildRecording(messages, {
    item: options.item || null,
    recordedAt: options.recordedAt,
    serverUrl: options.serverUrl || null,
    model: options.model || null,
    server: options.server || DEFAULT_SERVER
  })
  if (!recording.calls.length) {
    log(`No ${options.server || DEFAULT_SERVER} MCP calls in ${messages.length} transcript message(s); no recording written.`)
    return 0
  }
  fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
  fs.writeFileSync(options.output, JSON.stringify(recording, null, 2) + '\n')
  log(`Wrote ${recording.calls.length} ${options.server || DEFAULT_SERVER} MCP call(s) to ${options.output}.`)
  return 0
}

module.exports = { parseTranscript, extractCalls, sessionModel, buildRecording, runCli, DEFAULT_SERVER }
