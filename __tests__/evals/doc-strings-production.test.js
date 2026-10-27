'use strict'

// The doc-strings evals run the production review prompt straight from
// doc-strings-review.yml (evals/doc-strings/production.js). These tests make
// no model call: they pin the assumptions the eval makes about the workflow
// file, so an edit that would quietly stop the eval from testing what ships
// fails here instead.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const production = require('../../evals/doc-strings/production')
const lib = require('../../evals/doc-strings/lib')

describe('doc-strings evals: production review extraction', () => {
  const step = production.loadStep()

  test('the review step and its prompt are found', () => {
    expect(step.with.prompt.length).toBeGreaterThan(1000)
  })

  test('every Actions expression in the prompt is filled', () => {
    const rendered = production.renderPrompt(step.with.prompt, { repository: 'redpanda-data/redpanda', prNumber: 7 })
    expect(rendered).not.toMatch(/\$\{\{/)
    expect(rendered).toMatch(/PR_NUMBER: 7/)
  })

  test('an expression the eval does not know is an error, not a blank', () => {
    expect(() => production.renderPrompt('x ${{ secrets.TOKEN }}', { repository: 'a', prNumber: 1 })).toThrow(/unfilled/)
  })

  test('the step allows the inline-comment tool the stand-in provides', () => {
    const args = production.parseClaudeArgs(step.with.claude_args)
    expect(args.allowed).toContain('mcp__github_inline_comment__create_inline_comment')
    // The workspace-scoped file rules: the harness stages its inputs at the
    // fixture root and reads both output files back from there.
    expect(args.allowed).toContain('Read(./**)')
    expect(args.allowed).toContain('Edit(./doc-impact.json)')
    expect(args.allowed).toContain('Edit(./review-summary.md)')
    expect(args.maxTurns).toMatch(/^\d+$/)
  })

  test('the files the eval writes are the files the prompt names', () => {
    for (const name of ['lint-findings.json', 'pr-diff.patch', ...Object.keys(production.FETCHED_STANDARDS)]) {
      expect(step.with.prompt).toContain(name)
    }
  })
})

describe('doc-strings evals: the dispatch gate', () => {
  const ok = {
    findings: [{ surface: 'property', name: 'x', change_kind: 'removed', affected_pages: ['https://docs.redpanda.com/a/'], summary: 's' }],
    proposed_ticket: { title: 't', body: '- b' }
  }

  test('the workflow predicate accepts a well-formed file', () => {
    expect(lib.dispatchAccepts(JSON.stringify(ok)).pass).toBe(true)
  })

  test('and rejects a non-docs URL or an empty findings list', () => {
    const bad = JSON.parse(JSON.stringify(ok))
    bad.findings[0].affected_pages = ['http://example.com/']
    expect(lib.dispatchAccepts(JSON.stringify(bad)).pass).toBe(false)
    expect(lib.dispatchAccepts(JSON.stringify({ findings: [] })).pass).toBe(false)
  })

  test('a missing jq is a harness error, not a rejected document', () => {
    const result = spawnSync(process.execPath, ['-e', "require('./evals/doc-strings/lib').dispatchAccepts('{}')"], {
      cwd: lib.REPO_ROOT,
      env: { ...process.env, PATH: '' },
      encoding: 'utf8'
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/spawnSync jq ENOENT/)
  })
})

describe('doc-strings evals: inline-comment stand-in', () => {
  test('speaks MCP over stdio and records each comment', () => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inline-')), 'c.jsonl')
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_inline_comment', arguments: { path: 'a.cc', line: 3, body: 'b' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_inline_comment', arguments: { line: 3 } } }
    ].map((m) => JSON.stringify(m)).join('\n') + '\n'
    const r = spawnSync(process.execPath, [path.join(__dirname, '../../evals/doc-strings/mocks/inline-comment.js')], {
      input, encoding: 'utf8', env: { ...process.env, INLINE_COMMENT_LOG: log }
    })
    const replies = r.stdout.trim().split('\n').map((l) => JSON.parse(l))
    expect(replies.map((x) => x.id)).toEqual([1, 2, 3, 4])
    expect(replies[1].result.tools[0].name).toBe('create_inline_comment')
    expect(replies[3].result.isError).toBe(true)
    const recorded = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(recorded).toEqual([{ path: 'a.cc', line: 3, body: 'b' }])
  })
})

