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

const COMPONENT = 'solutions'

// Ids the docs-site function routes shadow (/solutions/progress, /solutions/download)
// plus names Antora already gives meaning to.
const RESERVED_IDS = ['progress', 'download', 'api', 'index']

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
    if (mod === 'ROOT') continue
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
  const platforms = parseList(attrs['page-solution-platforms'])

  return {
    id: mod,
    module: mod,
    componentVersion: version,
    overview,
    steps: stepPages,
    layout: attrs['page-layout'],
    title: overview ? (overview.asciidoc.doctitle || overview.title || mod) : mod,
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
    attachments: moduleAttachments
      .filter((a) => a.pub && a.pub.url)
      .map((a) => ({ name: a.src.relative, url: a.pub.url }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    lastModified: attrs['page-git-modified-date'] || null,
  }
}

module.exports = {
  COMPONENT,
  RESERVED_IDS,
  LAYOUTS,
  ENUMS,
  SLUG_RX,
  VERSION_RX,
  parseList,
  parseFlag,
  deriveRepo,
  pageKey,
  stripVersion,
  stepIdOf,
  collectSolutions,
}
