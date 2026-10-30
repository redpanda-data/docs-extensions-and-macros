'use strict'

// Runs the rpk-docs output check over a real command tree with the real
// overrides, the same way `doc-tools generate rpk-docs --check-output` does.
// A fixture passes while the live corpus breaks: DOC-2686's four bugs only
// showed on real rpk ai help text. See the _comment in rpk-snapshot.json for
// where both files come from.

const path = require('path')
const { checkTree, reportLines } = require('../../../tools/rpk-docs/check-output')

const dataDir = path.join(__dirname, '../../docs-data')
const snapshot = require(path.join(dataDir, 'rpk-snapshot.json'))
const overrides = require(path.join(dataDir, 'rpk-overrides.json'))

describe('rpk-docs output check on the real corpus', () => {
  let result

  beforeAll(() => {
    const warn = console.warn
    console.warn = () => {}
    try {
      result = checkTree(snapshot.raw_tree, overrides)
    } finally {
      console.warn = warn
    }
  })

  test('covers every command and flag description', () => {
    expect(result.checked).toBeGreaterThan(2000)
  })

  test('every generated description passes both invariants', () => {
    // On failure the diff lists one line per violation: command, flag,
    // invariant, reason, source, output.
    expect(reportLines(result)).toEqual([])
  })

  test('every exception still matches a violation', () => {
    expect(result.excepted.map(e => `${e.command} ${e.flag}`)).toEqual([
      'rpk redpanda tune --dirs',
      'rpk redpanda tune list --dirs'
    ])
  })
})
