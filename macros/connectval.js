'use strict'

/* Inline macro for one value of a Redpanda Connect component or config
 * field, read from the published Connect data instead of typed by hand:
 *
 *   connectval:[inputs/redpanda.client_id]                          -> redpanda-connect
 *   connectval:[inputs/postgres_cdc.incremental_snapshot.chunk_size] -> 1024
 *   connectval:[outputs/iceberg.merge_strategy,values]              -> merge-on-read, copy-on-write
 *   connectval:[config.pipeline.threads]                            -> -1
 *   connectval:[inputs/kafka_franz,status]                          -> deprecated
 *
 * The brackets start with <type>/<name> as the rp-connect-docs paths write
 * it, or config for the root fields, then the dot-separated field path; an
 * array of objects is addressed without an index (sasl.mechanism). With no
 * field path, the call reads a field of the component itself. The next
 * attribute is the field (default when omitted), named as every value macro
 * names it (extension-utils/value-fields.js) and formatted exactly as the
 * generated component reference prints it.
 *
 * The first form is still accepted: the field path as the target and the
 * component in component=, as in connectval:client_id[component=inputs/redpanda].
 *
 * A string longer than one paragraph, such as most descriptions, renders only
 * in the block form, connectval::[inputs/kafka_franz.consumer_group,description]
 * on a line of its own. Strings are AsciiDoc, or Markdown when the data says
 * docs_format: markdown, and their links are rewritten when they render off
 * their component's page (relocateConnectRefs in connect-values.js).
 *
 * The data is the newest connect-<version>.json in the connect component's
 * components module, whatever component the page is in: Connect versions are
 * Connect's own, so a page's version never selects one. On a Cloud page
 * (env-cloud) a component that is not available in Cloud renders a
 * placeholder. Whenever no verified value exists the macro renders
 * <unknown FIELD> and says why, according to connect-validate (warn, error or
 * off). A former name (a component path the connect docs alias to another
 * component's page) reads that component and warns with its name; a
 * deprecated component or field reads its own value and warns with its
 * replacement when the data names one. See macros/REFERENCE.adoc.
 *
 * Registered by macros/prop, so every playbook that registers prop: has it.
 */

const connectValues = require('../extension-utils/connect-values')
const connectLinks = require('../extension-utils/connect-links')
const datasets = require('../extension-utils/attachment-datasets')
const valueDescriptions = require('../extension-utils/value-descriptions')
const logger = require('@antora/logger')('connectval-macro')

// Kinds that fail the build in error mode. Data gaps never throw.
const THROW_KINDS = ['unknown-type', 'unknown-component', 'unknown-field', 'missing-field', 'unsupported-field', 'cloud-hidden', 'unavailable', 'needs-block', 'block-form-inline']

// The macro's own pattern: the default needs a target, and this one also
// matches the bracket form, connectval:[inputs/kafka_franz.consumer_group],
// whose target is empty.
const CONNECTVAL_RX = /\\?connectval:(\S*?)\[((?:\\\]|[^\]])*?)\]/

// The translated catalog rows generate-rp-connect-info sets on the connect
// component's latest version at contentClassified, when the build has them.
function csvRowsOf (contentCatalog) {
  if (typeof contentCatalog.getComponent !== 'function') return undefined
  const connect = contentCatalog.getComponent(connectValues.CONNECT_COMPONENT)
  const csv = connect && connect.latest && connect.latest.asciidoc && connect.latest.asciidoc.attributes && connect.latest.asciidoc.attributes.csvData
  return csv && Array.isArray(csv.data) ? csv.data : undefined
}

/**
 * Resolve one connectval: or connectval:: call on a page, the part the inline
 * and block forms share.
 */
