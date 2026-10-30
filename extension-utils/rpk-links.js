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
const urlToXref = require('../extensions/url-to-xref')
const { scanContentUrls } = require('../extensions/util/scan-content-urls')

const $rpkPages = Symbol('$rpkPages')
const $docsUrls = Symbol('$rpkDocsUrls')
const DOCS_HOSTNAMES = new Set(['docs.redpanda.com'])
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


/**
 * What extensions/url-to-xref.js resolves docs URLs against, built from the
 * content catalog once per build: published URL path -> page, including the
 * component start pages and page aliases, with the extension's default
 * hostnames and ignored paths (/api/ and /mcp). By the time a macro runs,
 * Antora has registered every page alias as an alias file, so buildUrlMap
 * finds them there. The playbook is out of reach here, so the latest-version
 * segment is the docs site's (current); candidatePaths also tries each
 * component's real latest version, which a build without that segment
 * publishes under.
 */
function docsUrlResolver (contentCatalog) {
  if (contentCatalog[$docsUrls] !== undefined) return contentCatalog[$docsUrls]
  let resolver = null
  if (typeof contentCatalog.getComponents === 'function' && typeof contentCatalog.getPages === 'function') {
    resolver = Object.assign(urlToXref.buildUrlMap(contentCatalog), {
      hostnames: DOCS_HOSTNAMES,
      ignore: urlToXref.DEFAULT_IGNORE.map((pattern) => new RegExp(pattern)),
      latestVersionSegment: 'current',
      resolveInclude: typeof contentCatalog.resolveResource === 'function'
        ? (spec, page) => contentCatalog.resolveResource(spec, page.src, 'partial', ['partial', 'page'])
        : undefined,
    })
  }
  contentCatalog[$docsUrls] = resolver
  return resolver
}

const $anchors = new WeakMap()
const stripTags = (html) => String(html).replace(/<[^>]*>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/**
 * The anchors of a URL's target page, id -> heading text, the way
 * url-to-xref reads them. Macros run during conversion, when a page Antora
 * has already converted holds HTML: its anchors are then its id attributes,
 * and its headings the h1-h6 elements that carry one. undefined when the page
 * has no contents to read.
 */
function targetAnchors (page, resolveInclude) {
  if (!page || !page.contents) return undefined
  if (page.mediaType !== 'text/html') return urlToXref.pageAnchors(page, resolveInclude)
  if ($anchors.has(page)) return $anchors.get(page)
  const html = page.contents.toString()
  const anchors = new Map()
  for (const m of html.matchAll(/<h[1-6]\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h[1-6]>/g)) {
    anchors.set(m[1], urlToXref.sanitizeLinkText(stripTags(m[2])) || undefined)
  }
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) if (!anchors.has(m[1])) anchors.set(m[1], undefined)
  $anchors.set(page, anchors)
  return anchors
}

/**
 * A page's title as link text: the title Antora loaded from its header, or
 * its level-0 heading while it is still AsciiDoc. Empty when neither is
 * there, so xref:...[] lets Antora fill the title in, as url-to-xref does.
 */
function pageTitle (page) {
  if (!page) return ''
  const doctitle = page.asciidoc && page.asciidoc.doctitle
  if (doctitle) return urlToXref.sanitizeLinkText(stripTags(doctitle))
  if (page.contents && page.mediaType !== 'text/html') return urlToXref.documentTitle(page.contents.toString()) || ''
  return ''
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
    const line = String(text == null ? '' : text).trim()
    const said = deprecationSentence({ registry, entry: resolved.entry, typed: resolved.typed, flag: parsed.flag, line, wrap: (l) => `rpkcmd:[${l}]` })
    return { ok: false, kind: 'deprecated-command', typed, registry, entry: resolved.entry, advice: said.advice, proposed: said.proposed, message: `${label}: '${cmdText(resolved.typed)}' is deprecated (${resolved.entry.key} in ${dataset}) and has no reference page, so it renders as plain code with no link.${said.text}` }
  }
  if (!resolved.ok) {
    const shown = cmdText([...resolved.parentNames, ...parsed.tokens.slice(resolved.at)])
    const hint = resolved.argument
      ? ' Write the command path, without arguments.'
      : resolved.suggestions.length ? ` Did you mean: ${resolved.suggestions.join(', ')}?` : ''
    return { ok: false, kind: 'unknown-command', typed, registry, message: `${label}: '${shown}' is not a command in ${dataset}: ${cmdText(resolved.parentNames)} has no subcommand '${resolved.token}'.${hint}` }
  }
  const { node, nodes, names } = resolved
  const out = { ok: true, names, node, nodes, typed, aliases: resolved.aliases || [] }
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
 * The one command a deprecated_commands replacement names: the rpk
 * reference page it links (xref:reference:rpk/rpk-cluster/rpk-cluster.adoc)
 * or the `rpk ...` span it quotes, when every one it names is the same
 * command in the tree. undefined when it names none, or more than one.
 *
 * @returns {{names: string[], node: object} | undefined}
 */
