'use strict'

const fs = require('fs')
const path = require('path')

const { SourceCache } = require('../source-text')

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
 *   `# @doc full.path -- description` documents any path explicitly. This
 *   parser mirrors that module's state machine (candidate selection,
 *   effective indent folding, subtree suppression) so the linter never
 *   calls a marker dead that the generator in this repo renders.
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

// Regexes mirrored from cli-utils/helm-commented-values.js.
const COMMENTED_KEY_RE = /^(\s*)#(\s{0,4})([a-z][A-Za-z0-9_-]*):\s*(.*)$/
const REAL_KEY_RE = /^(\s*)([A-Za-z0-9_."/-]+):(.*)$/
const DESC_MARKER_RE = /^\s*#\s*--\s*(?!-)(.*)$/
const AT_DOC_RE = /^\s*#\s*@doc\s+([A-Za-z0-9_./-]+)\s+--\s*(.*)$/
const AT_DEFAULT_RE = /^\s*#\s*@default\s+--\s*(.*)$/
const AT_WORD_RE = /^\s*#\s*@(\w+)\s*$/
const COMMENT_RE = /^\s*#\s?(.*)$/
const BLOCK_SCALAR_RE = /[|>][0-9]?[+-]?[0-9]?\s*(#.*)?$/
const LIST_ITEM_RE = /^\s*-\s/

/**
 * Parse one values.yaml. Exported for tests.
 *
 * @param {string} content - File content
 * @param {string} file - Repo-relative path
 * @returns {Array} declarations (without declaration_text)
 */
function parseValuesFile (content, file) {
  const declarations = []
  const lines = content.split('\n')
  const stack = [] // enclosing real keys: { name, indent }

  let block = null // { markerLine, lastLine, descLines, annotations, candidate }
  let atDoc = null // { line, lastLine, path, descLines, annotations }
  let skipScalarIndent = -1
  let suppressInnerIndent = -1
  let looseIgnored = false // bare `# @ignored` with no `# --` block above a key

  const decl = (name, string, lineStart, lineEnd, meta) => ({
    surface: 'helm',
    name,
    file,
    line_start: lineStart + 1, // 0-indexed -> 1-indexed
    line_end: lineEnd + 1,
    string,
    declaration_text: null,
    convention: CONVENTION,
    meta
  })

  const emitDead = (b) => {
    declarations.push(decl(null, b.descLines.join(' ').trim() || null, b.markerLine, b.lastLine, {
      kind: 'dead-marker',
      unverifiable: true
    }))
  }

  const flushAtDoc = () => {
    if (!atDoc) return
    declarations.push(decl(atDoc.path, atDoc.descLines.join(' ').trim() || null, atDoc.line, atDoc.lastLine, {
      kind: 'key',
      commented_out: true,
      top_level: !atDoc.path.includes('.'),
      default_annotation: atDoc.annotations.default || null
    }))
    atDoc = null
  }

  // Emit the active block's candidate (a documented commented-out key), or
  // record the block as dead when it has none. Mirrors flushBlock in
  // helm-commented-values.js, with dead blocks surfaced instead of dropped.
  const flushBlock = () => {
    if (!block) return
    if (block.candidate) {
      const { name, effIndent } = block.candidate
      const parents = stack.filter((k) => k.indent < effIndent).map((k) => k.name)
      declarations.push(decl([...parents, name].join('.'), block.descLines.join(' ').trim() || null,
        block.markerLine, block.lastLine, {
          kind: 'key',
          commented_out: true,
          top_level: parents.length === 0,
          default_annotation: block.annotations.default || null
        }))
      suppressInnerIndent = effIndent
    } else {
      emitDead(block)
    }
    block = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (skipScalarIndent >= 0) {
      const indent = line.match(/^\s*/)[0].length
      if (line.trim() === '' || indent > skipScalarIndent) continue
      skipScalarIndent = -1
    }

    const atDocMatch = line.match(AT_DOC_RE)
    if (atDocMatch) {
      flushAtDoc()
      flushBlock()
      atDoc = { line: i, lastLine: i, path: atDocMatch[1], descLines: [atDocMatch[2]], annotations: {} }
      continue
    }

    const atDefault = line.match(AT_DEFAULT_RE)
    if (atDefault) {
      if (atDoc) { atDoc.annotations.default = atDefault[1].trim(); atDoc.lastLine = i }
      else if (block) { block.annotations.default = atDefault[1].trim(); block.lastLine = i }
      continue
    }

    const atWord = line.match(AT_WORD_RE)
    if (atWord) {
      if (block) { block.annotations[atWord[1]] = true; block.lastLine = i }
      else if (atWord[1] === 'ignored') looseIgnored = true
      continue
    }

    const commentedKey = line.match(COMMENTED_KEY_RE)
    if (commentedKey) {
      flushAtDoc()
      // Fold indentation on both sides of the "#" into one depth (the space
      // separating "#" from its text is punctuation, not indentation).
      const effIndent = commentedKey[1].length + Math.max(0, commentedKey[2].length - 1)
      // A previously emitted commented key suppresses its own subtree: a
      // marker in there is documentation neither pipeline ever renders.
      if (suppressInnerIndent >= 0 && effIndent > suppressInnerIndent) {
        if (block) emitDead(block)
        block = null
        continue
      }
      suppressInnerIndent = -1
      const value = commentedKey[4].trim()
      const simpleValue = (value === '' || !/\s/.test(value)) && !value.startsWith('/')
      if (block && simpleValue) {
        if (!block.candidate || effIndent <= block.candidate.effIndent) {
          block.candidate = { name: commentedKey[3], effIndent }
        }
        block.lastLine = i
        continue
      }
    }

    const descMarker = line.match(DESC_MARKER_RE)
    if (descMarker) {
      flushAtDoc()
      flushBlock()
      block = { markerLine: i, lastLine: i, descLines: [descMarker[1]], annotations: {}, candidate: null }
      continue
    }

    const comment = line.match(COMMENT_RE)
    if (comment && line.trim().startsWith('#')) {
      if (atDoc) { atDoc.descLines.push(comment[1]); atDoc.lastLine = i }
      else if (block && !block.candidate) {
        if (comment[1].trim() !== '') block.descLines.push(comment[1].trim())
        block.lastLine = i
      } else if (block) {
        block.lastLine = i
      }
      continue
    }

    // Non-comment line.
    flushAtDoc()

    const realKey = line.match(REAL_KEY_RE)
    if (realKey && block && !block.candidate && block.lastLine === i - 1) {
      // helm-docs attachment: the block sits DIRECTLY above a real key.
      const indent = realKey[1].length
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
      const name = realKey[2].replace(/^"|"$/g, '')
      const keyPath = [...stack.map((k) => k.name), name].join('.')
      stack.push({ name, indent })
      if (!block.annotations.ignored) {
        declarations.push(decl(keyPath, block.descLines.join(' ').trim() || null, block.markerLine, i, {
          kind: 'key',
          top_level: indent === 0,
          raw: Boolean(block.annotations.raw),
          default_annotation: block.annotations.default || null
        }))
      }
      block = null
      if (BLOCK_SCALAR_RE.test(realKey[3])) skipScalarIndent = indent
      continue
    }

    flushBlock()
    if (line.trim() === '') continue
    suppressInnerIndent = -1
    if (LIST_ITEM_RE.test(line)) continue

    if (realKey) {
      const indent = realKey[1].length
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
      const name = realKey[2].replace(/^"|"$/g, '')
      stack.push({ name, indent })
      if (BLOCK_SCALAR_RE.test(realKey[3])) skipScalarIndent = indent
      if (indent === 0 && !looseIgnored) {
        // Undocumented top-level user-visible key (no attached # -- marker).
        declarations.push(decl(name, null, i, i, {
          kind: 'key',
          top_level: true,
          undocumented: true,
          unverifiable: true
        }))
      }
    }
    looseIgnored = false
  }

  flushAtDoc()
  flushBlock()
  return declarations
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
