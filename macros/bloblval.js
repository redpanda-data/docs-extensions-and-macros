'use strict'

/* Inline macro for one value of a Bloblang function, method or parameter,
 * read from the published Connect data instead of typed by hand:
 *
 *   bloblval:[counter(min),default]       -> 1
 *   bloblval:[.replace_all(old),type]     -> string
 *   bloblval:[now(),status]               -> stable
 *   bloblval:[.uppercase(),description]   -> Converts all letters in a string to uppercase. ...
 *   bloblval:[.contains(),description,category=String Manipulation]
 *
 * The brackets hold the call as blobl: takes it: a function with its
 * parentheses, a method with its leading dot, and a parameter's name in the
 * parentheses. The next attribute is the field, named as every value macro
 * names it (extension-utils/value-fields.js). A method in two categories has
 * a description and examples per category: category= picks one, and the
 * default is the first copy on the methods page.
 *
 * Text longer than one paragraph, such as examples, renders only in the
 * block form, bloblval::[counter(),examples], on a line of its own.
 *
 * The data is the Connect data connectval: reads. On a Cloud page an impure
 * function renders a placeholder, as the Cloud reference leaves it out, and
 * so does introduced, which the reference shows only outside Cloud. Whenever
 * no verified value exists the macro renders <unknown FIELD> and says why,
 * according to connect-validate (warn, error or off). See
 * macros/REFERENCE.adoc.
 *
 * Registered by macros/prop, so every playbook that registers prop: has it.
 */

const bloblang = require('../extension-utils/bloblang-values')
const connectLinks = require('../extension-utils/connect-links')
const connectValues = require('../extension-utils/connect-values')
const datasets = require('../extension-utils/attachment-datasets')
const valueDescriptions = require('../extension-utils/value-descriptions')
const logger = require('@antora/logger')('bloblval-macro')

// Kinds that fail the build in error mode. Data gaps, including the corrupt
// defaults, never throw.
const THROW_KINDS = ['unknown-function', 'unknown-method', 'unknown-parameter', 'ambiguous-name', 'hidden', 'unknown-category', 'missing-field', 'unsupported-field', 'cloud-hidden', 'unavailable', 'needs-block', 'block-form-inline']

const RX = /\\?bloblval:(\S*?)\[((?:\\\]|[^\]])*?)\]/

const unescape = (value) => String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/**
 * Resolve one bloblval: or bloblval:: call on a page.
 */
