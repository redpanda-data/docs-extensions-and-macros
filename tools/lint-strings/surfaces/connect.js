'use strict'

const fs = require('fs')
const path = require('path')
const Papa = require('papaparse')

const { SourceCache } = require('../source-text')
const { splitTopLevelArgs, findBalancedClose, collectGoFiles } = require('../go-source')
const { GoIndex, statementEnd, straightLineReturn, stripStrings, renderResult, isResolved, unresolvedParts } = require('../go-index')
const { parseLiteralFields } = require('./rpk')

/**
 * Connect surface: every published string a Redpanda Connect build defines.
 *
 * - Component specs (service.ConfigSpec): Summary, Description, Footnotes,
 *   and Example titles and summaries.
 * - Config fields (service.ConfigField): Description, ShortDescription, and
 *   the option descriptions of annotated enum fields.
 * - Bloblang plugins (bloblang.PluginSpec): Description, Example summaries,
 *   and parameter descriptions.
 * - `rpk connect` help (urfave/cli): command Usage, UsageText, ArgsUsage and
 *   Description, and flag Usage.
 *
 * Calls are found wherever they are: in helper packages outside
 * internal/impl (httpclient, retries, ...), on specs built by helper
 * constructors (`azureComponentSpec().Summary(...)`), and on variables
 * updated by reassignment (`spec = spec.Description(...)`). The receiver of
 * each call is traced back to its constructor, through local variables,
 * parameters, package variables and helper return types, so a
 * `.Description()` on something that is not a benthos spec is never taken
 * for one.
 *
 * Strings are evaluated across files and packages with GoIndex: constants
 * from another file or package, helper functions that return a string,
 * fmt.Sprintf, strings.Join and local variables all resolve to the exact
 * shipped text. A part that cannot be evaluated is never guessed at: the
 * declaration is still reported, with a numbered `{{unresolved:N}}`
 * placeholder for each gap, meta.unverifiable set (so mechanical rules,
 * which would judge partial text, skip it) and meta.unresolved naming the
 * source of each gap. Calls whose receiver cannot be traced are reported in
 * the extraction's `skipped` list. Nothing is dropped silently.
 *
 * Component declarations carry their registrations (type and name) and the
 * matching internal/plugins/info.csv row (support level, Cloud and Cloud
 * GPU availability), so a review can catch self-managed-only wording in a
 * component that runs in Cloud.
 *
 * Spec strings are AsciiDoc page bodies (cmd/tools/docs_gen writes them into
 * partials verbatim), so AsciiDoc constructs are legitimate: `==` headings,
 * links, tables, and the `raw` + "`literal`" + `raw` backtick idiom. The
 * verbatim raw-pipe rule is skipped because a bare `|` is table syntax in
 * that position. CLI help is not AsciiDoc: rpk-docs formats it like cobra
 * help, so CLI declarations skip the verbatim rules.
 */

const CONVENTION = {
  case: 'sentence',
  terminal_period: true,
  verbatim_asciidoc: true
}

const CLI_CONVENTION = {
  case: 'sentence',
  terminal_period: false,
  verbatim_asciidoc: false,
  transformer: 'formatDescription',
  auto_inline_code: {
    kinds: ['flag'],
    path_prefixes: ['/etc/', '/var/', '/usr/', '/home/', '/tmp/', '~/.']
  }
}

// Field constructors that ship with NO built-in documentation: a chain on
// one of these without .Description() publishes an empty field description.
// Composite helpers (NewTLSToggledField, NewAutoRetryNacksToggleField,
// NewBatchPolicyField, ...) carry their own docs and are exempt.
const BARE_FIELD_CTORS = new Set([
  'NewStringField', 'NewStringListField', 'NewStringMapField', 'NewStringListOfListsField',
  'NewStringEnumField', 'NewStringAnnotatedEnumField',
  'NewIntField', 'NewIntListField', 'NewIntMapField',
  'NewFloatField', 'NewFloatListField', 'NewFloatMapField', 'NewBoolField', 'NewDurationField',
  'NewInterpolatedStringField', 'NewInterpolatedStringListField',
  'NewInterpolatedStringMapField', 'NewInterpolatedStringEnumField',
  'NewBloblangField', 'NewAnyField', 'NewAnyListField', 'NewAnyMapField',
  'NewObjectField', 'NewObjectListField', 'NewObjectMapField', 'NewURLField', 'NewURLListField'
])

const SERVICE_PKG = 'github.com/redpanda-data/benthos/v4/public/service'
const BLOBLANG_PKG = 'github.com/redpanda-data/benthos/v4/public/bloblang'
const CLI_PKG = /^github\.com\/urfave\/cli(?:\/v\d+)?$/

// Repos whose urfave/cli commands are `rpk connect` help.
const CLI_MODULES = /^github\.com\/redpanda-data\/(?:connect|benthos)(?:\/v\d+)?$/

// Directories scanned in a whole-repo run. Helper packages outside
// internal/impl (httpclient, retries, ...) and the CLI live under these.
const SCAN_ROOTS = ['internal', 'public', 'cmd']

