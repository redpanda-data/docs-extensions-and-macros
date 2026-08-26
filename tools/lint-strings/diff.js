'use strict'

const { spawnSync } = require('child_process')

/**
 * Diff support for declaration-anchored linting.
 *
 * Diff mode never lints hunks directly: descriptions are clang-format-wrapped
 * adjacent string literals, so a PR touching one wrapped line must surface the
 * FULL declaration. The flow is: parse `git diff <base>...HEAD` into changed
 * (post-image) line numbers per file, route each file to a surface by path,
 * extract declarations from those files at HEAD, and keep declarations whose
 * line span intersects the changed lines.
 */

/**
 * Path -> surface routing table. First match wins. A surface routed here
 * without an extractor in the index.js SURFACES registry is reported as
 * not-yet-supported instead of silently dropping the files.
 */
const SURFACE_ROUTES = [
  { surface: 'properties', pattern: /^src\/v\/config\// },
  { surface: 'metrics', pattern: /(^|\/)[^/]*probe\.cc$|^src\/v\/metrics\// },
  { surface: 'rpk', pattern: /^src\/go\/rpk\/pkg\/cli\// },
  // Both chart layouts ship: charts/<name>/chart/values.yaml (redpanda,
  // console) and charts/<name>/values.yaml (connectors).
  { surface: 'helm', pattern: /^charts\/[^/]+\/(chart\/)?values\.yaml$/ },
  { surface: 'crd', pattern: /^operator\/api\// },
  { surface: 'connect', pattern: /^internal\/impl\// }
]

/**
 * Route a repo-relative file path to a surface id, or null when the file is
 * not a doc-string surface.
 */
function routeFile (file) {
  for (const route of SURFACE_ROUTES) {
    if (route.pattern.test(file)) return route.surface
  }
  return null
}

/**
 * Run `git diff <base>...HEAD` in the repo and parse it into a map of
 * file -> Set of changed line numbers in the post-image (HEAD) version.
 * Deleted files (no post-image) are omitted.
 *
 * @param {string} repo - Path to the git checkout
 * @param {string} base - Base ref (`git diff base...HEAD`)
 * @returns {Map<string, Set<number>>}
 */
function getChangedLines (repo, base) {
  const result = spawnSync(
    'git',
    ['diff', '--unified=0', '--no-color', `${base}...HEAD`],
    { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`git diff ${base}...HEAD failed in ${repo}: ${result.stderr || result.stdout}`)
  }
  return parseUnifiedDiff(result.stdout)
}

/**
 * Parse unified diff text (produced with --unified=0) into
 * file -> Set(changed post-image line numbers).
 */
function parseUnifiedDiff (diffText) {
  const changed = new Map()
  let currentFile = null

  for (const line of diffText.split('\n')) {
    // Only git's file headers count: "+++ b/<path>" or "+++ /dev/null".
    // (An added content line that itself starts with "++ " would otherwise
    // look like a header under --unified=0.)
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6).trim()
      continue
    }
    if (line.startsWith('+++ /dev/null')) {
      currentFile = null
      continue
    }
    if (!line.startsWith('@@') || currentFile === null) continue

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (!hunk) continue
    const start = parseInt(hunk[1], 10)
    const count = hunk[2] === undefined ? 1 : parseInt(hunk[2], 10)
    if (count === 0) continue // pure deletion: no post-image lines

    if (!changed.has(currentFile)) changed.set(currentFile, new Set())
    const lines = changed.get(currentFile)
    for (let i = 0; i < count; i++) lines.add(start + i)
  }

  return changed
}

/**
 * Group changed files by surface.
 *
 * @param {Map<string, Set<number>>} changedLines - From getChangedLines
 * @returns {Object} surface -> Map(file -> Set(lines))
 */
function classifyDiff (changedLines) {
  const bySurface = {}
  for (const [file, lines] of changedLines) {
    const surface = routeFile(file)
    if (!surface) continue
    if (!bySurface[surface]) bySurface[surface] = new Map()
    bySurface[surface].set(file, lines)
  }
  return bySurface
}

/**
 * True when the inclusive line span [lineStart, lineEnd] contains at least
 * one changed line.
 */
function spanIntersects (lineStart, lineEnd, lineSet) {
  if (lineStart == null || lineEnd == null || !lineSet) return false
  for (const line of lineSet) {
    if (line >= lineStart && line <= lineEnd) return true
  }
  return false
}

module.exports = {
  SURFACE_ROUTES,
  routeFile,
  getChangedLines,
  parseUnifiedDiff,
  classifyDiff,
  spanIntersects
}
