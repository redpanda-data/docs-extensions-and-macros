'use strict'

/**
 * Renders the `description` of every property in a
 * redpanda-properties-<tag>.json attachment to HTML at build time, with
 * Antora's own AsciiDoc loader and the site's own AsciiDoc config, and writes
 * the result to `description_html`.
 *
 * Why this exists
 * ---------------
 * Property descriptions are authored in AsciiDoc and shipped as JSON, so
 * something has to render them. The docs UI was doing it in the browser, with a
 * hand-written parser covering seven constructs: backticks, prop:, config_ref:,
 * glossterm:, link:, <<anchor>>, and xrefs pre-resolved by a regex extension.
 *
 * A whitelist of seven fails open. Everything else -- bold, italics, attribute
 * references, character replacements, bare URLs, any macro this repo adds next
 * -- reaches the reader as raw source, and nothing warns. In v26.2.1 that was 31
 * of 689 properties, including seven that displayed a literal
 * `include::reference:partial$internal-use-property.adoc[]` where an
 * internal-use warning or a breaking-change notice should have been.
 *
 * Converting here removes the whole class of defect rather than the instances:
 * Asciidoctor handles all of AsciiDoc, our own macros run as themselves (so
 * glossterm's positional attributes cannot drift from macros/glossary.js), and
 * a macro added next year works with no docs-ui change at all.
 *
 * Both fields ship. `description` stays because consumers read it -- including
 * docs-ui versions older than the one that prefers `description_html`, which
 * deploys separately. The output is minified to pay for the second field.
 */

const loadAsciiDoc = require('@antora/asciidoc-loader')
const { buildPageIndex, propertyAnchor } = require('../macros/prop')
const { raiseListenerLimit } = require('./util/raise-listener-limit')

const PROPERTIES_JSON_RX = /^redpanda-properties-(v\d+\.\d+\.\d+(?:-[\w.]+)?)\.json$/
// <<anchor>> and <<anchor,display text>>, as authored in the description.
const INTERNAL_REF_RX = /<<([^,<>\s]+)(?:,\s*([^<>]*?))?>>/g

module.exports.register = function () {
  raiseListenerLimit(this)
  const logger = this.getLogger('render-property-descriptions')

  // documentsConverted, not contentClassified: page aliases and the rest of
  // what page conversion relies on are only fully registered by then. Hooking
  // earlier left an xref to an aliased page rendering as
  // class="xref unresolved" while the same xref resolved fine on a real page.
  // Attachments are still published after this event.
  this.once('documentsConverted', ({ contentCatalog, siteAsciiDocConfig }) => {
    const attachments = (contentCatalog.findBy({ family: 'attachment' }) || []).filter(
      (file) => file.src.module === 'reference' && PROPERTIES_JSON_RX.test(basename(file))
    )
    if (!attachments.length) return

    for (const attachment of attachments) {
      const where = `${attachment.src.component}@${attachment.src.version || 'unversioned'}`
      let data
      try {
        data = JSON.parse(attachment.contents.toString())
      } catch (error) {
        // Left as-is: the prop macro reports an unusable dataset with the detail,
        // and failing the build over one bad attachment helps nobody.
        logger.warn(`${where}: ${basename(attachment)} is not valid JSON, descriptions not rendered (${error.message})`)
        continue
      }
      const properties = data && data.properties
      if (!properties || typeof properties !== 'object' || Array.isArray(properties)) continue

      // Convert "as" a real page rather than a fabricated one. A hand-built
      // file.pub is missing fields Antora's resolver needs, and resolving an
      // xref to another module then throws instead of resolving.
      const hostPage = findHostPage(contentCatalog, attachment)
      if (!hostPage) {
        logger.debug(`${where}: no reference page to convert descriptions as, skipped`)
        continue
      }
      const anchors = anchorIndex(contentCatalog, attachment, properties)

      let rendered = 0
      let failed = 0
      const brokenAnchors = new Set()
      for (const [name, entry] of Object.entries(properties)) {
        const description = entry && entry.description
        if (typeof description !== 'string' || !description.trim()) continue
        try {
          const source = resolveInternalRefs(description, anchors, (anchor) => brokenAnchors.add(anchor))
          const html = render(source, hostPage, contentCatalog, siteAsciiDocConfig)
          if (html == null) continue
          entry.description_html = html
          rendered++
        } catch (error) {
          // One description that will not convert must not cost the other 680.
          failed++
          logger.warn(`${where} ${name}: description could not be converted, so its tooltip falls back to the raw source (${error.message})`)
        }
      }

      if (rendered) attachment.contents = Buffer.from(JSON.stringify(data))
      logger.info(`${where}: rendered ${rendered} property descriptions to HTML${failed ? `, ${failed} failed` : ''}`)
      if (brokenAnchors.size) {
        logger.warn(
          `${where}: ${brokenAnchors.size} <<anchor>> reference(s) in property descriptions name no documented property, so they render as plain text: ` +
          `${[...brokenAnchors].sort().join(', ')}. Property anchors replace dots with hyphens, so redpanda.storage.mode is <<redpanda-storage-mode>>. ` +
          'Fix them in the description or in docs-data/property-overrides.json.'
        )
      }
    }
  })
}

