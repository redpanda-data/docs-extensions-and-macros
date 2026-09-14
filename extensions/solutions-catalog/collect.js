'use strict'

/**
 * Collect solution records from the `solutions` component of the content catalog.
 *
 * Everything in this file is a pure function over the catalog objects Antora
 * hands to extensions, so it can be exercised in tests with a small stub that
 * implements `getComponent`, `findBy`, and `resolveResource`. No validation
 * happens here: records carry the raw authored values plus the derived fields,
 * and validate.js decides what is acceptable.
 */

const { decode } = require('html-entities')

const COMPONENT = 'solutions'

// Ids the docs-site function routes shadow (/solutions/progress, /solutions/download),
// names Antora already gives meaning to, and the non-solution module below.
const RESERVED_IDS = ['progress', 'download', 'api', 'index', 'examples']

// Modules of the solutions component that are not solutions. ROOT holds the
// landing page and relationships.yml; `examples` holds public tutorial code
// published as attachments for Product Docs pages. Neither is validated as a
// solution, needs a pages/index.adoc, or appears in the catalog, nav, or graph.
const NON_SOLUTION_MODULES = ['ROOT', 'examples']

const LAYOUTS = Object.freeze({
  home: 'solutions-home',
  overview: 'solution',
  step: 'solution-step',
})

const ENUMS = Object.freeze({
  difficulty: ['beginner', 'intermediate', 'advanced'],
  status: ['draft', 'published', 'deprecated'],
  download: ['authenticated', 'public', 'none'],
  platforms: ['self-managed', 'cloud'],
})

const SLUG_RX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const VERSION_RX = /^v\d+\.\d+\.\d+$/

// Doc Detective evidence for a solution, written by the monorepo's runner after
// a passing full run and committed like the captured media. It is machine
// evidence rather than build-along scaffolding, so it is projected as the
// record's `verified` and kept out of the record's attachment list.
const VERIFICATION_FILE = 'verification.json'

// Manifest key -> record key. Only these are read, and only when the manifest
// carries them: nothing here is defaulted or synthesised.
const VERIFICATION_FIELDS = Object.freeze([
  ['suite', 'suite'],
  ['specs', 'specs'],
  ['steps', 'steps'],
  ['commands', 'commands'],
  ['checks', 'checks'],
  ['media', 'media'],
  ['verify_script', 'verifyScript'],
  ['redpanda_version', 'redpandaVersion'],
  ['run_at', 'runAt'],
])

/**
 * Read a solution's verification manifest.
 *
 * Returns `{ verified, error }`: a record object when the file parses and
 * carries at least one known field, otherwise `verified: null` and a reason for
 * validate.js to warn with. A missing file is neither: no data, no complaint.
 */
function parseVerification (file) {
  if (!file) return { verified: null, error: null }
  let data
  try {
    data = JSON.parse(file.contents ? file.contents.toString('utf8') : '')
  } catch (err) {
    return { verified: null, error: err.message }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { verified: null, error: 'not a JSON object' }
  }
  const verified = {}
  for (const [from, to] of VERIFICATION_FIELDS) {
    const value = data[from]
    if (value === undefined || value === null || value === '') continue
    verified[to] = value
  }
  if (!Object.keys(verified).length) return { verified: null, error: 'no known fields' }
  return { verified, error: null }
}

/** Split a comma list attribute into trimmed, non-empty values. */
function parseList (value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (value === undefined || value === null) return []
  return String(value).split(',').map((v) => v.trim()).filter(Boolean)
}

/**
 * AsciiDoc boolean: a set attribute is true unless it is literally "false".
 * `:page-solution-featured:` with no value arrives as '' and means true.
 */
function parseFlag (value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  return String(value).trim().toLowerCase() !== 'false'
}

/**
 * Reduce a git origin URL to `owner/name`.
 * Accepts https://github.com/o/n(.git), git@github.com:o/n(.git), ssh://git@github.com/o/n.
 * Local file:// origins (an unpushed worktree) yield ''.
 */
