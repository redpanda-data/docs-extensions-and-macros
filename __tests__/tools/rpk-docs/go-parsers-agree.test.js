'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const goSource = require('../../../tools/lint-strings/go-source')
const scanDeprecated = require('../../../tools/rpk-docs/scan-deprecated-commands')
const detectPlatform = require('../../../tools/rpk-docs/detect-platform-commands')

/**
 * The repo has three readers of cobra command source. Two of them were older
 * and demonstrably wrong: scan-deprecated-commands.js counted braces with no
 * awareness of strings or comments, so a `{` inside a comment unbalanced the
 * counter and truncated the cobra.Command block early, and
 * detect-platform-commands.js matched a bare `Use:\\s*"..."` over raw file
 * text, so it read the command name out of a comment. Both returned a phantom
 * command name where the newer string-aware helpers in
 * tools/lint-strings/go-source.js returned the correct one.
 *
 * All three now go through maskComments/findBalancedClose. This fixture is the
 * shape that told them apart: a commented-out example above the real command,
 * plus a raw-string Long containing JSON braces.
 */

const FIXTURE = `package cmd

import "github.com/spf13/cobra"

func NewCommand() *cobra.Command {
	// Legacy shape, kept for reference:
	//   cmd := &cobra.Command{
	//     Use: "legacy-oops",
	//   }
	cmd := &cobra.Command{
		Use:        "real-command",
		Short:      "Does the real thing",
		Deprecated: "use rpk real-command instead",
		Long: \`Emits a payload.

Example output:

	{"key": "value", "nested": {"a": 1}}
\`,
	}
	return cmd
}
`

describe('all three Go readers agree on the real command name', () => {
  test('go-source resolves the real command, not the commented one', () => {
    const masked = goSource.maskComments(FIXTURE)
    const use = masked.match(/\bUse:\s*"([^"]+)"/)
    expect(use[1]).toBe('real-command')
    // Guard the guard: without masking, the comment wins. If this ever stops
    // being true the fixture no longer exercises the bug.
    expect(FIXTURE.match(/\bUse:\s*"([^"]+)"/)[1]).toBe('legacy-oops')
  })

  test('scan-deprecated-commands resolves the real command and the full block', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-parsers-'))
    const file = path.join(dir, 'command.go')
    fs.writeFileSync(file, FIXTURE)
    const result = scanDeprecated.scanGoFile(file)
    expect(result).not.toBeNull()
    expect(result.use).toBe('real-command')
    // The Deprecated string sits AFTER the comment's stray brace, so a
    // truncated block loses it entirely.
    expect(result.deprecated).toBe(true)
    expect(result.deprecatedMessage).toBe('use rpk real-command instead')
    expect(result.short).toBe('Does the real thing')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('detect-platform-commands resolves the real command', () => {
    const constructors = detectPlatform.parseConstructors(FIXTURE)
    expect(constructors.NewCommand).toBeDefined()
    expect(constructors.NewCommand.useName).toBe('real-command')
    expect(constructors.NewCommand.excluded).toBe(true)
  })

  test('a Use: that appears only in a comment yields no command name', () => {
    const commentOnly = `package cmd

func NewCommand() *cobra.Command {
\t// A commented-out alternative: Use: "ghost"
\treturn &cobra.Command{
\t\tShort: "No Use field at all",
\t}
}
`
    const constructors = detectPlatform.parseConstructors(commentOnly)
    expect(constructors.NewCommand.useName).toBeNull()
    expect(constructors.NewGhost).toBeUndefined()
  })

  test('both older readers import the shared helpers rather than reimplementing them', () => {
    for (const file of ['scan-deprecated-commands.js', 'detect-platform-commands.js']) {
      const source = fs.readFileSync(
        path.join(__dirname, '../../../tools/rpk-docs', file), 'utf8')
      expect(source).toMatch(/require\('\.\.\/lint-strings\/go-source'\)/)
    }
  })
})
