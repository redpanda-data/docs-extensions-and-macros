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
 * A registry entry's `since` field, when set, is checked against the page
 * being converted, not the newest release: a mention or table row for a
 * feature whose `since` postdates the page's own version renders unstyled,
 * the same way an unreleased feature renders on released docs, because as
 * of that page's version the feature had not shipped yet.
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
const semver = require('semver')
const { buildBadgeHtml, DEFAULT_TOOLTIPS } = require('./badge')
const logger = require('@antora/logger')('enterprise-macro')

const $enterpriseRegistry = Symbol('$enterpriseRegistry')
const $enterpriseRegistryUnreadable = Symbol('$enterpriseRegistryUnreadable')
const $warned = Symbol('$warned')

/**
 * Report a message once per build. Keyed off the content catalog, which Antora
 * rebuilds per build, so watch mode keeps reporting instead of going quiet.
 */
function warnOnce (contentCatalog, key, message) {
  const seen = contentCatalog[$warned] || (contentCatalog[$warned] = new Set())
  if (seen.has(key)) return false
  seen.add(key)
  logger.warn(message)
  return true
}

const DEFAULT_LICENSING_PAGE = 'get-started:licensing/overview.adoc'
const DEFAULT_ROLE = 'enterprise-feature'
const BETA_LABEL = 'beta'
const UNRELEASED_LABEL = 'unreleased'
// The badge macro supplies the default hover text for these labels, so the same
// wording appears whether a badge comes from the registry or from a
// badge::[label=beta] call in a page.
const UNRELEASED_TOOLTIP = DEFAULT_TOOLTIPS.unreleased

// Release status of a feature, which decides where it may be referenced.
//
//   ga          Shipped. Referenced anywhere. The default.
//   beta        Publicly available as a beta. Referenced anywhere, badged, so
//               readers know the feature is not yet stable.
//   unreleased  In a release candidate only, not yet public. Referenced ONLY
//               from prerelease docs (a beta branch). A mention on a released
//               page describes something readers cannot get, so it is reported
//               and rendered as plain text.
const STATUS_GA = 'ga'
const STATUS_BETA = 'beta'
const STATUS_UNRELEASED = 'unreleased'
const VALID_STATUSES = [STATUS_GA, STATUS_BETA, STATUS_UNRELEASED]

/**
 * The release status of a registry entry.
 *
 * `beta: true` predates the status field and still means beta, so old entries
 * keep working. An explicit status wins. An unrecognized status is reported AND
 * treated as unreleased: a typo must not be the thing that publishes an
 * unreleased feature. The two failure directions are not symmetric -- gating a
 * shipped feature shows a writer a warning and an unstyled mention they will
 * notice, while publishing an unreleased one promises readers a feature they
 * cannot get, and nothing on the page looks wrong.
 *
 * @param {object} entry - Registry entry.
 * @param {object} [report] - {mode, filePath} to report an invalid status.
 * @returns {string} One of VALID_STATUSES.
 */
function entryStatus (entry, report) {
  if (!entry) return STATUS_GA
  // Any present key goes through validation, including a blank value. An absent
  // key means no status was intended, so GA is the right default; `status:` with
  // nothing after it means the writer meant to say something and did not, which
  // is the same mistake as a typo and must fail the same way. Treating blank as
  // absent reopened the hole this function exists to close: a forgotten value
  // published an unreleased feature with no warning at all.
  if (entry.status !== undefined) {
    const raw = entry.status === null ? '' : String(entry.status).trim()
    const status = raw.toLowerCase()
    if (VALID_STATUSES.includes(status)) return status
    if (report && report.mode !== 'off') {
      const where = report.filePath ? ` in ${report.filePath}` : ''
      const what = raw === '' ? 'an empty status' : `status '${entry.status}'`
      const message =
        `enterprise:${entry.name}[]${where}: registry has ${what}, which is not one of ${VALID_STATUSES.join(', ')}, so the feature is treated as unreleased and is left unpublished on released pages. ` +
        'Fix the status in enterprise-features.yml, or remove the key entirely if the feature has shipped.'
      // Honour error mode like every other registry diagnostic. A typo here is
      // exactly what publishes an unreleased feature, so the strictest setting
      // has to stop it.
      if (report.mode === 'error') throw new Error(message)
      // One registry typo needs one fix, so report it once per build rather
      // than once per mention of the feature.
      if (report.contentCatalog) warnOnce(report.contentCatalog, `status:${entry.name}`, message)
      else logger.warn(message)
    }
    return STATUS_UNRELEASED
  }
  return entry.beta === true ? STATUS_BETA : STATUS_GA
}

