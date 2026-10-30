'use strict'

/* doc-tools check-reference-values: check hand-written reference values and
 * references in a docs checkout against the published data, for three kinds:
 *
 *   properties  migrate-property-values' scan, unchanged (propval:).
 *   rpk         rpk commands and flags in shell blocks and prose, and flag
 *               defaults stated in prose (rpkval:). See rpk.js.
 *   connect     Connect components and fields in YAML, YAML comments that
 *               state a default, and field defaults stated in prose
 *               (connectval:). See connect.js.
 *
 * Data is selected exactly as the macros select it, from the repo and any
 * --lender checkouts read into one synthetic content catalog, unless
 * --data-file names it. One combined report; the exit code says whether any
 * finding is at or above --fail-on (1), or the check could not run (2).
 *
 * The rpk and Connect engines also report unlinked mentions (mentions.js):
 * the first mention of a command, component or Bloblang call on a page, as
 * it renders with its includes (page-order.js), that links it nowhere. Only --fail-on links fails on them, and only
 * --write-links, with --write, converts them.
 */

const fs = require('fs')
const path = require('path')
const migrate = require('../migrate-property-values')
const { DEFAULT_EXCLUDE } = require('../migrate-property-refs')
const { PROPERTIES_KIND, PROPERTIES_JSON_RX } = require('../../macros/prop')
const datasets = require('../../extension-utils/attachment-datasets')
const rpkValues = require('../../extension-utils/rpk-values')
const connectValues = require('../../extension-utils/connect-values')
const { scanRpk } = require('./rpk')
const { scanConnect } = require('./connect')
const connectLinks = require('./connect-links')
const { makeRenderGuard } = require('./render-check')
const shared = require('./shared')
const mentions = require('./mentions')
const oldNames = require('./names')
const { renderedPages } = require('./page-order')

const KINDS = ['properties', 'rpk', 'connect']
const LEVELS = ['none', 'mismatch', 'any', 'links']
const ALL_KINDS = [PROPERTIES_KIND, rpkValues.RPK_KIND, connectValues.CONNECT_KIND]
const HISTORICAL_CONNECT_RX = /(?:^|\/)migration\//

/**
 * A problem that stops the check from running: exit 2.
 */
class SetupError extends Error {}

const kindOfFile = (file) => {
  const base = path.basename(file)
  if (PROPERTIES_JSON_RX.test(base)) return { name: 'properties', kind: PROPERTIES_KIND, tag: base.match(PROPERTIES_JSON_RX)[1] }
  if (rpkValues.RPK_JSON_RX.test(base)) return { name: 'rpk', kind: rpkValues.RPK_KIND, tag: base.match(rpkValues.RPK_JSON_RX)[1] }
  if (connectValues.CONNECT_JSON_RX.test(base)) return { name: 'connect', kind: connectValues.CONNECT_KIND, tag: base.match(connectValues.CONNECT_JSON_RX)[1] }
  return undefined
}

function readExplicit (file, own) {
  const found = kindOfFile(file)
  if (!found) throw new SetupError(`--data-file ${file}: the name matches no dataset kind (redpanda-properties-v<tag>.json, rpk-v<version>.json, connect-<version>.json)`)
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new SetupError(`--data-file ${file}: ${error.code === 'ENOENT' ? 'no such file' : `not valid JSON (${error.message})`}`)
  }
  const verdict = datasets.isPlainObject(data) ? found.kind.validate(data) : found.kind.notObjectReason
  if (verdict !== true) throw new SetupError(`--data-file ${file}: ${verdict}`)
  const cloud = found.kind.borrowWhen.some((name) => datasets.isAttributeSet(own.attributes[name]))
  const registry = {
    tag: found.tag,
    data,
    component: own.component,
    version: own.version,
    surface: cloud ? datasets.SURFACE_CLOUD : datasets.SURFACE_ALL,
    kind: found.kind,
    explicit: file,
  }
  if (found.kind.decorate) found.kind.decorate(registry)
  return { name: found.name, registry, file }
}

/**
 * The rpk reference pages of a checkout, as page entries in the synthetic
 * catalog, so rpk links resolve against the pages the build would have, and
 * the page-aliases they declare, which Antora resolves an xref through.
 *
 * @returns {{pages: object[], aliases: {component: string, version: string, relative: string, target: string}[]}}
 */
