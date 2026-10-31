'use strict'

/* Inline macro for a Bloblang function or method, written as Bloblang calls
 * it and linked to its entry in the Bloblang reference:
 *
 *   blobl:[now()]                                   -> `now()`, linked to functions#now
 *   blobl:[.uppercase()]                            -> `.uppercase()`, linked to methods#uppercase
 *   blobl:[counter(min)]                            -> `counter(min)`, linked to functions#counter
 *   blobl:[.contains(),category=String Manipulation] -> linked to methods#contains-2
 *   blobl:[.fold(),`fold` method]                   -> `fold` method, linked
 *
 * A leading dot makes a method, parentheses without one a function, and a
 * name in the parentheses a parameter, which has no anchor of its own, so
 * it links its function. contains, length and slice are each in two
 * categories with a copy under each on the methods page: category= picks
 * one, and the default is the first copy on the page. The call renders as
 * inline code exactly as written; the next attribute, or text=, replaces it.
 *
 * The call is checked against the Bloblang lists of the Connect data
 * connectval: reads, and the page is found in the content catalog as
 * connect: finds component pages (extension-utils/connect-links.js). On a
 * Cloud page an impure function (count, env, file, file_rel, hostname),
 * which the Cloud reference leaves out, renders plain code. An unknown or
 * hidden name, or no page, renders plain code with no link and says why,
 * according to connect-validate (warn, error or off). A deprecated function
 * or method still links its entry, which documents it, and warns. See
 * macros/REFERENCE.adoc.
 *
 * Registered by macros/prop, so every playbook that registers prop: has it.
 */

const connectLinks = require('../extension-utils/connect-links')
const connectValues = require('../extension-utils/connect-values')
const bloblang = require('../extension-utils/bloblang-values')
const datasets = require('../extension-utils/attachment-datasets')
const { escapeHtml } = require('../extension-utils/html-utils')
const logger = require('@antora/logger')('blobl-macro')

// Kinds that fail the build in error mode: authoring errors.
const THROW_KINDS = ['unknown-function', 'unknown-method', 'unknown-parameter', 'ambiguous-name', 'hidden', 'unknown-category']

const ROLE = 'bloblang-call'

const unescape = (value) => String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/**
 * The HTML inside the link, or the whole output when there is no link.
 */
function buildBloblContent ({ written, name, kind, text, plain = false }) {
  if (text) return text
  if (plain) return `<code>${escapeHtml(written)}</code>`
  return `<code class="${ROLE}" data-bloblang-${kind}="${escapeHtml(name)}">${escapeHtml(written)}</code>`
}

function bloblInlineMacro (config) {
  return function () {
    const self = this
    self.named('blobl')
    self.option('format', 'short')
    self.positionalAttributes(['call', 'text'])
    self.process(function (parent, target, attributes) {
      const document = parent.getDocument()
      const mode = String(document.getAttribute('connect-validate', 'warn')).trim().toLowerCase()
      const src = (config && config.file && config.file.src) || {}
      const filePath = src.path
      const written = unescape(attributes.call == null ? '' : attributes.call).trim()
      const text = attributes.text == null ? undefined : String(attributes.text)
      const category = attributes.category == null ? undefined : unescape(attributes.category).trim()
      const call = `blobl:[${written}]${filePath ? ` in ${filePath}` : ''}`

      const plain = (message, kind) => {
        if (mode === 'error' && THROW_KINDS.includes(kind)) throw new Error(message)
        if (mode !== 'off') logger.warn(message)
        return self.createInline(parent, 'quoted', buildBloblContent({ written, text, plain: true }))
      }

      const parsed = bloblang.parseCall(written)
      if (!parsed.ok) return plain(`${call}: '${written}' is not a Bloblang call; write a function as now() and a method as .uppercase().`, 'unknown-function')
      const contentCatalog = config && config.contentCatalog
      if (!contentCatalog) return plain(`${call}: no content catalog, so the call cannot be checked or linked; it renders as plain code.`, 'no-data')
      const registry = connectValues.loadConnect(contentCatalog)
      if (!registry) {
        if (mode !== 'off') datasets.warnDatasetMissing(contentCatalog, connectValues.CONNECT_COMPONENT, '', connectValues.CONNECT_KIND)
        return plain(`${call}: this build has no Connect data to check '${written}' against (see the connectval macro warning), so it renders as plain code with no link.`, 'no-data')
      }
      const dataset = datasets.describeDataset(registry)
      const resolved = bloblang.resolveCall(registry.data, parsed)
      if (!resolved.ok) {
        const hint = resolved.suggestions.length ? ` Did you mean: ${resolved.suggestions.join(', ')}?` : ''
        return plain(`${call}: ${resolved.message} in ${dataset}, so it renders as plain code with no link.${hint}`, resolved.kind)
      }
      const { kind, entry } = resolved
      const what = bloblang.callText(kind, entry.name)
      const picked = bloblang.pickCategory(kind, entry, category, connectLinks.categoryOrder(contentCatalog, registry.data))
      if (!picked.ok) return plain(`${call}: ${picked.message} in ${dataset}, so it renders as plain code with no link.`, 'unknown-category')
      const cloud = connectLinks.isCloud(contentCatalog, src.component, src.version)
      if (cloud && bloblang.cloudHiddenEntry(kind, entry)) {
        return plain(`${call}: ${what} is impure, and the Cloud Bloblang reference leaves impure functions out, so it renders as plain code with no link on this Cloud page. Put the sentence in an ifndef::env-cloud[] block.`, 'cloud-no-page')
      }
      const relative = connectLinks.BLOBLANG_PAGES[kind]
      const page = connectLinks.pickConnectPage(contentCatalog, { component: src.component, version: src.version, module: connectLinks.GUIDES_MODULE, relative, cloud })
      if (!page.ok) {
        const where = `${src.component || 'unknown component'}@${src.version || 'unversioned'}`
        const why = page.reason === 'cloud-no-page'
          ? `${where} has no Bloblang ${kind}s page (guides:${relative}), and a Cloud page links only Cloud pages`
          : `no component in this build has the Bloblang ${kind}s page (guides:${relative})`
        return plain(`${call}: ${why}, so it renders as plain code with no link.`, 'no-page')
      }
      // A deprecated function or method is still on its page, so it links;
      // the Connect data names no replacement for any of them.
      if (entry.status === 'deprecated' && mode !== 'off') logger.warn(`${call}: ${bloblang.deprecationNote(kind, entry, dataset)}`)
      const fragment = connectLinks.bloblangAnchor(entry, picked)
      const content = buildBloblContent({ written, name: entry.name, kind, text })
      return self.createInline(parent, 'anchor', content, {
        type: 'xref',
        target: `#${page.id}`,
        attributes: { path: page.id, fragment },
      })
    })
  }
}

module.exports.bloblInlineMacro = bloblInlineMacro
module.exports.buildBloblContent = buildBloblContent
module.exports.THROW_KINDS = THROW_KINDS
