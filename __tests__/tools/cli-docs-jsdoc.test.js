'use strict'

const fs = require('fs')
const path = require('path')

/**
 * CLI_REFERENCE.adoc is generated (npm run generate:cli-docs) and a workflow
 * regenerates it on every push, so anything hand-written there is deleted
 * without warning. Two ways to lose a command's documentation silently, both of
 * which happened:
 *
 *  1. The command is not in the generator's hardcoded subcommand list, so no
 *     section is emitted at all and a hand-written one is removed on the next
 *     regeneration.
 *  2. The command's JSDoc block is not immediately before its own .command()
 *     call. The generator associates a comment with the NEXT .command() it
 *     finds, so inserting a block between an existing comment and its command
 *     silently reassigns the prose to the wrong command.
 */
const repoRoot = path.join(__dirname, '..', '..')
const cliSource = fs.readFileSync(path.join(repoRoot, 'bin', 'doc-tools.js'), 'utf8')
const generator = fs.readFileSync(path.join(repoRoot, 'tools', 'generate-cli-docs.js'), 'utf8')

// every `generate` subcommand actually registered on the CLI
const registered = [...cliSource.matchAll(/\bautomation\s*\n?\s*\.command\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])

describe('generated CLI reference cannot silently lose a command', () => {
  // Commands whose docs are ALREADY absent from CLI_REFERENCE.adoc on main,
  // recorded so the gap is visible and cannot grow silently. Not fixed here:
  // adding them would emit three new sections from JSDoc that does not exist
  // yet, which is a separate change. PR #264 removes these hardcoded lists
  // entirely by deriving the reference from the CLI, which retires this test.
  const KNOWN_UNDOCUMENTED = ['migrate-property-refs', 'rpk-plugin-stubs', 'rpk-overrides']

  test('the generator knows about every registered generate subcommand', () => {
    const listed = generator.slice(generator.indexOf('const generateSubcommands'))
    const block = listed.slice(0, listed.indexOf('];'))
    const known = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])

    expect(registered.length).toBeGreaterThan(0)
    const missing = registered.filter((c) => !known.includes(c) && !KNOWN_UNDOCUMENTED.includes(c))
    expect(missing).toEqual([])
  })

  test('every known-undocumented entry is still a real registered command', () => {
    // An entry that no longer names a registered command is a stale exemption
    // muting the check, so fail on it rather than letting it sit.
    for (const c of KNOWN_UNDOCUMENTED) expect(registered).toContain(c)
  })

  test('each JSDoc block sits immediately before the command it documents', () => {
    // Pair every "* generate <name>" header with the next .command() after it.
    const headers = [...cliSource.matchAll(/^\s*\*\s+generate ([a-z0-9-]+)\s*$/gm)]
    expect(headers.length).toBeGreaterThan(0)

    for (const h of headers) {
      const after = cliSource.slice(h.index)
      const next = after.match(/\.command\(['"]([^'"]+)['"]\)/)
      expect(next).not.toBeNull()
      // The comment documents `h[1]`, so the next command must BE `h[1]`.
      // A mismatch means the prose will be attached to the wrong command.
      expect(next[1]).toBe(h[1])
    }
  })
})
