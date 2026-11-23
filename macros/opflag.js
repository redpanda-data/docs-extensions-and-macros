'use strict'

/* Inline macros for the Redpanda Operator's `run` flags, read from the
 * published operator flag data instead of typed by hand:
 *
 *   opflag:[--unbind-pvcs-after]                -> --unbind-pvcs-after, linked
 *   opflag:[--unbind-pvcs-after=60s]            -> --unbind-pvcs-after=60s, linked
 *   opflagval:[--unbind-pvcs-after]             -> 0s (the default)
 *   opflagval:[--unbind-pvcs-after,type]        -> duration
 *   opflagval:[--allow-pv-rebinding,deprecated] -> yes
 *
 * opflag: links the flag's entry on the generated reference page
 * (reference:k-operator-flags.adoc, one anchor per flag) in the page's own
 * component version, and renders the text as written, so a value after = is
 * kept. opflagval: renders one field, named as every value macro names it
 * (extension-utils/value-fields.js): default, type, description or
 * deprecated (format=raw gives true/false).
 *
 * A deprecated flag warns with its deprecation message, and a hidden flag
 * warns that --help does not show it, unless the call says deprecated=ok:
 * the acknowledgement every reference macro accepts for a deliberate
 * mention. An unknown flag warns with the nearest names. operator-validate
 * (warn, error or off) sets whether problems warn, fail the build, or stay
 * quiet.
 *
 * The data is operator-flags-<version>.json in the reference module's
 * attachments, for the page's own release series (extension-utils/
 * operator-flags.js). Cloud pages never borrow it.
 *
 * Registered by macros/prop, so every playbook that registers prop: has it.
 */

const operatorFlags = require('../extension-utils/operator-flags')
const datasets = require('../extension-utils/attachment-datasets')
const valueDescriptions = require('../extension-utils/value-descriptions')
const { deprecationAcknowledged } = require('../extension-utils/deprecation-ack')
const logger = require('@antora/logger')('opflag-macro')

// Kinds that fail the build in error mode: authoring errors. Missing data or
// a missing page is a gap in the build, and plain code still reads right.
const THROW_KINDS = ['bad-flag', 'unknown-flag', 'deprecated-flag', 'hidden-flag', 'unsupported-field', 'missing-field', 'needs-block']

// Inline macros run after Asciidoctor escapes special characters.
const unescape = (value) => String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function context (config, parent) {
  const document = parent.getDocument()
  const mode = String(document.getAttribute('operator-validate', 'warn')).trim().toLowerCase()
  const src = (config && config.file && config.file.src) || {}
  const contentCatalog = config && config.contentCatalog
  const component = src.component || ''
  const version = src.version || ''
  const registry = contentCatalog ? operatorFlags.loadOperatorFlagsFor(contentCatalog, component, version) : undefined
  if (!registry && contentCatalog && mode !== 'off') {
    datasets.warnDatasetMissing(contentCatalog, component, version, operatorFlags.OPERATOR_FLAGS_KIND)
  }
  return { mode, src, contentCatalog, component, version, registry, where: src.path ? ` in ${src.path}` : '' }
}

function report (mode, kind, message) {
  if (mode === 'off') return
  if (mode === 'error' && THROW_KINDS.includes(kind)) throw new Error(message)
  logger.warn(message)
}

/**
 * Report a deprecated or hidden flag unless the call acknowledges it.
 */
function reportCaution (mode, call, flag, attributes) {
  const caution = operatorFlags.cautionOf(flag)
  if (!caution || deprecationAcknowledged(attributes)) return
  report(mode, caution.kind, `${call}: ${caution.text}. Mention it only to say so, and add deprecated=ok to the call.`)
}

