'use strict'

/* Dataset selection for the value macros, shared by prop:/propval:
 * (redpanda-properties-<tag>.json), rpkval: (rpk-<version>.json) and
 * connectval: (connect-<version>.json).
 *
 * Each dataset is an Antora attachment, and a page picks one by its own
 * component and version, through one of these kind objects:
 *
 *   module       The module whose attachments hold the files.
 *   rx           Matches the file basename; group 1 is the tag.
 *   validate     (data) => true, or a reason string for an unusable file.
 *   borrowWhen   Component attributes (env-cloud) that make a page use a
 *                lender's newest GA file instead of its own.
 *   lenders      The components that may lend one (streaming, ROOT).
 *   cacheSymbol  Where the per-catalog registry cache lives, so each kind
 *   gapSymbol    keeps its own cache and gap records on one catalog.
 *   text         The wording of the warnings, so each kind names its own
 *                macro, files and regeneration command.
 *
 * The selection rules are the ones prop: has always used: Cloud first when a
 * borrow attribute is set (GA lender data only), then the component's own
 * files for its release series, then nothing. A dataset is never guessed from
 * a neighbouring release or from another product's version.
 */

const semver = require('semver')

// Which slice of a dataset a component may reference.
const SURFACE_ALL = 'all'
const SURFACE_CLOUD = 'cloud'

// Warnings are deduplicated per build. Antora's watch mode (gulp/npm start)
// reuses one process across many builds, so a module-level guard would report
// each problem only on a session's first build and stay silent afterwards --
// exactly when a writer is iterating and most wants to see it. The content
// catalog is rebuilt per build, so keying off it scopes the guard correctly.
const $warned = Symbol('$warned')

