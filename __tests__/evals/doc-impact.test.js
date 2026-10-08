'use strict'

/**
 * Mechanical self-test for the doc-impact eval (evals/doc-strings/doc-impact).
 * Runs without the claude CLI: prompt and gate extraction from the live
 * workflow, item validation, URL normalization, scoring math, stream-json
 * parsing, the replay server over stdio, and control materialization with
 * the real lint-strings.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const lib = require('../../evals/doc-strings/doc-impact/lib')
const { materializeControl, controlVerdict, parseSurfaces, quotaRefusals, runItem, useItemsFile } = require('../../evals/doc-strings/doc-impact/run')
const { toItems, publicItem, refPatterns, classifyTickets } = require('../../evals/doc-strings/doc-impact/mine-candidates')

const DIR = path.join(__dirname, '../../evals/doc-strings/doc-impact')

const VALID_IMPACT = {
  findings: [{
    surface: 'properties',
    name: 'enable_rack_awareness',
    change_kind: 'renamed',
    affected_pages: ['https://docs.redpanda.com/streaming/current/manage/rack-awareness/'],
    summary: 'Renamed.'
  }],
  proposed_ticket: { title: 'Update rack awareness docs', body: '- rename' }
}

function item (id, label, extra = {}) {
  return { id, label, label_strength: 'strong', confirmed_by: null, expected_pages: [], repo: 'r/r', title: 't', body: '', reason: 'r', ...extra }
}

describe('production workflow extraction', () => {
  const wf = lib.loadWorkflow()

  test('the impact prompt is cut from the live review prompt', () => {
    const p = lib.extractImpactPrompt(wf.prompt)
    expect(p.preamble.startsWith('You are reviewing')).toBe(true)
    expect(p.preamble).toContain('lint-findings.json')
    expect(p.preamble).not.toContain('INLINE SUGGESTIONS')
    expect(p.impact.startsWith('PUBLISHED-CONTENT IMPACT:')).toBe(true)
    expect(p.impact).toContain('doc-impact.json')
    expect(p.impact).not.toContain('SUMMARY:')
    expect(p.mcpBudget).toBeGreaterThan(0)
  })

  test('a prompt without the impact section is a harness error, not a weaker eval', () => {
    const broken = wf.prompt.replace('PUBLISHED-CONTENT IMPACT:', 'IMPACT NOTES:')
    expect(() => lib.extractImpactPrompt(broken)).toThrow(/PUBLISHED-CONTENT IMPACT/)
  })

  test('tool settings come from the workflow claude_args', () => {
    const s = lib.extractClaudeSettings(wf.claudeArgs)
    expect(s.mcpConfig.mcpServers['redpanda-docs'].url).toMatch(/^https:\/\/docs\.redpanda\.com\//)
    expect(s.mcpTools.length).toBeGreaterThan(0)
    expect(s.allowedTools).toEqual(expect.arrayContaining(['Read', 'Write']))
    expect(s.allowedTools.some((t) => t.startsWith('Bash'))).toBe(false)
    expect(s.maxTurns).toBeGreaterThan(0)
  })

  test('diff excludes and the size cap come from the diff step', () => {
    const d = lib.extractDiffExcludes(wf.diffScript)
    expect(d.excludes).toEqual(expect.arrayContaining([':(exclude,glob)**/*.adoc']))
    expect(d.byteLimit).toBeGreaterThan(0)
  })

  test('the dispatch gate accepts a well-formed report and rejects a bad one', () => {
    const filter = lib.extractDispatchFilter(wf.dispatchScript)
    expect(lib.validateImpact(JSON.stringify(VALID_IMPACT), filter).valid).toBe(true)
    const offsite = JSON.parse(JSON.stringify(VALID_IMPACT))
    offsite.findings[0].affected_pages = ['https://example.com/page']
    expect(lib.validateImpact(JSON.stringify(offsite), filter).valid).toBe(false)
    expect(lib.validateImpact(JSON.stringify({ findings: [] }), filter).valid).toBe(false)
    expect(lib.validateImpact('not json', filter).valid).toBe(false)
  })

  test('the built prompt carries both production sections and the PR number', () => {
    const p = lib.extractImpactPrompt(wf.prompt)
    const text = lib.buildPrompt(p, item('x', 'no_change', { repo: 'redpanda-data/streaming-enterprise', pr_url: 'https://github.com/redpanda-data/streaming-enterprise/pull/123' }))
    expect(text).toContain('PR_NUMBER: 123')
    expect(text).toContain(p.preamble)
    expect(text).toContain(p.impact)
  })
})

