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
 *     regeneration. The generator now walks the CLI's own command tree
 *     instead of hardcoded lists (`documentCommand`), which structurally
 *     retires this failure mode — guarded below by asserting the hardcoded
 *     lists don't reappear.
 *  2. The command's JSDoc block is not immediately before its own .command()
 *     call. The generator associates a comment with the NEXT .command() it
 *     finds, so inserting a block between an existing comment and its command
 *     silently reassigns the prose to the wrong command.
 *
 *  3. The same command NAME is registered under two groups. Comments used to be
 *     keyed by bare name, so `validation.command('kapa-source-groups')`
 *     overwrote `automation.command('kapa-source-groups')` and the
 *     `generate kapa-source-groups` section shipped describing the validate
 *     command, with validate examples under a generate usage line. Keyed by the
 *     full command path now.
 */
const repoRoot = path.join(__dirname, '..', '..')
const cliSource = fs.readFileSync(path.join(repoRoot, 'bin', 'doc-tools.js'), 'utf8')
const generator = fs.readFileSync(path.join(repoRoot, 'tools', 'generate-cli-docs.js'), 'utf8')

// every `generate` subcommand actually registered on the CLI
const registered = [...cliSource.matchAll(/\bautomation\s*\n?\s*\.command\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])

describe('generated CLI reference cannot silently lose a command', () => {
  test('the generator derives sections from the CLI\'s own command tree, not a hardcoded list', () => {
    // The whole point of walking `mainData.commands` recursively is that a
    // hardcoded per-command list can drift from what's actually registered.
    // Guard against that mechanism reappearing.
    expect(registered.length).toBeGreaterThan(0)
    expect(generator).not.toMatch(/const\s+(generateSubcommands|validateSubcommands|topLevelCommands)\s*=/)
    expect(generator).toMatch(/documentCommand/)
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

describe('a command name used by two groups keeps two distinct sections', () => {
  const validationCommands = [
    ...cliSource.matchAll(/\bvalidation\s*\n?\s*\.command\(['"]([^'"]+)['"]\)/g),
  ].map((m) => m[1])

  // Found by intersection rather than hardcoded, so the next name registered
  // under both groups is covered without anyone remembering to add it.
  const shared = registered.filter((name) => validationCommands.includes(name))

  test('the generator captures the group, not just the command name', () => {
    // Keying on the bare name is what let one section overwrite the other.
    expect(generator).toMatch(/\(programCli\|automation\|validation\)/)
    expect(generator).toMatch(/comments\[`\$\{groupPrefix\}\$\{commandName\}`\]/)
  })

  test('the lookup prefers the full command path', () => {
    expect(generator).toMatch(/jsdocs\[label\]/)
  })

  if (shared.length) {
    const reference = fs.readFileSync(path.join(repoRoot, 'CLI_REFERENCE.adoc'), 'utf8')

    // The paragraph immediately after the heading is the command's description.
    const descriptionOf = (heading) => {
      const i = reference.indexOf(`\n=== ${heading}\n`)
      if (i === -1) return null
      return reference.slice(i).split('\n').filter(Boolean)[1] || null
    }

    test.each(shared)('generate %s and validate %s describe different commands', (name) => {
      const gen = descriptionOf(`generate ${name}`)
      const val = descriptionOf(`validate ${name}`)
      expect(gen).toBeTruthy()
      expect(val).toBeTruthy()
      expect(gen).not.toBe(val)
    })

    test.each(shared)('the generate %s examples do not invoke validate', (name) => {
      // The clearest symptom of the collision: a generate section whose
      // examples all read `doc-tools validate ...`.
      const i = reference.indexOf(`\n=== generate ${name}\n`)
      // Bounded by the next heading of ANY level. Terminating on '=== ' alone
      // ran past the end of the section into the '== validate' group heading,
      // whose own usage line made this test fail on correct output.
      const rest = reference.slice(i + 1)
      const next = rest.search(/\n={2,} /)
      const section = next === -1 ? rest : rest.slice(0, next)
      const invocations = [...section.matchAll(/doc-tools (generate|validate) /g)].map((m) => m[1])
      expect(invocations.length).toBeGreaterThan(0)
      expect(invocations).not.toContain('validate')
    })
  }
})
