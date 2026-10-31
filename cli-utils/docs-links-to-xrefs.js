'use strict'

/**
 * Converts docs.redpanda.com URLs in a generated page into xrefs before the
 * page is committed to a docs repository.
 *
 * Reference pages generated from engineering sources (the CRD reference from
 * Go doc comments, for example) arrive with absolute docs URLs, because a Go
 * comment cannot carry an AsciiDoc xref. The url-to-xref Antora extension
 * rewrites those at site build time, but the committed source then flips
 * between xrefs and URLs on every regeneration, which buries the real content
 * changes in a review diff. Converting here keeps the committed page stable.
 *
 * The URL-to-resource mapping is the one the extension uses: this module
 * builds a real Antora content catalog from the docs checkout (aggregator plus
 * classifier, worktree files, HEAD only) and hands it to the extension's
 * buildUrlMap and convertContent. Nothing about the URL structure is guessed:
 * a URL is converted only when it matches a page the checkout publishes,
 * directly or through a page alias, and its fragment, if any, matches an
 * anchor on that page; everything else is left as written and reported to the
 * caller.
 *
 * Targets in the checkout's own component are written as module:page xrefs,
 * the form the docs repos use by hand for same-component links. Pages of other
 * components (Connect, Cloud) are not in a single-repo catalog, so by default
 * URLs that point at them stay raw and are listed in the run output; the
 * build-time extension still converts them on the site. Pass the checkouts of
 * those components as lenders to read them into the same catalog: a URL that
 * matches one of their pages then becomes a component-qualified xref
 * (connect:guides:bloblang/about.adoc), version-pinned when the URL names a
 * version that is not the component's latest, exactly as the extension writes
 * it at build time.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { fileURLToPath } = require('url')
const yaml = require('js-yaml')

const { buildUrlMap, convertContent, targetComponentOf } = require('../extensions/url-to-xref')

const DEFAULT_HOSTNAMES = ['docs.redpanda.com']
// Mirrors the extension's default ignore list: docs-domain paths that Antora
// does not publish (the Bump.sh API reference and the MCP endpoint).
const DEFAULT_IGNORE = ['^/api/', '^/mcp(/|$)']
const LATEST_VERSION_SEGMENT = 'current'

/**
 * Loads an Antora package, preferring the copy installed in the docs checkout
 * (the site's own Antora version) over the one this package ships for its own
 * preview build. The aggregator and classifier are dependencies of
 * @antora/site-generator, so they are resolved through it.
 */
function requireAntora (name, searchPaths) {
  const errors = []
  for (const searchPath of searchPaths) {
    try {
      const siteGenerator = path.dirname(require.resolve('@antora/site-generator/package.json', { paths: [searchPath] }))
      return require(require.resolve(name, { paths: [siteGenerator, searchPath] }))
    } catch (err) {
      errors.push(`${searchPath}: ${err.message.split('\n')[0]}`)
    }
  }
  throw new Error(`Cannot load ${name}; install Antora in the docs repository (npm install) so generated links can be converted.\n${errors.join('\n')}`)
}

function realPath (dir) {
  try {
    return fs.realpathSync(dir)
  } catch {
    return dir
  }
}

/**
 * Reads the component name a docs checkout declares in antora.yml. A checkout
 * without one is not an Antora component and cannot be mapped.
 */
function readComponentName (docsRoot) {
  const descriptor = path.join(docsRoot, 'antora.yml')
  if (!fs.existsSync(descriptor)) {
    throw new Error(`No antora.yml in ${docsRoot}; a docs checkout is needed to map docs URLs to pages`)
  }
  const { name } = yaml.load(fs.readFileSync(descriptor, 'utf8')) || {}
  if (!name) throw new Error(`${descriptor} declares no component name`)
  return name
}

/**
 * Builds the resolver context for a docs checkout: the extension's URL map,
 * computed from an Antora content catalog of the checkout's worktree and of
 * any lender checkouts.
 *
 * @param {string} docsRoot - Root of a docs repository checkout (holds antora.yml).
 *   Its component is the local one: targets in it are written as module:page.
 * @param {Object} [options]
 * @param {string[]} [options.lenders] - Other component checkouts (each holds an
 *   antora.yml) read into the same catalog, so URLs that point at their pages
 *   become component-qualified xrefs instead of staying raw.
 * @param {string[]} [options.hostnames] - Docs hostnames to convert.
 * @param {string[]} [options.ignore] - URL path patterns to leave alone silently.
 * @param {string} [options.cacheDir] - Antora cache directory.
 * @returns {Promise<Object>} A context for convertContent, plus `component`
 *   (the checkout's component name), `pageCount` (pages in the whole
 *   catalog) and `loaded` (one {component, version, dir, pageCount} per
 *   checkout, the local one first).
 */
