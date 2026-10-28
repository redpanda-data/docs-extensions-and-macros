'use strict'

/* The render guard for check-reference-values --write.
 *
 * A replacement is kept only when the line renders to the same visible text
 * before and after it, through real Asciidoctor and the real macros (prop.js
 * register), against the same catalog the scan selected its data from and
 * with the scanned file's own component and version. A macro that would
 * render a placeholder, or a value the writer's text did not say, reverts
 * the replacement.
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

/**
 * A guard function for one scan.
 *
 * @param {object} opts
 * @param {object} opts.catalog - The synthetic content catalog of the scan.
 * @param {string} opts.component
 * @param {string} opts.version
 * @returns {(file: string, original: string, replaced: string) => boolean}
 */
function makeRenderGuard ({ catalog, component, version }) {
  return (file, original, replaced) => {
    const module = (String(file).match(/^modules\/([^/]+)\//) || [])[1] || 'ROOT'
    const src = { component, version, module, path: file, relative: file }
    try {
      return visibleText(renderLine(original, { catalog, src })) === visibleText(renderLine(replaced, { catalog, src }))
    } catch (error) {
      // A macro that throws (an error-mode build) changes what renders.
      return false
    }
  }
}

module.exports = { makeRenderGuard, visibleText, renderLine }
