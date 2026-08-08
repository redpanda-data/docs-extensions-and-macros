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
 * With link=true, the property also links to its reference page. The page
 * is discovered dynamically: the macro indexes which reference-module page
 * in the current component documents each property, by scanning property
 * headings in the partials each page includes (respecting include tag
 * filters such as tags=redpanda-cloud). Links therefore stay correct per
 * component (streaming, cloud, agentic-data-plane, connect) and keep
 * working if properties are split across different pages in the future.
 * When discovery finds nothing, the page falls back deterministically to
 * the property's config_scope (cluster, broker, or topic). The xref is
 * component-relative (no component ID). Use page= to override the target
 * entirely. This supersedes the config_ref macro's linking for most uses,
 * without requiring writers to know the page.
 *
 * With helm-path=auto, pages rendered with the env-kubernetes attribute
 * display the property as its Helm values path (storage.tiered.config.*
 * for tiered storage properties, config.node.* for broker properties, and
 * config.cluster.* for other cluster properties), so single-sourced
 * content reads correctly for both Linux and Kubernetes audiences. This
 * replaces the config_ref macro's hardcoded storage.tiered.config prefix,
 * which mislabeled non-tiered properties.
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

// Deterministic fallback only. The primary mechanism is dynamic discovery:
// the macro indexes which reference-module page actually documents each
// property (by scanning property headings in the partials each page
// includes, respecting include tag filters), so links keep working if
// properties are ever split across different pages.
const SCOPE_PAGES = {
  cluster: 'properties/cluster-properties',
  broker: 'properties/broker-properties',
  topic: 'properties/topic-properties',
}

const $propertyPageIndex = Symbol('$propertyPageIndex')
const HEADING_RX = /^=+\s+(\S+)\s*$/
const TAG_MARKER_RX = /^\/\/\s*(tag|end)::([\w-]+)\[\]\s*$/
const INCLUDE_RX = /^include::([^[]+)\[([^\]]*)\]/

/**
 * Extract property-style headings from AsciiDoc source together with the
 * include tags that enclose them.
 *
 * @param {string} source
 * @returns {{name: string, tags: string[]}[]}
 */
function extractHeadingsWithTags (source) {
  const headings = []
  const open = []
  for (const line of source.split('\n')) {
    const marker = line.match(TAG_MARKER_RX)
    if (marker) {
      if (marker[1] === 'tag') open.push(marker[2])
      else {
        const at = open.lastIndexOf(marker[2])
        if (at !== -1) open.splice(at, 1)
      }
      continue
    }
    const heading = line.match(HEADING_RX)
    if (heading) headings.push({ name: heading[1], tags: [...open] })
  }
  return headings
}

/**
 * Evaluate an include tags= expression against the tags enclosing a heading.
 * Supports the forms used by the property pages: a semicolon-separated list
 * of tag names, each optionally negated with '!'.
 *
 * @param {string[]} headingTags
 * @param {string|undefined} expression
 * @returns {boolean} Whether the heading survives the include.
 */
function evaluateTagExpression (headingTags, expression) {
  if (!expression) return true
  const items = expression.split(/[;,]/).map((item) => item.trim()).filter(Boolean)
  const positives = items.filter((item) => !item.startsWith('!'))
  const negatives = items.filter((item) => item.startsWith('!')).map((item) => item.slice(1))
  if (negatives.some((tag) => headingTags.includes(tag))) return false
  if (positives.length > 0) return positives.some((tag) => headingTags.includes(tag))
  return true
}

/**
 * Resolve an include target such as
 * 'streaming:reference:partial$properties/cluster-properties.adoc' into its
 * component, module, and relative path. Component and module default to the
 * including page's.
 */
function parsePartialTarget (target, pageSrc) {
  const at = target.indexOf('partial$')
  if (at === -1) return undefined
  const prefix = target.slice(0, at).replace(/:$/, '')
  const relative = target.slice(at + 'partial$'.length)
  const parts = prefix ? prefix.split(':') : []
  if (parts.length === 2) return { component: parts[0], module: parts[1], relative }
  if (parts.length === 1) return { component: pageSrc.component, module: parts[0], relative }
  return { component: pageSrc.component, module: pageSrc.module, relative }
}

