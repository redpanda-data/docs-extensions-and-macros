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
 * Known divergence, console chart: a `# --` block written for a
 * commented-out key is ALSO attached by helm-docs to the next real key, so
 * `service.annotations` publishes the description written for
 * `service.targetPort`. This surface attributes that marker to the
 * commented-out key (the doc-tools convention), so it reports
 * `service.annotations` as having no description of its own - which is true,
 * and is a real defect in that chart, so it is left reported rather than
 * modelled away.
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
function publishableBlankKeys (content, marked, ignored) {
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
      meta = { kind: 'dead-marker', unverifiable: true }
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
      string,
      declaration_text: null,
      convention: CONVENTION,
      meta
    }
  })

  // One declaration per key helm-docs will render with an empty description.
  for (const key of publishableBlankKeys(content, marked, ignored)) {
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
      return [{ message: 'This "# --" description is buried where neither helm-docs nor the helm-spec commented-values pass can attach it (inside another commented-out key\'s subtree, or separated from any key), so it silently never ships. Move it directly above the key it documents, use "# @doc full.path -- ...", or delete it.' }]
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
  rules: RULES
}
