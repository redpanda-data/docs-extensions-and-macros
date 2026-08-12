'use strict'

/* Macros for marking and listing enterprise features.
 *
 * Inline macro — mark a feature in prose:
 *
 *   enterprise:Continuous Data Balancing[]
 *   enterprise:Tiered Storage[xref=manage:tiered-storage.adoc]
 *   enterprise:Audit Logging[text=audit logging]
 *   enterprise:Iceberg Topics[tooltip=Iceberg Topics requires an Enterprise Edition license and object storage.]
 *
 * The feature name renders as a uniquely styled term with a tooltip that
 * explains the feature requires an Enterprise Edition license. The term
 * links to the feature's documentation when an xref attribute is given,
 * and otherwise to the licensing page, so readers can always reach an
 * explanation of what having (or not having) a license means.
 *
 * Block macro — render the licensing feature table for one scope:
 *
 *   enterprise_features::redpanda[]
 *   enterprise_features::connect[title=Enterprise features in Redpanda Connect]
 *
 * Registry validation:
 *
 * Both macros read the canonical enterprise features registry from the
 * 'shared' component (modules/ROOT/partials/enterprise-features.yml in the
 * shared folder of the docs repo). Inline targets are resolved against the
 * registry case-insensitively, including aliases, and the canonical name,
 * feature xref, and tooltip come from the matching entry. Unknown targets
 * are reported according to the enterprise-validate attribute. When no
 * registry is available (for example, outside an Antora build), the macros
 * fall back to unvalidated rendering with a single warning.
 *
 * Document or site attributes:
 *
 *   enterprise-validate        'warn' (default) to log unknown feature names,
 *                              'error' to fail the build, 'off' to disable
 *                              validation.
 *   enterprise-licensing-page  Resource ID of the licensing page used when
 *                              no feature page is known
 *                              (default: get-started:licensing/overview.adoc).
 *   enterprise-feature-role    CSS class applied to the wrapping span
 *                              (default: enterprise-feature).
 *   enterprise-tooltip         'title' (default), 'true' (renders
 *                              data-enterprise-tooltip), any attribute name
 *                              starting with 'data-', or 'false' to disable.
 *   enterprise-links           'true' (default) to render the term as a link.
 *
 * Example use in a playbook:
 *
 *   asciidoc:
 *     extensions:
 *     - '@redpanda-data/docs-extensions-and-macros/macros/enterprise'
 */

const yaml = require('js-yaml')
const chalk = require('chalk')
const { buildBadgeHtml } = require('./badge')

const $enterpriseRegistry = Symbol('$enterpriseRegistry')

const DEFAULT_LICENSING_PAGE = 'get-started:licensing/overview.adoc'
const DEFAULT_ROLE = 'enterprise-feature'
const BETA_LABEL = 'beta'

/**
 * Render the beta badge for a registry entry marked `beta: true`.
 *
 * The badge HTML is built directly rather than emitted as `badge:[...]`
 * AsciiDoc, so it renders whether or not the consuming playbook registers the
 * badge macro. Writing the macro call into a registry field used to be the only
 * way to flag a beta feature, and it silently produced the literal text
 * `badge::[label=beta]` in any build without that macro registered.
 *
 * @param {object} entry - Registry entry.
 * @returns {string} Badge HTML, or an empty string when the entry is not beta.
 */
function buildBetaBadge (entry) {
  if (!entry || entry.beta !== true) return ''
  return buildBadgeHtml({
    label: BETA_LABEL,
    tooltip: entry['beta-tooltip'] || undefined,
  })
}

/**
 * The badge for a registry entry, wrapped for use in generated AsciiDoc.
 *
 * The block macro returns AsciiDoc source that Asciidoctor then parses, so raw
 * HTML placed in a table cell is escaped and the reader sees the markup as
 * text. An inline passthrough emits it verbatim instead, and unlike a
 * `badge:[...]` macro call it does not require the badge macro to be registered
 * in the consuming playbook.
 *
 * @param {object} entry - Registry entry.
 * @returns {string} Passthrough-wrapped badge, or an empty string.
 */
function buildBetaBadgeAsciiDoc (entry) {
  const html = buildBetaBadge(entry)
  return html ? `pass:[${html}]` : ''
}
const REGISTRY_FILENAME = 'enterprise-features.yml'
const VALID_SCOPES = ['redpanda', 'console', 'connect', 'operator', 'cloud']