describe('items', () => {
  test('the shipped item and control files validate', () => {
    expect(Array.isArray(lib.loadItems(path.join(DIR, 'items.json')))).toBe(true)
    const controls = lib.loadItems(path.join(DIR, 'controls.json'), { synthetic: true })
    expect(controls.map((c) => c.label).sort()).toEqual(['needs_docs', 'no_change'])
  })

  test('malformed items throw', () => {
    const real = { ...item('a', 'needs_docs'), pr_url: 'https://github.com/o/r/pull/1', base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40) }
    expect(() => lib.validateItem(real)).not.toThrow()
    expect(() => lib.validateItem({ ...real, label: 'maybe' })).toThrow(/label/)
    expect(() => lib.validateItem({ ...real, base_sha: 'abc' })).toThrow(/base_sha/)
    expect(() => lib.validateItem({ ...real, expected_pages: ['https://example.com/'] })).toThrow(/expected_pages/)
    expect(() => lib.validateItem({ ...real, label: 'no_change', expected_pages: ['https://docs.redpanda.com/x/'] })).toThrow(/no_change/)
  })

  test('only strong or confirmed items count by default', () => {
    expect(lib.isConfirmed(item('a', 'no_change'))).toBe(true)
    expect(lib.isConfirmed(item('a', 'no_change', { label_strength: 'weak' }))).toBe(false)
    expect(lib.isConfirmed(item('a', 'no_change', { label_strength: 'weak', confirmed_by: 'a writer' }))).toBe(true)
  })
})

describe('normalizeUrl', () => {
  test.each([
    ['https://docs.redpanda.com/streaming/current/manage/rack-awareness/', 'https://docs.redpanda.com/streaming/:version/manage/rack-awareness'],
    ['http://WWW.docs.redpanda.com/streaming/25.3/manage/rack-awareness.html#x?y', 'https://docs.redpanda.com/streaming/:version/manage/rack-awareness'],
    ['https://docs.redpanda.com/streaming/current/manage/rack-awareness?ref=a', 'https://docs.redpanda.com/streaming/:version/manage/rack-awareness'],
    ['https://docs.redpanda.com/redpanda-cloud/get-started/index.html', 'https://docs.redpanda.com/redpanda-cloud/get-started']
  ])('%s', (raw, want) => {
    expect(lib.normalizeUrl(raw)).toBe(want)
  })

  test('different pages stay different', () => {
    expect(lib.normalizeUrl('https://docs.redpanda.com/streaming/current/manage/a/'))
      .not.toBe(lib.normalizeUrl('https://docs.redpanda.com/streaming/current/manage/b/'))
  })
})

