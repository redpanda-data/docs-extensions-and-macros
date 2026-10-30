'use strict'

/* Links from an rpk command to its generated reference page, shared by the
 * rpkcmd: inline macro (macros/rpkcmd.js) and check-reference-values, so a
 * hand-written xref is judged by the page the macro would link.
 *
 * The page path is the rpk docs generator's (getOutputPath in
 * tools/rpk-docs/generate-rpk-docs.js): rpk itself is rpk/rpk.adoc, a
 * top-level command with subcommands and every command below it are in
 * rpk/rpk-<top>/rpk-<path-dashed>.adoc, and a top-level command without
 * subcommands is rpk/rpk-<name>.adoc. The generated pages have no flag
 * anchors, so a flag links its command's page.
 *
 * The page is found in the content catalog, never in a list of repos, in
 * this order:
 *
 *   1. the rendering page's own component and version;
 *   2. the streaming component: the page's own version when rendering there,
 *      otherwise its latest (GA) version;
 *   3. any other component that has the page, the one with the most pages
 *      in the page's own directory first (rpk/rpk-cloud/ for rpk cloud
 *      login, where cloud-docs has many and adp-docs one), then the one with
 *      the most rpk reference pages.
 *
 * The rendering page is the one Antora converts, so a cloud-docs stub that
 * includes a streaming page, or a page that includes rp-connect-docs text,
 * resolves from its own component. A Cloud (env-cloud) page stops after step
 * 1: Cloud readers are never sent to self-managed docs.
 */

const datasets = require('./attachment-datasets')
const rpkValues = require('./rpk-values')
const { annotateVerbatimLines } = require('../tools/redpanda-connect/metadata-utils')

const $rpkPages = Symbol('$rpkPages')
const PAGE_MODULE = 'reference'
const PAGE_DIR = 'rpk/'

/**
 * The reference page path of a canonical command path, below the module.
 *
 * @param {object} tree - registry.data.tree.
 * @param {string[]} names - Canonical command names below rpk.
 */
function commandPagePath (tree, names) {
  if (!names.length) return `${PAGE_DIR}rpk.adoc`
  const file = `rpk-${names.join('-')}.adoc`
  const top = rpkValues.childOf(tree, names[0])
  const grouped = top && Array.isArray(top.commands) && top.commands.length > 0
  return grouped ? `${PAGE_DIR}rpk-${top.name}/${file}` : `${PAGE_DIR}${file}`
}

/**
 * The command a reference page path documents, or undefined for a page that
 * is not a command page (index.adoc, rpk-x-options.adoc) or names no command
 * in the tree. Command names may hold dashes, so each step takes the longest
 * child name that matches.
 *
 * @returns {{names: string[], node: object, nodes: object[]} | undefined}
 */
function commandOfPage (tree, relative) {
  const m = String(relative).match(/^rpk\/(?:rpk-[\w-]+\/)?(rpk(?:-[\w-]+)?)\.adoc$/)
  if (!m) return undefined
  if (m[1] === 'rpk') return relative === `${PAGE_DIR}rpk.adoc` ? { names: [], node: tree, nodes: [] } : undefined
  let node = tree
  const nodes = []
  const names = []
  let rest = m[1].slice(4)
  while (rest) {
    const child = (node.commands || [])
      .filter((c) => c && (rest === c.name || rest.startsWith(`${c.name}-`)))
      .sort((a, b) => b.name.length - a.name.length)[0]
    if (!child) return undefined
    node = child
    nodes.push(child)
    names.push(child.name)
    rest = rest.slice(child.name.length).replace(/^-/, '')
  }
  // The path must be where the generator puts that command.
  return commandPagePath(tree, names) === relative ? { names, node, nodes } : undefined
}

/**
 * Every rpk reference page in the build, by component and version, read once
 * per catalog. Antora rebuilds the catalog per build, so watch mode sees new
 * pages.
 *
 * @returns {Map<string, Map<string, Set<string>>>}
 */
function rpkPageIndex (contentCatalog) {
  if (contentCatalog[$rpkPages]) return contentCatalog[$rpkPages]
  const index = new Map()
  for (const page of contentCatalog.findBy({ family: 'page' }) || []) {
    const src = page.src || {}
    if (src.module !== PAGE_MODULE || !String(src.relative || '').startsWith(PAGE_DIR)) continue
    const component = String(src.component || '')
    const version = src.version == null ? '' : String(src.version)
    if (!index.has(component)) index.set(component, new Map())
    const versions = index.get(component)
    if (!versions.has(version)) versions.set(version, new Set())
    versions.get(version).add(src.relative)
  }
  contentCatalog[$rpkPages] = index
  return index
}