const DOC_METHODS = /\.\s*(Summary|Description|ShortDescription|Footnotes|Example|ExampleNotTested)\s*\(/g

const REGISTRATION = /\b(Must)?Register(Batch)?(Input|Output|Processor|Cache|RateLimit|Buffer|MetricsExporter|OtelTracerProvider|Scanner)(?:Creator)?\s*\(/g
const BLOBLANG_REGISTRATION = /\b(Must)?Register(Method|Function)V2\s*\(/g

const REGISTRATION_TYPES = {
  Input: 'input',
  Output: 'output',
  Processor: 'processor',
  Cache: 'cache',
  RateLimit: 'rate_limit',
  Buffer: 'buffer',
  MetricsExporter: 'metric',
  OtelTracerProvider: 'tracer',
  Scanner: 'scanner',
  Method: 'bloblang-method',
  Function: 'bloblang-function'
}

const MAX_COMPONENTS = 10
const MAX_TRACE_DEPTH = 40

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Read internal/plugins/info.csv: type/name -> support and availability.
 * Columns are matched by header name, so a reordered or extended CSV still
 * reads correctly.
 */
function readInfoCsv (repo) {
  const rows = new Map()
  let text
  try {
    text = fs.readFileSync(path.join(repo, 'internal', 'plugins', 'info.csv'), 'utf8')
  } catch {
    return rows
  }
  // Parse as CSV, so a quoted comma in a commercial name can't shift the
  // support and Cloud columns.
  const { data } = Papa.parse(text, { skipEmptyLines: 'greedy' })
  if (data.length === 0) return rows
  const header = data[0].map((h) => h.trim())
  for (const record of data.slice(1)) {
    const cells = record.map((c) => c.trim())
    const get = (name) => (header.indexOf(name) === -1 ? '' : cells[header.indexOf(name)] || '')
    const name = get('name')
    const type = get('type')
    if (!name || !type) continue
    rows.set(`${type}/${name}`, {
      support: get('support') || null,
      cloud: get('cloud') === 'y',
      cloud_ai: get('cloud_with_gpu') === 'y',
      deprecated: get('deprecated') === 'y',
      commercial_name: get('commercial_name') || null,
      cloud_unsupported_reason: get('cloud_unsupported_reason') || null
    })
  }
  return rows
}

/** The package name an unaliased import is known by. */
function importName (importPath) {
  return importPath.split('/').filter((s) => !/^v\d+$/.test(s)).pop()
}

/** Import aliases in `file` that name a package whose path passes `test`. */
function aliasesFor (file, test) {
  const out = new Set()
  for (const [key, value] of file.imports) {
    if (key === null) continue
    const matches = typeof test === 'string' ? value === test : test.test(value)
    if (!matches) continue
    if (key.startsWith('\0')) out.add(importName(value))
    else if (key !== '_' && key !== '.') out.add(key)
  }
  return out
}

/** The top-level function whose body contains `offset`, or null. */
function enclosingFunc (file, offset) {
  for (const fn of file.funcs) {
    if (offset > fn.bodyStart && offset < fn.bodyEnd) return { ...fn, file }
  }
  return null
}

/** The top-level declaration (func or var) whose text contains `offset`. */
function enclosingUnit (file, offset) {
  for (const fn of file.funcs) {
    if (offset >= fn.start && offset <= fn.bodyEnd) return { kind: 'func', name: fn.name }
  }
  for (const value of file.values) {
    if (offset >= value.start && offset <= value.end) return { kind: value.kind, name: value.name }
  }
  return null
}

function enclosingFuncKey (file, offset) {
  const fn = enclosingFunc(file, offset)
  return fn ? `${file.abs}:${fn.start}` : `${file.abs}:top`
}

const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
const isWord = (ch) => ch !== undefined && /\w/.test(ch)

/**
 * Walk a builder chain backwards from just after its last character (the
 * index of the `.` before a method name, or the end of an expression) to the
 * expression that starts it. Returns the head:
 *   { type: 'call', qual, name, open, close, start } - `qual.name(...)` or `name(...)`
 *   { type: 'ident', name, start }                    - a variable
 *   { type: 'unknown', start }                        - anything else
 * plus `chain`, the methods between the head and that position.
 */
function chainHead (masked, pairs, dotIndex) {
  let i = dotIndex - 1
  const chain = []
  for (;;) {
    while (i >= 0 && isSpace(masked[i])) i--
    if (masked[i] === ')') {
      const open = pairs.get(i)
      if (open === undefined) return { type: 'unknown', chain, start: i }
      let j = open - 1
      while (j >= 0 && isSpace(masked[j])) j--
      let k = j
      while (k >= 0 && isWord(masked[k])) k--
      const name = masked.slice(k + 1, j + 1)
      if (!name || /^\d/.test(name)) return { type: 'unknown', chain, start: open }
      let d = k
      while (d >= 0 && isSpace(masked[d])) d--
      if (masked[d] !== '.') return { type: 'call', qual: null, name, open, close: i, chain, start: k + 1 }
      let e = d - 1
      while (e >= 0 && isSpace(masked[e])) e--
      if (masked[e] === ')' || masked[e] === ']') {
        chain.unshift({ method: name, open, close: i })
        i = d - 1
        continue
      }
      let f = e
      while (f >= 0 && isWord(masked[f])) f--
      const qual = masked.slice(f + 1, e + 1)
      let g = f
      while (g >= 0 && isSpace(masked[g])) g--
      // a.b.Method(...): a field-selector receiver, not traceable.
      if (!qual || masked[g] === '.') return { type: 'unknown', chain, start: f + 1 }
      return { type: 'call', qual, name, open, close: i, chain, start: f + 1 }
    }
    if (masked[i] === ']') {
      // fields[0].Description(...): an element of a field list.
      const open = pairs.get(i)
      if (open === undefined) return { type: 'unknown', chain, start: i }
      let k = open - 1
      while (k >= 0 && isWord(masked[k])) k--
      const name = masked.slice(k + 1, open)
      let d = k
      while (d >= 0 && isSpace(masked[d])) d--
      if (!name || masked[d] === '.') return { type: 'unknown', chain, start: k + 1 }
      return { type: 'index', name, index: masked.slice(open + 1, i).trim(), chain, start: k + 1 }
    }
    if (isWord(masked[i])) {
      let k = i
      while (k >= 0 && isWord(masked[k])) k--
      const name = masked.slice(k + 1, i + 1)
      let d = k
      while (d >= 0 && isSpace(masked[d])) d--
      if (masked[d] === '.') return { type: 'unknown', chain, start: k + 1 }
      return { type: 'ident', name, chain, start: k + 1 }
    }
    return { type: 'unknown', chain, start: i }
  }
}

/** Classify a Go type or function result list as a spec kind, or null. */
function kindOfType (typeText) {
  const t = String(typeText || '').replace(/^\(\s*/, '').trim()
  if (/^\[\]\*?(?:\w+\.)?ConfigField\b/.test(t)) return 'field-list'
  if (/^\[\]/.test(t) || /^map\[/.test(t)) return null
  if (/^\*?(?:\w+\.)?ConfigSpec\b/.test(t)) return 'spec'
  if (/^\*?(?:\w+\.)?ConfigField\b/.test(t)) return 'field'
  if (/^\*?(?:\w+\.)?PluginSpec\b/.test(t)) return 'blobl-spec'
  if (/^(?:\w+\.)?ParamDefinition\b/.test(t)) return 'blobl-param'
  // The javascript processor's own builder for the functions it exposes to
  // scripts, published in the processor's footnotes.
  if (/^\*?jsFunctionDefinition\b/.test(t)) return 'js-function'
  return null
}

/** Index of the first top-level `:` in a `key: value` entry, or -1. */
function topLevelColon (text) {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"' || ch === '`' || ch === "'") {
      const q = ch
      i++
      while (i < text.length && text[i] !== q) i += (q !== '`' && text[i] === '\\') ? 2 : 1
      continue
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') depth--
    else if (ch === ':' && depth === 0) return i
  }
  return -1
}

/** Forward builder chain from `start`: [{ method, open, close }]. */
function readChain (masked, pairs, start) {
  const calls = []
  let i = start
  for (;;) {
    const m = masked.slice(i, i + 200).match(/^\s*\.\s*([A-Za-z0-9_]+)\s*\(/)
    if (!m) break
    const open = i + m[0].length - 1
    const close = pairs.get(open)
    if (close === undefined) break
    calls.push({ method: m[1], open, close })
    i = close + 1
  }
  return calls
}

class ConnectScanner {
  constructor (index, { repo }) {
    this.index = index
    this.info = readInfoCsv(repo)
    this.registrations = new Map() // package dir -> registrations
    this.callers = new Map() // package dir -> Map(name -> Set(caller names))
    this.cli = CLI_MODULES.test(index.gomod.module || '')
  }

  aliases (file) {
    if (!file._aliases) {
      file._aliases = {
        service: aliasesFor(file, SERVICE_PKG),
        bloblang: aliasesFor(file, BLOBLANG_PKG),
        cli: aliasesFor(file, CLI_PKG)
      }
    }
    return file._aliases
  }

  isImportAlias (file, alias) {
    for (const [key, value] of file.imports) {
      if (key === alias) return true
      if (key && key.startsWith('\0')) {
        const last = importName(value)
        if (last === alias || last.replace(/-/g, '_') === alias) return true
      }
    }
    return false
  }

  /** Evaluate a string expression found at `offset` in `file`. */
  evalAt (file, exprText, offset) {
    const fn = enclosingFunc(file, offset)
    return this.index.evalString(exprText, {
      file,
      depth: 0,
      resolveLocal: fn ? this.index.localResolver(file, fn, offset) : undefined
    })
  }

  /**
   * What a chain head constructs: { kind, ctor, name } where kind is
   * spec | field | blobl-spec | blobl-param | null, and name (fields and
   * params) is an evaluated Result.
   */
  classifyHead (file, head, offset, depth = 0) {
    const none = { kind: null }
    if (depth > MAX_TRACE_DEPTH) return none
    const { service, bloblang } = this.aliases(file)
    if (head.type === 'call') {
      const args = () => splitTopLevelArgs(file.masked.slice(head.open + 1, head.close))
      if (head.qual && service.has(head.qual)) {
        if (/^New(?:Struct)?ConfigSpec$/.test(head.name)) return { kind: 'spec', ctor: head.name }
        if (/^New\w*Field$/.test(head.name)) return { kind: 'field', ctor: head.name, ...this.fieldNameOf(file, head, args()) }
        return this.classifyFunc(file, `${head.qual}.${head.name}`, args(), depth)
      }
      if (head.qual && bloblang.has(head.qual)) {
        if (head.name === 'NewPluginSpec') return { kind: 'blobl-spec', ctor: head.name }
        if (/^New\w*Param$/.test(head.name)) {
          const a = args()
          return { kind: 'blobl-param', ctor: head.name, name: a.length ? this.evalAt(file, a[0], head.open) : null }
        }
        return none
      }
      if (head.qual && !this.isImportAlias(file, head.qual)) {
        // `spec.Field(...).Description(...)`: a method on a variable.
        return this.classifyIdent(file, head.qual, head.start, depth + 1)
      }
      return this.classifyFunc(file, head.qual ? `${head.qual}.${head.name}` : head.name, args(), depth)
    }
    if (head.type === 'ident') return this.classifyIdent(file, head.name, head.start, depth)
    if (head.type === 'index') {
      const base = this.classifyIdent(file, head.name, head.start, depth + 1)
      if (base.kind !== 'field-list') return none
      return { kind: 'field', ctor: null, via: `${head.name}[${head.index}]`, name: this.listElementName(file, head, depth) }
    }
    return none
  }

  /**
   * The name of element N of a field list built by a helper that returns a
   * `[]*service.ConfigField{...}` literal: `fields := FranzConnectionFields()`
   * then `fields[0].Description(...)`.
   */
  listElementName (file, head, depth) {
    if (!/^\d+$/.test(head.index)) return null
    const fn = enclosingFunc(file, head.start)
    const assignment = fn ? this.lastAssignment(file, fn, head.name, head.start) : null
    const call = assignment && assignment.expr && assignment.expr.trim().match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\(\s*\)$/)
    const helper = call ? this.index.lookupFunc(file, call[1]) : null
    const ret = helper ? straightLineReturn(helper) : null
    const lit = ret && ret.expr.match(/^\s*\[\]\*?(?:\w+\.)?ConfigField\s*\{/)
    if (!lit) return null
    const braceOpen = ret.offset + lit[0].length - 1
    const braceClose = helper.file.pairs.get(braceOpen)
    if (braceClose === undefined) return null
    const element = splitTopLevelArgs(helper.file.masked.slice(braceOpen + 1, braceClose))[Number(head.index)]
    const m = element && element.match(/New\w*Field\s*\(/)
    if (!m) return null
    const open = element.indexOf('(', m.index)
    const close = findBalancedClose(element, open)
    if (close === -1) return null
    const nameArg = splitTopLevelArgs(element.slice(open + 1, close))[0]
    return nameArg ? this.index.evalString(nameArg, { file: helper.file, depth: depth + 1 }) : null
  }

  /** A call to a helper: classified by its declared result type. */
  classifyFunc (file, callee, args, depth) {
    const fn = this.index.lookupFunc(file, callee)
    if (!fn) return { kind: null }
    const kind = kindOfType(fn.results)
    if (!kind) return { kind: null }
    const out = { kind, ctor: callee, helper: true }
    if (kind === 'field' || kind === 'blobl-param') Object.assign(out, this.helperFieldName(fn, args, file, depth))
    return out
  }

  /**
   * The field a helper builds: the first benthos field or param
   * constructor in its body, its name argument evaluated with the helper's
   * parameters bound to this call's arguments. Inside benthos itself the
   * constructors are unqualified.
   */
  helperFieldName (fn, args, callerFile, depth) {
    const helperFile = fn.file
    const body = helperFile.masked.slice(fn.bodyStart, fn.bodyEnd)
    const { service, bloblang } = this.aliases(helperFile)
    const quals = [...service, ...bloblang].map(escapeRe)
    const qualified = quals.length > 0 ? `(?:(?:${quals.join('|')})\\s*\\.\\s*)?` : ''
    const m = body.match(new RegExp(`(?:^|[^\\w.])${qualified}(New\\w*(?:Field|Param))\\s*\\(`))
    if (!m) return { name: null }
    const open = fn.bodyStart + m.index + m[0].length - 1
    const close = helperFile.pairs.get(open)
    if (close === undefined) return { name: null }
    const ctorArgs = splitTopLevelArgs(helperFile.masked.slice(open + 1, close))
    if (ctorArgs.length === 0 || ctorArgs[0].trim() === '') return { name: null }
    const locals = new Map()
    fn.params.forEach((param, i) => {
      if (!param.name) return
      const r = i < args.length ? this.index.evalString(args[i], { file: callerFile, depth: depth + 1 }) : null
      locals.set(param.name, r && r.sawString ? r : { parts: [{ unresolved: param.name }], sawString: false })
    })
    const name = this.index.evalString(ctorArgs[0], {
      file: helperFile,
      locals,
      depth: depth + 1,
      resolveLocal: this.index.localResolver(helperFile, fn, open)
    })
    return { name }
  }

  /** The field name of a benthos field constructor call. */
  fieldNameOf (file, head, args) {
    if (args.length === 0 || args[0].trim() === '') {
      // Nameless composite constructors (NewOutputMaxInFlightField) name
      // their field inside benthos.
      const fn = this.index.lookupFunc(file, `${head.qual}.${head.name}`)
      return fn ? this.helperFieldName(fn, [], file, 1) : { name: null }
    }
    return { name: this.evalAt(file, args[0], head.open), nameExpr: { text: args[0], offset: head.open } }
  }

  /** A variable, traced to its assignment, parameter type, or package var. */
  classifyIdent (file, ident, offset, depth) {
    if (depth > MAX_TRACE_DEPTH) return { kind: null }
    const fn = enclosingFunc(file, offset)
    if (fn) {
      const assignment = this.lastAssignment(file, fn, ident, offset)
      if (assignment) {
        const kind = assignment.type ? kindOfType(assignment.type) : null
        if (kind) return { kind, via: ident }
        if (assignment.expr) {
          const cls = this.classifyExpr(file, assignment.expr, assignment.exprStart, depth + 1)
          return { ...cls, via: ident }
        }
      }
      const param = fn.params.find((p) => p.name === ident)
      if (param) return { kind: kindOfType(param.type), via: ident }
      if (fn.recv) {
        const m = fn.recv.match(/^(\w+)\s+(.+)$/)
        if (m && m[1] === ident) return { kind: kindOfType(m[2]), via: ident }
      }
    }
    const value = this.index.lookupValue(file, ident)
    if (value) {
      const kind = value.type ? kindOfType(value.type) : null
      if (kind) return { kind, via: ident }
      if (value.expr) return { ...this.classifyExpr(value.file, value.expr, value.exprStart, depth + 1), via: ident }
    }
    return { kind: null }
  }

  /** Classify an expression by the constructor at the head of its chain. */
  classifyExpr (file, exprText, exprStart, depth) {
    let end = exprStart + exprText.length
    while (end > exprStart && isSpace(file.masked[end - 1])) end--
    const trimmed = exprText.trim().replace(/^&/, '')
    if (/^[A-Za-z_]\w*$/.test(trimmed)) {
      return this.classifyIdent(file, trimmed, exprStart + exprText.indexOf(trimmed), depth + 1)
    }
    if (file.masked[end - 1] !== ')') return { kind: null }
    // The builder methods return their receiver type, so the head of the
    // chain decides what the whole expression is.
    return this.classifyHead(file, chainHead(file.masked, file.pairs, end), exprStart, depth + 1)
  }

  /**
   * The last assignment to `ident` before offset in fn: `ident := expr`,
   * `ident = expr`, `var ident [T] = expr` or `var ident T`.
   * Returns { type, expr, exprStart } or null.
   */
  lastAssignment (file, fn, ident, offset) {
    return this.assignments(file, fn, ident, offset)[0] || null
  }

  /**
   * Every assignment to `ident` before offset in fn, latest first. See
   * lastAssignment for the forms. A spec built up by reassignment
   * (`conf = conf.Field(f)` in a loop) has several, and each one is part of
   * the spec.
   */
  assignments (file, fn, ident, offset) {
    const masked = file.masked
    const text = masked.slice(fn.bodyStart, offset)
    const esc = escapeRe(ident)
    const re = new RegExp(`(^|[^\\w.])(?:var\\s+${esc}\\s+([^=\\n;]+?)\\s*(?:(=)(?!=)|[\\n;])|${esc}\\s*(:=|=)(?!=))`, 'g')
    const matches = []
    let m
    while ((m = re.exec(text)) !== null) matches.push(m)
    const out = []
    // Latest first. An assignment whose right-hand side contains offset is
    // the statement being traced (`spec = spec.Example(...)`): the variable
    // there still holds its previous value.
    for (let i = matches.length - 1; i >= 0; i--) {
      const last = matches[i]
      const at = fn.bodyStart + last.index + last[0].length
      if (last[2] && !last[3]) {
        out.push({ type: last[2].trim() })
        break
      }
      const exprEnd = statementEnd(masked, at, fn.bodyEnd)
      if (offset >= at && offset <= exprEnd) continue
      out.push({ type: last[2] ? last[2].trim() : null, expr: masked.slice(at, exprEnd), exprStart: at, declares: Boolean(last[2] || last[4] === ':=') })
      // A declaration starts the variable: nothing earlier is the same one.
      if (last[2] || last[4] === ':=') break
    }
    return out
  }

  /** Registrations in one package: [{ type, name, refs, spans }]. */
  packageRegistrations (dir) {
    if (this.registrations.has(dir)) return this.registrations.get(dir)
    const regs = []
    for (const file of this.index.package(dir).files) {
      for (const pattern of [REGISTRATION, BLOBLANG_REGISTRATION]) {
        pattern.lastIndex = 0
        let m
        while ((m = pattern.exec(file.masked)) !== null) {
          const open = m.index + m[0].length - 1
          const close = file.pairs.get(open)
          if (close === undefined) continue
          const args = splitTopLevelArgs(file.masked.slice(open + 1, close))
          if (args.length < 2) continue
          const nameResult = this.evalAt(file, args[0], open)
          const reg = {
            type: REGISTRATION_TYPES[pattern === REGISTRATION ? m[3] : m[2]],
            name: isResolved(nameResult) ? renderResult(nameResult) : null,
            refs: new Set(),
            spans: []
          }
          this.collectSpecRefs(file, args[1], open + 1 + args[0].length + 1, reg, 0)
          regs.push(reg)
        }
      }
    }
    this.registrations.set(dir, regs)
    return regs
  }

  /** What a registration's spec argument refers to. */
  collectSpecRefs (file, exprText, exprStart, reg, depth) {
    if (depth > 3) return
    const trimmed = exprText.trim()
    const lead = exprText.length - exprText.trimStart().length
    if (/^[A-Za-z_]\w*$/.test(trimmed)) {
      const fn = enclosingFunc(file, exprStart)
      const assignments = fn ? this.assignments(file, fn, trimmed, exprStart).filter((a) => a.expr) : []
      if (fn) this.collectMutations(file, fn, trimmed, exprStart, reg)
      if (assignments.length > 0) {
        for (const a of assignments) this.collectSpecRefs(file, a.expr, a.exprStart, reg, depth + 1)
        return
      }
      reg.refs.add(trimmed)
      return
    }
    const call = trimmed.match(/^([A-Za-z_]\w*)\s*\(/)
    if (call) reg.refs.add(call[1])
    reg.spans.push([file.abs, exprStart + lead, exprStart + lead + trimmed.length])
  }

  /**
   * Builder statements that change a spec in place without reassigning it:
   * `spec.Field(...)` on a line of its own. ConfigSpec methods mutate their
   * receiver, so these are part of the registered spec too.
   */
  collectMutations (file, fn, ident, before, reg) {
    const masked = file.masked
    const re = new RegExp(`(^|[\\n;{]\\s*)${escapeRe(ident)}\\s*\\.\\s*[A-Z]\\w*\\s*\\(`, 'g')
    // String contents blanked, so example YAML in a raw string never
    // reads as a statement.
    const text = stripStrings(masked.slice(fn.bodyStart + 1, before))
    let m
    while ((m = re.exec(text)) !== null) {
      const start = fn.bodyStart + 1 + m.index + m[1].length
      const end = statementEnd(masked, start, fn.bodyEnd)
      reg.spans.push([file.abs, start, end])
    }
  }

  /**
   * Package-level names a registration's inline spec text mentions, such as
   * the field helper in `conf = conf.Field(accountField("x"))`, so a
   * declaration in that helper reaches the registration.
   */
  addSpanRefs (dir, regs) {
    if (regs._spanRefs) return
    regs._spanRefs = true
    const pkg = this.index.package(dir)
    const names = new Set([...pkg.funcs.keys(), ...pkg.values.keys()])
    for (const reg of regs) {
      for (const [abs, start, end] of reg.spans) {
        const file = this.index.file(abs)
        if (!file) continue
        const text = stripStrings(file.masked.slice(start, end))
        for (const m of text.matchAll(/(?:^|[^\w.])([A-Za-z_]\w*)/g)) if (names.has(m[1])) reg.refs.add(m[1])
      }
    }
  }

  /** name -> Set of package-level names whose text mentions it. */
  packageCallers (dir) {
    if (this.callers.has(dir)) return this.callers.get(dir)
    const units = []
    for (const file of this.index.package(dir).files) {
      for (const fn of file.funcs) units.push({ name: fn.name, text: file.masked.slice(fn.start, fn.bodyEnd + 1) })
      for (const value of file.values) units.push({ name: value.name, text: file.masked.slice(value.start, value.end) })
    }
    const names = new Set(units.map((u) => u.name))
    const callers = new Map()
    for (const unit of units) {
      for (const m of unit.text.matchAll(/(?:^|[^\w.])([A-Za-z_]\w*)/g)) {
        const name = m[1]
        if (name === unit.name || !names.has(name)) continue
        if (!callers.has(name)) callers.set(name, new Set())
        callers.get(name).add(unit.name)
      }
    }
    this.callers.set(dir, callers)
    return callers
  }

  /**
   * Directories of the in-module packages that import `importPath`, built
   * once per run from the import blocks of every scanned root.
   */
  importersOf (importPath) {
    if (!this.importers) {
      this.importers = new Map()
      const mod = this.index.gomod.module
      for (const root of SCAN_ROOTS) {
        for (const rel of collectGoFiles(path.join(this.index.repo, root))) {
          const abs = path.join(this.index.repo, root, rel)
          let head
          try {
            head = fs.readFileSync(abs, 'utf8')
          } catch {
            continue
          }
          const end = head.search(/\n(?:func|type|var|const)\b/)
          for (const m of (end === -1 ? head : head.slice(0, end)).matchAll(/"([^"\s]+)"/g)) {
            if (!mod || !m[1].startsWith(`${mod}/`)) continue
            if (!this.importers.has(m[1])) this.importers.set(m[1], new Set())
            this.importers.get(m[1]).add(path.dirname(abs))
          }
        }
      }
    }
    return [...(this.importers.get(importPath) || [])]
  }

  /**
   * Registrations in other packages that reach an exported helper: a spec
   * built in one package (azure/cosmosdb, httpclient) and registered in
   * another.
   */
  componentsViaImporters (file, unitName, hops) {
    const mod = this.index.gomod.module
    if (!mod || hops > 2 || !/^[A-Z]/.test(unitName)) return []
    const importPath = `${mod}/${this.index.rel(file.dir).split(path.sep).join('/')}`
    const found = []
    for (const dir of this.importersOf(importPath)) {
      for (const other of this.index.package(dir).files) {
        for (const [key, value] of other.imports) {
          if (value !== importPath || key === null) continue
          const alias = key.startsWith('\0') ? this.index.package(file.dir).name || importName(value) : key
          const re = new RegExp(`(?:^|[^\\w.])${escapeRe(alias)}\\s*\\.\\s*${escapeRe(unitName)}\\b`, 'g')
          for (const m of other.masked.matchAll(re)) found.push(...this.componentsAt(other, m.index + 1, hops + 1))
        }
      }
    }
    return found
  }

  /** Registrations whose spec reaches the code at `offset` in `file`. */
  componentsAt (file, offset, hops = 0) {
    const regs = this.packageRegistrations(file.dir)
    const inline = regs.filter((r) => r.spans.some(([abs, s, e]) => abs === file.abs && offset >= s && offset <= e))
    if (inline.length > 0) return inline
    const unit = enclosingUnit(file, offset)
    if (!unit) return []
    this.addSpanRefs(file.dir, regs)
    const callers = this.packageCallers(file.dir)
    const seen = new Set([unit.name])
    let frontier = [unit.name]
    const found = new Set()
    for (let depth = 0; depth < MAX_TRACE_DEPTH && frontier.length > 0; depth++) {
      for (const reg of regs) if (frontier.some((n) => reg.refs.has(n))) found.add(reg)
      const next = []
      for (const name of frontier) {
        for (const caller of callers.get(name) || []) {
          if (seen.has(caller)) continue
          seen.add(caller)
          next.push(caller)
        }
      }
      frontier = next
    }
    if (found.size === 0) {
      // Nothing in this package registers it: follow the exported names it
      // was reached through into the packages that import them.
      for (const name of seen) {
        for (const reg of this.componentsViaImporters(file, name, hops)) found.add(reg)
      }
    }
    return [...found]
  }

  /**
   * { components: [{ type, name, ...info.csv row }], components_total }.
   * An offset of -1 asks for the package's single component.
   */
  componentMeta (file, offset) {
    const seen = new Set()
    const components = []
    let regs = offset < 0 ? [] : this.componentsAt(file, offset)
    let via = null
    if (offset < 0) {
      // Text that no spec holds (the javascript functions, which the
      // processor renders at runtime): a package that registers exactly
      // one component documents only that one. Spec text never falls back:
      // a spec nothing registers (timeplus's output) belongs to no page.
      const own = this.packageRegistrations(file.dir)
      if (own.length === 1) {
        regs = own
        via = 'package'
      }
    }
    for (const reg of regs) {
      const key = `${reg.type}/${reg.name}`
      if (seen.has(key)) continue
      seen.add(key)
      const info = reg.name ? this.info.get(key) : null
      components.push({ type: reg.type, name: reg.name, ...(info || {}) })
    }
    components.sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.name).localeCompare(String(b.name)))
    const out = { components: components.slice(0, MAX_COMPONENTS), components_total: components.length }
    if (via) out.components_via = via
    return out
  }

  /** Scan one file. Returns { declarations, skipped }. */
  scan (file, rel) {
    const declarations = []
    const skipped = []
    const { service, bloblang, cli } = this.aliases(file)
    if (service.size > 0 || bloblang.size > 0) this.scanSpecs(file, rel, declarations, skipped)
    if (cli.size > 0 && this.cli) this.scanCli(file, rel, declarations)
    return { declarations, skipped }
  }

  makeDecl (file, rel, { kind, name, result, start, end, extra = {}, convention = CONVENTION }) {
    const unresolved = result ? unresolvedParts(result) : []
    const text = result ? renderResult(result).trim() : null
    const meta = { kind, ...extra }
    if (unresolved.length > 0) {
      meta.unverifiable = true
      meta.unresolved = unresolved
    }
    return {
      surface: 'connect',
      name: name || null,
      file: rel,
      line_start: file.lineOf(start),
      line_end: file.lineOf(end),
      string: text === '' ? null : text,
      declaration_text: null,
      convention,
      meta
    }
  }

  /**
   * Push a declaration, expanded per call site when it lives in a helper
   * whose parameters fill its gaps: `regionField(product string)` builds
   * "The AWS region to target for " + product + "." and is called once per
   * component, so each call publishes a different string. Each expansion
   * keeps the helper's lines (that is where a fix goes), and records the
   * call site, the template with its gaps, and the calling component.
   *
   * @param {Object} d - makeDecl options plus valueExpr / nameExpr
   *   ({ text, offset }) to re-evaluate with the bound parameters
   */
  pushDecl (declarations, file, rel, d) {
    const fallback = () => declarations.push(this.makeDecl(file, rel, d))
    if (!d.valueExpr) return fallback()
    const bindings = this.callSiteBindings(file, d.valueExpr.offset, [d.result, d.nameResult])
    if (!bindings) return fallback()
    const seen = new Set()
    const template = d.result ? renderResult(d.result).trim() : null
    let pushed = 0
    for (const { locals, site } of bindings) {
      const result = this.evalWith(file, d.valueExpr, locals)
      const nameResult = d.nameExpr ? this.evalWith(file, d.nameExpr, locals) : null
      const name = nameResult && isResolved(nameResult) ? renderResult(nameResult) : d.name
      const key = `${name}\0${renderResult(result)}`
      if (seen.has(key)) continue
      seen.add(key)
      const meta = d.components === false ? {} : this.componentMeta(site.file, site.offset)
      declarations.push(this.makeDecl(file, rel, {
        ...d,
        name,
        result,
        extra: { ...d.extra, ...meta, call_site: `${this.index.rel(site.file.abs)}:${site.file.lineOf(site.offset)}`, template }
      }))
      pushed++
    }
    if (pushed === 0) fallback()
  }

  /** Evaluate { text, offset } in file with parameters bound to `locals`. */
  evalWith (file, expr, locals) {
    const fn = enclosingFunc(file, expr.offset)
    return this.index.evalString(expr.text, {
      file,
      depth: 0,
      locals,
      resolveLocal: fn ? this.index.localResolver(file, fn, expr.offset) : undefined
    })
  }

  /**
   * When every gap in `results` is a parameter of the function enclosing
   * `offset`, the parameter bindings at each call of that function.
   * Returns [{ locals, site: { file, offset } }] or null.
   */
  callSiteBindings (file, offset, results) {
    const fn = enclosingFunc(file, offset)
    if (!fn || fn.recv) return null
    const params = new Set(fn.params.map((p) => p.name).filter(Boolean))
    const gaps = results.filter(Boolean).flatMap((r) => unresolvedParts(r))
    if (gaps.length === 0 || !gaps.every((g) => params.has(g.trim().replace(/\.\.\.$/, '')))) return null
    const sites = this.callSites(file, fn)
    if (sites.length === 0) return null
    return sites.map((site) => {
      const locals = new Map()
      fn.params.forEach((param, i) => {
        if (!param.name) return
        if (/^\.\.\./.test(param.type)) {
          // A variadic parameter is the list of the remaining arguments,
          // or the list a trailing `xs...` spreads.
          const rest = site.args.slice(i).filter((a) => a !== '')
          const spread = rest.length === 1 && rest[0].endsWith('...')
            ? this.index.evalStringList(rest[0].slice(0, -3), { file: site.file, depth: 1 })
            : rest.map((a) => this.evalAt(site.file, a, site.offset))
          locals.set(param.name, { parts: [{ unresolved: param.name }], sawString: false, list: spread || [{ parts: [{ unresolved: rest.join(', ') }], sawString: false }] })
          return
        }
        const arg = i < site.args.length ? site.args[i] : null
        const r = arg === null ? null : this.evalAt(site.file, arg, site.offset)
        locals.set(param.name, r && r.sawString ? r : { parts: [{ unresolved: param.name }], sawString: false })
      })
      return { locals, site }
    })
  }

  /** Calls of top-level function fn: in its package, and through importers. */
  callSites (file, fn) {
    const key = `${file.abs}:${fn.start}`
    this.siteCache = this.siteCache || new Map()
    if (this.siteCache.has(key)) return this.siteCache.get(key)
    const sites = []
    const scan = (other, prefix) => {
      const re = new RegExp(`(^|[^\\w.])${prefix}${escapeRe(fn.name)}\\s*\\(`, 'g')
      const text = stripStrings(other.masked)
      let m
      while ((m = re.exec(text)) !== null) {
        if (/\bfunc\s*$/.test(text.slice(Math.max(0, m.index - 10), m.index + m[1].length))) continue
        const open = m.index + m[0].length - 1
        const close = other.pairs.get(open)
        if (close === undefined) continue
        sites.push({ file: other, offset: open, args: splitTopLevelArgs(other.masked.slice(open + 1, close)).map((a) => a.trim()) })
      }
    }
    for (const other of this.index.package(file.dir).files) scan(other, '')
    const mod = this.index.gomod.module
    if (mod && /^[A-Z]/.test(fn.name)) {
      const importPath = `${mod}/${this.index.rel(file.dir).split(path.sep).join('/')}`
      for (const dir of this.importersOf(importPath)) {
        for (const other of this.index.package(dir).files) {
          for (const [k, value] of other.imports) {
            if (value !== importPath || k === null || k === '_' || k === '.') continue
            const alias = k.startsWith('\0') ? this.index.package(file.dir).name || importName(value) : k
            scan(other, `${escapeRe(alias)}\\s*\\.\\s*`)
          }
        }
      }
    }
    this.siteCache.set(key, sites)
    return sites
  }

  scanSpecs (file, rel, declarations, skipped) {
    const masked = file.masked
    const describedVars = new Set()
    const nameOf = (r) => (r && isResolved(r) ? renderResult(r) : null)
    DOC_METHODS.lastIndex = 0
    let m
    while ((m = DOC_METHODS.exec(masked)) !== null) {
      const method = m[1]
      const dot = m.index
      const open = m.index + m[0].length - 1
      const close = file.pairs.get(open)
      if (close === undefined) continue
      // A method declaration such as `func (c *X) Description(` is not a call.
      if (/func\s*\([^()]*\)\s*$/.test(masked.slice(Math.max(0, dot - 200), dot))) continue
      const head = chainHead(masked, file.pairs, dot)
      const cls = this.classifyHead(file, head, dot)
      // javascript function docs are read by scanJsFunctions; their
      // Example() is script code, not prose.
      if (cls.kind === 'js-function') continue
      if (!cls.kind || cls.kind === 'field-list') {
        const receiver = head.type === 'ident'
          ? head.name
          : head.type === 'call' ? `${head.qual ? `${head.qual}.` : ''}${head.name}()` : null
        skipped.push({
          surface: 'connect',
          file: rel,
          line: file.lineOf(dot),
          method,
          reason: receiver
            ? `receiver ${receiver} does not trace to a benthos spec, field or Bloblang plugin`
            : 'receiver is not a traceable expression'
        })
        continue
      }
      if (head.type === 'ident' && method === 'Description') describedVars.add(`${enclosingFuncKey(file, dot)}\0${head.name}`)
      const args = splitTopLevelArgs(masked.slice(open + 1, close))
      const argStart = (i) => open + 1 + args.slice(0, i).reduce((n, a) => n + a.length + 1, 0)
      let evalArg = (i) => this.evalAt(file, args[i], argStart(i))
      let tupled = false
      // `spec.Example(exampleConfig())`: one call returning every argument.
      if (args.length === 1 && /^(?:Example|ExampleNotTested)$/.test(method) && (cls.kind === 'spec' || cls.kind === 'blobl-spec')) {
        const fn = enclosingFunc(file, open)
        const tuple = this.index.evalTuple(args[0], {
          file,
          depth: 0,
          resolveLocal: fn ? this.index.localResolver(file, fn, open) : undefined
        })
        if (tuple && tuple.length > 1) {
          args.length = 0
          args.push(...tuple.map(() => ''))
          evalArg = (i) => tuple[i]
          tupled = true
        } else {
          skipped.push({ surface: 'connect', file: rel, line: file.lineOf(dot), method, reason: `example arguments come from ${args[0].trim().slice(0, 60)}, which does not evaluate to a title, a summary and a config` })
          continue
        }
      }

      if (cls.kind === 'spec' || cls.kind === 'blobl-spec') {
        const meta = this.componentMeta(file, dot)
        const names = [...new Set(meta.components.map((c) => c.name).filter(Boolean))]
        const name = names.length === 1 ? names[0] : null
        const bloblang = cls.kind === 'blobl-spec'
        const exprOf = (i) => (tupled ? null : { text: args[i], offset: argStart(i) })
        const push = (kind, result, extra = {}, i = 0) => this.pushDecl(declarations, file, rel, {
          kind, name, result, start: open, end: close, extra: { ...meta, ...extra }, valueExpr: exprOf(i)
        })
        if (method === 'Summary' || method === 'Description' || method === 'Footnotes') {
          if (args.length < 1) continue
          if (bloblang) push('bloblang', evalArg(0), { part: method.toLowerCase() })
          else push(method.toLowerCase(), evalArg(0))
        } else if (!bloblang && method === 'Example') {
          if (args.length < 3) continue
          push('example-title', evalArg(0), {}, 0)
          const summary = evalArg(1)
          if (renderResult(summary).trim() !== '') push('example-summary', summary, {}, 1)
        } else if (bloblang && (method === 'Example' || method === 'ExampleNotTested')) {
          if (args.length < 2) continue
          const summary = evalArg(0)
          if (renderResult(summary).trim() !== '') push('bloblang-example', summary)
        }
        continue
      }

      // Fields and Bloblang params: Example() takes a value, not prose.
      if (method !== 'Description' && method !== 'ShortDescription') continue
      if (args.length < 1) continue
      const kind = cls.kind === 'blobl-param'
        ? 'bloblang-param'
        : method === 'ShortDescription' ? 'field-short' : 'field'
      this.pushDecl(declarations, file, rel, {
        kind,
        name: nameOf(cls.name),
        nameResult: cls.name || null,
        nameExpr: cls.nameExpr || null,
        result: evalArg(0),
        valueExpr: { text: args[0], offset: argStart(0) },
        start: head.type === 'call' ? head.start : open,
        end: close,
        extra: { ctor: cls.ctor || null, ...(cls.via ? { via: cls.via } : {}), ...this.componentMeta(file, dot) }
      })
    }
    this.scanFieldCtors(file, rel, declarations, describedVars)
    this.scanJsFunctions(file, rel, declarations)
  }

  /**
   * javascript processor functions: `registerVMRunnerFunction(name,
   * description).Param(name, type, what)`. The processor renders each one
   * into its footnotes, so the description and every parameter's text are
   * published prose.
   */
  scanJsFunctions (file, rel, declarations) {
    const pkg = this.index.package(file.dir)
    const builders = [...pkg.funcs.values()].filter((fn) => kindOfType(fn.results) === 'js-function')
    if (builders.length === 0) return
    const masked = file.masked
    const meta = this.componentMeta(file, -1)
    for (const fn of builders) {
      const descIndex = fn.params.findIndex((p) => p.name === 'description')
      const nameIndex = fn.params.findIndex((p) => p.name === 'name')
      if (descIndex === -1) continue
      const re = new RegExp(`(^|[^\\w.])${escapeRe(fn.name)}\\s*\\(`, 'g')
      const text = stripStrings(masked)
      let m
      while ((m = re.exec(text)) !== null) {
        if (/\bfunc\s*$/.test(text.slice(Math.max(0, m.index - 10), m.index + m[1].length))) continue
        const open = m.index + m[0].length - 1
        const close = file.pairs.get(open)
        if (close === undefined) continue
        const args = splitTopLevelArgs(masked.slice(open + 1, close))
        const argStart = (i) => open + 1 + args.slice(0, i).reduce((n, a) => n + a.length + 1, 0)
        const nameResult = nameIndex !== -1 && args[nameIndex] ? this.evalAt(file, args[nameIndex], argStart(nameIndex)) : null
        const fnName = nameResult && isResolved(nameResult) ? renderResult(nameResult) : null
        if (args[descIndex] === undefined) continue
        declarations.push(this.makeDecl(file, rel, {
          kind: 'js-function',
          name: fnName,
          result: this.evalAt(file, args[descIndex], argStart(descIndex)),
          start: m.index + m[1].length,
          end: close,
          extra: { ...meta }
        }))
        for (const call of readChain(masked, file.pairs, close + 1)) {
          if (call.method !== 'Param') continue
          const pargs = splitTopLevelArgs(masked.slice(call.open + 1, call.close))
          if (pargs.length < 3) continue
          const pStart = (i) => call.open + 1 + pargs.slice(0, i).reduce((n, a) => n + a.length + 1, 0)
          const pname = this.evalAt(file, pargs[0], pStart(0))
          declarations.push(this.makeDecl(file, rel, {
            kind: 'js-function-param',
            name: fnName && isResolved(pname) ? `${fnName}.${renderResult(pname)}` : null,
            result: this.evalAt(file, pargs[2], pStart(2)),
            start: call.open,
            end: call.close,
            extra: { ...meta }
          }))
        }
      }
    }
  }

  /**
   * Field constructors: annotated enum options, and bare constructors that
   * never get a Description.
   */
  scanFieldCtors (file, rel, declarations, describedVars) {
    const masked = file.masked
    const { service } = this.aliases(file)
    if (service.size === 0) return
    const pattern = new RegExp(`\\b(?:${[...service].map(escapeRe).join('|')})\\s*\\.\\s*(New\\w*Field)\\s*\\(`, 'g')
    let m
    while ((m = pattern.exec(masked)) !== null) {
      const ctor = m[1]
      const open = m.index + m[0].length - 1
      const close = file.pairs.get(open)
      if (close === undefined) continue
      const args = splitTopLevelArgs(masked.slice(open + 1, close))
      const nameResult = args.length > 0 && args[0].trim() !== '' ? this.evalAt(file, args[0], open) : null
      const fieldName = nameResult && isResolved(nameResult) ? renderResult(nameResult) : null
      const calls = readChain(masked, file.pairs, close + 1)
      const end = calls.length > 0 ? calls[calls.length - 1].close : close

      if (ctor === 'NewStringAnnotatedEnumField' && args.length >= 2) {
        this.scanEnumOptions(file, rel, args[1], open + 1 + args[0].length + 1, fieldName, declarations)
      }

      if (!BARE_FIELD_CTORS.has(ctor)) continue
      // Deprecated fields are left out of the published reference.
      if (calls.some((c) => c.method === 'Description' || c.method === 'Deprecated')) continue
      // `f := service.NewStringField(...)` followed by
      // `f = f.Description(...)` documents the field by reassignment.
      const assigned = masked.slice(Math.max(0, m.index - 80), m.index).match(/(?:^|[^\w.])([A-Za-z_]\w*)\s*:?=\s*$/)
      if (assigned && describedVars.has(`${enclosingFuncKey(file, m.index)}\0${assigned[1]}`)) continue
      declarations.push(this.makeDecl(file, rel, {
        kind: 'field',
        name: fieldName,
        result: null,
        start: m.index,
        end,
        extra: { ctor, missing_description: true, ...this.componentMeta(file, m.index) }
      }))
    }
  }

  /** `map[string]string{"opt": "desc", ...}`, inline or in a variable. */
  scanEnumOptions (file, rel, argText, argStart, fieldName, declarations) {
    let text = argText
    let start = argStart
    let srcFile = file
    const trimmed = argText.trim()
    if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(trimmed)) {
      const fn = enclosingFunc(file, argStart)
      const local = fn && !trimmed.includes('.') ? this.lastAssignment(file, fn, trimmed, argStart) : null
      if (local && local.expr) {
        text = local.expr
        start = local.exprStart
      } else {
        const value = this.index.lookupValue(file, trimmed)
        if (!value || !value.expr) return
        text = value.expr
        start = value.exprStart
        srcFile = value.file
      }
    }
    const lit = text.match(/^\s*map\s*\[\s*string\s*\]\s*string\s*\{/)
    if (!lit) return
    const local = /^[A-Za-z_]\w*$/.test(trimmed) && srcFile === file ? enclosingFunc(file, argStart) : null
    if (local) this.scanEnumIndexAssignments(file, rel, local, trimmed, argStart, fieldName, declarations)
    const braceOpen = start + lit[0].length - 1
    const braceClose = srcFile.pairs.get(braceOpen)
    if (braceClose === undefined) return
    const srcRel = srcFile === file ? rel : this.index.rel(srcFile.abs)
    let offset = braceOpen + 1
    for (const entry of splitTopLevelArgs(srcFile.masked.slice(braceOpen + 1, braceClose))) {
      const entryStart = offset
      offset += entry.length + 1
      if (entry.trim() === '') continue
      const colon = topLevelColon(entry)
      if (colon === -1) continue
      const key = this.evalAt(srcFile, entry.slice(0, colon), entryStart)
      const value = this.evalAt(srcFile, entry.slice(colon + 1), entryStart + colon + 1)
      const opt = isResolved(key) ? renderResult(key) : null
      const lead = entry.length - entry.trimStart().length
      declarations.push(this.makeDecl(srcFile, srcRel, {
        kind: 'enum-option',
        name: fieldName && opt ? `${fieldName}=${opt}` : opt,
        result: value,
        start: entryStart + lead,
        end: entryStart + entry.trimEnd().length - 1,
        extra: { field: fieldName, option: opt, ...this.componentMeta(file, argStart) }
      }))
    }
  }

  /** `opts["key"] = "desc"` assignments that fill an enum option map. */
  scanEnumIndexAssignments (file, rel, fn, ident, before, fieldName, declarations) {
    const masked = file.masked
    const re = new RegExp(`(^|[^\\w.])${escapeRe(ident)}\\s*\\[`, 'g')
    const text = masked.slice(fn.bodyStart, before)
    let m
    while ((m = re.exec(text)) !== null) {
      const bracket = fn.bodyStart + m.index + m[0].length - 1
      const close = file.pairs.get(bracket)
      if (close === undefined) continue
      const assign = masked.slice(close + 1, close + 40).match(/^\s*=(?!=)\s*/)
      if (!assign) continue
      const exprStart = close + 1 + assign[0].length
      const exprEnd = statementEnd(masked, exprStart, fn.bodyEnd)
      const key = this.evalAt(file, masked.slice(bracket + 1, close), bracket)
      const opt = isResolved(key) ? renderResult(key) : null
      declarations.push(this.makeDecl(file, rel, {
        kind: 'enum-option',
        name: fieldName && opt ? `${fieldName}=${opt}` : opt,
        result: this.evalAt(file, masked.slice(exprStart, exprEnd), exprStart),
        start: bracket,
        end: exprEnd,
        extra: { field: fieldName, option: opt, ...this.componentMeta(file, before) }
      }))
    }
  }

  /** urfave/cli Command and Flag composite literals. */
  scanCli (file, rel, declarations) {
    const masked = file.masked
    const { cli } = this.aliases(file)
    const pattern = new RegExp(`\\b(?:${[...cli].map(escapeRe).join('|')})\\s*\\.\\s*(Command|\\w+Flag)\\s*\\{`, 'g')
    let m
    while ((m = pattern.exec(masked)) !== null) {
      const literal = m[1]
      const braceOpen = m.index + m[0].length - 1
      const braceClose = file.pairs.get(braceOpen)
      if (braceClose === undefined) continue
      const body = masked.slice(braceOpen + 1, braceClose)
      const fields = parseLiteralFields(body)
      const valueOf = (key) => {
        const f = fields.get(key)
        if (!f) return null
        const at = braceOpen + 1 + f.valueStart
        return {
          result: this.evalAt(file, body.slice(f.valueStart, f.end), at),
          start: braceOpen + 1 + f.start,
          end: braceOpen + f.end
        }
      }
      const nameField = valueOf('Name')
      const name = nameField && isResolved(nameField.result) ? renderResult(nameField.result) : null
      const keys = literal === 'Command'
        ? [['Usage', 'cli-usage'], ['UsageText', 'cli-usage-text'], ['ArgsUsage', 'cli-args-usage'], ['Description', 'cli-description']]
        : [['Usage', 'cli-flag']]
      for (const [key, kind] of keys) {
        const v = valueOf(key)
        if (!v) continue
        declarations.push(this.makeDecl(file, rel, {
          kind,
          name,
          result: v.result,
          start: v.start,
          end: v.end,
          convention: CLI_CONVENTION,
          extra: {
            literal: literal === 'Command' ? 'command' : literal,
            // rpk-docs formats CLI help like cobra help; it is not AsciiDoc.
            skip_rules: ['raw-pipe', 'unknown-attribute', 'broken-macro', 'too-short']
          }
        }))
      }
    }
  }
}

/** Repo-relative .go and template files to scan in a whole-repo run. */
function repoFiles (repo) {
  const out = []
  for (const root of SCAN_ROOTS) {
    for (const f of collectGoFiles(path.join(repo, root))) out.push(path.join(root, f))
    for (const f of collectTemplates(path.join(repo, root))) out.push(path.join(root, f))
  }
  return out
}

function collectTemplates (root, base = root, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'testdata' || entry.name === 'node_modules') continue
      collectTemplates(full, base, out)
    } else if (TEMPLATE_FILE.test(entry.name)) {
      out.push(path.relative(base, full))
    }
  }
  return out
}

const TEMPLATE_FILE = /\.tmpl\.ya?ml$/

/**
 * A config template (`*.tmpl.yaml`, registered with RegisterTemplateYAML):
 * its summary, description and field descriptions are published like a
 * component spec's.
 */
function scanTemplate (content, rel, scanner) {
  const YAML = require('yaml')
  const declarations = []
  let doc
  try {
    doc = YAML.parseDocument(content)
  } catch {
    return declarations
  }
  if (!doc || !YAML.isMap(doc.contents)) return declarations
  const lineIndex = (offset) => content.slice(0, offset).split('\n').length
  const name = doc.get('name')
  const type = doc.get('type')
  if (typeof name !== 'string' || typeof type !== 'string') return declarations
  const info = scanner.info.get(`${type}/${name}`)
  const meta = { components: [{ type, name, ...(info || {}) }], components_total: 1, config_template: true }
  const push = (kind, declName, node, extra = {}) => {
    if (!node || !YAML.isScalar(node) || typeof node.value !== 'string') return
    const [start, , end] = node.range
    const text = node.value.trim()
    declarations.push({
      surface: 'connect',
      name: declName,
      file: rel,
      line_start: lineIndex(start),
      line_end: lineIndex(Math.max(start, end - 1)),
      string: text === '' ? null : text,
      declaration_text: null,
      convention: CONVENTION,
      meta: { kind, ...meta, ...extra }
    })
  }
  push('summary', name, doc.contents.get('summary', true))
  push('description', name, doc.contents.get('description', true))
  const fields = doc.contents.get('fields', true)
  if (YAML.isSeq(fields)) {
    for (const field of fields.items) {
      if (!YAML.isMap(field)) continue
      const fieldName = field.get('name')
      const description = field.get('description', true)
      if (description) push('field', typeof fieldName === 'string' ? fieldName : null, description, { ctor: 'template' })
      else if (typeof fieldName === 'string') {
        const node = field.get('name', true)
        declarations.push({
          surface: 'connect',
          name: fieldName,
          file: rel,
          line_start: lineIndex(node.range[0]),
          line_end: lineIndex(node.range[0]),
          string: null,
          declaration_text: null,
          convention: CONVENTION,
          meta: { kind: 'field', ctor: 'template', missing_description: true, ...meta }
        })
      }
    }
  }
  return declarations
}

function spanText (content, start, end) {
  return content.split('\n').slice(start - 1, end).join('\n')
}

/**
 * Extract connect declarations.
 *
 * @param {Object} options
 * @param {string} options.repo - The connect (or benthos) checkout
 * @param {Set<string>} [options.files] - Repo-relative paths (diff mode);
 *   when omitted, scans internal/, public/ and cmd/
 * @param {boolean} [options.external=true] - Resolve benthos and other
 *   dependencies through the Go module cache when it holds them
 * @param {Map<string,string>} [options.overlay] - In-memory file contents
 * @returns {Array} declarations. The array also carries a non-enumerable
 *   `skipped` list: every doc-method call whose receiver could not be traced
 *   to a benthos type, so a caller can report it instead of losing it.
 */
function extract ({ repo, files = null, external = true, overlay = null }) {
  const index = new GoIndex(repo, { external, overlay })
  const scanner = new ConnectScanner(index, { repo })
  const fileList = files
    ? [...files].filter((f) => (f.endsWith('.go') && !f.endsWith('_test.go')) || TEMPLATE_FILE.test(f))
    : repoFiles(repo)
  const cache = new SourceCache(repo)
  const declarations = []
  const skipped = []
  for (const rel of fileList) {
    if (TEMPLATE_FILE.test(rel)) {
      let content = overlay && overlay.has(rel) ? overlay.get(rel) : null
      if (content === null) {
        try {
          content = fs.readFileSync(path.join(index.repo, rel), 'utf8')
        } catch {
          continue
        }
      }
      for (const decl of scanTemplate(content, rel, scanner)) {
        decl.declaration_text = spanText(content, decl.line_start, decl.line_end)
        declarations.push(decl)
      }
      continue
    }
    const file = index.file(path.isAbsolute(rel) ? rel : path.join(index.repo, rel))
    if (!file) continue
    const result = scanner.scan(file, rel)
    for (const decl of result.declarations) {
      decl.declaration_text = overlay && overlay.has(decl.file)
        ? spanText(overlay.get(decl.file), decl.line_start, decl.line_end)
        : cache.span(decl.file, decl.line_start, decl.line_end)
      declarations.push(decl)
    }
    skipped.push(...result.skipped)
  }
  Object.defineProperty(declarations, 'skipped', { value: skipped, enumerable: false })
  return declarations
}

/**
 * Scan one file's content with no checkout around it. Exported for tests:
 * only same-file constants and helpers resolve.
 */
function scanFile (content, file) {
  return extract({
    repo: path.join(path.sep, '__lint_strings_virtual__'),
    files: new Set([file]),
    external: false,
    overlay: new Map([[file, content]])
  })
}

// AsciiDoc and Markdown markup that a plain-text UI shows literally.
const MARKUP_PATTERNS = [
  [/`/, 'backticks'],
  [/\b(?:xref|link|image|include|glossterm):[^\s[]*\[/, 'an AsciiDoc macro'],
  [/https?:\/\/\S+\[[^\]]*\]/, 'an AsciiDoc link'],
  [/<<[^>]+>>/, 'a cross-reference'],
  [/\*\*[^*]+\*\*/, 'bold markup'],
  [/^\s*(?:=+|\*+|-|\.)\s/m, 'a heading or list marker'],
  [/\{[a-z][a-z0-9_-]*\}/, 'an attribute reference'],
  [/\n/, 'a line break']
]

const ENV_CONDITIONAL = /\b(?:ifdef|ifndef|ifeval|endif)::/

// Modules of the Redpanda Connect docs component. A generated partial is
// rendered on the self-managed page and included into Cloud pages, so a
// link needs an explicit module to resolve in both places.
const XREF_MODULES = new Set(['components', 'configuration', 'cookbooks', 'get-started', 'guides', 'install', 'reference'])

const AVAILABILITY_PROSE = /\b(?:not (?:available|supported) (?:in|on) (?:Redpanda )?Cloud|only available (?:in|on|for) (?:self-managed|Redpanda Cloud|Cloud)|self-managed only|requires? (?:a )?cgo|CGO_ENABLED|x_benthos_extra)\b/i

/** Surface-specific convention rules. */
const RULES = [
  {
    name: 'missing-field-description',
    description: 'Config field constructed with no .Description()',
    severity: 'warning',
    check: (decl) => {
      if (decl.meta.kind !== 'field' || !decl.meta.missing_description) return []
      return [{ message: `Field ${decl.name ? `"${decl.name}" ` : ''}(${decl.meta.ctor}) has no .Description(). It ships as an undocumented field on the connector page.` }]
    }
  },
  {
    name: 'connect-short-description-markup',
    description: 'ShortDescription is plain text in form-based editors',
    severity: 'warning',
    check: (decl) => {
      if (decl.meta.kind !== 'field-short' || !decl.string) return []
      const found = MARKUP_PATTERNS.filter(([re]) => re.test(decl.string)).map(([, what]) => what)
      if (found.length === 0) return []
      return [{ message: `ShortDescription contains ${found.join(', ')}. Form-based config editors, such as the one in Redpanda Cloud, show it as plain text, so markup renders literally. Write one plain sentence and keep markup in Description().` }]
    }
  },
  {
    name: 'connect-env-conditional',
    description: 'AsciiDoc ifdef/ifndef conditional in a Go spec string',
    severity: 'warning',
    check: (decl) => {
      if (!decl.string || !ENV_CONDITIONAL.test(decl.string)) return []
      return [{ message: 'Contains an AsciiDoc conditional (ifdef::, ifndef:: or endif::). The docs generator owns every Cloud conditional in the partials, and a hand-written one nests inside them, so the Cloud copy shows or hides the wrong text. Fix the availability data in internal/plugins/info.csv instead, or ask the docs team to carry the sentence on the page.' }]
    }
  },
  {
    name: 'connect-xref-module',
    description: 'xref without a module, or to a module the Connect docs do not have',
    severity: 'warning',
    check: (decl) => {
      if (!decl.string || (decl.convention && decl.convention.verbatim_asciidoc === false)) return []
      const issues = []
      for (const m of decl.string.matchAll(/\bxref:([^\s[\]]+)\[/g)) {
        const parts = m[1].split(':')
        // component:module:page names its docs component, so it resolves
        // wherever the partial is included.
        if (parts.length >= 3) continue
        if (parts.length === 2 && XREF_MODULES.has(parts[0])) continue
        issues.push({
          message: parts.length === 1
            ? `"xref:${m[1]}[" has no module. It resolves on the self-managed page, but Cloud includes the same partial into its own module, where the link breaks. Name the module, for example xref:components:${m[1]}[...].`
            : `"xref:${m[1]}[" names the ${parts[0]} module, which the Redpanda Connect docs do not have, so the link breaks on the rendered page. Use one of ${[...XREF_MODULES].join(', ')}, a component:module:page xref, or a full https:// link.`
        })
      }
      return issues
    }
  },
  {
    name: 'connect-availability-prose',
    description: 'Cloud or cgo availability written as prose instead of data',
    severity: 'warning',
    check: (decl) => {
      if (!decl.string) return []
      const m = decl.string.match(AVAILABILITY_PROSE)
      if (!m) return []
      return [{ message: `States availability in prose ("${m[0]}"). The generator renders Cloud and cgo availability notes from internal/plugins/info.csv and the build lists, and prose here shows on both the self-managed and the Cloud page. Remove it and fix the data instead.` }]
    }
  },
  {
    name: 'connect-cli-usage-multiline',
    description: 'urfave/cli Usage is a one-line label',
    severity: 'warning',
    check: (decl) => {
      if (decl.meta.kind !== 'cli-usage' && decl.meta.kind !== 'cli-flag') return []
      if (!decl.string || !decl.string.includes('\n')) return []
      return [{ message: 'Usage spans multiple lines. `rpk connect` help prints Usage as a one-line label, so move detail into the command Description.' }]
    }
  }
]

