'use strict'

/**
 * Writes Connect connector data with its 64-bit integers exact.
 *
 * Connect's data carries int64 limits as defaults (for example the `max` of
 * the Bloblang `counter` function, 9223372036854775807). The pipeline works
 * on plain JavaScript numbers, which round anything past 2^53, and every file
 * it wrote carried the rounded value (9223372036854776000).
 *
 * The pipeline keeps working on plain numbers: turning these values into
 * BigInt would reach every JSON.stringify in it (default comparisons, deep
 * copies), which throw on BigInt. Instead, `remember` records the exact
 * integers from Connect's own JSON text, and `stringify` puts them back when a
 * file is written. A value is put back only at the same component and field,
 * and only where the number there is the rounded form of the exact one, so an
 * override or a changed value is never replaced.
 */

const bigIntJson = require('../../cli-utils/big-int-json')

// version -> Map(path -> BigInt)
const exact = new Map()

// A path segment for an array element: its name when it has one, so the
// path survives the reordering, filtering and appending the pipeline does.
const segment = (item, index) => (item && typeof item === 'object' && typeof item.name === 'string' ? `@${item.name}` : String(index))

function walk (node, path, visit) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${path}/${segment(item, i)}`, visit))
  } else if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) walk(node[key], `${path}/${key}`, visit)
  }
  visit(node, path)
}

/**
 * Record the integers a JS number cannot hold from Connect JSON text for
 * `version`. Text that is not JSON is ignored: the caller parses it too and
 * reports that.
 */
function remember (version, text) {
  if (!version) return
  let parsed
  try {
    parsed = bigIntJson.parse(String(text))
  } catch (error) {
    return
  }
  const found = exact.get(version) || new Map()
  walk(parsed, '', (value, path) => { if (typeof value === 'bigint') found.set(path, value) })
  if (found.size > 0) exact.set(version, found)
}

/** A copy of `data` with the remembered exact integers for `version` put back. */
function restore (data, version) {
  const found = exact.get(version)
  if (!found) return data
  const copy = structuredClone(data)
  const put = (parent, key, value, path) => {
    const big = found.get(path)
    if (big !== undefined && typeof value === 'number' && Number(big) === value) parent[key] = big
  }
  const visit = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        const p = `${path}/${segment(item, i)}`
        put(node, i, item, p)
        if (item && typeof item === 'object') visit(item, p)
      })
    } else if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        const p = `${path}/${key}`
        put(node, key, node[key], p)
        if (node[key] && typeof node[key] === 'object') visit(node[key], p)
      }
    }
  }
  visit(copy, '')
  return copy
}

/** JSON text for `data` with the exact integers for `version`. */
function stringify (data, version, space = 2) {
  return bigIntJson.stringify(restore(data, version), space)
}

function forget () {
  exact.clear()
}

module.exports = { remember, restore, stringify, forget }