function hasPage (index, component, version, relative) {
  const versions = index.get(component)
  const pages = versions && versions.get(version)
  return Boolean(pages && pages.has(relative))
}

/**
 * A component's latest version: Antora's latest, which skips prereleases.
 */
function latestVersion (contentCatalog, component) {
  const found = typeof contentCatalog.getComponent === 'function' ? contentCatalog.getComponent(component) : undefined
  if (!found) return undefined
  const latest = found.latest || (found.versions || [])[0]
  return latest ? (latest.version == null ? '' : String(latest.version)) : undefined
}

/**
 * The Antora resource ID of a picked page.
 */
function resourceId ({ component, version, relative }) {
  return `${version ? `${version}@` : ''}${component}:${PAGE_MODULE}:${relative}`
}

/**
 * The page a command links to from a page rendering in one component
 * version, in the order the file comment gives.
 *
 * @returns {{ok: true, component: string, version: string, relative: string, id: string} |
 *   {ok: false, reason: 'cloud-no-page'|'no-page', relative: string}}
 */
function pickCommandPage (contentCatalog, { component, version, relative }) {
  const index = rpkPageIndex(contentCatalog)
  const found = (c, v) => ({ ok: true, component: c, version: v, relative, id: resourceId({ component: c, version: v, relative }) })
  if (hasPage(index, component, version, relative)) return found(component, version)
  const cloud = datasets.isAttributeSet(datasets.componentAttributes(contentCatalog, component, version)['env-cloud'])
  if (cloud) return { ok: false, reason: 'cloud-no-page', relative }
  const lenders = rpkValues.RPK_KIND.lenders
  for (const lender of lenders) {
    const v = lender === component ? version : latestVersion(contentCatalog, lender)
    if (v !== undefined && hasPage(index, lender, v, relative)) return found(lender, v)
  }
  const dir = relative.slice(0, relative.lastIndexOf('/') + 1)
  const inDir = (p) => p.startsWith(dir) && !p.slice(dir.length).includes('/')
  const others = [...index.keys()]
    .filter((c) => c !== component && !lenders.includes(c))
    .map((c) => {
      const sets = [...index.get(c).values()]
      return { c, group: sets.reduce((n, set) => n + [...set].filter(inDir).length, 0), pages: sets.reduce((n, set) => n + set.size, 0) }
    })
    .sort((a, b) => b.group - a.group || b.pages - a.pages || a.c.localeCompare(b.c))
  for (const { c } of others) {
    const v = latestVersion(contentCatalog, c)
    if (v !== undefined && hasPage(index, c, v, relative)) return found(c, v)
  }
  return { ok: false, reason: 'no-page', relative }
}

/**
 * The rpk data a link resolves commands against: the page's own (as rpkval:
 * picks it), or, for a component that is no Redpanda release and borrows
 * nothing (rp-connect-docs), the latest streaming version's. A versioned
 * self-managed page, and a Cloud or Agentic Data Plane page, never borrow
 * another release's data here either.
 */
function loadRpkForLinks (contentCatalog, component, version) {
  const own = rpkValues.loadRpkFor(contentCatalog, component, version)
  if (own) return own
  const kind = rpkValues.RPK_KIND
  if (kind.lenders.includes(component)) return undefined
  const attributes = datasets.componentAttributes(contentCatalog, component, version)
  if (kind.borrowWhen.some((name) => datasets.isAttributeSet(attributes[name]))) return undefined
  for (const lender of kind.lenders) {
    const v = latestVersion(contentCatalog, lender)
    if (v === undefined) continue
    const registry = rpkValues.loadRpkFor(contentCatalog, lender, v)
    if (registry) return registry
  }
  return undefined
}

const cmdText = (names) => ['rpk', ...names].join(' ')

/**
 * Resolve the command line in one rpkcmd:[...] to its command and flag, the
 * way rpkval: resolves them: names then aliases, deprecated commands before
 * unknown ones, the command's own flags then the global flags, and no
 * ancestor flags.
 *
 * @param {object} opts
 * @param {object} [opts.registry]
 * @param {string} opts.text - The command line as written.
 * @param {string} [opts.call] - How messages name the call.
 * @returns {{ok: true, names: string[], node: object, nodes: object[], flag?: object, typed: string} |
 *   {ok: false, kind: string, message: string, typed: string, registry?: object}}
 */
