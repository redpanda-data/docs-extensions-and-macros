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
 * The macro's job is to check that a property is actually available to the
 * audience reading the page, and to link it only where a page documents it.
 *
 * WHICH PROPERTIES A COMPONENT MAY REFERENCE
 *
 * Property data exists for two doc sets today:
 *
 *   Self-managed (streaming) publishes its own redpanda-properties-<tag>.json
 *   per release, as a reference-module attachment. Every property in that
 *   release's file is available, and a page validates against the file for
 *   its OWN release series: a 25.3 page against 25.3 data, never against a
 *   neighbouring release, which would accept properties that release never
 *   had and flag removed ones as typos.
 *
 *   Cloud is managed streaming, so it has no property data of its own and
 *   always tracks the newest streaming file. Only the properties whose
 *   cloud_supported field is true are available; the rest exist in Redpanda
 *   but cannot be set by a Cloud reader. A Cloud component is recognized by
 *   its env-cloud attribute.
 *
 * Any other component (connect, the agentic data plane, a preview site) has
 * no property data, and none is inferred for it: the macro warns once and
 * renders the property as plain inline code. Supporting a further doc set is
 * a deliberate addition here, not something guessed from a version number --
 * those components carry their own product versions, which say nothing about
 * which Redpanda properties exist.
 *
 * Unavailable and unknown names are reported according to property-validate.
 * Every warning names the dataset the page was checked against, so a typo is
 * distinguishable from an availability or release mismatch.
 *
 * LINKING
 *
 * With link=true the property also links to its reference page, but only when
 * a page in this component actually documents it. The page is discovered by
 * indexing which reference-module page documents each property, scanning
 * property headings in the partials each page includes and respecting include
 * tag filters such as tags=redpanda-cloud. Links are therefore
 * component-relative and stay correct if properties are split across
 * different pages later. Nothing is ever linked across components, and no
 * page target is guessed from a property's scope: a link the build cannot
 * verify would be a broken link. Use page= to set the target explicitly.
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
 *   property-validate     'warn' (default) to log problems, 'error' to fail
 *                         the build on an unknown name, 'off' to disable
 *                         validation and silence these warnings.
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
const semver = require('semver')

const $propertyRegistry = Symbol('$propertyRegistry')
// Release series a component version has no property data for, recorded at
// load time and reported by the macro on first actual use.
const $propertySeriesGap = Symbol('$propertySeriesGap')

const DEFAULT_ROLE = 'property-ref'
// Which slice of a dataset a component may reference.
const SURFACE_ALL = 'all'
const SURFACE_CLOUD = 'cloud'
const PROPERTIES_JSON_RX = /^redpanda-properties-(v\d+\.\d+\.\d+(?:-[\w.]+)?)\.json$/

