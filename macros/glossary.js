'use strict'

const $glossaryContexts = Symbol('$glossaryContexts')
const { posix: path } = require('path')
const logger = require('@antora/logger')('glossary-macro')
const { escapeHtml } = require('../extension-utils/html-utils')

// Backtick-monospace in hover-text. The unconstrained (double-backtick) form is
// matched first, otherwise it leaves a stray delimiter on each side.
const MONOSPACE_RX = /``([^`]+)``|`([^`]+)`/g

// Only a data-* tooltip is read by a JS tooltip library that renders it as HTML;
// the native title attribute is always plain text. Shared with the
// glossary-tooltip validation below so the two cannot drift apart.
function tooltipRendersHtml (tooltipAttr) {
  return typeof tooltipAttr === 'string' && tooltipAttr.startsWith('data-')
}

// hover-text is raw, unconverted source text, so it has to be escaped before it
// lands in an HTML attribute. How many passes depends on the consumer:
//
//   title   The browser decodes the attribute once and shows the result as
//           text, so one pass is exactly right.
//   data-*  docs-ui initializes tippy on these with allowHTML: true
//           (docs-ui/src/js/12-activate-tooltips.js), which means the value is
//           decoded once by the HTML parser and then parsed AGAIN as HTML by
//           innerHTML. A single pass is spent on that first decode and escaped
//           markup comes back to life -- `<img onerror=...>` in hover-text
//           became a live element that fired. Escape twice so one level
//           survives the decode, and add <code> afterwards so it is the only
//           live markup in the value.
//
// Set definitionIsHtml for a definition that Asciidoctor already converted --
// the inline glossterm:term[definition] form arrives as HTML, unlike a term
// file's raw :hover-text: value -- so it is escaped once rather than twice and
// its markup survives to the reader instead of being shown as literal tags.
function formatTooltipDefinition (text, tooltipAttr, definitionIsHtml) {
  if (!tooltipRendersHtml(tooltipAttr)) return escapeHtml(text)
  if (definitionIsHtml) {
    // Already HTML, so one pass is right: the attribute decode hands the markup
    // back intact for innerHTML to render, and a quote in the text still cannot
    // terminate the attribute early.
    return escapeHtml(text)
  }
  return escapeHtml(escapeHtml(text)).replace(
    MONOSPACE_RX,
    (match, unconstrained, constrained) =>
      `<code>${unconstrained !== undefined ? unconstrained : constrained}</code>`
  )
}

module.exports.register = function (registry, config = {}) {

  const vfs = adaptVfs()

  function adaptVfs () {
    function getKey (src) {
      return `${src.version}@${src.component}`
    }
    const contentCatalog = config.contentCatalog
    if (!contentCatalog[$glossaryContexts]) contentCatalog[$glossaryContexts] = {}
    const glossaryContexts = contentCatalog[$glossaryContexts]
    // Check if the terms have been cached
    const sharedKey = 'sharedTerms'
    if (!glossaryContexts[sharedKey]) {
      // Get the term files from the 'shared' component
      const termFiles = contentCatalog.findBy({ component: 'shared', module: 'terms', family: 'partial' })
      // Extract the term definitions from the files
      const ATTRIBUTE_REGEX = /^:([a-zA-Z0-9_-]+):[ \t]*(.*)$/gm

      const termMap = new Map();

      const terms = termFiles.map(file => {
        const content = file.contents.toString()
        // Split content by lines and get the first non-empty line as the title
        const lines = content.split('\n').map(line => line.trim())
        const firstNonEmptyLine = lines.find(line => line.length > 0)
        // Remove leading '=' characters (AsciiDoc syntax) and trim whitespace
        const pageTitle = firstNonEmptyLine ? firstNonEmptyLine.replace(/^=+\s*/, '') : '#'
        const attributes = {}

        let match
        while ((match = ATTRIBUTE_REGEX.exec(content)) !== null) {
          const [ , name, value ] = match
          attributes[name] = value
        }

        if (!attributes['term-name'] || !attributes['hover-text']) {
          logger.warn(`Skipping term ${file.path} due to missing 'term-name' and/or 'hover-text attributes'.`)
          return null
        }

        if (termMap.has(attributes['term-name'])) {
          throw new Error(`Error: Duplicate term-name '${attributes['term-name']}' found in ${file.src.fileUri || file.src.editUrl}.`);
        }

        termMap.set(attributes['term-name'], true);

        const termObject = {
          term: attributes['term-name'],
          def: attributes['hover-text'],
          category: attributes['category'] || '',
          pageTitle,
          content
        }

        if (attributes['link'] && attributes['link'].trim() !== '') {
          termObject.link = attributes['link']
        }

        return termObject
      }).filter(Boolean)

      // Store the terms in the cache
      glossaryContexts[sharedKey] = terms
    }
    const key = getKey(config.file.src)
    if (!glossaryContexts[key]) {
      glossaryContexts[key] = {
        gloss: glossaryContexts[sharedKey],
        self: undefined,
      }
    }
    const context = glossaryContexts[key]
    return {
      getContext: () => context,
    }
  }

  // Characters to replace by '-' in generated idprefix
  const IDRX = /[\/ _.-]+/g

  function termId(term) {
    // Remove brackets before replacing other characters
    const noBracketsTerm = term.replace(/[\[\]\(\)]/g, '') // Remove brackets
    return noBracketsTerm.toLowerCase().replace(IDRX, '-')
  }


  const TRX = /(<[a-z]+)([^>]*>.*)/

  function glossaryInlineMacro () {
    return function () {
      const self = this
      self.named('glossterm')
      //Specifying the regexp allows spaces in the term.
      self.$option('regexp', /glossterm:([^[]+)\[(|.*?[^\\])\]/)
      self.positionalAttributes(['definition', 'customText']); // Allows for specifying custom link text
      self.process(function (parent, target, attributes) {
        const term = attributes.term || target
        const customText = attributes.customText || term;
        const document = parent.document
        const context = vfs.getContext()
        const customLinkCandidate = context.gloss.find(candidate => 'link' in candidate && candidate.term === term);
        let customLink;
        if (customLinkCandidate) {
          customLink = customLinkCandidate.link;
        }
        var tooltip = document.getAttribute('glossary-tooltip')
        if (tooltip === 'true') tooltip = 'data-glossary-tooltip'
        if (tooltip && tooltip !== 'title' && !tooltipRendersHtml(tooltip)) {
          logger.warn(`glossary-tooltip attribute '${tooltip}' must be 'true', 'title', or start with 'data-`)
          tooltip = undefined
        }
        const logTerms = document.hasAttribute('glossary-log-terms')
        var definition;
        var pageTitle;
        // A term file's :hover-text: is raw source text, but the definition
        // passed inline as glossterm:term[definition] has already been through
        // Asciidoctor's inline substitutions, so the two need different escaping.
        var definitionIsHtml = false;
        const index = context.gloss.findIndex((candidate) => candidate.term === term)
        if (index >= 0) {
          definition = context.gloss[index].def
          pageTitle = context.gloss[index].pageTitle
        } else {
          definition = attributes.definition;
          definitionIsHtml = !!definition;
        }
        if (definition) {
          logTerms && logger.info(`${term}:: ${definition}`)
        } else if (tooltip) {
          definition = `${term} not yet defined`
        }
        const links = document.getAttribute('glossary-links', 'true') === 'true'
        var glossaryPage = document.getAttribute('glossary-page', '')
        if (glossaryPage.endsWith('.adoc')) {
          const page = config.contentCatalog.resolvePage(glossaryPage, config.file.src)
          if (page && config.config.attributes['site-url']) {
            glossaryPage = config.config.attributes['site-url'] + page.pub.url
          } else if (page) {
            glossaryPage = path.relative(path.dirname(config.file.pub.url), page.pub.url)
          }
        }
        const glossaryTermRole = document.getAttribute('glossary-term-role', 'glossary-term')
        const attrs = glossaryTermRole ? { role: glossaryTermRole } : {}
        var inline;
        const termExistsInContext = context.gloss.some((candidate) => candidate.term === term);
        if ((termExistsInContext && links) || (links && customLink)) {
          inline = customLink
            ? self.createInline(parent, 'anchor', customText, { type: 'link', target: customLink, attributes: { ...attrs, window: '_blank', rel: 'noopener noreferrer' } })
            : self.createInline(parent, 'anchor', customText, { type: 'xref', target: `${glossaryPage}#${termId(pageTitle)}`, reftext: customText, attributes: attrs })
        } else {
          inline = self.createInline(parent, 'quoted', customText, { attributes: attrs })
        }
        if (tooltip) {
          const formattedDefinition = formatTooltipDefinition(definition, tooltip, definitionIsHtml)
          const a = inline.convert()
          const matches = a.match(TRX)
          if (matches) {
            return self.createInline(parent, 'quoted', `${matches[1]} ${tooltip}="${formattedDefinition}"${matches[2]}`)
          } else {
            return self.createInline(parent, 'quoted', `<span ${tooltip}="${formattedDefinition}">${a}</span>`)
          }
        }
        return inline
      })
    }
  }

  function doRegister (registry) {
    if (typeof registry.inlineMacro === 'function') {
      registry.inlineMacro(glossaryInlineMacro())
    } else {
      logger.warn('no \'inlineMacro\' method on alleged registry')
    }
  }

  if (typeof registry.register === 'function') {
    registry.register(function () {
      //Capture the global registry so processors can register more extensions.
      registry = this
      doRegister(registry)
    })
  } else {
    doRegister(registry)
  }
  return registry
}

module.exports.formatTooltipDefinition = formatTooltipDefinition