function rpkPages (dir, comp) {
  const root = path.join(dir, 'modules', 'reference', 'pages')
  const pages = []
  const aliases = []
  for (const file of shared.walkFiles(dir, { root: path.join('modules', 'reference', 'pages', 'rpk') })) {
    const relative = path.relative(root, path.join(dir, file)).split(path.sep).join('/')
    pages.push({ src: { component: comp.component, version: comp.version, module: 'reference', family: 'page', relative } })
    const header = fs.readFileSync(path.join(dir, file), 'utf8').split('\n', 30).find((line) => /^:page-aliases:/.test(line))
    if (!header) continue
    for (const alias of header.replace(/^:page-aliases:/, '').split(',').map((a) => a.trim()).filter(Boolean)) {
      // reference:rpk/rpk-acl.adoc, or rpk/rpk-acl.adoc within the module.
      const parts = alias.split(':')
      if (parts.length > 2 || (parts.length === 2 && parts[0] !== 'reference')) continue
      aliases.push({ component: comp.component, version: comp.version, relative: parts[parts.length - 1], target: relative })
    }
  }
  return { pages, aliases }
}

/**
 * The nav files antora.yml lists: generated from the command tree, not prose.
 */
function navFiles (dir) {
  try {
    const descriptor = require('js-yaml').load(fs.readFileSync(path.join(dir, 'antora.yml'), 'utf8')) || {}
    return new Set((descriptor.nav || []).map((file) => path.normalize(String(file))))
  } catch (error) {
    return new Set()
  }
}

/**
 * A finding's kind of file: historical findings are reported, never fail and
 * are never written.
 */
function isHistorical (kind, file) {
  return migrate.HISTORICAL_RX.test(file) || (kind !== 'properties' && shared.RELEASES_RX.test(file)) || (kind === 'connect' && HISTORICAL_CONNECT_RX.test(file))
}

/**
 * Whether a finding fails the check at a level.
 */
function failsAt (kind, f, level) {
  if (level === 'none') return false
  if (f.applied) return false
  if (isHistorical(kind, f.file)) return false
  // A mention that could be a link fails only when links are asked for.
  if (f.status === mentions.STATUS) return level === 'links'
  if (f.status === 'mismatch') return true
  if (f.status === 'reference' && f.severity === 'error') return true
  if (f.status === 'example-output' && f.verdict === 'stale' && kind !== 'properties') return true
  if (level !== 'any' && level !== 'links') return false
  // An alias renders and links correctly, so it fails only when every
  // finding is asked for, as a deprecated name does.
  if (f.status === oldNames.STATUS) return true
  if (['exact', 'equivalent', 'unset'].includes(f.status)) return true
  if (f.status === 'reference' && f.severity === 'warning') return true
  return false
}

/**
 * Every failing finding of a result at a level, as {kind, finding}.
 */
function failingFindings (result, level) {
  const out = []
  for (const [kind, r] of Object.entries(result.kinds)) {
    for (const f of r.findings || []) if (failsAt(kind, f, level)) out.push({ kind, finding: f })
  }
  return out
}

/**
 * Drop the findings a `// value-check: ignore` comment suppresses.
 *
 * @returns {number} how many were dropped.
 */
function applyIgnores (result, docsDir) {
  const cache = new Map()
  const ignored = (file, line) => {
    if (!cache.has(file)) {
      const full = path.join(docsDir, file)
      cache.set(file, fs.existsSync(full) ? shared.ignoredLines(fs.readFileSync(full, 'utf8')) : new Set())
    }
    return cache.get(file).has(line)
  }
  let count = 0
  for (const r of Object.values(result.kinds)) {
    if (!Array.isArray(r.findings)) continue
    const kept = r.findings.filter((f) => !ignored(f.file, f.line))
    count += r.findings.length - kept.length
    if (kept.length !== r.findings.length) {
      r.findings = kept
      r.counts = recount(r)
    }
  }
  return count
}

/**
 * Remember every page that has a `// value-check: ignore` comment. The
 * returned function restores the lines the comments cover, in pages written
 * since, and returns how many pages are back to unchanged.
 */
function keepIgnoredLines (docsDir, files) {
  const before = []
  for (const relative of shared.walkFiles(docsDir, { exclude: DEFAULT_EXCLUDE, only: files })) {
    const full = path.join(docsDir, relative)
    const content = fs.readFileSync(full, 'utf8')
    const lines = shared.ignoredLines(content)
    if (lines.size) before.push({ full, content, lines })
  }
  return () => {
    let unchanged = 0
    for (const { full, content, lines } of before) {
      const now = fs.readFileSync(full, 'utf8')
      if (now === content) continue
      const was = content.split('\n')
      const out = now.split('\n')
      // Replacements stay within a line; anything else restores the page.
      const restored = out.length === was.length ? out.map((line, i) => (lines.has(i + 1) ? was[i] : line)).join('\n') : content
      if (restored === now) continue
      fs.writeFileSync(full, restored)
      if (restored === content) unchanged++
    }
    return unchanged
  }
}