function opflagInlineMacro (config) {
  return function () {
    const self = this
    self.named('opflag')
    self.option('format', 'short')
    self.positionalAttributes(['flag'])
    self.process(function (parent, target, attributes) {
      const ctx = context(config, parent)
      const line = unescape(attributes.flag == null ? '' : attributes.flag).trim()
      const call = `opflag:[${line}]${ctx.where}`
      const plain = (display) => self.createInline(parent, 'quoted', operatorFlags.buildFlagContent({ display, plain: true }))
      const resolved = operatorFlags.resolveFlag({ registry: ctx.registry, text: line, call })
      if (!resolved.ok) {
        if (resolved.kind !== 'no-data') report(ctx.mode, resolved.kind, resolved.message)
        return plain(line)
      }
      reportCaution(ctx.mode, call, resolved.flag, attributes)
      const name = resolved.flag.name
      const value = resolved.parsed.value
      const display = `--${name}${value !== undefined ? `${resolved.parsed.separator === '=' ? '=' : ' '}${value}` : ''}`
      // The reference page leaves out flags that are only hidden (internal),
      // so there is no entry to link.
      if (resolved.flag.hidden && !resolved.flag.deprecated) return plain(display)
      const page = operatorFlags.pickFlagPage(ctx.contentCatalog, { component: ctx.component, version: ctx.version })
      if (!page) {
        report(ctx.mode, 'no-page', `${call}: ${ctx.component || 'unknown component'}@${ctx.version || 'unversioned'} has no ${operatorFlags.PAGE_MODULE}:${operatorFlags.PAGE_RELATIVE}, so the flag renders as plain code with no link.`)
        return plain(display)
      }
      const anchor = operatorFlags.flagAnchor(name)
      return self.createInline(parent, 'anchor', operatorFlags.buildFlagContent({ display, name }), {
        type: 'xref',
        target: `#${page.id}#${anchor}`,
        attributes: { path: page.id, fragment: anchor },
      })
    })
  }
}

function opflagvalInlineMacro (config) {
  return function () {
    const self = this
    self.named('opflagval')
    self.option('format', 'short')
    self.positionalAttributes(['flag', 'field'])
    self.process(function (parent, target, attributes) {
      const ctx = context(config, parent)
      const line = unescape(attributes.flag == null ? '' : attributes.flag).trim()
      const requested = String(attributes.field == null ? 'default' : attributes.field).trim()
      const call = `opflagval:[${line}${attributes.field == null ? '' : `,${requested}`}]${ctx.where}`
      const parsedName = operatorFlags.parseFlagText(line).name || line
      const content = (extra) => self.createInline(parent, 'quoted', operatorFlags.buildValueContent({ name: parsedName, field: operatorFlags.normalizeField(requested) || requested, ...extra }))
      const resolved = operatorFlags.resolveFlag({ registry: ctx.registry, text: line, call })
      if (!resolved.ok) {
        if (resolved.kind !== 'no-data') report(ctx.mode, resolved.kind, resolved.message)
        return content({ unknown: true })
      }
      if (resolved.parsed.value !== undefined) {
        report(ctx.mode, 'bad-flag', `${call}: write the flag without a value, as in opflagval:[--${resolved.flag.name},${requested}].`)
      }
      reportCaution(ctx.mode, call, resolved.flag, attributes)
      let format = String(attributes.format || operatorFlags.FORMAT_HUMAN).trim().toLowerCase()
      if (format !== operatorFlags.FORMAT_HUMAN && format !== operatorFlags.FORMAT_RAW) {
        report(ctx.mode, 'format', `${call}: format=${format} is not supported; use format=raw for true/false.`)
        format = operatorFlags.FORMAT_HUMAN
      }
      const value = operatorFlags.fieldValue(resolved.flag, requested, { format, call })
      if (!value.ok) {
        report(ctx.mode, value.kind, value.message)
        return content({ unknown: true })
      }
      if (value.rich) {
        const html = valueDescriptions.richInlineHtml(parent, value.rich)
        if (html !== undefined) return content({ html })
        report(ctx.mode, 'needs-block', `${call}: the help text of --${resolved.flag.name} is more than one paragraph, which has no inline form.`)
        return content({ unknown: true })
      }
      return content({ text: value.text })
    })
  }
}

module.exports.opflagInlineMacro = opflagInlineMacro
module.exports.opflagvalInlineMacro = opflagvalInlineMacro
module.exports.THROW_KINDS = THROW_KINDS
