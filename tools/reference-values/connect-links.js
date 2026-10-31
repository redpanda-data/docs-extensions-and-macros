'use strict'

/* Connect links in check-reference-values: hand-written xrefs to Connect
 * component pages, their field anchors, and the Bloblang function and method
 * anchors, judged against the links connect: and blobl: make
 * (extension-utils/connect-links.js).
 *
 * A file is judged on every surface that renders it: its own component for a
 * page, or for a partial that one of its pages includes, and each --lender
 * component that includes it (a cloud-docs stub that includes an
 * rp-connect-docs page). An xref with no component resolves in the rendering
 * page's component, so the same xref can work in one and break in another.
 * A line in ifndef::env-cloud[] is judged off Cloud only, and one in
 * ifdef::env-cloud[] on Cloud only. An include with tag= or tags= renders
 * only the lines in those tag regions, and an include line in an env-cloud
 * conditional only on the surfaces the conditional keeps.
 *
 * A scan of connect with no Cloud lender cannot say whether Cloud renders a
 * line of a partial or of a page's single-source tag region. Its links are
 * link-target-not-loaded, never exact, until the scan has the cloud-docs
 * checkout.
 *
 *   broken-link (reference error): the page does not exist on a surface, or
 *   the anchor is not on the page there (a deprecated field, an impure
 *   function on Cloud, a numbered parameters-N heading).
 *   link-label-mismatch (reference warning): the label's backticked name is
 *   another component, type, field, function or method than the target.
 *   A name the target page declares as a page alias (pg_stream on the
 *   postgres_cdc page) is the same component.
 *   exact: the label is just the name, and on every surface the target is
 *   the page and anchor the macro links, so --write may replace the xref
 *   with connect:[...] or blobl:[...].
 *   link-target-not-loaded (unverifiable): no surface in this scan renders
 *   the line, Cloud may render it and the scan has no Cloud checkout, or the
 *   target is in a component the scan did not read.
 */

const fs = require('fs')
const path = require('path')
const connectLinks = require('../../extension-utils/connect-links')
const connectValues = require('../../extension-utils/connect-values')
const bloblang = require('../../extension-utils/bloblang-values')
const { normalizeType } = require('../../extensions/util/connect-catalog')
const shared = require('./shared')
const { xrefPage } = require('./rpk')
const { CONDITIONAL_RX, conditionOf } = require('../migrate-property-values')

const XREF_RX = /xref:([^\s[\]]+)\[((?:\\\]|[^\]])*)\]/g

// ---------------------------------------------------------------------------
// Pages, aliases and the surfaces that render a file

/**
 * Every page of a checkout as a catalog entry, with its abspath so the page
 * source can be read, and its page-aliases as alias entries.
 *
 * @param {(component: string) => string|undefined} latest - The latest
 *   version of a component named in an alias.
 * @param {Set<string>} [seen] - Pages already in the catalog.
 */
function pageEntries (dir, comp, { latest = () => undefined, seen = new Set() } = {}) {
  const out = []
  for (const file of shared.walkFiles(dir)) {
    const posix = file.split(path.sep).join('/')
    const m = posix.match(/^modules\/([^/]+)\/pages\/(.+\.adoc)$/)
    if (!m) continue
    const src = { component: comp.component, version: comp.version, module: m[1], family: 'page', relative: m[2], abspath: path.join(dir, file) }
    const key = `${src.version}@${src.component}:${src.module}:${src.relative}`
    if (seen.has(key)) continue
    seen.add(key)
    const page = { src }
    out.push(page)
    let header
    try {
      header = fs.readFileSync(src.abspath, 'utf8').split('\n', 40).find((line) => /^:page-aliases:/.test(line))
    } catch (error) {
      continue
    }
    if (!header) continue
    for (const alias of header.replace(/^:page-aliases:/, '').split(',').map((a) => a.trim()).filter(Boolean)) {
      let rest = alias
      let version
      const at = rest.indexOf('@')
      if (at !== -1) { version = rest.slice(0, at); rest = rest.slice(at + 1) }
      const parts = rest.split(':')
      if (parts.length > 3) continue
      const relative = parts.pop()
      const module = parts.pop() || src.module
      const component = parts.pop() || src.component
      if (version === undefined) version = component === src.component ? src.version : latest(component)
      if (version === undefined) continue
      out.push({ src: { component, version, module, family: 'alias', relative: relative.endsWith('.adoc') ? relative : `${relative}.adoc` }, rel: page })
    }
  }
  return out
}