const $propertyPageIndex = Symbol('$propertyPageIndex')
const HEADING_RX = /^=+\s+(\S+)\s*$/
const TAG_MARKER_RX = /^\/\/\s*(tag|end)::([\w-]+)\[\]\s*$/
const INCLUDE_RX = /^include::([^[]+)\[([^\]]*)\]/
// A reference page declaring the property collection it publishes.
const PROPERTY_SOURCE_RX = /^:page-property-source:[ \t]*(\S.*)$/m
// Claim strength: an explicit declaration beats a generated partial, which
// beats a bare heading that happens to match a property name.
const CLAIM_HEADING = 1
const CLAIM_PARTIAL = 2
const CLAIM_DECLARED = 3
// Delimited block fences: listing, literal, example, sidebar, quote, comment.
const DELIMITER_RX = /^(-{4,}|\.{4,}|={4,}|\*{4,}|_{4,}|\/{4,})$/

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
  // Asciidoctor accepts a quoted value, which is its documented way to write a
  // comma-separated list. Keeping the quotes made the first item look like a
  // positive tag named '"!deprecated', which matches nothing, so the page
  // indexed zero properties and every link on it silently disappeared.
  const unquoted = expression.trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
  const items = unquoted.split(/[;,]/).map((item) => item.trim()).filter(Boolean)
  // '*' selects all tagged regions, '**' all content. Both mean "do not filter
  // on positive tags"; negations still apply.
  const wildcards = items.filter((item) => item === '*' || item === '**')
  if (wildcards.length) {
    const negated = items.filter((item) => item.startsWith('!')).map((item) => item.slice(1))
    return !negated.some((tag) => headingTags.includes(tag))
  }
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
  // Antora replaces contents with converted HTML as it goes, but backs the
  // AsciiDoc up at src.contents first, so prefer that: it makes an index built
  // mid-conversion correct instead of merely reporting that it might be wrong.
  const sourceOf = (file) => ((file.src && file.src.contents) || file.contents || '').toString()
  const headingsFor = (file) => {
    if (!partialHeadings.has(file)) partialHeadings.set(file, extractHeadingsWithTags(sourceOf(file)))
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
  // Converted HTML starts with a tag. AsciiDoc that starts with '<<<' (a page
  // break) or '<<anchor>>' also starts with '<', and tripping on those told the
  // maintainer to register an extension that was often already running.
  const looksConverted = (candidate) => {
    if (candidate.src && candidate.src.contents) return false
    const head = candidate.contents.toString('utf8', 0, 200).trimStart()
    return head.startsWith('<') && !head.startsWith('<<') && /^<[a-zA-Z!/]/.test(head)
  }
  if (pages.some(looksConverted)) {
    console.warn(chalk.yellow(`prop macro: building the property page index for ${component}@${version || 'any'} after conversion started; some pages are already HTML and their properties may not be indexed. Register '@redpanda-data/docs-extensions-and-macros/extensions/property-page-index' under antora.extensions to build the index up front.`))
  }
  // A page can declare that it is the reference for a named collection of
  // properties:
  //
  //   = Cluster Configuration Properties
  //   :page-property-source: cluster-properties
  //
  // Declared pages are authoritative and are visited first, so an ordinary page
  // that merely happens to carry a heading matching a property name -- 'admin',
  // 'rack' -- can never claim it from the reference page that documents it.
  // Sorting also removes the last of the catalog-order dependence: two pages
  // that both surface a property used to resolve by aggregation order, which is
  // stable for one checkout but not meaningful.
  const declarationOf = (page) => {
    const match = sourceOf(page).match(PROPERTY_SOURCE_RX)
    return match ? match[1].trim() : undefined
  }
  const ordered = pages
    .map((page) => ({ page, declared: declarationOf(page) }))
    .sort((a, b) =>
      Number(Boolean(b.declared)) - Number(Boolean(a.declared)) ||
      String(a.page.src.relative).localeCompare(String(b.page.src.relative)))
  // Which page claimed each property, so a conflict between two *declared*
  // sources can be reported rather than silently resolved.
  const claims = new Map()
  for (const { page, declared } of ordered) {
    const source = sourceOf(page)
    const pagePath = page.src.relative.replace(/\.adoc$/, '')
    const pageUrl = (page.pub && page.pub.url) || undefined
    // First claim wins. Declared pages come first, so a declaration always
    // beats inference; two declared pages claiming one property is an authoring
    // conflict worth reporting rather than resolving quietly.
    // Claims are ranked, not first-come. A declared page outranks everything; a
    // property heading pulled in from a generated partial outranks a bare
    // heading that merely happens to match a property name, which is how a page
    // titled '= admin' used to claim the admin broker property from the
    // reference page that documents it.
    const claim = (name, entry, strength) => {
      const rank = declared ? CLAIM_DECLARED : strength
      const existing = claims.get(name)
      if (existing) {
        if (existing.rank > rank) return
        if (existing.rank === rank) {
          // Same standing. Keep the first, and say so when both pages
          // explicitly declared themselves the source: that is an authoring
          // conflict, not something to resolve quietly.
          if (rank === CLAIM_DECLARED) {
            warnOnce(contentCatalog, `claim:${component}:${name}`,
              `prop macro: '${name}' is claimed by two declared property sources in ${component}: ${existing.page} (:page-property-source: ${existing.declared}) and ${pagePath} (:page-property-source: ${declared}). Links use ${existing.page}. Remove the declaration from whichever page is not the reference for it.`)
          }
          return
        }
      }
      claims.set(name, { page: pagePath, declared, rank })
      index.set(name, entry)
    }
    let inDelimitedBlock = false
    for (const line of source.split('\n')) {
      // A property name inside a listing, literal, or comment block is sample
      // text, not documentation of that property. Indexing it handed the
      // property to a page that renders no anchor for it.
      if (DELIMITER_RX.test(line.trim())) {
        inDelimitedBlock = !inDelimitedBlock
        continue
      }
      if (inDelimitedBlock) continue
      const heading = line.match(HEADING_RX)
      if (heading && Object.prototype.hasOwnProperty.call(properties, heading[1])) {
        // First writer wins, as for partial-derived entries. Setting
        // unconditionally let any reference page whose title happens to be a
        // property name -- 'admin', 'rack' -- steal it from the reference page
        // that documents it, and a doctitle produces no anchor at all, so both
        // the link and the tooltip URL pointed at nothing.
        claim(heading[1], { page: pagePath, url: pageUrl }, CLAIM_HEADING)
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
      // Resolve the partial the way Antora does. A same-component include is
      // pinned to the including page's version, so falling back to another
      // version's copy indexed foreign-release content against this page. A
      // version-less cross-component include resolves to that component's
      // latest version, not to whichever copy the catalog yielded first.
      let partial
      if (partialRef.component === page.src.component) {
        partial = matching.find((candidate) => candidate.src.version === page.src.version)
      } else {
        const lender = typeof contentCatalog.getComponent === 'function' &&
          contentCatalog.getComponent(partialRef.component)
        const latest = lender && lender.latest && lender.latest.version
        partial = matching.find((candidate) => candidate.src.version === latest) ||
          [...matching].sort((a, b) => String(b.src.version).localeCompare(String(a.src.version)))[0]
      }
      if (!partial) continue
      for (const entry of headingsFor(partial)) {
        if (!Object.prototype.hasOwnProperty.call(properties, entry.name)) continue
        if (!evaluateTagExpression(entry.tags, expression)) continue
        claim(entry.name, { page: pagePath, url: pageUrl }, CLAIM_PARTIAL)
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
 * Compare two property tags by release precedence, newest last.
 *
 * Prereleases matter here: a release cycle publishes v26.3.1-rc1, then rc2,
 * then the GA v26.3.1, and the beta branch has to land on the newest of them
 * deterministically. A numeric-only comparison rates all three equal, leaving
 * the winner to catalog iteration order -- so rc1 could beat rc2, or an RC
 * could beat its own GA.
 *
 * Redpanda tags spell prereleases as one identifier (-rc2, not -rc.2), which
 * the semver spec compares as a string: 'rc10' would sort below 'rc2'. Split
 * the trailing digits into their own identifier first so they compare
 * numerically.
 */
function compareTags (a, b) {
  const normalize = (tag) => String(tag).replace(/^v/, '').replace(/-([a-z]+)(\d+)/gi, '-$1.$2')
  const left = semver.valid(normalize(a))
  const right = semver.valid(normalize(b))
  if (left && right) return semver.compare(left, right)
  // Not semver (a hand-named file, say): fall back to numeric release order.
  const parse = (tag) => String(tag).replace(/^v/, '').split('-')[0].split('.').map(Number)
  const [a1, a2, a3] = parse(a)
  const [b1, b2, b3] = parse(b)
  return (a1 - b1) || (a2 - b2) || (a3 - b3) || 0
}

/**
 * Whether a tag names a prerelease (an RC or beta build).
 */
function isPrerelease (tag) {
  const normalized = String(tag).replace(/^v/, '')
  const valid = semver.valid(normalized)
  return valid ? Boolean(semver.prerelease(valid)) : /-/.test(normalized)
}

/**
 * The release series ('26.2') of a component version ('26.2', '25.3.1') or a
 * properties tag ('v26.2.1', 'v26.3.1-rc1'). Undefined when the value names no
 * numeric series.
 */
function releaseSeries (value) {
  const match = String(value == null ? '' : value).replace(/^v/, '').match(/^(\d+)\.(\d+)/)
  return match ? `${match[1]}.${match[2]}` : undefined
}

/**
 * Whether an Antora attribute counts as declared.
 *
 * Antora keeps a component version's antora.yml attributes verbatim, and
 * setting one to false is how a maintainer turns it off: the key stays present.
 * A bare `!== undefined` test therefore reads `env-cloud: false` as "this is
 * Cloud", the opposite of what was written. Sibling readers of this attribute
 * in this repo use truthiness, so match them, while still honouring AsciiDoc's
 * set-but-empty convention.
 */
function isAttributeSet (value) {
  if (value === undefined || value === null || value === false) return false
  return String(value).toLowerCase() !== 'false'
}

/**
 * The asciidoc attributes declared for one component version, which is where
 * env-cloud lives. Read from the catalog rather than the converting document
 * so the property-page-index extension resolves surfaces identically.
 */
function componentAttributes (contentCatalog, component, version) {
  if (typeof contentCatalog.getComponent !== 'function') return {}
  const found = contentCatalog.getComponent(component)
  if (!found) return {}
  const versions = found.versions || []
  const match = versions.find((entry) => entry.version === version) || found.latest || versions[0]
  return (match && match.asciidoc && match.asciidoc.attributes) || {}
}

/**
 * Every properties JSON in the build, as {tag, file, component, version}.
 */
function propertyDatasets (contentCatalog) {
  const found = []
  for (const attachment of contentCatalog.findBy({ family: 'attachment' }) || []) {
    if (attachment.src.module !== 'reference') continue
    const match = attachment.src.relative.split('/').pop().match(PROPERTIES_JSON_RX)
    if (!match) continue
    found.push({ tag: match[1], file: attachment, component: attachment.src.component, version: attachment.src.version })
  }
  return found
}

/**
 * The newest dataset in a list, with ties broken on a stable identity rather
 * than on catalog iteration order: two attachments can carry the same tag, and
 * picking whichever the catalog happened to yield first made the chosen
 * property data differ between builds of identical content.
 */
const newestDataset = (list) =>
  list.reduce((best, entry) => {
    if (!best) return entry
    const byTag = compareTags(entry.tag, best.tag)
    if (byTag > 0) return entry
    if (byTag < 0) return best
    return stableKey(entry) < stableKey(best) ? entry : best
  }, null)

/**
 * Load and cache the property data for one page's component and version, plus
 * which slice of it that component may reference. Returns undefined when the
 * component has no property data, which is the signal to render plain and warn.
 *
 * Two doc sets have property data:
 *
 *   A component that publishes its own redpanda-properties-<tag>.json (the
 *   self-managed docs) uses the file for its own release series, newest patch
 *   within it, and may reference every property in it. Matching by series
 *   rather than by newest tag matters because the main branch carries the
 *   previous series' file alongside its own, and a prerelease could land there
 *   too. A versioned page whose series has no file goes unvalidated with an
 *   explicit warning rather than borrowing a neighbouring release's data.
 *
 *   A Cloud component (env-cloud) is managed streaming: no data of its own, so
 *   it tracks the newest streaming (or ROOT) file, and may reference only the
 *   properties marked cloud_supported.
 *
 * Anything else gets nothing. Component versions elsewhere in the site carry
 * their own product versions, which say nothing about Redpanda releases, so no
 * dataset is inferred for them.
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

  const datasets = propertyDatasets(contentCatalog)
  const own = datasets.filter((d) => d.component === pageComponent)
  let pick
  let surface

  // Cloud is decided first, and deliberately outranks the component's own
  // attachments. The property extractor writes
  // modules/reference/attachments/redpanda-properties-<tag>.json into whatever
  // repo it runs in, so running it inside cloud-docs would otherwise flip that
  // component to the unfiltered surface and switch off cloud_supported gating
  // site-wide, with no warning anywhere.
  if (isAttributeSet(componentAttributes(contentCatalog, pageComponent, pageVersion)['env-cloud'])) {
    surface = SURFACE_CLOUD
    // GA only: Cloud runs released Redpanda, so an RC published on the beta
    // branch must not become the dataset Cloud pages validate against.
    // Only streaming/ROOT count as lenders -- another component's product
    // version is not a Redpanda release candidate.
    const lenders = datasets.filter((d) => d.component === 'streaming' || d.component === 'ROOT')
    const released = lenders.filter((d) => !isPrerelease(d.tag))
    pick =
      newestDataset(released.filter((d) => d.component === 'streaming')) ||
      newestDataset(released.filter((d) => d.component === 'ROOT'))
    if (!pick && lenders.length) {
      // Self-managed data exists but all of it is a prerelease. Say that
      // specifically rather than claiming no property data was found.
      const gaps = contentCatalog[$propertySeriesGap] || (contentCatalog[$propertySeriesGap] = {})
      gaps[cacheKey] = {
        kind: 'cloud-prerelease-only',
        component: pageComponent,
        version: pageVersion,
        have: [...new Set(lenders.map((d) => d.tag))].sort(compareTags),
      }
      cache[cacheKey] = null
      return undefined
    }
  } else if (own.length) {
    surface = SURFACE_ALL
    const series = releaseSeries(pageVersion)
    if (series) {
      const inSeries = own.filter((d) => releaseSeries(d.tag) === series)
      pick = newestDataset(inSeries.filter((d) => d.version === pageVersion)) || newestDataset(inSeries)
      if (!pick) {
        // Record the gap rather than reporting it here: this also runs from the
        // property-page-index extension, once per component version in the
        // build, so warning now would report versions no page of which uses the
        // macro. The macro reports it on first actual use.
        const gaps = contentCatalog[$propertySeriesGap] || (contentCatalog[$propertySeriesGap] = {})
        gaps[cacheKey] = {
          kind: 'series',
          component: pageComponent,
          version: pageVersion,
          series,
          have: [...new Set(own.map((d) => d.tag))].sort(compareTags),
        }
        cache[cacheKey] = null
        return undefined
      }
    } else {
      pick = newestDataset(own.filter((d) => d.version === pageVersion)) || newestDataset(own)
    }
  }

  // A corrupt or half-written attachment must not take the whole build down,
  // and must not mask a good file: try candidates newest-first and use the
  // first one that actually carries properties, reporting each one skipped.
  let registry = null
  for (const candidate of orderedCandidates(pick, own, datasets, surface)) {
    const properties = readProperties(candidate, contentCatalog)
    if (!properties) continue
    registry = { tag: candidate.tag, properties, component: candidate.component, version: candidate.version, surface }
    break
  }
  // Cache null too, so a missing dataset is only searched for once per build.
  cache[cacheKey] = registry
  return registry || undefined
}

/**
 * The chosen dataset first, then the remaining candidates from the same pool in
 * descending release order, so an unusable file falls through to the next best
 * rather than voiding the component's data entirely.
 */
function orderedCandidates (pick, own, datasets, surface) {
  if (!pick) return []
  const pool = surface === SURFACE_CLOUD
    ? datasets.filter((d) => (d.component === 'streaming' || d.component === 'ROOT') && !isPrerelease(d.tag))
    : own
  const rest = pool
    .filter((d) => d !== pick)
    .sort((a, b) => compareTags(b.tag, a.tag) || stableKey(a).localeCompare(stableKey(b)))
  return [pick, ...rest]
}

/**
 * Parse one properties attachment, or report why it is unusable and return
 * undefined. A JSON syntax error used to escape as an unhandled exception that
 * named no file, so a single bad attachment failed the build with no way to tell
 * which of them was at fault.
 */
function readProperties (candidate, contentCatalog) {
  const where = `${candidate.component}@${candidate.version || 'unversioned'}`
  let data
  try {
    data = JSON.parse(candidate.file.contents.toString())
  } catch (error) {
    warnOnce(contentCatalog, `badjson:${where}:${candidate.tag}`,
      `prop macro: redpanda-properties-${candidate.tag}.json in ${where} is not valid JSON (${error.message}), so it is ignored. Regenerate it with 'npx doc-tools generate property-docs'.`)
    return undefined
  }
  const properties = data && data.properties
  // Must be a plain object of name -> entry. A string, number, or array parses
  // fine and would then make every prop: target look like a typo.
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    warnOnce(contentCatalog, `noprops:${where}:${candidate.tag}`,
      `prop macro: redpanda-properties-${candidate.tag}.json in ${where} has no usable 'properties' object, so it is ignored. Regenerate it with 'npx doc-tools generate property-docs'.`)
    return undefined
  }
  return properties
}

/**
 * A stable identity for an attachment, so two files carrying the same tag are
 * resolved the same way on every build instead of by catalog iteration order.
 */
function stableKey (candidate) {
  return `${candidate.component}\u0000${candidate.version}\u0000${candidate.file.src.relative}`
}

/**
 * Whether a property is available to the audience this dataset was loaded for.
 * On Cloud only cloud_supported properties are; a Cloud reader cannot set the
 * rest, even though Redpanda has them.
 */
function isAvailable (registry, entry) {
  if (registry.surface !== SURFACE_CLOUD) return true
  return entry.cloud_supported === true
}

/**
 * Report a recorded dataset gap. Either this component's release series has no
 * property file, or Cloud found only prerelease files. Both leave the page
 * unvalidated, and each has its own fix worth naming. Returns whether a gap was
 * found and reported.
 */
function warnSeriesMissing (contentCatalog, pageComponent, pageVersion) {
  const gaps = contentCatalog[$propertySeriesGap]
  const gap = gaps && gaps[`${pageComponent}@${pageVersion}`]
  if (!gap) return false
  const have = gap.have.join(', ')
  if (gap.kind === 'cloud-prerelease-only') {
    warnOnce(contentCatalog, `cloudpre:${gap.component}@${gap.version}`,
      `prop macro: ${gap.component} found only prerelease property data (${have}). Cloud runs released Redpanda, so it uses GA property data and will not validate against a release candidate. ` +
      'prop: targets on Cloud pages are therefore not validated and their tooltips carry no data. Include a GA self-managed branch in the build, or leave prop: out of Cloud content until the release ships.')
    return true
  }
  warnOnce(contentCatalog, `series:${gap.component}@${gap.version}`,
    `prop macro: ${gap.component}@${gap.version} publishes no redpanda-properties-v${gap.series}.*.json attachment in its reference module (found for other series: ${have}). ` +
    `prop: targets on ${gap.version} pages are therefore not validated and their tooltips carry no data, rather than being checked against another release's properties. ` +
    `Generate it with 'npx doc-tools generate property-docs --tag v${gap.series}.<patch>' on that branch, or leave prop: out of ${gap.version} content.`)
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
 * Report a property that exists in Redpanda but is not available to this
 * component's audience. On Cloud that means cloud_supported is false: a real
 * property a Cloud reader cannot set, so it renders as plain code rather than
 * as a tooltip implying otherwise.
 */
function reportUnavailableProperty ({ name, component, registry, mode, filePath }) {
  if (mode === 'off') return
  const where = filePath ? ` in ${filePath}` : ''
  const which = component || 'this'
  console.warn(chalk.yellow(
    `prop:${name}[]${where}: '${name}' is not available in the ${which} component, so it renders as plain code -- no link, and no tooltip. ` +
    `${describeDataset(registry)} marks it cloud_supported: false, meaning Redpanda has the property but this audience cannot set it. ` +
    'If that is wrong, fix cloud_supported in the property extractor; if it is right, reword the sentence and drop the macro.'
  ))
}

/**
 * Report an available property that no page in this component documents. The
 * tooltip still works, so this only matters when a link was explicitly asked
 * for -- there is nothing to link to.
 */
function reportUnpublishedProperty ({ name, registry, mode, filePath }) {
  if (mode === 'off') return
  const where = filePath ? ` in ${filePath}` : ''
  console.warn(chalk.yellow(
    `prop:${name}[link=true]${where}: '${name}' is in ${describeDataset(registry)} but no reference page in this component renders a heading for it, so it keeps its tooltip and renders without a link. ` +
    'Every property reference page filters out the deprecated and exclude-from-docs include tags, and some include only selected category tags -- check which tags enclose this property in the generated partial. ' +
    'If it is meant to stay unpublished, drop link=true.'
  ))
}

/**
 * Build the AsciiDoc content emitted for one macro instance. Exported for
 * unit testing.
 *
 * @param {object} opts
 * @param {string} opts.name - Property name.
 * @param {string} [opts.text] - Display text override.
 * @param {boolean} [opts.link] - Whether to link to the reference page. Ignored
 *   without a page: the macro never guesses a target.
 * @param {string} [opts.page] - Reference page (module-relative, no .adoc).
 * @param {string} [opts.scope] - config_scope, used only for the Helm path.
 * @param {string} opts.role - CSS class for the code element.
 * @param {boolean} [opts.plain] - Render unmarked code (no tooltip, no link)
 *   because the build could not verify the property for this component.
 * @returns {string}
 */
function buildPropContent ({ name, text, link, page, scope, role, helmPath = false, docUrl, plain = false }) {
  const display = text || (helmPath ? helmValuesPath(name, scope) : name)
  if (plain) return `<code>${display}</code>`
  const inner = link && page
    ? `xref:reference:${page}.adoc#${propertyAnchor(name)}[${display}]`
    : display
  // Escape every interpolated attribute value. role comes from a site
  // attribute, docUrl from a page's published URL, and name from a dataset
  // key: an unescaped quote in any of them ends the attribute early and the
  // remainder becomes stray attributes on every marked property in the build.
  const docAttr = docUrl ? ` data-doc-url="${escapeAttribute(docUrl)}"` : ''
  return `<code class="${escapeAttribute(role)}" data-property-name="${escapeAttribute(name)}"${docAttr}>${inner}</code>`
}

/**
 * Escape a value for use inside a double-quoted HTML attribute.
 */
function escapeAttribute (value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function propInlineMacro (config) {
  return function () {
    const self = this
    self.named('prop')
    self.process(function (parent, target, attributes) {
      const document = parent.getDocument()
      const name = target.trim()
      const mode = document.getAttribute('property-validate', 'warn')
      const filePath = config && config.file && config.file.src && config.file.src.path
      const component = (config && config.file && config.file.src && config.file.src.component) || ''
      const version = (config && config.file && config.file.src && config.file.src.version) || ''
      const linkRequested = attributes.link === 'true' || attributes.link === true

      // Anything that leaves the property unverified renders as plain inline
      // code: no marker, so the docs UI adds no tooltip. A tooltip the build
      // could not check is worse than none, and a marker with nothing behind it
      // would leave the UI guessing at a documentation link.
      // No Helm path here, deliberately: helmValuesPath needs the property's
      // config_scope to choose between config.node.* and config.cluster.*, and
      // on this path there is no verified entry to take it from. Emitting one
      // anyway printed a confident, copy-pasteable values.yaml path -- and the
      // wrong one for every broker property -- for a property the build could
      // not verify. Show the name instead.
      //
      // No macro substitution either: the content is a hand-built tag pair, so
      // a text= value containing xref:/image:/pass:[] would otherwise be
      // expanded inside it and could close or nest past the </code>.
      const plain = () => self.createInline(parent, 'quoted', buildPropContent({
        name,
        text: attributes.text,
        role: document.getAttribute('property-ref-role', DEFAULT_ROLE),
        plain: true,
      }))

      const registry = config && config.contentCatalog ? loadProperties(config) : undefined
      if (!registry) {
        // No dataset covers this component. Say so once and render plain.
        if (mode !== 'off' && config && config.contentCatalog) {
          if (!warnSeriesMissing(config.contentCatalog, component, version)) {
            warnNoPropertyData(config.contentCatalog, component, version)
          }
        }
        return plain()
      }

      // Own properties only: a bare index lookup makes toString, constructor
      // and valueOf validate as real properties and render marked.
      const entry = Object.prototype.hasOwnProperty.call(registry.properties, name)
        ? registry.properties[name]
        : undefined
      if (!entry) {
        reportUnknownProperty({ name, mode, registry, filePath })
        return plain()
      }
      if (!isAvailable(registry, entry)) {
        reportUnavailableProperty({ name, component, registry, mode, filePath })
        return plain()
      }

      // Discover the page in THIS component that documents the property. A page
      // is never borrowed from another component, and never guessed from the
      // property's scope, because a link the build cannot verify is a broken
      // link. page= overrides discovery for the rare case a writer knows better.
      let discoveredPage = attributes.page
      let discoveredUrl
      if (!discoveredPage) {
        const index = buildPageIndex(config.contentCatalog, component, registry.properties, version)
        const found = index.get(name)
        if (found) {
          discoveredPage = found.page
          discoveredUrl = found.url
        } else if (linkRequested) {
          reportUnpublishedProperty({ name, registry, mode, filePath })
        }
      }

      const content = buildPropContent({
        name,
        text: attributes.text,
        link: linkRequested && Boolean(discoveredPage),
        page: discoveredPage,
        scope: entry.config_scope,
        role: document.getAttribute('property-ref-role', DEFAULT_ROLE),
        helmPath: helmPathRequested(attributes, document),
        docUrl: discoveredUrl ? `${discoveredUrl}#${propertyAnchor(name)}` : undefined,
      })
      // Only request macro substitution when an xref actually needs resolving.
      // Applying it unconditionally let a text= value containing another macro
      // expand inside the hand-built <code> element, producing mis-nested or
      // unclosed markup.
      const options = linkRequested && discoveredPage ? { attributes: { subs: 'macros' } } : {}
      return self.createInline(parent, 'quoted', content, options)
    })
  }
}

/**
 * helm-path=auto displays the property as its Helm values path on pages
 * rendered with env-kubernetes, so single-sourced content reads correctly for
 * both Linux and Kubernetes audiences (the successor to the config_ref macro's
 * hardcoded storage.tiered.config prefixing).
 */
function helmPathRequested (attributes, document) {
  return attributes['helm-path'] === 'auto' && document.getAttribute('env-kubernetes') !== undefined
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
module.exports.isPrerelease = isPrerelease
module.exports.releaseSeries = releaseSeries
module.exports.extractHeadingsWithTags = extractHeadingsWithTags
module.exports.evaluateTagExpression = evaluateTagExpression
module.exports.buildPageIndex = buildPageIndex
