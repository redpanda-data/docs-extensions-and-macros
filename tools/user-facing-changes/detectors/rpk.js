'use strict'

const path = require('path')
const { stripComments, matchBracket, splitArgs, literalValue, lineAt, normalize } = require('../source')
const { makeFinding, PAGES } = require('../finding')
const { sameValue } = require('../values')

/**
 * rpk commands and flags (src/go/rpk/pkg/cli/**, non-test Go).
 *
 * The lint reviews Short, Long and flag usage strings. This detector reads
 * what those strings describe: each cobra.Command literal's Use (the
 * command name), Aliases, Hidden and Deprecated fields, and every pflag
 * registration (`cmd.Flags().BoolVarP(&dry, "dry", "d", false, "...")`,
 * through a flag set bound to a variable first, or through a helper such
 * as `p.InstallFormatFlag(cmd)` or `opts.InstallFlags(f)` defined in the
 * same package or an imported rpk package), with the flag's name, default
 * and target variable. MarkHidden and MarkDeprecated calls are read too,
 * and so is `cobraext.DeprecateCmd(newXCommand(...), "...")`, which hides
 * and deprecates the command it wraps.
 *
 * Flags belong to the command they are registered on: the command
 * variable in the same function, so a file that builds two commands
 * (`rpk cluster logdirs` and `rpk cluster logdirs describe`) attributes
 * each flag to its own. A command's full path comes from the directory
 * tree, with each directory named by the Use of the command its
 * `<dir>/<dir>.go` file builds (cli/cluster/selftest is `rpk cluster
 * self-test`), and from `cmd.AddCommand(newChild(...))` inside one file.
 *
 * Both sides of each changed file are parsed and compared per command and
 * per flag. A removed command whose Use is an alias of the added one is a
 * rename that keeps the old name working. A removed flag whose target
 * variable reappears under a new name is a renamed flag. Defaults are
 * compared by value (values.js), and a call that only moved package
 * (`common.DefaultRedpandaImage()` to `containerutil.DefaultRedpandaImage()`)
 * is the same default.
 */

const CLI_ROOT = 'src/go/rpk/pkg/cli'
const ROUTES = [/^src\/go\/rpk\/pkg\/cli\/(?:.*\/)?(?!.*_test\.go$)[^/]+\.go$/]

