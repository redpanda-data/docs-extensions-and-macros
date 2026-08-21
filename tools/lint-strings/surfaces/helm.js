'use strict'

const fs = require('fs')
const path = require('path')

const { SourceCache } = require('../source-text')
const { parseValuesFile: parseSharedValuesFile } = require('../../../cli-utils/helm-commented-values')

/**
 * Helm surface: helm-docs description comments in chart values.yaml files
 * (charts/<name>/chart/values.yaml, plus charts/<name>/values.yaml for
 * charts without the chart/ subdir).
 *
 * Documentation conventions - the union of what actually ships:
 * - helm-docs: `# -- description` (with plain `# ...` continuation lines)
 *   attaches to the real key DIRECTLY below the comment block; `# @default
 *   -- text`, `# @raw`, and `# @ignored` annotate it.
 * - doc-tools helm-spec (cli-utils/helm-commented-values.js): a `# --`
 *   block directly above a COMMENTED-OUT key documents that key, and
 *   `# @doc full.path -- description` documents any path explicitly.
 *
 * Both conventions are decided by ONE walk, cli-utils/helm-commented-values
 * `parseValuesFile`, which this surface calls with attachRealKeys so it also
 * models helm-docs' own real-key attachment. This file used to hold a
 * byte-identical copy of that module's nine regexes and a near-copy of its
 * state machine, on the stated grounds that "the linter never calls a marker
 * dead that the generator in this repo renders" - which nothing enforced.
 * Sharing the walk is what actually enforces it.
 *
 * A DEAD marker is a `# --` block neither pipeline can attach: one buried
 * inside another commented-out key's subtree (the classic commented-out
 * example block), or one separated from any key by a blank line. Its
 * description silently never ships - that is the error this surface exists
 * to catch.
 *
 * helm-docs output is markdown converted via pandoc, not verbatim AsciiDoc,
 * so the verbatim escaping rules do not apply. Terminal periods are
 * optional prose style here; only capitalization is enforced (via the
 * common starts-lowercase rule).
 */

const CONVENTION = {
  case: 'sentence',
  terminal_period: 'optional',
  verbatim_asciidoc: false
}

/**
 * Parse one values.yaml into lint declarations. Exported for tests.
 *
 * The attachment decisions and the line spans both come from the shared walk;
 * this function only reshapes its records into the linter's declaration form.
 *
 * @param {string} content - File content
 * @param {string} file - Repo-relative path
 * @returns {Array} declarations (without declaration_text)
 */
function parseValuesFile (content, file) {
  return parseSharedValuesFile(content, { attachRealKeys: true }).map((r) => {
    // The generator keeps newlines in a description; helm-docs renders one
    // paragraph, and the rules read one string, so flatten here.
    const string = r.descLines.map((l) => l.trim()).filter(Boolean).join(' ') || null
    let meta
    if (r.kind === 'dead-marker') {
      meta = { kind: 'dead-marker', unverifiable: true }
    } else if (r.undocumented) {
      // Nothing to lint for content: the rule fires on the absence itself.
      meta = { kind: 'key', top_level: true, undocumented: true, unverifiable: true }
    } else if (r.commentedOut) {
      meta = { kind: 'key', commented_out: true, top_level: r.topLevel, default_annotation: r.default || null }
    } else {
      meta = { kind: 'key', top_level: r.topLevel, raw: Boolean(r.annotations.raw), default_annotation: r.default || null }
    }
    return {
      surface: 'helm',
      name: r.kind === 'dead-marker' ? null : r.path,
      file,
      line_start: r.lineStart + 1, // 0-indexed -> 1-indexed
      line_end: r.lineEnd + 1,
      string: r.undocumented ? null : string,
      declaration_text: null,
      convention: CONVENTION,
      meta
    }
  })
}

/**
 * Extract helm declarations.
 *
 * @param {Object} options - { repo, files (Set of repo-relative paths, diff
 *   mode; when omitted, scans charts/<*>/chart/values.yaml and
 *   charts/<*>/values.yaml), log }
 */
function extract ({ repo, files = null }) {
  let fileList
  if (files) {
    fileList = [...files]
  } else {
    fileList = []
    const chartsRoot = path.join(repo, 'charts')
    if (fs.existsSync(chartsRoot)) {
      for (const entry of fs.readdirSync(chartsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        for (const candidate of [
          path.join('charts', entry.name, 'chart', 'values.yaml'),
          path.join('charts', entry.name, 'values.yaml')
        ]) {
          if (fs.existsSync(path.join(repo, candidate))) fileList.push(candidate)
        }
      }
    }
  }

  const cache = new SourceCache(repo)
  const declarations = []
  for (const file of fileList) {
    const absPath = path.isAbsolute(file) ? file : path.join(repo, file)
    if (!fs.existsSync(absPath)) continue
    const content = fs.readFileSync(absPath, 'utf8')
    for (const decl of parseValuesFile(content, file)) {
      decl.declaration_text = cache.span(file, decl.line_start, decl.line_end)
      declarations.push(decl)
    }
  }
  return declarations
}

/** Surface-specific convention rules. */
const RULES = [
  {
    name: 'dead-marker',
    description: 'A # -- marker no docs pipeline can attach to any key',
    severity: 'error',
    runOnUnverifiable: true,
    check: (decl) => {
      if (decl.meta.kind !== 'dead-marker') return []
      return [{ message: 'This "# --" description is buried where neither helm-docs nor the helm-spec commented-values pass can attach it (inside another commented-out key\'s subtree, or separated from any key), so it silently never ships. Move it directly above the key it documents, use "# @doc full.path -- ...", or delete it.' }]
    }
  },
  {
    name: 'undocumented-top-level-key',
    description: 'Top-level user-visible key with no # -- description',
    severity: 'info',
    runOnUnverifiable: true,
    check: (decl) => {
      if (decl.meta.kind !== 'key' || !decl.meta.undocumented) return []
      return [{ message: `Top-level key "${decl.name}" has no "# --" description, so helm-docs ships it undocumented. Add a marker comment directly above it (or "# @ignored" if it is not user-facing).` }]
    }
  }
]

module.exports = {
  name: 'helm',
  convention: CONVENTION,
  extract,
  parseValuesFile,
  rules: RULES
}
