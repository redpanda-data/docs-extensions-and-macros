'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const { maskComments, skipString, findBalancedClose, splitTopLevelArgs, unescapeGo } = require('./go-source')

/**
 * A package-aware index over a Go module, for surfaces whose doc strings are
 * assembled from more than one file.
 *
 * The plain helpers in go-source.js evaluate a string expression against the
 * constants of ONE file. Connect builds most of its published text across
 * files and packages: a description concatenates a constant from a sibling
 * file, calls a helper that returns a string, or embeds a field name constant
 * from another package (`kafka.FranzMaxInFlightDescription`). This index
 * loads packages on demand, records their top-level constants, variables and
 * functions, and evaluates string expressions against them.
 *
 * Same philosophy as the rest of lint-strings: a comment-masked scanner over
 * real source text, never a compiler. When an expression cannot be resolved
 * it is never guessed at. The evaluator returns the parts it could resolve
 * and names each part it could not, so a caller can report the gap instead
 * of dropping the declaration.
 *
 * Packages outside the module resolve through the Go module cache when it
 * holds the version go.mod requires (GOMODCACHE, or ~/go/pkg/mod). In CI the
 * cache is usually absent, and those parts stay unresolved.
 */

const PLACEHOLDER = (n) => `{{unresolved:${n}}}`
const PLACEHOLDER_RE = /\{\{unresolved:\d+\}\}/g
const MAX_DEPTH = 12