describe('score', () => {
  const pos = (id, extra) => item(id, 'needs_docs', { expected_pages: ['https://docs.redpanda.com/s/current/p1/', 'https://docs.redpanda.com/s/current/p2/'], ...extra })
  const neg = (id, extra) => item(id, 'no_change', extra)
  const P1 = lib.normalizeUrl('https://docs.redpanda.com/s/current/p1/')
  const P3 = lib.normalizeUrl('https://docs.redpanda.com/s/current/p3/')

  test('flag recall, abstention recall and the harmonic headline', () => {
    const s = lib.score([
      { item: pos('p1'), status: 'OK', flagged: true, pages: [P1, P3] },
      { item: pos('p2'), status: 'OK', flagged: false, pages: [] },
      { item: neg('n1'), status: 'OK', flagged: false, pages: [] },
      { item: neg('n2'), status: 'OK', flagged: false, pages: [] },
      { item: neg('n3'), status: 'OK', flagged: true, pages: [P3] },
      { item: neg('n4'), status: 'MODEL_ERROR', flagged: false, pages: [] }
    ])
    expect(s.flag_recall).toBeCloseTo(0.5)
    expect(s.abstention_recall).toBeCloseTo(2 / 3)
    expect(s.headline).toBeCloseTo((2 * 0.5 * (2 / 3)) / (0.5 + 2 / 3))
    expect(s.counts).toEqual({ scored: 5, needs_docs: 2, no_change: 3, excluded: 1, gate_closed: 0, replay_incomplete: 0, errors: 1 })
    // Page scores only on the correctly flagged positive: 1 hit of 2 predicted, 2 expected.
    expect(s.page_precision).toBeCloseTo(0.5)
    expect(s.page_recall).toBeCloseTo(0.5)
    expect(s.perItem.find((p) => p.id === 'n4').correct).toBeUndefined()
  })

  test('a closed lint gate and an incomplete replay are left out of F and A, and counted apart from errors', () => {
    const base = [
      { item: pos('p1'), status: 'OK', flagged: true, pages: [P1] },
      { item: neg('n1'), status: 'OK', flagged: true, pages: [P3] }
    ]
    const s = lib.score(base.concat([
      // Both would raise A to 2/3 or 3/3 if they were scored as abstentions.
      { item: neg('gate'), status: 'GATE_CLOSED', flagged: false, pages: [] },
      { item: neg('miss'), status: 'REPLAY_INCOMPLETE', flagged: false, pages: [] },
      { item: pos('gate-pos'), status: 'GATE_CLOSED', flagged: false, pages: [] }
    ]))
    expect(s.flag_recall).toBe(1)
    expect(s.abstention_recall).toBe(0)
    expect(s.counts).toEqual({ scored: 2, needs_docs: 1, no_change: 1, excluded: 3, gate_closed: 2, replay_incomplete: 1, errors: 0 })
    expect(s.perItem.find((p) => p.id === 'gate').correct).toBeUndefined()
  })

  test('flag-everything and flag-nothing both score zero', () => {
    const items = [pos('p1'), pos('p2'), neg('n1'), neg('n2')]
    const all = lib.score(items.map((i) => ({ item: i, status: 'OK', flagged: true, pages: [] })))
    const none = lib.score(items.map((i) => ({ item: i, status: 'OK', flagged: false, pages: [] })))
    expect(all.headline).toBe(0)
    expect(none.headline).toBe(0)
  })

  test('the headline is refused when only one class is present', () => {
    const s = lib.score([{ item: pos('p1'), status: 'OK', flagged: true, pages: [P1] }])
    expect(s.headline).toBeNull()
    expect(s.headline_refused).toMatch(/only one class/)
    expect(s.flag_recall).toBe(1)
  })

  test('duplicate rate counts a stacked item that repeats its flagged parent', () => {
    const s = lib.score([
      { item: pos('a'), status: 'OK', flagged: true, pages: [P1], names: ['x'] },
      { item: neg('b', { stacked_on: 'a' }), status: 'OK', flagged: true, pages: [P3], names: ['X'] },
      { item: neg('c', { stacked_on: 'a' }), status: 'OK', flagged: true, pages: [P3], names: ['y'] },
      { item: neg('d', { stacked_on: 'a' }), status: 'OK', flagged: false, pages: [], names: [] }
    ])
    expect(s.duplicate_rate).toBeCloseTo(0.5)
    expect(s.duplicates).toEqual(['b'])
  })
})

