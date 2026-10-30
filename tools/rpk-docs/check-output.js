#!/usr/bin/env node
'use strict'

/**
 * Deterministic output check for the rpk-docs generator.
 *
 * Every command and flag description goes through formatDescription, which
 * adds code spans and rewrites some text. Two invariants must hold for each
 * one, whatever the help text looks like:
 *
 * 1. text-preserved: the rendered output says the same words, in the same
 *    order, as the source. Only the changes the generator is built to make
 *    are normalized away (applySourceRewrites and normalizeWords name each
 *    one). No internal placeholder (__INLINE_CODE_n__ and friends) survives.
 * 2. whole-token-spans: every inline code span covers a whole token. Before
 *    a span: the start, whitespace, or an opening bracket or quote. After it:
 *    the end, whitespace, or punctuation that is not followed by more of the
 *    same token (`--a`.b and `topic`:`oncall` fail).
 *
 * Both run on the HTML Asciidoctor produces, because that is what readers
 * see: a span can look fine in the AsciiDoc and still render broken.
 *
 * Library: checkDescription(sourceText, generatedAdoc, options)
 *          checkTree(tree, overrides)
 * CLI:     node tools/rpk-docs/check-output.js --snapshot <rpk-vX.json> [--overrides <rpk-overrides.json>]
 *
 * Intentional exceptions live in the overrides file as outputCheckExceptions:
 * [{ "command": "rpk x", "flag": "--y", "invariant": "...", "reason": "..." }].
 * An exception that no longer matches anything is reported, so the list
 * cannot go stale.
 */

const fs = require('fs')
const path = require('path')
const {
  formatDescription,
  ensurePeriod,
  parseDescriptionSections,
  mergeCommandOverrides,
  resolveReferences,
  flattenCommands,
  shouldExcludeCommand,
  registerKnownCommandPaths,
  decodeHtmlEntities
} = require('./generate-rpk-docs')

// The placeholder names formatDescription uses while it protects spans.
const PLACEHOLDER = /__(?:EARLY_CODE_BLOCK|CODE_BLOCK|INLINE_CODE|XREF)_\d+__/

// Markers for inline code in the extracted text. Control characters never
// occur in help text, so they cannot collide with real content.
const CODE_OPEN = '\u0001'
const CODE_CLOSE = '\u0002'

const OPENERS = new Set(['(', '[', '{', '<', "'", '"', '\u2018', '\u201c'])
const CLOSERS = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', "'", '"', '\u2019', '\u201d'])
// A separator between two spans joins whole values (`json`,`yaml` from the
// override list rules, `--wait`/`-w`), so it is not a span cut mid-token.
const SEPARATORS = new Set([',', '/', '|'])

let asciidoctor = null
function render(adoc) {
  if (!asciidoctor) {
    // @asciidoctor/core comes with Antora (a peer dependency), so every repo
    // that renders these pages already has it.
    asciidoctor = require('@asciidoctor/core')()
    asciidoctor.LoggerManager.setLogger(asciidoctor.MemoryLogger.create())
  }
  return asciidoctor.convert(adoc, { safe: 'safe' })
}

/**
 * Render AsciiDoc and return its visible text, with inline code spans
 * wrapped in CODE_OPEN/CODE_CLOSE.
 */
