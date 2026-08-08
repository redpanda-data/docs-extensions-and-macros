'use strict'

/* Inline macro for referencing Redpanda configuration properties in prose.
 *
 * Example use in a page:
 *
 *   prop:cloud_storage_enabled[]
 *   prop:iceberg_enabled[link=true]
 *   prop:retention_ms[link=true,page=properties/topic-properties]
 *   prop:write_caching_default[text=write caching]
 *
 * The property renders as a marked <code> element that the docs UI decorates
 * with a hover-documentation tooltip. Marking is opt-in: only properties
 * referenced through this macro get tooltips, so ambiguous words such as
 * `admin` or `rack` in unrelated contexts (Helm values, feature settings)
 * are never decorated by mistake.
 *
 * The macro validates its target against the published property reference
 * (the newest redpanda-properties-<tag>.json attachment in the reference
 * module, the same data the tooltips fetch at runtime). Unknown names are
 * reported according to the property-validate attribute. When no property
 * JSON is available in the build, the macro renders unvalidated with a
 * single warning.
 *
 * With link=true, the property also links to its reference page, derived
 * from the property's config_scope in the published JSON (cluster, broker,
 * or topic). Use page= to override the target page (for example,
 * properties/object-storage-properties). This supersedes the config_ref
 * macro's linking for most uses, without requiring writers to know the page.
 *
 * Document or site attributes:
 *
 *   property-validate     'warn' (default) to log unknown property names,
 *                         'error' to fail the build, 'off' to disable
 *                         validation.
 *   property-ref-role     CSS class applied to the code element
 *                         (default: property-ref).
 *
 * Example use in a playbook:
 *
 *   asciidoc:
 *     extensions:
 *     - '@redpanda-data/docs-extensions-and-macros/macros/prop'
 */

const chalk = require('chalk')

const $propertyRegistry = Symbol('$propertyRegistry')

const DEFAULT_ROLE = 'property-ref'
const PROPERTIES_JSON_RX = /^redpanda-properties-(v\d+\.\d+\.\d+(?:-[\w.]+)?)\.json$/

const SCOPE_PAGES = {
  cluster: 'properties/cluster-properties',
  broker: 'properties/broker-properties',
  topic: 'properties/topic-properties',
}

let warnedNoRegistry = false

/**
 * Compare two vX.Y.Z(-pre) tags without a semver dependency. Good enough to
 * pick the newest properties attachment.
 */
function compareTags (a, b) {
  const parse = (tag) => tag.replace(/^v/, '').split('-')[0].split('.').map(Number)
  const [a1, a2, a3] = parse(a)
  const [b1, b2, b3] = parse(b)
  return a1 - b1 || a2 - b2 || a3 - b3
}

/**
 * Load and cache the property map from the newest published properties JSON
 * attachment in the content catalog. Returns undefined when unavailable.
 */
function loadProperties (config) {
  const contentCatalog = config && config.contentCatalog
  if (!contentCatalog) return undefined
  if (contentCatalog[$propertyRegistry] !== undefined) return contentCatalog[$propertyRegistry] || undefined
  let registry = null
  const attachments = contentCatalog.findBy({ family: 'attachment' }) || []
  let newest = null
  for (const attachment of attachments) {
    if (attachment.src.module !== 'reference') continue
    const basename = attachment.src.relative.split('/').pop()
    const match = basename.match(PROPERTIES_JSON_RX)
    if (!match) continue
    if (!newest || compareTags(match[1], newest.tag) > 0) newest = { tag: match[1], file: attachment }
  }
  if (newest) {
    const data = JSON.parse(newest.file.contents.toString())
    if (data && data.properties) {
      registry = { tag: newest.tag, properties: data.properties }
    }
  }
  // Cache null too, so a missing JSON is only searched for once per build.
  contentCatalog[$propertyRegistry] = registry
  return registry || undefined
}

function warnNoPropertyData () {
  if (warnedNoRegistry) return
  warnedNoRegistry = true
  console.warn(chalk.yellow('Property reference data (redpanda-properties-<tag>.json attachment) not found; prop: targets are not validated.'))
}

/**
 * Report an unknown property name according to the property-validate mode.
 */
function reportUnknownProperty ({ name, mode, registry, filePath }) {
  if (mode === 'off') return
  const fragment = name.trim().toLowerCase()
  const commonPrefix = (a, b) => {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return i
  }
  const candidates = Object.keys(registry.properties)
    .map((candidate) => ({ candidate, shared: commonPrefix(candidate.toLowerCase(), fragment) }))
    .filter((scored) => scored.shared >= Math.min(6, fragment.length))
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 3)
    .map((scored) => scored.candidate)
  const hint = candidates.length ? ` Did you mean: ${candidates.join(', ')}?` : ''
  const where = filePath ? ` in ${filePath}` : ''
  const message = `prop:${name}[] does not match any property in the published property reference (${registry.tag})${where}.${hint}`
  if (mode === 'error') throw new Error(message)
  console.warn(chalk.yellow(message))
}

/**
 * Build the AsciiDoc content emitted for one macro instance. Exported for
 * unit testing.
 *
 * @param {object} opts
 * @param {string} opts.name - Property name.
 * @param {string} [opts.text] - Display text override.
 * @param {boolean} opts.link - Whether to link to the reference page.
 * @param {string} [opts.page] - Reference page override (module-relative, no .adoc).
 * @param {string} [opts.scope] - config_scope from the published JSON.
 * @param {string} opts.role - CSS class for the code element.
 * @returns {string}
 */
function buildPropContent ({ name, text, link, page, scope, role }) {
  const display = text || name
  let inner = display
  if (link) {
    const targetPage = page || SCOPE_PAGES[scope] || SCOPE_PAGES.cluster
    inner = `xref:reference:${targetPage}.adoc#${name}[${display}]`
  }
  return `<code class="${role}" data-property-name="${name}">${inner}</code>`
}

function propInlineMacro (config) {
  return function () {
    const self = this
    self.named('prop')
    self.process(function (parent, target, attributes) {
      const document = parent.getDocument()
      const name = target.trim()
      let registry
      let entry
      if (config && config.contentCatalog) {
        registry = loadProperties(config)
        if (!registry) warnNoPropertyData()
      }
      if (registry) {
        entry = registry.properties[name]
        if (!entry) {
          reportUnknownProperty({
            name,
            mode: document.getAttribute('property-validate', 'warn'),
            registry,
            filePath: config && config.file && config.file.src && config.file.src.path,
          })
        }
      }
      const content = buildPropContent({
        name,
        text: attributes.text,
        link: attributes.link === 'true' || attributes.link === true,
        page: attributes.page,
        scope: entry && entry.config_scope,
        role: document.getAttribute('property-ref-role', DEFAULT_ROLE),
      })
      // The xref inside the code element is resolved by the 'macros'
      // substitution, the same mechanism the enterprise macro relies on.
      return self.createInline(parent, 'quoted', content, { attributes: { subs: 'macros' } })
    })
  }
}

function register (registry, config = {}) {
  if (typeof registry.register === 'function') {
    registry.register(function () {
      this.inlineMacro(propInlineMacro(config))
    })
  } else if (typeof registry.inlineMacro === 'function') {
    registry.inlineMacro(propInlineMacro(config))
  } else {
    console.warn("no 'inlineMacro' method on alleged registry")
  }
  return registry
}

module.exports.register = register
module.exports.buildPropContent = buildPropContent
module.exports.compareTags = compareTags
