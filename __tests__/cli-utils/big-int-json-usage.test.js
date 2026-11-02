'use strict'

const fs = require('fs')
const path = require('path')

/**
 * A file that reads property data with bigIntJson.parse() gets real BigInt
 * values back for uint64/int64 limits. Serializing any structure derived from
 * that data with plain JSON.stringify throws ("Do not know how to serialize a
 * BigInt") instead of writing -- this happened twice in
 * tools/property-extractor/compare-properties.js (the JSON report writer and
 * the console formatter) before being fixed to use bigIntJson.stringify.
 *
 * This test makes the mistake structurally hard to reintroduce: any file that
 * imports cli-utils/big-int-json may not also call plain JSON.stringify(.
 */
const repoRoot = path.join(__dirname, '..', '..')
const SEARCH_DIRS = ['extensions', 'tools', 'cli-utils', 'bin']
const IMPORT_RX = /require\(['"][^'"]*\/cli-utils\/big-int-json['"]\)/
const PLAIN_STRINGIFY_RX = /(?<!big[Ii]nt[Jj]son\.)\bJSON\.stringify\(/

function walk (relative) {
  const full = path.join(repoRoot, relative)
  if (!fs.existsSync(full)) return []
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const next = path.join(relative, entry.name)
    if (entry.isDirectory()) return walk(next)
    return entry.name.endsWith('.js') ? [next] : []
  })
}

const jsFiles = SEARCH_DIRS.flatMap(walk)
const consumers = jsFiles.filter((file) =>
  IMPORT_RX.test(fs.readFileSync(path.join(repoRoot, file), 'utf8'))
)

describe('big-int-json consumers never fall back to plain JSON.stringify', () => {
  it('finds a plausible number of consumers, so this check isn\'t vacuous', () => {
    expect(consumers.length).toBeGreaterThan(0)
  })

  test.each(consumers)('%s uses bigIntJson.stringify, not JSON.stringify', (file) => {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8')
    const offendingLines = source
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => PLAIN_STRINGIFY_RX.test(line))
    expect(offendingLines).toEqual([])
  })
})
