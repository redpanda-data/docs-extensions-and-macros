'use strict'

/**
 * The `.promql` example file: one query per file, inside a `query` tag, with
 * test settings in comment lines outside the tag.
 *
 *   # expect: empty
 *   # set: <topic>=metrics-probe
 *   # tag::query[]
 *   redpanda_kafka_under_replicated_replicas{redpanda_topic="<topic>"} > 0
 *   # end::query[]
 *
 * A page includes the file with `include::...[tag=query]`, so readers see
 * only the query.
 */

const EXPECT_VALUES = ['series', 'empty', 'scalar']
const SETTINGS = ['expect', 'set', 'skip-run', 'extra-labels']
const TAG_START = /^#\s*tag::([A-Za-z0-9_-]+)\[\]\s*$/
const TAG_END = /^#\s*end::([A-Za-z0-9_-]+)\[\]\s*$/
const SETTING = /^#\s*([A-Za-z][A-Za-z0-9_-]*)\s*:(.*)$/
const LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

// What a reader is meant to replace: <topic>, $interval, ${interval}, $__rate_interval, [[interval]].
const PLACEHOLDER = /<[A-Za-z][A-Za-z0-9_-]*>|\$\{[A-Za-z_][A-Za-z0-9_:.]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\[\[[A-Za-z_][A-Za-z0-9_:.]*\]\]/g

/**
 * Placeholders in a query, each once, in the order written. Text in a `#`
 * comment is not part of the query and is ignored.
 */
function findPlaceholders (query) {
  const found = []
  for (const line of query.split('\n')) {
    const code = stripComment(line)
    for (const match of code.match(PLACEHOLDER) || []) if (!found.includes(match)) found.push(match)
  }
  return found
}

// Cuts a line at the first `#` that is not inside a string.
function stripComment (line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\' && quote !== '`') i += 1
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '#') return line.slice(0, i)
  }
  return line
}

/**
 * Read a query file.
 *
 * @param {string} text - The file's text.
 * @returns {{ errors: string[], query: string|null, resolved: string|null, settings: object }}
 *   `query` is the text inside the tag as readers see it. `resolved` is the
 *   query with every placeholder replaced, or null when the file has an error.
 */
function parseQueryFile (text) {
  const errors = []
  const settings = { expect: 'series', set: {}, skipRun: null, extraLabels: [] }
  const seen = new Set()
  const body = []
  let tags = 0
  let inside = false

  const lines = text.replace(/\r\n/g, '\n').split('\n')
  lines.forEach((line, index) => {
    const at = `line ${index + 1}`
    const trimmed = line.trim()
    const start = TAG_START.exec(trimmed)
    const end = TAG_END.exec(trimmed)
    if (inside) {
      if (end && end[1] === 'query') { inside = false; return }
      if (start || end) { errors.push(`${at}: a tag inside the query tag is not allowed`); return }
      body.push(line)
      return
    }
    if (start) {
      if (start[1] !== 'query') { errors.push(`${at}: unknown tag "${start[1]}". The only tag is "query"`); return }
      tags += 1
      inside = true
      return
    }
    if (end) { errors.push(`${at}: end::${end[1]}[] has no matching tag::${end[1]}[]`); return }
    if (!trimmed) return
    const setting = SETTING.exec(trimmed)
    if (!setting) {
      errors.push(`${at}: only settings (# name: value) and blank lines are allowed outside the query tag`)
      return
    }
    const name = setting[1]
    const value = setting[2].trim()
    if (!SETTINGS.includes(name)) {
      errors.push(`${at}: unknown setting "${name}". The settings are ${SETTINGS.join(', ')}`)
      return
    }
    if (name !== 'set' && seen.has(name)) { errors.push(`${at}: "${name}" is given twice`); return }
    seen.add(name)
    if (name === 'expect') {
      if (!EXPECT_VALUES.includes(value)) errors.push(`${at}: expect must be one of ${EXPECT_VALUES.join(', ')}, got "${value}"`)
      else settings.expect = value
    } else if (name === 'skip-run') {
      if (!value) errors.push(`${at}: skip-run needs a reason`)
      else settings.skipRun = value
    } else if (name === 'extra-labels') {
      const labels = value.split(',').map((label) => label.trim()).filter(Boolean)
      const bad = labels.filter((label) => !LABEL_NAME.test(label))
      if (!labels.length) errors.push(`${at}: extra-labels needs at least one label name`)
      else if (bad.length) errors.push(`${at}: extra-labels has a name that is not a label name: ${bad.join(', ')}`)
      else settings.extraLabels = labels
    } else {
      const equals = value.indexOf('=')
      const placeholder = equals === -1 ? '' : value.slice(0, equals).trim()
      const replacement = equals === -1 ? '' : value.slice(equals + 1).trim()
      const whole = placeholder.match(PLACEHOLDER)
      if (equals === -1 || !placeholder || !replacement) errors.push(`${at}: set must be <placeholder>=value`)
      else if (!whole || whole[0] !== placeholder) errors.push(`${at}: "${placeholder}" is not a placeholder. A placeholder looks like <topic>, $interval, \${interval} or [[interval]]`)
      else if (placeholder in settings.set) errors.push(`${at}: "${placeholder}" is set twice`)
      else settings.set[placeholder] = replacement
    }
  })

  if (inside) errors.push('the query tag is not closed with # end::query[]')
  if (tags === 0) errors.push('no query tag. Put the query between # tag::query[] and # end::query[]')
  if (tags > 1) errors.push(`${tags} query tags. A file holds one query`)

  let query = null
  let resolved = null
  if (tags === 1 && !inside) {
    query = body.join('\n').trim()
    if (!body.some((line) => stripComment(line).trim())) errors.push('the query is empty')
    else {
      const placeholders = findPlaceholders(query)
      for (const placeholder of placeholders) {
        if (!(placeholder in settings.set)) errors.push(`the query has the placeholder ${placeholder} and no "set: ${placeholder}=value" for it`)
      }
      for (const placeholder of Object.keys(settings.set)) {
        if (!placeholders.includes(placeholder)) errors.push(`set: ${placeholder} is not a placeholder in the query`)
      }
      if (!errors.length) {
        // A comment keeps its text: readers see it, and Prometheus ignores it.
        resolved = query.split('\n').map((line) => {
          const code = stripComment(line)
          return code.replace(PLACEHOLDER, (match) => settings.set[match]) + line.slice(code.length)
        }).join('\n')
      }
    }
  }
  return { errors, query, resolved, settings }
}

module.exports = { EXPECT_VALUES, SETTINGS, findPlaceholders, parseQueryFile, stripComment }
