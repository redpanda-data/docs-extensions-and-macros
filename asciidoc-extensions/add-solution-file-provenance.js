'use strict'

/**
 * Download provenance for the snippets of a solution page.
 *
 * Every code block on a solution page is single-sourced from the solution's own
 * code with `include::example$<path>`, so a reader can be offered the file
 * behind the snippet. That offer needs the path in the HTML, which Asciidoctor's
 * listing output does not carry, so this stamps it on the listing block as
 * `data-solution-file` and, when the include selected one region,
 * `data-solution-tag`.
 *
 * Mechanism, in two halves that share one document's state:
 *
 * 1. A tree processor reads each listing block's `source_location`. Antora's
 *    include processor pushes the resolved file onto the reader as a String
 *    carrying the Antora source record (`family`, `relative`) and a `parent`
 *    cursor pointing at the include directive's own line in the including file,
 *    so a block rendered from an include names its file, and a hand-written
 *    block has no source file at all. This needs `sourcemap`, which the
 *    solutions-catalog extension turns on for the site.
 * 2. Asciidoctor's HTML converter emits no `data-*` on a listing block, so the
 *    tree processor marks the block with a per-document role token and a
 *    postprocessor swaps that token for the attributes. The token is unique per
 *    block, so this never depends on blocks and HTML being in the same order.
 *
 * The tag is read from the include directive's own line in the page source
 * rather than guessed from the block: Asciidoctor keeps the included lines, not
 * the selection that produced them. A selection that does not name exactly one
 * region (`tags=a;b`, a negation, a wildcard) is left unstated.
 *
 * Restricted to the `solutions` component.
 */

const SOLUTIONS_COMPONENT = 'solutions'
const EXAMPLE_FAMILY = 'example'

// Role kept on the block for the UI, plus the per-block marker the
// postprocessor consumes.
const SNIPPET_ROLE = 'sol-snippet'
const MARKER_PREFIX = 'sol-snippet-'

const INCLUDE_RX = /^\s*include::[^[\]]+\[(.*)\]\s*$/
const TAG_RX = /(?:^|,)\s*tags?=([^,]*)/

