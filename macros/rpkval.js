'use strict'

/* Inline macro for one value of an rpk flag or command, read from the
 * published rpk data instead of typed by hand:
 *
 *   rpkval:[rpk topic create --partitions]            -> -1
 *   rpkval:[rpk topic create --partitions,shorthand]  -> -p
 *   rpkval:[rpk ai auditlog list --since]             -> 24h
 *   rpkval:[rpk --config-opt,type]                    -> stringArray (a global flag)
 *   rpkval:[rpk topic create,usage]                   -> rpk topic create [TOPICS...] [flags]
 *
 * The brackets hold the command exactly as typed, aliases included, without
 * arguments, then the long flag; the leading rpk is optional, and a global
 * flag has no command. With no flag, the call reads a field of the command
 * itself. The next attribute is the field (default when omitted), named as
 * every value macro names it (extension-utils/value-fields.js), and
 * format=raw gives true/false instead of yes/no.
 *
 * Help text longer than one paragraph, such as a command's description or
 * examples, renders only in the block form, rpkval::[rpk topic create,description]
 * on a line of its own. Descriptions render as AsciiDoc, as the rpk reference
 * renders them; examples render literally, because they are command lines.
 *
 * The first form is still accepted: the flag as the target and the command
 * in command=, as in rpkval:partitions[command=rpk topic create] or
 * rpkval:partitions[shorthand,command=rpk topic create].
 *
 * The data is rpk-<version>.json in a reference module's attachments, picked
 * exactly as prop: picks property data: a self-managed page reads its own
 * release series, a Cloud (env-cloud) or Agentic Data Plane (env-adp) page
 * reads the newest GA streaming file, and anything else has none. Whenever no
 * verified value exists the macro renders <unknown FIELD> and says why,
 * according to rpk-validate (warn, error or off). See macros/REFERENCE.adoc.
 *
 * Registered by macros/prop, so every playbook that registers prop: has it.
 */

const rpkValues = require('../extension-utils/rpk-values')
const datasets = require('../extension-utils/attachment-datasets')
const valueDescriptions = require('../extension-utils/value-descriptions')
const { annotateVerbatimLines } = require('../tools/redpanda-connect/metadata-utils')
const logger = require('@antora/logger')('rpkval-macro')

// Kinds that fail the build in error mode: authoring errors, plus the Cloud
// gates, which appear only in the Cloud build of single-sourced prose where a
// warning alone would let the placeholder ship. Data gaps never throw, and
// neither does a dropped field, which was documented once.
const THROW_KINDS = ['unknown-command', 'unknown-flag', 'shorthand-target', 'deprecated-command', 'missing-field', 'unsupported-field', 'cloud-hidden', 'unavailable', 'needs-block', 'block-form-inline']

// The macro's own pattern: the default needs a target, and this one also
// matches the bracket form, rpkval:[rpk topic create --partitions], whose
// target is empty.
const RPKVAL_RX = /\\?rpkval:(\S*?)\[((?:\\\]|[^\]])*?)\]/

/**
 * Resolve one rpkval: or rpkval:: call on a page, the part the inline and
 * block forms share.
 */
function rpkvalCall (config, parent, target, attributes, { block = false } = {}) {
  const document = parent.getDocument()
  const mode = String(document.getAttribute('rpk-validate', 'warn')).trim().toLowerCase()
  const src = (config && config.file && config.file.src) || {}
  const filePath = src.path
  const component = src.component || ''
  const version = src.version || ''
  const positionals = attributes.$positional || []
  // rpkval::[...] in a sentence reaches the inline macro with the second
  // colon as its target.
  const misplaced = !block && String(target).trim() === ':'
  // The bracket form: the command line first, then the field.
  const bracket = misplaced || String(target).trim() === ''
  const line = bracket ? String(positionals[0] == null ? '' : positionals[0]).trim() : ''
  const parsed = bracket ? rpkValues.parseCommandLine(line) : undefined
  // Asciidoctor fills field from the first slot only, so a field written
  // after command= or component= arrives as a later positional.
  const positional = bracket ? positionals.slice(1).find((value) => value != null) : positionals.find((value) => value != null)
  const requested = String((bracket ? positional : attributes.field || positional) || 'default').trim()
  const command = bracket ? parsed.tokens.join(' ') : attributes.command
  const flagTarget = bracket ? (parsed.flag || '') : target
  const macro = bracket ? `rpkval${block ? '::' : ':'}[${line}${positional != null ? `,${requested}` : ''}]` : undefined
  let format = String(attributes.format || rpkValues.FORMAT_HUMAN).trim().toLowerCase()
  const where = filePath ? ` in ${filePath}` : ''
  const flagName = String(flagTarget).trim().replace(/^-+/, '')
  const commandText = () => ['rpk', ...rpkValues.commandTokens(command)].join(' ')
  const field = rpkValues.normalizeField(requested) || requested
  if (misplaced) {
    return { mode, flagName, requested, commandText: commandText(), result: { ok: false, kind: 'block-form-inline', field, message: `rpkval::[${line}]${where}: rpkval:: is the block form, which renders only on a line of its own. In a sentence, write rpkval:[${line}${positional != null ? `,${requested}` : ''}].` } }
  }
  if (format !== rpkValues.FORMAT_HUMAN && format !== rpkValues.FORMAT_RAW) {
    if (mode !== 'off') logger.warn(`${macro || `rpkval:${target}[${requested}]`}${where}: format=${format} is not supported; use format=raw for true/false. Rendering the human-readable value.`)
    format = rpkValues.FORMAT_HUMAN
  }

  const contentCatalog = config && config.contentCatalog
  const registry = contentCatalog ? rpkValues.loadRpkFor(contentCatalog, component, version) : undefined
  if (!registry && contentCatalog && mode !== 'off') {
    // The same once-per-component-version diagnostic propval: emits.
    datasets.warnDatasetMissing(contentCatalog, component, version, rpkValues.RPK_KIND)
  }
  // A value or argument after the flag is never a field of anything.
  const shape = bracket && parsed.flag && parsed.extra.length
    ? {
        ok: false,
        kind: 'unknown-flag',
        field,
        message: `${macro}${where}: '${parsed.extra.join(' ')}' follows ${parsed.flag}; write the command and one flag, without a value or arguments, as in rpkval:[rpk topic create --partitions].`,
      }
    : undefined
  // With no flag, the bracket form reads a field of the command itself.
  const level = bracket && !parsed.flag ? 'command' : 'flag'
  let result = shape || rpkValues.resolveRpkValue({ registry, command, flag: flagTarget, field: requested, format, filePath, macro, level })
  if (result.ok && result.rich && result.rich.format === valueDescriptions.FORMAT_ASCIIDOC) {
    result = { ...result, rich: { ...result.rich, text: escapeUndefinedAttributes(result.rich.text, document) } }
  }
  return { mode, flagName, requested, commandText: result.ok ? result.command : commandText(), result, macro: macro || `rpkval:${target}[${requested}]`, where }
}

