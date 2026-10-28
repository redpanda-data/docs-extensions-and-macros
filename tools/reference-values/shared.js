'use strict'

/* Helpers shared by the rpk and Connect engines of check-reference-values:
 * walking a checkout, recognizing pages to skip, backticked spans, and
 * comparing a written value with a value from the data.
 */

const fs = require('fs')
const path = require('path')
const {
  parseValue,
  TIME_UNITS_MS,
  isGenerated,
} = require('../migrate-property-values')

const norm = (text) => String(text).replace(/`/g, '').replace(/\s+/g, ' ').trim()

/**
 * Files under modules/ with one of the extensions, relative to docsDir and
 * sorted, minus excluded paths. With `only`, just those files.
 */
function walkFiles (docsDir, { exclude = [], extensions = ['.adoc'], only, root = 'modules', include } = {}) {
  const out = []
  const wanted = only ? new Set(only.map((f) => path.normalize(f))) : undefined
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      const relative = path.relative(docsDir, full)
      if (exclude.some((fragment) => `${relative}/`.includes(fragment) || relative.includes(fragment))) continue
      if (entry.isDirectory()) walk(full)
      else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        if (wanted && !wanted.has(path.normalize(relative))) continue
        if (include && !include(relative)) continue
        out.push(relative)
      }
    }
  }
  walk(path.join(docsDir, root))
  return out
}

/**
 * A stub page: after the title, only include:: lines, attribute entries,
 * comments and blank lines. Its content is scanned where it lives.
 */
function isStubPage (content) {
  const lines = content.split('\n')
  let inComment = false
  let sawInclude = false
  for (const line of lines) {
    const t = line.trim()
    if (/^\/{4,}$/.test(t)) {
      inComment = !inComment
      continue
    }
    if (inComment || !t) continue
    if (/^=\s/.test(t) || /^:[-\w]+!?:/.test(t) || t.startsWith('//')) continue
    if (/^include::/.test(t)) {
      sawInclude = true
      continue
    }
    return false
  }
  return sawInclude
}

/**
 * Backticked spans on a line: `text`, ``text``, and `+text+` (the pluses are
 * stripped). Escaped backticks and a backtick inside a span do not count.
 *
 * @returns {{text: string, start: number, end: number, innerStart: number}[]}
 */
function backtickSpans (line) {
  const spans = []
  const rx = /(?<![`\\\w])(``?)(?!`)(\+?)([^`]+?)\2\1(?![`\w])/g
  for (const m of line.matchAll(rx)) {
    const innerStart = m.index + m[1].length + m[2].length
    spans.push({ text: m[3], start: m.index, end: m.index + m[0].length, innerStart })
  }
  return spans
}

/**
 * A Go duration (10s, 1m0s, 1h30m, 500ms) in milliseconds, or undefined.
 */
function goDurationMs (text) {
  const t = String(text).trim()
  if (!/^-?(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/.test(t)) return undefined
  const factor = { ns: 1e-6, us: 1e-3, µs: 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000 }
  let total = 0
  for (const m of t.replace(/^-/, '').matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) total += Number(m[1]) * factor[m[2]]
  return t.startsWith('-') ? -total : total
}

/**
 * A written duration in milliseconds: a number with a time unit (30 seconds,
 * 24h) or a Go duration string.
 */
function writtenMs (parsed) {
  if (!parsed) return undefined
  if (parsed.kind === 'number' && parsed.unitKind === 'time') return parsed.number * TIME_UNITS_MS[parsed.unit]
  if (parsed.kind === 'string') return goDurationMs(parsed.string)
  return undefined
}

const NUMBER_RX = /^-?\d+(?:\.\d+)?$/

/**
 * Compare a written value with the text the macro renders.
 *
 * Mismatch is reserved for comparisons that cannot be a difference of
 * wording: two numbers, two durations, a boolean flag's two booleans, or two
 * strings. Anything else is not comparable.
 *
 * @param {object} parsed - From parseValue.
 * @param {string} dataText - What the macro renders.
 * @param {object} [opts]
 * @param {boolean} [opts.bool] - The value is a boolean (on/off count).
 * @param {boolean} [opts.msUnit] - A bare data number is milliseconds (an -ms flag).
 * @param {boolean} [opts.stringType] - The data value is a string.
 * @returns {'exact'|'equivalent'|'mismatch'|'unset'|'not-comparable'}
 */
function compareWritten (parsed, dataText, { bool = false, msUnit = false, stringType = false } = {}) {
  const written = norm(parsed.written)
  if (written === dataText) return 'exact'
  if (dataText === '""' || dataText === '[]' || dataText === '{}') {
    if (parsed.kind === 'null') return 'equivalent'
    if (parsed.kind === 'string' && (parsed.string === '' || parsed.string === '""')) return 'equivalent'
    return 'unset'
  }
  if (parsed.kind === 'null') return 'mismatch'
  if (bool && /^(true|false)$/.test(dataText)) {
    if (parsed.kind === 'bool') return parsed.bool === (dataText === 'true') ? 'equivalent' : 'mismatch'
    return 'not-comparable'
  }
  const dataMs = goDurationMs(dataText) !== undefined && !NUMBER_RX.test(dataText)
    ? goDurationMs(dataText)
    : msUnit && NUMBER_RX.test(dataText) ? Number(dataText) : undefined
  if (dataMs !== undefined) {
    const ms = writtenMs(parsed)
    if (ms !== undefined) return Math.abs(ms - dataMs) < 1e-6 ? 'equivalent' : 'mismatch'
    if (msUnit && parsed.kind === 'number' && !parsed.unit) return parsed.number === dataMs ? 'equivalent' : 'mismatch'
    return 'not-comparable'
  }
  if (NUMBER_RX.test(dataText)) {
    if (parsed.kind === 'number' && !parsed.unit) return parsed.number === Number(dataText) ? 'equivalent' : 'mismatch'
    return 'not-comparable'
  }
  if (parsed.kind === 'string' || (stringType && parsed.kind === 'bool')) {
    const value = parsed.string
    if (value === dataText) return 'equivalent'
    if (value.toLowerCase() === dataText.toLowerCase()) return 'equivalent'
    return /\s/.test(value) ? 'not-comparable' : 'mismatch'
  }
  return 'not-comparable'
}

// Words a writer puts between a default phrase and its value: "defaults to
// the last 24 hours", "prints at most 50 entries".
const FILLER_RX = /^(?:the\s+(?:last\s+|first\s+)?|at\s+most\s+|at\s+least\s+|up\s+to\s+|every\s+)(?=-?\d)/i
// A bare word that starts a description, not a value: "defaults to the
// current time".
const NOT_A_VALUE = new Set(['the', 'a', 'an', 'this', 'that', 'its', 'their', 'every', 'each', 'whatever', 'whichever', 'one', 'some', 'any', 'all'])

/**
 * parseValue, after skipping filler words before a number. Undefined parsed
 * when the text starts with a word that describes rather than states a value.
 */
function parseAfterFiller (text) {
  const filler = text.match(FILLER_RX)
  const skip = filler ? filler[0].length : 0
  const parsed = parseValue(text.slice(skip))
  if (parsed && parsed.bareWord && NOT_A_VALUE.has(parsed.string.toLowerCase())) return { parsed: undefined, skip }
  return { parsed, skip }
}

/**
 * Lines a `// value-check: ignore` comment suppresses: the line directly
 * after it, or every line of the delimited block it sits directly before
 * (with or without a block attribute line or title in between).
 *
 * @returns {Set<number>} 1-based line numbers.
 */
function ignoredLines (content) {
  const lines = content.split('\n')
  const out = new Set()
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\/\/\s*value-check:\s*ignore\s*$/.test(lines[i])) continue
    let j = i + 1
    out.add(j + 1)
    while (j < lines.length && (/^\[.*\]\s*$/.test(lines[j].trim()) || /^\.[^.\s]/.test(lines[j].trim()))) {
      j++
      out.add(j + 1)
    }
    const fence = j < lines.length && lines[j].trim().match(/^(-{4,}|\.{4,}|`{3,})/)
    if (!fence) continue
    const close = fence[1].startsWith('```') ? /^`{3,}\s*$/ : new RegExp(`^${fence[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
    for (let k = j + 1; k < lines.length; k++) {
      out.add(k + 1)
      if (close.test(lines[k].trim())) break
    }
  }
  return out
}

const readText = (file) => fs.readFileSync(file, 'utf8')

// Per-release pages HISTORICAL_RX does not match (docs
// modules/reference/pages/releases/). Historical for rpk and Connect only, so
// property findings stay as migrate-property-values reports them.
const RELEASES_RX = /(?:^|\/)releases\//

module.exports = {
  norm,
  walkFiles,
  isStubPage,
  isGenerated,
  backtickSpans,
  goDurationMs,
  writtenMs,
  compareWritten,
  parseAfterFiller,
  ignoredLines,
  readText,
  RELEASES_RX,
  FILLER_RX,
}