function htmlEscape (value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The one tag an include directive selected, or '' when it did not name one. */
function tagFromDirective (line) {
  const directive = INCLUDE_RX.exec(String(line || ''))
  if (!directive) return ''
  const found = TAG_RX.exec(directive[1])
  if (!found) return ''
  const tag = found[1].trim().replace(/^(["'])(.*)\1$/, '$2').trim()
  // Multiple regions, a negation, or a wildcard select something this cannot
  // name in one attribute, so it says nothing rather than something wrong.
  if (!tag || /[;*!]/.test(tag)) return ''
  return tag
}

/** The Antora source record of the file a block's lines came from. */
function includedSrcOf (block) {
  if (typeof block.getSourceLocation !== 'function') return null
  const location = block.getSourceLocation()
  if (!location || typeof location.getFile !== 'function') return null
  const file = location.getFile()
  return (file && file.src) || null
}

/**
 * The line of the include directive that produced this block, read from the
 * page's own source.
 *
 * The parent cursor names the including file: empty when the document was
 * loaded without a docfile, and the page's own path in a real build. An include
 * nested inside a partial names that partial instead, and gets no tag rather
 * than a line read out of the wrong file.
 */
function includeDirectiveLine (block, file, pageLines) {
  if (!pageLines) return ''
  const location = block.getSourceLocation()
  const included = location && location.getFile()
  const parent = included && included.parent
  if (!parent) return ''
  const parentFile = parent.file === undefined || parent.file === null ? '' : String(parent.file)
  const ownPaths = [file.path, file.src && file.src.path].filter(Boolean).map(String)
  if (parentFile !== '' && !ownPaths.includes(parentFile)) return ''
  const lineno = Number(parent.lineno)
  if (!Number.isInteger(lineno) || lineno < 1) return ''
  return pageLines[lineno - 1] || ''
}

// An include of this module's examples, unqualified or qualified with the
// module name only: `include::example$<path>[...]`, `include::<module>:example$<path>[...]`.
const EXAMPLE_DIRECTIVE_RX = /^\s*include::(?:([A-Za-z0-9_-]+):)?example\$([^[\]\s]+)\[.*\]\s*$/
const DELIMITER_RX = /^(?:-{4,}|\.{4,})$/

/**
 * The include directive behind a listing nested in another block.
 *
 * A listing inside a compound block (the `[%collapsible]` example block that
 * holds a solution page's `.Complete source`, a sidebar, a tab) is parsed from
 * lines the parent block already read, include expanded, so its source
 * location names the page and a line in it rather than the included file.
 * That line is the listing's opening delimiter (or the attribute and title
 * lines above it), so the directive is the line after the delimiter. Returns
 * '' when the location is not this page or that line is not an example include.
 */
function nestedDirectiveLine (block, file, pageLines) {
  if (!pageLines || typeof block.getSourceLocation !== 'function') return ''
  const location = block.getSourceLocation()
  if (!location || typeof location.getFile !== 'function') return ''
  const located = location.getFile()
  // A String carrying a source record is an included file: not this case.
  if (located && typeof located === 'object') return ''
  const name = located === undefined || located === null ? '' : String(located)
  const ownPaths = [file.path, file.src && file.src.path].filter(Boolean).map(String)
  if (name !== '' && !ownPaths.includes(name)) return ''
  let i = Number(location.getLineNumber()) - 1
  if (!Number.isInteger(i) || i < 0) return ''
  while (i < pageLines.length && (/^\[.*\]$/.test(pageLines[i]) || /^\.[^.\s]/.test(pageLines[i]))) i++
  if (!DELIMITER_RX.test(String(pageLines[i] || '').trim())) return ''
  const line = pageLines[i + 1] || ''
  return EXAMPLE_DIRECTIVE_RX.test(line) ? line : ''
}

/**
 * The example file a nested listing was included from, as an Antora source
 * record, or null. Resolved through the content catalog when the loader passes
 * one, which also proves the include resolved; the block's first line must be
 * in that file, so a line number that drifted onto some other listing's
 * directive is never taken for this one.
 */
function nestedIncludedSrc (block, file, directive, contentCatalog) {
  const m = EXAMPLE_DIRECTIVE_RX.exec(directive)
  if (!m) return null
  const [, module, relative] = m
  if (module && file.src && module !== file.src.module) return null
  if (relative.includes('{')) return null
  if (!contentCatalog || typeof contentCatalog.resolveResource !== 'function') {
    return { family: EXAMPLE_FAMILY, relative: relative.replace(/^\.\//, '') }
  }
  let resolved
  try {
    resolved = contentCatalog.resolveResource(`example$${relative}`, file.src, 'example', ['example'])
  } catch {
    return null
  }
  if (!resolved || !resolved.src || !resolved.contents) return null
  const first = (typeof block.getSourceLines === 'function' ? block.getSourceLines() : []).find((l) => String(l).trim())
  if (first !== undefined && !resolved.contents.toString('utf8').includes(String(first).trim())) return null
  return resolved.src
}

function sourceLinesOf (file) {
  try {
    return file && file.contents ? file.contents.toString('utf8').split(/\r\n?|\n/) : null
  } catch {
    return null
  }
}

// Everything under steps/ is per-step scaffolding, not a source a reader
// takes away: tools/capture-expected.sh writes captured output to a step's
// expected/ directory, and a step's commands.sh holds the tagged commands the
// page shows inline and Doc Detective runs. A Download control on either
// offers a file that only makes sense beside the harness that uses it, so
// nothing whose first path segment is `steps` is stamped. An expected/
// directory anywhere else is captured output too.
function isStepScaffolding (relative) {
  const segments = String(relative).split('/')
  return segments[0] === 'steps' || segments.includes('expected')
}

function register (registry, context = {}) {
  const file = context.file
  if (!file || !file.src || file.src.component !== SOLUTIONS_COMPONENT) return registry
  if (file.src.family && file.src.family !== 'page') return registry

  // One registration per document (Antora registers extensions per file), so
  // this map belongs to exactly one page.
  const stamped = new Map()

  registry.treeProcessor(function () {
    this.process((doc) => {
      const pageLines = sourceLinesOf(file)
      for (const block of doc.findBy({ context: 'listing' })) {
        let src = includedSrcOf(block)
        let directive = ''
        if (!src) {
          directive = nestedDirectiveLine(block, file, pageLines)
          src = directive ? nestedIncludedSrc(block, file, directive, context.contentCatalog) : null
        }
        if (!src || src.family !== EXAMPLE_FAMILY || !src.relative) continue
        if (isStepScaffolding(src.relative)) continue
        const marker = `${MARKER_PREFIX}${stamped.size + 1}`
        stamped.set(marker, { path: src.relative, tag: tagFromDirective(directive || includeDirectiveLine(block, file, pageLines)) })
        const role = block.getAttribute('role')
        block.setAttribute('role', [role, SNIPPET_ROLE, marker].filter(Boolean).join(' '))
      }
      return doc
    })
  })

  registry.postprocessor(function () {
    this.process((doc, output) => {
      if (!stamped.size) return output
      let html = output
      for (const [marker, { path, tag }] of stamped) {
        const classRx = new RegExp(`class="([^"]*?)\\s*\\b${marker}\\b\\s*([^"]*)"`)
        html = html.replace(classRx, (_match, before, after) => {
          const classes = `${before} ${after}`.replace(/\s+/g, ' ').trim()
          const tagAttr = tag ? ` data-solution-tag="${htmlEscape(tag)}"` : ''
          return `class="${classes}" data-solution-file="${htmlEscape(path)}"${tagAttr}`
        })
      }
      return html
    })
  })

  return registry
}

module.exports = {
  register,
  SNIPPET_ROLE,
  MARKER_PREFIX,
  tagFromDirective,
  htmlEscape,
  isStepScaffolding,
}
module.exports.register = register
