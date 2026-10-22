'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { detectUserFacingChanges } = require('../../../tools/user-facing-changes')

/**
 * Build a real unified diff between two versions of a set of files, with
 * git's own headers, so the detectors are exercised on exactly the text
 * `git diff` would hand them. `base` and `head` map repo-relative paths to
 * file text; a path missing from one side is an added or deleted file.
 */
function makeDiff (base, head, { context = 3 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-diff-'))
  for (const [side, files] of [['a', base], ['b', head]]) {
    for (const [p, text] of Object.entries(files)) {
      const full = path.join(dir, side, p)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, text)
    }
    fs.mkdirSync(path.join(dir, side), { recursive: true })
  }
  // --no-prefix: with --no-index git would print a/a/<path>; the temp
  // directories are named a and b so the headers come out as git's usual
  // `a/<path>` and `b/<path>`.
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-color', '--no-prefix', `-U${context}`, 'a', 'b'], { cwd: dir, encoding: 'utf8' })
  fs.rmSync(dir, { recursive: true, force: true })
  if (r.status !== 0 && r.status !== 1) throw new Error(`git diff --no-index failed: ${r.stderr}`)
  // For a file on one side only, --no-index names that side twice
  // (`diff --git b/x b/x`); in-repo git always writes `a/x b/x`.
  return r.stdout.replace(/^diff --git [ab]\/(.+) [ab]\/\1$/gm, 'diff --git a/$1 b/$1')
}

/**
 * Run the detectors over base -> head. `whole: true` (default) hands them
 * the whole files, as the workflow does with a checkout; `whole: false`
 * leaves them the hunks alone, as `--patch` without `--repo` does.
 */
function detect (base, head, { whole = true, context = 3, detectors = null } = {}) {
  const diff = makeDiff(base, head, { context })
  const opts = { detectors }
  if (whole) {
    opts.readBase = (p) => (p in base ? base[p] : null)
    opts.readHead = (p) => (p in head ? head[p] : null)
    opts.listHead = (dir) => Object.keys(head).filter((p) => path.posix.dirname(p) === dir)
  }
  return detectUserFacingChanges(diff, opts)
}

const kinds = (result) => result.findings.map((f) => [f.change_kind, f.name])

module.exports = { makeDiff, detect, kinds }
