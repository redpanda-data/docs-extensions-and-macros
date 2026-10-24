'use strict'

const path = require('path')
const { stripComments, skipString, lineAt, normalize } = require('../source')
const { sameValue } = require('../values')
const { makeFinding, PAGES } = require('../finding')
const { parseInitializers } = require('./properties')
const { parseGo, commandPath, commandPaths } = require('./rpk')

/**
 * Defaults held in a named constant.
 *
 * A property initializer that passes `default_rpc_conns`, or an rpk flag
 * that passes `defaultPartitions`, changes its default when the constant
 * changes, and neither the properties nor the rpk detector sees it: the
 * initializer and the flag registration are untouched. This detector reads
 * every constant or variable definition whose value the diff changed and
 * looks for the defaults that use it, within a fixed scope:
 *
 *   C++  a `const`, `constexpr`, `inline constexpr` or `static const(expr)`
 *        definition (`= v`, `{v}`) in a changed file under src/v, used as
 *        the default of a property initialized in a src/v/config/*.cc file
 *        that is that same file or `#include`s it directly.
 *   Go   a package-level `const` or `var` (single or in a block) in a
 *        changed non-test file under src/go/rpk/pkg/cli, used as the
 *        default of a flag registered in a non-test .go file of the same
 *        directory and package.
 *
 * Not followed: headers included transitively, constants built from other
 * constants (`a = b * 2` where only `b` changed), `#define` macros, Go
 * identifiers from another package (`config.DefaultX`), `iota`, and names
 * defined more than once on one side of a file (which definition a use
 * binds to is not decided by text). Old and new values are compared with
 * values.js, so `128_MiB` to `134217728` is no change. Without a checkout
 * the users of a changed constant cannot be listed, and a note says so.
 */

const CPP_ROUTES = [/^src\/v\/(?!(?:.*\/)?tests?\/)(?:.*\/)?[^/]+\.(?:h|hh|cc)$/]
const GO_ROUTES = [/^src\/go\/rpk\/pkg\/cli\/(?:.*\/)?(?!.*_test\.go$)[^/]+\.go$/]
const ROUTES = [...CPP_ROUTES, ...GO_ROUTES]

const CONFIG_DIR = 'src/v/config'
const CPP_INCLUDE_ROOT = 'src/v/'

const CPP_DEF_START = /(^|[\n;{}])[ \t]*((?:(?:inline|static|constexpr|constinit|const)\s+)+)/g
const CPP_DEF = /^([A-Za-z_][\w:<>,\s*&]*?)\s*\b([A-Za-z_]\w*)\s*(?:=\s*([\s\S]+)|\{([\s\S]*)\})$/

/**
 * C++ constant definitions: name -> { value, line }, with names defined more
 * than once collected in `ambiguous`.
 */
function parseCppConstants (snippets) {
  const defs = new Map()
  const ambiguous = new Set()
  for (const { startLine, text: raw } of snippets) {
    const text = stripComments(raw)
    CPP_DEF_START.lastIndex = 0
    let m
    while ((m = CPP_DEF_START.exec(text)) !== null) {
      const qualifiers = m[2]
      if (!/\b(?:const|constexpr)\b/.test(qualifiers)) continue
      const start = m.index + m[1].length
      const bodyStart = m.index + m[0].length
      const end = statementEnd(text, bodyStart)
      if (end === -1) continue
      const statement = normalize(text.slice(bodyStart, end))
      const d = CPP_DEF.exec(statement)
      if (!d || /[()]/.test(d[1]) || !d[1].trim()) continue
      const value = normalize(d[3] !== undefined ? d[3] : d[4])
      if (!value) continue
      const name = d[2]
      const line = lineAt(text, start, startLine)
      if (defs.has(name)) ambiguous.add(name)
      else defs.set(name, { name, value, line })
    }
  }
  return { defs, ambiguous }
}

