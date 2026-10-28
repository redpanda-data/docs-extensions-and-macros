'use strict'

/* Inline macro for one value of a Redpanda Connect config field, read from the
 * published Connect data instead of typed by hand:
 *
 *   connectval:client_id[component=inputs/redpanda]                          -> redpanda-connect
 *   connectval:incremental_snapshot.chunk_size[component=inputs/postgres_cdc] -> 1024
 *   connectval:merge_strategy[options,component=outputs/iceberg]              -> merge-on-read, copy-on-write
 *   connectval:pipeline.threads[component=config]                            -> -1
 *
 * The target is a dot-separated field path; an array of objects is addressed
 * without an index (sasl.mechanism). component= is <type>/<name> as the
 * rp-connect-docs paths write it, or config for the root fields. The first
 * positional attribute is the field (default, type, options, deprecated,
 * introduced; default when omitted), formatted exactly as the generated
 * component reference prints it.
 *
 * The data is the newest connect-<version>.json in the connect component's
 * components module, whatever component the page is in: Connect versions are
 * Connect's own, so a page's version never selects one. On a Cloud page
 * (env-cloud) a component that is not available in Cloud renders a
 * placeholder. Whenever no verified value exists the macro renders
 * <unknown FIELD> and says why, according to connect-validate (warn, error or
 * off). See macros/REFERENCE.adoc.
 *
 * Registered by macros/prop, so every playbook that registers prop: has it.
 */

const connectValues = require('../extension-utils/connect-values')
const datasets = require('../extension-utils/attachment-datasets')
const logger = require('@antora/logger')('connectval-macro')

// Kinds that fail the build in error mode. Data gaps never throw.
const THROW_KINDS = ['unknown-type', 'unknown-component', 'unknown-field', 'missing-field', 'unsupported-field', 'cloud-hidden', 'unavailable']

// The translated catalog rows generate-rp-connect-info sets on the connect
// component's latest version at contentClassified, when the build has them.
function csvRowsOf (contentCatalog) {
  if (typeof contentCatalog.getComponent !== 'function') return undefined
  const connect = contentCatalog.getComponent(connectValues.CONNECT_COMPONENT)
  const csv = connect && connect.latest && connect.latest.asciidoc && connect.latest.asciidoc.attributes && connect.latest.asciidoc.attributes.csvData
  return csv && Array.isArray(csv.data) ? csv.data : undefined
}

function connectvalInlineMacro (config) {
  return function () {
    const self = this
    self.named('connectval')
    self.positionalAttributes(['field'])
    self.process(function (parent, target, attributes) {
      const document = parent.getDocument()
      const mode = String(document.getAttribute('connect-validate', 'warn')).trim().toLowerCase()
      const src = (config && config.file && config.file.src) || {}
      const filePath = src.path
      // Asciidoctor fills field from the first slot only, so a field written
      // after command= or component= arrives as a later positional.
      const positional = (attributes.$positional || []).find((value) => value != null)
      const requested = String(attributes.field || positional || 'default').trim()
      const component = attributes.component
      const path = String(target).trim()
      let format = String(attributes.format || connectValues.FORMAT_HUMAN).trim().toLowerCase()
      const where = filePath ? ` in ${filePath}` : ''
      if (format !== connectValues.FORMAT_HUMAN && format !== connectValues.FORMAT_RAW) {
        if (mode !== 'off') logger.warn(`connectval:${path}[${requested}]${where}: format=${format} is not supported; use format=raw for the exact value. Rendering the human-readable value.`)
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
      const result = connectValues.resolveConnectValue({ registry, component, path, field: requested, format, cloud, csvRows, filePath })
      const componentText = String(component == null ? '' : component).trim()
      if (mode !== 'off') {
        for (const warning of result.warnings || []) {
          if (warning.kind === 'cloud-unknown') datasets.warnOnce(contentCatalog, `connect:cloudunknown:${componentText}`, warning.message, logger)
          else logger.warn(warning.message)
        }
      }
      if (result.ok) {
        return self.createInline(parent, 'quoted', connectValues.buildConnectvalContent({ component: componentText, path, field: result.field, text: result.text, html: result.html }))
      }
      if (mode === 'error' && THROW_KINDS.includes(result.kind)) throw new Error(result.message)
      logger.warn(result.message)
      return self.createInline(parent, 'quoted', connectValues.buildConnectvalContent({ component: componentText, path, field: result.field, unknown: true }))
    })
  }
}

module.exports.connectvalInlineMacro = connectvalInlineMacro
module.exports.resolveConnectValue = connectValues.resolveConnectValue
module.exports.THROW_KINDS = THROW_KINDS
