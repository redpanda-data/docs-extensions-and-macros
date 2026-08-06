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

const COMMENTED_KEY_RE = /^(\s*)#(\s{0,4})([a-z][A-Za-z0-9_./-]*):\s*(.*)$/
const REAL_KEY_RE = /^(\s*)([A-Za-z0-9_."/-]+):(.*)$/
const DESC_MARKER_RE = /^\s*#\s*--\s*(.*)$/
const AT_DOC_RE = /^\s*#\s*@doc\s+([A-Za-z0-9_./-]+)\s+--\s*(.*)$/
const AT_DEFAULT_RE = /^\s*#\s*@default\s+--\s*(.*)$/
const COMMENT_RE = /^\s*#\s?(.*)$/
const BLOCK_SCALAR_RE = /[|>][+-]?\s*(#.*)?$/
const LIST_ITEM_RE = /^\s*-\s/

/**
 * Parse values.yaml text and return entries for documented commented-out keys.
 *
 * @param {string} yamlText - Raw contents of values.yaml.
 * @returns {Array<{path: string, description: string, default: string}>}
 */
function extractCommentedValueDocs (yamlText) {
  const lines = yamlText.split(/\r?\n/)
  const entries = []
  const stack = [] // enclosing real keys: { name, indent }

  let block = null // accumulating comment block: { descLines, default, hasMarker }
  let atDoc = null // accumulating @doc entry: { path, descLines, default }
  let skipScalarIndent = -1 // inside a block scalar when >= 0
  let suppressInnerIndent = -1 // inside an emitted commented key's subtree when >= 0

  const flushAtDoc = () => {
    if (atDoc) {
      entries.push({
        path: atDoc.path,
        description: atDoc.descLines.join('\n').trim(),
        default: atDoc.default || '`nil`',
      })
      atDoc = null
    }
  }

  for (const line of lines) {
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
      block = null
      atDoc = { path: atDocMatch[1], descLines: [atDocMatch[2]], default: '' }
      continue
    }

    const atDefault = line.match(AT_DEFAULT_RE)
    if (atDefault) {
      if (atDoc) atDoc.default = atDefault[1].trim()
      else if (block) block.default = atDefault[1].trim()
      continue
    }

    const commentedKey = line.match(COMMENTED_KEY_RE)
    if (commentedKey) {
      // A commented-out key line terminates an @doc entry rather than being
      // swallowed into its description, so @doc lines can sit directly above
      // the commented key they document.
      flushAtDoc()
      const innerIndent = commentedKey[2].length
      // A previously emitted commented key suppresses its own commented
      // subtree, so nested example structures do not emit bogus paths.
      if (suppressInnerIndent >= 0 && innerIndent > suppressInnerIndent) {
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
      if (block && block.hasMarker && simpleValue) {
        flushAtDoc()
        const indent = commentedKey[1].length
        const parents = stack.filter((k) => k.indent < indent).map((k) => k.name)
        entries.push({
          path: [...parents, commentedKey[3]].join('.'),
          description: block.descLines.join('\n').trim(),
          default: block.default || '`nil`',
        })
        suppressInnerIndent = innerIndent
        block = null
        continue
      }
    }

    const descMarker = line.match(DESC_MARKER_RE)
    if (descMarker) {
      flushAtDoc()
      block = { descLines: [descMarker[1]], default: '', hasMarker: true }
      continue
    }

    const comment = line.match(COMMENT_RE)
    if (comment && line.trim().startsWith('#')) {
      if (atDoc) atDoc.descLines.push(comment[1])
      else if (block) block.descLines.push(comment[1])
      continue
    }

    // Any non-comment line ends comment accumulation and subtree suppression.
    flushAtDoc()
    block = null
    suppressInnerIndent = -1

    if (line.trim() === '' || LIST_ITEM_RE.test(line)) continue

    const realKey = line.match(REAL_KEY_RE)
    if (realKey) {
      const indent = realKey[1].length
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop()
      }
      stack.push({ name: realKey[2].replace(/^"|"$/g, ''), indent })
      if (BLOCK_SCALAR_RE.test(realKey[3])) skipScalarIndent = indent
    }
  }

  flushAtDoc()
  return entries
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
 * @returns {{doc: string, injected: string[]}}
 */
function injectIntoAsciiDoc (adoc, entries) {
  const headingRe = /^=== link:\+\+(https?:\/\/[^+]*[?&]path=)([^+\]]+)\+\+\[[^\]]*\]\s*$/gm
  const sections = []
  let match
  while ((match = headingRe.exec(adoc)) !== null) {
    sections.push({ index: match.index, urlPrefix: match[1], key: match[2] })
  }
  if (sections.length === 0) {
    return { doc: adoc, injected: [] }
  }

  const urlPrefix = sections[0].urlPrefix
  const existingKeys = new Set(sections.map((s) => s.key))
  const additions = entries
    .filter((e) => !existingKeys.has(e.path))
    .sort((a, b) => a.path.localeCompare(b.path))

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
      entry.description,
      '',
      `*Default:* ${entry.default}`,
      '',
      '',
    ].join('\n')

    if (after) {
      doc = doc.slice(0, after.index) + section + doc.slice(after.index)
    } else {
      // Append after the final section, before the next top-level heading if
      // one exists.
      const last = current[current.length - 1]
      const rest = doc.slice(last.index)
      const nextHeading = rest.search(/^==?\s/m) === 0
        ? rest.slice(1).search(/^==?\s/m) + 1
        : rest.search(/\n== /)
      if (nextHeading > 0) {
        const cut = last.index + nextHeading + 1
        doc = doc.slice(0, cut) + section + doc.slice(cut)
      } else {
        doc = doc.trimEnd() + '\n\n' + section
      }
    }
    injected.push(entry.path)
  }

  return { doc, injected }
}

module.exports = { extractCommentedValueDocs, injectIntoAsciiDoc }
