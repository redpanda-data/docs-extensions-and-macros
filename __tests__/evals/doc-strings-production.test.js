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
    expect(args.allowed).toContain('Read')
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
})

describe('doc-strings evals: the must-read check', () => {
  const cwd = '/work/repo'
  const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
  const result = (id, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } })
  const stream = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const comment = (id) => use(id, production.COMMENT_TOOL, { path: 'a.cc', line: 3, body: '```suggestion\nx\n```' })

  test('the production model is an exact id, not an alias', () => {
    expect(production.PRODUCTION_MODEL).toMatch(/^claude-[a-z]+-\d/)
    expect(['opus', 'sonnet', 'haiku']).not.toContain(production.PRODUCTION_MODEL)
  })

  test('parseStream keeps every tool call in order with its result status', () => {
    const { calls, result: r } = production.parseStream(stream([
      use('t1', 'Read', { file_path: 'lint-findings.json' }),
      result('t1'),
      use('t2', 'Read', { file_path: '/work/repo/missing.md' }),
      result('t2', true),
      { type: 'result', subtype: 'success', result: 'done' }
    ]))
    expect(calls.map((c) => [c.index, c.name, c.error])).toEqual([[0, 'Read', false], [1, 'Read', true]])
    expect(r.result).toBe('done')
  })

  test('both standards read before the first inline comment passes, by Read or by the allowed cat', () => {
    const { calls } = production.parseStream(stream([
      use('t1', 'Read', { file_path: 'pr-diff.patch' }), result('t1'),
      use('t2', 'Read', { file_path: '/work/repo/embedded-reference-strings.md' }), result('t2'),
      use('t3', 'Bash', { command: 'cat terminology.md' }), result('t3'),
      comment('t4'), result('t4')
    ]))
    const v = production.checkMustRead(calls, cwd)
    expect(v.pass).toBe(true)
    expect(v.first_comment_index).toBe(3)
    expect(v.files.map((f) => [f.file, f.indices])).toEqual([['embedded-reference-strings.md', [1]], ['terminology.md', [2]]])
  })

  test('a standard that was never opened fails and is named', () => {
    const { calls } = production.parseStream(stream([
      use('t1', 'Read', { file_path: 'embedded-reference-strings.md' }), result('t1'),
      comment('t2'), result('t2')
    ]))
    const v = production.checkMustRead(calls, cwd)
    expect(v.pass).toBe(false)
    expect(v.detail).toMatch(/never read: terminology\.md/)
  })

  test('a standard opened only after the first inline comment fails', () => {
    const { calls } = production.parseStream(stream([
      use('t1', 'Read', { file_path: 'terminology.md' }), result('t1'),
      comment('t2'), result('t2'),
      use('t3', 'Read', { file_path: 'embedded-reference-strings.md' }), result('t3')
    ]))
    const v = production.checkMustRead(calls, cwd)
    expect(v.pass).toBe(false)
    expect(v.detail).toMatch(/read only after the first inline comment \(call #1\): embedded-reference-strings\.md/)
  })

  test('a read that errored, a file of the same name elsewhere, and a shell command that does not name the file do not count', () => {
    const { calls } = production.parseStream(stream([
      use('t1', 'Read', { file_path: 'embedded-reference-strings.md' }), result('t1', true),
      use('t2', 'Read', { file_path: '/elsewhere/terminology.md' }), result('t2'),
      use('t3', 'Bash', { command: 'cat /elsewhere/terminology.md' }), result('t3'),
      use('t4', 'Bash', { command: 'ls -la' }), result('t4')
    ]))
    const v = production.checkMustRead(calls, cwd)
    expect(v.pass).toBe(false)
    expect(v.detail).toMatch(/never read: embedded-reference-strings\.md, terminology\.md/)
  })

  test('a grep or head that names the staged file counts as opening it, and the command is kept as evidence', () => {
    const { calls } = production.parseStream(stream([
      use('t1', 'Bash', { command: `cd ${cwd} && grep -n -i "broker" terminology.md | head -20` }), result('t1'),
      use('t2', 'Bash', { command: `head -40 ${cwd}/embedded-reference-strings.md` }), result('t2')
    ]))
    const v = production.checkMustRead(calls, cwd)
    expect(v.pass).toBe(true)
    expect(v.reads.map((r) => [r.file, r.tool])).toEqual([['terminology.md', 'Bash'], ['embedded-reference-strings.md', 'Bash']])
    expect(v.reads[0].how).toMatch(/grep/)
  })

  test('a Read through a symlinked spelling of the workspace still counts', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'must-read-real-'))
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'must-read-link-')), 'ws')
    fs.symlinkSync(real, link)
    const { calls } = production.parseStream(stream([
      use('t1', 'Read', { file_path: path.join(real, 'embedded-reference-strings.md') }), result('t1'),
      use('t2', 'Read', { file_path: path.join(link, 'terminology.md') }), result('t2')
    ]))
    expect(production.checkMustRead(calls, link).pass).toBe(true)
    expect(production.checkMustRead(calls, real).pass).toBe(true)
    fs.rmSync(real, { recursive: true, force: true })
    fs.rmSync(path.dirname(link), { recursive: true, force: true })
  })

  test('with no inline comment, the reads only have to happen', () => {
    const { calls } = production.parseStream(stream([
      use('t1', 'Read', { file_path: 'embedded-reference-strings.md' }), result('t1'),
      use('t2', 'Read', { file_path: 'terminology.md' }), result('t2')
    ]))
    const v = production.checkMustRead(calls, cwd)
    expect(v.pass).toBe(true)
    expect(v.detail).toMatch(/no inline comment posted/)
  })

  test('the sabotage strips every sentence naming a standard and keeps the rest of the prompt', () => {
    const step = production.loadStep()
    const full = production.renderPrompt(step.with.prompt, { repository: 'a/b', prNumber: 1 })
    const stripped = production.renderPrompt(step.with.prompt, { repository: 'a/b', prNumber: 1 }, { withoutStandards: true })
    for (const name of production.MUST_READ) {
      expect(full).toContain(name)
      expect(stripped).not.toContain(name)
    }
    for (const kept of ['INLINE SUGGESTIONS', 'PROSE QUALITY', 'PUBLISHED-CONTENT IMPACT', 'lint-findings.json', 'pr-diff.patch']) {
      expect(stripped).toContain(kept)
    }
    expect(stripped.length).toBeLessThan(full.length)
  })

  test('the sabotage refuses to run if a file name survives the split', () => {
    // A path-qualified mention is not a sentence the stripper recognises, so
    // the name survives and the guard has to refuse rather than run a weaker
    // sabotage than it claims.
    expect(() => production.stripStandardsInstructions('See docs/terminology.md. Then stop.')).toThrow(/sabotage left terminology\.md/)
  })
})