function replacementCommand (registry, text) {
  if (!registry || !text) return undefined
  const tree = registry.data.tree
  const found = new Map()
  for (const m of String(text).matchAll(/xref:(?:[\w-]+:)?(?:reference:)?(rpk\/[^\s[#]+\.adoc)/g)) {
    const command = commandOfPage(tree, m[1])
    if (command) found.set(command.names.join(' '), { names: command.names, node: command.node })
  }
  for (const m of String(text).matchAll(/`(rpk(?:\s+[a-z][\w-]*)+)`/g)) {
    const resolved = rpkValues.resolveCommand(tree, rpkValues.commandTokens(m[1]))
    if (resolved.ok) found.set(resolved.names.join(' '), { names: resolved.names, node: resolved.node })
  }
  return found.size === 1 ? [...found.values()][0] : undefined
}

/**
 * What to do about a deprecated command, from its deprecated_commands
 * entry: the command that replaces it, and whether a call or span may be
 * rewritten to it. It may only when the entry's own replacement names one
 * command, nothing but flags follows the deprecated command, and the
 * replacement has every one of those flags, by long name or shorthand (a
 * global flag counts). An ancestor's replacement replaces the ancestor
 * (rpk redpanda admin -> rpk cluster), never a subcommand of it.
 *
 * @param {object} opts
 * @param {object} opts.registry
 * @param {object} opts.entry - From rpkValues.deprecatedEntry.
 * @param {string[]} opts.typed - The deprecated command as written, below rpk.
 * @param {string[]} [opts.flags] - Flags written after it, without dashes.
 * @param {boolean} [opts.extra] - Words other than flags follow it.
 * @returns {{replacement?: string, names?: string[], writable: boolean, why?: string}}
 */
function deprecationAdvice ({ registry, entry, typed, flags = [], extra = false }) {
  const command = cmdText(typed)
  const found = replacementCommand(registry, entry && entry.replacement)
  if (!found) return { writable: false, why: `the rpk data names no single replacement for ${command}` }
  const replacement = cmdText(found.names)
  const out = { replacement, names: found.names, writable: false }
  if (entry.replacementKey !== command) return { ...out, why: `the rpk data names a replacement only for ${entry.replacementKey} (${replacement}), not for ${command}` }
  if (extra) return { ...out, why: `its replacement is ${replacement}, but words follow ${command}, which ${replacement} may not take` }
  const tree = registry.data.tree
  const missing = flags.filter((name) => !(found.names.length ? rpkValues.findFlag(found.node, name, tree) : rpkValues.findFlag(tree, name, tree)))
  if (missing.length) return { ...out, why: `its replacement, ${replacement}, has no ${missing.map((name) => (name.length === 1 ? `-${name}` : `--${name}`)).join(', ')} flag, so find the equivalent by hand` }
  return { ...out, writable: true }
}

/**
 * A command line as written (rpkcmd:[...], rpkval:[...], command=, or a
 * backticked span) with its command words replaced: the words at the given
 * positions of commandTokens' output, a leading rpk not counted. Everything
 * else, spacing, flags and arguments, stays as written.
 *
 * @param {string} line
 * @param {{at: number, name: string}[]} words - Replace word `at` with `name`.
 * @param {{from: number, to: number, names: string[]}} [span] - Instead,
 *   replace words from..to-1 with names.
 */
function rewriteCommandWords (line, { words = [], span } = {}) {
  const parts = String(line).split(/(\s+)/)
  const indices = []
  parts.forEach((part, i) => { if (part && !/^\s+$/.test(part)) indices.push(i) })
  const quoted = /^(['"])/.exec(parts[indices[0]] || '')
  const offset = (parts[indices[0]] || '').replace(/^['"]/, '') === 'rpk' ? 1 : 0
  if (quoted) return undefined
  const at = (n) => indices[n + offset]
  if (span) {
    const first = at(span.from)
    const last = at(span.to - 1)
    if (first === undefined || last === undefined) return undefined
    return [...parts.slice(0, first), span.names.join(' '), ...parts.slice(last + 1)].join('')
  }
  for (const w of words) {
    const i = at(w.at)
    if (i === undefined) return undefined
    parts[i] = w.name
  }
  return parts.join('')
}

/**
 * The sentence a deprecated-command warning ends with: the replacement and
 * the call to write, or why the call cannot simply be rewritten, or the
 * entry's own message when it names no single command.
 *
 * @param {object} opts
 * @param {object} opts.registry
 * @param {object} opts.entry - From rpkValues.deprecatedEntry.
 * @param {string[]} opts.typed - The command words as written, below rpk,
 *   from the first one to the last before any flag.
 * @param {string} [opts.flag] - The flag written after them, dashes included.
 * @param {string} [opts.line] - The command line as written in the call.
 * @param {(line: string) => string} [opts.wrap] - The call around a line.
 * @returns {{text: string, advice: object, proposed?: string}}
 */
function deprecationSentence ({ registry, entry, typed, flag, line, wrap = (l) => l }) {
  const keyNames = String(entry.key).split(' ').slice(1)
  const advice = deprecationAdvice({ registry, entry, typed: keyNames, flags: flag ? [flag.replace(/^-+/, '')] : [], extra: typed.length > keyNames.length })
  if (!advice.replacement) {
    const why = entry.deprecatedMessage
    return { text: why ? ` ${why}` : '', advice }
  }
  if (!advice.writable) return { text: ` ${advice.why.charAt(0).toUpperCase()}${advice.why.slice(1)}.`, advice }
  const rewritten = line === undefined ? undefined : rewriteCommandWords(line, { span: { from: 0, to: keyNames.length, names: advice.names } })
  const proposed = rewritten === undefined ? undefined : wrap(rewritten)
  return { text: ` Its replacement is ${advice.replacement}${proposed ? `: write ${proposed}` : ''}.`, advice, proposed }
}

/**
 * The warning for a command written with an alias: rpk cluster status is an
 * alias of rpk cluster info. typed and names are below rpk.
 */
function aliasNote (typed, names) {
  return `${cmdText(typed)} is an alias of ${cmdText(names)}`
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
 *   a docs URL         (https://docs.redpanda.com/...) maps to a page as
 *                      extensions/url-to-xref.js maps it: /current/ and
 *                      version segments, legacy slugs such as
 *                      /redpanda-connect/, start pages, page aliases, and a
 *                      fragment only when the anchor is on the page. That
 *                      extension runs before conversion, so it never sees
 *                      macro output. A command page then links as above.
 *                      Any other page links the rendering component's own
 *                      page: the same page in its version when the target
 *                      is in its component, otherwise a page alias it
 *                      declares for the target's path (cloud-docs declares
 *                      guides:bloblang/about.adoc for its Bloblang page).
 *                      Otherwise the link names the target's component, as
 *                      url-to-xref writes it. A Cloud page links only
 *                      Cloud pages, never the self-managed docs (streaming,
 *                      or connect, whose Cloud stubs alias its paths): it
 *                      renders the link text, which is the label, the page
 *                      title, or the URL, and the URL is returned in
 *                      unlinked. The link keeps
 *                      the URL's label; with none, it takes the heading the
 *                      fragment names or the page title. A URL the catalog
 *                      does not publish, or one under /api/ or /mcp, or with
 *                      a query string or a fragment that is not on the
 *                      page, stays as written: the build's own checks report
 *                      those. Trailing sentence punctuation is not part of
 *                      a URL.
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
  const urls = docsUrlResolver(contentCatalog)
  const ownAlias = (module, relative) => (contentCatalog.findBy({ family: 'alias', component, version, module, relative }) || []).length > 0
  const relinkUrl = (match) => {
    let url
    try {
      url = new URL(match.url)
    } catch {
      return undefined
    }
    if (!urls.hostnames.has(url.hostname) || match.inAttributeEntry || match.inAttributeValue || match.hasAttributeReference) return undefined
    if (url.search || urls.ignore.some((pattern) => pattern.test(url.pathname))) return undefined
    const entry = urlToXref.resolveUrlPath(url.pathname, urls)
    if (!entry) return undefined
    const fragment = url.hash ? urlToXref.fragmentId(url.hash) : ''
    let heading
    if (fragment) {
      const anchors = targetAnchors(entry.page, urls.resolveInclude)
      if (!anchors || !anchors.has(fragment)) return undefined
      heading = anchors.get(fragment)
    }
    // A trailing ^ opens a URL link in a new window; an xref would print it.
    const given = (match.label || '').replace(/\^$/, '').trim()
    if (entry.module === PAGE_MODULE && entry.relative.startsWith(PAGE_DIR)) {
      const command = commandOfPage(tree, entry.relative)
      if (command) return commandLink(entry.relative, fragment, given || `\`${cmdText(command.names)}\``)
    }
    const shown = given || heading || pageTitle(entry.page)
    const spec = `${entry.module}:${entry.relative}`
    const own = entry.component === component
      ? findPage(contentCatalog, spec, { component, version, module: entry.module })
      : ownAlias(entry.module, entry.relative)
    if (own) return `xref:${spec}${fragment ? `#${fragment}` : ''}[${shown}]`
    if (cloud) {
      unlinked.push(match.url)
      // A bare URL would still autolink, so one with no text to show is escaped.
      return shown || `\\${match.url}`
    }
    return urlToXref.entryToXref(entry, fragment ? `#${fragment}` : '', shown)
  }
  const relinkUrls = (out) => {
    if (!urls) return out
    let result = ''
    let cursor = 0
    for (const match of scanContentUrls(out)) {
      const replacement = relinkUrl(match)
      if (replacement === undefined) continue
      result += out.slice(cursor, match.start) + replacement
      cursor = match.end
    }
    return result + out.slice(cursor)
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
  return { text: relinkUrls(lines.join('\n')), unlinked }
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
  replacementCommand,
  deprecationAdvice,
  rewriteCommandWords,
  aliasNote,
  deprecationSentence,
}