/**
 * Whether the page being converted belongs to a prerelease component version,
 * which is where an unreleased feature may be referenced.
 *
 * Read from the component version's own prerelease flag (antora.yml) rather
 * than inferred, with a document attribute as an escape hatch for playbooks
 * that surface it themselves.
 */
function isPrereleasePage (config, document) {
  const attribute = document && document.getAttribute('page-component-version-is-prerelease')
  if (attribute !== undefined) {
    const value = String(attribute).trim().toLowerCase()
    if (value === 'true' || value === '') return true
    if (value === 'false') return false
    // Anything else is a typo. Falling through to the catalog is safer than
    // guessing, and silently treating it as "released" produced a warning that
    // told the writer their prerelease page belonged to a released version.
    logger.warn(
      `enterprise macro: page-component-version-is-prerelease is '${attribute}', which is neither true nor false, so it is ignored and the component version's own prerelease flag is used instead.`
    )
  }
  const contentCatalog = config && config.contentCatalog
  const src = config && config.file && config.file.src
  if (!contentCatalog || !src || typeof contentCatalog.getComponent !== 'function') return false
  const component = contentCatalog.getComponent(src.component)
  if (!component) return false
  const versions = Array.isArray(component.versions) ? component.versions : []
  const componentVersion = versions.find((entry) => entry.version === src.version)
  return Boolean(componentVersion && componentVersion.prerelease)
}

/**
 * Render the release-status badge for a registry entry.
 *
 * The badge HTML is built directly rather than emitted as `badge:[...]`
 * AsciiDoc, so it renders whether or not the consuming playbook registers the
 * badge macro. Writing the macro call into a registry field used to be the only
 * way to flag a beta feature, and it silently produced the literal text
 * `badge::[label=beta]` in any build without that macro registered.
 *
 * @param {object} entry - Registry entry.
 * @returns {string} Badge HTML, or an empty string for a shipped feature.
 */
function buildBetaBadge (entry) {
  const status = entryStatus(entry)
  if (status === STATUS_BETA) {
    return buildBadgeHtml({ label: BETA_LABEL, tooltip: entry['beta-tooltip'] || undefined })
  }
  if (status === STATUS_UNRELEASED) {
    return buildBadgeHtml({ label: UNRELEASED_LABEL, tooltip: entry['status-tooltip'] || UNRELEASED_TOOLTIP })
  }
  return ''
}

/**
 * Report an unreleased feature referenced from released documentation.
 */
function reportUnreleasedFeature ({ feature, mode, filePath }) {
  if (mode === 'off') return
  const where = filePath ? ` in ${filePath}` : ''
  const message =
    `enterprise:${feature}[]${where}: '${feature}' is marked status: unreleased in the enterprise features registry, so it is only documented for an upcoming release. ` +
    'This page belongs to a released version, so the mention renders as plain text with no enterprise styling, tooltip, or link. ' +
    'Move the mention to the prerelease (beta) branch, or change the status once the feature ships.'
  if (mode === 'error') throw new Error(message)
  logger.warn(message)
}

/**
 * Parse a version string into a semver for comparison, or undefined when it
 * cannot be parsed. Lenient the same way `semver.coerce` is: Redpanda docs
 * versions are "MAJOR.MINOR", not full semver, so an exact-match parse would
 * reject every one of them.
 */
function coerceVersion (raw) {
  if (raw === undefined || raw === null) return undefined
  return semver.coerce(String(raw)) || undefined
}

/**
 * Whether a registry entry's `since` version has shipped as of the page
 * being converted.
 *
 * enterprise-features.yml lives in the non-versioned 'shared' component, so
 * every version branch reads the exact same entry -- unlike property data,
 * which has one JSON file per release and is checked against the page's
 * own version (see PROPERTY_AND_ENTERPRISE_REFERENCES.adoc). Without this
 * check, a feature that ships in 26.3 renders as fully available -- linked,
 * badge-free, no warning -- on a 24.1 page that predates it by two years.
 *
 * Returns true (shipped) when `since` is absent, unparsable, or the page's
 * own version cannot be determined. That default favors data quality over
 * release-readiness: unlike an unrecognized `status`, which fails closed
 * because it is the one mistake that could publish an unreleased feature,
 * a `since` typo or a build with no page-version context has no such
 * asymmetry to protect against, so it defaults to not gating rather than
 * hiding a shipped feature over unrelated bad data. An unparsable `since`
 * is still reported, the same way an unrecognized `status` is: the failure
 * mode differs (not gated, instead of gated), but a silent typo is exactly
 * as easy to miss either way.
 *
 * @param {object} entry - Registry entry.
 * @param {object} [config] - Extension config, used to read the page's own
 *   version.
 * @param {object} [report] - {mode, filePath, contentCatalog} to report an
 *   unparsable since value. Omit to check silently.
 */