function renderedText(adoc) {
  return render(adoc)
    // Admonition labels ("Note") come from the NOTE: prefix, not the text.
    .replace(/<td class="icon">[\s\S]*?<\/td>/g, ' ')
    // convertIndentedTablesToAsciiDoc adds a "Value | Description" header.
    .replace(/<thead>[\s\S]*?<\/thead>/g, ' ')
    .replace(/<code>/g, CODE_OPEN)
    .replace(/<\/code>/g, CODE_CLOSE)
    // Block boundaries separate words; inline tags (strong, em, a) do not.
    .replace(/<\/?(?:p|div|li|ul|ol|dl|dt|dd|table|tbody|tr|td|th|pre|br|h\d|colgroup|col|blockquote)\b[^>]*>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#8201;/g, ' ')
    .replace(/&#8203;/g, '')
    .split(/(&[#a-z0-9]+;)/i).map(part => decodeHtmlEntities(part)).join('')
}

/**
 * Word-level rewrites the generator makes on purpose, applied to the source
 * so that the comparison flags only what it was not built to do.
 */
function applySourceRewrites(text, textTransformations) {
  // Override replacement rules (textTransformations.replacements), applied
  // by formatDescription in STEP 1 and STEP 3. Rules can rewrite words
  // (rpai -> rpk ai, Note: -> NOTE:, [X] -> <X>), so the expected text has
  // them applied. Indented lines become code blocks, which only applyToCode
  // rules touch, the same split applyTextTransformationsToExamples makes.
  const rules = textTransformations?.replacements || []
  const applyRules = (line, codeOnly) => rules.reduce((out, rule) => {
    if (codeOnly && !rule.applyToCode) return out
    try {
      return out.replace(new RegExp(rule.pattern, rule.flags || 'g'), rule.replacement)
    } catch {
      return out // formatDescription warns about and skips invalid patterns
    }
  }, line)
  const codeLines = []
  const masked = text.replace(/^[ ]{2,}\S.*$/gm, line => `\u0003${codeLines.push(line) - 1}\u0003`)
  const out = applyRules(masked, false).replace(/\u0003(\d+)\u0003/g, (_, n) => applyRules(codeLines[n], true))

  return decodeHtmlEntities(out)
    // convertIndentedCodeBlocksToAsciiDoc drops the "$ " shell prompt.
    .replace(/^[ \t]*\$[ \t]+/gm, '')
    // formatDescription "STYLE GUIDE COMPLIANCE" and "TYPO CORRECTIONS",
    // in the order it applies them.
    .replace(/[,;]?\s*\be\.g\.[\s,]*$/i, '')
    .replace(/,?[^\S\n]*\be\.g\.:[^\S\n]*/gi, ', for example: ')
    .replace(/\be\.g\.[^\S\n]*/gi, 'for example, ')
    .replace(/\bi\.e\.[^\S\n]*/gi, 'that is, ')
    .replace(/\ban\s+(prod|dev|test|local|remote|new|cluster|config|file)\b/gi, 'a $1')
}

/**
 * Normalize text to a comparable word sequence. Each rule is a change the
 * generator or Asciidoctor makes by design.
 */
function normalizeWords(text) {
  return text
    // Asciidoctor's typographic replacements, mapped back to their source.
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2014/g, '--')
    .replace(/\u2026/g, '...')
    .replace(/\u2192/g, '->').replace(/\u21d2/g, '=>')
    .replace(/\u2190/g, '<-').replace(/\u21d0/g, '<=')
    .replace(/\u00a9/g, '(C)').replace(/\u00ae/g, '(R)').replace(/\u2122/g, '(TM)')
    // List markers, which render as list items: convertMarkdownLists
    // (- item -> * item), convertNumberedListsToAsciiDoc (1. item -> . item),
    // convertBulletedDefinitionListsToAsciiDoc, and override rule "1) -> . ".
    .replace(/^[ \t]*(?:[-*\u2022]|\d+[.)]|\.)[ \t]+/gm, '')
    // Admonition labels (override rules turn Note: into NOTE:, which renders
    // as an icon cell that renderedText drops).
    .replace(/(^|\n)[ \t]*(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION):[ \t]+/g, '$1')
    // convertIndentedCodeBlocksToAsciiDoc joins an indented command and its
    // indented flag lines with " \" continuations, adding any the help text
    // left out. Only a continuation before a flag is dropped: one before
    // anything else joins two separate commands, which is a bug.
    .replace(/[ \t]\\(?=\s+-)/g, '')
    // Code span delimiters and the quotes the generator turns into spans
    // (formatDescription strips '--flag' quotes; override rules turn 'cmd',
    // "cmd" and "`x`" into spans).
    .replace(/[`'"\u0001\u0002]/g, '')
    // Bold that override rules make from "# Word:" headers.
    .replace(/\*\*/g, '')
    // formatDescription removes a stray space before a closing parenthesis.
    .replace(/\s+\)/g, ')')
    // ensurePeriod adds a closing period; formatDescription drops one after a
    // span alone on its line; convertIndentedTablesToAsciiDoc drops the colon
    // after a table's value column.
    .replace(/[.:](?=\s|$)/g, '')
    // Case: formatDescription capitalizes "redpanda" (the product) and
    // "Redpanda Cloud"; admonition labels change case.
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

function sourceWords(sourceText, options) {
  const rewritten = applySourceRewrites(sourceText, options.textTransformations)
  // Override text is AsciiDoc its author wrote (xrefs, bold, lists), so it
  // is rendered the same way as the output. Raw help is plain text: it is
  // compared as written, so markup it accidentally triggers is caught.
  return normalizeWords(options.sourceIsAsciiDoc ? renderedText(rewritten) : rewritten)
}

function firstDifference(a, b) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const from = Math.max(0, i - 4)
  return { index: i, expected: a.slice(from, i + 4).join(' '), actual: b.slice(from, i + 4).join(' ') }
}

function spanAt(text, index) {
  const open = text.lastIndexOf(CODE_OPEN, index)
  const close = text.indexOf(CODE_CLOSE, open)
  return '`' + text.slice(open + 1, close === -1 ? undefined : close) + '`'
}

/**
 * Check one description.
 * @param {string} sourceText - Effective source: the override's description when the overrides replace it, else the raw help text
 * @param {string} generatedAdoc - What the generator wrote for it
 * @param {Object} [options]
 * @param {Object} [options.textTransformations] - Resolved overrides textTransformations
 * @param {boolean} [options.sourceIsAsciiDoc] - The source is override text (AsciiDoc), not raw help
 * @returns {Array<{invariant: string, reason: string}>} Empty when the output is fine
 */
function checkDescription(sourceText, generatedAdoc, options = {}) {
  const violations = []
  const leak = (generatedAdoc || '').match(PLACEHOLDER)
  if (leak) {
    violations.push({ invariant: 'text-preserved', reason: `internal placeholder ${leak[0]} in the output` })
  }

  const text = renderedText(generatedAdoc || '')

  const expected = sourceWords(sourceText || '', options)
  const actual = normalizeWords(text)
  if (!leak && expected.join(' ') !== actual.join(' ')) {
    const d = firstDifference(expected, actual)
    violations.push({
      invariant: 'text-preserved',
      reason: `text differs at word ${d.index + 1}: expected "${d.expected}", got "${d.actual}"`
    })
  }

  // A span next to a word character is not a constrained span, so
  // Asciidoctor prints its backticks instead of rendering it (name:`web`).
  // That is a mid-token span the HTML has no <code> element for.
  const stray = render(generatedAdoc || '')
    .replace(/<pre\b[\s\S]*?<\/pre>/g, '')
    .replace(/<code>([\s\S]*?)<\/code>/g, (_, code) => code.replace(/`/g, ''))
    .replace(/<[^>]+>/g, '')
    .match(/\S*`\S*/)
  if (stray) {
    violations.push({ invariant: 'whole-token-spans', reason: `unrendered code span: "${decodeHtmlEntities(stray[0])}"` })
  }

  for (let i = 0; i < text.length; i++) {
    if (text[i] === CODE_OPEN) {
      const before = text[i - 1]
      const joined = SEPARATORS.has(before) && text[i - 2] === CODE_CLOSE
      if (before !== undefined && !/\s/.test(before) && !OPENERS.has(before) && !joined) {
        violations.push({ invariant: 'whole-token-spans', reason: `code span ${spanAt(text, i)} starts mid-token after "${before}"` })
      }
    } else if (text[i] === CODE_CLOSE) {
      if (SEPARATORS.has(text[i + 1]) && text[i + 2] === CODE_OPEN) continue
      let j = i + 1
      while (j < text.length && CLOSERS.has(text[j])) j++
      if (j < text.length && !/\s/.test(text[j])) {
        violations.push({ invariant: 'whole-token-spans', reason: `code span ${spanAt(text, i)} ends mid-token before "${text.slice(i + 1, j + 1).replace(/[\u0001\u0002]/g, '`')}"` })
      }
    }
  }
  return violations
}

/**
 * Run every command and flag description in a tree through the same
 * formatDescription calls generateRpkDocs makes, and check each one.
 * @param {Object} tree - Command tree (a snapshot's raw_tree)
 * @param {Object} [overrides] - Parsed rpk-overrides.json
 * @returns {{checked: number, violations: Array, excepted: Array, unusedExceptions: Array}}
 */
function checkTree(tree, overrides) {
  const resolved = overrides ? resolveReferences(overrides, overrides) : null
  const textTransformations = resolved?.textTransformations || null
  const commands = flattenCommands(tree)
  registerKnownCommandPaths(commands.map(c => c.path))

  // formatDescription throws when a placeholder would leak. Report that as
  // a violation like any other instead of stopping the run.
  const format = (text) => {
    try {
      return ensurePeriod(formatDescription(text, textTransformations))
    } catch (err) {
      return `formatDescription threw: ${err.message}`
    }
  }

  const items = []
  const add = (command, flag, source, sourceIsAsciiDoc) =>
    items.push({ command, flag, source, sourceIsAsciiDoc, output: format(source) })

  for (const { path: commandPath, command } of commands) {
    // Same skips as generateRpkDocs: the root page is hand-written, and
    // excluded commands get no page.
    if (commandPath === 'rpk' || shouldExcludeCommand(resolved, commandPath)) continue
    const override = resolved?.commands?.[commandPath] || {}
    const merged = mergeCommandOverrides(command, resolved, commandPath)
    const { mainDescription } = parseDescriptionSections(merged.description || '')
    add(commandPath, undefined, mainDescription, Boolean(override.description || override.appendToDescription))
    for (const flag of merged.flags || []) {
      add(commandPath, `--${flag.name}`, flag.description || '', Boolean(override.flags?.[flag.name]?.description))
    }
  }
  for (const flag of tree.global_flags || []) {
    add('rpk', `--${flag.name}`, flag.description || '', false)
  }

  const exceptions = overrides?.outputCheckExceptions || []
  const used = new Set()
  const violations = []
  const excepted = []
  for (const item of items) {
    const found = checkDescription(item.source, item.output, { textTransformations, sourceIsAsciiDoc: item.sourceIsAsciiDoc })
    for (const v of found) {
      const entry = { command: item.command, flag: item.flag, ...v, source: item.source, output: item.output }
      const idx = exceptions.findIndex(e =>
        e.command === item.command && (e.flag || undefined) === item.flag && (!e.invariant || e.invariant === v.invariant))
      if (idx === -1) {
        violations.push(entry)
      } else {
        used.add(idx)
        excepted.push({ ...entry, exceptionReason: exceptions[idx].reason })
      }
    }
  }
  const unusedExceptions = exceptions.filter((_, i) => !used.has(i))
  return { checked: items.length, violations, excepted, unusedExceptions }
}

/** One line per violation: command path, flag, invariant, reason, source, output. */
function formatViolation(v) {
  const where = v.flag ? `${v.command} ${v.flag}` : v.command
  return `${where} | ${v.invariant} | ${v.reason} | source: ${JSON.stringify(v.source)} | output: ${JSON.stringify(v.output)}`
}

function formatUnusedException(e) {
  const where = e.flag ? `${e.command} ${e.flag}` : e.command
  return `${where} | unused-exception | outputCheckExceptions entry matches no violation, remove it (reason: ${e.reason})`
}

/** All report lines for a checkTree result. */
function reportLines(result) {
  return [
    ...result.violations.map(formatViolation),
    ...result.unusedExceptions.map(formatUnusedException)
  ]
}

/**
 * Check a tree as part of a generation run: print each violation, write
 * them to reportPath when one is given (an empty file when there are none,
 * so a CI step can test it with -s), and return whether the check passed.
 * @param {Object} tree - The command tree the run generated from
 * @param {Object} [overrides] - Parsed rpk-overrides.json
 * @param {string} [reportPath] - File to write the violation lines to
 * @returns {{passed: boolean, lines: string[], checked: number}}
 */
function runOutputCheck(tree, overrides, reportPath) {
  const result = checkTree(tree, overrides)
  const lines = reportLines(result)
  console.log(`\nOutput check: ${result.checked} descriptions, ${result.violations.length} violation(s), ${result.excepted.length} excepted`)
  for (const line of lines) console.error(`  ${line}`)
  if (reportPath) {
    fs.writeFileSync(reportPath, lines.length ? lines.join('\n') + '\n' : '', 'utf8')
  }
  return { passed: lines.length === 0, lines, checked: result.checked }
}

function main(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--snapshot' || argv[i] === '--overrides') args[argv[i].slice(2)] = argv[++i]
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  if (args.help || !args.snapshot) {
    console.log('Usage: check-output.js --snapshot <rpk-vX.json> [--overrides <rpk-overrides.json>]')
    return args.help ? 0 : 2
  }
  const snapshot = JSON.parse(fs.readFileSync(path.resolve(args.snapshot), 'utf8'))
  const overrides = args.overrides ? JSON.parse(fs.readFileSync(path.resolve(args.overrides), 'utf8')) : null
  const result = checkTree(snapshot.raw_tree || snapshot.tree, overrides)
  const lines = reportLines(result)
  for (const line of lines) console.log(line)
  console.error(`rpk output check: ${result.checked} descriptions, ${result.violations.length} violation(s), ${result.excepted.length} excepted, ${result.unusedExceptions.length} unused exception(s)`)
  return lines.length > 0 ? 1 : 0
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exitCode = 2
  }
}

module.exports = { checkDescription, checkTree, reportLines, formatViolation, runOutputCheck, main }
