'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  parseTranscript,
  extractCalls,
  sessionModel,
  buildRecording,
  runCli
} = require('../../tools/doc-impact-recording')

const FIXTURE = path.join(__dirname, 'fixtures', 'doc-impact-recording', 'execution-file.json')
const fixtureText = fs.readFileSync(FIXTURE, 'utf8')
const CLI = path.join(__dirname, '..', '..', 'bin', 'doc-tools.js')

// The same messages as stream-json, one per line, the way `claude -p
// --output-format stream-json` and the eval harness write them.
const asStreamJson = (text) => JSON.parse(text).map((m) => JSON.stringify(m)).join('\n') + '\nnot json\n'

function tmp () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-recording-'))
}

describe('doc-impact-recording: transcript parsing', () => {
  test('reads the claude-code-action execution file (one JSON array)', () => {
    expect(parseTranscript(fixtureText)).toHaveLength(7)
  })

  test('reads stream-json lines and skips lines that are not JSON', () => {
    expect(parseTranscript(asStreamJson(fixtureText))).toHaveLength(7)
  })

  test('both forms give the same calls', () => {
    expect(extractCalls(parseTranscript(asStreamJson(fixtureText)))).toEqual(extractCalls(parseTranscript(fixtureText)))
  })
})

describe('doc-impact-recording: calls', () => {
  const calls = extractCalls(parseTranscript(fixtureText))

  test('keeps only redpanda-docs calls, in call order, with the prefix stripped', () => {
    expect(calls.map((c) => c.tool)).toEqual(['ask_redpanda_question', 'get_api_reference_content'])
  })

  test('pairs each call with its own result and keeps the error flag', () => {
    expect(calls[0]).toEqual({
      tool: 'ask_redpanda_question',
      arguments: { question: 'How do I enable rack awareness?', platform: 'self-managed' },
      content: [{ type: 'text', text: '{"results":[{"source_url":"https://docs.redpanda.com/streaming/current/manage/rack-awareness/"}]}' }],
      is_error: false
    })
    expect(calls[1]).toEqual({
      tool: 'get_api_reference_content',
      arguments: { url: 'https://docs.redpanda.com/api/doc/admin/' },
      content: [{ type: 'text', text: 'page not found' }],
      is_error: true
    })
  })

  test('drops a call that never got a result', () => {
    expect(calls.find((c) => c.tool === 'search_api_reference')).toBeUndefined()
  })

  test('each call holds only tool, arguments, content and is_error', () => {
    for (const c of calls) expect(Object.keys(c).sort()).toEqual(['arguments', 'content', 'is_error', 'tool'])
  })

  test('another server name selects that server instead', () => {
    expect(extractCalls(parseTranscript(fixtureText), { server: 'github_inline_comment' }).map((c) => c.tool)).toEqual(['create_inline_comment'])
  })
})

describe('doc-impact-recording: recording', () => {
  test('has the eval recording shape and nothing from the session itself', () => {
    const rec = buildRecording(parseTranscript(fixtureText), {
      item: 'redpanda-operator-7',
      recordedAt: '2026-10-08T00:00:00.000Z',
      serverUrl: 'https://docs.redpanda.com/mcp'
    })
    expect(Object.keys(rec).sort()).toEqual(['calls', 'item', 'model', 'recorded_at', 'server_url', 'source'])
    expect(rec).toMatchObject({
      item: 'redpanda-operator-7',
      recorded_at: '2026-10-08T00:00:00.000Z',
      server_url: 'https://docs.redpanda.com/mcp',
      model: 'claude-sonnet-5',
      source: 'production'
    })
    const text = JSON.stringify(rec)
    for (const leak of ['apiKeySource', 'ANTHROPIC_API_KEY', 'session_id', '/home/runner', 'diff --git', 'suggestion']) {
      expect(text).not.toContain(leak)
    }
  })

  test('an explicit model wins over the init message', () => {
    expect(buildRecording(parseTranscript(fixtureText), { model: 'sonnet' }).model).toBe('sonnet')
    expect(sessionModel([])).toBeNull()
  })
})

describe('doc-impact-recording: CLI', () => {
  const quiet = { log: () => {}, error: () => {} }

  test('writes the recording and exits 0', () => {
    const dir = tmp()
    const out = path.join(dir, 'sub', 'recording.json')
    expect(runCli({ executionFile: FIXTURE, output: out, item: 'x-1' }, quiet)).toBe(0)
    const rec = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(rec.item).toBe('x-1')
    expect(rec.calls).toHaveLength(2)
  })

  test('writes nothing when there are no docs calls, and still exits 0', () => {
    const dir = tmp()
    const file = path.join(dir, 'none.json')
    fs.writeFileSync(file, JSON.stringify([{ type: 'system', subtype: 'init', model: 'm' }]))
    const out = path.join(dir, 'recording.json')
    const logs = []
    expect(runCli({ executionFile: file, output: out }, { log: (m) => logs.push(m), error: () => {} })).toBe(0)
    expect(fs.existsSync(out)).toBe(false)
    expect(logs.join('\n')).toMatch(/No redpanda-docs MCP calls/)
  })

  test('a missing transcript exits 1', () => {
    expect(runCli({ executionFile: path.join(tmp(), 'absent.json'), output: path.join(tmp(), 'r.json') }, quiet)).toBe(1)
  })

  test('is registered on doc-tools and runs end to end', () => {
    const out = path.join(tmp(), 'recording.json')
    const r = spawnSync(process.execPath, [CLI, 'doc-impact-recording', '--execution-file', FIXTURE, '--output', out,
      '--item', 'redpanda-operator-7', '--server-url', 'https://docs.redpanda.com/mcp', '--recorded-at', '2026-10-08T00:00:00.000Z'], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    const rec = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(rec).toMatchObject({ item: 'redpanda-operator-7', recorded_at: '2026-10-08T00:00:00.000Z', source: 'production' })
    expect(rec.calls).toHaveLength(2)
  })
})
