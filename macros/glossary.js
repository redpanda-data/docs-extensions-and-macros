'use strict'

const $glossaryContexts = Symbol('$glossaryContexts')
const { posix: path } = require('path')
const chalk = require('chalk')

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
          console.warn(`Skipping term ${file.path} due to missing 'term-name' and/or 'hover-text attributes'.`)
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
        if (tooltip && tooltip !== 'title' && !tooltip.startsWith('data-')) {
          console.log(`glossary-tooltip attribute '${tooltip}' must be 'true', 'title', or start with 'data-`)
          tooltip = undefined
        }
        const logTerms = document.hasAttribute('glossary-log-terms')
        var definition;
        var pageTitle;
        const index = context.gloss.findIndex((candidate) => candidate.term === term)
        if (index >= 0) {
          definition = context.gloss[index].def
          pageTitle = context.gloss[index].pageTitle
        } else {
          definition = attributes.definition;
        }
        if (definition) {
          logTerms && console.log(`${term}:: ${definition}`)
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
          const a = inline.convert()
          const matches = a.match(TRX)
          if (matches) {
            return self.createInline(parent, 'quoted', `${matches[1]} ${tooltip}="${definition}"${matches[2]}`)
          } else {
            return self.createInline(parent, 'quoted', `<span ${tooltip}="${definition}">${a}</span>`)
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
      console.warn('no \'inlineMacro\' method on alleged registry')
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
