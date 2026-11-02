'use strict'

/**
 * Runs the feature modules in features/index.js for each LSP request.
 *
 * A feature module is a plain object. Only `id` is required; every hook is
 * optional and the server advertises a capability only when some module
 * implements it:
 *
 *   {
 *     id: 'example',                    // unique; also the key of ws.data
 *     languages: ['asciidoc'],          // document languages the hooks see (default ['asciidoc'])
 *     watch: [/enterprise-features\.yml$/],  // changed files that reload the workspace
 *     triggerCharacters: [':'],         // completion triggers, unioned
 *     codeActionKinds: ['quickfix'],    // advertised code action kinds, unioned
 *     async load (ws, ctx) {},          // returns this module's data, stored at ws.data[id]
 *     diagnostics (doc, ws) {},         // -> Diagnostic[]
 *     completion (doc, position, ws, params) {},   // -> CompletionItem[]
 *     hover (doc, position, ws, params) {},        // -> Hover | null
 *     codeActions (doc, diagnostics, ws, params) {}, // -> CodeAction[]
 *     codeLens (doc, ws, params) {},               // -> CodeLens[]
 *     definition (doc, position, ws, params) {},   // -> Location | Location[] | null
 *     documentLinks (doc, ws, params) {},          // -> DocumentLink[]
 *     commands: { 'redpandaDocs.example': async (args, ws, ctx) => {} },
 *   }
 *
 * `doc` is { uri, languageId, version, text }. `ws` is the component
 * workspace from workspace.js: shared build data (component, properties,
 * taxonomy, ...) plus ws.data[id] from each module's load. Any hook may
 * return a promise.
 *
 * Results are concatenated in registry order; hover returns the first
 * non-null result. A module whose load failed is skipped for that workspace
 * (ws.disabled[id] holds the reason), and a hook that throws is reported
 * through onError and contributes nothing, so one broken module never takes
 * the others down.
 */

const registry = require('./features')

const DEFAULT_LANGUAGES = ['asciidoc']
const LANGUAGE_BY_EXTENSION = { '.adoc': 'asciidoc', '.asciidoc': 'asciidoc', '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml' }

/** The language of a document, from the client or else its file extension. */
function languageOf (doc) {
  if (doc.languageId) return doc.languageId
  const m = /(\.[^./]+)$/.exec(String(doc.uri || ''))
  return (m && LANGUAGE_BY_EXTENSION[m[1].toLowerCase()]) || 'asciidoc'
}

const isThenable = (v) => v && typeof v.then === 'function'
const union = (lists) => [...new Set(lists.flat())]

/**
 * @param {Array<Object>} [modules=features/index.js]
 * @param {Object} [options]
 * @param {Function} [options.onError] - (moduleId, hook, error) when a hook throws
 */
function createDispatcher (modules = registry, { onError = () => {} } = {}) {
  const ids = new Set()
  const commands = new Map()
  for (const m of modules) {
    if (!m || typeof m.id !== 'string' || !m.id) throw new Error('docs language server: every feature module needs an id')
    if (ids.has(m.id)) throw new Error(`docs language server: two feature modules have the id '${m.id}'`)
    ids.add(m.id)
    for (const [name, handler] of Object.entries(m.commands || {})) {
      if (commands.has(name)) throw new Error(`docs language server: '${name}' is registered by both ${commands.get(name).id} and ${m.id}`)
      commands.set(name, { id: m.id, handler })
    }
  }

  const has = (hook) => modules.some((m) => typeof m[hook] === 'function')

  /** The modules that handle `hook` for this document in this workspace. */
  const active = (hook, doc, ws) => {
    const language = languageOf(doc)
    return modules.filter((m) => typeof m[hook] === 'function' &&
      !(ws && ws.disabled && ws.disabled[m.id]) &&
      (m.languages || DEFAULT_LANGUAGES).includes(language))
  }

  /**
   * Calls `hook` on every active module and merges the results. Synchronous
   * when every hook is, so plain-text callers get values, not promises.
   */
  const run = (hook, doc, ws, args, merge) => {
    const results = active(hook, doc, ws).map((m) => {
      try {
        const out = m[hook](doc, ...args)
        return isThenable(out) ? Promise.resolve(out).catch((err) => { onError(m.id, hook, err); return null }) : out
      } catch (err) {
        onError(m.id, hook, err)
        return null
      }
    })
    return results.some(isThenable) ? Promise.all(results).then(merge) : merge(results)
  }

  const concat = (results) => results.flatMap((r) => (r == null ? [] : Array.isArray(r) ? r : [r]))
  const first = (results) => results.find((r) => r != null) || null

  return {
    modules,

    /** The server capabilities these modules need, unioned. */
    capabilities () {
      const caps = {}
      if (has('completion')) caps.completionProvider = { triggerCharacters: union(modules.map((m) => m.triggerCharacters || [])) }
      if (has('hover')) caps.hoverProvider = true
      if (has('codeActions')) caps.codeActionProvider = { codeActionKinds: union(modules.filter((m) => m.codeActions).map((m) => m.codeActionKinds || ['quickfix'])) }
      if (has('codeLens')) caps.codeLensProvider = { resolveProvider: false }
      if (has('definition')) caps.definitionProvider = true
      if (has('documentLinks')) caps.documentLinkProvider = { resolveProvider: false }
      if (commands.size) caps.executeCommandProvider = { commands: [...commands.keys()] }
      return caps
    },

    /** Every module's reload patterns. */
    watch: modules.flatMap((m) => m.watch || []),

    diagnostics: (doc, ws) => run('diagnostics', doc, ws, [ws], concat),
    completion: (doc, position, ws, params) => run('completion', doc, ws, [position, ws, params], concat),
    hover: (doc, position, ws, params) => run('hover', doc, ws, [position, ws, params], first),
    codeActions: (doc, diagnostics, ws, params) => run('codeActions', doc, ws, [diagnostics, ws, params], concat),
    codeLens: (doc, ws, params) => run('codeLens', doc, ws, [ws, params], concat),
    definition: (doc, position, ws, params) => run('definition', doc, ws, [position, ws, params], concat),
    documentLinks: (doc, ws, params) => run('documentLinks', doc, ws, [ws, params], concat),

    /** Runs a registered command; resolves to undefined for an unknown name. */
    async executeCommand (name, args, ws, ctx) {
      const entry = commands.get(name)
      if (!entry) return undefined
      if (ws && ws.disabled && ws.disabled[entry.id]) throw new Error(`${name} is unavailable: ${ws.disabled[entry.id]}`)
      return entry.handler(args || [], ws, ctx)
    },
  }
}

/**
 * The same requests over plain page text, for tests and scripts:
 * diagnostics(text, ws), completion(text, position, ws), hover(text,
 * position, ws) and codeActions(text, diagnostics, ws, uri).
 */
function forText (dispatcher = createDispatcher()) {
  const doc = (text, uri = 'file:///page.adoc') => ({ uri, languageId: 'asciidoc', version: 1, text: String(text) })
  return {
    diagnostics: (text, ws) => dispatcher.diagnostics(doc(text), ws),
    completion: (text, position, ws) => dispatcher.completion(doc(text), position, ws),
    hover: (text, position, ws) => dispatcher.hover(doc(text), position, ws),
    codeActions: (text, diagnostics, ws, uri) => dispatcher.codeActions(doc(text, uri), diagnostics, ws),
  }
}

module.exports = { createDispatcher, forText, languageOf }