// Counts after findings were dropped, in each kind's own shape.
function recount (r) {
  if (r.counts && Object.prototype.hasOwnProperty.call(r.counts, 'referenceErrors')) {
    const extra = {}
    for (const key of ['examplesRestatingDefault', 'yamlRestatingDefault']) if (key in r.counts) extra[key] = r.counts[key]
    const links = 'linksBroken' in r.counts ? { ...require('./rpk').linkCounts(r.findings), ...mentions.mentionCounts(r.findings) } : {}
    return { ...require('./rpk').countFindings(r.findings), ...extra, ...links, ...oldNames.nameCounts(r.findings) }
  }
  const counts = { exact: 0, equivalent: 0, mismatch: 0, unset: 0, unverifiable: 0, autoSafe: 0, 'example-output': 0, exampleStale: 0 }
  for (const f of r.findings) {
    counts[f.status]++
    if (f.autoSafe) counts.autoSafe++
    if (f.verdict === 'stale') counts.exampleStale++
  }
  return counts
}

/**
 * Run every requested kind over one checkout.
 *
 * @param {object} opts
 * @param {string} opts.docsDir
 * @param {string[]} [opts.lenderDirs]
 * @param {string[]} [opts.dataFiles]
 * @param {string[]} [opts.kinds] - Default: all three.
 * @param {boolean} [opts.kindsExplicit] - The caller named the kinds: missing
 *   data for one is a setup error, not a skip.
 * @param {string[]} [opts.files]
 * @param {boolean} [opts.write]
 * @param {boolean} [opts.writeLinks] - With write, also turn unlinked
 *   mentions into rpkcmd:, connect: and blobl: links.
 * @param {string} [opts.failOn]
 */