describe('stream-json, recording and replay', () => {
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    'not json',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__redpanda-docs__ask_redpanda_question', input: { question: 'Rack awareness', context: 'checking a rename' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'page: rack-awareness' }] }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'doc-impact.json' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 3 })
  ].join('\n')

  test('pairs tool calls with results and isolates the MCP calls', () => {
    const p = lib.parseStreamJson(stream)
    expect(p.result).toEqual({ text: 'done', isError: false, subtype: 'success', numTurns: 3 })
    expect(p.calls).toHaveLength(2)
    expect(p.mcpCalls).toHaveLength(1)
    expect(p.mcpCalls[0].tool).toBe('ask_redpanda_question')
    expect(p.mcpCalls[0].content).toEqual([{ type: 'text', text: 'page: rack-awareness' }])
  })

  test('replay: exact canonical match first, then nearest same-tool query, else null', () => {
    const rec = lib.buildRecording({ id: 'x' }, [
      { tool: 'ask_redpanda_question', input: { question: 'enable_rack_awareness cluster property', context: 'a' }, content: [{ type: 'text', text: 'first' }], isError: false },
      { tool: 'ask_redpanda_question', input: { question: 'enable_rack_awareness cluster property' }, content: [{ type: 'text', text: 'second' }], isError: false },
      { tool: 'ask_redpanda_question', input: { question: 'leader pinning prerequisites' }, content: [{ type: 'text', text: 'pinning' }], isError: false }
    ], { recordedAt: 'now', serverUrl: 'u', model: 'm' })
    const lookup = lib.createReplayer(rec)
    const exact1 = lookup('ask_redpanda_question', { question: '  ENABLE_rack_awareness   cluster property ', context: 'different' })
    expect(exact1.match).toBe('exact')
    expect(exact1.entry.content[0].text).toBe('first')
    expect(lookup('ask_redpanda_question', { question: 'enable_rack_awareness cluster property' }).entry.content[0].text).toBe('second')
    expect(lookup('ask_redpanda_question', { question: 'enable_rack_awareness cluster property' }).entry.content[0].text).toBe('second')
    // Rephrased: the shorter query is contained in a recorded one.
    const near = lookup('ask_redpanda_question', { question: 'enable_rack_awareness', top_k: 8 })
    expect(near.match).toBe('nearest')
    expect(near.entry.content[0].text).toBe('first')
    expect(lookup('ask_redpanda_question', { question: 'pinning leader' }).entry.content[0].text).toBe('pinning')
    // Unrelated text, or the right text on a different tool, is a miss.
    expect(lookup('ask_redpanda_question', { question: 'schema registry authentication' })).toBeNull()
    expect(lookup('search_api_reference', { query: 'enable_rack_awareness' })).toBeNull()
  })

  test('the stdio replay server serves hits, logs every match kind, and answers misses with an explicit error', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-replay-'))
    const recFile = path.join(tmp, 'rec.json')
    const toolsFile = path.join(tmp, 'tools.json')
    const log = path.join(tmp, 'replay.jsonl')
    fs.writeFileSync(recFile, JSON.stringify({ calls: [{ tool: 'ask_redpanda_question', arguments: { question: 'rack awareness' }, content: [{ type: 'text', text: 'recorded' }], is_error: false }] }))
    fs.writeFileSync(toolsFile, JSON.stringify({ tools: [{ name: 'ask_redpanda_question', inputSchema: { type: 'object' } }] }))
    const child = spawn(process.execPath, [path.join(DIR, 'replay-server.js')], {
      env: { ...process.env, DOC_IMPACT_RECORDING: recFile, DOC_IMPACT_TOOLS: toolsFile, DOC_IMPACT_LOG: log }
    })
    const replies = new Map()
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        replies.set(msg.id, msg)
      }
    })
    const send = (m) => child.stdin.write(JSON.stringify(m) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_redpanda_question', arguments: { question: 'Rack Awareness', context: 'x' } } })
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ask_redpanda_question', arguments: { question: 'unrecorded' } } })
    send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ask_redpanda_question', arguments: { question: 'awareness', top_k: 3 } } })
    send({ jsonrpc: '2.0', id: 5, method: 'resources/list' })
    const deadline = Date.now() + 10000
    while (replies.size < 6 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    child.kill()
    expect(replies.get(1).result.protocolVersion).toBe('2025-06-18')
    expect(replies.get(2).result.tools.map((t) => t.name)).toEqual(['ask_redpanda_question'])
    expect(replies.get(3).result).toEqual({ content: [{ type: 'text', text: 'recorded' }], isError: false })
    expect(replies.get(4).result.isError).toBe(true)
    expect(replies.get(4).result.content[0].text).toMatch(/^NO RECORDING/)
    expect(replies.get(5).error.code).toBe(-32601)
    expect(replies.get(6).result.content[0].text).toBe('recorded')
    const logged = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    expect(logged.map((l) => l.match)).toEqual(['exact', 'miss', 'nearest'])
    expect(logged[2].recorded_arguments).toEqual({ question: 'rack awareness' })
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe('controls', () => {
  const controls = lib.loadItems(path.join(DIR, 'controls.json'), { synthetic: true })

  test('control inputs come from the real lint-strings and pass the workflow gate', () => {
    const byId = Object.fromEntries(controls.map((c) => [c.id, c]))
    const posIn = materializeControl(byId['control-needs-docs'])
    const posLint = JSON.parse(posIn.findings)
    expect(posLint.summary.removedDeclarations.map((d) => d.name)).toEqual(['enable_rack_awareness'])
    expect(posLint.declarations.map((d) => d.name)).toEqual(['rack_awareness_enabled'])
    expect(posIn.diff).toContain('-      "enable_rack_awareness",')

    const negIn = materializeControl(byId['control-no-change'])
    const negLint = JSON.parse(negIn.findings)
    expect(negLint.summary.totalDeclarations).toBe(1)
    expect(negLint.summary.removedSurfaceLines).toBe(0)
    expect(negLint.findings).toEqual([])
  }, 120000)

  test('a harness that always or never flags fails the controls', () => {
    const pages = controls.find((c) => c.label === 'needs_docs').expected_pages.map(lib.normalizeUrl)
    const run = (flagged) => controls.map((c) => ({ id: c.id, status: 'OK', flagged, pages: flagged ? pages : [], replay_misses: 0 }))
    expect(controlVerdict(run(true), controls)).toEqual(['control-no-change: negative control flagged'])
    expect(controlVerdict(run(false), controls)).toEqual(['control-needs-docs: positive control not flagged'])
    const good = controls.map((c) => ({ id: c.id, status: 'OK', flagged: c.label === 'needs_docs', pages: c.label === 'needs_docs' ? [pages[0]] : [], replay_misses: 0 }))
    expect(controlVerdict(good, controls)).toEqual([])
    good[0].replay_misses = 1
    expect(controlVerdict(good, controls)).toHaveLength(1)
  })
})

describe('seeding and freezing', () => {
  const candidate = (id, extra = {}) => ({
    id,
    repo: 'redpanda-data/redpanda-operator',
    pr_url: `https://github.com/redpanda-data/redpanda-operator/pull/${id.split('-').pop()}`,
    title: 'operator: add a thing',
    body: '',
    proposed_label: 'needs_docs',
    label_strength: 'strong',
    pages: ['https://docs.redpanda.com/streaming/current/manage/a/', 'partial:docs:modules/manage/partials/b.adoc'],
    reason: 'merged docs PR',
    base_sha: 'a'.repeat(40),
    merge_base_sha: 'b'.repeat(40),
    head_sha: 'c'.repeat(40),
    backport: false,
    evidence: [],
    ...extra
  })

  test('candidates become valid items; partials stay out of expected_pages; backports stack on their original', () => {
    const items = toItems([
      candidate('redpanda-operator-1'),
      candidate('redpanda-operator-2', { title: '[release/v26.1.x] operator: add a thing (#1)', backport: true }),
      candidate('redpanda-operator-3', { title: 'operator: tidy logs', proposed_label: 'no_change', label_strength: 'provisional', pages: [] })
    ], [])
    for (const i of items) expect(() => lib.validateItem(i)).not.toThrow()
    expect(items[0].expected_pages).toEqual(['https://docs.redpanda.com/streaming/current/manage/a/'])
    expect(items[0].expected_partials).toEqual(['partial:docs:modules/manage/partials/b.adoc'])
    expect(items[1].stacked_on).toBe('redpanda-operator-1')
    expect(items[0].stacked_on).toBeUndefined()
    expect(items.map((i) => i.confirmed_by)).toEqual([null, null, null])
    expect(lib.isConfirmed(items[2])).toBe(false)
  })

  test('a public item drops private evidence and keeps its own PR URL', () => {
    const own = 'https://github.com/redpanda-data/redpanda-operator/pull/1'
    const [item] = toItems([candidate('redpanda-operator-1', {
      reason: `merged docs PR https://github.com/redpanda-data/docs/pull/9, https://github.com/redpanda-data/docs/pull/8 edited non-generated pages; see DOC-1234 and ${own}`,
      evidence: ['https://github.com/redpanda-data/docs/pull/9 [merged]', 'DOC-1234 [Done]']
    })], [])
    const pub = publicItem(item)
    expect(pub.evidence).toBeUndefined()
    expect(pub.expected_partials).toBeUndefined()
    expect(pub.reason).toBe(`merged docs PRs edited non-generated pages; see a DOC ticket and ${own}`)
    expect(JSON.stringify(pub)).not.toMatch(/redpanda-data\/docs\/pull|DOC-\d|partial:/)
    expect(pub.expected_pages).toEqual(item.expected_pages)
    expect(() => lib.validateItem(pub)).not.toThrow()
    // A private item keeps everything: it never goes in this repository.
    expect(item.evidence).toEqual(['https://github.com/redpanda-data/docs/pull/9 [merged]', 'DOC-1234 [Done]'])
  })

  test('a writer-confirmed item survives a reseed unchanged', () => {
    const confirmed = { ...toItems([candidate('redpanda-operator-1')], [])[0], label: 'no_change', expected_pages: [], confirmed_by: 'a writer' }
    const [again] = toItems([candidate('redpanda-operator-1')], [confirmed])
    expect(again).toBe(confirmed)
  })

  test('surfaces come from the caller workflow input', () => {
    expect(parseSurfaces('jobs:\n  review:\n    with:\n      surfaces: helm,crd\n')).toBe('helm,crd')
    expect(parseSurfaces('jobs:\n  review:\n    with:\n      model: x\n')).toBeNull()
  })

  // The docs server's anonymous-quota refusal, verbatim as it arrived in a
  // recording run: an ordinary tool result (is_error false) whose text is a
  // JSON error body.
  const SERVER_REFUSAL = '{"error":"anonymous_quota_exhausted","message":"You have used your 10 free Redpanda docs tool calls for this 24-hour window. Connecting and listing tools are free; only tool calls count. For unlimited tool calls, reconnect this MCP server so your client runs its sign-in flow with a free Redpanda Cloud account. If your client does not prompt you, sign in at https://docs.redpanda.com/login in your default browser first, then reconnect.","limit":10,"resets_at":"2026-10-07T09:20:47.067Z","sign_in_url":"https://docs.redpanda.com/login"}'
  const DOCS_ANSWER = JSON.stringify({ results: [{ source_url: 'https://docs.redpanda.com/current/manage/cluster-maintenance/manage-throughput/', content: 'Client quotas and the rate limit for produce requests. Sign in to Redpanda Cloud to reconnect.' }] })

  test('the server\'s real quota refusal is detected although it is not an MCP error', () => {
    const calls = [
      { tool: 'ask_redpanda_question', isError: false, content: [{ type: 'text', text: SERVER_REFUSAL }] },
      // Negative controls: real docs answers about quotas, rate limits and
      // signing in, as JSON and as prose, and an ordinary argument error.
      { tool: 'ask_redpanda_question', isError: false, content: [{ type: 'text', text: DOCS_ANSWER }] },
      { tool: 'ask_redpanda_question', isError: false, content: [{ type: 'text', text: 'The rate limit for produce requests is set by client quotas. Reconnect after you sign in.' }] },
      { tool: 'ask_redpanda_question', isError: true, content: [{ type: 'text', text: 'Invalid arguments: question is required' }] },
      { tool: 'ask_redpanda_question', isError: false, content: [{ type: 'text', text: '{"error":"invalid_arguments","message":"question is required"}' }] },
      // A server that refuses with an MCP error and plain text instead.
      { tool: 'ask_redpanda_question', isError: true, content: [{ type: 'text', text: 'Anonymous tool-call limit reached. Reconnect to sign in.' }] }
    ]
    expect(quotaRefusals(calls)).toEqual([calls[0], calls[5]])
    expect(lib.limitRefusal(calls[0])).toBe(SERVER_REFUSAL)
    // Recording entries use is_error; the check reads them the same way.
    const rec = lib.buildRecording({ id: 'x' }, calls, { recordedAt: 't', serverUrl: null, model: 'm' })
    expect(lib.limitRefusals(rec.calls)).toEqual([rec.calls[0], rec.calls[5]])
  })

  describe('runItem before any model call', () => {
    let dir
    const seItem = (id, label) => item(id, label, { pr_url: 'https://github.com/r/r/pull/1', base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40) })
    const findings = (decls) => JSON.stringify({ findings: [], declarations: [], summary: { totalDeclarations: decls, removedSurfaceLines: 0 } })
    const ctx = () => ({ options: { mcp: 'replay', keepTemp: false, model: 'sonnet' }, prompts: { mcpBudget: 4 }, settings: {}, filter: '.', caseDir: dir })
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-runitem-'))
      for (const [id, decls] of [['gate', 0], ['poisoned', 2]]) {
        fs.mkdirSync(path.join(dir, 'fixtures', id), { recursive: true })
        fs.writeFileSync(path.join(dir, 'fixtures', id, 'pr-diff.patch'), 'diff\n')
        fs.writeFileSync(path.join(dir, 'fixtures', id, 'lint-findings.json'), findings(decls))
      }
      fs.mkdirSync(path.join(dir, 'recordings'))
      fs.writeFileSync(path.join(dir, 'recordings', 'poisoned.json'), JSON.stringify({ item: 'poisoned', calls: [{ tool: 'ask_redpanda_question', arguments: { question: 'q' }, content: [{ type: 'text', text: SERVER_REFUSAL }], is_error: false }] }))
      useItemsFile(path.join(dir, 'items.json'))
    })
    afterAll(() => {
      useItemsFile(path.join(DIR, 'items.json'))
      fs.rmSync(dir, { recursive: true, force: true })
    })

    test('a closed lint gate is GATE_CLOSED, not a free correct abstention', () => {
      const ev = runItem(seItem('gate', 'no_change'), ctx())
      expect(ev.status).toBe('GATE_CLOSED')
      expect(lib.score([{ item: seItem('gate', 'no_change'), ...ev }]).abstention_recall).toBeNull()
    })

    test('a recording that holds a quota refusal is a harness error in replay', () => {
      const ev = runItem(seItem('poisoned', 'needs_docs'), ctx())
      expect(ev.status).toBe('HARNESS_ERROR')
      expect(ev.notes[0]).toMatch(/refused for its limit; delete it and re-record/)
    })
  })

  test('a merge recording keeps every recorded call and adds only new ones', () => {
    const call = (q, text) => ({ tool: 'ask_redpanda_question', arguments: { question: q, context: 'why' }, content: [{ type: 'text', text }], is_error: false })
    const old = { item: 'x', recorded_at: '2026-01-01', calls: [call('rack awareness', 'A')] }
    const fresh = { item: 'x', recorded_at: '2026-02-01', calls: [call('  Rack   Awareness ', 'B'), call('topic properties', 'C')] }
    const { added, recording } = lib.mergeRecording(old, fresh)
    expect(added).toBe(1)
    expect(recording.calls.map((c) => c.content[0].text)).toEqual(['A', 'C'])
    expect(recording.recorded_at).toBe('2026-02-01')
    expect(recording.merged_from).toEqual(['2026-01-01'])
    expect(lib.mergeRecording(recording, { recorded_at: '2026-03-01', calls: [] }).recording.merged_from).toEqual(['2026-01-01', '2026-02-01'])
  })

  test('a ticket\'s verdict applies only to the PR its description names', () => {
    const pats = refPatterns('redpanda-operator', 7)
    const url = 'https://github.com/redpanda-data/redpanda-operator/pull/7'
    const other = 'https://github.com/redpanda-data/redpanda-operator/pull/6'
    const t = (key, status, resolution, description, comment, labels = ['auto-doc-impact']) => ({ key, status, resolution, labels, description, comments: comment ? [{ body: comment }] : [] })
    const tickets = [
      t('DOC-1', 'Will not implement', null, `Raised for ${url}`),
      t('DOC-2', 'Will not implement', null, `Raised for ${other}`, `Also ${url}`),
      t('DOC-3', 'Done', 'Done', `Raised for ${url}`),
      t('DOC-4', 'Done', "Won't Do", `Raised for ${url}`),
      t('DOC-5', 'Done', 'Duplicate', `Raised for ${url}`),
      t('DOC-6', 'Done', 'Done', `Raised for ${other}`, `Also ${url}`)
    ]
    const { accepted, wni, pendingAuto } = classifyTickets(tickets, pats)
    expect(accepted.map((x) => x.key)).toEqual(['DOC-3'])
    expect(wni.map((x) => x.key)).toEqual(['DOC-1', 'DOC-4'])
    // An accepted ticket this PR was only appended to is untriaged evidence
    // for it, never a verdict; a closed one is neither.
    expect(pendingAuto.map((x) => x.key)).toEqual(['DOC-6'])
  })

  test('items keep the head production last reviewed as provenance', () => {
    const [it] = toItems([candidate('redpanda-operator-1', { reviewed_head_sha: 'd'.repeat(40) })], [])
    expect(it.reviewed_head_sha).toBe('d'.repeat(40))
    expect(toItems([candidate('redpanda-operator-1')], [])[0].reviewed_head_sha).toBeNull()
  })
})