const INCLUDE_RX = /^include::([^[\s]+)\[([^\]]*)\]\s*$/gm

/**
 * Where an include target lands in a component, as a file relative to its
 * checkout, or undefined for another component, an example or a path the
 * scan cannot follow.
 */
function includeTarget (target, { fromFile, component }) {
  const fromModule = (fromFile.match(/^modules\/([^/]+)\//) || [])[1]
  let rest = target
  const at = rest.indexOf('@')
  if (at !== -1) rest = rest.slice(at + 1)
  const family = rest.match(/(partial|example|page)\$/)
  const [spec, file] = family ? [rest.slice(0, family.index), rest.slice(family.index + family[0].length)] : [rest, undefined]
  if (!family) {
    // A page by resource ID (connect:components:inputs/x.adoc), or a path.
    const parts = rest.split(':')
    if (parts.length === 1) return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), rest))
    const relative = parts.pop()
    const module = parts.pop()
    const comp = parts.pop()
    if (comp !== undefined && comp !== component) return undefined
    return `modules/${module}/pages/${relative}`
  }
  if (family[1] === 'example') return undefined
  const parts = spec.split(':').filter((p) => p !== '')
  const module = parts.length ? parts.pop() : fromModule
  const comp = parts.length ? parts.pop() : undefined
  if (comp !== undefined && comp !== component) return undefined
  return `modules/${module}/${family[1] === 'partial' ? 'partials' : 'pages'}/${file}`
}

/**
 * The include lines of a file: target, attributes, line index, and the
 * surfaces an env-cloud conditional around the line keeps (cloud, off or
 * either).
 */
function includeLines (text) {
  const out = []
  const conditions = []
  String(text).split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    const directive = trimmed.match(CONDITIONAL_RX)
    if (/^endif::[^[\s]*\[\]$/.test(trimmed)) {
      conditions.pop()
    } else if (/^ifeval::\[.*\]$/.test(trimmed)) {
      conditions.push({ type: 'ifeval', attrs: '' })
    } else if (directive) {
      // The single-line form, ifdef::x[text], opens nothing.
      if (!directive[3]) conditions.push({ type: directive[1], attrs: directive[2] })
    } else {
      const m = line.match(/^include::([^[\s]+)\[([^\]]*)\]\s*$/)
      if (!m) return
      const state = conditionOf(conditions, false)
      out.push({ target: m[1], attrs: m[2], index, only: state.cloudExcluded ? 'off' : state.qualifier ? 'cloud' : undefined })
    }
  })
  return out
}

/**
 * The line indexes of a file inside the tag regions an include selects, or
 * undefined for every line: no tag=, or a filter with ! or * the scan does
 * not follow.
 */