function scanAll ({ docsDir, lenderDirs = [], dataFiles = [], kinds = KINDS, kindsExplicit = false, files, write = false, writeLinks = false, failOn = 'mismatch' }) {
  if (!LEVELS.includes(failOn)) throw new SetupError(`--fail-on ${failOn}: use one of ${LEVELS.join(', ')}`)
  if (writeLinks && !write) throw new SetupError('--write-links converts unlinked mentions only with --write')
  for (const kind of kinds) if (!KINDS.includes(kind)) throw new SetupError(`--kinds: '${kind}' is not a kind; use ${KINDS.join(', ')}`)
  if (!fs.existsSync(path.join(docsDir, 'antora.yml'))) throw new SetupError(`--docs-dir ${docsDir}: no antora.yml`)
  for (const dir of lenderDirs) if (!fs.existsSync(path.join(dir, 'antora.yml'))) throw new SetupError(`--lender ${dir}: no antora.yml`)
  let own
  try {
    own = migrate.readComponent(docsDir, ALL_KINDS)
  } catch (error) {
    throw new SetupError(`--docs-dir ${docsDir}: ${error.message}`)
  }
  const lenders = lenderDirs.map((dir) => migrate.readComponent(dir, ALL_KINDS))
  const pageAliases = new Map()
  ;[[docsDir, own], ...lenderDirs.map((dir, i) => [dir, lenders[i]])].forEach(([dir, comp]) => {
    const { pages, aliases } = rpkPages(dir, comp)
    comp.files.push(...pages)
    for (const a of aliases) pageAliases.set(`${a.component}@${a.version}:${a.relative}`, a.target)
  })
  // Every other page and page alias, so Connect links resolve as Antora
  // resolves them.
  const comps = [own, ...lenders]
  const latest = (name) => {
    const found = comps.find((c) => c.component === name)
    return found ? found.version : undefined
  }
  ;[[docsDir, own], ...lenderDirs.map((dir, i) => [dir, lenders[i]])].forEach(([dir, comp]) => {
    const seen = new Set(comp.files.filter((f) => f.src.family === 'page').map((f) => `${f.src.version}@${f.src.component}:${f.src.module}:${f.src.relative}`))
    comp.files.push(...connectLinks.pageEntries(dir, comp, { latest, seen }))
  })
  const catalog = migrate.catalogFor(comps)
  const explicit = {}
  for (const file of dataFiles) {
    const read = readExplicit(file, own)
    explicit[read.name] = read
  }

  // The catalog the render guard renders against: the scan's, plus the
  // explicit files as attachments where the macros would look for them.
  const renderCatalog = () => {
    const extra = Object.values(explicit).map(({ registry, file }) => {
      const kind = registry.kind
      const cloud = registry.surface === datasets.SURFACE_CLOUD
      const component = kind === connectValues.CONNECT_KIND ? 'connect' : cloud ? 'streaming' : own.component
      const version = kind === connectValues.CONNECT_KIND ? '' : cloud ? (datasets.releaseSeries(registry.tag) || '') : own.version
      const base = kind === connectValues.CONNECT_KIND ? `connect-${registry.tag}.json` : `${kind.filePrefix}${registry.tag}.json`
      return { component, version, attributes: {}, files: [{ src: { component, version, module: kind.module, family: 'attachment', relative: base }, contents: fs.readFileSync(file) }] }
    })
    return migrate.catalogFor([own, ...lenders, ...extra])
  }
  const guard = write ? makeRenderGuard({ catalog: renderCatalog(), component: own.component, version: own.version }) : undefined

  const result = {
    schema: 1,
    docsDir,
    component: own.component,
    version: own.version,
    failOn,
    kinds: {},
    skipped: {},
    ignored: 0,
    failing: 0,
  }
  const skip = (kind, why) => {
    if (kindsExplicit) throw new SetupError(`--kinds ${kind}: ${why}`)
    result.skipped[kind] = why
  }
  const where = `${own.component}@${own.version || 'unversioned'}`
  // The pages of the scan and its lenders in rendered order, for the
  // unlinked-mention check, read once for both engines.
  let rendered
  const pages = () => rendered || (rendered = renderedPages({ repos: [{ dir: docsDir, comp: own }, ...lenderDirs.map((dir, i) => ({ dir, comp: lenders[i] }))] }))

  if (kinds.includes('properties')) {
    const given = explicit.properties && explicit.properties.registry
    const registry = given || datasets.loadDatasetFor(catalog, own.component, own.version, PROPERTIES_KIND)
    if (!registry) skip('properties', `no property data for ${where}`)
    else {
      // The property engine writes without knowing about // value-check:
      // ignore, so put back the lines it covers afterwards.
      const kept = write ? keepIgnoredLines(docsDir, files) : undefined
      const r = migrate.scanRepo({ docsDir, lenderDirs, write, files, registry: given })
      if (r.error) skip('properties', r.error)
      else {
        if (kept) r.changedFiles -= kept()
        // Every auto-safe property finding is replaced when writing.
        if (write) for (const f of r.findings) if (f.autoSafe) f.applied = true
        result.kinds.properties = { ...r, selection: given ? 'explicit' : registry.surface === datasets.SURFACE_CLOUD ? 'cloud' : 'page' }
      }
    }
  }

  if (kinds.includes('rpk')) {
    const given = explicit.rpk && explicit.rpk.registry
    const registry = given || rpkValues.loadRpkFor(catalog, own.component, own.version)
    if (!registry) skip('rpk', `no rpk data for ${where}: no rpk-<version>.json attachment selects for it; pass --data-file docs-data/rpk-v<version>.json`)
    else {
      const cloudLenders = lenders.filter((l) => datasets.isAttributeSet(l.attributes['env-cloud']))
      const links = {
        catalog,
        component: own.component,
        version: own.version,
        skip: navFiles(docsDir),
        aliases: pageAliases,
        pages: pages(),
        cloud: cloudLenders.length === 1 ? { component: cloudLenders[0].component, version: cloudLenders[0].version } : undefined,
      }
      const r = scanRpk({ docsDir, registry, files, write, writeLinks, renderGuard: guard, links })
      result.kinds.rpk = {
        dataset: given ? `${path.basename(given.explicit)} (--data-file)` : datasets.describeDataset(registry),
        selection: given ? 'explicit' : registry.surface === datasets.SURFACE_CLOUD ? 'cloud' : 'page',
        surface: registry.surface,
        rpkVersion: registry.data.rpk_version || registry.tag,
        pluginVersions: registry.data.plugin_versions || {},
        scraped: rpkValues.KNOWN_PLUGINS.filter((p) => rpkValues.isScraped(registry, [p])),
        ...r,
      }
    }
  }

  if (kinds.includes('connect')) {
    const given = explicit.connect && explicit.connect.registry
    const registry = given || connectValues.loadConnect(catalog)
    if (!registry) skip('connect', 'no connect-<version>.json in connect:components attachments; pass --lender with an rp-connect-docs checkout, or --data-file')
    else {
      const cloudSurface = datasets.isAttributeSet(own.attributes['env-cloud'])
      const links = {
        catalog,
        component: own.component,
        version: own.version,
        skip: navFiles(docsDir),
        pages: pages(),
        surfacesOf: connectLinks.renderingSurfaces({ docsDir, own, lenders: lenderDirs.map((dir, i) => ({ dir, comp: lenders[i] })) }),
        // --data-file checks the links, but connect: and blobl: link only
        // with the build's own Connect data.
        buildHasData: Boolean(connectValues.loadConnect(catalog)),
      }
      const r = scanConnect({ docsDir, registry, files, write, writeLinks, cloudSurface, renderGuard: guard, component: own.component, links })
      result.kinds.connect = {
        dataset: given ? `${path.basename(given.explicit)} (--data-file)` : datasets.describeDataset(registry),
        selection: given ? 'explicit' : 'fixed',
        surface: cloudSurface ? datasets.SURFACE_CLOUD : datasets.SURFACE_ALL,
        cloudSource: 'json',
        ...r,
      }
    }
  }

  if (!Object.keys(result.kinds).length) throw new SetupError(`no kind has data for ${where}: ${Object.entries(result.skipped).map(([k, v]) => `${k}: ${v}`).join('; ')}`)
  result.ignored = applyIgnores(result, docsDir)
  for (const [kind, r] of Object.entries(result.kinds)) {
    for (const f of r.findings) f.failing = failsAt(kind, f, failOn)
  }
  result.failing = failingFindings(result, failOn).length
  return result
}