const TABLE_TITLES = {
  redpanda: 'Enterprise features in Redpanda',
  console: 'Enterprise features in Redpanda Console',
  connect: 'Enterprise features in Redpanda Connect',
  operator: 'Enterprise features in the Redpanda Operator',
  cloud: 'Enterprise features in Redpanda Cloud',
}

const THIRD_COLUMN_HEADINGS = {
  redpanda: 'Behavior Upon Expiration',
  default: 'Restrictions Without Valid License',
}

let warnedNoRegistry = false

/**
 * Parse the registry YAML into a lookup structure. Exported for unit testing.
 *
 * @param {string} source - Raw YAML from enterprise-features.yml.
 * @param {string} origin - Human-readable location for error messages.
 * @returns {{features: object[], lookup: Map<string, object>}}
 */
function parseRegistry (source, origin = REGISTRY_FILENAME) {
  const data = yaml.load(source)
  if (!data || !Array.isArray(data.features)) {
    throw new Error(`Enterprise features registry ${origin} has no 'features' list.`)
  }
  const lookup = new Map()
  const claim = (rawKey, feature, kind) => {
    const key = rawKey.trim().toLowerCase()
    if (!key) return
    const existing = lookup.get(key)
    if (existing && existing !== feature) {
      throw new Error(`Duplicate enterprise feature ${kind} '${rawKey}' in ${origin}: used by both '${existing.name}' and '${feature.name}'.`)
    }
    lookup.set(key, feature)
  }
  for (const feature of data.features) {
    if (!feature || !feature.name) {
      throw new Error(`Enterprise features registry ${origin} has an entry without a name.`)
    }
    if (feature.scope && !VALID_SCOPES.includes(feature.scope)) {
      throw new Error(`Enterprise feature '${feature.name}' in ${origin} has unknown scope '${feature.scope}'.`)
    }
    claim(feature.name, feature, 'name')
    for (const alias of feature.aliases || []) claim(String(alias), feature, 'alias')
  }
  return { features: data.features, lookup }
}

/**
 * Load and cache the registry from the shared component in the Antora
 * content catalog. Returns undefined when no registry is available.
 */
function loadRegistry (config) {
  const contentCatalog = config && config.contentCatalog
  if (!contentCatalog) return undefined
  if (contentCatalog[$enterpriseRegistry] !== undefined) return contentCatalog[$enterpriseRegistry] || undefined
  let registry = null
  const partials = contentCatalog.findBy({ component: 'shared', module: 'ROOT', family: 'partial' }) || []
  const registryFile = partials.find((file) => file.path && file.path.endsWith(REGISTRY_FILENAME))
  if (registryFile) {
    registry = parseRegistry(registryFile.contents.toString(), registryFile.path)
  }
  // Cache null too, so a missing registry is only searched for once per build.
  contentCatalog[$enterpriseRegistry] = registry
  return registry || undefined
}

function warnNoRegistry () {
  if (warnedNoRegistry) return
  warnedNoRegistry = true
  console.warn(chalk.yellow(`Enterprise features registry (${REGISTRY_FILENAME} in the shared component) not found; enterprise: targets are not validated.`))
}

/**
 * Report an unknown feature name according to the enterprise-validate mode.
 */
function reportUnknownFeature ({ feature, mode, registry, filePath }) {
  if (mode === 'off') return
  const candidates = registry.features
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().includes(feature.trim().toLowerCase().split(/\s+/)[0] || ''))
    .slice(0, 3)
  const hint = candidates.length ? ` Did you mean: ${candidates.join(', ')}?` : ''
  const where = filePath ? ` in ${filePath}` : ''
  const message = `enterprise:${feature}[] does not match any feature in the enterprise features registry${where}.${hint} Add the feature to ${REGISTRY_FILENAME} in the shared component first.`
  if (mode === 'error') throw new Error(message)
  console.warn(chalk.yellow(message))
}