describe('doc-strings evals: the suggestion comment must target the declaration', () => {
  const target = { file: 'src/v/config/configuration.cc', lineStart: 10, lineEnd: 12, fingerprint: '0123456789abcdef' }
  const footer = '<sub>doc-strings-review:fp=0123456789abcdef</sub>'
  const body = (extra = footer) => '```suggestion\n"New text.",\n```\n' + extra
  const good = { path: 'src/v/config/configuration.cc', startLine: 10, line: 12, body: body() }

  test('the right file, range and footer pass, and the recorded range is returned', () => {
    const r = lib.checkSuggestionComment([good], target)
    expect(r.problems).toEqual([])
    expect([r.start, r.end]).toEqual([10, 12])
  })

  test.each([
    ['a wrong path', { ...good, path: 'src/v/config/other.cc' }, /posted on src\/v\/config\/other\.cc/],
    ['a wrong line range', { ...good, startLine: 11, line: 13 }, /lines 11-13, expected 10-12/],
    ['no line at all', { path: good.path, body: good.body }, /no line/],
    ['no fingerprint footer', { ...good, body: body('') }, /lacks the footer/]
  ])('%s fails', (_label, comment, why) => {
    const r = lib.checkSuggestionComment([comment], target)
    expect(r.problems.join('; ')).toMatch(why)
  })

  test('zero or two suggestion comments fail', () => {
    expect(lib.checkSuggestionComment([], target).problems.join()).toMatch(/found 0/)
    expect(lib.checkSuggestionComment([good, good], target).problems.join()).toMatch(/found 2/)
  })

  test('the mock inline-comment tool rejects a call with no line and logs only a full one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-'))
    const log = path.join(dir, 'log.jsonl')
    const call = (id, args) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'create_inline_comment', arguments: args } })
    const r = spawnSync(process.execPath, [path.join(__dirname, '../../evals/doc-strings/mocks/inline-comment.js')], {
      input: [call(1, { path: 'a.cc', body: 'x' }), call(2, { path: 'a.cc', body: 'y', line: 3 })].join('\n') + '\n',
      env: { ...process.env, INLINE_COMMENT_LOG: log },
      encoding: 'utf8'
    })
    const replies = r.stdout.trim().split('\n').map((l) => JSON.parse(l))
    expect(replies[0].result.isError).toBe(true)
    expect(replies[1].result.isError).toBeUndefined()
    const logged = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(logged).toEqual([{ path: 'a.cc', body: 'y', line: 3 }])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a production review that never ran is a harness error, never a model failure', () => {
    const runEvals = require('../../evals/doc-strings/run-evals')
    const checks = runEvals.makeChecks()
    const harness = runEvals.modelCallFailed(checks, { failed: true, harness: true, stderr: 'could not fetch terminology.md' })
    expect(harness.status).toBe('HARNESS_ERROR')
    const model = runEvals.modelCallFailed(runEvals.makeChecks(), { failed: true, timedOut: false, status: 1, stderr: 'boom' })
    expect(model.status).toBe('FAIL')
  })
})

