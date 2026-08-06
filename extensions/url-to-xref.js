'use strict'

const { scanContentUrls } = require('./util/scan-content-urls')

/**
 * URL to Xref Extension
 *
 * Converts absolute docs-site URLs (for example https://docs.redpanda.com/...)
 * found in page and partial content into Antora xrefs, using the content
 * catalog as the single source of truth. A URL is only converted when it maps
 * to a page that is actually published in this build — the extension never
 * guesses at URL structure. Converted links get Antora's build-time xref
 * validation; internal URLs that match no published page are reported as
 * warnings, which makes this extension a broken-internal-link detector.
 *
 * Registration (docs-site playbook):
 *
 * antora:
 *   extensions:
 *     - require: '@redpanda-data/docs-extensions-and-macros/extensions/url-to-xref'
 *       # hostnames: ['docs.redpanda.com']   (default)
 *       # log_unconverted: true              (default)
 *
 * Behavior details:
 * - Runs at contentClassified, before AsciiDoc conversion, so emitted xrefs
 *   flow through Antora's normal resolution and broken-xref logging.
 * - URLs inside listing/literal/fenced/passthrough blocks, inline code spans,
 *   and attribute entry lines are left untouched.
 * - Legacy URL shapes (/docs/..., /current/..., /vX.Y/..., pre-rename
 *   component slugs) are rewritten to candidate paths, but a candidate is
 *   only used when it matches a published page.
 * - Fragments (#anchor) and link labels are preserved. Unlabeled URLs become
 *   xref:...[] so Antora fills in the target page title.
 * - Targets in the latest version of a component emit an unversioned xref;
 *   targets pinned to an older version emit version@component:module:page.
 */

// Rewrites for URL shapes that predate the current docs.redpanda.com site
// structure. Every produced candidate is verified against the catalog before
// use, so an entry that no longer applies is harmless. Slugs mirror the live
// site's 301 redirects.
const LEGACY_SLUG_REWRITES = {
  'redpanda-connect': 'connect',
  'redpanda-cloud': 'cloud-data-platform',
  'redpanda-labs': 'labs',
}

// The component that serves the pre-umbrella site's unprefixed URLs
// (/docs/..., /current/..., /vX.Y/...). The live site 301s those to
// /streaming/....
const LEGACY_UNPREFIXED_COMPONENT = 'streaming'

module.exports.register = function ({ config = {} }) {
  const logger = this.getLogger('url-to-xref-extension')
  const hostnames = new Set(config.hostnames || ['docs.redpanda.com'])
  const logUnconverted = config.logUnconverted !== false

  this.on('contentClassified', ({ playbook, contentCatalog }) => {
    const resolverContext = Object.assign(buildUrlMap(contentCatalog), {
      hostnames,
      latestVersionSegment: (playbook.urls || {}).latestVersionSegment || 'current',
    })
    let convertedCount = 0
    const unmapped = new Map()
    const files = contentCatalog
      .getPages((page) => page.out)
      .concat(contentCatalog.findBy({ family: 'partial' }))
    for (const file of files) {
      if (!file.contents) continue
      const result = convertContent(file.contents.toString(), resolverContext)
      if (result.converted) {
        file.contents = Buffer.from(result.content)
        convertedCount += result.converted
      }
      for (const url of result.unmapped) {
        if (!unmapped.has(url)) unmapped.set(url, new Set())
        unmapped.get(url).add(file.path)
      }
    }
    if (logUnconverted) {
      for (const [url, pages] of unmapped) {
        logger.warn(`No published page matches ${url} (found in: ${[...pages].join(', ')})`)
      }
    }
    if (convertedCount || unmapped.size) {
      logger.info(
        `Converted ${convertedCount} docs URL${convertedCount === 1 ? '' : 's'} to xrefs; ` +
          `${unmapped.size} URL${unmapped.size === 1 ? '' : 's'} matched no published page`
      )
    }
  })
}

/**
 * Builds a lookup of published URL path -> resource coordinates from the
 * content catalog. Covers regular pages plus the synthetic alias files Antora
 * registers during classification for component start pages and the site
 * start page, so component landing URLs (/connect/) and the site root (/)
 * resolve too.
 */