/**
 * Build (and cache) the property -> page index for one component by scanning
 * the reference-module pages and the partials they include.
 *
 * @param {object} contentCatalog
 * @param {string} component
 * @param {object} properties - Known property names from the published JSON.
 * @returns {Map<string, string>} property name -> page path without .adoc
 */
function buildPageIndex (contentCatalog, component, properties, version) {
  const cache = contentCatalog[$propertyPageIndex] || (contentCatalog[$propertyPageIndex] = {})
  const cacheKey = `${component}@${version || ''}`
  if (cache[cacheKey]) return cache[cacheKey]
  const index = new Map()
  const partialHeadings = new Map()
  const headingsFor = (file) => {
    if (!partialHeadings.has(file)) partialHeadings.set(file, extractHeadingsWithTags(file.contents.toString()))
    return partialHeadings.get(file)
  }
  // Restrict the index to the page's own component version, so a page on an
  // older docs branch never links into (or claims pages from) another version.
  const query = { component, module: 'reference', family: 'page' }
  if (version !== undefined && version !== '') query.version = version
  const pages = contentCatalog.findBy(query) || []
  for (const page of pages) {
    const source = page.contents.toString()
    const pagePath = page.src.relative.replace(/\.adoc$/, '')
    for (const line of source.split('\n')) {
      const heading = line.match(HEADING_RX)
      if (heading && Object.prototype.hasOwnProperty.call(properties, heading[1])) {
        index.set(heading[1], pagePath)
        continue
      }
      const include = line.match(INCLUDE_RX)
      if (!include) continue
      const partialRef = parsePartialTarget(include[1].trim(), page.src)
      if (!partialRef) continue
      const tagsMatch = include[2].match(/tags?=([^,\]]+)/)
      const expression = tagsMatch && tagsMatch[1]
      const partials = contentCatalog.findBy({ component: partialRef.component, module: partialRef.module, family: 'partial' }) || []
      const matching = partials.filter((candidate) => candidate.src.relative === partialRef.relative)
      // Same-component includes resolve within the page's version; for
      // cross-component includes take whichever version the catalog has.
      const partial = matching.find((candidate) => candidate.src.version === page.src.version) || matching[0]
      if (!partial) continue
      for (const entry of headingsFor(partial)) {
        if (!Object.prototype.hasOwnProperty.call(properties, entry.name)) continue
        if (!evaluateTagExpression(entry.tags, expression)) continue
        if (!index.has(entry.name)) index.set(entry.name, pagePath)
      }
    }
  }
  cache[cacheKey] = index
  return index
}

// Helm values paths for setting properties on Kubernetes. Deterministic:
// tiered storage properties keep the chart's dedicated storage.tiered.config
// block (which also wires credentials), broker/node properties map to
// config.node, and every other cluster property maps to config.cluster --
// the path the docs recommend for all cluster properties.
function helmValuesPath (name, scope) {
  if (name.startsWith('cloud_storage_')) return `storage.tiered.config.${name}`
  if (scope === 'broker') return `config.node.${name}`
  return `config.cluster.${name}`
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
 * attachment in the content catalog. Properties are published per component
 * (streaming, cloud, sometimes agentic-data-plane and connect), so the JSON
 * from the page's own component wins, falling back to the streaming (or
 * ROOT) component, then to the newest JSON anywhere in the catalog. Returns
 * undefined when unavailable.
 */
