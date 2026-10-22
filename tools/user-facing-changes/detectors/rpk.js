'use strict'

const { stripComments, matchBracket, splitArgs, literalValue, lineAt, normalize } = require('../source')
const { makeFinding, PAGES } = require('../finding')

/**
 * rpk commands and flags (src/go/rpk/pkg/cli/**, non-test Go).
 *
 * The lint reviews Short, Long and flag usage strings. This detector reads
 * what those strings describe: the cobra.Command literal's Use (the command
 * name), its Hidden and Deprecated fields, and every pflag registration
 * (`cmd.Flags().BoolVarP(&dry, "dry", "d", false, "...")`, or through a
 * flag set bound to a variable first), with the flag's name, default and
 * target variable. MarkHidden and MarkDeprecated calls are read too. Both
 * sides of each changed file are parsed and compared per flag name and per
 * command name. rpk keeps one command per file, so a file whose single Use
 * changed is a renamed command, and a removed flag whose target variable
 * reappears under a new name is a renamed flag.
 */

const ROUTES = [/^src\/go\/rpk\/pkg\/cli\/(?:.*\/)?(?!.*_test\.go$)[^/]+\.go$/]

const FLAG_METHOD = /^(String|Bool|Int|Uint|Float|Duration|Count|Bytes|IP)[A-Za-z0-9]*$/
const COMMAND_LITERAL = /\bcobra\.Command\{/g
const MARK = /\.\s*Mark(Hidden|Deprecated)\s*\(\s*"([^"]+)"/g