function buildUrlMap (contentCatalog) {
  const components = {}
  for (const component of contentCatalog.getComponents()) {
    components[component.name] = { latestVersion: component.latest ? component.latest.version : '' }
  }
  const isLatest = (name, version) => name in components && components[name].latestVersion === version
  const toEntry = ({ component, version, module: module_, relative }) => ({
    component,
    version,
    module: module_,
    relative,
    latest: isLatest(component, version),
  })
  const urls = new Map()
  for (const page of contentCatalog.getPages((p) => p.out && p.pub && p.pub.url)) {
    urls.set(normalizeUrlPath(page.pub.url), toEntry(page.src))
  }
  for (const alias of contentCatalog.findBy({ family: 'alias' })) {
    if (!alias.pub || !alias.pub.url || alias.pub.splat) continue
    let target = alias.rel
    let depth = 0
    while (target && target.src && target.src.family === 'alias' && depth++ < 5) target = target.rel
    if (!target || !target.src || target.src.family !== 'page' || !target.pub) continue
    const key = normalizeUrlPath(alias.pub.url)
    if (!urls.has(key)) urls.set(key, toEntry(target.src))
  }
  return { urls, components }
}

/** Normalizes a URL path for map lookup: drops the query string, an
 * index.html or .html suffix, and any trailing slash (except the bare root).
 */
function normalizeUrlPath (urlPath) {
  let result = urlPath.split('?')[0]
  if (result.endsWith('/index.html')) result = result.slice(0, -'index.html'.length)
  else if (result.endsWith('.html')) result = result.slice(0, -'.html'.length)
  if (result.length > 1 && result.endsWith('/')) result = result.slice(0, -1)
  return result || '/'
}

/**
 * Produces lookup candidates for a normalized path: the path itself, legacy
 * rewrites, and an explicit-latest-version -> symbolic-segment swap. Callers
 * must verify each candidate against the URL map.
 */
function candidatePaths (normalizedPath, { components, latestVersionSegment }) {
  const candidates = [normalizedPath]
  let unprefixed = normalizedPath
  const docsPrefix = unprefixed.match(/^\/docs(\/.*)?$/)
  if (docsPrefix) unprefixed = docsPrefix[1] || '/'
  const versionPrefix = unprefixed.match(/^\/(?:current|v?(\d+\.\d+(?:\.\d+)?))(\/.*)?$/)
  if (versionPrefix) {
    const [, version, rest = ''] = versionPrefix
    candidates.push(`/${LEGACY_UNPREFIXED_COMPONENT}/${version || latestVersionSegment}${rest}`)
    if (version) candidates.push(`/${LEGACY_UNPREFIXED_COMPONENT}/${latestVersionSegment}${rest}`)
  } else if (docsPrefix) {
    candidates.push(
      `/${LEGACY_UNPREFIXED_COMPONENT}/${latestVersionSegment}${unprefixed === '/' ? '' : unprefixed}`
    )
  }
  for (const [slug, componentName] of Object.entries(LEGACY_SLUG_REWRITES)) {
    if (normalizedPath === `/${slug}` || normalizedPath.startsWith(`/${slug}/`)) {
      candidates.push(`/${componentName}${normalizedPath.slice(slug.length + 1)}`)
    }
  }
  // An explicitly versioned URL whose version is the component's latest is
  // published under the symbolic segment instead (redirect:to strategy).
  const segments = normalizedPath.split('/')
  const component = components[segments[1]]
  if (component && segments[2]) {
    const version = segments[2].replace(/^v/, '')
    if (version === component.latestVersion) {
      candidates.push(['', segments[1], latestVersionSegment, ...segments.slice(3)].join('/'))
    }
  }
  return candidates
}

function resolveUrlPath (urlPath, resolverContext) {
  for (const candidate of candidatePaths(normalizeUrlPath(urlPath), resolverContext)) {
    const entry = resolverContext.urls.get(candidate)
    if (entry) return entry
  }
  return undefined
}

function entryToXref (entry, fragment, label) {
  const versionPrefix = entry.latest || !entry.version ? '' : `${entry.version}@`
  return `xref:${versionPrefix}${entry.component}:${entry.module}:${entry.relative}${fragment || ''}[${label || ''}]`
}

/**
 * Rewrites every mappable docs URL in content. Returns the updated content,
 * the number of conversions, and the internal URLs that matched no published
 * page.
 */
function convertContent (content, resolverContext) {
  const { hostnames } = resolverContext
  let result = ''
  let cursor = 0
  let converted = 0
  const unmapped = []
  for (const match of scanContentUrls(content)) {
    let url
    try {
      url = new URL(match.url)
    } catch {
      continue
    }
    if (!hostnames.has(url.hostname) || match.inAttributeEntry) continue
    const entry = resolveUrlPath(url.pathname, resolverContext)
    if (!entry) {
      unmapped.push(match.url)
      continue
    }
    result += content.slice(cursor, match.start) + entryToXref(entry, url.hash, match.label)
    cursor = match.end
    converted++
  }
  result += content.slice(cursor)
  return { content: result, converted, unmapped }
}

module.exports.buildUrlMap = buildUrlMap
module.exports.convertContent = convertContent
module.exports.normalizeUrlPath = normalizeUrlPath