/**
 * Pick the environment-appropriate feature page from a registry entry.
 * Some features have separate documentation for Kubernetes, Linux
 * (self-managed), and Redpanda Cloud. Mirrors the config_ref macro's
 * environment-awareness: the env-cloud and env-kubernetes page attributes
 * select the xref-cloud and xref-kubernetes registry fields, falling back
 * to the default xref.
 *
 * @param {object} entry - Registry entry.
 * @param {object} document - Asciidoctor document (for env attributes).
 * @returns {string|undefined}
 */
function resolveEntryXref (entry, document) {
  if (!entry) return undefined
  if (document.getAttribute('env-cloud') !== undefined && entry['xref-cloud']) return entry['xref-cloud']
  if (document.getAttribute('env-kubernetes') !== undefined && entry['xref-kubernetes']) return entry['xref-kubernetes']
  return entry.xref
}

/**
 * Resolve the tooltip attribute name from the enterprise-tooltip document
 * attribute. Mirrors the glossary macro's contract.
 *
 * @param {string|undefined} raw - Raw attribute value.
 * @returns {string|undefined} Attribute name to emit, or undefined when disabled.
 */
function resolveTooltipAttribute (raw) {
  if (raw === 'false') return undefined
  if (raw === undefined || raw === 'title') return 'title'
  if (raw === 'true') return 'data-enterprise-tooltip'
  if (raw.startsWith('data-')) return raw
  console.warn(`enterprise-tooltip attribute '${raw}' must be 'title', 'true', 'false', or start with 'data-'. Falling back to 'title'.`)
  return 'title'
}

/**
 * Build the AsciiDoc content emitted for one inline macro instance. Exported
 * for unit testing.
 *
 * @param {object} opts
 * @param {string} opts.feature - Canonical feature name.
 * @param {string} [opts.text] - Display text override.
 * @param {string} [opts.xref] - Resource ID of the feature documentation.
 * @param {string} [opts.url] - Absolute link used when no xref exists.
 * @param {string} [opts.tooltip] - Tooltip text override.
 * @param {string} opts.licensingPage - Resource ID of the licensing page.
 * @param {string} opts.role - CSS class for the wrapping span.
 * @param {string|undefined} opts.tooltipAttr - Tooltip attribute name, or undefined to omit.
 * @param {boolean} opts.links - Whether to render a link.
 * @returns {string}
 */
