'use strict'

const fs = require('fs')
const path = require('path')
const { isDeepStrictEqual } = require('util')

/**
 * Schemas that document docs-data/*.json files (rpk-overrides.schema.json,
 * property-overrides.schema.json, ...) are meant to live inside each content
 * repo's own docs-data/, alongside the file they document — a writer can
 * change both the override data and its schema in one PR, without waiting on
 * a new @redpanda-data/docs-extensions-and-macros release first.
 *
 * That's exactly why this package's copy is not automatically authoritative:
 * a content repo's copy can legitimately be AHEAD of this package's, when a
 * writer documented a real override field here before anyone remembered to
 * update the schema in this package. Confirmed happening in practice —
 * docs-data/rpk-overrides.schema.json in this package is missing `asPartial`,
 * a real field the generator (tools/rpk-docs/generate-rpk-docs.js) already
 * reads, that the docs repo's copy documents correctly. A naive "package
 * always wins" sync would have silently deleted that the first time someone
 * ran it. So syncSchemas() only ever overwrites a destination file when this
 * package's copy is a superset of it (every object key the destination has,
 * the source also has) — otherwise it reports the destination-only keys and
 * refuses, same as `check` mode, unless the caller passes `force: true`.
 */

const PACKAGE_SCHEMA_DIR = path.resolve(__dirname, '..', 'docs-data')

/**
 * List the *.schema.json files this package ships.
 * @returns {Array<{name: string, sourcePath: string}>}
 */
function listPackageSchemas () {
  if (!fs.existsSync(PACKAGE_SCHEMA_DIR)) return []
  return fs.readdirSync(PACKAGE_SCHEMA_DIR)
    .filter((name) => name.endsWith('.schema.json'))
    .sort()
    .map((name) => ({ name, sourcePath: path.join(PACKAGE_SCHEMA_DIR, name) }))
}

/**
 * Find object keys present in `dest` but absent from the same path in
 * `source` — the shape of "the destination knows something the source
 * doesn't". Arrays are compared as opaque leaves (JSON Schema's own
 * structure keeps named, distinguishable content in objects — `properties`,
 * `$defs` — not in arrays like `required`/`enum`, so this is where a
 * destination-only capability would actually show up).
 *
 * @param {*} source
 * @param {*} dest
 * @param {string} [pathPrefix]
 * @returns {string[]} Dotted paths that exist in dest but not source.
 */
function findDestOnlyPaths (source, dest, pathPrefix = '') {
  if (
    dest === null || typeof dest !== 'object' || Array.isArray(dest) ||
    source === null || typeof source !== 'object' || Array.isArray(source)
  ) {
    return []
  }

  const onlyInDest = []
  for (const [key, destValue] of Object.entries(dest)) {
    const keyPath = pathPrefix ? `${pathPrefix}.${key}` : key
    if (!Object.hasOwn(source, key)) {
      onlyInDest.push(keyPath)
      continue
    }
    onlyInDest.push(...findDestOnlyPaths(source[key], destValue, keyPath))
  }
  return onlyInDest
}

/**
 * Compare this package's schemas against the copies in a destination
 * directory (a content repo's docs-data/), and optionally write updates.
 *
 * @param {object} [opts]
 * @param {string} [opts.destDir] - Directory to sync into. Defaults to
 *   docs-data/ under the current repo root.
 * @param {boolean} [opts.check=false] - When true, never writes — only
 *   reports what's missing or out of date. Use this in CI.
 * @param {boolean} [opts.force=false] - Overwrite a destination file even
 *   when it has content this package's copy lacks. Rarely correct — see the
 *   module doc comment. Ignored when `check` is true.
 * @returns {{
 *   destDir: string,
 *   results: Array<{
 *     name: string,
 *     status: ('created'|'updated'|'unchanged'|'diverged'),
 *     sourcePath: string,
 *     destPath: string,
 *     destOnlyPaths?: string[]
 *   }>,
 *   drift: boolean
 * }} drift is true when any schema is missing, differs, or has diverged.
 *   status 'diverged' means the destination has content this package's copy
 *   doesn't — nothing was written for that file unless `force` was set.
 */
function syncSchemas ({ destDir, check = false, force = false } = {}) {
  const resolvedDest = path.resolve(destDir || 'docs-data')
  const schemas = listPackageSchemas()

  const results = schemas.map(({ name, sourcePath }) => {
    const destPath = path.join(resolvedDest, name)
    const sourceContent = fs.readFileSync(sourcePath, 'utf8')
    const destExists = fs.existsSync(destPath)
    const destContent = destExists ? fs.readFileSync(destPath, 'utf8') : null

    let status
    let destOnlyPaths
    if (!destExists) {
      status = 'created'
    } else {
      // Compare parsed content, not raw text — a destination reformatted by a
      // content repo's own prettier/editorconfig (different indent, key
      // order, trailing newline) with no real data change must not read as
      // drift.
      const sourceParsed = JSON.parse(sourceContent)
      const destParsed = JSON.parse(destContent)
      if (isDeepStrictEqual(sourceParsed, destParsed)) {
        status = 'unchanged'
      } else {
        destOnlyPaths = findDestOnlyPaths(sourceParsed, destParsed)
        status = destOnlyPaths.length > 0 ? 'diverged' : 'updated'
      }
    }

    const shouldWrite = !check && (status === 'created' || status === 'updated' || (status === 'diverged' && force))
    if (shouldWrite) {
      fs.mkdirSync(resolvedDest, { recursive: true })
      fs.writeFileSync(destPath, sourceContent)
    }

    return { name, status, sourcePath, destPath, ...(destOnlyPaths ? { destOnlyPaths } : {}) }
  })

  const drift = results.some((r) => r.status !== 'unchanged')

  return { destDir: resolvedDest, results, drift }
}

module.exports = { listPackageSchemas, syncSchemas, findDestOnlyPaths, PACKAGE_SCHEMA_DIR }
