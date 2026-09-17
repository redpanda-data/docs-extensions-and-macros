'use strict'

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const { SourceCache } = require('../source-text')
const { parseValuesFile: parseSharedValuesFile, PATTERNS } = require('../../../cli-utils/helm-commented-values')

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
 * A MISSING description has to be judged at the level helm-docs actually
 * publishes, which is not the level a values.yaml author thinks in.
 * helm-docs renders one row per key that either carries a `# --` marker or
 * is a leaf with no marked ancestor; a marked key documents its whole
 * subtree, so its unmarked children are never rendered at all. Verified by
 * running helm-docs 1.14.2 over all three charts and diffing the predicted
 * blank set against the real output: exact on redpanda (20) and connectors
 * (30), and one known divergence on console, below.
 *
 * The consequences for detection:
 *
 *   * An unmarked PARENT (`statefulset:`, `podTemplate:`) is not published
 *     as a row, so telling anyone to document it is wrong - helm-docs never
 *     shows it. The old undocumented-top-level-key rule reported exactly
 *     these, and all four of its findings on the redpanda chart were keys
 *     absent from the published reference.
 *   * The keys that DO ship blank are unmarked leaves under unmarked
 *     parents (`statefulset.budget.maxUnavailable`, `tests.enabled`). There
 *     were 20 of them in the redpanda chart and the old rule, being
 *     top-level only, could not report one.
 *
 * Leaf-ness follows helm-docs: a non-empty array of objects is descended by
 * index (`ingress.hosts[0].host`), while an array of scalars and an empty
 * array are single rows. `# @ignored` drops a key and its subtree.
 *
 * The two pipelines can also attach ONE marker to TWO different keys, which
 * is its own defect and needs its own rule. helm-docs uses the nearest `# --`
 * above a real key and does not care that the marker was written for a
 * commented-out key in between, so
 *
 *     # -- Override the value in `console.config.server.listenPort`
 *     # targetPort:
 *     annotations: {}
 *
 * publishes that text as `service.annotations`' description, while the
 * helm-spec pass injects the same text under `service.targetPort`. The text
 * ships twice, once under a key it does not describe. `misattached-marker`
 * reports it on the marker itself and names both keys.
 *
 * Two things about helm-docs' attachment are easy to get wrong, and both were
 * wrong here until helm-docs 1.14.2 was run on isolated fixtures to settle
 * them:
 *
 *   * A BLANK LINE DOES NOT BREAK ATTACHMENT. A `# --` attaches to the next
 *     real key in document order however many blank lines intervene; only a
 *     later `# --` supersedes it. (A marker at the very top of a file, before
 *     any key, attaches to nothing.) Predicting attachment this way agrees
 *     with helm-docs on 227 of the 228 markers in the three charts, the
 *     single difference being an `@raw` annotation line it strips.
 *   * helm-docs' MARKER FORM IS STRICTER than this repo's. It needs exactly
 *     one space, `# -- text`; an indented `#   -- text` is invisible to it,
 *     while `DESC_MARKER_RE` here accepts both. That gap is the whole reason
 *     the walk can attribute a marker helm-docs never sees, and it is why the
 *     markers buried in a commented-out subtree really are dead: they are all
 *     written in the indented form.
 *
 * So a marker the walk calls dead is only dead when helm-docs cannot see it
 * or no key follows it; a visible one separated by blank lines is not dead,
 * it is misattached, and `misattached-marker` says so instead.
 *
 * Modelling all of this is also what makes the blank-key set exact: a
 * misattached target is NOT blank, so it must not be reported as
 * undocumented. With it, the predicted blank set equals helm-docs' own output
 * on all three charts (20/20, 36/36, 30/30).
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

// Block-scalar and real-key recognition come from the shared walk's own
// patterns rather than a second copy here; a divergence between the two is
// exactly the drift this surface's guard test forbids.
const { BLOCK_SCALAR_RE, REAL_KEY_RE } = PATTERNS

