'use strict'

/**
 * Extracts documentation for commented-out values in a Helm chart's
 * values.yaml, and injects the resulting entries into the AsciiDoc reference
 * that `doc-tools generate helm-spec` produces.
 *
 * helm-docs only renders rows for keys that exist in the YAML tree, so
 * optional values that ship commented out (for example `external.domain` in
 * the Redpanda chart) never appear in the generated reference, even when the
 * chart author wrote a `# --` description for them. This module closes that
 * gap without requiring any change to chart behavior.
 *
 * Two comment conventions are recognized:
 *
 * 1. helm-docs style, attached to a commented-out key. A comment block that
 *    contains a `# -- description` marker and is immediately followed by a
 *    commented-out key documents that key. The key's path is derived from
 *    the enclosing uncommented keys by indentation:
 *
 *      external:
 *        # -- Optional domain advertised to external clients.
 *        # domain: local
 *
 *    yields `external.domain`.
 *
 * 2. Explicit, fully-qualified syntax that works anywhere in the file:
 *
 *      # @doc external.addresses -- Optional list of advertised addresses.
 *      # @default -- `nil`
 *
 * In both forms, an optional `# @default -- text` line overrides the
 * displayed default, which is otherwise `nil`.
 */

// Key names never contain dots or slashes: a dotted or slashed "key" in a
// comment is prose or a URL (`# docker.redpanda.com/...:4.101.0`), and
// treating it as a key both fabricates a path and truncates the description.
// Fully-qualified dotted paths are supported through the @doc syntax instead.
const COMMENTED_KEY_RE = /^(\s*)#(\s{0,4})([a-z][A-Za-z0-9_-]*):\s*(.*)$/
const REAL_KEY_RE = /^(\s*)([A-Za-z0-9_."/-]+):(.*)$/
// `(?!-)` keeps comment dividers such as `# ----------------` from being
// mistaken for an empty description marker.
const DESC_MARKER_RE = /^\s*#\s*--\s*(?!-)(.*)$/
const AT_DOC_RE = /^\s*#\s*@doc\s+([A-Za-z0-9_./-]+)\s+--\s*(.*)$/
const AT_DEFAULT_RE = /^\s*#\s*@default\s+--\s*(.*)$/
// helm-docs' bare word annotations: `# @raw`, `# @ignored`.
const AT_WORD_RE = /^\s*#\s*@(\w+)\s*$/
const COMMENT_RE = /^\s*#\s?(.*)$/
// A block scalar header may carry an explicit indentation indicator digit on
// either side of the chomping indicator: `|2`, `|-2`, `|2-`, `>2`, ...
const BLOCK_SCALAR_RE = /[|>][0-9]?[+-]?[0-9]?\s*(#.*)?$/
const LIST_ITEM_RE = /^\s*-\s/

/**
 * The one values.yaml comment walk in this repo. Two consumers share it:
 *
 * - `extractCommentedValueDocs` below, which the helm-spec generator uses to
 *   inject rows for documented commented-out keys.
 * - `tools/lint-strings/surfaces/helm.js`, which needs the same attachment
 *   decisions plus line spans, real-key (helm-docs) attachments, and the
 *   blocks that attach to NOTHING.
 *
 * The linter used to hold a byte-identical copy of every regex above and a
 * near-copy of this walk, so that "the linter never calls a marker dead that
 * the generator in this repo renders" - a promise nothing enforced. When the
 * copies drifted, the linter emitted exactly the false dead-marker the
 * comment promised to prevent and every test stayed green. There is now one
 * walk, so they cannot disagree.
 *
 * Records are the union of what both consumers need. Line numbers are
 * 0-indexed; descriptions are returned as the raw comment lines so each
 * consumer can join them its own way (the generator preserves newlines, the
 * linter flattens to one line).
 *
 * @param {string} yamlText - Raw contents of values.yaml.
 * @param {object} [options]
 * @param {boolean} [options.attachRealKeys=false] - Model helm-docs' own
 *   attachment: a `# --` block sitting DIRECTLY above an uncommented key
 *   documents that key, and a top-level uncommented key with no block above
 *   it is recorded as undocumented. The generator leaves this off because
 *   helm-docs already renders those rows; only the linter judges them.
 * @returns {Array<object>} records: { kind: 'key'|'dead-marker', path,
 *   descLines, default, annotations, lineStart, lineEnd, commentedOut,
 *   topLevel, undocumented }
 */
function parseValuesFile (yamlText, { attachRealKeys = false } = {}) {
  const lines = yamlText.split(/\r?\n/)
  const records = []
  const stack = [] // enclosing real keys: { name, indent }

  // Accumulating comment block: { descLines, default, candidate }. The
  // candidate is the key the block documents; emission is deferred to the
  // end of the block so that a later key line at the same depth supersedes a
  // prose line that merely looks like a key (`# example:`, `# default: 30s`).
  let block = null
  let atDoc = null // accumulating @doc entry: { path, descLines, default }
  let skipScalarIndent = -1 // inside a block scalar when >= 0
  let suppressInnerIndent = -1 // inside an emitted commented key's subtree when >= 0
  let looseIgnored = false // bare `# @ignored` with no `# --` block above a key

  const record = (fields) => {
    records.push({
      kind: 'key',
      path: null,
      descLines: [],
      default: '',
      annotations: {},
      lineStart: 0,
      lineEnd: 0,
      commentedOut: false,
      topLevel: false,
      undocumented: false,
      ...fields,
    })
  }

  const flushAtDoc = () => {
    if (atDoc) {
      record({
        path: atDoc.path,
        descLines: atDoc.descLines,
        default: atDoc.default,
        annotations: atDoc.annotations,
        lineStart: atDoc.line,
        lineEnd: atDoc.lastLine,
        commentedOut: true,
        topLevel: !atDoc.path.includes('.'),
      })
      atDoc = null
    }
  }

  // A `# --` block that reached the end of its life with no key to attach to.
  // The generator drops these; the linter reports them, because their
  // description silently never ships.
  const emitDead = (b) => {
    record({
      kind: 'dead-marker',
      descLines: b.descLines,
      default: b.default,
      annotations: b.annotations,
      lineStart: b.markerLine,
      lineEnd: b.lastLine,
    })
  }

  // Emit the active block's candidate, if any, and close the block. The
  // emitted key suppresses its own commented subtree until real content
  // appears, so nested example structures do not emit bogus paths.
  const flushBlock = () => {
    if (!block) return
    if (block.candidate) {
      const { name, effIndent } = block.candidate
      const parents = stack.filter((k) => k.indent < effIndent).map((k) => k.name)
      record({
        path: [...parents, name].join('.'),
        descLines: block.descLines,
        default: block.default,
        annotations: block.annotations,
        lineStart: block.markerLine,
        lineEnd: block.lastLine,
        commentedOut: true,
        topLevel: parents.length === 0,
      })
      suppressInnerIndent = effIndent
    } else {
      emitDead(block)
    }
    block = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Skip the body of block scalars so their content is never mistaken for
    // keys or comments.
    if (skipScalarIndent >= 0) {
      const indent = line.match(/^\s*/)[0].length
      if (line.trim() === '' || indent > skipScalarIndent) continue
      skipScalarIndent = -1
    }

    const atDocMatch = line.match(AT_DOC_RE)
    if (atDocMatch) {
      flushAtDoc()
      flushBlock()
      atDoc = { line: i, lastLine: i, path: atDocMatch[1], descLines: [atDocMatch[2]], default: '', annotations: {} }
      continue
    }

    const atDefault = line.match(AT_DEFAULT_RE)
    if (atDefault) {
      if (atDoc) { atDoc.default = atDefault[1].trim(); atDoc.lastLine = i }
      else if (block) { block.default = atDefault[1].trim(); block.lastLine = i }
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
      // A commented-out key line terminates an @doc entry rather than being
      // swallowed into its description, so @doc lines can sit directly above
      // the commented key they document.
      flushAtDoc()
      // Authors indent a commented key either before the marker ("  # child:")
      // or after it ("#   child:"), and the two forms mean the same nesting.
      // Counting only one side made them disagree: a child indented before the
      // marker escaped its parent's subtree and was emitted as a top-level
      // path. Fold both sides into one depth, treating the single space that
      // separates "#" from its text as punctuation rather than indentation, so
      // the result lines up with the real-key indents held on the stack.
      const effIndent = commentedKey[1].length + Math.max(0, commentedKey[2].length - 1)
      // A previously emitted commented key suppresses its own commented
      // subtree, so nested example structures do not emit bogus paths. A
      // marker in there is documentation neither pipeline ever renders.
      if (suppressInnerIndent >= 0 && effIndent > suppressInnerIndent) {
        if (block) emitDead(block)
        block = null
        continue
      }
      suppressInnerIndent = -1
      // Only bare keys or simple scalar values look like real chart values.
      // Prose such as `# Warning: If you use LoadBalancers...` has spaces in
      // the trailing text and is rejected.
      const value = commentedKey[4].trim()
      // Reject URL-like lines such as `# https://github.com/...`, where the
      // "key" is a URL scheme and the "value" is the scheme-relative part.
      const simpleValue = (value === '' || !/\s/.test(value)) && !value.startsWith('/')
      if (block && simpleValue) {
        if (!block.candidate || effIndent <= block.candidate.effIndent) {
          // The last key-shaped line at the block's shallowest depth wins:
          // an earlier line at the same depth was prose shaped like a key,
          // and deeper lines are nested example structures.
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
      block = { markerLine: i, lastLine: i, descLines: [descMarker[1]], default: '', annotations: {}, candidate: null }
      continue
    }

    const comment = line.match(COMMENT_RE)
    if (comment && line.trim().startsWith('#')) {
      if (atDoc) { atDoc.descLines.push(comment[1]); atDoc.lastLine = i }
      // Description lines precede the documented key; once a candidate
      // exists, trailing comment lines belong to its example structure and
      // only extend the span.
      else if (block && !block.candidate) { block.descLines.push(comment[1]); block.lastLine = i }
      else if (block) block.lastLine = i
      continue
    }

    // Any non-comment line ends comment accumulation. Only real content also
    // ends subtree suppression: a blank line inside a commented-out example
    // structure must not re-enable emission against a stale parent key, since
    // the real-key stack is not rebuilt by comment lines.
    flushAtDoc()

    const realKey = line.match(REAL_KEY_RE)
    if (attachRealKeys && realKey && block && !block.candidate && block.lastLine === i - 1) {
      // helm-docs' own attachment: the block sits DIRECTLY above a real key.
      const indent = realKey[1].length
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
      const name = realKey[2].replace(/^"|"$/g, '')
      const keyPath = [...stack.map((k) => k.name), name].join('.')
      stack.push({ name, indent })
      if (!block.annotations.ignored) {
        record({
          path: keyPath,
          descLines: block.descLines,
          default: block.default,
          annotations: block.annotations,
          lineStart: block.markerLine,
          lineEnd: i,
          topLevel: indent === 0,
        })
      }
      block = null
      suppressInnerIndent = -1
      if (BLOCK_SCALAR_RE.test(realKey[3])) skipScalarIndent = indent
      continue
    }

    flushBlock()
    if (line.trim() === '') continue
    suppressInnerIndent = -1

    if (LIST_ITEM_RE.test(line)) continue

    if (realKey) {
      const indent = realKey[1].length
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop()
      }
      const name = realKey[2].replace(/^"|"$/g, '')
      stack.push({ name, indent })
      if (BLOCK_SCALAR_RE.test(realKey[3])) skipScalarIndent = indent
      if (attachRealKeys && indent === 0 && !looseIgnored) {
        // Top-level user-visible key with no attached `# --` marker.
        record({ path: name, lineStart: i, lineEnd: i, topLevel: true, undocumented: true })
      }
    }
    looseIgnored = false
  }

  flushAtDoc()
  flushBlock()
  return records
}

/**
 * Parse values.yaml text and return entries for documented commented-out keys.
 *
 * A filter over `parseValuesFile`: the commented-out keys it attaches, with
 * their comment lines joined the way the AsciiDoc injector wants them.
 *
 * @param {string} yamlText - Raw contents of values.yaml.
 * @returns {Array<{path: string, description: string, default: string}>}
 */
function extractCommentedValueDocs (yamlText) {
  return parseValuesFile(yamlText)
    .filter((r) => r.kind === 'key' && r.commentedOut)
    .map((r) => ({
      path: r.path,
      description: r.descLines.join('\n').trim(),
      default: r.default || '`nil`',
    }))
}

/**
 * Check a dotted value path against a chart's values.schema.json. A path is
 * rejected only when the walk can prove the schema forbids it: an object
 * level whose `properties` lack the segment, whose `patternProperties` (if
 * any) do not match it, and whose `additionalProperties` is `false`.
 * Anything the walk cannot interpret ($ref, allOf, open objects) is allowed,
 * so an incomplete schema never hides documentation.
 *
 * @param {object} schema - Parsed values.schema.json.
 * @param {string} path - Dotted value path, for example `external.domain`.
 * @returns {boolean}
 */
function isPathAllowedBySchema (schema, path) {
  let node = schema
  for (const segment of path.split('.')) {
    if (!node || typeof node !== 'object' || node.$ref || node.allOf || node.anyOf || node.oneOf) {
      return true
    }
    const props = node.properties
    if (props && Object.prototype.hasOwnProperty.call(props, segment)) {
      node = props[segment]
      continue
    }
    if (node.patternProperties) {
      const pattern = Object.keys(node.patternProperties)
        .find((p) => { try { return new RegExp(p).test(segment) } catch { return true } })
      if (pattern !== undefined) {
        node = node.patternProperties[pattern]
        continue
      }
    }
    return node.additionalProperties !== false
  }
  return true
}

/**
 * Split extracted entries into those permitted by the chart's
 * values.schema.json and those provably rejected by it, such as keys whose
 * `# --` comment is a deprecation notice for a removed value.
 *
 * @param {Array<{path: string}>} entries
 * @param {object} schema - Parsed values.schema.json.
 * @returns {{accepted: Array, rejected: Array}}
 */
function filterEntriesBySchema (entries, schema) {
  const accepted = []
  const rejected = []
  for (const entry of entries) {
    (isPathAllowedBySchema(schema, entry.path) ? accepted : rejected).push(entry)
  }
  return { accepted, rejected }
}

// Neutralize description lines that would otherwise parse as AsciiDoc
// structure when injected at block level: section titles re-parent the
// following sections, and an unclosed block delimiter swallows the rest of
// the document. `{empty}` renders as nothing but demotes the line to a
// plain paragraph.
function sanitizeDescription (text) {
  return text
    .split('\n')
    .map((line) => (/^(=+\s|-{2,}\s*$|[=*_.+]{4,}\s*$|\|===)/.test(line) ? `{empty}${line}` : line))
    .join('\n')
}

/**
 * Inject extracted entries into a generated AsciiDoc Helm reference.
 *
 * Sections are matched by their `=== link:++<url>?...path=<key>++[<key>]`
 * headings. New sections reuse the Artifact Hub URL prefix of the existing
 * sections and are inserted in alphabetical key order. Keys that are already
 * documented are skipped.
 *
 * @param {string} adoc - The converted AsciiDoc document.
 * @param {Array<{path: string, description: string, default: string}>} entries
 * @returns {{doc: string, injected: string[], sectionsFound: number}}
 */
function injectIntoAsciiDoc (adoc, entries) {
  // The label may itself contain brackets (`[storage.volume[0].name]` in the
  // connectors chart), so it is matched to end of line rather than to the
  // first closing bracket.
  const headingRe = /^=== link:\+\+(https?:\/\/[^+]*[?&]path=)([^+]+)\+\+\[.*\]\s*$/gm
  const sections = []
  let match
  while ((match = headingRe.exec(adoc)) !== null) {
    sections.push({ index: match.index, urlPrefix: match[1], key: match[2] })
  }
  if (sections.length === 0) {
    return { doc: adoc, injected: [], sectionsFound: 0 }
  }

  const urlPrefix = sections[0].urlPrefix
  // Tracks both keys present in the document and keys queued for injection,
  // so a path extracted twice (for example, from both @doc and # -- comments
  // for the same key) is only injected once.
  const existingKeys = new Set(sections.map((s) => s.key))
  const additions = []
  for (const entry of entries) {
    if (existingKeys.has(entry.path)) continue
    existingKeys.add(entry.path)
    additions.push(entry)
  }
  additions.sort((a, b) => a.path.localeCompare(b.path))

  let doc = adoc
  const injected = []

  for (const entry of additions) {
    // Recompute section offsets after each insertion.
    const current = []
    headingRe.lastIndex = 0
    while ((match = headingRe.exec(doc)) !== null) {
      current.push({ index: match.index, key: match[2] })
    }
    const after = current.find((s) => s.key.localeCompare(entry.path) > 0)

    const section = [
      `=== link:++${urlPrefix}${entry.path}++[${entry.path}]`,
      '',
      sanitizeDescription(entry.description),
      '',
      `*Default:* ${entry.default}`,
      '',
      '',
    ].join('\n')

    if (after) {
      doc = doc.slice(0, after.index) + section + doc.slice(after.index)
    } else {
      // Append after the final section, before the next heading (levels 1-3)
      // if one exists, so a trailing non-values subsection stays last.
      const last = current[current.length - 1]
      const rest = doc.slice(last.index)
      const nextHeading = rest.search(/\n={1,3} /)
      if (nextHeading > 0) {
        const cut = last.index + nextHeading + 1
        doc = doc.slice(0, cut) + section + doc.slice(cut)
      } else {
        doc = doc.trimEnd() + '\n\n' + section
      }
    }
    injected.push(entry.path)
  }

  return { doc, injected, sectionsFound: sections.length }
}

module.exports = {
  parseValuesFile,
  extractCommentedValueDocs,
  injectIntoAsciiDoc,
  filterEntriesBySchema,
  isPathAllowedBySchema,
  // Exported so the lint surface cannot hold its own copy. Every one of these
  // was duplicated character-for-character before.
  PATTERNS: {
    COMMENTED_KEY_RE,
    REAL_KEY_RE,
    DESC_MARKER_RE,
    AT_DOC_RE,
    AT_DEFAULT_RE,
    AT_WORD_RE,
    COMMENT_RE,
    BLOCK_SCALAR_RE,
    LIST_ITEM_RE,
  },
}