describe('doc-strings evals: the must-read check', () => {
  // A workspace with the two staged files on disk: the check grades what each
  // tool result showed the model against these, line by line.
  let ws
  const STD = Array.from({ length: 325 }, (_, i) => `standard line ${i + 1}`)
  const TERM = Array.from({ length: 199 }, (_, i) => `term ${i + 1}`)
  const STD_PATH = () => path.join(ws, 'embedded-reference-strings.md')
  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'must-read-ws-'))
    fs.writeFileSync(path.join(ws, 'embedded-reference-strings.md'), STD.join('\n') + '\n')
    fs.writeFileSync(path.join(ws, 'terminology.md'), TERM.join('\n') + '\n')
  })
  afterAll(() => fs.rmSync(ws, { recursive: true, force: true }))

  // Read output as the CLI prints it (checked against Claude Code 2.1.310):
  // "<n>\t<line>", one per line, from the requested offset.
  const numbered = (lines, from = 1) => lines.map((l, i) => `${from + i}\t${l}`).join('\n')
  const use = (id, name, input, extra = {}) => ({ type: 'assistant', ...extra, message: { content: [{ type: 'tool_use', id, name, input }] } })
  const turn = (...blocks) => ({ type: 'assistant', message: { content: blocks.map(([id, name, input]) => ({ type: 'tool_use', id, name, input })) } })
  const result = (id, content = '', isError = false, extra = {}) => ({ type: 'user', ...extra, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } })
  const stream = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const comment = (id) => use(id, production.COMMENT_TOOL, { path: 'a.cc', line: 3, body: '```suggestion\nx\n```' })
  const posted = (id) => result(id, 'Inline comment recorded')
  const readStd = (id) => [use(id, 'Read', { file_path: STD_PATH() }), result(id, numbered(STD))]
  const readTerm = (id) => [use(id, 'Read', { file_path: path.join(ws, 'terminology.md') }), result(id, numbered(TERM))]
  const verdict = (events) => production.checkMustRead(production.parseStream(stream(events)).calls, ws)

  test('the production model is an exact id, not an alias', () => {
    expect(production.PRODUCTION_MODEL).toMatch(/^claude-[a-z]+-\d/)
    expect(['opus', 'sonnet', 'haiku']).not.toContain(production.PRODUCTION_MODEL)
  })

  test('parseStream keeps every call in order with when its result arrived, its output, and whether it got one', () => {
    const { calls, result: r, events } = production.parseStream(stream([
      use('t1', 'Read', { file_path: 'lint-findings.json' }),
      result('t1', [{ type: 'text', text: '1\t{}' }]),
      use('t2', 'Read', { file_path: '/work/repo/missing.md' }),
      result('t2', 'File does not exist.', true),
      use('t3', 'Bash', { command: 'cat terminology.md' }),
      { type: 'result', subtype: 'success', result: 'done' }
    ]))
    expect(calls.map((c) => [c.index, c.name, c.answered, c.error, c.output])).toEqual([
      [0, 'Read', true, false, '1\t{}'], [1, 'Read', true, true, 'File does not exist.'], [2, 'Bash', false, false, '']
    ])
    expect(calls[0].resultSeq).toBeGreaterThan(calls[0].seq)
    expect(r.result).toBe('done')
    expect(events).toBe(6)
    expect(production.parseStream('not json\n').events).toBe(0)
  })

  test('both standards shown in full before the first comment pass, by Read or by cat', () => {
    const v = verdict([
      ...readStd('t1'),
      use('t2', 'Bash', { command: 'cat terminology.md' }), result('t2', TERM.join('\n')),
      comment('t3'), posted('t3')
    ])
    expect(v.pass).toBe(true)
    expect(v.first_comment_index).toBe(2)
    expect(v.files.map((f) => [f.file, f.indices])).toEqual([['embedded-reference-strings.md', [0]], ['terminology.md', [1]]])
  })

  test('a standard that was never opened fails and is named', () => {
    const v = verdict([...readStd('t1'), comment('t2'), posted('t2')])
    expect(v.pass).toBe(false)
    expect(v.detail).toMatch(/never read: terminology\.md/)
  })

  test('a standard opened only after the first comment fails', () => {
    const v = verdict([...readTerm('t1'), comment('t2'), posted('t2'), ...readStd('t3')])
    expect(v.pass).toBe(false)
    expect(v.detail).toMatch(/read only after the first inline comment \(call #1\): embedded-reference-strings\.md/)
  })

  test('reads issued in the same turn as the comment do not count: their results arrived after it was written', () => {
    // Negative control for the ordering: the same three calls in two turns,
    // with the reads' results back before the comment is issued, pass.
    const sameTurn = verdict([
      turn(['t1', 'Read', { file_path: STD_PATH() }], ['t2', 'Read', { file_path: path.join(ws, 'terminology.md') }], ['t3', production.COMMENT_TOOL, { path: 'a.cc', line: 3, body: 'x' }]),
      result('t1', numbered(STD)), result('t2', numbered(TERM)), posted('t3')
    ])
    expect(sameTurn.pass).toBe(false)
    expect(sameTurn.detail).toMatch(/read only after the first inline comment \(call #2\): embedded-reference-strings\.md, terminology\.md/)

    const earlierTurn = verdict([
      turn(['t1', 'Read', { file_path: STD_PATH() }], ['t2', 'Read', { file_path: path.join(ws, 'terminology.md') }]),
      result('t1', numbered(STD)), result('t2', numbered(TERM)),
      comment('t3'), posted('t3')
    ])
    expect(earlierTurn.pass).toBe(true)
  })

  test('a rejected comment sets no deadline; the first accepted one does', () => {
    const v = verdict([
      comment('t1'), result('t1', 'path, body and line are required', true),
      ...readStd('t2'), ...readTerm('t3'),
      comment('t4'), posted('t4')
    ])
    expect(v.pass).toBe(true)
    expect(v.first_comment_index).toBe(3)
    // Control: the same rejected-first stream with the reads after the
    // accepted comment still fails.
    const late = verdict([comment('t1'), result('t1', 'bad', true), comment('t2'), posted('t2'), ...readStd('t3'), ...readTerm('t4')])
    expect(late.pass).toBe(false)
    expect(late.first_comment_index).toBe(1)
  })

  test('a read that never got a result does not count, and is reported as such', () => {
    const v = verdict([
      use('t1', 'Read', { file_path: STD_PATH() }),
      use('t2', 'Read', { file_path: path.join(ws, 'terminology.md') })
    ])
    expect(v.pass).toBe(false)
    expect(v.detail).toMatch(/read never got a result: embedded-reference-strings\.md \(#0\), terminology\.md \(#1\)/)
  })

  test('a read that errored is reported as errored, not as never read', () => {
    const v = verdict([
      use('t1', 'Read', { file_path: STD_PATH() }), result('t1', 'File content (40000 tokens) exceeds maximum allowed tokens', true),
      ...readTerm('t2')
    ])
    expect(v.pass).toBe(false)
    expect(v.detail).toMatch(/every read errored: embedded-reference-strings\.md \(#0\)/)
    expect(v.detail).not.toMatch(/never read/)
  })

  test('a cat the model saw counts even when a later command in the chain failed the call', () => {
    const v = verdict([
      ...readStd('t1'),
      use('t2', 'Bash', { command: 'cat terminology.md && grep -q nothing lint-findings.json' }), result('t2', TERM.join('\n'), true)
    ])
    expect(v.pass).toBe(true)
  })

  test('output that never reached the model in full does not count: piped, captured, or truncated', () => {
    const v = verdict([
      ...readStd('t1'),
      use('t2', 'Bash', { command: '(cat embedded-reference-strings.md terminology.md) | head -5' }), result('t2', STD.slice(0, 5).join('\n')),
      use('t3', 'Bash', { command: 'x=$(cat terminology.md)' }), result('t3', ''),
      use('t4', 'Bash', { command: 'cat embedded-reference-strings.md terminology.md' }),
      result('t4', STD.join('\n') + '\n' + TERM.slice(0, 120).join('\n') + '\n\n... [output truncated]')
    ])
    expect(v.pass).toBe(false)
    const term = v.files.find((f) => f.file === 'terminology.md')
    expect(term).toMatchObject({ read: false, partial_indices: [1, 2, 3] })
    expect(v.detail).toMatch(/read only in part: terminology\.md/)
    // The untruncated cat of both credits both.
    expect(verdict([use('t1', 'Bash', { command: 'cat embedded-reference-strings.md terminology.md' }), result('t1', STD.join('\n') + '\n' + TERM.join('\n'))]).pass).toBe(true)
  })

  test('grep and head show part of a file; a command that only names it shows none', () => {
    const v = verdict([
      use('t1', 'Bash', { command: 'grep -n broker terminology.md | head -20' }), result('t1', '12:term 12'),
      use('t2', 'Bash', { command: 'head -40 embedded-reference-strings.md' }), result('t2', STD.slice(0, 40).join('\n')),
      use('t3', 'Bash', { command: 'wc -l embedded-reference-strings.md terminology.md' }), result('t3', '325 embedded-reference-strings.md\n199 terminology.md')
    ])
    expect(v.pass).toBe(false)
    expect(v.files.map((f) => [f.file, f.indices, f.partial_indices])).toEqual([['embedded-reference-strings.md', [], [1, 2]], ['terminology.md', [], [0, 2]]])
  })

  test('a file of the same name elsewhere does not count, by Read path or by content', () => {
    const v = verdict([
      use('t1', 'Read', { file_path: '/elsewhere/terminology.md' }), result('t1', numbered(TERM)),
      use('t2', 'Bash', { command: 'cd /tmp/other && cat embedded-reference-strings.md' }), result('t2', 'a different file\nwith other text')
    ])
    expect(v.pass).toBe(false)
    expect(v.files.every((f) => !f.read)).toBe(true)
  })

  test('ranged Reads that together cover a file count; one that stops short does not', () => {
    const paged = verdict([
      use('t1', 'Read', { file_path: STD_PATH(), offset: 1, limit: 200 }), result('t1', numbered(STD.slice(0, 200))),
      use('t2', 'Read', { file_path: STD_PATH(), offset: 201, limit: 200 }), result('t2', numbered(STD.slice(200), 201)),
      ...readTerm('t3')
    ])
    expect(paged.pass).toBe(true)
    const short = verdict([
      use('t1', 'Read', { file_path: STD_PATH(), limit: 100 }), result('t1', numbered(STD.slice(0, 100))),
      ...readTerm('t2'), comment('t3'), posted('t3')
    ])
    expect(short.pass).toBe(false)
    expect(short.detail).toMatch(/read only in part: embedded-reference-strings\.md \(100 of 325 lines shown; #0 Read/)
  })

  test('a Read result whose lines do not match the staged file is not credited', () => {
    const v = verdict([
      use('t1', 'Read', { file_path: STD_PATH() }), result('t1', numbered(STD.map((l) => l + ' edited'))),
      ...readTerm('t2')
    ])
    expect(v.pass).toBe(false)
  })

  test('a Read through a symlinked spelling of the workspace still counts', () => {
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'must-read-link-')), 'ws')
    fs.symlinkSync(ws, link)
    const { calls } = production.parseStream(stream([
      use('t1', 'Read', { file_path: path.join(link, 'embedded-reference-strings.md') }), result('t1', numbered(STD)),
      ...readTerm('t2')
    ]))
    expect(production.checkMustRead(calls, link).pass).toBe(true)
    expect(production.checkMustRead(calls, ws).pass).toBe(true)
    fs.rmSync(path.dirname(link), { recursive: true, force: true })
  })

  test('reads a subagent made are not credited to the reviewer', () => {
    const sub = { parent_tool_use_id: 'task1' }
    const v = verdict([
      use('task1', 'Task', { prompt: 'read the standards' }),
      use('t1', 'Read', { file_path: STD_PATH() }, sub), result('t1', numbered(STD), false, sub),
      use('t2', 'Read', { file_path: path.join(ws, 'terminology.md') }, sub), result('t2', numbered(TERM), false, sub),
      result('task1', 'Both files say to use sentence case.')
    ])
    expect(v.pass).toBe(false)
    expect(v.detail).toMatch(/never read: embedded-reference-strings\.md, terminology\.md/)
  })

  test('with no inline comment, the reads only have to happen', () => {
    const v = verdict([...readStd('t1'), ...readTerm('t2')])
    expect(v.pass).toBe(true)
    expect(v.detail).toMatch(/no inline comment posted/)
  })

  test('the sabotage strips every sentence naming a standard, leaves no dangling reference, and keeps the rest', () => {
    const step = production.loadStep()
    const full = production.renderPrompt(step.with.prompt, { repository: 'a/b', prNumber: 1 })
    const stripped = production.renderPrompt(step.with.prompt, { repository: 'a/b', prNumber: 1 }, { withoutStandards: true })
    for (const name of production.MUST_READ) {
      expect(full).toContain(name)
      expect(stripped).not.toContain(name)
    }
    for (const kept of ['INLINE SUGGESTIONS', 'PROSE QUALITY', 'PUBLISHED-CONTENT IMPACT', 'lint-findings.json', 'pr-diff.patch', 'here for the published-content check alone.']) {
      expect(stripped).toContain(kept)
    }
    expect(stripped).not.toMatch(/If it is\s+absent or empty/)
    expect(stripped).not.toMatch(/writing\s+standard's\s+quality\s+bar/)
    expect(stripped.length).toBeLessThan(full.length)
  })

  test('the sabotage removes only the naming sentence, not the list item or line after it', () => {
    const out = production.stripStandardsInstructions('Do this first.\nCheck terminology.md for terms?\n- keep this bullet\nRules:\n- and this one\nRead embedded-reference-strings.md:\n- this bullet stays\nLast line.')
    expect(out).toContain('- keep this bullet')
    expect(out).toContain('Rules:\n- and this one')
    expect(out).toContain('- this bullet stays')
    expect(out).toContain('Do this first.')
    expect(out).not.toMatch(/terminology\.md|embedded-reference-strings\.md/)
  })

  test('the sabotage refuses to run if a file name survives the split', () => {
    // A path-qualified mention is not a sentence the stripper recognises, so
    // the name survives and the guard has to refuse rather than run a weaker
    // sabotage than it claims.
    expect(() => production.stripStandardsInstructions('See docs/terminology.md. Then stop.')).toThrow(/sabotage left terminology\.md/)
  })

  test('a removed span must be one unit: a second sentence, a later list item or a blank line is refused', () => {
    // The guard behind the splitter, so a splitter regression cannot quietly
    // widen the sabotage.
    expect(() => production.assertOneUnit('\n- read terminology.md before you start')).not.toThrow()
    expect(() => production.assertOneUnit(' Read terminology.md first.')).not.toThrow()
    expect(() => production.assertOneUnit(' Read terminology.md first. Then stop.')).toThrow(/more than one sentence/)
    expect(() => production.assertOneUnit(' Read terminology.md\n- and this bullet')).toThrow(/more than one sentence/)
    expect(() => production.assertOneUnit(' Read terminology.md\n\nNext paragraph')).toThrow(/more than one sentence/)
  })
})

describe('doc-strings evals: the must-read sabotage verdict and flags', () => {
  const runEvals = require('../../evals/doc-strings/run-evals')
  const row = (pass) => ({ check: 'must-read: standards opened before the first inline comment', pass, detail: pass ? 'ok' : 'never read: terminology.md; tool calls: []' })
  const run = (baseline, pass) => ({ baseline, sabotage_must_read: !baseline, checks: [row(pass)] })

  test('proven only when the baseline passes the row and the stripped run fails it', () => {
    expect(runEvals.mustReadSabotageVerdict([run(true, true), run(false, false)]).proven).toBe(true)
    // A case that already fails the row on the unmodified prompt (or a check
    // that always fails) proves nothing.
    const already = runEvals.mustReadSabotageVerdict([run(true, false), run(false, false)])
    expect(already.proven).toBe(false)
    expect(already.message).toMatch(/baseline run on the unmodified prompt already fails/)
    expect(runEvals.mustReadSabotageVerdict([run(true, true), run(false, true)]).proven).toBe(false)
    expect(runEvals.mustReadSabotageVerdict([run(false, false)]).proven).toBe(false)
  })

  test('a flag that lost its value, or --case with a sabotage, is a usage error', () => {
    expect(() => runEvals.parseArgs(['--sabotage-must-read'])).toThrow(/needs a value/)
    expect(() => runEvals.parseArgs(['--sabotage-must-read', '--keep-temp'])).toThrow(/needs a value/)
    expect(() => runEvals.parseArgs(['--case', 'a', '--sabotage-must-read', 'b'])).toThrow(/cannot be combined/)
    expect(() => runEvals.parseArgs(['--sabotage', 'a', '--sabotage-must-read', 'b'])).toThrow(/exclusive/)
    expect(runEvals.parseArgs(['--sabotage-must-read', 'b', '--keep-temp'])).toMatchObject({ sabotageMustRead: 'b', keepTemp: true })
  })
})

describe('doc-strings evals: sabotage driver exit codes', () => {
  test.each(['--sabotage', '--sabotage-must-read'].flatMap((flag) =>
    [false, true, undefined].map((cliPass) => [flag, cliPass])
  ))('%s with CLI success check %s', (flag, cliPass) => {
    const filename = path.join(__dirname, '../../evals/doc-strings/run-evals.js')
    const localRequire = require('module').createRequire(filename)
    const exit = new Error('driver exited')
    let exitCode
    let output = ''
    // Run the real driver with synthetic executor results and no disk writes
    // or model calls. Both modes must reject CLI failures before grading proof.
    const context = {
      __dirname: path.dirname(filename),
      module: { exports: {} },
      require (name) {
        if (name === 'fs') return { mkdirSync () {}, mkdtempSync: () => '/synthetic-workdir', writeFileSync () {}, rmSync () {} }
        if (name === './lib') return { ...lib, claudeAvailable: () => true }
        if (name === './cases') return { CASES: [{ id: 'negative', kind: 'negative-review', sabotageEdits: [] }] }
        return localRequire(name)
      },
      process: {
        argv: ['node', filename, flag, 'negative'],
        cwd: () => lib.REPO_ROOT,
        stdout: { write: (text) => { output += text } },
        exit (code) { exitCode = code; throw exit }
      }
    }
    require('vm').runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename })
    let calls = 0
    context.module.exports.EXECUTORS['negative-review'] = () => ({
      status: 'FAIL',
      checks: [
        { check: 'must-read: standards opened before the first inline comment', pass: calls++ === 0, detail: 'synthetic evidence' },
        ...(cliPass === undefined ? [] : [{ check: 'claude CLI call succeeded', pass: cliPass, detail: 'synthetic CLI result' }])
      ],
      model: null
    })
    expect(() => context.main()).toThrow(exit)
    expect(exitCode).toBe(cliPass === false ? 2 : 0)
    expect(output).toContain(cliPass === false ? 'SABOTAGE NOT RUN' : 'SABOTAGE PROVEN')
  })
})
