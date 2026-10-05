'use strict'

const { scanContentUrls } = require('./util/scan-content-urls')
const { raiseListenerLimit } = require('./util/raise-listener-limit')

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
 *   attribute entry lines, and macro attribute values (link=...) are left
 *   untouched.
 * - Legacy URL shapes (/docs/..., /current/..., /vX.Y/..., pre-rename
 *   component slugs) are rewritten to candidate paths, but a candidate is
 *   only used when it matches a published page.
 * - Fragments (#anchor) and link labels are preserved, including labels that a
 *   generator wrapped across a line break. An unlabeled URL becomes xref:...[]
 *   so Antora fills in the target page title, except when it carries a
 *   fragment, where link text has to be supplied (see linkTextFor).
 * - Targets in the latest version of a component emit an unversioned xref;
 *   targets pinned to an older version emit version@component:module:page.
 * - URLs pointing at a page's former path resolve through the page-aliases the
 *   page declares (see buildUrlMap).
 * - URLs carrying a query string are left raw, because an xref cannot express
 *   one; they are reported at info level rather than as warnings.
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
  raiseListenerLimit(this)
  const logger = this.getLogger('url-to-xref-extension')
  const hostnames = new Set(config.hostnames || ['docs.redpanda.com'])
  const logUnconverted = config.logUnconverted !== false
  // URL paths that live on the docs domain but outside the Antora catalog: the
  // API reference is hosted by Bump.sh, and /mcp is the docs MCP server
  // endpoint. Left untouched, no warning.
  const ignore = (config.ignore || ['^/api/', '^/mcp(/|$)']).map((pattern) => new RegExp(pattern))

  this.on('contentClassified', ({ playbook, contentCatalog }) => {
    const resolverContext = Object.assign(buildUrlMap(contentCatalog), {
      hostnames,
      ignore,
      latestVersionSegment: (playbook.urls || {}).latestVersionSegment || 'current',
      // Used to read heading ids out of the partials a target page includes.
      resolveInclude: (spec, page) => contentCatalog.resolveResource(spec, page.src, 'partial', ['partial', 'page']),
    })
    let convertedCount = 0
    const unmapped = new Map()
    const withQueryString = new Set()
    const withoutLinkText = new Set()
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
      for (const url of result.withQueryString) withQueryString.add(url)
      for (const url of result.withoutLinkText) withoutLinkText.add(url)
    }
    if (logUnconverted) {
      for (const [url, pages] of unmapped) {
        logger.warn(`No published page matches ${url} (found in: ${[...pages].join(', ')})`)
      }
    }
    if (withQueryString.size) {
      logger.info(
        `Left ${withQueryString.size} docs URL${withQueryString.size === 1 ? '' : 's'} with a query string as raw ` +
          `link${withQueryString.size === 1 ? '' : 's'} (an xref cannot carry one): ${[...withQueryString].join(', ')}`
      )
    }
    if (withoutLinkText.size) {
      logger.info(
        `Left ${withoutLinkText.size} docs URL${withoutLinkText.size === 1 ? '' : 's'} with a fragment as raw ` +
          `link${withoutLinkText.size === 1 ? '' : 's'} (no link text could be resolved from the target page): ` +
          `${[...withoutLinkText].join(', ')}`
      )
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
 * content catalog. Covers regular pages, the synthetic alias files Antora
 * registers during classification for component start pages and the site start
 * page (so component landing URLs like /connect/ and the site root resolve),
 * and the page-aliases each page declares in its header.
 *
 * page-aliases have to be read from the page header here because Antora does
 * not register them as catalog alias files until it converts documents, which
 * is after this extension runs. Without them, a URL that points at a page's
 * former path (the majority of the raw URLs in generated Helm and CRD specs)
 * would be reported as broken even though the site redirects it.
 */
function buildUrlMap (contentCatalog) {
  const components = {}
  for (const component of contentCatalog.getComponents()) {
    components[component.name] = { latestVersion: component.latest ? component.latest.version : '' }
  }
  const isLatest = (name, version) => name in components && components[name].latestVersion === version
  // The target file travels with the entry so that link text can be resolved
  // from it later, which an xref with a fragment needs (see linkTextFor).
  const toEntry = ({ component, version, module: module_, relative }, page) => ({
    component,
    version,
    module: module_,
    relative,
    latest: isLatest(component, version),
    page,
  })
  const urls = new Map()
  const pages = contentCatalog.getPages((p) => p.out && p.pub && p.pub.url)
  for (const page of pages) {
    urls.set(normalizeUrlPath(page.pub.url), toEntry(page.src, page))
  }
  for (const alias of contentCatalog.findBy({ family: 'alias' })) {
    if (!alias.pub || !alias.pub.url || alias.pub.splat) continue
    let target = alias.rel
    let depth = 0
    while (target && target.src && target.src.family === 'alias' && depth++ < 5) target = target.rel
    if (!target || !target.src || target.src.family !== 'page' || !target.pub) continue
    const key = normalizeUrlPath(alias.pub.url)
    if (!urls.has(key)) urls.set(key, toEntry(target.src, target))
  }
  for (const page of pages) {
    for (const key of pageAliasUrls(page)) {
      if (!urls.has(key)) urls.set(key, toEntry(page.src, page))
    }
  }
  return { urls, components }
}

const PAGE_ALIASES_ATTRIBUTE = ':page-aliases:'

/**
 * Returns the raw value of a page's page-aliases attribute, joining the
 * continuation lines that AsciiDoc allows a long value to span.
 */
function extractPageAliases (header) {
  const lines = header.split('\n')
  const start = lines.findIndex((line) => line.startsWith(PAGE_ALIASES_ATTRIBUTE))
  if (start === -1) return
  let value = lines[start].slice(PAGE_ALIASES_ATTRIBUTE.length)
  for (let index = start; value.trimEnd().endsWith('\\') && index + 1 < lines.length; index++) {
    value = `${value.trimEnd().slice(0, -1)} ${lines[index + 1]}`
  }
  return value
}

/**
 * Returns the normalized URL paths that a page's page-aliases attribute makes
 * available. Only aliases in the same component and version as the target page
 * are mapped, because their URL is derived from the target page's own
 * published URL; a cross-component or cross-version alias is left to Antora's
 * own redirect handling.
 */
function pageAliasUrls (page) {
  const contents = page.contents && page.contents.toString()
  if (!contents) return []
  const aliases = extractPageAliases(contents.slice(0, 4096))
  if (!aliases) return []
  const targetUrl = normalizeUrlPath(page.pub.url)
  const targetSuffix = pageUrlSuffix(page.src)
  // The alias URL differs from the target URL only in the module and page
  // segments, so everything before them is a shared prefix.
  if (targetSuffix && !targetUrl.endsWith(`/${targetSuffix}`)) return []
  const base = targetSuffix ? targetUrl.slice(0, -(targetSuffix.length + 1)) : targetUrl
  const keys = []
  for (const spec of aliases.split(',')) {
    const aliasSrc = parsePageAliasSpec(spec, page.src)
    if (!aliasSrc) continue
    const suffix = pageUrlSuffix(aliasSrc)
    keys.push(normalizeUrlPath(suffix ? `${base}/${suffix}` : base || '/'))
  }
  return keys
}

/**
 * Returns the module and page portion of a page's URL, which is the part that
 * follows the component and version segments. A module named ROOT and an
 * index page contribute no segment of their own.
 */
function pageUrlSuffix ({ module: module_, relative }) {
  let stem = relative.replace(/\.adoc$/, '')
  if (stem === 'index') stem = ''
  else if (stem.endsWith('/index')) stem = stem.slice(0, -'/index'.length)
  const segments = []
  if (module_ && module_ !== 'ROOT') segments.push(module_)
  if (stem) segments.push(stem)
  return segments.join('/')
}

/**
 * Parses one page-aliases entry ([version@][component:][module:]relative) into
 * a resource id, inheriting anything it leaves out from the page that declares
 * it. Returns undefined for an entry that names another component or version.
 */
function parsePageAliasSpec (spec, targetSrc) {
  let rest = spec.trim()
  if (!rest) return
  const versionSeparator = rest.indexOf('@')
  if (versionSeparator !== -1) {
    if (rest.slice(0, versionSeparator) !== targetSrc.version) return
    rest = rest.slice(versionSeparator + 1)
  }
  const parts = rest.split(':')
  if (parts.length > 3) return
  const relative = parts.pop()
  if (!relative) return
  const module_ = parts.length ? parts.pop() : targetSrc.module
  if (parts.length && parts[0] !== targetSrc.component) return
  // Antora still accepts an alias spec without the file extension.
  return { module: module_ || targetSrc.module, relative: relative.endsWith('.adoc') ? relative : `${relative}.adoc` }
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
  const versionPrefix = unprefixed.match(/^\/(?:current|beta|v?(\d+\.\d+(?:\.\d+)?))(\/.*)?$/)
  if (versionPrefix) {
    const [, version, rest = ''] = versionPrefix
    candidates.push(`/${LEGACY_UNPREFIXED_COMPONENT}/${version || latestVersionSegment}${rest}`)
    if (version) candidates.push(`/${LEGACY_UNPREFIXED_COMPONENT}/${latestVersionSegment}${rest}`)
    // Builds without a symbolic latest-version segment (for example preview
    // builds) publish the latest version under its real version number, and
    // may drop the component segment entirely (ROOT component). Substitute
    // each component's latest version; only verified candidates are used.
    if (!version) {
      for (const [name, { latestVersion }] of Object.entries(components)) {
        if (!latestVersion) continue
        candidates.push(`/${latestVersion}${rest}`)
        candidates.push(`/${name}/${latestVersion}${rest}`)
      }
    }
  } else if (docsPrefix) {
    const rest = unprefixed === '/' ? '' : unprefixed
    candidates.push(`/${LEGACY_UNPREFIXED_COMPONENT}/${latestVersionSegment}${rest}`)
    for (const [name, { latestVersion }] of Object.entries(components)) {
      if (!latestVersion) continue
      candidates.push(`/${latestVersion}${rest}`)
      candidates.push(`/${name}/${latestVersion}${rest}`)
    }
  }
  for (const [slug, componentName] of Object.entries(LEGACY_SLUG_REWRITES)) {
    if (normalizedPath === `/${slug}` || normalizedPath.startsWith(`/${slug}/`)) {
      candidates.push(`/${componentName}${normalizedPath.slice(slug.length + 1)}`)
    }
  }
  const segments = normalizedPath.split('/')
  const component = components[segments[1]]
  if (component && segments[2]) {
    const version = segments[2].replace(/^v/, '')
    if (version === component.latestVersion) {
      // An explicitly versioned URL whose version is the component's latest is
      // published under the symbolic segment instead (redirect:to strategy).
      candidates.push(['', segments[1], latestVersionSegment, ...segments.slice(3)].join('/'))
    } else if (segments[2] === latestVersionSegment && component.latestVersion) {
      // The reverse: a symbolic latest-version URL in a build that publishes
      // the latest version under its real number (for example the preview
      // site, which sets no latest-version segment).
      candidates.push(['', segments[1], component.latestVersion, ...segments.slice(3)].join('/'))
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

// Parsed heading id -> heading text, cached per target file.
const headingsByFile = new WeakMap()
const EXPLICIT_ANCHOR_PATTERNS = [
  /^\[\[([\w:.-]+)(?:,.*)?\]\]$/,
  /^\[#([\w:.-]+)(?:[,.].*)?\]$/,
  /^\[id="?([\w:.-]+)"?(?:,.*)?\]$/,
]
const HEADING_RX = /^(={1,6})\s+(\S.*)$/

/**
 * Returns the link text for a converted URL, or undefined when the URL should
 * be left alone.
 *
 * A labeled URL keeps its label, and an unlabeled URL without a fragment gets
 * empty text so that Antora fills in the target page title. An unlabeled URL
 * *with* a fragment has to be given text explicitly: Antora cannot resolve a
 * section title, so `xref:page.adoc#anchor[]` renders the raw resource id as
 * the link text. Prefer the heading the fragment points at, then the page
 * title; if neither can be read, the caller leaves the URL as a raw link,
 * which still displays sensibly.
 */
function linkTextFor (label, fragment, page, resolveInclude) {
  if (label) return label
  if (!fragment) return ''
  const contents = page && page.contents && page.contents.toString()
  if (!contents) return undefined
  let headings = headingsByFile.get(page)
  if (!headings) headingsByFile.set(page, (headings = pageHeadingIds(contents, page, resolveInclude)))
  return headings.get(fragment.slice(1)) || documentTitle(contents)
}

// Only the first level of includes is followed, and only this many per page:
// enough for the reference pages that assemble a partial per category, without
// walking an include tree of unknown depth.
const MAX_INCLUDES_SEARCHED = 50

/**
 * Collects the heading ids of a page plus those of the partials it includes.
 * The reference pages that carry most anchor targets are thin wrappers around
 * generated partials — every property heading on the cluster and broker
 * property pages lives in one — and Antora has not resolved includes yet at
 * contentClassified, so they are resolved here.
 */
function pageHeadingIds (contents, page, resolveInclude) {
  const ids = parseHeadingIds(contents)
  if (!resolveInclude) return ids
  let searched = 0
  for (const match of contents.matchAll(/^include::([^[\s]+)\[/gm)) {
    if (++searched > MAX_INCLUDES_SEARCHED) break
    let included
    try {
      included = resolveInclude(match[1], page)
    } catch {
      continue
    }
    if (!included || !included.contents) continue
    for (const [id, text] of parseHeadingIds(included.contents.toString())) {
      if (!ids.has(id)) ids.set(id, text)
    }
  }
  return ids
}

/**
 * Maps every heading id in a page to its text, covering explicit anchors
 * ([[id]], [#id], [id=...]) and the ids Asciidoctor generates from heading
 * text. Id generation is approximated: a mismatch only costs the page-title
 * fallback.
 */
function parseHeadingIds (contents) {
  const ids = new Map()
  let pendingId
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim()
    const anchor = EXPLICIT_ANCHOR_PATTERNS.reduce((found, pattern) => found || pattern.exec(line), null)
    if (anchor) {
      pendingId = anchor[1]
      continue
    }
    const heading = HEADING_RX.exec(line)
    if (heading) {
      const text = sanitizeLinkText(heading[2])
      const id = pendingId || autoId(text)
      if (id && text && !ids.has(id)) ids.set(id, text)
    }
    if (line) pendingId = undefined
  }
  return ids
}

/** Returns a page's document title (its level-0 heading), sanitized. */
function documentTitle (contents) {
  const match = /^=\s+(\S.*)$/m.exec(contents)
  return match ? sanitizeLinkText(match[1]) : undefined
}

/**
 * Makes text safe to use as an xref label: an unbalanced bracket would end the
 * macro early, and a nested link macro cannot appear inside one.
 */
function sanitizeLinkText (text) {
  return text
    .replace(/(?:xref|link|image):[^[\s]*\[([^\]]*)\]/g, '$1')
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Approximates Asciidoctor id generation with idprefix='' and idseparator='-'. */
function autoId (text) {
  return text
    .replace(/[`*+#^~]/g, '')
    .toLowerCase()
    .replace(/[^\w\- .]/g, '')
    .trim()
    .replace(/[ .]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Rewrites every mappable docs URL in content. Returns the updated content,
 * the number of conversions, the internal URLs that matched no published page,
 * the internal URLs that carry a query string (which an xref cannot express),
 * and the internal URLs left alone because no link text could be resolved for
 * their fragment.
 */
function convertContent (content, resolverContext) {
  const { hostnames, ignore = [] } = resolverContext
  let result = ''
  let cursor = 0
  let converted = 0
  const unmapped = []
  const withQueryString = []
  const withoutLinkText = []
  for (const match of scanContentUrls(content)) {
    let url
    try {
      url = new URL(match.url)
    } catch {
      continue
    }
    if (!hostnames.has(url.hostname) || match.inAttributeEntry || match.inAttributeValue) continue
    // The path still holds a literal {attribute} reference: attributes are
    // substituted after this hook, so the real target is unknown here. It
    // cannot be looked up in the catalog, and reporting it as unmatched would
    // be wrong when the substituted URL resolves fine.
    if (match.hasAttributeReference) continue
    if (ignore.some((pattern) => pattern.test(url.pathname))) continue
    // An xref target cannot carry a query string, and dropping one would
    // change the link: the docs UI reads parameters such as
    // ?platform=kubernetes to preselect a tab. Leave the raw URL, which still
    // works, rather than converting it lossily.
    if (url.search) {
      withQueryString.push(match.url)
      continue
    }
    const entry = resolveUrlPath(url.pathname, resolverContext)
    if (!entry) {
      unmapped.push(match.url)
      continue
    }
    const label = linkTextFor(match.label, url.hash, entry.page, resolverContext.resolveInclude)
    if (label === undefined) {
      withoutLinkText.push(match.url)
      continue
    }
    result += content.slice(cursor, match.start) + entryToXref(entry, url.hash, label)
    cursor = match.end
    converted++
  }
  result += content.slice(cursor)
  return { content: result, converted, unmapped, withQueryString, withoutLinkText }
}

module.exports.buildUrlMap = buildUrlMap
module.exports.convertContent = convertContent
module.exports.normalizeUrlPath = normalizeUrlPath
