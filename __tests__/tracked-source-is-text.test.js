'use strict'

const path = require('path')
const { execFileSync } = require('child_process')
const fs = require('fs')

/**
 * No tracked source file may contain a NUL byte.
 *
 * tools/overrides-audit/classify.js shipped with a raw 0x00 as a hash
 * separator, which made the whole file binary as far as POSIX text tools are
 * concerned: `grep contentHash` on it returned nothing and exited 1, so the
 * file was invisible to code search while `git diff` still rendered it as
 * text (git's binary heuristic only sniffs the first 8000 bytes, and the NUL
 * sat at 8573). Beyond the search blindness, any formatter or editor
 * round-trip that sanitizes control characters would have silently changed
 * every content_hash and broken the cross-run dedup manifest the upstream
 * workflow relies on.
 *
 * This is the check that stops it recurring, rather than a note asking people
 * to remember.
 */

const REPO_ROOT = path.join(__dirname, '..')

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.json', '.py', '.sh', '.yml', '.yaml',
  '.adoc', '.md', '.txt', '.hbs', '.html', '.css', '.h', '.cc', '.go', '.proto'
])

function trackedTextFiles () {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\0').filter((f) => {
    if (!f) return false
    const base = path.basename(f)
    return TEXT_EXTENSIONS.has(path.extname(f)) || base === 'Makefile' || base.startsWith('.gitignore')
  })
}

describe('tracked source files stay text', () => {
  const files = trackedTextFiles()

  test('the file list is not empty', () => {
    // Guard the guard: a broken `git ls-files` would make the sweep vacuous.
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain('tools/overrides-audit/classify.js')
  })

  test('no tracked source file contains a NUL byte', () => {
    const offenders = []
    for (const file of files) {
      const abs = path.join(REPO_ROOT, file)
      if (!fs.existsSync(abs)) continue
      const buf = fs.readFileSync(abs)
      const at = buf.indexOf(0)
      if (at !== -1) {
        const line = buf.subarray(0, at).toString('utf8').split('\n').length
        offenders.push(`${file}:${line}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