/**
 * Where a declaration lives, for removal matching. Field names (`url`,
 * `topic`, `enabled`) repeat across components, and a component name repeats
 * across its input and output, so the key is the file, the kind and the name.
 * Same-file repeats (nested object fields) are handled by counting in the
 * caller.
 */
function identity (decl) {
  return [decl.file, (decl.meta && decl.meta.kind) || null, decl.name]
}

const DETAIL_KEYS = ['kind', 'part', 'ctor', 'field', 'option', 'components', 'components_total', 'components_via', 'call_site', 'template', 'unresolved', 'config_template']

/**
 * What a review needs beyond the string: the kind of declaration, the
 * components that publish it with their info.csv row (support level, Cloud
 * and Cloud GPU availability), and, for helper text, the call site and the
 * template with its gaps.
 */
function reviewContext (decl) {
  const meta = decl.meta || {}
  const out = {}
  for (const key of DETAIL_KEYS) if (meta[key] !== undefined && meta[key] !== null) out[key] = meta[key]
  return out
}

module.exports = {
  name: 'connect',
  convention: CONVENTION,
  extract,
  scanFile,
  identity,
  reviewContext,
  readInfoCsv,
  chainHead,
  kindOfType,
  _ConnectScanner: ConnectScanner,
  rules: RULES,
  // A connect description is the AsciiDoc page body, not a table cell:
  // bare | is legitimate table syntax there, and missing prose is handled
  // by the connect-specific missing-field-description warning. Brace
  // placeholders ({endpoint}, {my-domain}) are the established URL-template
  // idiom in connect descriptions, so the unknown-attribute check is noise.
  skipRules: ['raw-pipe', 'empty-description', 'unknown-attribute']
}