function loadProperties (config) {
  const contentCatalog = config && config.contentCatalog
  if (!contentCatalog) return undefined
  const pageComponent = (config.file && config.file.src && config.file.src.component) || ''
  const pageVersion = (config.file && config.file.src && config.file.src.version) || ''
  const cacheKey = `${pageComponent}@${pageVersion}` || '$any'
  const cache = contentCatalog[$propertyRegistry] || (contentCatalog[$propertyRegistry] = {})
  if (cache[cacheKey] !== undefined) return cache[cacheKey] || undefined

  // Versioned components publish one properties JSON per version, so a page
  // must validate against its OWN version's data (a 25.3 page checked
  // against 26.x data would produce wrong results in both directions).
  // Priority: own component and version, own component any version (newest
  // tag), then the streaming/ROOT fallbacks, then anything.
  const attachments = contentCatalog.findBy({ family: 'attachment' }) || []
  const candidates = []
  for (const attachment of attachments) {
    if (attachment.src.module !== 'reference') continue
    const basename = attachment.src.relative.split('/').pop()
    const match = basename.match(PROPERTIES_JSON_RX)
    if (!match) continue
    candidates.push({ tag: match[1], file: attachment, component: attachment.src.component, version: attachment.src.version })
  }
  const newest = (list) => list.reduce((best, entry) => (!best || compareTags(entry.tag, best.tag) > 0 ? entry : best), null)
  const pick =
    newest(candidates.filter((c) => c.component === pageComponent && c.version === pageVersion)) ||
    newest(candidates.filter((c) => c.component === pageComponent)) ||
    newest(candidates.filter((c) => c.component === 'streaming')) ||
    newest(candidates.filter((c) => c.component === 'ROOT')) ||
    newest(candidates)

  let registry = null
  if (pick) {
    const data = JSON.parse(pick.file.contents.toString())
    if (data && data.properties) {
      registry = { tag: pick.tag, properties: data.properties }
    }
  }
  // Cache null too, so a missing JSON is only searched for once per build.
  cache[cacheKey] = registry
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
 * @param {string} [opts.componentPrefix] - 'component:' prefix when the link
 *   must leave the current component (which publishes no property pages).
 * @returns {string}
 */
function buildPropContent ({ name, text, link, page, scope, role, componentPrefix = '', helmPath = false }) {
  const display = text || (helmPath ? helmValuesPath(name, scope) : name)
  let inner = display
  if (link) {
    const targetPage = page || SCOPE_PAGES[scope] || SCOPE_PAGES.cluster
    inner = `xref:${componentPrefix}reference:${targetPage}.adoc#${name}[${display}]`
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
      // Discover which page documents the property. The current component
      // wins. When it doesn't document this property -- either because it
      // publishes no property pages at all (the connect component, this
      // repo's preview site) or because it publishes only a subset (the
      // cloud component has no topic-properties page) -- fall back to the
      // streaming (or ROOT) component and emit a component-qualified xref.
      let discoveredPage
      let componentPrefix = ''
      if (registry && config.contentCatalog && (attributes.link === 'true' || attributes.link === true) && !attributes.page) {
        const component = (config.file && config.file.src && config.file.src.component) || ''
        const version = (config.file && config.file.src && config.file.src.version) || ''
        const ownIndex = buildPageIndex(config.contentCatalog, component, registry.properties, version)
        discoveredPage = ownIndex.get(name)
        if (!discoveredPage) {
          let fallbackWithPages
          for (const fallbackComponent of ['streaming', 'ROOT']) {
            if (fallbackComponent === component) continue
            const fallbackIndex = buildPageIndex(config.contentCatalog, fallbackComponent, registry.properties, undefined)
            if (fallbackIndex.size === 0) continue
            if (!fallbackWithPages) fallbackWithPages = fallbackComponent
            const fallbackPage = fallbackIndex.get(name)
            if (fallbackPage) {
              discoveredPage = fallbackPage
              componentPrefix = `${fallbackComponent}:`
              break
            }
          }
          // Nothing documents the property anywhere: point the scope-derived
          // fallback at a component that at least publishes property pages,
          // unless the current component does.
          if (!discoveredPage && ownIndex.size === 0 && fallbackWithPages) {
            componentPrefix = `${fallbackWithPages}:`
          }
        }
      }
      // helm-path=auto displays the property as its Helm values path on
      // pages rendered with env-kubernetes, so single-sourced content reads
      // correctly for both Linux and Kubernetes audiences (the successor to
      // the config_ref macro's hardcoded storage.tiered.config prefixing).
      const helmPath = attributes['helm-path'] === 'auto' && document.getAttribute('env-kubernetes') !== undefined
      const content = buildPropContent({
        name,
        text: attributes.text,
        link: attributes.link === 'true' || attributes.link === true,
        page: attributes.page || discoveredPage,
        scope: entry && entry.config_scope,
        role: document.getAttribute('property-ref-role', DEFAULT_ROLE),
        componentPrefix,
        helmPath,
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
module.exports.helmValuesPath = helmValuesPath
module.exports.compareTags = compareTags
module.exports.extractHeadingsWithTags = extractHeadingsWithTags
module.exports.evaluateTagExpression = evaluateTagExpression
module.exports.buildPageIndex = buildPageIndex
