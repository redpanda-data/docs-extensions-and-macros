'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

/**
 * CLI_REFERENCE.adoc must document every registered command.
 *
 * README.adoc points users at that file as the complete command reference, and
 * tools/generate-cli-docs.js used to walk three hardcoded command lists to
 * build it. Those lists drifted in both directions at once: lint-strings,
 * preview-string and `overrides audit` shipped undocumented, while
 * preview-prompt still got a section long after the command was removed (the
 * generator quietly fell back to the top-level help, so the stale section
 * looked real). The auto-commit workflow that would have caught it triggers on
 * bin/doc-tools.js, but it cannot run on a PR that conflicts with main, which
 * is exactly when a new command lands.
 *
 * The generator now derives the tree from the CLI's own help. This test is the
 * guard on that, walking the same tree independently and failing when a
 * command has no section.
 */

const REPO_ROOT = path.join(__dirname, '..')
const BIN = path.join(REPO_ROOT, 'bin', 'doc-tools.js')

function help (commandPath) {
  const result = spawnSync('node', [BIN, ...commandPath, '--help'], { encoding: 'utf8' })
  return `${result.stdout || ''}${result.stderr || ''}`
}

/** Command names listed in one help output, excluding commander's own `help`. */
function childrenOf (helpText) {
  const commandsAt = helpText.indexOf('\nCommands:\n')
  if (commandsAt === -1) return []
  const body = helpText.slice(commandsAt + '\nCommands:\n'.length)
  const names = []
  for (const line of body.split('\n')) {
    if (!/^ {2}\S/.test(line)) continue
    const name = line.trim().split(/[\s[<]/)[0]
    if (name && name !== 'help' && !names.includes(name)) names.push(name)
  }
  return names
}

function walk (commandPath = [], out = []) {
  for (const child of childrenOf(help(commandPath))) {
    const next = [...commandPath, child]
    out.push(next.join(' '))
    walk(next, out)
  }
  return out
}

describe('CLI_REFERENCE.adoc covers every registered command', () => {
  jest.setTimeout(120000)

  const reference = fs.readFileSync(path.join(REPO_ROOT, 'CLI_REFERENCE.adoc'), 'utf8')
  const headings = new Set(
    reference.split('\n')
      .filter((line) => /^={2,3} /.test(line))
      .map((line) => line.replace(/^={2,3} /, '').trim())
  )
  const commands = walk()

  test('the walk found the command tree', () => {
    // Guard the guard: an empty or shallow walk would make this vacuous.
    expect(commands.length).toBeGreaterThan(20)
    expect(commands).toContain('generate property-docs')
    expect(commands).toContain('lint-strings')
    expect(commands).toContain('overrides audit')
  })

  test('every command has a section', () => {
    const undocumented = commands.filter((c) => !headings.has(c))
    expect(undocumented).toEqual([])
  })

  test('no section documents a command that no longer exists', () => {
    const known = new Set([...commands, 'doc-tools'])
    const stale = [...headings].filter((h) => !known.has(h))
    expect(stale).toEqual([])
  })
})