function connectvalCall (config, parent, target, attributes, { block = false } = {}) {
  const document = parent.getDocument()
  const mode = String(document.getAttribute('connect-validate', 'warn')).trim().toLowerCase()
  const src = (config && config.file && config.file.src) || {}
  const filePath = src.path
  const positionals = attributes.$positional || []
  // connectval::[...] in a sentence reaches the inline macro with the second
  // colon as its target.
  const misplaced = !block && String(target).trim() === ':'
  // The bracket form: the component and field path first, then the field.
  const bracket = misplaced || String(target).trim() === ''
  const first = bracket ? String(positionals[0] == null ? '' : positionals[0]).trim() : ''
  // Asciidoctor fills field from the first slot only, so a field written
  // after component= arrives as a later positional.
  const positional = bracket ? positionals.slice(1).find((value) => value != null) : positionals.find((value) => value != null)
  const requested = String((bracket ? positional : attributes.field || positional) || 'default').trim()
  const parsed = bracket ? connectValues.parseFieldTarget(first) : { component: attributes.component, path: String(target).trim() }
  const { component, path } = parsed
  const macro = bracket ? `connectval${block ? '::' : ':'}[${first}${positional != null ? `,${requested}` : ''}]` : undefined
  let format = String(attributes.format || connectValues.FORMAT_HUMAN).trim().toLowerCase()
  const where = filePath ? ` in ${filePath}` : ''
  const componentText = String(component == null ? '' : component).trim()
  const base = { mode, component: componentText, path, requested, src, where }
  if (misplaced) {
    const field = connectValues.normalizeField(requested) || requested
    return { ...base, result: { ok: false, kind: 'block-form-inline', field, message: `connectval::[${first}]${where}: connectval:: is the block form, which renders only on a line of its own. In a sentence, write connectval:[${first}${positional != null ? `,${requested}` : ''}].` } }
  }
  if (format !== connectValues.FORMAT_HUMAN && format !== connectValues.FORMAT_RAW) {
    if (mode !== 'off') logger.warn(`${macro || `connectval:${path}[${requested}]`}${where}: format=${format} is not supported; use format=raw for the exact value. Rendering the human-readable value.`)
    format = connectValues.FORMAT_HUMAN
  }

  const contentCatalog = config && config.contentCatalog
  let registry
  let cloud = false
  let csvRows
  if (contentCatalog) {
    registry = connectValues.loadConnect(contentCatalog)
    if (!registry) {
      if (mode !== 'off') datasets.warnDatasetMissing(contentCatalog, connectValues.CONNECT_COMPONENT, '', connectValues.CONNECT_KIND)
    } else if (mode !== 'off') {
      const all = connectValues.connectDatasets(contentCatalog)
      if (all.length > 1) {
        datasets.warnOnce(contentCatalog, 'connect:several', `connectval macro: ${all.length} Connect datasets in connect:components; using ${datasets.describeDataset(registry).split(' from ')[0]}.`, logger)
      }
    }
    // The surface is the page's own component version, never the
    // document: a cloud-docs page that includes rp-connect-docs text is
    // still a Cloud page.
    cloud = datasets.isAttributeSet(datasets.componentAttributes(contentCatalog, src.component || '', src.version || '')['env-cloud'])
    csvRows = csvRowsOf(contentCatalog)
  }
  // A former name (inputs/kafka_migrator) reads the component its page path
  // now goes to; a deprecated name reads its own value. Both warn with what
  // to write instead, and neither throws.
  const written = `${componentText}${path ? `.${path}` : ''}`
  const advice = registry && contentCatalog && componentText ? connectLinks.referenceAdvice(contentCatalog, registry.data, written) : undefined
  const renamed = advice && advice.kind === 'renamed' ? advice.replacement : undefined
  const lookup = renamed ? `${connectLinks.typeDir(renamed.key)}/${renamed.name}` : component
  const result = connectValues.resolveConnectValue({ registry, component: lookup, path, field: requested, format, cloud, csvRows, filePath, macro })
  // A call that is wrong for another reason says that instead.
  const malformed = !result.ok && ['unsupported-field', 'unknown-field', 'unknown-component', 'unknown-type'].includes(result.kind)
  const suggest = (ref) => {
    if (bracket) return `connectval${block ? '::' : ':'}[${ref}${positional != null ? `,${requested}` : ''}]`
    const to = connectValues.parseFieldTarget(ref)
    return `connectval:${to.path}[${requested},component=${to.component}]`
  }
  // The error about a former name's field says which component it read.
  if (renamed && malformed) result.message += ` ${connectLinks.adviceSentence(advice, { written, dataset: datasets.describeDataset(registry), suggest }).replace(/^./, (c) => c.toUpperCase())}`
  if (advice && !malformed && mode !== 'off') {
    const call = `${macro || `connectval:${path}[${requested},component=${componentText}]`}${where}`
    // A deprecated field is already in resolveConnectValue's warnings, and a
    // call that asks whether something is deprecated knows.
    const asks = ['status', 'deprecated'].includes(connectValues.normalizeField(requested))
    if (advice.kind === 'deprecated-field') {
      for (const warning of result.warnings || []) {
        if (warning.kind === 'deprecated-field') warning.message += advice.field ? ` Its replacement is ${advice.field}: write ${suggest(advice.ref)}.` : ''
      }
    } else if (!(advice.kind === 'deprecated-component' && asks)) {
      logger.warn(`${call}: ${connectLinks.adviceSentence(advice, { written, dataset: datasets.describeDataset(registry), suggest })}`)
    }
  }
  if (mode !== 'off') {
    for (const warning of result.warnings || []) {
      if (warning.kind === 'cloud-unknown') datasets.warnOnce(contentCatalog, `connect:cloudunknown:${componentText}`, warning.message, logger)
      else logger.warn(warning.message)
    }
  }
  // A string reused off its component's page gets its links rewritten for
  // the page it renders on.
  if (result.ok && result.rich && result.rich.format === 'asciidoc') {
    const relocate = (text) => {
      const moved = connectValues.relocateConnectRefs(text, { home: result.home, src, cloud, contentCatalog })
      if (moved.unlinked.length && mode !== 'off') {
        logger.warn(`${result.call}: the ${result.field} links ${moved.unlinked.join(', ')}, which ${cloud ? 'this Cloud page' : 'this build'} has no page for, so ${moved.unlinked.length === 1 ? 'that link renders' : 'those links render'} as text.`)
      }
      return moved.text
    }
    const rich = { ...result.rich }
    if (rich.kind === 'text') rich.text = relocate(rich.text)
    return { ...base, result: { ...result, rich } }
  }
  return { ...base, result }
}