function parseGo (snippets) {
  const commands = new Map()
  const flags = new Map()
  const hidden = new Set()
  const deprecated = new Set()
  const unresolved = []
  for (const { startLine, text: raw } of snippets) {
    const text = stripComments(raw)
    // Commands.
    COMMAND_LITERAL.lastIndex = 0
    let m
    while ((m = COMMAND_LITERAL.exec(text)) !== null) {
      const open = m.index + m[0].length - 1
      const close = matchBracket(text, open)
      const line = lineAt(text, m.index, startLine)
      if (close === -1) { unresolved.push({ line, what: 'cobra.Command literal' }); continue }
      const fields = splitArgs(text.slice(open + 1, close))
      const cmd = { line, lineEnd: lineAt(text, close, startLine), use: null, hidden: false, deprecated: null }
      for (const field of fields) {
        const fm = /^(Use|Hidden|Deprecated)\s*:\s*([\s\S]+)$/.exec(field.trim())
        if (!fm) continue
        if (fm[1] === 'Use') {
          const v = literalValue(fm[2]) ?? rawGoString(fm[2])
          if (v) cmd.use = v.trim().split(/\s+/)[0]
        } else if (fm[1] === 'Hidden') cmd.hidden = /^true$/.test(fm[2].trim())
        else if (fm[1] === 'Deprecated') cmd.deprecated = literalValue(fm[2]) ?? rawGoString(fm[2]) ?? fm[2].trim()
      }
      if (cmd.use) commands.set(cmd.use, cmd)
    }
    // Flag registrations, direct and through a bound flag set.
    const flagsetVars = new Set()
    const assign = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*[\w.]+\.(?:Flags|PersistentFlags)\s*\(\s*\)/g
    while ((m = assign.exec(text)) !== null) flagsetVars.add(m[1])
    const patterns = [/\.\s*(?:Flags|PersistentFlags)\s*\(\s*\)\s*\.\s*([A-Za-z0-9]+)\s*\(/g]
    if (flagsetVars.size > 0) {
      patterns.push(new RegExp(`\\b(?:${[...flagsetVars].join('|')})\\s*\\.\\s*([A-Za-z0-9]+)\\s*\\(`, 'g'))
    }
    for (const re of patterns) {
      re.lastIndex = 0
      while ((m = re.exec(text)) !== null) {
        const method = m[1]
        if (!FLAG_METHOD.test(method)) continue
        const open = m.index + m[0].length - 1
        const close = matchBracket(text, open)
        const line = lineAt(text, m.index, startLine)
        if (close === -1) { unresolved.push({ line, what: `${method} flag registration` }); continue }
        const args = splitArgs(text.slice(open + 1, close))
        const isVar = /Var/.test(method)
        const hasShort = /P$/.test(method)
        const nameIdx = isVar ? 1 : 0
        const name = literalValue(args[nameIdx])
        if (!name) continue
        let defaultIdx = nameIdx + 1 + (hasShort ? 1 : 0)
        const noDefault = /^Count/.test(method)
        const defaultText = noDefault || defaultIdx >= args.length - 1 ? null : normalize(args[defaultIdx])
        flags.set(name, {
          name,
          line,
          lineEnd: lineAt(text, close, startLine),
          method,
          defaultText,
          target: isVar ? normalize(args[0]) : null
        })
      }
    }
    MARK.lastIndex = 0
    while ((m = MARK.exec(text)) !== null) (m[1] === 'Hidden' ? hidden : deprecated).add(m[2])
  }
  // Source order, whichever registration pattern found a flag first.
  const ordered = new Map([...flags.entries()].sort((a, b) => a[1].line - b[1].line))
  return { commands, flags: ordered, hidden, deprecated, unresolved }
}

function rawGoString (s) {
  const t = String(s || '').trim()
  const m = /^`([\s\S]*)`$/.exec(t)
  return m ? m[1] : null
}

/**
 * The command a file implements, from its path: rpk mirrors the command
 * tree in directories (cli/shadow/create.go is `rpk shadow create`). The
 * Use token from the file's own cobra.Command wins over the basename.
 */
function commandPath (file, use) {
  const rel = file.replace(/^src\/go\/rpk\/pkg\/cli\//, '').replace(/\.go$/, '')
  const parts = rel.split('/')
  const base = parts.pop()
  const dirs = parts
  const leaf = use || base
  if (dirs.length > 0 && dirs[dirs.length - 1] === leaf) dirs.pop()
  if (leaf === 'root' || leaf === 'rpk') return 'rpk'
  return ['rpk', ...dirs, leaf].join(' ')
}

function detect ({ files, sides, excerpt, note }) {
  const findings = []
  for (const file of files) {
    const { base, head, partial } = sides(file)
    const b = parseGo(base)
    const h = parseGo(head)
    if (partial) {
      for (const u of [...b.unresolved, ...h.unresolved]) {
        note(`${file.path}:${u.line}: ${u.what} is cut by the hunk; run with --repo to read the whole file`, { file: file.path, line: u.line })
      }
    }
    const commandUse = h.commands.size === 1 ? [...h.commands.keys()][0] : (b.commands.size === 1 ? [...b.commands.keys()][0] : null)
    const command = commandPath(file.path, commandUse)
    const common = { detector: 'rpk', surface: 'rpk', file: file.path, page: PAGES.rpk }

    // Commands.
    const removedCmds = [...b.commands.keys()].filter((u) => !h.commands.has(u) && !b.commands.get(u).hidden)
    const addedCmds = [...h.commands.keys()].filter((u) => !b.commands.has(u) && !h.commands.get(u).hidden)
    if (removedCmds.length === 1 && addedCmds.length === 1) {
      const from = b.commands.get(removedCmds[0])
      const to = h.commands.get(addedCmds[0])
      findings.push(makeFinding({
        ...common,
        name: commandPath(file.path, to.use),
        change_kind: 'renamed',
        line: to.line,
        evidence: excerpt(file, 'head', to.line, to.lineEnd),
        summary: `The command in \`${file.path}\` changed its Use from \`${from.use}\` to \`${to.use}\` (likely \`${commandPath(file.path, from.use)}\` to \`${commandPath(file.path, to.use)}\`). The rpk reference regenerates the page under the new name; every page that runs the old command states a command that no longer exists.`
      }))
    } else {
      for (const use of removedCmds) {
        const c = b.commands.get(use)
        findings.push(makeFinding({
          ...common,
          name: commandPath(file.path, use),
          change_kind: 'removed',
          line: c.line,
          evidence: excerpt(file, 'base', c.line, c.lineEnd),
          summary: `The command \`${commandPath(file.path, use)}\` (Use \`${use}\` in \`${file.path}\`) was removed. Every page that runs it states a command that no longer exists.`
        }))
      }
      for (const use of addedCmds) {
        const c = h.commands.get(use)
        findings.push(makeFinding({
          ...common,
          name: commandPath(file.path, use),
          change_kind: c.deprecated ? 'deprecated' : 'added',
          line: c.line,
          evidence: excerpt(file, 'head', c.line, c.lineEnd),
          summary: `New command \`${commandPath(file.path, use)}\` (Use \`${use}\` in \`${file.path}\`). The rpk reference generates its page on regeneration; any task or guide that should use it needs writing.`
        }))
      }
    }
    for (const [use, c] of h.commands) {
      const prev = b.commands.get(use)
      if (!prev) continue
      if (c.deprecated && !prev.deprecated) {
        findings.push(makeFinding({
          ...common,
          name: commandPath(file.path, use),
          change_kind: 'deprecated',
          line: c.line,
          evidence: excerpt(file, 'head', c.line, c.lineEnd),
          summary: `\`${commandPath(file.path, use)}\` is now deprecated in \`${file.path}\`: ${c.deprecated}. Pages that recommend it now recommend a deprecated command.`
        }))
      } else if (c.hidden && !prev.hidden) {
        findings.push(makeFinding({
          ...common,
          name: commandPath(file.path, use),
          change_kind: 'removed',
          line: c.line,
          evidence: excerpt(file, 'head', c.line, c.lineEnd),
          detail: 'hidden',
          summary: `\`${commandPath(file.path, use)}\` is now Hidden in \`${file.path}\`, so it leaves rpk help and the generated reference. Every page that runs it needs another route.`
        }))
      }
    }

    // Flags.
    const visible = (parsed, name) => !parsed.hidden.has(name)
    const removedFlags = [...b.flags.keys()].filter((n) => !h.flags.has(n) && visible(b, n))
    const addedFlags = [...h.flags.keys()].filter((n) => !b.flags.has(n) && visible(h, n))
    const paired = new Set()
    for (const oldName of removedFlags) {
      const old = b.flags.get(oldName)
      const match = old.target ? addedFlags.find((n) => h.flags.get(n).target === old.target && !paired.has(n)) : null
      if (match) {
        paired.add(match)
        const nf = h.flags.get(match)
        findings.push(makeFinding({
          ...common,
          name: `${command} --${match}`,
          change_kind: 'renamed',
          line: nf.line,
          evidence: excerpt(file, 'head', nf.line, nf.lineEnd),
          summary: `Flag \`--${oldName}\` of \`${command}\` was renamed to \`--${match}\` in \`${file.path}\` (same target \`${old.target}\`). Every page that passes the old flag states one rpk no longer accepts.`
        }))
        continue
      }
      findings.push(makeFinding({
        ...common,
        name: `${command} --${oldName}`,
        change_kind: 'removed',
        line: old.line,
        evidence: excerpt(file, 'base', old.line, old.lineEnd),
        summary: `Flag \`--${oldName}\` of \`${command}\` was removed in \`${file.path}\`. Every page that passes it states a flag rpk no longer accepts.`
      }))
    }
    for (const name of addedFlags) {
      if (paired.has(name)) continue
      const nf = h.flags.get(name)
      findings.push(makeFinding({
        ...common,
        name: `${command} --${name}`,
        change_kind: h.deprecated.has(name) ? 'deprecated' : 'added',
        line: nf.line,
        evidence: excerpt(file, 'head', nf.line, nf.lineEnd),
        summary: `New flag \`--${name}\` on \`${command}\`${nf.defaultText != null ? ` (default \`${nf.defaultText}\`)` : ''} in \`${file.path}\`. The rpk reference lists it on regeneration; any guide for this command that should use the flag needs the step.`
      }))
    }
    for (const [name, nf] of h.flags) {
      const of = b.flags.get(name)
      if (!of) continue
      if (h.deprecated.has(name) && !b.deprecated.has(name)) {
        findings.push(makeFinding({
          ...common,
          name: `${command} --${name}`,
          change_kind: 'deprecated',
          line: nf.line,
          evidence: excerpt(file, 'head', nf.line, nf.lineEnd),
          summary: `Flag \`--${name}\` of \`${command}\` is now marked deprecated in \`${file.path}\`. Pages that pass it now recommend a deprecated flag.`
        }))
        continue
      }
      if (h.hidden.has(name) && !b.hidden.has(name)) {
        findings.push(makeFinding({
          ...common,
          name: `${command} --${name}`,
          change_kind: 'removed',
          line: nf.line,
          evidence: excerpt(file, 'head', nf.line, nf.lineEnd),
          detail: 'hidden',
          summary: `Flag \`--${name}\` of \`${command}\` is now hidden in \`${file.path}\`, so it leaves rpk help and the generated reference.`
        }))
        continue
      }
      if (of.defaultText !== null && nf.defaultText !== null && of.defaultText !== nf.defaultText && visible(h, name)) {
        findings.push(makeFinding({
          ...common,
          name: `${command} --${name}`,
          change_kind: 'default-changed',
          line: nf.line,
          evidence: excerpt(file, 'head', nf.line, nf.lineEnd),
          summary: `The default of \`--${name}\` on \`${command}\` changed from \`${of.defaultText}\` to \`${nf.defaultText}\` in \`${file.path}\`. The rpk reference regenerates the default; any page that quotes the old default states the wrong value.`
        }))
      }
    }
  }
  return findings
}

module.exports = { id: 'rpk', surface: 'rpk', routes: ROUTES, detect, parseGo, commandPath }