function bloblvalCall (config, parent, target, attributes, { block = false } = {}) {
  const document = parent.getDocument()
  const mode = String(document.getAttribute('connect-validate', 'warn')).trim().toLowerCase()
  const src = (config && config.file && config.file.src) || {}
  const where = src.path ? ` in ${src.path}` : ''
  const positionals = attributes.$positional || []
  const written = unescape(positionals[0] == null ? '' : positionals[0]).trim()
  const positional = positionals.slice(1).find((value) => value != null)
  const requested = String(positional || 'default').trim()
  const category = attributes.category == null ? undefined : unescape(attributes.category).trim()
  const macro = `bloblval${block ? '::' : ':'}[${written}${positional != null ? `,${requested}` : ''}]`
  const base = { mode, written, requested, where, macro }
  if (!block && String(target).trim() === ':') {
    const field = bloblang.normalizeField(requested) || requested
    return { ...base, result: { ok: false, kind: 'block-form-inline', field, message: `bloblval::[${written}]${where}: bloblval:: is the block form, which renders only on a line of its own. In a sentence, write bloblval:[${written}${positional != null ? `,${requested}` : ''}].` } }
  }
  if (String(target).trim() !== '') {
    const field = bloblang.normalizeField(requested) || requested
    return { ...base, result: { ok: false, kind: 'unknown-function', field, message: `bloblval:${target}[...]${where}: write the call in the brackets, as in bloblval:[counter(min),default].` } }
  }
  let format = String(attributes.format || bloblang.FORMAT_HUMAN).trim().toLowerCase()
  if (format !== bloblang.FORMAT_HUMAN && format !== bloblang.FORMAT_RAW) {
    if (mode !== 'off') logger.warn(`${macro}${where}: format=${format} is not supported; use format=raw for true/false. Rendering the human-readable value.`)
    format = bloblang.FORMAT_HUMAN
  }
  const contentCatalog = config && config.contentCatalog
  let registry
  let cloud = false
  let categoryOrder
  if (contentCatalog) {
    registry = connectValues.loadConnect(contentCatalog)
    if (!registry && mode !== 'off') datasets.warnDatasetMissing(contentCatalog, connectValues.CONNECT_COMPONENT, '', connectValues.CONNECT_KIND)
    cloud = connectLinks.isCloud(contentCatalog, src.component, src.version)
    if (registry) categoryOrder = connectLinks.categoryOrder(contentCatalog, registry.data)
  }
  const result = bloblang.resolveBloblValue({ registry, call: written, field: requested, format, cloud, category, categoryOrder, filePath: src.path, macro })
  if (mode !== 'off') for (const warning of result.warnings || []) logger.warn(warning.message)
  // The strings are written for the functions or methods page: off it,
  // their links are rewritten as connectval: rewrites a component's.
  if (result.ok && result.rich && result.rich.format === 'asciidoc') {
    const moved = connectValues.relocateConnectRefs(result.rich.text, { home: connectLinks.BLOBLANG_PAGES[result.kind], homeModule: connectLinks.GUIDES_MODULE, src, cloud, contentCatalog })
    if (moved.unlinked.length && mode !== 'off') {
      logger.warn(`${result.call}: the ${result.field} links ${moved.unlinked.join(', ')}, which ${cloud ? 'this Cloud page' : 'this build'} has no page for, so ${moved.unlinked.length === 1 ? 'that link renders' : 'those links render'} as text.`)
    }
    return { ...base, result: { ...result, rich: { ...result.rich, text: moved.text } } }
  }
  return { ...base, result }
}

function report (mode, result) {
  if (mode === 'error' && THROW_KINDS.includes(result.kind)) throw new Error(result.message)
  logger.warn(result.message)
}

const fieldLabel = (result, requested) => (result.ok && result.invert ? requested.toLowerCase() : result.field)

function bloblvalInlineMacro (config) {
  return function () {
    const self = this
    self.named('bloblval')
    self.match(RX)
    self.process(function (parent, target, attributes) {
      const { mode, written, requested, where, macro, result } = bloblvalCall(config, parent, target, attributes)
      const content = (extra) => self.createInline(parent, 'quoted', bloblang.buildBloblvalContent({ call: written, field: fieldLabel(result, requested), ...extra }))
      if (result.ok && result.rich) {
        const html = valueDescriptions.richInlineHtml(parent, result.rich)
        if (html !== undefined) return content({ html })
        report(mode, { kind: 'needs-block', message: `${macro}${where}: the ${result.field} value is more than one paragraph, which has no inline form, so it renders <unknown ${result.field}>. Use the block form on a line of its own: bloblval::[${written},${result.field}].` })
        return content({ unknown: true })
      }
      if (result.ok) return content({ text: result.text, html: result.html })
      report(mode, result)
      return content({ unknown: true })
    })
  }
}

/**
 * bloblval::[<call>,<field>], the block form, for text longer than one
 * paragraph: a description or the examples, parsed into the page.
 */
function bloblvalBlockMacro (config) {
  return function () {
    const self = this
    self.named('bloblval')
    self.process(function (parent, target, attributes) {
      const { mode, written, requested, result } = bloblvalCall(config, parent, target, attributes, { block: true })
      const html = (extra) => bloblang.buildBloblvalContent({ call: written, field: fieldLabel(result, requested), ...extra })
      if (result.ok && result.rich) return valueDescriptions.richBlock(self, parent, result.rich, `bloblang-value bloblang-value-${result.field}`)
      if (result.ok) return valueDescriptions.htmlParagraph(self, parent, html({ text: result.text, html: result.html }))
      report(mode, result)
      return valueDescriptions.htmlParagraph(self, parent, html({ unknown: true }))
    })
  }
}

module.exports.bloblvalInlineMacro = bloblvalInlineMacro
module.exports.bloblvalBlockMacro = bloblvalBlockMacro
module.exports.THROW_KINDS = THROW_KINDS