/**
 * Help text uses {name} for placeholders (agents/{agent}/triggers/{trigger}),
 * which AsciiDoc reads as attribute references. One the page does not define
 * is escaped, so it renders with its braces, as the rpk reference renders it;
 * a defined one, such as {vbar}, still resolves. Listings and indented
 * (literal) lines are left alone, because they take no substitutions.
 */
function escapeUndefinedAttributes (text, document) {
  return annotateVerbatimLines(text).map(({ line, verbatim }) => (verbatim || /^\s/.test(line)
    ? line
    : line.replace(/(?<!\\)\{([\w][\w-]*)\}/g, (match, name) => (document.hasAttribute(name) ? match : `\\${match}`)))).join('\n')
}

function report (mode, result) {
  if (mode === 'error' && THROW_KINDS.includes(result.kind)) throw new Error(result.message)
  logger.warn(result.message)
}

// The data-field a value carries: the canonical field, or the inverse alias
// it was asked for (optional).
const fieldLabel = (result, requested) => (result.ok && result.invert ? requested.toLowerCase() : result.field)

function rpkvalInlineMacro (config) {
  return function () {
    const self = this
    self.named('rpkval')
    self.match(RPKVAL_RX)
    self.positionalAttributes(['field'])
    self.process(function (parent, target, attributes) {
      const call = rpkvalCall(config, parent, target, attributes)
      const { mode, flagName, commandText, result } = call
      const content = (extra) => self.createInline(parent, 'quoted', rpkValues.buildRpkvalContent({ command: commandText, flag: flagName, field: fieldLabel(result, call.requested), ...extra }))
      if (result.ok && result.rich) {
        // Help text renders inline only when it is one paragraph.
        const html = valueDescriptions.richInlineHtml(parent, result.rich)
        if (html !== undefined) return content({ html, source: result.source })
        report(mode, { kind: 'needs-block', message: `${call.macro}${call.where}: the ${result.field} value of ${flagName ? `--${flagName} of ` : ''}${commandText} is more than one paragraph, which has no inline form, so it renders <unknown ${result.field}>. Use the block form on a line of its own: rpkval::[${commandText}${flagName ? ` --${flagName}` : ''},${result.field}].` })
        return content({ unknown: true })
      }
      if (result.ok) return content({ text: result.text, source: result.source })
      report(mode, result)
      return content({ unknown: true })
    })
  }
}

/**
 * rpkval::[<command> [--<flag>],<field>], the block form, for help text
 * longer than one paragraph: a command's description or examples. A
 * description is parsed as AsciiDoc; examples render literally, as paragraphs
 * and literal blocks.
 */
function rpkvalBlockMacro (config) {
  return function () {
    const self = this
    self.named('rpkval')
    self.positionalAttributes(['field'])
    self.process(function (parent, target, attributes) {
      const { mode, flagName, requested, commandText, result } = rpkvalCall(config, parent, target, attributes, { block: true })
      const html = (extra) => rpkValues.buildRpkvalContent({ command: commandText, flag: flagName, field: fieldLabel(result, requested), ...extra })
      if (result.ok && result.rich) return valueDescriptions.richBlock(self, parent, result.rich, `rpk-value rpk-value-${result.field}`)
      if (result.ok) return valueDescriptions.htmlParagraph(self, parent, html({ text: result.text, source: result.source }))
      report(mode, result)
      return valueDescriptions.htmlParagraph(self, parent, html({ unknown: true }))
    })
  }
}

module.exports.rpkvalInlineMacro = rpkvalInlineMacro
module.exports.rpkvalBlockMacro = rpkvalBlockMacro
module.exports.resolveRpkValue = rpkValues.resolveRpkValue
module.exports.THROW_KINDS = THROW_KINDS