function basename (file) {
  return file.src.relative.split('/').pop()
}

/**
 * A real page in the attachment's own component and reference module, preferring
 * one under properties/ so includes and relative xrefs resolve from where the
 * property docs actually live.
 */
function findHostPage (contentCatalog, attachment) {
  const pages = contentCatalog.findBy({
    component: attachment.src.component,
    version: attachment.src.version,
    family: 'page',
  }) || []
  return (
    pages.find((f) => f.src.module === 'reference' && /^properties\//.test(f.src.relative)) ||
    pages.find((f) => f.src.module === 'reference') ||
    undefined
  )
}

/**
 * anchor -> xref target, for the <<anchor>> references that point at another
 * documented property. Built from the same page index the prop macro links
 * with, so a description and a prop: call agree about which page documents what.
 */
function anchorIndex (contentCatalog, attachment, properties) {
  const index = new Map()
  let pages
  try {
    pages = buildPageIndex(contentCatalog, attachment.src.component, properties, attachment.src.version)
  } catch (error) {
    return index
  }
  for (const [name, entry] of pages) {
    if (!entry || !entry.page) continue
    index.set(propertyAnchor(name), { page: entry.page, name })
  }
  return index
}

/**
 * Rewrite <<anchor>> to an xref before conversion.
 *
 * Asciidoctor renders <<anchor>> as a same-page fragment link, which is right
 * on the reference page and wrong in a tooltip: a tooltip is shown on an
 * arbitrary page, where that fragment does not exist. Pointing it at the page
 * that documents the property keeps the link working wherever the tooltip
 * appears, and lets Antora resolve the URL rather than us building one.
 */
function resolveInternalRefs (description, anchors, report) {
  return description.replace(INTERNAL_REF_RX, (match, anchor, display) => {
    const text = (display || '').trim()
    const target = anchors.get(anchor)
    if (target) return `xref:reference:${target.page}.adoc#${anchor}[${text || `\`${target.name}\``}]`
    // The anchor names no documented property, so there is nothing to link to.
    // Asciidoctor would render a same-page fragment, and a tooltip is shown on
    // arbitrary pages, so that link would go nowhere and still invite a click --
    // the same reasoning the prop macro applies to a page it cannot verify.
    // Render the text and report the anchor so it gets fixed at the source.
    report(anchor)
    return text || `\`${anchor}\``
  })
}

/** Convert one description with the site's converter, as the host page. */
function render (source, hostPage, contentCatalog, siteAsciiDocConfig) {
  const file = {
    contents: Buffer.from(source),
    mediaType: 'text/asciidoc',
    src: { ...hostPage.src },
    pub: { ...hostPage.pub },
  }
  // relativizeResourceRefs: false gives site-root-relative URLs. The default
  // computes them relative to the converting file, which is wrong for a tooltip
  // shown on some other page.
  const doc = loadAsciiDoc(file, contentCatalog, { ...siteAsciiDocConfig, relativizeResourceRefs: false })
  const blocks = doc.getBlocks()
  if (!blocks.length) return doc.convert() || null
  // A single paragraph gives inline HTML with no <p> wrapper, which is what a
  // tooltip wants. Anything richer -- an included admonition, a list, several
  // paragraphs -- keeps its block markup, and the UI styles it.
  if (blocks.length === 1 && blocks[0].getContext() === 'paragraph') return blocks[0].getContent()
  return doc.convert()
}