function taggedLines (text, attrs) {
  const m = String(attrs || '').match(/(?:^|,)\s*tags?=["']?([^,"']+)/)
  if (!m) return undefined
  const tags = m[1].split(';').map((t) => t.trim()).filter(Boolean)
  if (!tags.length || tags.some((t) => /^[!*]/.test(t))) return undefined
  const lines = new Set()
  const open = new Set()
  String(text).split('\n').forEach((line, index) => {
    const tag = line.match(/\b(tag|end)::([^[\s]+)\[\]/)
    if (tag && tags.includes(tag[2])) {
      if (tag[1] === 'tag') open.add(tag[2])
      else open.delete(tag[2])
      return
    }
    if (open.size) lines.add(index)
  })
  return lines
}

/**
 * The surfaces that render each line of the scanned checkout's files.
 *
 * @param {object} opts
 * @param {string} opts.docsDir
 * @param {object} opts.own - {component, version, attributes}.
 * @param {{dir: string, comp: object}[]} opts.lenders
 * @returns {(relative: string, index?: number) => {component: string, version: string, cloud: boolean, unknown?: boolean}[]}
 *   the surfaces of a line, or with no index of any line of the file. An
 *   unknown surface is a Cloud the scan has no checkout for.
 */
function renderingSurfaces ({ docsDir, own, lenders = [] }) {
  const surface = (comp) => ({ component: comp.component, version: comp.version, cloud: Boolean(comp.attributes && comp.attributes['env-cloud']) })
  const ownSurface = surface(own)
  const unknownCloud = own.component === connectLinks.CONNECT && !ownSurface.cloud && !lenders.some(({ comp }) => surface(comp).cloud)
    ? { component: undefined, version: undefined, cloud: true, unknown: true }
    : undefined
  const texts = new Map()
  const includers = new Map()
  const seeds = new Map()
  const add = (map, key, value) => {
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(value)
  }
  for (const relative of shared.walkFiles(docsDir)) {
    const posix = relative.split(path.sep).join('/')
    let text
    try {
      text = fs.readFileSync(path.join(docsDir, relative), 'utf8')
    } catch (error) {
      continue
    }
    texts.set(posix, text)
    if (!text.includes('include::')) continue
    for (const edge of includeLines(text)) {
      const target = includeTarget(edge.target, { fromFile: posix, component: own.component })
      if (target) add(includers, target, { from: posix, ...edge })
    }
  }
  for (const { dir, comp } of lenders) {
    const needle = `${own.component}:`
    for (const relative of shared.walkFiles(dir)) {
      let text
      try {
        text = fs.readFileSync(path.join(dir, relative), 'utf8')
      } catch (error) {
        continue
      }
      if (!text.includes(needle)) continue
      for (const edge of includeLines(text)) {
        if (!edge.target.includes(needle)) continue
        const target = includeTarget(edge.target, { fromFile: relative.split(path.sep).join('/'), component: own.component })
        if (target) add(seeds, target, { surface: surface(comp), ...edge })
      }
    }
  }
  const keeps = (only, s) => !only || (only === 'cloud') === s.cloud
  const linesOf = (file, attrs) => taggedLines(texts.get(file) || '', attrs)
  const memo = new Map()
  // Each surface of a file, with the lines it renders (undefined for all).
  const of = (file, stack = new Set()) => {
    if (memo.has(file)) return memo.get(file)
    if (stack.has(file)) return new Map()
    stack.add(file)
    const found = new Map()
    const reach = (s, lines) => {
      const key = `${s.component}@${s.version}`
      const had = found.get(key)
      if (!had) found.set(key, { s, lines })
      else if (had.lines) had.lines = lines ? new Set([...had.lines, ...lines]) : undefined
    }
    if (/^modules\/[^/]+\/pages\//.test(file)) reach(ownSurface)
    for (const seed of seeds.get(file) || []) if (keeps(seed.only, seed.surface)) reach(seed.surface, linesOf(file, seed.attrs))
    for (const edge of includers.get(file) || []) {
      for (const { s, lines } of of(edge.from, stack).values()) {
        if ((lines && !lines.has(edge.index)) || !keeps(edge.only, s)) continue
        reach(s, linesOf(file, edge.attrs))
      }
    }
    if (unknownCloud) {
      // Cloud may include any partial, and a page's single-source region.
      const text = texts.get(file) || ''
      if (/^modules\/[^/]+\/partials\//.test(file)) reach(unknownCloud)
      else if (/tag::single-source\[\]/.test(text)) reach(unknownCloud, taggedLines(text, 'tag=single-source'))
    }
    stack.delete(file)
    memo.set(file, found)
    return found
  }
  return (relative, index) => [...of(String(relative).split(path.sep).join('/')).values()]
    .filter(({ lines }) => index === undefined || !lines || lines.has(index))
    .map(({ s }) => s)
}

// ---------------------------------------------------------------------------
// Labels

const TYPE_WORDS_RX = '(input|output|processor|cache|buffer|rate limit|tracer|scanner|metrics(?: exporter)?)'
const COMPONENT_LABEL_RX = new RegExp(`^\`([a-z0-9_]+)\`(?:\\s+${TYPE_WORDS_RX})?$`, 'i')
const FIELD_LABEL_RX = /^`([a-z0-9_]+(?:\[\])?(?:\.[a-z0-9_]+(?:\[\])?)*)`$/i
const BLOBL_LABEL_RX = /^(?:(method|function)\s+)?`(\.?)([a-z0-9_]+)(\(\))?`(?:\s+(?:Bloblang\s+)?(method|function))?$/i

const backticked = (label) => [...String(label).matchAll(/`\+?([^`+]+)\+?`/g)].map((m) => m[1].trim())

// ---------------------------------------------------------------------------
// One line

/**
 * What a Connect xref target names: a component page, or a Bloblang page,
 * by the path the connect component gives it, or by the page alias of a
 * page that declares one.
 */
function connectTarget (page, { types, resolved }) {
  let module = page.module
  let relative = page.relative
  if (resolved && resolved.src.component === connectLinks.CONNECT) {
    module = resolved.src.module
    relative = resolved.src.relative
  }
  if (module === connectLinks.GUIDES_MODULE) {
    const m = relative.match(/^bloblang\/(functions|methods)\.adoc$/)
    if (m) return { kind: m[1] === 'functions' ? bloblang.FUNCTION : bloblang.METHOD, relative }
  }
  if (module === connectLinks.COMPONENTS_MODULE) {
    const m = relative.match(/^([a-z_]+)\/([\w-]+)\.adoc$/)
    if (m && types[m[1]]) return { kind: 'component', key: types[m[1]], name: m[2], relative }
  }
  return undefined
}

/**
 * The link findings of one prose or table line.
 *
 * @param {object} opts
 * @param {object} opts.links - {catalog, component, version, surfacesOf, buildHasData, skip}.
 * @param {object} opts.ctx - The line's walkAdoc state.
 */
function linkFindings (line, { index, relative, registry, links, ctx = {}, historical = false, connectContent = true }) {
  const data = registry.data
  const { catalog } = links
  const module = (relative.match(/^modules\/([^/]+)\//) || [])[1] || 'ROOT'
  const types = {}
  for (const key of Object.values(connectValues.componentTypes(data))) types[connectLinks.typeDir(key)] = key
  const spans = shared.backtickSpans(line)
  let surfaces = links.surfacesOf(relative, index)
  if (ctx.cloudExcluded) surfaces = surfaces.filter((s) => !s.cloud)
  if (ctx.qualifier === 'ifdef::env-cloud') surfaces = surfaces.filter((s) => s.cloud)
  // A Cloud the scan has no checkout for may render the line.
  const cloudUnknown = surfaces.some((s) => s.unknown)
  const cloudNote = `Cloud may render this line (${/(?:^|\/)partials\//.test(relative) ? 'a partial' : 'the page\'s single-source tag region'}), and this scan has no Cloud checkout; pass the cloud-docs checkout with --lender to check it`
  surfaces = surfaces.filter((s) => !s.unknown)
  const out = []
  for (const m of line.matchAll(XREF_RX)) {
    if (spans.some((sp) => sp.start < m.index && m.index < sp.end)) continue
    const label = m[2].trim()
    const base = { file: relative, line: index + 1, text: line.trim(), kind: 'connect', check: 'link', target: `xref:${m[1]}`, token: m[1], written: m[0], association: 'link', autoSafe: false, start: m.index, end: m.index + m[0].length }
    // The target as each surface resolves it.
    const views = surfaces.map((s) => {
      const page = xrefPage(m[1], { component: s.component, version: s.version, module, catalog })
      if (!page) return { s }
      const resolved = page.version === undefined ? undefined : connectLinks.findPage(catalog, `${page.module}:${page.relative}`, { component: page.component, version: page.version, module: page.module })
      let target = connectTarget(page, { types, resolved })
      // A Cloud stub, linked by its own path: the connect page it includes
      // says what it is, then what it aliases. The include comes first
      // because it is what the stub renders (connectLinks.isPageOf).
      if (!target && resolved) {
        for (const included of connectLinks.includedPaths(resolved)) {
          target = connectTarget({ module: connectLinks.COMPONENTS_MODULE, relative: included }, { types })
          if (target) break
        }
      }
      if (!target && resolved) {
        for (const alias of aliasesOf(catalog, resolved)) {
          target = connectTarget(alias.src, { types })
          if (target) break
        }
      }
      return { s, page, resolved, target }
    })
    if (!views.length) {
      // No surface in this scan renders the line: still say it is a link
      // this check would judge.
      const page = xrefPage(m[1], { component: links.component, version: links.version, module, catalog })
      if (page && connectTarget(page, { types }) && (connectContent || connectTarget(page, { types }).kind === 'component')) {
        out.push({ ...base, status: 'unverifiable', reason: 'link-target-not-loaded', note: cloudUnknown ? cloudNote : 'no page in this scan renders this line; pass the checkout that includes the file with --lender to check it' })
      }
      continue
    }
    const target = (views.find((v) => v.target) || {}).target
    if (!target) continue
    if (target.kind !== 'component' && !connectContent) continue
    const entry = target.kind === 'component'
      ? (data[target.key] || []).find((c) => c && c.name === target.name)
      : undefined
    const problems = []
    let notLoaded
    const picks = []
    for (const v of views) {
      const where = `${v.s.component}@${v.s.version || 'unversioned'}`
      if (!v.page || v.page.version === undefined || !catalog.getComponent(v.page.component)) {
        notLoaded = `${v.page ? v.page.component : 'the target component'} is not in this scan; pass its checkout with --lender to check the link`
        continue
      }
      if (!v.resolved) {
        problems.push(`${where} has no page ${v.page.component}:${v.page.module}:${v.page.relative}`)
        continue
      }
      const fragment = v.page.fragment
      if (target.kind === 'component') {
        if (!entry) continue
        // A path that aliases another page there (a Cloud about page that
        // took over a removed stub's paths) is not the component's page.
        if (!connectLinks.isPageOf(catalog, v.resolved, { module: connectLinks.COMPONENTS_MODULE, relative: target.relative })) {
          problems.push(`${where} has no ${normalizeType(target.key)} page for '${target.name}': ${v.page.component}:${v.page.module}:${v.page.relative} is a page alias of ${connectLinks.resourceId(v.resolved)}`)
          continue
        }
        const anchors = componentAnchorsOf(catalog, target, entry, data)
        if (fragment && !anchors.ids.has(fragment)) problems.push(`the ${normalizeType(target.key)} page has no anchor #${fragment}${fieldHint(anchors, fragment)}`)
        const pick = connectLinks.pickConnectPage(catalog, { component: v.s.component, version: v.s.version, module: connectLinks.COMPONENTS_MODULE, relative: target.relative, cloud: v.s.cloud })
        picks.push({ v, pick, fragment })
      } else {
        const anchors = bloblangAnchorsOf(catalog, target.kind, data, { cloud: v.s.cloud, page: v.resolved })
        if (fragment && !anchors.has(fragment)) {
          const fn = target.kind === bloblang.FUNCTION && (data['bloblang-functions'] || []).find((e) => e.name === fragment)
          const why = fn && fn.status === 'hidden' ? `: ${fragment} is hidden, so the reference does not list it` : fn && v.s.cloud && bloblang.cloudHiddenEntry(target.kind, fn) ? `: ${fragment}() is impure, and the Cloud page leaves it out` : /-\d+$/.test(fragment) ? ': a numbered heading id, which changes when the page does' : ''
          problems.push(`the Bloblang ${target.kind}s page in ${where} has no anchor #${fragment}${why}`)
        }
        const pick = connectLinks.pickConnectPage(catalog, { component: v.s.component, version: v.s.version, module: connectLinks.GUIDES_MODULE, relative: target.relative, cloud: v.s.cloud })
        picks.push({ v, pick, fragment })
      }
    }
    if (problems.length) {
      out.push({ ...base, status: 'reference', reason: 'broken-link', severity: 'error', component: target.name, componentType: target.key && normalizeType(target.key), note: [...new Set(problems)].join('; ') })
      continue
    }
    if (!picks.length) {
      if (notLoaded) out.push({ ...base, status: 'unverifiable', reason: 'link-target-not-loaded', note: notLoaded })
      continue
    }
    const mislabel = target.kind === 'component' ? componentLabelProblem(label, target, entry, picks, catalog, data) : bloblangLabelProblem(label, target, picks)
    if (mislabel) {
      out.push({ ...base, status: 'reference', reason: 'link-label-mismatch', severity: 'warning', component: target.name, componentType: target.key && normalizeType(target.key), note: mislabel })
      continue
    }
    if (cloudUnknown) {
      out.push({ ...base, status: 'unverifiable', reason: 'link-target-not-loaded', note: cloudNote })
      continue
    }
    const proposed = target.kind === 'component' ? componentProposal(label, target, entry, picks, catalog, data) : bloblangProposal(label, target, picks, catalog, data)
    if (!proposed || notLoaded) continue
    // The macro must link the same page (and anchor) on every surface.
    const same = picks.every(({ v, pick }) => pick.ok && pick.page === v.resolved && !v.page.pinned)
    if (!same) continue
    const finding = { ...base, status: 'exact', target: proposed, proposed, dataValue: picks.map(({ pick }) => pick.id).filter((id, i, all) => all.indexOf(id) === i).join(', ') }
    if (target.kind === 'component') Object.assign(finding, { component: target.name, componentType: normalizeType(target.key) })
    if (historical) finding.note = 'release, upgrade or migration notes: proposed only'
    else if (!links.buildHasData) finding.note = 'no connect-<version>.json attachment in this build; connect: and blobl: would render without a link'
    else finding.autoSafe = true
    out.push(finding)
  }
  return out
}

const $aliases = Symbol('$connectAliases')

// The page aliases that point at a page.
function aliasesOf (catalog, page) {
  if (!catalog[$aliases]) {
    const map = new Map()
    for (const alias of (typeof catalog.findBy === 'function' && catalog.findBy({ family: 'alias' })) || []) {
      if (!alias.rel) continue
      if (!map.has(alias.rel)) map.set(alias.rel, [])
      map.get(alias.rel).push(alias)
    }
    catalog[$aliases] = map
  }
  return catalog[$aliases].get(page) || []
}

const $anchors = Symbol('$connectAnchors')

function cache (catalog) {
  return catalog[$anchors] || (catalog[$anchors] = new Map())
}

// Every id on a component page, and the field path of each field anchor.
function componentAnchorsOf (catalog, target, entry, data) {
  const key = `component:${target.key}/${target.name}`
  const memo = cache(catalog)
  if (memo.has(key)) return memo.get(key)
  const pageText = connectLinks.connectPageText(catalog, target.key, target.name)
  const ids = connectLinks.componentAnchors({ entry, pageText, catalog, format: connectValues.docsFormat(data) })
  const fields = new Map()
  const walk = (children, prefix) => {
    for (const c of children || []) {
      if (!c || !c.name) continue
      const segments = [...prefix, String(c.name).replace(/\[\]$/, '')]
      const anchor = connectLinks.fieldAnchor({ resolved: { entry, key: target.key, name: target.name, segments }, catalog, pageText, format: connectValues.docsFormat(data) })
      if (anchor.anchor) fields.set(anchor.anchor, { path: segments.join('.'), heading: anchor.heading })
      walk(c.children, segments)
    }
  }
  walk(entry.config && entry.config.children, [])
  const out = { ids, fields }
  memo.set(key, out)
  return out
}

function fieldHint (anchors, fragment) {
  const near = [...anchors.fields.keys()].find((a) => a.replace(/-\d+$/, '') === fragment.replace(/-\d+$/, ''))
  return near ? `; the field is #${near}` : ''
}

function bloblangAnchorsOf (catalog, kind, data, { cloud, page }) {
  const key = `bloblang:${kind}:${cloud}:${page ? connectLinks.resourceId(page) : ''}`
  const memo = cache(catalog)
  if (memo.has(key)) return memo.get(key)
  const ids = connectLinks.bloblangAnchors(data, kind, { cloud, order: connectLinks.categoryOrder(catalog, data) })
  const text = page ? connectLinks.fileText(page) : undefined
  if (text) for (const { id } of connectLinks.sourceIds(text)) if (id) ids.add(id)
  memo.set(key, ids)
  return ids
}

// The names a component goes by on its page: its own, and the components
// whose page aliases point at the page (pg_stream on postgres_cdc).
function componentNames (catalog, target) {
  const names = new Set([target.name])
  const page = connectLinks.findPage(catalog, `${connectLinks.CONNECT}:${connectLinks.COMPONENTS_MODULE}:${target.relative}`)
  if (page) {
    for (const alias of aliasesOf(catalog, page)) {
      const m = String(alias.src.relative).match(/^[a-z_]+\/([\w-]+)\.adoc$/)
      if (m) names.add(m[1])
    }
  }
  return names
}

function componentLabelProblem (label, target, entry, picks, catalog, data) {
  const fragment = picks[0].fragment
  const type = normalizeType(target.key)
  if (fragment) {
    const anchors = componentAnchorsOf(catalog, target, entry, data)
    const field = anchors.fields.get(fragment)
    const m = label.match(FIELD_LABEL_RX)
    if (!field || !m) return undefined
    const written = m[1].replace(/\[\]/g, '')
    if (written === field.path || field.path.endsWith(`.${written}`)) return undefined
    // A label that names the component, or one of its other fields, on a
    // field link is a choice of words, not a wrong field.
    if (componentNames(catalog, target).has(written)) return undefined
    return `the label names the field ${written}, but the link goes to ${field.path} of the ${type} '${target.name}'`
  }
  const names = backticked(label)
  if (!names.length) return undefined
  const known = componentNames(catalog, target)
  const fields = new Set()
  const walk = (children, prefix) => {
    for (const c of children || []) {
      if (!c || !c.name) continue
      const p = prefix ? `${prefix}.${String(c.name).replace(/\[\]$/, '')}` : String(c.name).replace(/\[\]$/, '')
      fields.add(p)
      fields.add(p.split('.').pop())
      walk(c.children, p)
    }
  }
  walk(entry.config && entry.config.children, '')
  if (!names.some((n) => known.has(n) || fields.has(n))) {
    return `the label names ${names.map((n) => `\`${n}\``).join(', ')}, but the link goes to the ${type} '${target.name}'`
  }
  const m = label.match(COMPONENT_LABEL_RX)
  if (m && m[2] && known.has(m[1]) && normalizeType(m[2].replace(/ exporter$/, '').replace(/ /g, '_')) !== type) {
    return `the label calls '${m[1]}' a ${m[2].toLowerCase()}, but the link goes to the ${type} page`
  }
  return undefined
}

function componentProposal (label, target, entry, picks, catalog, data) {
  const dir = connectLinks.typeDir(target.key)
  const fragment = picks[0].fragment
  if (!fragment) {
    const m = label.match(COMPONENT_LABEL_RX)
    if (!m || m[1] !== target.name) return undefined
    if (m[2] && normalizeType(m[2].replace(/ exporter$/, '').replace(/ /g, '_')) !== normalizeType(target.key)) return undefined
    const shown = `\`${target.name}\` ${connectLinks.typeWords(normalizeType(target.key))}`
    return label === shown ? `connect:[${dir}/${target.name}]` : `connect:[${dir}/${target.name},${label}]`
  }
  const field = componentAnchorsOf(catalog, target, entry, data).fields.get(fragment)
  const m = label.match(FIELD_LABEL_RX)
  if (!field || !m) return undefined
  // The anchor must be the one connect: computes for the field.
  const anchor = connectLinks.fieldAnchor({ resolved: { entry, key: target.key, name: target.name, segments: field.path.split('.') }, catalog, format: connectValues.docsFormat(data) })
  if (anchor.anchor !== fragment) return undefined
  const written = m[1]
  if (written !== field.path && !field.path.endsWith(`.${written.replace(/\[\]/g, '')}`) && written.replace(/\[\]/g, '') !== field.path) return undefined
  return written === field.path ? `connect:[${dir}/${target.name}.${field.path}]` : `connect:[${dir}/${target.name}.${field.path},${label}]`
}

// The entry an anchor on a Bloblang page names, and its category copy.
function bloblangAnchorEntry (kind, data, fragment, order) {
  const list = data[kind === bloblang.FUNCTION ? 'bloblang-functions' : 'bloblang-methods'] || []
  const numbered = fragment.match(/^(.*)-(\d+)$/)
  for (const [name, index] of [[fragment, 0], ...(numbered ? [[numbered[1], Number(numbered[2]) - 1]] : [])]) {
    const entry = list.find((e) => e && e.name === name)
    if (!entry || entry.status === 'hidden') continue
    if (kind === bloblang.FUNCTION) return index === 0 ? { entry, index } : undefined
    const copies = (entry.categories || []).map((c) => c.Category)
    const sorted = [...copies].sort((a, b) => order.indexOf(bloblang.categoryKey(a)) - order.indexOf(bloblang.categoryKey(b)))
    if (index < Math.max(1, sorted.length)) return { entry, index, category: sorted[index] }
  }
  return undefined
}

function bloblangLabelProblem (label, target, picks) {
  const fragment = picks[0].fragment
  if (!fragment) return undefined
  const m = label.match(BLOBL_LABEL_RX)
  if (!m) return undefined
  const word = (m[1] || m[5] || '').toLowerCase()
  const name = m[3]
  const anchorName = fragment.replace(/-\d+$/, '')
  if (word && word !== target.kind) return `the label calls '${name}' a ${word}, but the link goes to the Bloblang ${target.kind}s page`
  if (m[2] && target.kind === bloblang.FUNCTION) return `the label writes '.${name}()', a method, but the link goes to the Bloblang functions page`
  if (name !== anchorName && name !== fragment) return `the label names '${name}', but the link goes to #${fragment}`
  return undefined
}

function bloblangProposal (label, target, picks, catalog, data) {
  const fragment = picks[0].fragment
  if (!fragment) return undefined
  const m = label.match(BLOBL_LABEL_RX)
  if (!m) return undefined
  const order = connectLinks.categoryOrder(catalog, data)
  const found = bloblangAnchorEntry(target.kind, data, fragment, order)
  if (!found || found.entry.name !== m[3]) return undefined
  const picked = bloblang.pickCategory(target.kind, found.entry, found.category, order)
  if (!picked.ok || connectLinks.bloblangAnchor(found.entry, picked) !== fragment) return undefined
  const call = bloblang.callText(target.kind, found.entry.name)
  const category = found.index > 0 ? `,category=${found.category}` : ''
  return label === `\`${call}\`` ? `blobl:[${call}${category}]` : `blobl:[${call},${label}${category}]`
}

module.exports = {
  pageEntries,
  includeTarget,
  renderingSurfaces,
  connectTarget,
  linkFindings,
  COMPONENT_LABEL_RX,
  FIELD_LABEL_RX,
  BLOBL_LABEL_RX,
}
