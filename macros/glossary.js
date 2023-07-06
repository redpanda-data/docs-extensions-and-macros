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

      const terms = termFiles.map(file => {
        const content = file.contents.toString()
        const attributes = {}

        let match
        while ((match = ATTRIBUTE_REGEX.exec(content)) !== null) {
          const [ , name, value ] = match
          attributes[name] = value
        }

        if (!attributes['term-name'] || !attributes['hover-text']) {
          console.warn(`Skipping file ${file.path} due to missing 'term-name' and/or 'hover-text'.`)
          return null
        }

        return {
          term: attributes['term-name'],
          def: attributes['hover-text'],
          content
        }
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

  //characters to replace by '_' in generated idprefix
  const IDRX = /[/ _.-]+/g

  function termId (term) {
    return term.toLowerCase().replace(IDRX, '-')
  }

  const TRX = /(<[a-z]+)([^>]*>.*)/

  function glossaryInlineMacro () {
    return function () {
      const self = this
      self.named('glossterm')
      //Specifying the regexp allows spaces in the term.
      self.$option('regexp', /glossterm:([^[]+)\[(|.*?[^\\])\]/)
      self.positionalAttributes(['definition'])
      self.process(function (parent, target, attributes) {
        const term = attributes.term || target
        const document = parent.document
        const context = vfs.getContext()
        const localTerms = document.getAttribute("local-terms") || [];
        const localTermData = (localTerms || []).find((t) => t.term === term) || {};
        const customLink = localTermData.link;
        var tooltip = document.getAttribute('glossary-tooltip')
        if (tooltip === 'true') tooltip = 'data-glossary-tooltip'
        if (tooltip && tooltip !== 'title' && !tooltip.startsWith('data-')) {
          console.log(`glossary-tooltip attribute '${tooltip}' must be 'true', 'title', or start with 'data-`)
          tooltip = undefined
        }
        const logTerms = document.hasAttribute('glossary-log-terms')
        var definition;
        const index = context.gloss.findIndex((candidate) => candidate.term === term)
        if (index >= 0) {
          definition = context.gloss[index].def
        } else {
          definition = localTermData.definition || attributes.definition;
        }
        if (definition) {
          logTerms && console.log(`${term}::  ${definition}`)
        } else if (tooltip) {
          definition = `${term} not yet defined`
        }
        const links = document.getAttribute('glossary-links', 'true') === 'true'
        var glossaryPage = document.getAttribute('glossary-page', '')
        if (glossaryPage.endsWith('.adoc')) {
          const page = config.contentCatalog.resolvePage(glossaryPage, config.file.src)
          const relativizedPath = path.relative(path.dirname(config.file.pub.url), page.pub.url)
          const prefix = attributes.prefix
          glossaryPage = prefix ? [prefix, relativizedPath].join('/') : relativizedPath
        }
        const glossaryTermRole = document.getAttribute('glossary-term-role', 'glossary-term')
        const attrs = glossaryTermRole ? { role: glossaryTermRole } : {}
        var inline;
        const termExistsInContext = context.gloss.some((candidate) => candidate.term === term);
        if ((termExistsInContext && links) || (links && customLink)) {
          inline = customLink
            ? self.createInline(parent, 'anchor', target, { type: 'link', target: customLink, attributes: attrs })
            : self.createInline(parent, 'anchor', target, { type: 'xref', target: `${glossaryPage}#${termId(term)}`, reftext: target, attributes: attrs })
        } else {
          inline = self.createInline(parent, 'quoted', target, { attributes: attrs })
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