/** Byte offset -> 1-indexed line, by binary search over line starts. */
function makeLineIndex (content) {
  const starts = [0]
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') starts.push(i + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/**
 * Bracket matches for (), [] and {} over comment-masked content, skipping
 * string and rune literals. Returns Map(offset -> partner offset) in both
 * directions, which is what lets a scanner walk a builder chain backwards.
 */
function bracketPairs (masked) {
  const pairs = new Map()
  const stack = []
  let i = 0
  while (i < masked.length) {
    const ch = masked[i]
    if (ch === '"' || ch === '`' || ch === "'") {
      i = skipString(masked, i)
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') stack.push(i)
    else if (ch === ')' || ch === ']' || ch === '}') {
      const open = stack.pop()
      if (open !== undefined) {
        pairs.set(open, i)
        pairs.set(i, open)
      }
    }
    i++
  }
  return pairs
}

/**
 * End offset of the Go statement starting at `start`: the first newline
 * outside strings and brackets that does not follow a continuation token
 * (`+`, `.`, `,`, an opening bracket, a binary operator). Go's automatic
 * semicolon insertion works the same way.
 */
function statementEnd (masked, start, limit = masked.length) {
  let depth = 0
  let i = start
  while (i < limit) {
    const ch = masked[i]
    if (ch === '"' || ch === '`' || ch === "'") {
      i = skipString(masked, i)
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i
      depth--
    } else if ((ch === '\n' || ch === ';') && depth === 0) {
      if (ch === ';') return i
      // The last token before the newline decides, as in Go's semicolon
      // insertion: a blank line, or a comment line (masked to spaces),
      // inside a builder chain does not end the statement.
      let k = i - 1
      while (k >= start && /\s/.test(masked[k])) k--
      if (k < start || !/[+.,([{|&=:*/-]/.test(masked[k])) return i
    }
    i++
  }
  return limit
}

/** Split text on top-level occurrences of a single-character operator. */
function splitTopLevel (text, op) {
  const parts = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === '`' || ch === "'") {
      i = skipString(text, i)
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === op && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
    i++
  }
  parts.push(text.slice(start))
  return parts
}

/** Parse `a, b string, c *T` into [{ name, type }]. */
function parseParams (text) {
  const raw = splitTopLevelArgs(text).map((p) => p.trim()).filter(Boolean)
  const params = []
  let pendingNames = []
  for (const entry of raw) {
    const m = entry.match(/^([A-Za-z_]\w*)\s+(.+)$/s)
    if (m) {
      for (const name of pendingNames) params.push({ name, type: m[2].trim() })
      pendingNames = []
      params.push({ name: m[1], type: m[2].trim() })
    } else if (/^[A-Za-z_]\w*$/.test(entry)) {
      pendingNames.push(entry)
    } else {
      params.push({ name: null, type: entry })
    }
  }
  for (const name of pendingNames) params.push({ name: null, type: name })
  return params
}

/**
 * Top-level declarations of one comment-masked file: functions (with body
 * offsets), const/var entries (with their raw expression), and imports.
 */
function scanTopLevel (masked, pairs) {
  const funcs = []
  const values = []
  const imports = new Map()
  let pkg = null
  const pkgMatch = masked.match(/^\s*package\s+([A-Za-z_]\w*)/m)
  if (pkgMatch) pkg = pkgMatch[1]

  let i = 0
  let depth = 0
  const n = masked.length
  const keywordAt = (kw) => masked.startsWith(kw, i) && (i === 0 || /\s/.test(masked[i - 1])) &&
    /[\s(]/.test(masked[i + kw.length] || '')
  while (i < n) {
    const ch = masked[i]
    if (ch === '"' || ch === '`' || ch === "'") {
      i = skipString(masked, i)
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; i++; continue }
    if (depth !== 0) { i++; continue }

    if (keywordAt('import')) {
      let j = i + 6
      while (/\s/.test(masked[j])) j++
      let region
      let end
      if (masked[j] === '(') {
        end = pairs.get(j)
        region = masked.slice(j + 1, end)
      } else {
        end = statementEnd(masked, j)
        region = masked.slice(j, end)
      }
      for (const m of region.matchAll(/(?:^|\n|;)\s*([A-Za-z_]\w*|\.|_)?\s*"([^"]+)"/g)) {
        imports.set(m[1] || null, m[2])
        if (!m[1]) imports.set(`\0${m[2]}`, m[2])
      }
      i = end + 1
      continue
    }

    if (keywordAt('func')) {
      const fn = parseFunc(masked, pairs, i)
      if (fn) {
        funcs.push(fn)
        i = fn.bodyEnd + 1
        continue
      }
      i += 4
      continue
    }

    if (keywordAt('const') || keywordAt('var')) {
      const kind = masked.startsWith('const', i) ? 'const' : 'var'
      let j = i + kind.length
      while (/[ \t]/.test(masked[j])) j++
      if (masked[j] === '(') {
        const end = pairs.get(j)
        if (end === undefined) { i++; continue }
        let k = j + 1
        while (k < end) {
          while (k < end && /\s/.test(masked[k])) k++
          if (k >= end) break
          const stop = statementEnd(masked, k, end)
          const entry = parseValueEntry(masked, k, stop, kind)
          if (entry) values.push(entry)
          k = stop + 1
        }
        i = end + 1
      } else {
        const stop = statementEnd(masked, j)
        const entry = parseValueEntry(masked, j, stop, kind)
        if (entry) values.push(entry)
        i = stop + 1
      }
      continue
    }
    i++
  }
  return { pkg, funcs, values, imports }
}

/** Parse one `name [type] [= expr]` const/var entry between start and stop. */
function parseValueEntry (masked, start, stop, kind) {
  const text = masked.slice(start, stop)
  const m = text.match(/^([A-Za-z_]\w*)\s*([^=]*?)\s*(?:=(?!=)\s*([\s\S]*))?$/)
  if (!m) return null
  const exprText = m[3] === undefined ? null : m[3]
  const exprStart = exprText === null ? null : start + text.length - exprText.length
  return {
    kind,
    name: m[1],
    type: (m[2] || '').trim() || null,
    expr: exprText,
    exprStart,
    start,
    end: stop
  }
}

/** Parse a top-level func declaration starting at the `func` keyword. */
function parseFunc (masked, pairs, at) {
  let j = at + 4
  const skipWs = () => { while (/\s/.test(masked[j])) j++ }
  skipWs()
  let recv = null
  if (masked[j] === '(') {
    const close = pairs.get(j)
    if (close === undefined) return null
    recv = masked.slice(j + 1, close).trim()
    j = close + 1
    skipWs()
  }
  const nameMatch = masked.slice(j).match(/^([A-Za-z_]\w*)/)
  if (!nameMatch) return null
  const name = nameMatch[1]
  j += name.length
  skipWs()
  if (masked[j] === '[') {
    const close = pairs.get(j)
    if (close === undefined) return null
    j = close + 1
    skipWs()
  }
  if (masked[j] !== '(') return null
  const paramsClose = pairs.get(j)
  if (paramsClose === undefined) return null
  const params = parseParams(masked.slice(j + 1, paramsClose))
  j = paramsClose + 1
  // Results run to the body brace. A newline at depth 0 first means a
  // declaration with no body (assembly stub).
  const resultsStart = j
  while (j < masked.length && masked[j] !== '{') {
    if (masked[j] === '\n') return null
    if (masked[j] === '(' || masked[j] === '[') {
      const close = pairs.get(j)
      if (close === undefined) return null
      j = close + 1
      continue
    }
    j++
  }
  const bodyStart = j
  const bodyEnd = pairs.get(bodyStart)
  if (bodyEnd === undefined) return null
  return {
    name,
    recv,
    params,
    results: masked.slice(resultsStart, bodyStart).trim(),
    start: at,
    bodyStart,
    bodyEnd
  }
}

/** The Go module path and requirements from go.mod. */
function readGoMod (repo) {
  const file = path.join(repo, 'go.mod')
  if (!fs.existsSync(file)) return { module: null, requires: new Map(), replaces: new Map() }
  const text = maskComments(fs.readFileSync(file, 'utf8'))
  const moduleMatch = text.match(/^\s*module\s+(\S+)/m)
  const requires = new Map()
  for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9][\w.\-/]*\.[\w.\-/]+)\s+(v[\w.\-+]+)\s*$/gm)) {
    requires.set(m[1], m[2])
  }
  const replaces = new Map()
  for (const m of text.matchAll(/^\s*(?:replace\s+)?(\S+)\s*=>\s*(\S+)\s+(v\S+)\s*$/gm)) {
    replaces.set(m[1], { path: m[2], version: m[3] })
  }
  return { module: moduleMatch ? moduleMatch[1] : null, requires, replaces }
}

/** Module cache escaping: uppercase letters become !lowercase. */
function escapeModulePath (p) {
  return p.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)
}

function moduleCacheDir () {
  if (process.env.GOMODCACHE) return process.env.GOMODCACHE
  if (process.env.GOPATH) return path.join(process.env.GOPATH.split(path.delimiter)[0], 'pkg', 'mod')
  return path.join(os.homedir(), 'go', 'pkg', 'mod')
}