describe('base-prompt runs and the CI delta', () => {
  const { parseArgs, main } = require('../../evals/doc-strings/doc-impact/run')
  const { renderComparison, readSummary } = require('../../evals/doc-strings/doc-impact/compare')
  const YAML = require('yaml')

  test('--workflow reads the prompt from another copy of the review workflow', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-wf-'))
    const copy = path.join(tmp, 'doc-strings-review.yml')
    const text = fs.readFileSync(lib.WORKFLOW_PATH, 'utf8')
    fs.writeFileSync(copy, text.replace('PUBLISHED-CONTENT IMPACT:', 'PUBLISHED-CONTENT IMPACT:\n            BASE-COPY MARKER.'))
    expect(parseArgs(['--workflow', copy]).workflow).toBe(copy)
    expect(parseArgs([]).workflow).toBeNull()
    const p = lib.extractImpactPrompt(lib.loadWorkflow(copy).prompt)
    expect(p.impact).toContain('BASE-COPY MARKER.')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('a base copy without the impact section is a harness error before any model call', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-wf-'))
    const copy = path.join(tmp, 'doc-strings-review.yml')
    fs.writeFileSync(copy, fs.readFileSync(lib.WORKFLOW_PATH, 'utf8').replace('PUBLISHED-CONTENT IMPACT:', 'IMPACT NOTES:'))
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await main(['--workflow', copy])).toBe(2)
      expect(err.mock.calls.flat().join('\n')).toMatch(/HARNESS_ERROR: PUBLISHED-CONTENT IMPACT section not found/)
    } finally {
      err.mockRestore()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  const summary = (over = {}, items = []) => {
    const runs = items.map(([id, label, status, flagged]) => ({ item: item(id, label), status, flagged, pages: [], names: [] }))
    return { model: 'm', mcp: 'replay', include_unconfirmed: true, ...lib.score(runs), items: runs.map((r) => ({ id: r.item.id, status: r.status, notes: [`${r.status} detail`] })), ...over }
  }
  const base = summary({}, [['p1', 'needs_docs', 'OK', true], ['p2', 'needs_docs', 'OK', false], ['n1', 'no_change', 'OK', false], ['g', 'needs_docs', 'GATE_CLOSED', false]])

  test('the delta table, the flipped items, and a clean exit on a score drop', () => {
    const head = summary({}, [['p1', 'needs_docs', 'OK', false], ['p2', 'needs_docs', 'OK', false], ['n1', 'no_change', 'OK', false], ['g', 'needs_docs', 'GATE_CLOSED', false]])
    const r = renderComparison({ head, base, headLabel: 'this PR', baseLabel: 'main' })
    expect(r.errors).toEqual([])
    expect(r.markdown).toContain('| Flag recall F | 50.0% | 0.0% | -50.0 pt |')
    expect(r.markdown).toContain('| Abstention recall A | 100.0% | 100.0% | 0 |')
    expect(r.markdown).toContain('| Headline 2FA/(F+A) | 0.667 | 0.000 | -0.667 |')
    expect(r.markdown).toContain('| GATE_CLOSED | 1 | 1 | 0 |')
    expect(r.markdown).toContain('| `p1` | needs_docs | flagged (correct) | not flagged (wrong) |')
    expect(r.markdown).not.toContain('`p2`')
  })

  test('an item error on either side is an error; an incomplete replay is only a warning', () => {
    const head = summary({}, [['p1', 'needs_docs', 'MODEL_ERROR', false], ['p2', 'needs_docs', 'REPLAY_INCOMPLETE', false], ['n1', 'no_change', 'OK', false]])
    const r = renderComparison({ head, base })
    expect(r.errors).toEqual(['head: p1 MODEL_ERROR: MODEL_ERROR detail'])
    expect(r.warnings.join('\n')).toMatch(/head: 1 item\(s\) REPLAY_INCOMPLETE/)
    expect(r.markdown).toContain('| REPLAY_INCOMPLETE | 0 | 1 | +1 |')
    expect(r.markdown).toContain('| Errors (harness or model) | 0 | 1 | +1 |')
  })

  test('no head summary fails; no base summary shows the head numbers alone', () => {
    expect(renderComparison({ head: null, base }).errors).toHaveLength(1)
    const r = renderComparison({ head: base, base: null })
    expect(r.errors).toEqual([])
    expect(r.markdown).toContain('| Flag recall F | 50.0% |')
    expect(r.markdown).not.toContain('| Delta |')
  })

  test('a non-JSON or empty run output reads as no summary', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-cmp-'))
    fs.writeFileSync(path.join(tmp, 'skipped.json'), 'SKIPPED: the claude CLI is not available on PATH.\n')
    fs.writeFileSync(path.join(tmp, 'empty.json'), '')
    expect(readSummary(path.join(tmp, 'skipped.json'))).toBeNull()
    expect(readSummary(path.join(tmp, 'empty.json'))).toBeNull()
    expect(readSummary(path.join(tmp, 'absent.json'))).toBeNull()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('the CI workflow keeps credentials out of checkouts and the eval step', () => {
    const wf = YAML.parse(fs.readFileSync(path.join(__dirname, '../../.github/workflows/doc-impact-eval.yml'), 'utf8'))
    expect(wf.permissions).toEqual({ contents: 'read' })
    const steps = Object.values(wf.jobs).flatMap((j) => j.steps)
    for (const s of steps.filter((x) => String(x.uses || '').startsWith('actions/checkout@'))) {
      expect(s.with['persist-credentials']).toBe(false)
    }
    const run = wf.jobs.eval.steps.find((s) => s.name === 'Run the replay')
    expect(JSON.stringify(run)).not.toMatch(/secrets\./)
    expect(run.run).toContain('rm -f "$RUNNER_TEMP/gateway-token"')
    expect(wf.jobs.compare.permissions).toEqual({ contents: 'read' })
  })
})