const { mdEscape } = migrate

// One line describing a failing finding, for the console and annotations.
function describe (kind, f) {
  if (kind === 'properties') {
    if (f.status === 'mismatch') return `${f.property} ${f.field}: written ${f.written}, data ${f.dataValue}`
    return `${f.property} ${f.field}: ${f.status}${f.note ? ` (${f.note})` : ''}`
  }
  const what = f.target || (kind === 'rpk' ? `${f.command || 'rpk'}${f.flag ? ` --${f.flag}` : ''}` : `${f.componentType || ''}/${f.component || ''}${f.fieldPath ? ` ${f.fieldPath}` : ''}`)
  if (f.status === 'reference' || f.status === oldNames.STATUS) return `${f.check === 'name' ? f.written : what}: ${f.reason}${f.note ? `: ${f.note}` : ''}${f.proposed ? `; ${f.applied ? 'applied' : f.writable ? '--write writes' : 'proposed'} ${f.proposed}` : ''}`
  if (f.status === mentions.STATUS) return `${f.written}: ${f.mention} with no link on the page${f.proposed ? `; ${f.proposed} links ${f.dataValue}` : ''}`
  if (f.status === 'example-output') return `${what}: comment says ${f.written}, data ${f.dataValue}`
  return `${what}: written ${f.written}, data ${f.dataValue}`
}

/**
 * Render the combined report as Markdown.
 */