function warnOnce (contentCatalog, key, message, logger) {
  const seen = contentCatalog[$warned] || (contentCatalog[$warned] = new Set())
  if (seen.has(key)) return false
  seen.add(key)
  logger.warn(message)
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
 * Every attachment of one kind in the build, as {tag, file, component, version}.
 */
function datasetsMatching (contentCatalog, { module, rx }) {
  const found = []
  for (const attachment of contentCatalog.findBy({ family: 'attachment' }) || []) {
    if (attachment.src.module !== module) continue
    const match = attachment.src.relative.split('/').pop().match(rx)
    if (!match) continue
    found.push({ tag: match[1], file: attachment, component: attachment.src.component, version: attachment.src.version })
  }
  return found
}

/**
 * A stable identity for an attachment, so two files carrying the same tag are
 * resolved the same way on every build instead of by catalog iteration order.
 */
function stableKey (candidate) {
  return `${candidate.component}\u0000${candidate.version}\u0000${candidate.file.src.relative}`
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
 * The chosen dataset first, then the remaining candidates from the same pool in
 * descending release order, so an unusable file falls through to the next best
 * rather than voiding the component's data entirely.
 */
function orderedCandidates (pick, pool) {
  if (!pick) return []
  const rest = (pool || [])
    .filter((d) => d !== pick)
    .sort((a, b) => compareTags(b.tag, a.tag) || stableKey(a).localeCompare(stableKey(b)))
  return [pick, ...rest]
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Which dataset a registry came from, named in every warning so a reader can
 * tell a typo apart from a release or component mismatch.
 */
function describeDataset (registry) {
  const from = registry.component
    ? `${registry.component}@${registry.version || 'unversioned'}`
    : 'unknown component'
  return `${registry.kind.filePrefix}${registry.tag}.json from ${from}`
}

/**
 * Parse one attachment, or report why it is unusable and return undefined. A
 * JSON syntax error used to escape as an unhandled exception that named no
 * file, so a single bad attachment failed the build with no way to tell which
 * of them was at fault.
 */
function readDataset (candidate, contentCatalog, kind) {
  const where = `${candidate.component}@${candidate.version || 'unversioned'}`
  const t = kind.text
  let data
  try {
    data = JSON.parse(candidate.file.contents.toString())
  } catch (error) {
    warnOnce(contentCatalog, `${kind.keyPrefix}badjson:${where}:${candidate.tag}`,
      `${t.log}: ${kind.filePrefix}${candidate.tag}.json in ${where} is not valid JSON (${error.message}), so it is ignored. Regenerate it with ${kind.regenerate}.`, kind.logger)
    return undefined
  }
  // A string, number, or array parses fine and would then make every target
  // look like a typo.
  const verdict = isPlainObject(data) ? kind.validate(data) : kind.notObjectReason
  if (verdict !== true) {
    warnOnce(contentCatalog, `${kind.keyPrefix}${kind.invalidKey}:${where}:${candidate.tag}`,
      `${t.log}: ${kind.filePrefix}${candidate.tag}.json in ${where} ${verdict}, so it is ignored. Regenerate it with ${kind.regenerate}.`, kind.logger)
    return undefined
  }
  return data
}

function recordGap (contentCatalog, kind, cacheKey, gap) {
  const gaps = contentCatalog[kind.gapSymbol] || (contentCatalog[kind.gapSymbol] = {})
  gaps[cacheKey] = gap
}

/**
 * Load and cache the dataset of one kind for one page's component and version,
 * plus which slice of it that component may reference. Returns undefined when
 * the component has no data, which is the signal to report and fall back.
 *
 * Two doc sets have data of their own or borrowed:
 *
 *   A component that publishes its own attachment (the self-managed docs)
 *   uses the file for its own release series, newest patch within it, and
 *   may reference everything in it. Matching by series rather than by newest
 *   tag matters because the main branch carries the previous series' file
 *   alongside its own, and a prerelease could land there too. A versioned
 *   page whose series has no file goes unvalidated with an explicit warning
 *   rather than borrowing a neighbouring release's data.
 *
 *   A component with a borrow attribute (env-cloud) has no data of its own,
 *   so it tracks the newest GA file of a lender.
 *
 * Anything else gets nothing. Component versions elsewhere in the site carry
 * their own product versions, which say nothing about Redpanda releases, so no
 * dataset is inferred for them.
 */
function loadDatasetFor (contentCatalog, pageComponent, pageVersion, kind) {
  const cacheKey = `${pageComponent}@${pageVersion}`
  const cache = contentCatalog[kind.cacheSymbol] || (contentCatalog[kind.cacheSymbol] = {})
  if (cache[cacheKey] !== undefined) return cache[cacheKey] || undefined

  const datasets = datasetsMatching(contentCatalog, kind)
  const own = datasets.filter((d) => d.component === pageComponent)
  let pick
  let surface
  // The candidates the corrupt-file fallback may fall back TO. It has to be the
  // same filtered set `pick` was chosen from, not everything the component
  // publishes: falling back across release series would validate a 25.3 page
  // against 25.2 data, which is exactly the borrowing this function refuses to
  // do on the primary path.
  let pool

  // Cloud is decided first, and deliberately outranks the component's own
  // attachments. The property extractor writes
  // modules/reference/attachments/redpanda-properties-<tag>.json into whatever
  // repo it runs in, so running it inside cloud-docs would otherwise flip that
  // component to the unfiltered surface and switch off cloud_supported gating
  // site-wide, with no warning anywhere.
  const attributes = componentAttributes(contentCatalog, pageComponent, pageVersion)
  if (kind.borrowWhen.some((name) => isAttributeSet(attributes[name]))) {
    surface = SURFACE_CLOUD
    // GA only: Cloud runs released Redpanda, so an RC published on the beta
    // branch must not become the dataset Cloud pages validate against.
    // Only the named lenders count -- another component's product version is
    // not a Redpanda release candidate.
    const lenders = datasets.filter((d) => kind.lenders.includes(d.component))
    const released = lenders.filter((d) => !isPrerelease(d.tag))
    pool = released
    for (const lender of kind.lenders) {
      pick = newestDataset(released.filter((d) => d.component === lender))
      if (pick) break
    }
    if (!pick && lenders.length) {
      // Self-managed data exists but all of it is a prerelease. Say that
      // specifically rather than claiming no data was found.
      recordGap(contentCatalog, kind, cacheKey, {
        kind: 'cloud-prerelease-only',
        component: pageComponent,
        version: pageVersion,
        have: [...new Set(lenders.map((d) => d.tag))].sort(compareTags),
      })
      cache[cacheKey] = null
      return undefined
    }
  } else if (own.length) {
    surface = SURFACE_ALL
    const series = releaseSeries(pageVersion)
    if (series) {
      const inSeries = own.filter((d) => releaseSeries(d.tag) === series)
      pool = inSeries
      pick = newestDataset(inSeries.filter((d) => d.version === pageVersion)) || newestDataset(inSeries)
      if (!pick) {
        // Record the gap rather than reporting it here: this also runs from the
        // property-page-index extension, once per component version in the
        // build, so warning now would report versions no page of which uses the
        // macro. The macro reports it on first actual use.
        recordGap(contentCatalog, kind, cacheKey, {
          kind: 'series',
          component: pageComponent,
          version: pageVersion,
          series,
          have: [...new Set(own.map((d) => d.tag))].sort(compareTags),
        })
        cache[cacheKey] = null
        return undefined
      }
    } else {
      pool = own
      pick = newestDataset(own.filter((d) => d.version === pageVersion)) || newestDataset(own)
    }
  }

  // A corrupt or half-written attachment must not take the whole build down,
  // and must not mask a good file: try candidates newest-first and use the
  // first one that is usable, reporting each one skipped.
  let registry = null
  const candidates = orderedCandidates(pick, pool)
  for (const candidate of candidates) {
    const data = readDataset(candidate, contentCatalog, kind)
    if (!data) continue
    registry = { tag: candidate.tag, data, component: candidate.component, version: candidate.version, surface, kind }
    if (kind.decorate) kind.decorate(registry)
    break
  }
  if (!registry && candidates.length) {
    // Every candidate was unusable. Record that, because the caller's fallback
    // diagnostic says no attachment exists anywhere -- which contradicts the
    // per-file warning readDataset just emitted and sends the writer looking
    // for a file that is sitting right there.
    recordGap(contentCatalog, kind, cacheKey, {
      kind: 'unusable',
      component: pageComponent,
      version: pageVersion,
      have: [...new Set(candidates.map((d) => d.tag))].sort(compareTags),
    })
  }
  // Cache null too, so a missing dataset is only searched for once per build.
  cache[cacheKey] = registry
  return registry || undefined
}

/**
 * Report, once, why a page has no dataset of this kind: the gap recorded at
 * load time when there is one, else no data at all. Gaps are reported only on
 * first macro use, never at load time.
 *
 * @returns {boolean} Whether a recorded gap was reported.
 */
function warnDatasetMissing (contentCatalog, component, version, kind) {
  const t = kind.text
  const gaps = contentCatalog[kind.gapSymbol]
  const gap = gaps && gaps[`${component}@${version}`]
  if (!gap) {
    warnOnce(contentCatalog, `${kind.keyPrefix}nodata:${component}@${version}`, t.noData(component, version), kind.logger)
    return false
  }
  const have = gap.have.join(', ')
  if (gap.kind === 'unusable') {
    warnOnce(contentCatalog, `${kind.keyPrefix}unusable:${gap.component}@${gap.version}`,
      `${t.log}: every ${t.attachment} for ${gap.component}@${gap.version} is unusable (${have}); see the per-file warning above for why. ` +
      `${t.effect('')}. Regenerate the file with ${kind.regenerate} rather than treating this as missing data.`, kind.logger)
    return true
  }
  if (gap.kind === 'cloud-prerelease-only') {
    warnOnce(contentCatalog, `${kind.keyPrefix}cloudpre:${gap.component}@${gap.version}`,
      `${t.log}: ${gap.component} found only prerelease ${kind.label} (${have}). Cloud runs released Redpanda, so it uses GA ${kind.label} and will not validate against a release candidate. ` +
      `${t.effect(' on Cloud pages')}. Include a GA self-managed branch in the build, or leave ${t.macro} out of Cloud content until the release ships.`, kind.logger)
    return true
  }
  warnOnce(contentCatalog, `${kind.keyPrefix}series:${gap.component}@${gap.version}`,
    `${t.log}: ${gap.component}@${gap.version} publishes no ${kind.filePrefix}v${gap.series}.*.json attachment in its ${kind.module} module (found for other series: ${have}). ` +
    `${t.effect(` on ${gap.version} pages`)}, rather than being checked against another release's ${t.releaseNoun}. ` +
    `Generate it with ${t.generateSeries(gap.series)} on that branch, or leave ${t.macro} out of ${gap.version} content.`, kind.logger)
  return true
}

function editDistance (a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]
}

/**
 * "Did you mean" candidates, up to three: names sharing a prefix of at least
 * six characters with the fragment (the whole fragment when it is shorter),
 * the approach prop: uses for property names, then names within an edit
 * distance of a third of the fragment's length, which catches a word changed
 * in the middle (movement-cancel for move-cancel).
 */
function suggest (fragment, names) {
  const target = String(fragment).trim().toLowerCase()
  if (!target) return []
  const commonPrefix = (a, b) => {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return i
  }
  const unique = [...new Set(names.filter((name) => typeof name === 'string' && name))]
  const byPrefix = unique
    .map((candidate) => ({ candidate, shared: commonPrefix(candidate.toLowerCase(), target) }))
    .filter((scored) => scored.shared >= Math.min(6, target.length))
    .sort((a, b) => b.shared - a.shared || a.candidate.localeCompare(b.candidate))
    .map((scored) => scored.candidate)
  const limit = Math.floor(target.length / 3)
  const byDistance = unique
    .map((candidate) => ({ candidate, distance: editDistance(candidate.toLowerCase(), target) }))
    .filter((scored) => scored.distance > 0 && scored.distance <= limit)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .map((scored) => scored.candidate)
  return [...new Set([...byPrefix, ...byDistance])].slice(0, 3)
}

module.exports = {
  SURFACE_ALL,
  SURFACE_CLOUD,
  warnOnce,
  compareTags,
  isPrerelease,
  releaseSeries,
  isAttributeSet,
  componentAttributes,
  datasetsMatching,
  stableKey,
  newestDataset,
  orderedCandidates,
  describeDataset,
  readDataset,
  recordGap,
  loadDatasetFor,
  warnDatasetMissing,
  suggest,
  isPlainObject,
}