async function buildDocsResolverContext (docsRoot, options = {}) {
  const root = path.resolve(docsRoot)
  const component = readComponentName(root)
  const lenderRoots = [...new Set((options.lenders || []).map((dir) => path.resolve(dir)))].filter((dir) => dir !== root)
  // Read each lender's descriptor up front so a wrong path fails with the
  // path in the message, not deep inside the aggregator.
  for (const dir of lenderRoots) readComponentName(dir)
  const searchPaths = [root, path.join(__dirname, '..')]
  const aggregateContent = requireAntora('@antora/content-aggregator', searchPaths)
  const classifyContent = requireAntora('@antora/content-classifier', searchPaths)
  const playbook = {
    runtime: {
      quiet: true,
      fetch: false,
      cacheDir: options.cacheDir || fs.mkdtempSync(path.join(os.tmpdir(), 'docs-links-antora-cache-')),
      log: { level: 'silent' },
    },
    site: {},
    // The published shape of the live site; normalizeUrlPath in the extension
    // makes the extension style irrelevant to matching, and candidatePaths
    // covers both the symbolic and the real version segment.
    urls: { htmlExtensionStyle: 'indexify', latestVersionSegment: LATEST_VERSION_SEGMENT },
    // HEAD of the local checkout, read from the worktree, so an unpushed
    // branch and uncommitted pages count as published.
    // Lenders are read the same way, each as its own content source.
    content: { sources: [root, ...lenderRoots].map((url) => ({ url, branches: 'HEAD' })) },
  }
  const aggregate = await aggregateContent(playbook)
  let contentCatalog
  try {
    contentCatalog = classifyContent(playbook, aggregate)
  } catch (err) {
    if (!lenderRoots.length) throw err
    // Two checkouts of the same component version publish the same pages.
    throw new Error(`Cannot read the docs checkout and its lenders into one catalog (${err.message.split('\n')[0]}). Each lender must be a different component, or a different version of one.`)
  }
  const pageCount = contentCatalog.getPages((page) => page.out).length
  const loaded = aggregate.map(({ name, version, origins = [] }) => {
    const origin = origins.find((o) => typeof o.worktree === 'string') || origins[0] || {}
    let dir = typeof origin.worktree === 'string' ? origin.worktree : origin.url
    if (dir && dir.startsWith('file:')) dir = fileURLToPath(dir)
    return {
      component: name,
      version: version || '',
      dir,
      pageCount: contentCatalog.getPages((page) => page.out && page.src.component === name && page.src.version === version).length,
    }
  })
  // The local checkout first, then lenders in the order given. Origins can
  // name a checkout by its real path (/private/tmp for /tmp on macOS).
  const order = [root, ...lenderRoots].map(realPath)
  for (const entry of loaded) {
    const index = order.indexOf(realPath(entry.dir))
    if (index !== -1) entry.dir = [root, ...lenderRoots][index]
  }
  loaded.sort((a, b) => order.indexOf(realPath(a.dir)) - order.indexOf(realPath(b.dir)))
  return Object.assign(buildUrlMap(contentCatalog), {
    hostnames: new Set(options.hostnames || DEFAULT_HOSTNAMES),
    ignore: (options.ignore || DEFAULT_IGNORE).map((pattern) => new RegExp(pattern)),
    latestVersionSegment: LATEST_VERSION_SEGMENT,
    localComponent: component,
    resolveInclude: (spec, page) => contentCatalog.resolveResource(spec, page.src, 'partial', ['partial', 'page']),
    component,
    pageCount,
    loaded,
  })
}

/**
 * Describes what a resolver context maps against, for the run output. With no
 * lenders this is the line the CRD generator has always printed.
 */
function describeResolverContext (context, docsRoot) {
  const lenders = (context.loaded || []).filter((entry) => entry.dir !== path.resolve(docsRoot))
  const localPages = lenders.length
    ? context.pageCount - lenders.reduce((sum, entry) => sum + entry.pageCount, 0)
    : context.pageCount
  let line = `Mapping docs URLs against ${localPages} pages of the ${context.component} component in ${docsRoot}`
  if (lenders.length) {
    const named = lenders.map((entry) => `${entry.pageCount} of ${entry.component}${entry.version ? ` ${entry.version}` : ''} in ${entry.dir}`)
    line += `, plus lender pages: ${named.join('; ')}`
  }
  return line
}

/**
 * Converts the docs URLs in a string. Thin wrapper over the extension's
 * convertContent so callers do not depend on the extension module directly.
 */
function convertDocsLinks (content, context) {
  return convertContent(content, context)
}

/**
 * Converts the docs URLs in a file in place. The file is rewritten only when
 * something changed.
 *
 * @returns {Object} `{ converted, unmapped, withQueryString, withoutLinkText, missingAnchor }`
 *   with the raw URLs in each list deduplicated.
 */
function convertDocsLinksInFile (filePath, context) {
  const before = fs.readFileSync(filePath, 'utf8')
  const result = convertDocsLinks(before, context)
  if (result.converted) fs.writeFileSync(filePath, result.content, 'utf8')
  return {
    converted: result.converted,
    unmapped: [...new Set(result.unmapped)],
    withQueryString: [...new Set(result.withQueryString)],
    withoutLinkText: [...new Set(result.withoutLinkText)],
    missingAnchor: [...new Set(result.missingAnchor)],
  }
}