function resolveRpkCommand ({ registry, text, call }) {
  const parsed = rpkValues.parseCommandLine(text)
  const typed = [cmdText(parsed.tokens), ...(parsed.flag ? [parsed.flag] : [])].join(' ')
  const label = call || `rpkcmd:[${String(text == null ? '' : text).trim()}]`
  if (!registry) {
    return { ok: false, kind: 'no-data', typed, message: `${label}: this page has no rpk data to check '${typed}' against (see the rpkval macro warning for this component version), so it renders as plain code with no link.` }
  }
  const dataset = datasets.describeDataset(registry)
  const tree = registry.data.tree
  if (parsed.extra.length) {
    return { ok: false, kind: 'unknown-flag', typed, registry, message: `${label}: '${parsed.extra.join(' ')}' follows ${parsed.flag}; write the command and at most one flag, without a value or arguments.` }
  }
  const resolved = rpkValues.resolveCommand(tree, parsed.tokens, registry.data.deprecated_commands)
  if (!resolved.ok && resolved.kind === 'deprecated-command') {
    const why = resolved.entry.replacement || resolved.entry.deprecatedMessage
    return { ok: false, kind: 'deprecated-command', typed, registry, message: `${label}: '${cmdText(resolved.typed)}' is deprecated (${resolved.entry.key} in ${dataset}) and has no reference page, so it renders as plain code with no link.${why ? ` ${why}` : ''}` }
  }
  if (!resolved.ok) {
    const shown = cmdText([...resolved.parentNames, ...parsed.tokens.slice(resolved.at)])
    const hint = resolved.argument
      ? ' Write the command path, without arguments.'
      : resolved.suggestions.length ? ` Did you mean: ${resolved.suggestions.join(', ')}?` : ''
    return { ok: false, kind: 'unknown-command', typed, registry, message: `${label}: '${shown}' is not a command in ${dataset}: ${cmdText(resolved.parentNames)} has no subcommand '${resolved.token}'.${hint}` }
  }
  const { node, nodes, names } = resolved
  const out = { ok: true, names, node, nodes, typed }
  if (!parsed.flag) return out
  const name = parsed.flag.replace(/^-+/, '')
  const where = cmdText(names)
  const found = names.length ? rpkValues.findFlag(node, name, tree) : rpkValues.findFlag(tree, name, tree)
  if (found) return { ...out, flag: found.flag }
  const ancestor = rpkValues.ancestorFlag(nodes, names, name)
  if (ancestor) {
    return { ok: false, kind: 'unknown-flag', typed, registry, message: `${label}: '${parsed.flag}' is not a flag of ${where} in ${dataset}; it is defined on ${cmdText(ancestor.names)}; write rpkcmd:[${cmdText(ancestor.names)} ${parsed.flag}].` }
  }
  const suggestions = name.length > 1 ? datasets.suggest(name, [...(names.length ? node.flags || [] : []), ...(tree.global_flags || [])].map((f) => f.name)) : []
  const hint = suggestions.length ? ` Did you mean: ${suggestions.map((s) => `--${s}`).join(', ')}?` : ''
  return { ok: false, kind: 'unknown-flag', typed, registry, message: `${label}: '${parsed.flag}' is not a flag of ${where} in ${dataset}.${hint}` }
}

/**
 * Rewrite the links in an rpk description for the page it renders on. The
 * descriptions are written for the command's own reference page in the
 * component the rpk data came from (streaming): an xref with no component
 * resolves there, xref:./x.adoc is a page beside the command's page, and
 * <<id>> is an anchor on it. On any other page those links break, so:
 *
 *   a command page     links the page rpkcmd: would link (pickCommandPage),
 *                      with its fragment: a Cloud stub on Cloud, the rpk ai
 *                      pages on Agentic Data Plane, never a self-managed
 *                      page on Cloud.
 *   <<id>>             links the anchor on the command's page, picked the
 *                      same way, unless the text renders on that page.
 *   any other page     stays as written when the rendering page's component
 *                      version has it, and is otherwise qualified with the
 *                      data's component and version. A Cloud page never
 *                      links outside its own component.
 *   a qualified target (xref:connect:guides:bloblang/about.adoc) stays as
 *                      written.
 *
 * A target the build has no page for renders as its label, unlinked, and is
 * returned in unlinked.
 *
 * @param {string} text - AsciiDoc.
 * @param {object} opts
 * @param {object} opts.registry - The rpk data the text came from.
 * @param {string[]} opts.names - The command the text describes, below rpk.
 * @param {object} [opts.src] - The rendering page's src (component, version, module, relative).
 * @param {object} [opts.contentCatalog]
 * @returns {{text: string, unlinked: string[]}}
 */
