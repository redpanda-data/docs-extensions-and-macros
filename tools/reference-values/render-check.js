'use strict'

/* The render guard for check-reference-values --write.
 *
 * A replacement is kept only when the line renders to the same visible text
 * before and after it, through real Asciidoctor and the real macros (prop.js
 * register), against the same catalog the scan selected its data from and
 * with the scanned file's own component and version. A macro that would
 * render a placeholder, or a value the writer's text did not say, reverts
 * the replacement. A rename (an alias or a deprecated name rewritten to the
 * main or replacement name, names.js) may change the line only where the
 * renamed text renders.
 */

const { register } = require('../../macros/prop')

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&', '&#8217;': '’', '&#8216;': '‘', '&#8220;': '“', '&#8221;': '”', '&#8230;': '…', '&#8203;': '' }

/**
 * The visible text of rendered HTML: tags stripped, entities decoded,
 * whitespace collapsed.
 */
function visibleText (html) {
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:lt|gt|quot|amp|#39|#82(?:17|16|20|21|30|03));/g, (e) => ENTITIES[e])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

let asciidoctor
const processor = () => asciidoctor || (asciidoctor = require('@asciidoctor/core')())

/**
 * Render one line as a document fragment.
 */
function renderLine (line, { catalog, src }) {
  const Asciidoctor = processor()
  const registry = Asciidoctor.Extensions.create()
  register(registry, { contentCatalog: catalog, file: { src } })
  return Asciidoctor.convert(line, { extension_registry: registry, safe: 'safe' })
}

// The link targets of rendered HTML, sorted.
const hrefs = (html) => [...String(html).matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1]).sort()

/**
 * Whether a rename renders as expected: the line renders as before, except
 * that where the written text rendered, the proposed text's rendering
 * appears (rpk cluster status becomes rpk cluster info; a value read through
 * an alias stays the same value), with no placeholder in it. links 'same'
 * also requires the same link targets: an alias links its main name's page
 * already.
 */
function renamedAsExpected ({ original, replaced, rename, render }) {
  const before = visibleText(render(original))
  const after = visibleText(render(replaced))
  const from = visibleText(render(rename.before))
  const to = visibleText(render(rename.after))
  if (/<unknown [\w-]+>/.test(to)) return false
  if (rename.links === 'same' && hrefs(render(original)).join('\n') !== hrefs(render(replaced)).join('\n')) return false
  if (after === before && from === to) return true
  if (!from) return false
  for (let at = before.indexOf(from); at !== -1; at = before.indexOf(from, at + 1)) {
    if (before.slice(0, at) + to + before.slice(at + from.length) === after) return true
  }
  return false
}

/**
 * A guard function for one scan.
 *
 * @param {object} opts
 * @param {object} opts.catalog - The synthetic content catalog of the scan.
 * @param {string} opts.component
 * @param {string} opts.version
 * @returns {(file: string, original: string, replaced: string, rename?: {before: string, after: string, links: 'same'|'any'}) => boolean}
 *   rename: the replacement writes another name on purpose (names.js), so
 *   the line may render differently, but only as renamedAsExpected allows.
 */
function makeRenderGuard ({ catalog, component, version }) {
  return (file, original, replaced, rename) => {
    const module = (String(file).match(/^modules\/([^/]+)\//) || [])[1] || 'ROOT'
    const src = { component, version, module, path: file, relative: file }
    const render = (line) => renderLine(line, { catalog, src })
    try {
      if (rename) return renamedAsExpected({ original, replaced, rename, render })
      return visibleText(render(original)) === visibleText(render(replaced))
    } catch (error) {
      // A macro that throws (an error-mode build) changes what renders.
      return false
    }
  }
}

module.exports = { makeRenderGuard, visibleText, renderLine, renamedAsExpected }