function isFeatureShippedOnPage (entry, config, report) {
  const since = entry && entry.since
  if (since === undefined || since === null || String(since).trim() === '') return true
  const sinceVersion = coerceVersion(since)
  if (!sinceVersion) {
    if (report && report.mode !== 'off') {
      const where = report.filePath ? ` in ${report.filePath}` : ''
      const message =
        `enterprise:${entry.name}[]${where}: registry has since: '${since}', which is not a parsable version, so the since-gating check is skipped and the feature renders as already shipped. ` +
        'Fix the since value in enterprise-features.yml (e.g. "26.3"), or remove the key if the feature has always been available.'
      if (report.contentCatalog) warnOnce(report.contentCatalog, `since:${entry.name}`, message)
      else logger.warn(message)
    }
    return true
  }
  const src = config && config.file && config.file.src
  const pageVersion = src && coerceVersion(src.version)
  if (!pageVersion) return true
  return semver.gte(pageVersion, sinceVersion)
}

/**
 * Report an inline mention of a feature before its `since` version, on a
 * page whose own version predates it.
 */
function reportFeatureNotYetShipped ({ feature, since, pageVersion, mode, filePath }) {
  if (mode === 'off') return
  const where = filePath ? ` in ${filePath}` : ''
  const message =
    `enterprise:${feature}[]${where}: '${feature}' is marked since: ${since} in the enterprise features registry, but this page is version ${pageVersion}, which predates it. ` +
    'The mention renders as plain text with no enterprise styling, tooltip, or link. ' +
    'Move the mention to a page whose version is at or after the since version, or remove since if the feature covers this version too.'
  if (mode === 'error') throw new Error(message)
  logger.warn(message)
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
  let data
  try {
    data = yaml.load(source)
  } catch (error) {
    // Every other throw below names the file, so this one does too: the caller
    // then reports whatever it catches verbatim, and the path appears once.
    throw new Error(`Enterprise features registry ${origin} is not valid YAML (${error.message}).`)
  }
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
    try {
      registry = parseRegistry(registryFile.contents.toString(), registryFile.path)
    } catch (error) {
      // A malformed registry must not take the whole build down. Unvalidated
      // enterprise mentions are the same graceful degradation as no registry at
      // all, and this matches how prop.js treats a corrupt properties JSON.
      // Caching the failure also stops the error being re-raised per macro call
      // and attributed to whichever page happened to convert first.
      registry = null
      // Remember that the file was found and unreadable, so the caller does not
      // then also report it missing. Saying "not found" about a file we just
      // read and failed to parse sends the writer looking for the wrong problem.
      contentCatalog[$enterpriseRegistryUnreadable] = true
      // Report the error as thrown. It already names the file and says exactly
      // what is wrong -- invalid YAML, a missing features list, an entry with no
      // name, an unknown scope, or a duplicate name or alias. Wrapping it in
      // "could not be read" was inaccurate for all but the first (the file read
      // fine; its contents are invalid) and printed the path twice.
      warnOnce(contentCatalog, 'badregistry',
        `${error.message} No enterprise: target is validated, no feature is gated by release status, and the licensing tables are empty until this is fixed.`)
    }
  }
  // Cache null too, so a missing registry is only searched for once per build.
  contentCatalog[$enterpriseRegistry] = registry
  return registry || undefined
}