// End of a declaration statement: the next top-level `;`, skipping strings
// and brackets. -1 if a `{` opens a body first (a function or a class).
function statementEnd (text, from) {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === '\'') { i = skipString(text, i); continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth < 0) return -1
    } else if (c === ';' && depth === 0) return i
  }
  return -1
}

const GO_DECL = /(^|\n)(const|var)[ \t]+(\(|[A-Za-z_]\w*)/g

/** Package-level Go const and var definitions with an explicit value. */
function parseGoConstants (snippets) {
  const defs = new Map()
  const ambiguous = new Set()
  const add = (name, value, line) => {
    if (name === '_' || !value || /\biota\b/.test(value)) return
    if (defs.has(name)) ambiguous.add(name)
    else defs.set(name, { name, value: normalize(value), line })
  }
  // `name [type] = value`, one spec per line.
  const SPEC = /^([A-Za-z_]\w*)(?:\s+[^=]+?)?\s*=\s*(.+)$/
  for (const { startLine, text: raw } of snippets) {
    const text = stripComments(raw)
    GO_DECL.lastIndex = 0
    let m
    while ((m = GO_DECL.exec(text)) !== null) {
      const declStart = m.index + m[1].length
      if (m[3] === '(') {
        const open = m.index + m[0].length - 1
        const close = text.indexOf('\n)', open)
        if (close === -1) continue
        const body = text.slice(open + 1, close)
        let offset = open + 1
        for (const lineText of body.split('\n')) {
          const spec = SPEC.exec(lineText.trim())
          if (spec) add(spec[1], spec[2], lineAt(text, offset, startLine))
          offset += lineText.length + 1
        }
      } else {
        const eol = text.indexOf('\n', declStart)
        const lineText = text.slice(declStart, eol === -1 ? text.length : eol).replace(/^(?:const|var)\s+/, '')
        const spec = SPEC.exec(lineText.trim())
        if (spec) add(spec[1], spec[2], lineAt(text, declStart, startLine))
      }
    }
  }
  return { defs, ambiguous }
}

/** Definitions on both sides whose value changed. */
function changedConstants (base, head, lang) {
  const out = []
  for (const [name, h] of head.defs) {
    const b = base.defs.get(name)
    if (!b || base.ambiguous.has(name) || head.ambiguous.has(name)) continue
    if (sameValue(b.value, h.value, lang)) continue
    out.push({ name, before: b.value, after: h.value, line: h.line })
  }
  return out
}

const usesIdentifier = (expr, name) => expr != null && new RegExp(`(?<![A-Za-z0-9_])(?:[A-Za-z_]\\w*::)*${name}(?![A-Za-z0-9_])`).test(expr)
const usesGoIdentifier = (expr, name) => expr != null && new RegExp(`(?<![A-Za-z0-9_.])${name}(?![A-Za-z0-9_])`).test(expr)

function includes (sourcePath, sourceText, headerPath) {
  const re = /^[ \t]*#[ \t]*include[ \t]*["<]([^">]+)[">]/gm
  let m
  while ((m = re.exec(sourceText)) !== null) {
    const inc = m[1]
    if (CPP_INCLUDE_ROOT + inc === headerPath) return true
    if (path.posix.join(path.posix.dirname(sourcePath), inc) === headerPath) return true
  }
  return false
}

function detect ({ files, sides, excerpt, note, readHead, listHead }) {
  const findings = []
  const inDiff = new Map(files.map((f) => [f.path, f]))
  const headText = (p) => {
    if (readHead) {
      const t = readHead(p)
      if (t !== null && t !== undefined) return t
    }
    const f = inDiff.get(p)
    if (!f) return null
    const s = sides(f)
    return s.partial ? null : s.head.map((x) => x.text).join('\n')
  }
  const list = (dir) => {
    if (listHead) {
      const listed = listHead(dir)
      if (listed) return listed
    }
    return null
  }

  for (const file of files) {
    if (file.isNew || file.isDeleted) continue
    const isGo = GO_ROUTES.some((re) => re.test(file.path))
    const lang = isGo ? 'go' : 'cpp'
    const { base, head } = sides(file)
    const parse = isGo ? parseGoConstants : parseCppConstants
    const changed = changedConstants(parse(base), parse(head), lang)
    if (changed.length === 0) continue

    const dir = isGo ? path.posix.dirname(file.path) : CONFIG_DIR
    const listed = list(dir)
    let candidates
    if (listed) {
      candidates = listed.filter((p) => path.posix.dirname(p) === dir && (isGo ? /\.go$/.test(p) && !/_test\.go$/.test(p) : /\.cc$/.test(p)))
    } else {
      candidates = [...inDiff.keys()].filter((p) => path.posix.dirname(p) === dir && (isGo ? /\.go$/.test(p) && !/_test\.go$/.test(p) : /\.cc$/.test(p)))
      note(`${file.path}: ${changed.map((c) => c.name).join(', ')} changed value; without a checkout only the files in the diff were searched for defaults that use ${changed.length === 1 ? 'it' : 'them'}; run with --repo`, { file: file.path, line: changed[0].line })
    }
    if (!candidates.includes(file.path) && (isGo || file.path.endsWith('.cc')) && path.posix.dirname(file.path) === dir) candidates.push(file.path)

    const pkgOf = (text) => { const m = /^\s*package\s+(\w+)/m.exec(stripComments(text)); return m ? m[1] : null }
    const ownText = isGo ? headText(file.path) : null
    const ownPkg = ownText ? pkgOf(ownText) : null

    for (const candidate of candidates.sort()) {
      const text = headText(candidate)
      if (text === null) continue
      if (isGo) {
        if (ownPkg && pkgOf(text) !== ownPkg) continue
        const parsed = parseGo([{ startLine: 1, text }])
        const use = parsed.commands.size === 1 ? [...parsed.commands.keys()][0] : null
        const paths = commandPaths(candidate, parsed)
        for (const f of parsed.flags.values()) {
          const flag = f.name
          const command = (f.command && paths.get(f.command)) || commandPath(candidate, use)
          if (parsed.hidden.has(flag)) continue
          for (const c of changed) {
            if (!usesGoIdentifier(f.defaultText, c.name)) continue
            findings.push(makeFinding({
              detector: 'constants',
              surface: 'rpk',
              file: file.path,
              page: PAGES.rpk,
              name: `${command} --${flag}`,
              change_kind: 'default-changed',
              line: c.line,
              evidence: excerpt(file, 'head', c.line, c.line),
              detail: 'via-constant',
              summary: `The default of \`--${flag}\` on \`${command}\` changed from \`${c.before}\` to \`${c.after}\`: the flag (\`${candidate}:${f.line}\`) passes \`${c.name}\`, whose value changed in \`${file.path}\`. The rpk reference regenerates the default; any page that quotes the old default states the wrong value.`
            }))
          }
        }
        continue
      }
      if (candidate !== file.path && !includes(candidate, text, file.path)) continue
      const { decls } = parseInitializers([{ startLine: 1, text }])
      for (const d of [...decls.values()].sort((a, b) => a.line - b.line)) {
        for (const c of changed) {
          if (!usesIdentifier(d.defaultText, c.name)) continue
          findings.push(makeFinding({
            detector: 'constants',
            surface: 'properties',
            file: file.path,
            page: /node_config/.test(path.posix.basename(candidate)) ? PAGES.brokerProperties : PAGES.clusterProperties,
            name: d.name,
            change_kind: 'default-changed',
            line: c.line,
            evidence: excerpt(file, 'head', c.line, c.line),
            detail: 'via-constant',
            summary: `The default of \`${d.name}\` changed from \`${c.before}\` to \`${c.after}\`: its initializer (\`${candidate}:${d.line}\`) passes \`${c.name}\`, whose value changed in \`${file.path}\`. The property reference regenerates its Default row, but any page that quotes the old default in prose, or sizes guidance on it, now states the wrong value.`
          }))
        }
      }
    }
  }
  return findings
}

module.exports = { id: 'constants', surface: 'properties', routes: ROUTES, detect, parseCppConstants, parseGoConstants }
