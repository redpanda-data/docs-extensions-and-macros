'use strict'

/* Rendered pages for check-reference-values: the lines each page shows, in
 * the order it shows them, following its include:: directives the way
 * Asciidoctor does. The unlinked-mention check (mentions.js) judges "first
 * mention, and not already linked" over this order, so a partial's mention
 * is judged on the pages that include it.
 *
 * A page is every file under modules/<module>/pages/ of the scanned checkout
 * and of each --lender checkout. Its order is its own lines, with each
 * include:: replaced by the lines of the file it names:
 *
 *   - in the same component, or in a loaded one (include::streaming:... from
 *     a cloud-docs stub); a component the scan did not load is not followed;
 *   - only the lines a tag= or tags= selects, !negations included (all
 *     lines for a wildcard);
 *   - a target built from attributes ({partials-dir}/x.adoc) when every
 *     attribute is set at that point, else not followed;
 *   - nested includes, each in place, never a file inside itself.
 *
 * ifdef::, ifndef:: and their single-line forms keep or drop lines by the
 * attributes set at that point: the component's antora.yml attributes
 * (env-cloud on Cloud), then the attribute entries of the page and its
 * includes, in order. ifeval:: is never evaluated: its lines are kept.
 * Attributes set by the site playbook or by Antora itself (page-*) are not
 * known, so a conditional on one reads as unset.
 */

const fs = require('fs')
const path = require('path')
const shared = require('./shared')
const datasets = require('../../extension-utils/attachment-datasets')
const { includeTarget } = require('./connect-links')
const { CONDITIONAL_RX } = require('../migrate-property-values')