class GoIndex {
  /**
   * @param {string} repo - Module root (the directory holding go.mod)
   * @param {Object} [options]
   * @param {boolean} [options.external=true] - Resolve packages outside the
   *   module through the Go module cache when it holds them
   */
  constructor (repo, { external = true, overlay = null } = {}) {
    this.repo = path.resolve(repo)
    // In-memory files (abs path -> content), consulted before the disk, so
    // a single file can be scanned without a checkout (tests, previews).
    this.overlay = new Map()
    if (overlay) for (const [file, content] of overlay) this.overlay.set(path.resolve(this.repo, file), content)
    this.gomod = readGoMod(this.repo)
    this.external = external
    this.files = new Map() // abs path -> FileInfo
    this.packages = new Map() // abs dir -> PackageInfo
    this.memo = new Map()
  }

  /** Repo-relative path for an absolute path inside the module. */
  rel (abs) {
    return path.relative(this.repo, abs)
  }

  /** Load (and cache) one file. */
  file (absPath) {
    if (this.files.has(absPath)) return this.files.get(absPath)
    let content
    if (this.overlay.has(absPath)) {
      content = this.overlay.get(absPath)
    } else {
      try {
        content = fs.readFileSync(absPath, 'utf8')
      } catch {
        this.files.set(absPath, null)
        return null
      }
    }
    const masked = maskComments(content)
    const pairs = bracketPairs(masked)
    const top = scanTopLevel(masked, pairs)
    const build = content.match(/^\/\/go:build\s+(.+)$/m)
    const info = {
      abs: absPath,
      dir: path.dirname(absPath),
      content,
      masked,
      pairs,
      lineOf: makeLineIndex(content),
      pkg: top.pkg,
      funcs: top.funcs,
      values: top.values,
      imports: top.imports,
      buildConstraint: build ? build[1].trim() : null
    }
    this.files.set(absPath, info)
    return info
  }