function warnNoRegistry (contentCatalog) {
  // Already reported as unreadable: one problem, one diagnostic.
  if (contentCatalog && contentCatalog[$enterpriseRegistryUnreadable]) return
  const message = "Enterprise features registry (enterprise-features.yml in the 'shared' component) not found; enterprise: targets are not validated."
  // Deduplicate per build, not per process: Antora's watch mode reuses one
  // process across builds, and a module-level guard reported this only on a
  // session's first build -- exactly when a writer is iterating.
  if (contentCatalog) return warnOnce(contentCatalog, 'noregistry', message)
  if (warnedNoRegistry) return
  warnedNoRegistry = true
  logger.warn(message)
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
  logger.warn(message)
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
  logger.warn(`enterprise-tooltip attribute '${raw}' must be 'title', 'true', 'false', or start with 'data-'. Falling back to 'title'.`)
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
  // All four, matching badge.js. Escaping only the quote kept the attribute
  // intact but let < and > through from a registry tooltip field, which any
  // consumer that re-parses the page then reads as markup -- the docs UI
  // promotes this attribute into a tooltip, the Markdown converter and the
  // search indexer both re-read it.
  const escapedTooltip = tooltipText
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
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
 * @param {object} [opts.config] - Extension config, used to read the page's
 *   own version for since-gating (see isFeatureShippedOnPage).
 * @returns {string}
 */
function buildFeatureTable (features, scope, opts = {}) {
  // On released docs an unreleased feature is omitted entirely: the licensing
  // table is a list of what a licence covers today, and listing something
  // unavailable makes it wrong. Prerelease docs list it with its badge.
  const includeUnreleased = opts.includeUnreleased === true
  // Report a bad status from here too. Without a reporter a typo'd status was
  // silently downgraded to released, so an unreleased feature that no page
  // happens to reference inline was published in the table with no diagnostic.
  const report = opts.report
  const rows = features
    .filter((feature) => feature.scope === scope)
    // Evaluate the status first: `includeUnreleased || entryStatus(...)` skipped
    // the call entirely on a prerelease page, so a typo'd status went unreported
    // on the beta branch -- the one branch where unreleased features are
    // actually authored and the table renders them -- and enterprise-validate=error
    // did not fail there either.
    .filter((feature) => {
      const status = entryStatus(feature, report)
      if (!includeUnreleased && status === STATUS_UNRELEASED) return false
      // since only describes a shipped feature's first version, so it does
      // not apply to one that has not released at all yet. Silent, like the
      // unreleased filter above: an older version's table naturally does not
      // list a feature that did not exist yet on that version, which is not
      // a writer mistake worth warning about.
      return status === STATUS_UNRELEASED || isFeatureShippedOnPage(feature, opts.config, report)
    })
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
        if (!registry) warnNoRegistry(config && config.contentCatalog)
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
      const mode = document.getAttribute('enterprise-validate', 'warn')
      const filePath = config && config.file && config.file.src && config.file.src.path
      const status = entryStatus(entry, { mode, filePath, contentCatalog: config && config.contentCatalog })
      if (status === STATUS_UNRELEASED && !isPrereleasePage(config, document)) {
        // Documented for an upcoming release, referenced from released docs.
        // Styling it as an available enterprise feature would promise readers
        // something they cannot get, so render the name and say so.
        reportUnreleasedFeature({ feature, mode, filePath })
        return self.createInline(parent, 'quoted', attributes.text || feature)
      }
      if (!isFeatureShippedOnPage(entry, config, { mode, filePath, contentCatalog: config && config.contentCatalog })) {
        // isFeatureShippedOnPage only returns false when entry.since parsed,
        // so entry is defined here.
        reportFeatureNotYetShipped({
          feature,
          since: entry.since,
          pageVersion: config && config.file && config.file.src && config.file.src.version,
          mode,
          filePath,
        })
        return self.createInline(parent, 'quoted', attributes.text || feature)
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
      // A feature's status holds wherever it is referenced, so prose gets the
      // same badge as the generated tables. enterprise-beta-badge=false
      // suppresses the beta badge in prose; the unreleased badge is not
      // suppressible, because "not in a release yet" is not decoration.
      if (status === STATUS_UNRELEASED || document.getAttribute('enterprise-beta-badge', 'true') === 'true') {
        const badge = buildBetaBadge(entry)
        if (badge) content += ` ${badge}`
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
        warnNoRegistry(config && config.contentCatalog)
        return self.parseContent(parent, `WARNING: The enterprise features registry is unavailable, so the ${scope} feature table cannot be rendered.`)
      }
      const table = buildFeatureTable(registry.features, scope, {
        title: attributes.title,
        heading: attributes.heading,
        report: {
          mode: parent.getDocument().getAttribute('enterprise-validate', 'warn'),
          filePath: config && config.file && config.file.src && config.file.src.path,
          contentCatalog: config && config.contentCatalog,
        },
        // Prerelease docs describe the upcoming release, so they list features
        // that are still only in a release candidate.
        includeUnreleased: isPrereleasePage(config, parent.getDocument()),
        config,
      })
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
    logger.warn("no 'inlineMacro' method on alleged registry")
  }
  return registry
}

module.exports.register = register
module.exports.buildEnterpriseContent = buildEnterpriseContent
module.exports.buildFeatureTable = buildFeatureTable
module.exports.parseRegistry = parseRegistry
module.exports.resolveEntryXref = resolveEntryXref
module.exports.resolveTooltipAttribute = resolveTooltipAttribute
module.exports.isFeatureShippedOnPage = isFeatureShippedOnPage