/**
 * Folds the results of several conversions (one per generated page) into one,
 * in the shape convertDocsLinksInFile returns.
 */
function mergeDocsLinkResults (results) {
  const merged = { converted: 0, unmapped: [], withQueryString: [], withoutLinkText: [], missingAnchor: [] }
  for (const result of results) {
    merged.converted += result.converted || 0
    for (const key of ['unmapped', 'withQueryString', 'withoutLinkText', 'missingAnchor']) {
      for (const url of result[key] || []) if (!merged[key].includes(url)) merged[key].push(url)
    }
  }
  return merged
}

const REASONS = {
  unmappedNoContext: 'no page in this checkout matches; the url-to-xref extension converts cross-component URLs at build time and warns about broken ones',
  noPage: 'no page in the loaded components matches; the link is probably broken, and the url-to-xref extension warns about it at build time',
  notLoaded: (name) => `it points at the ${name} component, which this run did not load; pass its checkout with --lender to convert it (the url-to-xref extension converts it at build time)`,
  withQueryString: 'an xref cannot carry a query string',
  withoutLinkText: 'the target page could not be read to check the fragment',
  missingAnchor: 'anchor not found: the page exists but has no section or anchor with that id',
  ignored: 'the path is served outside the Antora catalog (the API reference or the MCP endpoint)',
  notScanned: 'not converted by this run: the page was not regenerated (hand-written or preserved), or the URL is in a code block, code span, comment, attribute entry or macro attribute, which the converter leaves as written',
  noContext: 'no docs checkout was given to map against, so nothing was converted; the url-to-xref extension converts it at build time',
}

/**
 * Explains why a URL that matched no page was left as written: its component
 * is not in the catalog, or it is in the catalog and the page does not exist.
 */
function unmappedReason (url, context) {
  if (!context || !context.components) return { reason: REASONS.unmappedNoContext, severity: 'warning' }
  let pathname
  try {
    pathname = new URL(url).pathname
  } catch {
    return { reason: REASONS.noPage, severity: 'warning' }
  }
  const target = targetComponentOf(pathname)
  if (target && !(target in context.components)) return { reason: REASONS.notLoaded(target), severity: 'info', notLoaded: target }
  return { reason: REASONS.noPage, severity: 'warning' }
}

/**
 * Explains why a docs URL is still raw in generated output, given the
 * conversion result and the context it ran with (both absent when no
 * conversion ran). Severity is warning for a URL that points at a page or
 * anchor the loaded components lack (a likely broken link), info otherwise.
 *
 * @param {string} url - The raw URL, with trailing sentence punctuation trimmed.
 * @param {{result: Object, context: Object}} [report]
 * @returns {{reason: string, severity: string}}
 */
function explainRawDocsUrl (url, report) {
  if (!report || !report.result) return { reason: REASONS.noContext, severity: 'info' }
  const { result, context } = report
  if ((result.missingAnchor || []).includes(url)) return { reason: REASONS.missingAnchor, severity: 'warning' }
  if ((result.unmapped || []).includes(url)) return unmappedReason(url, context)
  if ((result.withQueryString || []).includes(url)) return { reason: REASONS.withQueryString, severity: 'info' }
  if ((result.withoutLinkText || []).includes(url)) return { reason: REASONS.withoutLinkText, severity: 'info' }
  let pathname = ''
  try {
    pathname = new URL(url).pathname
  } catch {}
  const ignore = (context && context.ignore) || DEFAULT_IGNORE.map((pattern) => new RegExp(pattern))
  if (ignore.some((pattern) => pattern.test(pathname))) return { reason: REASONS.ignored, severity: 'info' }
  return { reason: REASONS.notScanned, severity: 'info' }
}

/**
 * Formats the outcome of a conversion for the run output: one summary line,
 * then every URL that was left as written and why. Given the resolver
 * context, URLs that matched no page are split into those whose component
 * was not loaded and those that are likely broken.
 */
function formatDocsLinkReport (result, filePath, context) {
  const lines = [`Converted ${result.converted} docs URL${result.converted === 1 ? '' : 's'} to xrefs in ${filePath}`]
  const leftRaw = (urls, reason) => {
    if (!urls.length) return
    lines.push(`Left ${urls.length} docs URL${urls.length === 1 ? '' : 's'} as written (${reason}):`)
    for (const url of urls) lines.push(`  ${url}`)
  }
  const byReason = new Map()
  for (const url of result.unmapped) {
    const { reason } = unmappedReason(url, context)
    if (!byReason.has(reason)) byReason.set(reason, [])
    byReason.get(reason).push(url)
  }
  for (const [reason, urls] of byReason) leftRaw(urls, reason)
  leftRaw(result.withQueryString, REASONS.withQueryString)
  leftRaw(result.withoutLinkText, REASONS.withoutLinkText)
  leftRaw(result.missingAnchor || [], REASONS.missingAnchor)
  return lines.join('\n')
}

module.exports = {
  buildDocsResolverContext,
  describeResolverContext,
  convertDocsLinks,
  convertDocsLinksInFile,
  mergeDocsLinkResults,
  explainRawDocsUrl,
  formatDocsLinkReport,
}
