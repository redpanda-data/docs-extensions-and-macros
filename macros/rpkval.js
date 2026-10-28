'use strict'

/* Inline macro for one value of an rpk flag, read from the published rpk data
 * instead of typed by hand:
 *
 *   rpkval:partitions[command=rpk topic create]            -> -1
 *   rpkval:partitions[shorthand,command=rpk topic create]  -> -p
 *   rpkval:since[command=rpk ai auditlog list]             -> 24h
 *   rpkval:config-opt[type]                                -> stringArray (a global flag)
 *
 * The target is the long flag name, with or without leading dashes. command=
 * is the command path exactly as typed, aliases included, without arguments;
 * leave it out for a global flag. The first positional attribute is the field
 * (default, type, shorthand, required, deprecated; default when omitted), and
 * format=raw gives true/false instead of yes/no.
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
    self.positionalAttributes(['field'])
    self.process(function (parent, target, attributes) {
      const document = parent.getDocument()
      const mode = String(document.getAttribute('rpk-validate', 'warn')).trim().toLowerCase()
      const src = (config && config.file && config.file.src) || {}
      const filePath = src.path
      const component = src.component || ''
      const version = src.version || ''
      const requested = String(attributes.field || 'default').trim()
      const command = attributes.command
      let format = String(attributes.format || rpkValues.FORMAT_HUMAN).trim().toLowerCase()
      const where = filePath ? ` in ${filePath}` : ''
      const flagName = String(target).trim().replace(/^-+/, '')
      if (format !== rpkValues.FORMAT_HUMAN && format !== rpkValues.FORMAT_RAW) {
        if (mode !== 'off') logger.warn(`rpkval:${target}[${requested}]${where}: format=${format} is not supported; use format=raw for true/false. Rendering the human-readable value.`)
        format = rpkValues.FORMAT_HUMAN
      }

      const contentCatalog = config && config.contentCatalog
      const registry = contentCatalog ? rpkValues.loadRpkFor(contentCatalog, component, version) : undefined
      if (!registry && contentCatalog && mode !== 'off') {
        // The same once-per-component-version diagnostic propval: emits.
        datasets.warnDatasetMissing(contentCatalog, component, version, rpkValues.RPK_KIND)
      }
      const result = rpkValues.resolveRpkValue({ registry, command, flag: target, field: requested, format, filePath })
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