const FLAG_METHOD = /^(String|Bool|Int|Uint|Float|Duration|Count|Bytes|IP)[A-Za-z0-9]*$/
const COMMAND_LITERAL = /&?\s*cobra\.Command\{/g
const FUNC = /(^|\n)func\s+(?:\(\s*[A-Za-z_]\w*\s+\*?\s*[\w.]+\s*\)\s*)?([A-Za-z_]\w*)\s*\(/g
const MARK = /([A-Za-z_]\w*(?:\s*\.\s*(?:Flags|PersistentFlags)\s*\(\s*\))?)\s*\.\s*Mark(Hidden|Deprecated)\s*\(\s*([^,)]+)/g
const DEPRECATE_CMD = /\bDeprecateCmd\s*\(/g
const HELPER_CALL = /\b([A-Za-z_]\w*)\s*\.\s*(Install[A-Za-z0-9]*)\s*\(\s*([^()]*?(?:\(\s*\))?)\s*\)/g
const PLAIN_HELPER_CALL = /(?<![.\w])([a-z]\w*)\s*\(\s*([A-Za-z_]\w*)\s*[,)]/g

/** Top-level functions: name, body span and parameter list. */
function parseFunctions (text) {
  const out = []
  FUNC.lastIndex = 0
  let m
  while ((m = FUNC.exec(text)) !== null) {
    const parenOpen = m.index + m[0].length - 1
    const parenClose = matchBracket(text, parenOpen)
    if (parenClose === -1) continue
    const brace = text.indexOf('{', parenClose)
    if (brace === -1) continue
    // A function type in the result list (`func() error`) has no body
    // brace before its own `{`; the first `{` after the params is the body.
    const close = matchBracket(text, brace)
    out.push({ name: m[2], start: m.index + m[1].length, open: brace, close: close === -1 ? text.length : close, params: text.slice(parenOpen + 1, parenClose) })
  }
  return out
}

function rawGoString (s) {
  const t = String(s || '').trim()
  const m = /^`([\s\S]*)`$/.exec(t)
  return m ? m[1] : null
}

/** A flag name argument: a literal, or a string constant of the package. */
function nameArg (arg, resolveConst) {
  const lit = literalValue(arg) ?? rawGoString(arg)
  if (lit !== null) return lit
  const id = String(arg || '').trim()
  if (resolveConst && /^[A-Za-z_][\w.]*$/.test(id)) return resolveConst(id.split('.').pop())
  return null
}

/** A pflag call shape: `(&v, "name", ...)` for a Var method, `("name", ...)` otherwise. */
function looksLikeRegistration (text, open, method) {
  const close = matchBracket(text, open)
  if (close === -1) return false
  const args = splitArgs(text.slice(open + 1, close))
  const isVar = /Var/.test(method)
  if (args.length < (isVar ? 3 : 2)) return false
  if (isVar && !/^&/.test(String(args[0]).trim())) return false
  return literalValue(args[isVar ? 1 : 0]) !== null
}

/**
 * Parse one Go file (or hunk snippets of one).
 *
 * @param {Array<{startLine: number, text: string}>} snippets
 * @param {object} [opts]
 * @param {(name: string) => string|null} [opts.resolveConst] - a package string constant's value
 * @param {boolean} [opts.loose] - hunk-only mode: accept flag registrations on a receiver whose binding is above the window
 */
function parseGo (snippets, { resolveConst = null, loose = false } = {}) {
  const commands = new Map()
  const flags = new Map()
  const hidden = new Set()
  const deprecated = new Set()
  const unresolved = []
  const helperCalls = []
  const deprecations = []
  const children = new Map() // parent use -> [function names]
  const funcCommand = new Map() // function name -> use of the command it returns
  const helperFlags = [] // flags registered on a parameter: { func, flag }
  for (const { startLine, text: raw } of snippets) {
    const text = stripComments(raw)
    const functions = parseFunctions(text)
    const funcAt = (offset) => functions.find((f) => offset > f.open && offset < f.close) || null
    // Commands.
    const varCommand = new Map() // `${func}\0${var}` -> use
    COMMAND_LITERAL.lastIndex = 0
    let m
    while ((m = COMMAND_LITERAL.exec(text)) !== null) {
      const open = m.index + m[0].length - 1
      const close = matchBracket(text, open)
      const line = lineAt(text, m.index, startLine)
      if (close === -1) { unresolved.push({ line, what: 'cobra.Command literal' }); continue }
      const fields = splitArgs(text.slice(open + 1, close))
      const cmd = { line, lineEnd: lineAt(text, close, startLine), use: null, aliases: [], hidden: false, deprecated: null }
      for (const field of fields) {
        const fm = /^(Use|Hidden|Deprecated|Aliases)\s*:\s*([\s\S]+)$/.exec(field.trim())
        if (!fm) continue
        if (fm[1] === 'Use') {
          const v = literalValue(fm[2]) ?? rawGoString(fm[2])
          if (v) cmd.use = v.trim().split(/\s+/)[0]
        } else if (fm[1] === 'Hidden') cmd.hidden = /^true$/.test(fm[2].trim())
        else if (fm[1] === 'Deprecated') cmd.deprecated = literalValue(fm[2]) ?? rawGoString(fm[2]) ?? fm[2].trim()
        else if (fm[1] === 'Aliases') {
          const body = /\{([\s\S]*)\}/.exec(fm[2])
          if (body) cmd.aliases = splitArgs(body[1]).map((a) => literalValue(a)).filter(Boolean)
        }
      }
      if (!cmd.use) continue
      const fn = funcAt(m.index)
      cmd.func = fn ? fn.name : null
      commands.set(cmd.use, cmd)
      const assigned = /([A-Za-z_]\w*)\s*:?=\s*&?\s*$/.exec(text.slice(Math.max(0, m.index - 80), m.index + (text[m.index] === '&' ? 1 : 0)).replace(/&\s*$/, ''))
      if (fn) {
        if (assigned) varCommand.set(`${fn.name}\0${assigned[1]}`, cmd.use)
        if (!funcCommand.has(fn.name)) funcCommand.set(fn.name, cmd.use)
      }
    }
    // The command a receiver expression stands for, in function fn: a
    // command variable, or a flag set bound from one.
    const flagsetVars = new Map() // `${func}\0${var}` -> command var
    const assign = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*([A-Za-z_]\w*)\s*\.\s*(?:Flags|PersistentFlags)\s*\(\s*\)/g
    while ((m = assign.exec(text)) !== null) {
      const fn = funcAt(m.index)
      if (fn) flagsetVars.set(`${fn.name}\0${m[1]}`, m[2])
    }
    const commandOf = (fn, receiver, { strict = false } = {}) => {
      if (!fn) return null
      const r = receiver.replace(/\s+/g, '')
      const direct = /^([A-Za-z_]\w*)\.(?:Flags|PersistentFlags)\(\)$/.exec(r)
      const v = direct ? direct[1] : (flagsetVars.get(`${fn.name}\0${r}`) || r)
      if (varCommand.has(`${fn.name}\0${v}`)) return { use: varCommand.get(`${fn.name}\0${v}`) }
      // A parameter of the function: a helper that registers flags on
      // whatever command its caller passes.
      if (new RegExp(`(?:^|[,(\\s])${v}\\s+(?:\\*\\s*)?(?:cobra\\.Command|pflag\\.FlagSet)\\b`).test(fn.params)) return { param: true }
      // `cmd.Flags()` on a command variable this parse did not see bound
      // (an assignment the hunk cut): the function's only command.
      if (strict) return null
      const own = [...varCommand.entries()].filter(([k]) => k.startsWith(`${fn.name}\0`))
      if (own.length === 1) return { use: own[0][1] }
      return null
    }
    // Flag registrations, direct and through a bound flag set.
    const patterns = [/([A-Za-z_]\w*\s*\.\s*(?:Flags|PersistentFlags)\s*\(\s*\))\s*\.\s*([A-Za-z0-9]+)\s*\(/g]
    const boundVars = [...new Set([...flagsetVars.keys()].map((k) => k.split('\0')[1]))]
    if (boundVars.length > 0) patterns.push(new RegExp(`\\b(${boundVars.join('|')})\\s*\\.\\s*([A-Za-z0-9]+)\\s*\\(`, 'g'))
    // Helper parameters (`f *pflag.FlagSet`, `pf := cmd.PersistentFlags()` in a helper).
    patterns.push(/\b([a-z][A-Za-z0-9_]*)\s*\.\s*([A-Z][A-Za-z0-9]+)\s*\(/g)
    const seenAt = new Set()
    patterns.forEach((re, pi) => {
      // The last pattern matches any `x.Method(`: only a receiver that is a
      // command or flag-set parameter, or a known binding, counts there,
      // so `strings.Count(` is never a flag.
      const generic = pi === patterns.length - 1
      re.lastIndex = 0
      while ((m = re.exec(text)) !== null) {
        const method = m[2]
        if (!FLAG_METHOD.test(method) || seenAt.has(m.index + m[0].length)) continue
        const fn = funcAt(m.index)
        const owner = commandOf(fn, m[1], { strict: generic })
        // Hunk-only mode: the binding (`f := cmd.Flags()`) may sit above
        // the window, so a registration-shaped call on an unknown receiver
        // still counts, attributed to the file's command.
        const looseOk = loose && !owner && looksLikeRegistration(text, m.index + m[0].length - 1, method)
        if (!owner && !looseOk) continue
        seenAt.add(m.index + m[0].length)
        const open = m.index + m[0].length - 1
        const close = matchBracket(text, open)
        const line = lineAt(text, m.index, startLine)
        if (close === -1) { unresolved.push({ line, what: `${method} flag registration` }); continue }
        const args = splitArgs(text.slice(open + 1, close))
        const isVar = /Var/.test(method)
        const hasShort = /P$/.test(method)
        const nameIdx = isVar ? 1 : 0
        const name = nameArg(args[nameIdx], resolveConst)
        if (!name) continue
        const defaultIdx = nameIdx + 1 + (hasShort ? 1 : 0)
        const noDefault = /^Count/.test(method)
        const defaultText = noDefault || defaultIdx >= args.length - 1 ? null : normalize(args[defaultIdx])
        const flag = { name, line, lineEnd: lineAt(text, close, startLine), method, defaultText, target: isVar ? normalize(args[0]) : null }
        if (owner && owner.param) { helperFlags.push({ func: fn.name, flag }); continue }
        flag.command = owner ? owner.use : null
        flags.set(`${flag.command || ''}\t${name}`, flag)
      }
    })
    MARK.lastIndex = 0
    while ((m = MARK.exec(text)) !== null) {
      const name = nameArg(m[3], resolveConst)
      if (name) (m[2] === 'Hidden' ? hidden : deprecated).add(name)
    }
    // Helpers that install flags onto a command: `p.InstallKafkaFlags(cmd)`.
    HELPER_CALL.lastIndex = 0
    while ((m = HELPER_CALL.exec(text)) !== null) {
      const fn = funcAt(m.index)
      const owner = commandOf(fn, m[3])
      if (!owner) continue
      helperCalls.push({ callee: m[2], receiver: m[1], command: owner.use || null, inHelper: !!owner.param, func: fn ? fn.name : null, line: lineAt(text, m.index, startLine) })
    }
    // Plain helper functions that take the command: `addFlags(cmd, &opts)`.
    PLAIN_HELPER_CALL.lastIndex = 0
    while ((m = PLAIN_HELPER_CALL.exec(text)) !== null) {
      const fn = funcAt(m.index)
      const owner = commandOf(fn, m[2], { strict: true })
      if (owner) helperCalls.push({ callee: m[1], receiver: null, command: owner.use || null, inHelper: !!owner.param, func: fn ? fn.name : null, line: lineAt(text, m.index, startLine) })
    }
    // In-file children: `cmd.AddCommand(newChild(fs, p), ...)`.
    const addCmd = /\b([A-Za-z_]\w*)\s*\.\s*AddCommand\s*\(/g
    while ((m = addCmd.exec(text)) !== null) {
      const fn = funcAt(m.index)
      const parent = fn ? varCommand.get(`${fn.name}\0${m[1]}`) : null
      const open = m.index + m[0].length - 1
      const close = matchBracket(text, open)
      if (close === -1) continue
      for (const arg of splitArgs(text.slice(open + 1, close))) {
        const call = /^(?:[\w.]*DeprecateCmd\s*\(\s*)?([A-Za-z_]\w*)\s*\(/.exec(arg.trim())
        if (call && parent) {
          if (!children.has(parent)) children.set(parent, [])
          children.get(parent).push(call[1])
        }
      }
    }
    // cobraext.DeprecateCmd(newXCommand(...), "rpk new command")
    DEPRECATE_CMD.lastIndex = 0
    while ((m = DEPRECATE_CMD.exec(text)) !== null) {
      const open = m.index + m[0].length - 1
      const close = matchBracket(text, open)
      if (close === -1) continue
      const args = splitArgs(text.slice(open + 1, close))
      const call = /^([A-Za-z_]\w*)\s*\(/.exec((args[0] || '').trim())
      if (!call) continue
      deprecations.push({ callee: call[1], message: literalValue(args[1]) || '', line: lineAt(text, m.index, startLine) })
    }
  }
  // Source order, whichever registration pattern found a flag first.
  const ordered = new Map([...flags.entries()].sort((a, b) => a[1].line - b[1].line))
  return { commands, flags: ordered, hidden, deprecated, unresolved, helperCalls, helperFlags, deprecations, children, funcCommand }
}

/**
 * The command a file implements, from its path alone: rpk mirrors the
 * command tree in directories (cli/shadow/create.go is `rpk shadow
 * create`). The Use token from the file's own cobra.Command wins over the
 * basename. Kept for callers without a checkout; detect() resolves each
 * directory's own Use when it can read it.
 */
function commandPath (file, use, dirUse = (d) => path.posix.basename(d)) {
  const rel = file.replace(/^src\/go\/rpk\/pkg\/cli\//, '').replace(/\.go$/, '')
  const parts = rel.split('/')
  const base = parts.pop()
  const dirs = []
  for (let i = 0; i < parts.length; i++) dirs.push(dirUse(`${CLI_ROOT}/${parts.slice(0, i + 1).join('/')}`, parts[i]) || parts[i])
  const leaf = use || base
  // The directory's own command file names the directory command.
  if (parts.length > 0 && (base === parts[parts.length - 1] || dirs[dirs.length - 1] === leaf)) dirs.pop()
  if (leaf === 'root' || leaf === 'rpk') return 'rpk'
  // A package directory with no command of its own (cli/version holds only
  // versioncmd/) adds no token: collapse a repeated one.
  return ['rpk', ...dirs, leaf].filter((t, i, all) => i === 0 || t !== all[i - 1]).join(' ')
}

/**
 * The full path of every command in a parsed file: in-file children under
 * their parent, everything else under the file's directory.
 */
function commandPaths (file, parsed, dirUse) {
  const paths = new Map()
  const childOf = new Map()
  for (const [parent, funcs] of parsed.children) {
    for (const fn of funcs) {
      const use = parsed.funcCommand.get(fn)
      if (use && use !== parent) childOf.set(use, parent)
    }
  }
  const resolve = (use, depth = 0) => {
    if (paths.has(use)) return paths.get(use)
    const parent = childOf.get(use)
    const p = parent && depth < 8 ? `${resolve(parent, depth + 1)} ${use}` : commandPath(file, use, dirUse)
    paths.set(use, p)
    return p
  }
  for (const use of parsed.commands.keys()) resolve(use)
  return paths
}

/** Go import path -> repo-relative directory, for rpk's own packages. */
function importDirs (text) {
  const out = new Map() // package name or alias -> dir
  const block = /\bimport\s*\(([\s\S]*?)\)/.exec(text)
  const lines = block ? block[1].split('\n') : []
  const single = /\bimport\s+((?:[A-Za-z_]\w*\s+)?"[^"]+")/.exec(text)
  if (single) lines.push(single[1])
  for (const l of lines) {
    const m = /^\s*(?:([A-Za-z_]\w*)\s+)?"([^"]+)"/.exec(l)
    if (!m) continue
    const i = m[2].indexOf('/src/go/rpk/')
    if (i === -1) continue
    const dir = m[2].slice(i + 1)
    out.set(m[1] || path.posix.basename(dir), dir)
  }
  return out
}

/**
 * Reads a package's files on one side of the diff and answers the
 * questions a file's parse leaves open: a string constant's value, the
 * flags a helper method installs, the Use of a directory's command, and
 * the command a function in a sibling file builds.
 */
function packageContext ({ read, list }) {
  const dirCache = new Map()
  const dirFiles = (dir) => {
    if (dirCache.has(dir)) return dirCache.get(dir)
    const names = list ? (list(dir) || []) : []
    const files = names.filter((p) => /\.go$/.test(p) && !/_test\.go$/.test(p) && path.posix.dirname(p) === dir)
      .map((p) => ({ path: p, text: read ? read(p) : null })).filter((f) => f.text)
    dirCache.set(dir, files)
    return files
  }
  const constCache = new Map()
  const consts = (dir) => {
    if (constCache.has(dir)) return constCache.get(dir)
    const out = new Map()
    for (const f of dirFiles(dir)) {
      const text = stripComments(f.text)
      const re = /(?:^|\n)\s*(?:const\s+)?([A-Za-z_]\w*)\s*(?:string\s*)?=\s*("(?:[^"\\]|\\.)*"|`[^`]*`)/g
      let m
      while ((m = re.exec(text)) !== null) if (!out.has(m[1])) out.set(m[1], literalValue(m[2]) ?? rawGoString(m[2]))
    }
    constCache.set(dir, out)
    return out
  }
  const resolveConstIn = (dir) => (name) => consts(dir).get(name) ?? null
  const helperCache = new Map()
  // The visible flags a helper method installs: { name, hidden, defaultText }.
  const helperFlags = (dirs, callee, depth = 0) => {
    const key = `${dirs.join(',')}\0${callee}`
    if (helperCache.has(key)) return helperCache.get(key)
    helperCache.set(key, [])
    let out = null
    for (const dir of dirs) {
      for (const f of dirFiles(dir)) {
        if (!new RegExp(`\\bfunc\\s+(?:\\([^)]*\\)\\s*)?${callee}\\s*\\(`).test(f.text)) continue
        const parsed = parseGo([{ startLine: 1, text: f.text }], { resolveConst: resolveConstIn(dir) })
        const mine = parsed.helperFlags.filter((h) => h.func === callee).map((h) => h.flag)
        const nested = depth < 3
          ? parsed.helperCalls.filter((c) => c.func === callee && c.inHelper).flatMap((c) => helperFlags([dir, ...dirs.filter((d) => d !== dir)], c.callee, depth + 1))
          : []
        out = [...mine.map((fl) => ({ ...fl, hidden: parsed.hidden.has(fl.name), deprecated: parsed.deprecated.has(fl.name) })), ...nested]
          .map((fl) => ({ ...fl, hidden: fl.hidden || parsed.hidden.has(fl.name), deprecated: fl.deprecated || parsed.deprecated.has(fl.name) }))
        break
      }
      if (out) break
    }
    helperCache.set(key, out || [])
    return out || []
  }
  const useCache = new Map()
  // The Use of the command a directory's own <dir>/<dir>.go builds.
  const dirUse = (dir, fallback) => {
    if (useCache.has(dir)) return useCache.get(dir)
    let use = null
    // Usually <dir>/<dir>.go; otherwise the file whose command adds
    // children built in the directory's other files
    // (debug/remotebundle/remote.go is `remote-bundle`).
    const own = `${dir}/${path.posix.basename(dir)}.go`
    const candidates = [{ path: own, text: read ? read(own) : null }, ...dirFiles(dir).filter((f) => f.path !== own)]
    for (const { path: p, text } of candidates) {
      if (!text) continue
      const parsed = parseGo([{ startLine: 1, text }])
      const tops = [...parsed.commands.values()].filter((c) => ![...parsed.children.values()].some((fns) => fns.includes(c.func)))
      const adopts = (c) => (parsed.children.get(c.use) || []).some((fn) => !parsed.funcCommand.has(fn))
      const top = p === own ? tops[0] : tops.find(adopts)
      if (top) { use = top.use; break }
    }
    useCache.set(dir, use || fallback || path.posix.basename(dir))
    return useCache.get(dir)
  }
  // The Use of the command function `fn` builds, from the files of `dir`.
  const funcUse = (dir, fn) => {
    for (const f of dirFiles(dir)) {
      if (!new RegExp(`\\bfunc\\s+${fn}\\s*\\(`).test(f.text)) continue
      const parsed = parseGo([{ startLine: 1, text: f.text }])
      const use = parsed.funcCommand.get(fn)
      if (use) return { use, file: f.path, paths: commandPaths(f.path, parsed, dirUse) }
    }
    return null
  }
  return { resolveConstIn, helperFlags, dirUse, funcUse }
}

/** Default text compared by value, and ignoring a package qualifier that moved. */
function sameDefault (a, b) {
  if (sameValue(a, b, 'go')) return true
  const strip = (t) => String(t).replace(/\s+/g, '').replace(/(^|[^\w.])(?:[a-z]\w*\.)+(?=[A-Z]\w*\()/g, '$1')
  return strip(a) === strip(b)
}

function detect ({ files, sides, excerpt, note, readBase, readHead, listHead, listBase }) {
  const findings = []
  const ctxBase = packageContext({ read: readBase, list: listBase || listHead })
  const ctxHead = packageContext({ read: readHead, list: listHead })
  for (const file of files) {
    const { base, head, partial } = sides(file)
    const dir = path.posix.dirname(file.path)
    const parseSide = (snippets, ctx, oldDir) => {
      const parsed = parseGo(snippets, { resolveConst: ctx.resolveConstIn(oldDir), loose: partial })
      // Flags a helper installs count as the calling command's own.
      const text = snippets.map((s) => s.text).join('\n')
      const imports = importDirs(text)
      for (const call of parsed.helperCalls) {
        if (call.inHelper || !call.command) continue
        const dirs = [oldDir, ...imports.values()]
        for (const fl of ctx.helperFlags(dirs, call.callee)) {
          if (fl.hidden) parsed.hidden.add(fl.name)
          if (fl.deprecated) parsed.deprecated.add(fl.name)
          const key = `${call.command}\t${fl.name}`
          if (!parsed.flags.has(key)) parsed.flags.set(key, { ...fl, command: call.command, line: call.line, lineEnd: call.line, via: call.callee })
        }
      }
      return parsed
    }
    const b = parseSide(base, ctxBase, path.posix.dirname(file.oldPath))
    const h = parseSide(head, ctxHead, dir)
    if (partial) {
      for (const u of [...b.unresolved, ...h.unresolved]) {
        note(`${file.path}:${u.line}: ${u.what} is cut by the hunk; run with --repo to read the whole file`, { file: file.path, line: u.line })
      }
    }
    const bPaths = commandPaths(file.oldPath, b, ctxBase.dirUse)
    const hPaths = commandPaths(file.path, h, ctxHead.dirUse)
    const soleUse = (p) => (p.commands.size === 1 ? [...p.commands.keys()][0] : null)
    // A flag with no command of its own (hunk-only mode) belongs to the
    // file's only command, or to the file's path.
    const pathOf = (paths, parsed, filePath, use) => (use && paths.get(use)) || commandPath(filePath, use || soleUse(parsed), ctxHead.dirUse)
    const common = { detector: 'rpk', surface: 'rpk', file: file.path, page: PAGES.rpk }

    // Commands.
    const removedCmds = [...b.commands.keys()].filter((u) => !h.commands.has(u) && !b.commands.get(u).hidden)
    const addedCmds = [...h.commands.keys()].filter((u) => !b.commands.has(u) && !h.commands.get(u).hidden)
    const renamedTo = new Map()
    for (const old of removedCmds) {
      const byAlias = addedCmds.find((u) => !renamedTo.has(u) && h.commands.get(u).aliases.includes(old))
      if (byAlias) renamedTo.set(byAlias, old)
    }
    if (removedCmds.length === 1 && addedCmds.length === 1 && !renamedTo.size) renamedTo.set(addedCmds[0], removedCmds[0])
    for (const [toUse, fromUse] of renamedTo) {
      const from = b.commands.get(fromUse)
      const to = h.commands.get(toUse)
      const aliased = to.aliases.includes(fromUse)
      const toPath = hPaths.get(toUse)
      const fromPath = bPaths.get(fromUse)
      findings.push(makeFinding({
        ...common,
        name: toPath,
        change_kind: 'renamed',
        // The old name still runs: the reference moves, no page breaks.
        severity: aliased ? 'medium' : undefined,
        line: to.line,
        evidence: excerpt(file, 'head', to.line, to.lineEnd),
        summary: aliased
          ? `\`${fromPath}\` was renamed to \`${toPath}\` in \`${file.path}\`; \`${fromUse}\` stays as an alias, so commands that use the old name keep working. The rpk reference regenerates the page under the new name; pages that use the old name should move to the new one.`
          : `The command in \`${file.path}\` changed its Use from \`${from.use}\` to \`${to.use}\` (\`${fromPath}\` to \`${toPath}\`). The rpk reference regenerates the page under the new name; every page that runs the old command states a command that no longer exists.`
      }))
    }
    for (const use of removedCmds) {
      if ([...renamedTo.values()].includes(use)) continue
      const c = b.commands.get(use)
      findings.push(makeFinding({
        ...common,
        name: bPaths.get(use),
        change_kind: 'removed',
        line: c.line,
        evidence: excerpt(file, 'base', c.line, c.lineEnd),
        summary: `The command \`${bPaths.get(use)}\` (Use \`${use}\` in \`${file.oldPath}\`) was removed. Every page that runs it states a command that no longer exists.`
      }))
    }
    for (const use of addedCmds) {
      if (renamedTo.has(use)) continue
      const c = h.commands.get(use)
      findings.push(makeFinding({
        ...common,
        name: hPaths.get(use),
        change_kind: c.deprecated ? 'deprecated' : 'added',
        line: c.line,
        evidence: excerpt(file, 'head', c.line, c.lineEnd),
        summary: `New command \`${hPaths.get(use)}\` (Use \`${use}\` in \`${file.path}\`). The rpk reference generates its page on regeneration; any task or guide that should use it needs writing.`
      }))
    }
    for (const [use, c] of h.commands) {
      const prev = b.commands.get(use)
      if (!prev) continue
      const name = hPaths.get(use)
      if (c.deprecated && !prev.deprecated) {
        findings.push(makeFinding({
          ...common, name, change_kind: 'deprecated', line: c.line, evidence: excerpt(file, 'head', c.line, c.lineEnd),
          summary: `\`${name}\` is now deprecated in \`${file.path}\`: ${c.deprecated}. Pages that recommend it now recommend a deprecated command.`
        }))
      } else if (c.hidden && !prev.hidden) {
        findings.push(makeFinding({
          ...common, name, change_kind: 'removed', line: c.line, evidence: excerpt(file, 'head', c.line, c.lineEnd), detail: 'hidden',
          summary: `\`${name}\` is now Hidden in \`${file.path}\`, so it leaves rpk help and the generated reference. Every page that runs it needs another route.`
        }))
      }
    }
    // cobraext.DeprecateCmd wrapped around a child this run did not see
    // before: that command is hidden and deprecated.
    for (const d of h.deprecations) {
      if (b.deprecations.some((x) => x.callee === d.callee)) continue
      const local = h.funcCommand.get(d.callee)
      const resolved = local ? { use: local, paths: hPaths } : ctxHead.funcUse(dir, d.callee)
      const name = resolved ? resolved.paths.get(resolved.use) : `${pathOf(hPaths, h, file.path, null)} (${d.callee})`
      findings.push(makeFinding({
        ...common, name, change_kind: 'deprecated', line: d.line, evidence: excerpt(file, 'head', d.line, d.line), detail: 'deprecate-cmd',
        summary: `\`${name}\` is now wrapped in \`cobraext.DeprecateCmd\` in \`${file.path}\`, which hides it from rpk help and the generated reference and marks it deprecated${d.message ? ` (use ${d.message} instead)` : ''}. Pages that run it now recommend a deprecated command.`
      }))
    }

    // Flags, per command.
    const visible = (parsed, fl) => !parsed.hidden.has(fl.name) && !fl.hidden
    // A command present on both sides is compared under its head path, so
    // a renamed parent directory command (recovery to restore) does not
    // turn every flag below it into a removal plus an addition.
    const bFlags = new Map([...b.flags.values()].map((fl) => [`${fl.command && h.commands.has(fl.command) ? pathOf(hPaths, h, file.path, fl.command) : pathOf(bPaths, b, file.oldPath, fl.command)} --${fl.name}`, fl]))
    const hFlags = new Map([...h.flags.values()].map((fl) => [`${pathOf(hPaths, h, file.path, fl.command)} --${fl.name}`, fl]))
    // A renamed command carries its flags: compare them under the new path.
    for (const [toUse, fromUse] of renamedTo) {
      const fromPath = bPaths.get(fromUse)
      const toPath = hPaths.get(toUse)
      for (const [k, fl] of [...bFlags]) {
        if (!k.startsWith(`${fromPath} --`)) continue
        bFlags.delete(k)
        bFlags.set(`${toPath} --${fl.name}`, fl)
      }
    }
    const removedFlags = [...bFlags.keys()].filter((k) => !hFlags.has(k) && visible(b, bFlags.get(k)))
    const addedFlags = [...hFlags.keys()].filter((k) => !bFlags.has(k) && visible(h, hFlags.get(k)))
    const paired = new Set()
    const cmdOfKey = (k) => k.slice(0, k.lastIndexOf(' --'))
    for (const oldKey of removedFlags) {
      const old = bFlags.get(oldKey)
      const command = cmdOfKey(oldKey)
      const match = old.target ? addedFlags.find((k) => cmdOfKey(k) === command && hFlags.get(k).target === old.target && !paired.has(k)) : null
      if (match) {
        paired.add(match)
        const nf = hFlags.get(match)
        findings.push(makeFinding({
          ...common,
          name: match,
          change_kind: 'renamed',
          line: nf.line,
          evidence: excerpt(file, 'head', nf.line, nf.lineEnd),
          summary: `Flag \`--${old.name}\` of \`${command}\` was renamed to \`--${nf.name}\` in \`${file.path}\` (same target \`${old.target}\`). Every page that passes the old flag states one rpk no longer accepts.`
        }))
        continue
      }
      findings.push({
        ...makeFinding({
          ...common,
          name: oldKey,
          change_kind: 'removed',
          line: old.line,
          evidence: excerpt(file, 'base', old.line, old.lineEnd),
          summary: `Flag \`--${old.name}\` of \`${command}\` was removed in \`${file.path}\`. Every page that passes it states a flag rpk no longer accepts.`
        }),
        moveValue: old.defaultText == null ? null : { text: old.defaultText, same: sameDefault }
      })
    }
    for (const key of addedFlags) {
      if (paired.has(key)) continue
      const nf = hFlags.get(key)
      const command = cmdOfKey(key)
      const isDeprecated = h.deprecated.has(nf.name) || nf.deprecated
      findings.push({
        ...makeFinding({
          ...common,
          name: key,
          change_kind: isDeprecated ? 'deprecated' : 'added',
          line: nf.line,
          evidence: excerpt(file, 'head', nf.line, nf.lineEnd),
          summary: `New flag \`--${nf.name}\` on \`${command}\`${nf.defaultText != null ? ` (default \`${nf.defaultText}\`)` : ''} in \`${file.path}\`${nf.via ? ` (installed by \`${nf.via}\`)` : ''}. The rpk reference lists it on regeneration; any guide for this command that should use the flag needs the step.`
        }),
        moveValue: nf.defaultText == null ? null : { text: nf.defaultText, same: sameDefault }
      })
    }
    for (const [key, nf] of hFlags) {
      const of = bFlags.get(key)
      if (!of) continue
      const command = cmdOfKey(key)
      if ((h.deprecated.has(nf.name) || nf.deprecated) && !(b.deprecated.has(of.name) || of.deprecated)) {
        findings.push(makeFinding({
          ...common, name: key, change_kind: 'deprecated', line: nf.line, evidence: excerpt(file, 'head', nf.line, nf.lineEnd),
          summary: `Flag \`--${nf.name}\` of \`${command}\` is now marked deprecated in \`${file.path}\`. Pages that pass it now recommend a deprecated flag.`
        }))
        continue
      }
      if (!visible(h, nf) && visible(b, of)) {
        findings.push(makeFinding({
          ...common, name: key, change_kind: 'removed', line: nf.line, evidence: excerpt(file, 'head', nf.line, nf.lineEnd), detail: 'hidden',
          summary: `Flag \`--${nf.name}\` of \`${command}\` is now hidden in \`${file.path}\`, so it leaves rpk help and the generated reference.`
        }))
        continue
      }
      if (of.defaultText !== null && nf.defaultText !== null && !sameDefault(of.defaultText, nf.defaultText) && visible(h, nf)) {
        findings.push(makeFinding({
          ...common, name: key, change_kind: 'default-changed', line: nf.line, evidence: excerpt(file, 'head', nf.line, nf.lineEnd),
          summary: `The default of \`--${nf.name}\` on \`${command}\` changed from \`${of.defaultText}\` to \`${nf.defaultText}\` in \`${file.path}\`. The rpk reference regenerates the default; any page that quotes the old default states the wrong value.`
        }))
      }
    }
  }
  return findings
}

module.exports = { id: 'rpk', surface: 'rpk', routes: ROUTES, detect, parseGo, commandPath, commandPaths, packageContext, sameDefault }
