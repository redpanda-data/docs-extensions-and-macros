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
 * The macro validates its target against the published property reference: a
 * redpanda-properties-<tag>.json attachment in the reference module, the same
 * data the tooltips fetch at runtime. Each release series publishes its own
 * copy, and a page is matched to the copy for its OWN series -- see
 * loadPropertiesFor. Unknown names are reported according to the
 * property-validate attribute; every warning names the dataset the page was
 * checked against, so a typo can be told apart from a release mismatch.
 *
 * With link=true, the property also links to its reference page. The page
 * is discovered dynamically: the macro indexes which reference-module page
 * in the current component documents each property, by scanning property
 * headings in the partials each page includes (respecting include tag
 * filters such as tags=redpanda-cloud). Links therefore stay correct per
 * component (streaming, cloud, agentic-data-plane, connect) and keep
 * working if properties are split across different pages in the future.
 * The xref is component-relative (no component ID). Use page= to override
 * the target entirely. This supersedes the config_ref macro's linking for
 * most uses, without requiring writers to know the page.
 *
 * When the current component's reference doesn't document the property, the
 * outcome depends on whether another component's does:
 *
 *   - Published elsewhere but not here (a topic property on a cloud page:
 *     cloud publishes the cluster and object storage references only). The
 *     property doesn't apply to this audience, so the macro logs a warning
 *     and renders plain inline code -- no link, no marker, no tooltip.
 *     Linking would send cloud readers to self-managed documentation for a
 *     setting they cannot change. The exception is a component that
 *     publishes no property reference at all (connect, this repo's preview
 *     site): with no local reference to prefer, it borrows the streaming
 *     (or ROOT) pages through a component-qualified xref.
 *   - Published nowhere in the build (a deprecated property, or one held
 *     back by include tags). The marker and its tooltip stay, since the
 *     published JSON still describes the property accurately, but there is
 *     no page to link: link=true renders unlinked and warns.
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
// Release series a component version has no property data for, recorded at
// load time and reported by the macro on first actual use.
const $propertySeriesGap = Symbol('$propertySeriesGap')

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
  // Antora replaces each page's contents with converted HTML as it goes, so
  // an index built lazily mid-conversion can miss includes on pages that
  // already converted. The property-page-index extension warms this cache
  // before conversion starts; warn when that safety net is absent.
  if (pages.some((candidate) => candidate.contents.toString('utf8', 0, 200).trimStart().startsWith('<'))) {
    console.warn(chalk.yellow(`prop macro: building the property page index for ${component}@${version || 'any'} after conversion started; some pages are already HTML and their properties may not be indexed. Register '@redpanda-data/docs-extensions-and-macros/extensions/property-page-index' under antora.extensions to build the index up front.`))
  }
  for (const page of pages) {
    const source = page.contents.toString()
    const pagePath = page.src.relative.replace(/\.adoc$/, '')
    const pageUrl = (page.pub && page.pub.url) || undefined
    for (const line of source.split('\n')) {
      const heading = line.match(HEADING_RX)
      if (heading && Object.prototype.hasOwnProperty.call(properties, heading[1])) {
        index.set(heading[1], { page: pagePath, url: pageUrl })
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
        if (!index.has(entry.name)) index.set(entry.name, { page: pagePath, url: pageUrl })
      }
    }
  }
  cache[cacheKey] = index
  return index
}

/**
 * The anchor Asciidoctor generates for a property heading. With the docs'
 * idseparator '-', invalid id characters (dots) become hyphens while
 * underscores are valid and stay: '=== cloud_storage_enabled' gets the id
 * 'cloud_storage_enabled', '=== redpanda.storage.mode' gets
 * 'redpanda-storage-mode'.
 */
