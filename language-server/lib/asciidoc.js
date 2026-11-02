'use strict'

/**
 * AsciiDoc text helpers shared by every feature module: which lines render,
 * attribute lists, the page header, inline macros, and LSP ranges.
 *
 * Positions are LSP positions: zero-based line and UTF-16 character, which is
 * how JavaScript indexes strings.
 */

const { parseHeader } = require('../../tools/check-metadata')

/**
 * Lines whose text is not converted: line comments, comment blocks, and
 * listing or literal blocks. Macros there never render, so they are not
 * checked or completed.
 *
 * @returns {Set<number>} zero-based line numbers
 */
function inertLines (lines) {
  const inert = new Set()
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const delimiter = /^(\/{4,}|-{4,}|\.{4,})\s*$/.exec(line)
    if (fence) {
      inert.add(i)
      if (delimiter && delimiter[1] === fence) fence = null
      continue
    }
    if (delimiter) {
      fence = delimiter[1]
      inert.add(i)
      continue
    }
    if (/^\/\/(?!\/)/.test(line)) inert.add(i)
  }
  return inert
}

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A regular expression for Asciidoctor's inline macro shape,
 * name:target[attrlist], for the given macro names. The target has no
 * whitespace or '['; the attrlist ends at the first ']'.
 */
function macroPattern (names) {
  const alternatives = [...names].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')
  return new RegExp(`(?<![\\w-])(${alternatives}):([^\\s[\\]]+)\\[([^\\]]*)\\]`, 'g')
}

/**
 * Every inline macro with one of `names` on a line that renders, with its
 * range and parsed attributes.
 */
function scanMacros (text, names) {
  const rx = macroPattern(names)
  const lines = String(text).split(/\r?\n/)
  const inert = inertLines(lines)
  const out = []
  lines.forEach((line, lineNo) => {
    if (inert.has(lineNo)) return
    rx.lastIndex = 0
    let m
    while ((m = rx.exec(line))) {
      const [whole, macro, name, attrlist] = m
      const nameStart = m.index + macro.length + 1
      out.push({
        macro,
        name,
        attrlist,
        attributes: parseAttrlist(attrlist),
        line: lineNo,
        range: range(lineNo, m.index, m.index + whole.length),
        nameRange: range(lineNo, nameStart, nameStart + name.length),
      })
    }
  })
  return out
}

/** Positional and named attributes, the way the macros read them. */
function parseAttrlist (attrlist) {
  const attributes = {}
  let position = 1
  for (const part of String(attrlist).split(',').map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf('=')
    if (eq > 0) attributes[part.slice(0, eq).trim()] = part.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    else attributes[position++] = part
  }
  return attributes
}

function range (line, start, end) {
  return { start: { line, character: start }, end: { line, character: end } }
}

const contains = (r, pos) =>
  pos.line === r.start.line && pos.character >= r.start.character && pos.character <= r.end.character

/** A document attribute set in the page header, such as property-validate. */
function headerAttribute (text, name) {
  const entry = parseHeader(text).filter((e) => e.name === name).pop()
  return entry ? entry.value : undefined
}

/** Whether a zero-based line is part of an attribute entry in the page header. */
function isHeaderLine (lines, lineNo) {
  return parseHeader(lines.join('\n')).some((e) => lineNo + 1 >= e.start && lineNo + 1 <= e.line)
}

/** Where one value sits on an attribute entry line; the whole line if not found. */
function valueRange (line, lineNo, attribute, value) {
  const prefix = new RegExp(`^:${attribute}!?:`).exec(line)
  const from = prefix ? prefix[0].length : 0
  const rx = new RegExp(`(^|,)\\s*(${escapeRegExp(value)})\\s*(?=,|$)`)
  const m = rx.exec(line.slice(from))
  if (!m) return range(lineNo, 0, line.length)
  const start = from + m.index + m[0].indexOf(m[2])
  return range(lineNo, start, start + value.length)
}

module.exports = {
  inertLines,
  macroPattern,
  scanMacros,
  parseAttrlist,
  range,
  contains,
  headerAttribute,
  isHeaderLine,
  valueRange,
  parseHeader,
}