/**
 * The marker form helm-docs itself recognizes: exactly one space between the
 * hash and the dashes. Verified against helm-docs 1.14.2 - `# -- text`
 * attaches, `#   -- text` produces no description at all.
 *
 * Deliberately stricter than the shared `DESC_MARKER_RE`, which this repo's
 * own pass uses. A marker only the loose pattern matches is attributed by
 * doc-tools and ignored by helm-docs.
 */
const HELM_DOCS_MARKER_RE = /^\s*#\s--\s/

/**
 * Walk the raw text for every real key's dotted path, its line, and whether
 * its comment block carries `# @ignored`.
 *
 * Done on the text rather than the parsed tree because findings need line
 * numbers, and because a block scalar's BODY must not be mistaken for keys -
 * `config: |` followed by indented `some: content` is content, not structure.
 *
 * @returns {{lines: Map<string, number>, ignored: Set<string>}} 0-indexed lines
 */
function scanKeyLines (content) {
  const lines = new Map()
  const ignored = new Set()
  const stack = []
  let block = []
  let blockScalarIndent = null
  const rows = content.split('\n')

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (blockScalarIndent !== null) {
      const indent = row.search(/\S/)
      if (row.trim() === '' || indent > blockScalarIndent) continue
      blockScalarIndent = null
    }
    if (/^\s*#/.test(row)) {
      block.push(row)
      continue
    }
    const match = REAL_KEY_RE.exec(row)
    if (!match) {
      if (row.trim() !== '') block = []
      continue
    }
    const indent = match[1].length
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    stack.push({ indent, key: match[2] })
    const dotted = stack.map((entry) => entry.key).join('.')
    lines.set(dotted, i)
    if (block.some((b) => /^\s*#\s*@ignored\b/.test(b))) ignored.add(dotted)
    block = []
    // The shared pattern matches the value side, so test the captured value.
    if (BLOCK_SCALAR_RE.test(match[3].trim())) blockScalarIndent = indent
  }
  return { lines, ignored }
}

/**
 * Markers that helm-docs will attach to a different key than the helm-spec
 * pass does: `commentedOutPath -> realKeyPath`.
 *
 * The walk decides what documents a commented-out key, so this only has to
 * answer what helm-docs does with the same marker. Walking down from the
 * commented-out key line: a blank line ends the comment block (helm-docs then
 * sees no marker), a further `# --` gives the real key its own description,
 * and anything else lands on the next real key.
 *
 * @param {string} content - values.yaml text
 * @param {Array} records - shared-walk records
 * @param {Map<number, string>} pathByLine - 0-indexed line -> dotted path
 * @param {Set<string>} ignored - paths carrying `# @ignored`
 * @returns {Map<string, string>}
 */
function misattachedMarkers (content, records, pathByLine, ignored = new Set()) {
  const rows = content.split('\n')
  const out = new Map()
  for (const record of records) {
    // Both shapes go wrong the same way: a marker this repo attributes to a
    // commented-out key, and one it calls dead, are each handed by helm-docs
    // to the next real key below.
    const isCommentedOut = record.commentedOut && record.path
    const isDead = record.kind === 'dead-marker'
    if (!isCommentedOut && !isDead) continue
    // helm-docs has to be able to see the marker in the first place.
    if (!HELM_DOCS_MARKER_RE.test(rows[record.lineStart] || '')) continue

    let i = record.lineEnd + 1
    let superseded = false
    while (i < rows.length) {
      const row = rows[i]
      // A blank line does NOT end attachment; only a later visible marker
      // does, by taking the real key for itself.
      if (row.trim() === '') { i++; continue }
      if (/^\s*#/.test(row)) {
        if (HELM_DOCS_MARKER_RE.test(row)) { superseded = true; break }
        i++
        continue
      }
      break
    }
    if (superseded || i >= rows.length) continue
    if (!REAL_KEY_RE.test(rows[i])) continue
    const target = pathByLine.get(i)
    if (!target) continue
    // An `@ignored` key is not published at all, so a marker landing there
    // still ships nowhere: that is dead-marker's finding, not this one.
    if (ignored.has(target) || ancestorIn(target, ignored)) continue
    out.set(isCommentedOut ? record.path : `@marker:${record.lineStart}`, target)
  }
  return out
}

/** True when any strict ancestor of `dotted` is in `set`. */
function ancestorIn (dotted, set) {
  const parts = dotted.replace(/\[\d+\]/g, '').split('.')
  for (let i = 1; i < parts.length; i++) {
    if (set.has(parts.slice(0, i).join('.'))) return true
  }
  return false
}

/**
 * The keys helm-docs will publish with an EMPTY description: unmarked leaves
 * that no marked (or `@ignored`) ancestor covers.
 *
 * @param {string} content - values.yaml text
 * @param {Set<string>} marked - paths carrying a `# --` description
 * @param {Set<string>} ignored - paths carrying `# @ignored`
 * @returns {string[]} dotted paths, array elements indexed
 */
function publishableBlankKeys (content, marked, ignored, misattachedTo = new Set()) {
  let tree
  try {
    tree = yaml.load(content)
  } catch (err) {
    // A values.yaml this surface cannot parse is not a doc-string defect;
    // the chart's own CI owns that. Report nothing rather than guess.
    return []
  }
  if (!tree || typeof tree !== 'object') return []

  const leaves = []
  const visit = (node, dotted) => {
    if (Array.isArray(node)) {
      // helm-docs descends an array by index only when its elements are
      // themselves structured; an array of scalars is a single row.
      if (!node.some((el) => el && typeof el === 'object')) {
        if (dotted) leaves.push(dotted)
        return
      }
      node.forEach((el, index) => visit(el, `${dotted}[${index}]`))
      return
    }
    if (node && typeof node === 'object' && Object.keys(node).length > 0) {
      for (const key of Object.keys(node)) visit(node[key], dotted ? `${dotted}.${key}` : key)
      return
    }
    if (dotted) leaves.push(dotted)
  }
  visit(tree, '')

  return leaves.filter((leaf) => {
    const plain = leaf.replace(/\[\d+\]/g, '')
    if (marked.has(plain) || ignored.has(plain)) return false
    // A key helm-docs hands a misattached marker to is not blank - it ships
    // the wrong description, which misattached-marker reports instead.
    if (misattachedTo.has(plain)) return false
    return !ancestorIn(leaf, marked) && !ancestorIn(leaf, ignored)
  })
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
  const records = parseSharedValuesFile(content, { attachRealKeys: true })
  const { lines: keyLines, ignored } = scanKeyLines(content)
  const marked = new Set(
    records
      .filter((r) => r.kind !== 'dead-marker' && !r.undocumented && r.path)
      .map((r) => r.path)
  )
  const pathByLine = new Map([...keyLines].map(([dotted, line]) => [line, dotted]))
  const misattached = misattachedMarkers(content, records, pathByLine, ignored)
  const misattachedTo = new Set(misattached.values())

  const declarations = records
    // The walk's own undocumented records are top-level parents, which
    // helm-docs does not publish as rows. They are replaced below by the
    // leaves it does publish.
    .filter((r) => !(r.kind === 'key' && r.undocumented))
    .map((r) => {
    // The generator keeps newlines in a description; helm-docs renders one
    // paragraph, and the rules read one string, so flatten here.
    const string = r.descLines.map((l) => l.trim()).filter(Boolean).join(' ') || null
    let meta
    if (r.kind === 'dead-marker') {
      meta = {
        kind: 'dead-marker',
        unverifiable: true,
        // A marker helm-docs CAN see is not dead: it lands on the next real
        // key rather than nowhere.
        misattached_to: misattached.get(`@marker:${r.lineStart}`) || null
      }
    } else if (r.commentedOut) {
      meta = {
        kind: 'key',
        commented_out: true,
        top_level: r.topLevel,
        default_annotation: r.default || null,
        // Set when helm-docs hands this same marker to a real key below.
        misattached_to: misattached.get(r.path) || null
      }
    } else {
      meta = { kind: 'key', top_level: r.topLevel, raw: Boolean(r.annotations.raw), default_annotation: r.default || null }
    }
    return {
      surface: 'helm',
      name: r.kind === 'dead-marker' ? null : r.path,
      file,
      line_start: r.lineStart + 1, // 0-indexed -> 1-indexed
      line_end: r.lineEnd + 1,
      string,
      declaration_text: null,
      convention: CONVENTION,
      meta
    }
  })

  // One declaration per key helm-docs will render with an empty description.
  for (const key of publishableBlankKeys(content, marked, ignored, misattachedTo)) {
    // An indexed path has no key line of its own; anchor on the nearest
    // ancestor that does, so the finding still points into the file.
    let anchor = keyLines.get(key.replace(/\[\d+\]/g, ''))
    if (anchor === undefined) {
      const parts = key.replace(/\[\d+\]/g, '').split('.')
      for (let i = parts.length - 1; i > 0 && anchor === undefined; i--) {
        anchor = keyLines.get(parts.slice(0, i).join('.'))
      }
    }
    if (anchor === undefined) continue
    declarations.push({
      surface: 'helm',
      name: key,
      file,
      line_start: anchor + 1,
      line_end: anchor + 1,
      // Nothing to lint for content: the rule fires on the absence itself.
      string: null,
      declaration_text: null,
      convention: CONVENTION,
      meta: {
        kind: 'key',
        undocumented: true,
        top_level: !key.includes('.'),
        unverifiable: true
      }
    })
  }

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
      // Only dead if helm-docs cannot see it either. A visible marker
      // separated from its key still lands somewhere, which is
      // misattached-marker's finding, not this one.
      if (decl.meta.misattached_to) return []
      return [{ message: 'This "# --" description is buried where neither helm-docs nor the helm-spec commented-values pass can attach it: it sits inside another commented-out key\'s subtree, in the indented `#   -- ` form that helm-docs does not recognize as a marker at all. It silently never ships. Move it directly above the key it documents, use "# @doc full.path -- ...", or delete it.' }]
    }
  },
  {
    name: 'misattached-marker',
    description: 'One # -- marker is published under two different keys',
    severity: 'error',
    runOnUnverifiable: true,
    check: (decl) => {
      if (!decl.meta.misattached_to) return []
      const target = decl.meta.misattached_to
      const written = decl.meta.kind === 'dead-marker'
        ? 'is not attached to any key of its own'
        : `documents the commented-out key "${decl.name}"`
      return [{
        message: `This "# --" ${written}, but helm-docs attaches a marker to the next REAL key below it - blank lines and commented-out keys in between make no difference - so it publishes this text as "${target}"'s description. Give "${target}" its own "# --" description, which supersedes this one, or delete this marker.`
      }]
    }
  },
  {
    name: 'undocumented-key',
    description: 'Key helm-docs publishes with an empty description',
    severity: 'info',
    runOnUnverifiable: true,
    check: (decl) => {
      if (decl.meta.kind !== 'key' || !decl.meta.undocumented) return []
      return [{ message: `"${decl.name}" has no "# --" description of its own, so helm-docs publishes it with an empty description. Add a marker comment directly above the key (or "# @ignored" if it is not user-facing). Note that documenting an ancestor instead removes the row entirely rather than filling it in.` }]
    }
  }
]

module.exports = {
  name: 'helm',
  convention: CONVENTION,
  extract,
  parseValuesFile,
  publishableBlankKeys,
  scanKeyLines,
  misattachedMarkers,
  HELM_DOCS_MARKER_RE,
  rules: RULES
}
