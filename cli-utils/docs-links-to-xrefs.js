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
 * components (Connect, Cloud) are not in a single-repo catalog, so URLs that
 * point at them stay raw and are listed in the run output; the build-time
 * extension still converts them on the site.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const yaml = require('js-yaml')

const { buildUrlMap, convertContent } = require('../extensions/url-to-xref')

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
 * computed from an Antora content catalog of the checkout's worktree.
 *
 * @param {string} docsRoot - Root of a docs repository checkout (holds antora.yml).
 * @param {Object} [options]
 * @param {string[]} [options.hostnames] - Docs hostnames to convert.
 * @param {string[]} [options.ignore] - URL path patterns to leave alone silently.
 * @param {string} [options.cacheDir] - Antora cache directory.
 * @returns {Promise<Object>} A context for convertContent, plus `component`
 *   (the checkout's component name) and `pageCount`.
 */
async function buildDocsResolverContext (docsRoot, options = {}) {
  const root = path.resolve(docsRoot)
  const component = readComponentName(root)
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
    content: { sources: [{ url: root, branches: 'HEAD' }] },
  }
  const contentCatalog = classifyContent(playbook, await aggregateContent(playbook))
  const pageCount = contentCatalog.getPages((page) => page.out).length
  return Object.assign(buildUrlMap(contentCatalog), {
    hostnames: new Set(options.hostnames || DEFAULT_HOSTNAMES),
    ignore: (options.ignore || DEFAULT_IGNORE).map((pattern) => new RegExp(pattern)),
    latestVersionSegment: LATEST_VERSION_SEGMENT,
    localComponent: component,
    resolveInclude: (spec, page) => contentCatalog.resolveResource(spec, page.src, 'partial', ['partial', 'page']),
    component,
    pageCount,
  })
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
 * Formats the outcome of a file conversion for the run output: one summary
 * line, then every URL that was left as written and why.
 */
function formatDocsLinkReport (result, filePath) {
  const lines = [`Converted ${result.converted} docs URL${result.converted === 1 ? '' : 's'} to xrefs in ${filePath}`]
  const leftRaw = (urls, reason) => {
    if (!urls.length) return
    lines.push(`Left ${urls.length} docs URL${urls.length === 1 ? '' : 's'} as written (${reason}):`)
    for (const url of urls) lines.push(`  ${url}`)
  }
  leftRaw(result.unmapped, 'no page in this checkout matches; the url-to-xref extension converts cross-component URLs at build time and warns about broken ones')
  leftRaw(result.withQueryString, 'an xref cannot carry a query string')
  leftRaw(result.withoutLinkText, 'the target page could not be read to check the fragment')
  leftRaw(result.missingAnchor || [], 'anchor not found: the page exists but has no section or anchor with that id')
  return lines.join('\n')
}

module.exports = {
  buildDocsResolverContext,
  convertDocsLinks,
  convertDocsLinksInFile,
  formatDocsLinkReport,
}