function report (mode, result) {
  if (mode === 'error' && THROW_KINDS.includes(result.kind)) throw new Error(result.message)
  logger.warn(result.message)
}

// The data-field a value carries: the canonical field, or the inverse alias
// it was asked for (optional).
const fieldLabel = (result, requested) => (result.ok && result.invert ? requested.toLowerCase() : result.field)

function connectvalInlineMacro (config) {
  return function () {
    const self = this
    self.named('connectval')
    self.match(CONNECTVAL_RX)
    self.positionalAttributes(['field'])
    self.process(function (parent, target, attributes) {
      const { mode, component, path, requested, where, result } = connectvalCall(config, parent, target, attributes)
      const content = (extra) => self.createInline(parent, 'quoted', connectValues.buildConnectvalContent({ component, path, field: fieldLabel(result, requested), ...extra }))
      if (result.ok && result.rich) {
        // A string renders inline only when it is one paragraph.
        const html = valueDescriptions.richInlineHtml(parent, result.rich)
        if (html !== undefined) return content({ html })
        const blockForm = `connectval::[${component}${path ? `.${path}` : ''},${result.field}]`
        report(mode, { kind: 'needs-block', message: `${result.call}: the ${result.field} value is more than one paragraph, which has no inline form, so it renders <unknown ${result.field}>. Use the block form on a line of its own: ${blockForm}.` })
        return content({ unknown: true })
      }
      if (result.ok) return content({ text: result.text, html: result.html })
      report(mode, result)
      return content({ unknown: true })
    })
  }
}

/**
 * connectval::[<type>/<name>[.<field.path>],<field>], the block form, for a
 * string longer than one paragraph, such as a description. The string is
 * parsed into the page as AsciiDoc (or Markdown, by the data's docs_format).
 */
function connectvalBlockMacro (config) {
  return function () {
    const self = this
    self.named('connectval')
    self.positionalAttributes(['field'])
    self.process(function (parent, target, attributes) {
      const { mode, component, path, requested, result } = connectvalCall(config, parent, target, attributes, { block: true })
      const html = (extra) => connectValues.buildConnectvalContent({ component, path, field: fieldLabel(result, requested), ...extra })
      if (result.ok && result.rich) return valueDescriptions.richBlock(self, parent, result.rich, `connect-value connect-value-${result.field}`)
      if (result.ok) return valueDescriptions.htmlParagraph(self, parent, html({ text: result.text, html: result.html }))
      report(mode, result)
      return valueDescriptions.htmlParagraph(self, parent, html({ unknown: true }))
    })
  }
}

module.exports.connectvalInlineMacro = connectvalInlineMacro
module.exports.connectvalBlockMacro = connectvalBlockMacro
module.exports.resolveConnectValue = connectValues.resolveConnectValue
module.exports.THROW_KINDS = THROW_KINDS
