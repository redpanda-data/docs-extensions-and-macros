'use strict'

/* Inline macro for one value of an rpk flag, read from the published rpk data
 * instead of typed by hand:
 *
 *   rpkval:[rpk topic create --partitions]            -> -1
 *   rpkval:[rpk topic create --partitions,shorthand]  -> -p
 *   rpkval:[rpk ai auditlog list --since]             -> 24h
 *   rpkval:[rpk --config-opt,type]                    -> stringArray (a global flag)
 *
 * The brackets hold the command exactly as typed, aliases included, without
 * arguments, then the long flag; the leading rpk is optional, and a global
 * flag has no command. The next attribute is the field (default, type,
 * shorthand, required, deprecated; default when omitted), and format=raw
 * gives true/false instead of yes/no.
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
const logger = require('@antora/logger')('rpkval-macro')

// Kinds that fail the build in error mode: authoring errors, plus the Cloud
// gates, which appear only in the Cloud build of single-sourced prose where a
// warning alone would let the placeholder ship. Data gaps never throw.
const THROW_KINDS = ['unknown-command', 'unknown-flag', 'shorthand-target', 'deprecated-command', 'missing-field', 'unsupported-field', 'cloud-hidden', 'unavailable']

function rpkvalInlineMacro (config) {
  return function () {
    const self = this
    self.named('rpkval')
    // The default pattern needs a target; this one also matches the bracket
    // form, rpkval:[rpk topic create --partitions], whose target is empty.
    self.match(/\\?rpkval:(\S*?)\[((?:\\\]|[^\]])*?)\]/)
    self.positionalAttributes(['field'])
    self.process(function (parent, target, attributes) {
      const document = parent.getDocument()
      const mode = String(document.getAttribute('rpk-validate', 'warn')).trim().toLowerCase()
      const src = (config && config.file && config.file.src) || {}
      const filePath = src.path
      const component = src.component || ''
      const version = src.version || ''
      const positionals = attributes.$positional || []
      // The bracket form: the command line first, then the field.
      const bracket = String(target).trim() === ''
      const line = bracket ? String(positionals[0] == null ? '' : positionals[0]).trim() : ''
      const parsed = bracket ? rpkValues.parseCommandLine(line) : undefined
      // Asciidoctor fills field from the first slot only, so a field written
      // after command= or component= arrives as a later positional.
      const positional = bracket ? positionals.slice(1).find((value) => value != null) : positionals.find((value) => value != null)
      const requested = String((bracket ? positional : attributes.field || positional) || 'default').trim()
      const command = bracket ? parsed.tokens.join(' ') : attributes.command
      const flagTarget = bracket ? (parsed.flag || '') : target
      const macro = bracket ? `rpkval:[${line}${positional != null ? `,${requested}` : ''}]` : undefined
      let format = String(attributes.format || rpkValues.FORMAT_HUMAN).trim().toLowerCase()
      const where = filePath ? ` in ${filePath}` : ''
      const flagName = String(flagTarget).trim().replace(/^-+/, '')
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
      const shape = bracket && (!parsed.flag || parsed.extra.length)
        ? {
            ok: false,
            kind: 'unknown-flag',
            field: rpkValues.normalizeField(requested) || requested,
            message: `${macro}${where}: ${parsed.flag ? `'${parsed.extra.join(' ')}' follows ${parsed.flag}; write the command and one flag, without a value or arguments` : 'names no flag; write the command, then the flag'}, as in rpkval:[rpk topic create --partitions].`,
          }
        : undefined
      const result = shape || rpkValues.resolveRpkValue({ registry, command, flag: flagTarget, field: requested, format, filePath, macro })
      const commandText = result.ok ? result.command : ['rpk', ...rpkValues.commandTokens(command)].join(' ')
      if (result.ok) {
        return self.createInline(parent, 'quoted', rpkValues.buildRpkvalContent({ command: commandText, flag: flagName, field: result.field, text: result.text, source: result.source }))
      }
      if (mode === 'error' && THROW_KINDS.includes(result.kind)) throw new Error(result.message)
      logger.warn(result.message)
      return self.createInline(parent, 'quoted', rpkValues.buildRpkvalContent({ command: commandText, flag: flagName, field: result.field, unknown: true }))
    })
  }
}

module.exports.rpkvalInlineMacro = rpkvalInlineMacro
module.exports.resolveRpkValue = rpkValues.resolveRpkValue
module.exports.THROW_KINDS = THROW_KINDS