function deriveRepo (originUrl) {
  if (!originUrl || typeof originUrl !== 'string') return ''
  let url = originUrl.trim()
  if (url.startsWith('file:')) return ''
  // scp-like syntax: git@host:owner/name.git
  const scp = url.match(/^[^@/]+@[^:/]+:(.+)$/)
  let pathPart
  if (scp) {
    pathPart = scp[1]
  } else {
    try {
      pathPart = new URL(url).pathname
    } catch {
      return ''
    }
  }
  pathPart = pathPart.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  const segments = pathPart.split('/')
  if (segments.length < 2) return ''
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`
}

/** The page ID string used as the key for docs everywhere in this extension. */
function pageKey (page) {
  const src = page.src || {}
  return `${src.component}:${src.module}:${src.relative}`
}

/** Strip a `version@` prefix from a resource spec. */
function stripVersion (spec) {
  return String(spec || '').replace(/^[^@:\s]+@/, '')
}

/**
 * Plain-text page title. Asciidoctor's doctitle keeps inline markup
 * (`<code>rpk</code>`), which must not leak into JSON the UI prints as text.
 */
function plainTitle (value) {
  return decode(String(value || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

/**
 * Every example file a solution's pages actually render, deduplicated and
 * sorted: the set a reader may download and nothing more.
 *
 * Read back out of the rendered HTML, from the `data-solution-file` attributes
 * that the add-solution-file-provenance AsciiDoc extension stamps on each
 * snippet. Scraping what shipped rather than re-reading the AsciiDoc is what
 * keeps the allowlist and the page in step: a snippet the reader can see is in
 * the list, and a path no page renders cannot be.
 */
function collectSnippetFiles (pages) {
  const files = new Set()
  const rx = /data-solution-file="([^"]*)"/g
  for (const page of pages) {
    if (!page || !page.contents) continue
    const html = page.contents.toString('utf8')
    let match
    while ((match = rx.exec(html))) {
      const value = match[1]
        .replace(/&quot;/g, '"')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&')
        .trim()
      if (value) files.add(value)
    }
  }
  return [...files].sort()
}

/** Step id for a page of a solution module: the file stem relative to pages/. */
function stepIdOf (page) {
  return String(page.src.relative || '').replace(/\.adoc$/, '')
}

/**
 * Collect the solutions component into records.
 *
 * @param {Object} contentCatalog - Antora content catalog (or a test stub)
 * @param {Object} [options]
 * @param {string} [options.component='solutions']
 * @returns {null | {
 *   component: Object, version: string, landing: Object|undefined,
 *   solutions: Array<Object>, rootPages: Array<Object>, relationshipsFile: Object|undefined
 * }} null when the component is not part of the build
 */
function collectSolutions (contentCatalog, { component = COMPONENT } = {}) {
  const comp = contentCatalog.getComponent(component)
  if (!comp) return null

  const latest = comp.latest || (comp.versions && comp.versions[0])
  const version = latest ? latest.version : ''

  const pages = contentCatalog.findBy({ component, family: 'page', version })
  const attachments = contentCatalog.findBy({ component, family: 'attachment', version })
  const partials = contentCatalog.findBy({ component, family: 'partial', version })

  const byModule = new Map()
  for (const page of pages) {
    const mod = page.src.module
    if (!byModule.has(mod)) byModule.set(mod, [])
    byModule.get(mod).push(page)
  }

  const rootPages = byModule.get('ROOT') || []
  const landing = rootPages.find((p) => p.src.relative === 'index.adoc')
  const relationshipsFile = partials.find((f) => f.src.module === 'ROOT' && f.src.relative === 'relationships.yml')

  const solutions = []
  for (const [mod, modulePages] of byModule) {
    if (NON_SOLUTION_MODULES.includes(mod)) continue
    solutions.push(buildRecord(mod, modulePages, attachments.filter((a) => a.src.module === mod), { version }))
  }
  solutions.sort((a, b) => a.id.localeCompare(b.id))

  return { component: comp, version, landing, solutions, rootPages, relationshipsFile }
}

function buildRecord (mod, modulePages, moduleAttachments, { version }) {
  const overview = modulePages.find((p) => p.src.relative === 'index.adoc')
  const stepPages = modulePages
    .filter((p) => p !== overview)
    .map((p) => ({ id: stepIdOf(p), page: p }))
    .sort((a, b) => a.id.localeCompare(b.id))

  const attrs = (overview && overview.asciidoc && overview.asciidoc.attributes) || {}
  const solutionVersion = attrs['page-solution-version'] ? String(attrs['page-solution-version']).trim() : ''
  const { verified, error: verifiedError } = parseVerification(
    moduleAttachments.find((a) => a.src.relative === VERIFICATION_FILE)
  )
  const platforms = parseList(attrs['page-solution-platforms'])

  return {
    id: mod,
    module: mod,
    componentVersion: version,
    overview,
    steps: stepPages,
    layout: attrs['page-layout'],
    // At contentClassified pages have no asciidoc yet; only structure is read then.
    title: plainTitle(overview && overview.asciidoc && overview.asciidoc.doctitle) || (overview && overview.title) || mod,
    url: overview && overview.pub ? overview.pub.url : undefined,
    description: attrs.description ? String(attrs.description).trim() : '',
    version: solutionVersion,
    difficulty: attrs['page-solution-difficulty'] ? String(attrs['page-solution-difficulty']).trim() : '',
    duration: attrs['page-solution-duration'],
    status: attrs['page-solution-status'] ? String(attrs['page-solution-status']).trim() : '',
    featured: parseFlag(attrs['page-solution-featured']),
    download: attrs['page-solution-download'] ? String(attrs['page-solution-download']).trim() : '',
    platforms: platforms.length ? platforms : [...ENUMS.platforms],
    platformsAuthored: platforms.length > 0,
    technologies: parseList(attrs['page-solution-technologies']),
    categoriesRaw: parseList(attrs['page-categories']),
    categories: parseList(attrs['page-categories']),
    useCases: parseList(attrs['page-solution-use-cases']),
    personas: parseList(attrs.personas || attrs['page-personas']),
    stepIds: parseList(attrs['page-solution-steps']),
    relatedDocRefs: parseList(attrs['page-solution-related-docs']),
    relatedSolutionIds: parseList(attrs['page-solution-related-solutions']),
    supersededBy: attrs['page-solution-superseded-by'] ? String(attrs['page-solution-superseded-by']).trim() : '',
    topicType: attrs['page-topic-type'],
    repo: deriveRepo(overview && overview.src && overview.src.origin && overview.src.origin.url),
    tag: solutionVersion ? `${mod}/${solutionVersion}` : '',
    asset: solutionVersion ? `${mod}-${solutionVersion}.zip` : '',
    verified,
    verifiedError,
    files: collectSnippetFiles([overview, ...stepPages.map((s) => s.page)]),
    attachments: moduleAttachments
      .filter((a) => a.src.relative !== VERIFICATION_FILE)
      .filter((a) => a.pub && a.pub.url)
      .map((a) => ({ name: a.src.relative, url: a.pub.url }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    lastModified: attrs['page-git-modified-date'] || null,
  }
}

module.exports = {
  COMPONENT,
  RESERVED_IDS,
  NON_SOLUTION_MODULES,
  LAYOUTS,
  ENUMS,
  SLUG_RX,
  VERSION_RX,
  VERIFICATION_FILE,
  VERIFICATION_FIELDS,
  parseVerification,
  collectSnippetFiles,
  parseList,
  parseFlag,
  deriveRepo,
  pageKey,
  stripVersion,
  stepIdOf,
  plainTitle,
  collectSolutions,
}