const INCLUDE_LINE_RX = /^include::([^[\s]+)\[([^\]]*)\]\s*$/
const ENDIF_RX = /^endif::[^[\s]*\[\]\s*$/
const IFEVAL_RX = /^ifeval::\[.*\]\s*$/
const ATTRIBUTE_ENTRY_RX = /^:(!?)([\w][\w-]*)(!?):(?:[ \t]+(.*?))?\s*$/
const PAGE_RX = /^modules\/[^/]+\/pages\/.+\.adoc$/

/**
 * The component an include target names, or undefined when it names none
 * (partial$x.adoc, manage:partial$x.adoc, a relative path).
 */
function includeComponent (target) {
  let rest = String(target)
  const at = rest.indexOf('@')
  if (at !== -1) rest = rest.slice(at + 1)
  const family = rest.match(/(partial|example|page)\$/)
  const parts = (family ? rest.slice(0, family.index) : rest).split(':').filter((p) => p !== '')
  if (family) return parts.length >= 2 ? parts[parts.length - 2] : undefined
  return parts.length === 3 ? parts[0] : undefined
}

/**
 * Whether an ifdef:: or ifndef:: keeps its content, by Asciidoctor's rules:
 * a,b is any of them and a+b all of them for ifdef::, and the reverse for
 * ifndef::.
 */
function conditionHolds (type, names, attrs) {
  const set = (name) => attrs.has(name)
  const all = names.includes('+')
  const list = names.split(all ? '+' : ',')
  if (type === 'ifdef') return all ? list.every(set) : list.some(set)
  return all ? !list.every(set) : !list.some(set)
}

const substitute = (target, attrs) => {
  let missing = false
  const out = String(target).replace(/\{([\w][\w-]*)\}/g, (whole, name) => {
    if (!attrs.has(name)) { missing = true; return whole }
    return attrs.get(name)
  })
  return missing ? undefined : out
}

/**
 * The line indexes of a file an include's tag= or tags= selects, or
 * undefined for every line: the lines in the named tag regions, less those
 * in a !negated one (every tagged-out line when only negations are named),
 * never the tag directives themselves. A wildcard (* or **) is not
 * followed: every line.
 */
function selectedLines (text, attrs) {
  const m = String(attrs || '').match(/(?:^|,)\s*tags?=["']?([^,"']+)/)
  if (!m) return undefined
  const tags = m[1].split(';').map((t) => t.trim()).filter(Boolean)
  if (!tags.length || tags.some((t) => t.replace(/^!/, '').includes('*'))) return undefined
  const wanted = tags.filter((t) => !t.startsWith('!'))
  const unwanted = new Set(tags.filter((t) => t.startsWith('!')).map((t) => t.slice(1)))
  const lines = new Set()
  const open = new Set()
  String(text).split('\n').forEach((line, index) => {
    const tag = line.match(/\b(tag|end)::([^[\s]+)\[\]/)
    if (tag) {
      if (tag[1] === 'tag') open.add(tag[2])
      else open.delete(tag[2])
      return
    }
    const inWanted = wanted.length ? wanted.some((t) => open.has(t)) : true
    if (inWanted && ![...open].some((t) => unwanted.has(t))) lines.add(index)
  })
  return lines
}

/**
 * The rendered pages of the scanned checkout and its lenders.
 *
 * @param {object} opts
 * @param {{dir: string, comp: object}[]} opts.repos - The scanned checkout
 *   first, then each lender. comp is {component, version, attributes}.
 * @returns {{files: Map, pages: object[], rendering: (relative: string, index: number) => {page: object, pos: number}[]}}
 *   files by id (`<repo>:<relative>`), each {id, repo, relative, text,
 *   component, version, cloud}; pages, each {id, file, label, lines}, where
 *   lines is [{file, index}] in rendered order; rendering, the pages that
 *   render a line of a scanned file, and where.
 */
function renderedPages ({ repos }) {
  const files = new Map()
  const byComponent = new Map()
  repos.forEach(({ dir, comp }, repo) => {
    if (!byComponent.has(comp.component)) byComponent.set(comp.component, repo)
    for (const relative of shared.walkFiles(dir)) {
      const posix = relative.split(path.sep).join('/')
      let text
      try {
        text = fs.readFileSync(path.join(dir, relative), 'utf8')
      } catch (error) {
        continue
      }
      const id = `${repo}:${posix}`
      files.set(id, { id, repo, relative: posix, text, component: comp.component, version: comp.version, cloud: datasets.isAttributeSet((comp.attributes || {})['env-cloud']) })
    }
  })
  const linesOf = new Map()
  const split = (file) => {
    if (!linesOf.has(file.id)) linesOf.set(file.id, file.text.split('\n'))
    return linesOf.get(file.id)
  }

  const expand = (file, only, attrs, out, stack) => {
    if (stack.has(file.id)) return
    stack.add(file.id)
    const lines = split(file)
    const frames = []
    for (let index = 0; index < lines.length; index++) {
      if (only && !only.has(index)) continue
      const line = lines[index]
      const trimmed = line.trim()
      const active = frames.every((f) => f)
      if (ENDIF_RX.test(trimmed)) { frames.pop(); continue }
      if (IFEVAL_RX.test(trimmed)) { frames.push(true); continue }
      const directive = trimmed.match(CONDITIONAL_RX)
      if (directive) {
        const holds = conditionHolds(directive[1], directive[2], attrs)
        if (!directive[3]) frames.push(holds)
        else if (active && holds) out.push({ file: file.id, index })
        continue
      }
      if (!active) continue
      const entry = line.match(ATTRIBUTE_ENTRY_RX)
      if (entry) {
        if (entry[1] || entry[3]) attrs.delete(entry[2])
        else attrs.set(entry[2], entry[4] || '')
        // An attribute that holds an xref links where it is used.
        out.push({ file: file.id, index })
        continue
      }
      const include = line.match(INCLUDE_LINE_RX)
      if (include) {
        const target = substitute(include[1], attrs)
        const named = target && includeComponent(target)
        const repo = target && (named === undefined ? file.repo : byComponent.get(named))
        const relative = repo !== undefined && includeTarget(target, { fromFile: file.relative, component: named === undefined ? file.component : named })
        const included = relative && files.get(`${repo}:${relative}`)
        if (included) expand(included, selectedLines(included.text, include[2]), attrs, out, stack)
        continue
      }
      out.push({ file: file.id, index })
    }
    stack.delete(file.id)
  }

  const pages = []
  const rendering = new Map()
  for (const file of files.values()) {
    if (!PAGE_RX.test(file.relative)) continue
    const attrs = new Map()
    for (const [name, value] of Object.entries(repos[file.repo].comp.attributes || {})) {
      if (datasets.isAttributeSet(value)) attrs.set(name, String(value).replace(/@$/, ''))
    }
    const lines = []
    expand(file, undefined, attrs, lines, new Set())
    const page = { id: file.id, file, label: file.repo === 0 ? file.relative : `${file.component}:${file.relative}`, lines }
    pages.push(page)
    lines.forEach(({ file: id, index }, pos) => {
      if (!id.startsWith('0:')) return
      const key = `${id}\n${index}`
      if (!rendering.has(key)) rendering.set(key, [])
      rendering.get(key).push({ page, pos })
    })
  }
  return {
    files,
    pages,
    rendering: (relative, index) => rendering.get(`0:${String(relative).split(path.sep).join('/')}\n${index}`) || [],
  }
}

module.exports = {
  renderedPages,
  selectedLines,
  includeComponent,
  conditionHolds,
}