  /** Load (and cache) every non-test file of the package in `dir`. */
  package (dir) {
    if (this.packages.has(dir)) return this.packages.get(dir)
    const pkg = { dir, name: null, files: [], funcs: new Map(), values: new Map(), methods: new Map() }
    this.packages.set(dir, pkg)
    const names = new Set()
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isFile()) names.add(entry.name)
    } catch {}
    for (const file of this.overlay.keys()) if (path.dirname(file) === dir) names.add(path.basename(file))
    for (const name of [...names].sort()) {
      if (!name.endsWith('.go') || name.endsWith('_test.go')) continue
      const info = this.file(path.join(dir, name))
      if (!info) continue
      pkg.files.push(info)
      if (!pkg.name) pkg.name = info.pkg
      for (const fn of info.funcs) {
        const target = fn.recv ? pkg.methods : pkg.funcs
        if (!target.has(fn.name)) target.set(fn.name, { ...fn, file: info })
      }
      for (const value of info.values) {
        if (!pkg.values.has(value.name)) pkg.values.set(value.name, { ...value, file: info })
      }
    }
    return pkg
  }

  /** Directory of an import path, or null when it is not resolvable. */
  importDir (importPath) {
    const mod = this.gomod.module
    if (mod && (importPath === mod || importPath.startsWith(`${mod}/`))) {
      return path.join(this.repo, importPath.slice(mod.length))
    }
    if (!this.external) return null
    let best = null
    for (const [modPath, version] of this.gomod.requires) {
      if ((importPath === modPath || importPath.startsWith(`${modPath}/`)) && (!best || modPath.length > best[0].length)) {
        best = [modPath, version]
      }
    }
    if (!best) return null
    const [modPath, version] = best
    const replaced = this.gomod.replaces.get(modPath)
    const source = replaced ? replaced.path : modPath
    const ver = replaced ? replaced.version : version
    const dir = path.join(moduleCacheDir(), `${escapeModulePath(source)}@${ver}`, importPath.slice(modPath.length))
    return fs.existsSync(dir) ? dir : null
  }

  /** The package an identifier qualifier names in `file`, or null. */
  importedPackage (file, alias) {
    let importPath = file.imports.get(alias)
    if (!importPath) {
      // An unaliased import is named by its package clause, which is
      // usually, but not always, the last path element.
      for (const [key, value] of file.imports) {
        if (key !== null && key.startsWith('\0')) {
          const last = value.split('/').filter((s) => !/^v\d+$/.test(s)).pop()
          if (last === alias || last.replace(/-/g, '_') === alias) { importPath = value; break }
        }
      }
    }
    if (!importPath) {
      for (const [key, value] of file.imports) {
        if (key === null || !key.startsWith('\0')) continue
        const dir = this.importDir(value)
        if (dir && this.package(dir).name === alias) { importPath = value; break }
      }
    }
    if (!importPath) return null
    return { importPath, dir: this.importDir(importPath) }
  }

  /** True when `alias` in `file` imports a path ending in `suffix`. */
  importIs (file, alias, suffix) {
    const imported = this.importedPackage(file, alias)
    return Boolean(imported && imported.importPath.endsWith(suffix))
  }

  /**
   * Look up a function by callee text (`name` or `pkg.Name`) as seen from
   * `file`. Returns the function record or null.
   */
  lookupFunc (file, callee) {
    const dot = callee.indexOf('.')
    if (dot === -1) {
      return this.package(file.dir).funcs.get(callee) || null
    }
    const alias = callee.slice(0, dot)
    const name = callee.slice(dot + 1)
    if (name.includes('.')) return null
    const imported = this.importedPackage(file, alias)
    if (!imported || !imported.dir) return null
    return this.package(imported.dir).funcs.get(name) || null
  }

  /** Same as lookupFunc, for a top-level const or var. */
  lookupValue (file, ident) {
    const dot = ident.indexOf('.')
    if (dot === -1) return this.package(file.dir).values.get(ident) || null
    const alias = ident.slice(0, dot)
    const name = ident.slice(dot + 1)
    if (name.includes('.')) return null
    const imported = this.importedPackage(file, alias)
    if (!imported || !imported.dir) return null
    return this.package(imported.dir).values.get(name) || null
  }

  /**
   * Evaluate a Go string expression.
   *
   * @param {string} exprText - Comment-masked expression text
   * @param {Object} ctx - { file, locals?: Map(name -> Result), depth? }
   * @returns {{ parts: Array<{text}|{unresolved}>, sawString: boolean }}
   *   Each unresolved part names the source text that could not be
   *   evaluated. Use renderResult() to turn it into a string.
   */
  evalString (exprText, ctx) {
    const depth = ctx.depth || 0
    const parts = []
    let sawString = false
    if (depth > MAX_DEPTH) return { parts: [{ unresolved: exprText.trim() }], sawString: false }
    for (const rawTerm of splitTopLevel(exprText, '+')) {
      const term = rawTerm.trim()
      if (term === '') continue
      const r = this.evalTerm(term, { ...ctx, depth })
      if (r.sawString) sawString = true
      parts.push(...r.parts)
    }
    return { parts: mergeParts(parts), sawString }
  }

  evalTerm (term, ctx) {
    const unresolved = { parts: [{ unresolved: term }], sawString: false }
    // A constant slice of a string, as in `...`[1:] (drops a raw string's
    // leading newline).
    const slice = term.match(/\[\s*(\d*)\s*:\s*(\d*)\s*\]$/)
    if (slice && term.length > slice[0].length) {
      const baseText = term.slice(0, term.length - slice[0].length)
      const open = term.length - slice[0].length
      const base = term[open - 1] === ')' || term[open - 1] === '`' || term[open - 1] === '"' || /\w/.test(term[open - 1])
        ? this.evalTerm(baseText.trim(), ctx)
        : null
      if (!base || !isResolved(base)) return unresolved
      const text = renderResult(base)
      const from = slice[1] === '' ? 0 : Number(slice[1])
      const to = slice[2] === '' ? text.length : Number(slice[2])
      if (from > to || to > text.length) return unresolved
      return { parts: [{ text: text.slice(from, to) }], sawString: true }
    }
    const first = term[0]
    if (first === '"' || first === '`') {
      const end = skipString(term, 0)
      if (end !== term.length) return unresolved
      const body = term.slice(1, end - 1)
      return { parts: [{ text: first === '"' ? unescapeGo(body) : body.replace(/\r/g, '') }], sawString: true }
    }
    if (first === '(') {
      const close = findBalancedClose(term, 0)
      if (close !== term.length - 1) return unresolved
      return this.evalString(term.slice(1, -1), { ...ctx, depth: ctx.depth + 1 })
    }
    const call = term.match(/^([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)?)\s*\(/)
    if (call) {
      const open = term.indexOf('(', call[1].length)
      const close = findBalancedClose(term, open)
      if (close !== term.length - 1) return unresolved
      return this.evalCall(call[1], term.slice(open + 1, close), ctx, term)
    }
    if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(term)) {
      return this.evalIdent(term, ctx)
    }
    return unresolved
  }

  evalIdent (ident, ctx) {
    const unresolved = { parts: [{ unresolved: ident }], sawString: false }
    if (ctx.locals && ctx.locals.has(ident)) return ctx.locals.get(ident)
    // A function-local variable or parameter shadows the package scope.
    // The resolver returns undefined for "not a local", null for "a local
    // whose value cannot be known here".
    if (ctx.resolveLocal && !ident.includes('.')) {
      const local = ctx.resolveLocal(ident, ctx)
      if (local === null) return unresolved
      if (local !== undefined) return local
    }
    const value = this.lookupValue(ctx.file, ident)
    if (value && value.expr === null) {
      // `//go:embed file` on a string var: the file is the value.
      const embedded = this.embeddedString(value)
      if (embedded !== null) return { parts: [{ text: embedded }], sawString: true }
    }
    if (!value || value.expr === null) return unresolved
    const key = `${value.file.abs}\0${value.name}`
    if (this.memo.has(key)) return this.memo.get(key) || unresolved
    this.memo.set(key, null) // cycle guard
    const r = this.evalString(value.expr, { file: value.file, depth: ctx.depth + 1 })
    const result = r.sawString ? r : unresolved
    this.memo.set(key, result)
    return result
  }

  evalCall (callee, argText, ctx, term) {
    const unresolved = { parts: [{ unresolved: term }], sawString: false }
    const args = splitTopLevelArgs(argText).map((a) => a.trim()).filter((a) => a !== '')
    const sub = { ...ctx, depth: ctx.depth + 1 }

    // string(x): a typed string constant converted back to string.
    if (callee === 'string' && args.length === 1) {
      const r = this.evalString(args[0], sub)
      return r.sawString ? r : unresolved
    }

    const dot = callee.indexOf('.')
    const alias = dot === -1 ? null : callee.slice(0, dot)
    const fnName = dot === -1 ? callee : callee.slice(dot + 1)
    const stdlib = alias && this.stdlibName(ctx.file, alias)
    if (stdlib === 'fmt' && fnName === 'Sprintf' && args.length >= 1) {
      return this.evalSprintf(args, sub, term)
    }
    if (stdlib === 'strings' && fnName === 'Join' && args.length === 2) {
      const list = this.evalStringList(args[0], sub)
      const sep = this.evalString(args[1], sub)
      if (!list || !isResolved(sep) || !list.some((r) => r.sawString)) return unresolved
      const parts = []
      list.forEach((r, i) => {
        if (i > 0) parts.push({ text: renderResult(sep) })
        parts.push(...r.parts)
      })
      return { parts: mergeParts(parts), sawString: true }
    }
    if (stdlib === 'strings' && ((fnName === 'ReplaceAll' && args.length === 3) || (fnName === 'Replace' && args.length === 4))) {
      const r = this.evalString(args[0], sub)
      const from = this.evalString(args[1], sub)
      const to = this.evalString(args[2], sub)
      const n = fnName === 'Replace' ? Number(args[3]) : -1
      if (!isResolved(r) || !isResolved(from) || !Number.isInteger(n)) return unresolved
      const needle = renderResult(from)
      if (needle === '') return unresolved
      // The replacement may itself be partial: splice its parts in.
      const pieces = renderResult(r).split(needle)
      const parts = []
      pieces.forEach((piece, i) => {
        if (i > 0) parts.push(...(n < 0 || i <= n ? to.parts : [{ text: needle }]))
        parts.push({ text: piece })
      })
      return { parts: mergeParts(parts.filter((p) => p.text !== '')), sawString: true }
    }
    if (stdlib === 'strconv' && fnName === 'Itoa' && args.length === 1) {
      const n = this.evalInt(args[0], sub)
      return n === null ? unresolved : { parts: [{ text: String(n) }], sawString: true }
    }
    if (stdlib === 'strings' && /^(TrimSpace|ToLower|ToUpper|Title)$/.test(fnName) && args.length === 1) {
      const r = this.evalString(args[0], sub)
      if (!isResolved(r)) return unresolved
      const s = renderResult(r)
      const out = fnName === 'TrimSpace'
        ? s.trim()
        : fnName === 'ToLower' ? s.toLowerCase() : fnName === 'ToUpper' ? s.toUpperCase() : s.replace(/\b\w/g, (c) => c.toUpperCase())
      return { parts: [{ text: out }], sawString: true }
    }

    // A function in this module (or a cached dependency) whose body runs
    // straight to one return statement, with its parameters bound to the
    // call arguments and its local string variables followed. Anything with
    // control flow stays unresolved.
    const fn = this.lookupFunc(ctx.file, callee)
    if (!fn) return unresolved
    const ret = straightLineReturn(fn)
    if (ret === null) {
      const r = this.interpretBranches(fn, args, sub)
      return r && r.sawString ? r : unresolved
    }
    const locals = new Map()
    // Every parameter shadows the package scope, so one that does not
    // evaluate to a string is bound to an unresolved part, never left to
    // fall through to a same-named package constant.
    fn.params.forEach((param, i) => {
      if (!param.name) return
      const arg = i < args.length && !/^\.\.\./.test(param.type) ? args[i] : null
      const r = arg === null ? null : this.evalString(arg, sub)
      locals.set(param.name, r && r.sawString ? r : { parts: [{ unresolved: arg === null ? param.name : arg }], sawString: false })
    })
    const r = this.evalString(ret.expr, {
      file: fn.file,
      locals,
      depth: ctx.depth + 1,
      resolveLocal: this.localResolver(fn.file, fn, ret.offset)
    })
    return r.sawString ? r : unresolved
  }

  /**
   * A resolver for the local variables of `fn` as they stand at `offset`
   * (an offset into fn.file.masked). Follows `x := expr`, `x = expr`,
   * `var x = expr` and `x += expr` assignments in the function body.
   *
   * Returns a function (ident, ctx) -> Result | null | undefined:
   * undefined when the identifier is not a local of fn (so the package
   * scope applies), null when it is a local or parameter whose value cannot
   * be known here (assigned under a condition, in a loop, from a tuple).
   */
  localResolver (file, fn, offset) {
    if (!fn) return undefined
    const masked = file.masked
    const body = { start: fn.bodyStart, end: Math.min(fn.bodyEnd, offset) }
    const params = new Set(fn.params.map((p) => p.name).filter(Boolean))
    const pairs = file.pairs
    // Brace depth of a position relative to the body: an assignment deeper
    // than the declaration it updates runs conditionally.
    const depthAt = (pos) => {
      let depth = 0
      for (let i = fn.bodyStart + 1; i < pos; i++) {
        const ch = masked[i]
        if (ch === '"' || ch === '`' || ch === "'") { i = skipString(masked, i) - 1; continue }
        if (ch === '{') {
          const close = pairs.get(i)
          if (close !== undefined && close < pos) { i = close; continue }
          depth++
        }
      }
      return depth
    }
    const assignmentsOf = (ident, before) => {
      const out = []
      const text = masked.slice(body.start, before)
      const forms = [
        new RegExp(`(^|[^\\w.])${ident}\\s*(:=|\\+=|=)(?!=)`, 'g'),
        new RegExp(`(^|[^\\w.])var\\s+${ident}\\b[^=\\n;]*(=)(?!=)`, 'g')
      ]
      for (const re of forms) {
        let m
        while ((m = re.exec(text)) !== null) {
          const at = body.start + m.index + m[1].length
          // `a, b := f()` binds a tuple: never a plain string value.
          let k = at - 1
          while (k > body.start && /[ \t]/.test(masked[k])) k--
          if (masked[k] === ',') { out.push({ tuple: true, at }); continue }
          const exprStart = body.start + m.index + m[0].length
          const exprEnd = statementEnd(masked, exprStart, fn.bodyEnd)
          out.push({ op: m[2] === '=' && re === forms[1] ? ':=' : m[2], at, exprStart, exprEnd, depth: depthAt(at) })
        }
      }
      return out.sort((a, b) => a.at - b.at)
    }
    const resolveAt = (ident, before, ctx) => {
      const list = assignmentsOf(ident, before)
      if (list.length === 0) return params.has(ident) ? null : undefined
      if (list.some((a) => a.tuple)) return null
      const declIndex = list.map((a) => a.op).lastIndexOf(':=')
      const startIndex = declIndex === -1 ? 0 : declIndex
      const relevant = list.slice(startIndex)
      const baseDepth = relevant[0].depth
      if (relevant.some((a) => a.depth !== baseDepth)) return null
      // The last plain assignment wins; += after it appends.
      let from = relevant.length - 1
      while (from > 0 && relevant[from].op === '+=') from--
      // An append with no plain assignment before it extends a value this
      // body never set (a parameter or a package variable).
      if (relevant[from].op === '+=') return null
      const parts = []
      let sawString = false
      for (const a of relevant.slice(from)) {
        const sub = {
          file,
          depth: (ctx.depth || 0) + 1,
          locals: ctx.locals,
          resolveLocal: (id, c) => resolveAt(id, a.at, c)
        }
        const r = this.evalString(masked.slice(a.exprStart, a.exprEnd), sub)
        if (r.sawString) sawString = true
        parts.push(...r.parts)
      }
      return sawString ? { parts: mergeParts(parts), sawString } : null
    }
    return (ident, ctx) => resolveAt(ident, body.end, ctx || {})
  }

  /**
   * The contents of the file a `//go:embed <file>` directive above a
   * string var names, or null. Patterns and multiple files are not a
   * single string, so they stay unresolved.
   */
  embeddedString (value) {
    if (value.kind !== 'var' || !/^string$/.test(value.type || '')) return null
    const before = value.file.content.slice(0, value.start)
    const m = before.match(/\/\/go:embed[ \t]+(\S+)[ \t]*\r?\n\s*(?:var\s*)?$/)
    if (!m || /[*?[]/.test(m[1])) return null
    const abs = path.join(value.file.dir, m[1])
    if (this.overlay.has(abs)) return this.overlay.get(abs)
    try {
      return fs.readFileSync(abs, 'utf8')
    } catch {
      return null
    }
  }

  /**
   * The values of a call to a function that returns several strings, as in
   * `spec.Example(exampleConfig())` where exampleConfig returns a title,
   * a summary and a config. Returns an array of Results, or null.
   */
  evalTuple (callText, ctx) {
    const call = callText.trim().match(/^([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)?)\s*\(/)
    if (!call) return null
    const open = callText.trim().indexOf('(', call[1].length)
    const close = findBalancedClose(callText.trim(), open)
    if (close !== callText.trim().length - 1) return null
    const fn = this.lookupFunc(ctx.file, call[1])
    if (!fn || !/^\(/.test(fn.results)) return null
    const ret = straightLineReturn(fn)
    if (ret === null) return null
    const args = splitTopLevelArgs(callText.trim().slice(open + 1, close)).map((a) => a.trim()).filter(Boolean)
    const locals = new Map()
    fn.params.forEach((param, i) => {
      if (!param.name) return
      const r = i < args.length ? this.evalString(args[i], { ...ctx, depth: (ctx.depth || 0) + 1 }) : null
      locals.set(param.name, r && r.sawString ? r : { parts: [{ unresolved: param.name }], sawString: false })
    })
    const sub = { file: fn.file, locals, depth: (ctx.depth || 0) + 1, resolveLocal: this.localResolver(fn.file, fn, ret.offset) }
    return splitTopLevelArgs(ret.expr).map((e) => this.evalString(e, sub))
  }

  /**
   * An integer expression of literals and constants joined by + and -, as
   * in `strconv.Itoa(maxRetries-1)`. Returns a number or null.
   */
  evalInt (text, ctx) {
    const t = text.trim()
    if ((ctx.depth || 0) > MAX_DEPTH) return null
    const terms = t.match(/^[-+]?\s*[\w.]+(?:\s*[-+]\s*[\w.]+)*$/) ? t.split(/(?=[-+])/) : null
    if (!terms) return null
    let total = 0
    for (const raw of terms) {
      const m = raw.trim().match(/^([-+]?)\s*([\w.]+)$/)
      if (!m) return null
      let v
      if (/^\d+$/.test(m[2])) v = Number(m[2])
      else if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(m[2])) {
        const value = this.lookupValue(ctx.file, m[2])
        if (!value || value.kind !== 'const' || !value.expr) return null
        v = this.evalInt(value.expr, { file: value.file, depth: (ctx.depth || 0) + 1 })
        if (v === null) return null
      } else return null
      total += m[1] === '-' ? -v : v
    }
    return total
  }

  /** `[]string{...}` literal or an identifier bound to one. */
  evalStringList (text, ctx) {
    let t = text.trim()
    // A variadic parameter bound to the call's arguments.
    if (ctx.locals && ctx.locals.has(t) && ctx.locals.get(t).list) return [...ctx.locals.get(t).list]
    // append(list, a, b) and append(list, rest...): a variadic spread that
    // cannot be evaluated is one unresolved element.
    const app = t.match(/^append\s*\(/)
    if (app) {
      const open = app[0].length - 1
      const close = findBalancedClose(t, open)
      if (close !== t.length - 1) return null
      const parts = splitTopLevelArgs(t.slice(open + 1, close)).map((a) => a.trim()).filter(Boolean)
      if (parts.length === 0) return null
      const base = this.evalStringList(parts[0], ctx)
      if (!base) return null
      for (const item of parts.slice(1)) {
        if (item.endsWith('...')) {
          const spread = this.evalStringList(item.slice(0, -3), ctx)
          base.push(...(spread || [{ parts: [{ unresolved: item }], sawString: false }]))
        } else {
          base.push(this.evalString(item, ctx))
        }
      }
      return base
    }
    if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(t)) {
      const value = this.lookupValue(ctx.file, t)
      if (!value || !value.expr) return null
      t = value.expr.trim()
      ctx = { ...ctx, file: value.file }
    }
    const m = t.match(/^\[\]string\s*\{/)
    if (!m) return null
    const open = m[0].length - 1
    const close = findBalancedClose(t, open, '{', '}')
    if (close !== t.length - 1) return null
    return splitTopLevelArgs(t.slice(open + 1, close)).map((a) => a.trim()).filter(Boolean)
      .map((a) => this.evalString(a, ctx))
  }

  /**
   * fmt.Sprintf with a resolvable format. An argument that cannot be
   * evaluated becomes an unresolved part in place of its verb, so the rest
   * of the sentence still reaches the review.
   */
  evalSprintf (args, ctx, term) {
    const unresolved = { parts: [{ unresolved: term }], sawString: false }
    const format = this.evalString(args[0], ctx)
    if (!isResolved(format)) return unresolved
    const fmtText = renderResult(format)
    const parts = []
    let argIndex = 1
    let last = 0
    const verbs = /%([-+# 0]*\d*(?:\.\d+)?)([svqdtx%])/g
    let m
    while ((m = verbs.exec(fmtText)) !== null) {
      parts.push({ text: fmtText.slice(last, m.index) })
      last = m.index + m[0].length
      const [whole, flags, verb] = m
      if (verb === '%') { parts.push({ text: '%' }); continue }
      const arg = args[argIndex++]
      if (arg === undefined || flags) return unresolved
      const a = arg.trim()
      if (/^-?\d+$/.test(a) && (verb === 'd' || verb === 'v')) { parts.push({ text: a }); continue }
      if (/^(true|false)$/.test(a) && (verb === 't' || verb === 'v')) { parts.push({ text: a }); continue }
      const r = this.evalString(a, ctx)
      if (!isResolved(r)) {
        parts.push({ unresolved: a || whole })
        continue
      }
      const text = renderResult(r)
      if (verb === 'q') parts.push({ text: JSON.stringify(text) })
      else if (verb === 's' || verb === 'v') parts.push({ text })
      else parts.push({ unresolved: a })
    }
    parts.push({ text: fmtText.slice(last) })
    return { parts: mergeParts(parts.filter((p) => p.text !== '')), sawString: true }
  }

  /**
   * Interpret a string-returning function whose control flow branches only
   * on boolean parameters bound to literal arguments, such as benthos'
   * service.OutputPerformanceDocs(true, false):
   *
   *   if <cond> { ... }   (no else; cond over params, !, &&, ||, true, false)
   *   x += expr | x = expr | x := expr | var x = expr
   *   return [expr]       (a bare return yields the named result)
   *
   * Anything else returns null and the call stays unresolved.
   */
  interpretBranches (fn, args, ctx) {
    const masked = fn.file.masked
    const bools = new Map()
    fn.params.forEach((param, i) => {
      const a = (args[i] || '').trim()
      if (param.name && /^bool$/.test(param.type) && /^(true|false)$/.test(a)) bools.set(param.name, a === 'true')
    })
    const named = fn.results.match(/^\(\s*([A-Za-z_]\w*)\s+string\s*\)$/)
    const vars = new Map()
    if (named) vars.set(named[1], { parts: [], sawString: true })
    const evalCond = (text) => {
      const t = text.replace(/\s+/g, ' ').trim()
      if (!/^[\w!&|() ]+$/.test(t)) return null
      const js = t.replace(/[A-Za-z_]\w*/g, (id) => {
        if (id === 'true' || id === 'false') return id
        return bools.has(id) ? String(bools.get(id)) : '@'
      })
      if (js.includes('@')) return null
      if (!/^[truefals!&|() ]+$/.test(js)) return null
      try { return Boolean(Function(`"use strict"; return (${js})`)()) } catch { return null }
    }
    const sub = () => ({
      file: fn.file,
      depth: (ctx.depth || 0) + 1,
      locals: new Map([...vars]),
      resolveLocal: () => undefined
    })
    const run = (start, end) => {
      let i = start
      while (i < end) {
        while (i < end && /[\s;]/.test(masked[i])) i++
        if (i >= end) return undefined
        const rest = masked.slice(i, end)
        let m
        if ((m = rest.match(/^if\b/))) {
          const brace = masked.indexOf('{', i)
          if (brace === -1 || brace >= end) return null
          const close = fn.file.pairs.get(brace)
          if (close === undefined) return null
          const cond = evalCond(masked.slice(i + 2, brace))
          if (cond === null) return null
          if (/^\s*else\b/.test(masked.slice(close + 1, end))) return null
          if (cond) {
            const r = run(brace + 1, close)
            if (r !== undefined) return r
          }
          i = close + 1
          continue
        }
        if ((m = rest.match(/^return\b/))) {
          const stop = statementEnd(masked, i + 6, end)
          const expr = masked.slice(i + 6, stop).trim()
          if (expr === '') return named ? vars.get(named[1]) : null
          return this.evalString(expr, sub())
        }
        if ((m = rest.match(/^(?:var\s+)?([A-Za-z_]\w*)\s*(\+=|:=|=)(?!=)\s*/))) {
          const exprStart = i + m[0].length
          const stop = statementEnd(masked, exprStart, end)
          const r = this.evalString(masked.slice(exprStart, stop), sub())
          if (m[2] === '+=') {
            const prev = vars.get(m[1])
            if (!prev) return null
            vars.set(m[1], { parts: mergeParts([...prev.parts, ...r.parts]), sawString: true })
          } else {
            vars.set(m[1], r)
          }
          i = stop + 1
          continue
        }
        return null
      }
      return undefined
    }
    const r = run(fn.bodyStart + 1, fn.bodyEnd)
    if (r === undefined) return named ? vars.get(named[1]) : null
    return r
  }

  /** The standard-library package an alias names in `file`, if any. */
  stdlibName (file, alias) {
    const importPath = file.imports.get(alias) || [...file.imports.values()].find((p) => p === alias)
    if (!importPath) return null
    return importPath.includes('.') ? null : importPath
  }
}

/**
 * The return statement of a function whose body runs straight to it: no
 * if/for/switch/select/goto, no function literal, and exactly one return.
 * Returns { expr, offset } (offset into fn.file.masked) or null.
 */
function straightLineReturn (fn) {
  const masked = fn.file.masked
  const body = masked.slice(fn.bodyStart + 1, fn.bodyEnd)
  if (/\b(?:if|for|switch|select|goto|func)\b/.test(stripStrings(body))) return null
  const returns = [...stripStrings(body).matchAll(/(^|[^\w.])return\b/g)]
  if (returns.length !== 1) return null
  const at = fn.bodyStart + 1 + returns[0].index + returns[0][1].length + 'return'.length
  const end = statementEnd(masked, at, fn.bodyEnd)
  const expr = masked.slice(at, end)
  if (masked.slice(end, fn.bodyEnd).replace(/[;\s]/g, '') !== '') return null
  if (expr.trim() === '') return null
  return { expr, offset: at }
}

/** Blank string and rune literal contents, preserving offsets. */
function stripStrings (text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === '`' || ch === "'") {
      const end = skipString(text, i)
      out += ch + text.slice(i + 1, end - 1).replace(/[^\n]/g, ' ') + (end - 1 > i ? text[end - 1] : '')
      i = end
      continue
    }
    out += ch
    i++
  }
  return out
}

/** The expression of a function body that is exactly `return <expr>`. */
function singleReturn (fn) {
  const body = fn.file.masked.slice(fn.bodyStart + 1, fn.bodyEnd).trim()
  const m = body.match(/^return\s+([\s\S]+)$/)
  if (!m) return null
  // A second statement after the return expression is not a single return.
  const expr = m[1]
  const end = statementEnd(expr, 0)
  if (expr.slice(end).trim() !== '') return null
  return expr
}

function mergeParts (parts) {
  const out = []
  for (const part of parts) {
    const last = out[out.length - 1]
    if (part.text !== undefined && last && last.text !== undefined) last.text += part.text
    else out.push({ ...part })
  }
  return out
}

function isResolved (result) {
  return result.sawString && result.parts.every((p) => p.text !== undefined)
}

/** The string a result renders to, with numbered placeholders for gaps. */
function renderResult (result) {
  let n = 0
  return result.parts.map((p) => (p.text !== undefined ? p.text : PLACEHOLDER(++n))).join('')
}

function unresolvedParts (result) {
  return result.parts.filter((p) => p.unresolved !== undefined).map((p) => p.unresolved.replace(/\s+/g, ' '))
}

const INDEX_CACHE = new Map()

/** A shared index per repo path, so one lint run parses each file once. */
function indexFor (repo, options = {}) {
  const key = `${path.resolve(repo)}\0${options.external !== false}`
  if (!INDEX_CACHE.has(key)) INDEX_CACHE.set(key, new GoIndex(repo, options))
  return INDEX_CACHE.get(key)
}

function clearIndexCache () {
  INDEX_CACHE.clear()
}

module.exports = {
  GoIndex,
  indexFor,
  clearIndexCache,
  bracketPairs,
  statementEnd,
  splitTopLevel,
  parseParams,
  scanTopLevel,
  makeLineIndex,
  renderResult,
  isResolved,
  unresolvedParts,
  singleReturn,
  straightLineReturn,
  stripStrings,
  mergeParts,
  PLACEHOLDER,
  PLACEHOLDER_RE
}