function relocateRpkRefs (text, { registry, names = [], src = {}, contentCatalog } = {}) {
  if (!contentCatalog || !registry) return { text, unlinked: [] }
  const { findPage: find } = require('./connect-links')
  // A resource ID with a version (26.2@streaming:manage:x.adoc) resolves in
  // that version, as Antora resolves it.
  const findPage = (catalog, spec, context = {}) => {
    const at = spec.indexOf('@')
    if (at === -1 || typeof catalog.resolvePage === 'function') return find(catalog, spec, context)
    const parts = spec.slice(at + 1).split(':')
    const relative = parts.pop()
    const module = parts.pop() || context.module
    return find(catalog, `${module}:${relative}`, { component: parts.pop() || context.component, version: spec.slice(0, at), module })
  }
  const tree = registry.data.tree
  const component = String(src.component || '')
  const version = src.version == null ? '' : String(src.version)
  const home = commandPagePath(tree, names)
  const onHome = src.module === PAGE_MODULE && src.relative === home
  const cloud = datasets.isAttributeSet(datasets.componentAttributes(contentCatalog, component, version)['env-cloud'])
  const from = { component: String(registry.component || ''), version: registry.version == null ? '' : String(registry.version) }
  const unlinked = []
  const title = (spec) => {
    const page = findPage(contentCatalog, spec, from)
    return page && page.asciidoc && page.asciidoc.doctitle
  }
  const unlink = (spec, label, fallback) => {
    unlinked.push(spec)
    return label || fallback
  }
  const commandLink = (relative, fragment, label) => {
    const command = commandOfPage(tree, relative)
    const shown = command ? `\`${cmdText(command.names)}\`` : `\`${relative.replace(/^.*\//, '').replace(/\.adoc$/, '')}\``
    const page = pickCommandPage(contentCatalog, { component, version, relative })
    if (!page.ok) return unlink(`${PAGE_MODULE}:${relative}`, label, shown)
    return `xref:${page.id}${fragment ? `#${fragment}` : ''}[${label}]`
  }
  const lines = annotateVerbatimLines(text).map(({ line, verbatim }) => {
    if (verbatim) return line
    return line
      .replace(/<<([^,>\s]+)(?:,\s*([^>]*?))?>>/g, (match, id, label) => {
        if (onHome) return match
        return commandLink(home, id, label != null && label !== '' ? label : `\`${id}\``)
      })
      .replace(/xref:([^[\s]+)\[([^\]]*)\]/g, (match, target, label) => {
        const [resource, fragment] = target.split('#')
        // A version or a component already says where it points, and an
        // attribute reference is the page's to resolve.
        if (resource.includes('@') || resource.split(':').length > 2 || /[{}]/.test(resource)) {
          if (/[{}]/.test(resource) || findPage(contentCatalog, resource, { component, version })) return match
          return unlink(resource, label, `\`${resource.replace(/^.*[/:]/, '').replace(/\.adoc$/, '')}\``)
        }
        let module = PAGE_MODULE
        let relative = resource
        if (resource.startsWith('./') || resource.startsWith('../')) {
          relative = require('path').posix.normalize(`${home.slice(0, home.lastIndexOf('/') + 1)}${resource}`)
        } else if (resource.includes(':')) {
          [module, relative] = resource.split(':')
        }
        if (module === PAGE_MODULE && relative.startsWith(PAGE_DIR) && commandOfPage(tree, relative)) {
          if (onHome && relative === home) return match
          return commandLink(relative, fragment, label)
        }
        const spec = `${module}:${relative}`
        const link = (id) => `xref:${id}${fragment ? `#${fragment}` : ''}[${label}]`
        if (findPage(contentCatalog, spec, { component, version, module: src.module })) return link(spec)
        const qualified = `${from.version ? `${from.version}@` : ''}${from.component}:${spec}`
        if (cloud || from.component === component || !findPage(contentCatalog, qualified)) {
          return unlink(spec, label, title(spec) || `\`${relative.replace(/^.*\//, '').replace(/\.adoc$/, '')}\``)
        }
        return link(qualified)
      })
  })
  return { text: lines.join('\n'), unlinked }
}

module.exports = {
  PAGE_MODULE,
  commandPagePath,
  commandOfPage,
  rpkPageIndex,
  hasPage,
  latestVersion,
  resourceId,
  pickCommandPage,
  loadRpkForLinks,
  resolveRpkCommand,
  relocateRpkRefs,
}