function propertyAnchor (name) {
  return name.replace(/\./g, '-')
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

// Warnings are deduplicated per build. Antora's watch mode (gulp/npm start)
// reuses one process across many builds, so a module-level guard would report
// each problem only on a session's first build and stay silent afterwards --
// exactly when a writer is iterating and most wants to see it. The content
// catalog is rebuilt per build, so keying off it scopes the guard correctly.
const $warned = Symbol('$warned')

function warnOnce (contentCatalog, key, message) {
  const seen = contentCatalog[$warned] || (contentCatalog[$warned] = new Set())
  if (seen.has(key)) return false
  seen.add(key)
  console.warn(chalk.yellow(message))
  return true
}

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
 * The release series ('26.2') of a component version ('26.2', '25.3.1') or a
 * properties tag ('v26.2.1', 'v26.3.1-rc1'). Undefined for non-numeric
 * versions, which is how unversioned components (cloud, connect) and named
 * branches are recognized.
 */
function releaseSeries (value) {
  const match = String(value == null ? '' : value).replace(/^v/, '').match(/^(\d+)\.(\d+)/)
  return match ? `${match[1]}.${match[2]}` : undefined
}

/**
 * Load and cache the property map for one page's component and version.
 * Returns undefined when no suitable dataset exists.
 *
 * Every published Redpanda release series has its own properties JSON, so a
 * versioned page must validate against the data for its OWN series: a 25.3
 * page checked against 26.2 data reports properties that release never had
 * and flags removed ones as typos. The macro therefore matches by series
 * (major.minor) rather than taking the newest tag it can find -- the docs
 * repo's main branch carries an older series' JSON alongside its own, and
 * older version branches may carry none at all. When a versioned component
 * publishes property data but nothing for the page's series, the page goes
 * unvalidated with an explicit warning rather than borrowing the wrong
 * release's data.
 *
 * Components with no property data of their own (cloud, connect) borrow the
 * streaming (or ROOT) dataset -- their own series when their version names
 * one, otherwise the newest, since an unversioned doc set or one versioned
 * independently of Redpanda releases tracks the current release.
 */
function loadProperties (config) {
  const contentCatalog = config && config.contentCatalog
  if (!contentCatalog) return undefined
  const pageComponent = (config.file && config.file.src && config.file.src.component) || ''
  const pageVersion = (config.file && config.file.src && config.file.src.version) || ''
  return loadPropertiesFor(contentCatalog, pageComponent, pageVersion)
}

/**
 * Same as loadProperties, addressable by component and version so the
 * property-page-index extension can warm the caches before conversion.
 */
function loadPropertiesFor (contentCatalog, pageComponent, pageVersion) {
  const cacheKey = `${pageComponent}@${pageVersion}` || '$any'
  const cache = contentCatalog[$propertyRegistry] || (contentCatalog[$propertyRegistry] = {})
  if (cache[cacheKey] !== undefined) return cache[cacheKey] || undefined

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

  const ownComponent = candidates.filter((c) => c.component === pageComponent)
  const series = releaseSeries(pageVersion)
  let pick
  if (ownComponent.length && series) {
    // Newest patch of this page's own series: prefer the copy published on
    // the page's own version, then the same series published anywhere in the
    // component (a series' JSON sometimes lives only on the main branch).
    const inSeries = ownComponent.filter((c) => releaseSeries(c.tag) === series)
    pick = newest(inSeries.filter((c) => c.version === pageVersion)) || newest(inSeries)
    if (!pick) {
      // Record the gap rather than reporting it here. This function also runs
      // from the property-page-index extension, once per component version in
      // the build, so warning at load time would report every version that
      // lacks data even when none of its pages uses the macro. The macro
      // reports it on first actual use instead.
      const gaps = contentCatalog[$propertySeriesGap] || (contentCatalog[$propertySeriesGap] = {})
      gaps[cacheKey] = {
        component: pageComponent,
        version: pageVersion,
        series,
        have: [...new Set(ownComponent.map((c) => c.tag))].sort(compareTags),
      }
      cache[cacheKey] = null
      return undefined
    }
  } else if (ownComponent.length) {
    pick = newest(ownComponent.filter((c) => c.version === pageVersion)) || newest(ownComponent)
  } else {
    // No property data of this component's own. Borrow streaming's (or
    // ROOT's), but still honor the page's series when it has one: a component
    // versioned per Redpanda release must not be handed the newest release's
    // properties. Components whose versions are unrelated to Redpanda releases
    // (or unversioned, like cloud and connect today) have no series to match
    // and correctly track the latest.
    const borrow = (component) => {
      const from = candidates.filter((c) => c.component === component)
      if (!from.length) return null
      return (series && newest(from.filter((c) => releaseSeries(c.tag) === series))) || newest(from)
    }
    pick = borrow('streaming') || borrow('ROOT') || newest(candidates)
  }

  let registry = null
  if (pick) {
    const data = JSON.parse(pick.file.contents.toString())
    if (data && data.properties) {
      registry = { tag: pick.tag, properties: data.properties, component: pick.component, version: pick.version }
    }
  }
  // Cache null too, so a missing JSON is only searched for once per build.
  cache[cacheKey] = registry
  return registry || undefined
}

/**
 * The component publishes property data for other release series but none for
 * this page's. Silently validating against a neighbouring release is what this
 * warning exists to prevent, so say exactly which file is missing and how to
 * produce it. Returns whether a gap was found and reported.
 */
function warnSeriesMissing (contentCatalog, pageComponent, pageVersion) {
  const gaps = contentCatalog[$propertySeriesGap]
  const gap = gaps && gaps[`${pageComponent}@${pageVersion}`]
  if (!gap) return false
  const { series, have: tags } = gap
  const have = tags.join(', ')
  warnOnce(contentCatalog, `series:${gap.component}@${gap.version}`,
    `prop macro: ${gap.component}@${gap.version} publishes no redpanda-properties-v${series}.*.json attachment in its reference module (found for other series: ${have}). ` +
    `prop: targets on ${pageVersion} pages are therefore not validated and their tooltips carry no data, rather than being checked against another release's properties. ` +
    `Generate it with 'npx doc-tools generate property-docs --tag v${series}.<patch>' on that branch, or leave prop: out of ${pageVersion} content.`)
  // A gap was found and explained, whether or not this build already said so.
  return true
}

function warnNoPropertyData (contentCatalog, component, version) {
  warnOnce(contentCatalog, `nodata:${component}@${version}`,
    `prop macro: no redpanda-properties-<tag>.json attachment found in any component's reference module for ${component || 'unknown component'}@${version || 'unversioned'}; ` +
    'prop: targets are not validated and their tooltips carry no data. Publish the property JSON as a reference-module attachment in this component or in streaming.')
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
  const message = `prop:${name}[]${where}: '${name}' is not in the property data this page validates against (${describeDataset(registry)}). ` +
    `Either the name is misspelled or the property does not exist in that release.${hint}`
  if (mode === 'error') throw new Error(message)
  console.warn(chalk.yellow(message))
}

/**
 * Which properties JSON a page was checked against. Named in every warning
 * so a reader can tell a typo apart from a release or component mismatch --
 * the same name can be valid in one series and absent from another.
 */
function describeDataset (registry) {
  const from = registry.component
    ? `${registry.component}@${registry.version || 'unversioned'}`
    : 'unknown component'
  return `redpanda-properties-${registry.tag}.json from ${from}`
}

/**
 * Report a property that another component's reference documents but this
 * one's does not. The name is real (it validated against the published
 * JSON), so this is an audience mismatch rather than a typo: the mention
 * belongs to a doc set that doesn't publish the property.
 */
function reportWrongAudienceProperty ({ name, component, elsewhereComponent, elsewherePage, mode, filePath }) {
  if (mode === 'off') return
  const where = filePath ? ` in ${filePath}` : ''
  const which = component || 'this'
  const found = elsewhereComponent
    ? ` It is published in the ${elsewhereComponent} component (${elsewherePage}), but that reference is written for a different audience, so linking there would point readers at a property they cannot set.`
    : ''
  console.warn(chalk.yellow(
    `prop:${name}[]${where}: no property reference page in the ${which} component documents '${name}', so it renders as plain code -- no link, and no tooltip.${found} ` +
    `Fix it either way: if this audience CAN set '${name}', publish it on the ${which} component's reference pages (check the property's include tags in the generated partial); if not, reword the sentence and drop the macro.`
  ))
}

/**
 * Report a property that the published data describes but no reference page
 * in the build renders. The tooltip still works, so this only matters when a
 * writer explicitly asked for a link.
 */
function reportUnpublishedProperty ({ name, registry, mode, filePath }) {
  if (mode === 'off') return
  const where = filePath ? ` in ${filePath}` : ''
  console.warn(chalk.yellow(
    `prop:${name}[link=true]${where}: '${name}' is in ${describeDataset(registry)} but no reference page in this build renders a heading for it, so the tooltip renders without a documentation link. ` +
    'Every property reference page filters out the deprecated and exclude-from-docs include tags, and some pages include only selected category tags -- check which tags enclose this property in the generated partial. ' +
    'If it is meant to stay unpublished (a deprecated property, say), drop link=true and keep the tooltip-only form.'
  ))
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
 * @param {boolean} [opts.plain] - Render unmarked code (no tooltip, no link)
 *   because no reference page in this component documents the property.
 * @returns {string}
 */
function buildPropContent ({ name, text, link, page, scope, role, componentPrefix = '', helmPath = false, docUrl, plain = false }) {
  const display = text || (helmPath ? helmValuesPath(name, scope) : name)
  // Without a reference page to point at, the marker would give the docs UI
  // nothing to link from its tooltip, so drop the marking entirely.
  if (plain) return `<code>${display}</code>`
  let inner = display
  if (link) {
    const targetPage = page || SCOPE_PAGES[scope] || SCOPE_PAGES.cluster
    inner = `xref:${componentPrefix}reference:${targetPage}.adoc#${propertyAnchor(name)}[${display}]`
  }
  // The published URL of the page that documents this property, discovered
  // at build time. The docs UI prefers it for the tooltip's documentation
  // link -- the client can't know which scopes a component publishes or
  // which page a shared property landed on.
  const docAttr = docUrl ? ` data-doc-url="${docUrl}"` : ''
  return `<code class="${role}" data-property-name="${name}"${docAttr}>${inner}</code>`
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
        if (!registry && document.getAttribute('property-validate', 'warn') !== 'off') {
          const component = (config.file && config.file.src && config.file.src.component) || ''
          const version = (config.file && config.file.src && config.file.src.version) || ''
          // Prefer the specific diagnosis (this version's series has no data)
          // over the general one (the build has no property data at all).
          if (!warnSeriesMissing(config.contentCatalog, component, version)) {
            warnNoPropertyData(config.contentCatalog, component, version)
          }
        }
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
      // Discover which page documents the property. The current component's
      // own reference wins.
      let discoveredPage
      let discoveredUrl
      let componentPrefix = ''
      // Documented in another component but not in this one: the audiences
      // differ, so borrowing that page is worse than not linking.
      let wrongAudience = false
      // Documented nowhere in this build. Nothing to link, but the property
      // is real and its tooltip still describes it accurately.
      let unpublished = false
      const linkRequested = attributes.link === 'true' || attributes.link === true
      if (registry && config.contentCatalog && !attributes.page) {
        const component = (config.file && config.file.src && config.file.src.component) || ''
        const version = (config.file && config.file.src && config.file.src.version) || ''
        const ownIndex = buildPageIndex(config.contentCatalog, component, registry.properties, version)
        const ownEntry = ownIndex.get(name)
        if (ownEntry) {
          discoveredPage = ownEntry.page
          discoveredUrl = ownEntry.url
        } else {
          let elsewhere
          let elsewhereComponent
          let fallbackWithPages = false
          for (const fallbackComponent of ['streaming', 'ROOT']) {
            if (fallbackComponent === component) continue
            // A component-qualified xref without a version resolves to the
            // fallback component's latest version, so consult exactly that
            // version's index (which the property-page-index extension warms).
            const latest = typeof config.contentCatalog.getComponent === 'function' &&
              config.contentCatalog.getComponent(fallbackComponent)
            const fallbackVersion = (latest && latest.latest && latest.latest.version) || undefined
            const fallbackIndex = buildPageIndex(config.contentCatalog, fallbackComponent, registry.properties, fallbackVersion)
            if (fallbackIndex.size === 0) continue
            fallbackWithPages = true
            const fallbackEntry = fallbackIndex.get(name)
            if (fallbackEntry) {
              elsewhere = fallbackEntry
              elsewhereComponent = fallbackComponent
              break
            }
          }
          if (elsewhere && ownIndex.size === 0) {
            // This component publishes no property reference at all (connect,
            // this repo's preview site), so there is no local reference to
            // prefer: borrow the other component's page.
            discoveredPage = elsewhere.page
            discoveredUrl = elsewhere.url
            componentPrefix = `${elsewhereComponent}:`
          } else if (elsewhere) {
            // The property is published, just not for this component's
            // audience -- a topic property on a cloud page, say, where cloud
            // publishes only the cluster and object storage references.
            // Linking would send cloud readers to self-managed docs for a
            // setting they cannot change.
            wrongAudience = { component: elsewhereComponent, page: elsewhere.page }
          } else if (ownIndex.size > 0 || fallbackWithPages) {
            // Reference pages exist, but none documents this property (a
            // deprecated property, or one excluded by include tags). Nothing
            // to link, but the tooltip still describes it correctly.
            unpublished = true
          }
        }
        // An unrecognized name lands here too, but reportUnknownProperty has
        // already covered it; a second warning would only add noise.
        if (entry) {
          const mode = document.getAttribute('property-validate', 'warn')
          const filePath = config.file && config.file.src && config.file.src.path
          if (wrongAudience) {
            reportWrongAudienceProperty({
              name,
              component,
              elsewhereComponent: wrongAudience.component,
              elsewherePage: wrongAudience.page,
              mode,
              filePath,
            })
          } else if (unpublished && linkRequested) {
            reportUnpublishedProperty({ name, registry, mode, filePath })
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
        link: linkRequested && !wrongAudience && !unpublished,
        page: attributes.page || discoveredPage,
        scope: entry && entry.config_scope,
        role: document.getAttribute('property-ref-role', DEFAULT_ROLE),
        componentPrefix,
        helmPath,
        docUrl: discoveredUrl ? `${discoveredUrl}#${propertyAnchor(name)}` : undefined,
        plain: wrongAudience,
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
module.exports.propertyAnchor = propertyAnchor
module.exports.helmValuesPath = helmValuesPath
module.exports.loadPropertiesFor = loadPropertiesFor
module.exports.compareTags = compareTags
module.exports.releaseSeries = releaseSeries
module.exports.extractHeadingsWithTags = extractHeadingsWithTags
module.exports.evaluateTagExpression = evaluateTagExpression
module.exports.buildPageIndex = buildPageIndex
