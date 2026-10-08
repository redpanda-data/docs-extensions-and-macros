'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { MARKER, MAX_ROWS, buildComment, runCli } = require('../../../tools/connect-docs/pr-comment')

const page = (p) => ({ url: `https://docs.redpanda.com/${p}`, sitePath: `${p}index.html`, anchors: [], files: [] })
const diff = (n) => ({
  summary: { files: n, changed: n, added: 0, removed: 0, pages: n },
  pages: Array.from({ length: n }, (_, i) => page(`connect/components/inputs/c${i}/`))
})

describe('connect-docs-check PR comment', () => {
  test('starts with the marker the workflow finds its comment by', () => {
    expect(buildComment({ build: 'pass', diff: diff(1) }).body.startsWith(MARKER)).toBe(true)
  })

  test('links each changed page to production and to the preview', () => {
    const { body, notify } = buildComment({ build: 'pass', diff: diff(1), preview: 'https://connect-pr-9--site.netlify.app/' })
    expect(notify).toBe(true)
    expect(body).toContain('Preview: https://connect-pr-9--site.netlify.app/connect/home/')
    expect(body).toContain('| [/connect/components/inputs/c0/](https://docs.redpanda.com/connect/components/inputs/c0/) | [preview](https://connect-pr-9--site.netlify.app/connect/components/inputs/c0/) |')
  })

  test('without a preview, lists production links only', () => {
    const { body } = buildComment({ build: 'pass', diff: diff(1) })
    expect(body).toContain('| Page |\n|---|')
    expect(body).not.toContain('preview](')
  })

  test('does not notify when nothing published changes and the build passes', () => {
    const { body, notify } = buildComment({ build: 'pass', diff: diff(0) })
    expect(notify).toBe(false)
    expect(body).toContain('doesn\'t change any published Connect docs page')
  })

  test('notifies on a failed build even with no changed pages', () => {
    const { body, notify } = buildComment({ build: 'fail', diff: diff(0) })
    expect(notify).toBe(true)
    expect(body).toContain('**The docs build failed.**')
  })

  test('reports rendered-HTML findings on changed pages and notifies', () => {
    const { body, notify } = buildComment({ build: 'pass', diff: diff(0), htmlFindings: 2 })
    expect(notify).toBe(true)
    expect(body).toContain('**2 rendered-HTML findings on pages this PR changes**')
  })

  test('caps the table and says how many pages are left out', () => {
    const { body } = buildComment({ build: 'pass', diff: diff(MAX_ROWS + 5) })
    expect(body.split('\n').filter((l) => l.startsWith('| [/connect/'))).toHaveLength(MAX_ROWS)
    expect(body).toContain('And 5 more pages.')
  })

  test('says so when there is no merge-base diff', () => {
    const { body, notify } = buildComment({ build: 'pass', diff: null })
    expect(notify).toBe(false)
    expect(body).toContain('merge base was not generated')
  })

  test('CLI writes the body and prints notify', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-comment-'))
    fs.writeFileSync(path.join(dir, 'diff.json'), JSON.stringify(diff(2)))
    const out = path.join(dir, 'comment.md')
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      runCli(['--build', 'pass', '--diff', path.join(dir, 'diff.json'), '--sha', 'abcdef1234567', '--output', out])
      expect(write).toHaveBeenCalledWith('{"notify":true}\n')
    } finally {
      write.mockRestore()
    }
    expect(fs.readFileSync(out, 'utf8')).toContain('Checked at abcdef123.')
  })

  test('CLI rejects a missing build result', () => {
    expect(() => runCli(['--diff', 'x.json'])).toThrow('--build must be pass or fail')
  })
})