function buildEnterpriseContent ({ feature, text, xref, url, tooltip, licensingPage, role, tooltipAttr, links }) {
  const display = text || feature
  const tooltipText = tooltip || `${feature} requires an Enterprise Edition license.`
  const escapedTooltip = tooltipText.replace(/"/g, '&quot;')
  const tooltipHtml = tooltipAttr ? ` ${tooltipAttr}="${escapedTooltip}"` : ''
  let inner = display
  if (links) {
    inner = xref ? `xref:${xref}[${display}]` : (url ? `link:${url}[${display}]` : `xref:${licensingPage}[${display}]`)
  }
  return `<span class="${role}"${tooltipHtml}>${inner}</span>`
}

/**
 * Build the AsciiDoc source of the licensing feature table for one scope.
 * Exported for unit testing.
 *
 * @param {object[]} features - All registry entries.
 * @param {string} scope - Scope to render.
 * @param {object} [opts]
 * @param {string} [opts.title] - Table title override.
 * @param {string} [opts.heading] - Third column heading override.
 * @returns {string}
 */
function buildFeatureTable (features, scope, opts = {}) {
  const rows = features
    .filter((feature) => feature.scope === scope)
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
  const title = opts.title || TABLE_TITLES[scope]
  const heading = opts.heading || THIRD_COLUMN_HEADINGS[scope] || THIRD_COLUMN_HEADINGS.default
  const lines = [`.${title}`, '[cols="1a,2a,2a"]', '|===', `| Feature | Description | ${heading}`, '']
  for (const feature of rows) {
    let cell = feature.xref
      ? `xref:${feature.xref}[${feature.name}]`
      : (feature.url ? `link:${feature.url}[${feature.name}]` : feature.name)
    if (feature['feature-suffix']) cell += ` ${feature['feature-suffix']}`
    const betaBadge = buildBetaBadgeAsciiDoc(feature)
    if (betaBadge) cell += ` ${betaBadge}`
    if (feature['show-gating-property'] && feature['gating-property']) cell += `\n(\`${feature['gating-property']}\`)`
    lines.push(`| ${cell}`)
    lines.push(`| ${(feature.description || '').trim()}`)
    lines.push(`| ${(feature.expiration || '').trim()}`)
    lines.push('')
  }
  lines.push('|===')
  return lines.join('\n')
}

function enterpriseInlineMacro (config) {
  return function () {
    const self = this
    self.named('enterprise')
    // Specifying the regexp allows spaces in the feature name.
    self.$option('regexp', /enterprise:([^[]+)\[(|.*?[^\\])\]/)
    self.process(function (parent, target, attributes) {
      const document = parent.getDocument()
      let registry
      if (config && config.contentCatalog) {
        registry = loadRegistry(config)
        if (!registry) warnNoRegistry()
      }
      let feature = target
      let entry
      if (registry) {
        entry = registry.lookup.get(target.trim().toLowerCase())
        if (entry) {
          feature = entry.name
        } else {
          reportUnknownFeature({
            feature: target,
            mode: document.getAttribute('enterprise-validate', 'warn'),
            registry,
            filePath: config && config.file && config.file.src && config.file.src.path,
          })
        }
      }
      let content = buildEnterpriseContent({
        feature,
        text: attributes.text,
        xref: attributes.xref || resolveEntryXref(entry, document),
        url: entry && entry.url,
        tooltip: attributes.tooltip || (entry && entry.tooltip) || undefined,
        licensingPage: document.getAttribute('enterprise-licensing-page', DEFAULT_LICENSING_PAGE),
        role: document.getAttribute('enterprise-feature-role', DEFAULT_ROLE),
        tooltipAttr: resolveTooltipAttribute(document.getAttribute('enterprise-tooltip')),
        links: document.getAttribute('enterprise-links', 'true') === 'true',
      })
      // A feature marked beta in the registry is beta wherever it is
      // referenced, so prose gets the same badge as the generated tables.
      // Set enterprise-beta-badge to false to suppress it in prose only.
      if (document.getAttribute('enterprise-beta-badge', 'true') === 'true') {
        const betaBadge = buildBetaBadge(entry)
        if (betaBadge) content += ` ${betaBadge}`
      }
      // The xref inside the span is resolved by the 'macros' substitution,
      // the same mechanism the config_ref macro relies on.
      return self.createInline(parent, 'quoted', content, { attributes: { subs: 'macros' } })
    })
  }
}

function enterpriseFeaturesBlockMacro (config) {
  return function () {
    const self = this
    self.named('enterprise_features')
    self.process(function (parent, target, attributes) {
      const scope = (target || attributes.scope || '').trim()
      if (!VALID_SCOPES.includes(scope)) {
        throw new Error(`enterprise_features::[] needs a scope of ${VALID_SCOPES.join(', ')} as its target, got '${scope}'.`)
      }
      const registry = config && config.contentCatalog ? loadRegistry(config) : undefined
      if (!registry) {
        warnNoRegistry()
        return self.parseContent(parent, `WARNING: The enterprise features registry is unavailable, so the ${scope} feature table cannot be rendered.`)
      }
      const table = buildFeatureTable(registry.features, scope, { title: attributes.title, heading: attributes.heading })
      // A block anchor before the macro call ([[my-id]]) is consumed into the
      // macro's id attribute. Re-emit it so crossrefs to the table keep working.
      const source = attributes.id ? `[[${attributes.id}]]\n${table}` : table
      return self.parseContent(parent, source)
    })
  }
}

function register (registry, config = {}) {
  if (typeof registry.register === 'function') {
    registry.register(function () {
      this.inlineMacro(enterpriseInlineMacro(config))
      this.blockMacro(enterpriseFeaturesBlockMacro(config))
    })
  } else if (typeof registry.inlineMacro === 'function') {
    registry.inlineMacro(enterpriseInlineMacro(config))
    if (typeof registry.blockMacro === 'function') registry.blockMacro(enterpriseFeaturesBlockMacro(config))
  } else {
    console.warn("no 'inlineMacro' method on alleged registry")
  }
  return registry
}

module.exports.register = register
module.exports.buildEnterpriseContent = buildEnterpriseContent
module.exports.buildFeatureTable = buildFeatureTable
module.exports.parseRegistry = parseRegistry
module.exports.resolveEntryXref = resolveEntryXref
module.exports.resolveTooltipAttribute = resolveTooltipAttribute