function renderMarkdown (result) {
  const out = ['# Reference values report', '']
  out.push('Statuses: **reference** is a command, flag, component or field that does not exist in the data (error) or is deprecated (warning), or an xref to an rpk, Connect component or Bloblang page or anchor that does not exist (broken-link, error) or whose label names something else (link-label-mismatch, warning). **exact** is what the macro renders, or an xref rpkcmd:[...], connect:[...] or blobl:[...] would render the same; **auto-safe** is an exact match `--write` may apply. **equivalent** is the same value worded differently. **mismatch** differs from the data. **unset** states a value the data leaves empty. **unverifiable** could not be compared, with the reason. **example output** is a value in a block or YAML comment, never written: **stale** when it differs from the data. **unlinked mention** is the first mention on a page of an rpk command, Connect component or Bloblang call in inline code, on a page that links it nowhere, which rpkcmd:[...], connect:[...] or blobl:[...] would link; it fails only at --fail-on links, and --write converts it only with --write-links. **alias** is an rpk command written with an alias, or a Connect component written with the name its page now aliases, in a macro or a prose span: it renders and links correctly, fails only at --fail-on any or links, and `--write` rewrites it to the main name when it is writable, as it rewrites a deprecated name whose data names one replacement.', '')
  out.push(`Checked ${result.component}@${result.version || 'unversioned'} at --fail-on ${result.failOn}: ${result.failing} failing finding(s), ${result.ignored} ignored by \`// value-check: ignore\`.`, '')
  out.push('| Kind | Dataset | Surface | Files | Findings | Failing | Reference errors | Reference warnings | Mismatch | Exact (auto-safe) | Equivalent | Unset | Unverifiable | Example output (stale) | Unlinked mentions | Aliases |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const [kind, r] of Object.entries(result.kinds)) {
    const c = r.counts || {}
    out.push(`| ${kind} | ${mdEscape(r.dataset)} | ${r.surface} | ${r.files} | ${r.findings.length} | ${r.findings.filter((f) => f.failing).length} | ${c.referenceErrors || 0} | ${c.referenceWarnings || 0} | ${c.mismatch || 0} | ${c.exact || 0} (${c.autoSafe || 0}) | ${c.equivalent || 0} | ${c.unset || 0} | ${c.unverifiable || 0} | ${c['example-output'] || 0} (${c.exampleStale || 0}) | ${c.unlinkedMentions || 0} | ${c.aliases || 0} |`)
  }
  for (const [kind, why] of Object.entries(result.skipped)) out.push(`| ${kind} | skipped: ${mdEscape(why)} | | | | | | | | | | | | | | |`)

  const failing = failingFindings(result, result.failOn)
  out.push('', `## Failing (${failing.length})`, '')
  if (failing.length) {
    out.push('| File:line | Kind | Status | Finding |', '|---|---|---|---|')
    for (const { kind, finding: f } of failing) out.push(`| ${mdEscape(`${f.file}:${f.line}`)} | ${kind} | ${f.status}${f.reason ? ` (${f.reason})` : ''}${f.verdict ? ` ${f.verdict}` : ''} | ${mdEscape(describe(kind, f))} |`)
  } else out.push('None.')

  for (const [kind, r] of Object.entries(result.kinds)) {
    out.push('', `## ${kind}`, '')
    if (kind === 'properties') {
      // The property section is migrate-property-values' own report body.
      const body = migrate.renderMarkdown([{ ...r, label: `${r.component}@${r.version || 'unversioned'}` }], { title: 'x' })
      out.push(body.split('\n').slice(2).join('\n').replace(/^## /gm, '### '))
      continue
    }
    if (r.counts && 'linksBroken' in r.counts) {
      const c = r.counts
      out.push(kind === 'connect'
        ? `Links to Connect component and Bloblang pages: ${c.linksBroken} broken, ${c.linksMislabeled} with a label naming another component, field, function or method, ${c.linksReplaceable} replaceable with connect:[...] or blobl:[...] (listed under Exact), ${c.linksNotLoaded} not checked (not rendered by, or not in, this scan).`
        : `Links to rpk reference pages: ${c.linksBroken} broken, ${c.linksMislabeled} with a label naming another command, ${c.linksReplaceable} replaceable with rpkcmd:[...] (listed under Exact), ${c.linksNotLoaded} to a component this scan did not read.`, '')
    }
    const refs = r.findings.filter((f) => f.status === 'reference')
    const errors = refs.filter((f) => f.severity === 'error')
    const warnings = refs.filter((f) => f.severity === 'warning')
    out.push(`### Reference problems (${errors.length} errors, ${warnings.length} warnings)`, '')
    if (refs.length) {
      out.push('| File:line | Severity | Reason | Where | Note |', '|---|---|---|---|---|')
      for (const f of [...errors, ...warnings]) {
        const where = f.check === 'name' ? f.written : kind === 'rpk' ? `${f.command || ''}${f.token ? ` ${f.token}` : ''}` : `${f.componentType || ''}/${f.component || ''}${f.fieldPath ? ` ${f.fieldPath}` : ''}`
        const proposal = f.proposed ? `; ${f.applied ? 'applied' : f.writable ? '--write writes' : 'proposed'} \`${f.proposed}\`` : ''
        out.push(`| ${mdEscape(`${f.file}:${f.line}`)} | ${f.severity} | ${f.reason} | ${mdEscape(where)} | ${mdEscape(`${f.note || ''}${proposal}`)} |`)
      }
    } else out.push('None.')
    const aliases = r.findings.filter((f) => f.status === oldNames.STATUS)
    out.push('', `### Aliases and former names (${aliases.length}, ${aliases.filter((f) => f.writable || f.applied).length} writable)`, '')
    if (aliases.length) {
      out.push('| File:line | Written | Main name | Proposed |', '|---|---|---|---|')
      for (const f of aliases) out.push(`| ${mdEscape(`${f.file}:${f.line}`)} | ${mdEscape(f.written)} | ${mdEscape(f.command || (f.componentType ? `${f.componentType}/${f.component}` : ''))} | ${f.applied ? 'applied: ' : ''}${f.proposed ? `\`${mdEscape(f.proposed)}\`` : ''}${f.writable || f.applied ? '' : ` (not written: ${mdEscape(f.note)})`} |`)
    } else out.push('None.')
    const section = (title, list, cols) => {
      out.push('', `### ${title} (${list.length})`, '')
      if (!list.length) { out.push('None.'); return }
      out.push(`| File:line | Target | Written | Data | ${cols.join(' | ')} |`, `|---|---|---|---|${cols.map(() => '---|').join('')}`)
      for (const f of list) out.push(`| ${mdEscape(`${f.file}:${f.line}`)} | \`${mdEscape(f.target || '')}\` | ${mdEscape(f.written)} | ${mdEscape(f.dataValue)} | ${cols.map((c) => mdEscape(c === 'Auto-safe' ? (f.autoSafe ? 'yes' : 'no') : c === 'Tied to' ? f.association : f.note)).join(' | ')} |`)
    }
    section('Mismatches', r.findings.filter((f) => f.status === 'mismatch'), ['Tied to', 'Note'])
    section('Not set in the data', r.findings.filter((f) => f.status === 'unset'), ['Note'])
    const exact = r.findings.filter((f) => f.status === 'exact')
    section(`Exact, ${exact.filter((f) => f.autoSafe).length} auto-safe`, exact, ['Auto-safe', 'Note'])
    section('Equivalent, proposed and never applied', r.findings.filter((f) => f.status === 'equivalent'), ['Tied to'])
    const unverifiable = r.findings.filter((f) => f.status === 'unverifiable')
    out.push('', `### Unverifiable (${unverifiable.length})`, '')
    const byReason = {}
    for (const f of unverifiable) byReason[f.reason] = (byReason[f.reason] || 0) + 1
    out.push(Object.keys(byReason).length ? Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `* ${k}: ${v}`).join('\n') : 'None.')
    const helpDefaults = unverifiable.filter((f) => f.reason === 'plugin-help-default')
    if (helpDefaults.length) {
      out.push('', 'Plugin flags whose --help default differs from the prose (listed for a human; the --help scrape is not reliable enough to fail on):', '')
      for (const f of helpDefaults) out.push(`* ${mdEscape(`${f.file}:${f.line}`)} \`${mdEscape(f.target)}\`: written ${mdEscape(f.written)}, --help ${mdEscape(f.dataValue)}`)
    }
    const unlinked = r.findings.filter((f) => f.status === mentions.STATUS)
    const byKind = Object.entries((r.counts && r.counts.unlinkedMentionsByKind) || {}).map(([k, n]) => `${n} ${k}`).join(', ')
    out.push('', `### Unlinked mentions (${unlinked.length}${byKind ? `: ${byKind}` : ''})`, '')
    if (unlinked.length) {
      out.push('| File:line | Mention | Written | Links | Proposed |', '|---|---|---|---|---|')
      for (const f of unlinked) out.push(`| ${mdEscape(`${f.file}:${f.line}`)} | ${f.mention} | ${mdEscape(f.written)} | ${mdEscape(f.dataValue)} | ${f.applied ? 'applied: ' : ''}${f.proposed ? `\`${mdEscape(f.proposed)}\`` : mdEscape(f.note || '')} |`)
    } else out.push('None.')
    const examples = r.findings.filter((f) => f.status === 'example-output')
    out.push('', `### Example output (${examples.length}: ${examples.filter((f) => f.verdict === 'stale').length} stale, ${examples.filter((f) => f.verdict === 'matches').length} matching)`, '')
    const stale = examples.filter((f) => f.verdict === 'stale')
    if (stale.length) {
      out.push('| File:line | Target | Shown | Default |', '|---|---|---|---|')
      for (const f of stale) out.push(`| ${mdEscape(`${f.file}:${f.line}`)} | \`${mdEscape(f.target || '')}\` | ${mdEscape(f.written)} | ${mdEscape(f.dataValue)} |`)
    } else out.push('None stale.')
  }
  return out.join('\n') + '\n'
}

/**
 * GitHub workflow commands: ::error for each failing finding, ::warning for
 * each reference warning that does not fail.
 */
function annotations (result) {
  const lines = []
  const clean = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  for (const [kind, r] of Object.entries(result.kinds)) {
    for (const f of r.findings) {
      if (f.failing) lines.push(`::error file=${f.file},line=${f.line}::${clean(`${kind} ${f.status}: ${describe(kind, f)}`)}`)
      else if ((f.status === 'reference' && f.severity === 'warning') || f.status === oldNames.STATUS) lines.push(`::warning file=${f.file},line=${f.line}::${clean(`${kind} ${f.reason}: ${describe(kind, f)}`)}`)
    }
  }
  return lines
}

/**
 * The CLI action. Returns the exit code.
 */
function runCli (options, { log = console.log, error = console.error } = {}) {
  const docsDir = path.resolve(options.docsDir || '.')
  const kindsExplicit = options.kinds !== undefined
  const kinds = kindsExplicit ? String(options.kinds).split(',').map((k) => k.trim()).filter(Boolean) : KINDS
  if (options.annotations !== undefined && options.annotations !== 'github') {
    error(`Error: --annotations ${options.annotations}: the only format is github`)
    return 2
  }
  let result
  try {
    if (options.write) {
      // The render guard converts lines through the real macros, which log
      // every placeholder; those are expected while guarding.
      require('@antora/logger').configure({ level: 'silent' })
    }
    result = scanAll({
      docsDir,
      lenderDirs: (options.lender || []).map((dir) => path.resolve(dir)),
      dataFiles: (options.dataFile || []).map((file) => path.resolve(file)),
      kinds,
      kindsExplicit,
      files: options.files,
      write: Boolean(options.write),
      writeLinks: Boolean(options.writeLinks),
      failOn: options.failOn || 'mismatch',
    })
  } catch (e) {
    if (e instanceof SetupError) {
      error(`Error: ${e.message}`)
      return 2
    }
    throw e
  }
  const reportDir = path.resolve(options.reportDir || '.')
  fs.mkdirSync(reportDir, { recursive: true })
  const jsonPath = path.join(reportDir, 'reference-values-report.json')
  const mdPath = path.join(reportDir, 'reference-values-report.md')
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n')
  fs.writeFileSync(mdPath, renderMarkdown(result))
  for (const [kind, r] of Object.entries(result.kinds)) {
    const c = r.counts
    const refs = kind === 'properties' ? '' : `${c.referenceErrors} reference error(s), ${c.referenceWarnings} warning(s), `
    log(`${kind}: ${r.dataset} (${r.surface}), ${r.files} files: ${refs}${c.mismatch} mismatch, ${c.unset} unset, ${c.exact} exact (${c.autoSafe} auto-safe), ${c.equivalent} equivalent, ${c.unverifiable} unverifiable, ${c['example-output'] || 0} example output (${c.exampleStale || 0} stale).`)
    if ('linksBroken' in c) log(`${kind} links: ${c.linksBroken} broken, ${c.linksMislabeled} mislabeled, ${c.linksReplaceable} replaceable with ${kind === 'connect' ? 'connect:[...] or blobl:[...]' : 'rpkcmd:[...]'}, ${c.linksNotLoaded} not checked (${kind === 'connect' ? 'not rendered by, or not in, this scan' : 'component not loaded'}).`)
    if ('aliases' in c) log(`${kind} old names: ${c.aliases} alias(es), ${c.deprecatedNames} deprecated name(s) in macros and prose spans, ${c.namesWritable} writable${options.write ? `, ${c.namesApplied} rewritten` : ''}.`)
    if ('unlinkedMentions' in c) log(`${kind} unlinked mentions: ${c.unlinkedMentions}${Object.keys(c.unlinkedMentionsByKind).length ? ` (${Object.entries(c.unlinkedMentionsByKind).map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}.`)
  }
  for (const [kind, why] of Object.entries(result.skipped)) log(`${kind}: skipped (${why})`)
  if (result.ignored) log(`${result.ignored} finding(s) ignored by // value-check: ignore.`)
  for (const { kind, finding: f } of failingFindings(result, result.failOn)) {
    log(`  ${f.status === 'reference' ? f.reason.toUpperCase() : f.status.toUpperCase()} ${f.file}:${f.line} ${kind} ${describe(kind, f)}`)
  }
  if (options.annotations === 'github') for (const line of annotations(result)) log(line)
  if (options.write) {
    const changed = Object.values(result.kinds).reduce((n, r) => n + (r.changedFiles || 0), 0)
    log(`Replaced auto-safe exact matches and writable old names${options.writeLinks ? ' and linked unlinked mentions' : ''} in ${changed} file(s).`)
  }
  log(`Report: ${mdPath}`)
  log(`check (${result.failOn}): ${result.failing} failing finding(s)`)
  return result.failing > 0 ? 1 : 0
}

module.exports = {
  scanAll,
  renderMarkdown,
  failingFindings,
  applyIgnores,
  annotations,
  runCli,
  failsAt,
  SetupError,
  KINDS,
  LEVELS,
}
