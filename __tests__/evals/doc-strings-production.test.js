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

describe('doc-strings evals: unchanged-lines check', () => {
  const decl = { file: 'cmd.go', line_start: 10, line_end: 20 }
  const keep = ['An untouched line.', 'Another untouched line.']
  const comment = (body, line = 20, startLine = 10) => ({ path: 'cmd.go', body, line, startLine })

  test('a suggestion that keeps every unchanged line passes', () => {
    const r = lib.linesKept([comment('```suggestion\nAn untouched line.\nA changed line, fixed.\nAnother untouched line.\n```')], decl, keep)
    expect(r).toEqual({ pass: true, judged: 1, dropped: [] })
  })

  test('a suggestion that rewords an unchanged line fails and names it', () => {
    const r = lib.linesKept([comment('```suggestion\nAn untouched line, improved.\nAnother untouched line.\n```')], decl, keep)
    expect(r.pass).toBe(false)
    expect(r.dropped).toEqual(['An untouched line.'])
  })

  test('plain comments and comments on other spans are not judged', () => {
    const r = lib.linesKept([
      comment('Reads oddly, no suggestion.'),
      comment('```suggestion\nunrelated\n```', 40, 38),
      { path: 'other.go', body: '```suggestion\nunrelated\n```', line: 15 }
    ], decl, keep)
    expect(r).toEqual({ pass: true, judged: 0, dropped: [] })
  })

  test('changedLines reads post-image line numbers from git', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dse-changed-'))
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb\nc\nd\n')
    const base = lib.gitInit(dir)
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nB\nc\nd\ne\n')
    lib.gitCommitAll(dir, 'edit')
    expect([...lib.changedLines(dir, base, 'f.txt')].sort()).toEqual([2, 5])
  })
})

describe('doc-strings evals: prompt controls', () => {
  const { CASES } = require('../../evals/doc-strings/cases')

  // A control that silently ran the unchanged prompt would prove nothing,
  // so each control edit must match the shipped prompt exactly once.
  test.each(CASES.filter((c) => c.sabotagePromptEdits).map((c) => [c.id, c]))('%s: its control edit applies to the shipped prompt', (_, spec) => {
    const prompt = production.loadStep().with.prompt
    const edited = production.editPrompt(prompt, spec.sabotagePromptEdits)
    expect(edited).not.toBe(prompt)
  })

  test('an edit that does not match is an error', () => {
    expect(() => production.editPrompt('text', [{ find: 'absent', replace: 'x' }])).toThrow(/must match once/)
  })
})
