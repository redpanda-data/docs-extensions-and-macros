'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Gate for the suites that shell out to the real Python property extractor.
 *
 * Those suites hold the only assertions covering parser.py's line_start /
 * line_end spans, which every one of the lint-strings suggestion blocks is
 * built on. They need the property-extractor venv and the tree-sitter-cpp
 * grammar, so they used to be written as
 * `(canRunExtractor ? describe : describe.skip)` - and no CI job satisfied
 * the guard: test-tools ran jest on a bare `npm ci`, and
 * test-property-extractor built the environment but ran only pytest. The
 * result was six assertions permanently dark behind a green check, which is
 * the same as not having written them.
 *
 * So the skip is loud, and in CI it is not a skip at all: a missing
 * environment fails, because a green run that quietly covered nothing is
 * worse than a red one. Locally it still skips, so a plain `npx jest` stays
 * hermetic, but it says so on stderr rather than reporting a silent pass.
 *
 * Set ALLOW_MISSING_EXTRACTOR=1 to force the local behaviour in CI.
 */
function describeWithExtractor (properties) {
  const parserC = path.join(properties.TREESITTER_DIR, 'src', 'parser.c')
  const missing = []
  if (!fs.existsSync(properties.VENV_PYTHON)) missing.push(`venv python (${properties.VENV_PYTHON})`)
  if (!fs.existsSync(parserC)) missing.push(`tree-sitter-cpp parser.c (${parserC})`)

  if (missing.length === 0) return describe

  const reason =
    `The property extractor environment is not built, so these integration ` +
    `assertions cannot run. Missing: ${missing.join(', ')}. ` +
    `Build it with "make -C tools/property-extractor venv treesitter".`

  if (process.env.CI && !process.env.ALLOW_MISSING_EXTRACTOR) {
    return (name) => {
      describe(name, () => {
        test('the property extractor environment is bootstrapped', () => {
          throw new Error(reason)
        })
      })
    }
  }

  return (name, fn) => {
    // eslint-disable-next-line no-console
    console.warn(`\nSKIPPING "${name}": ${reason}\n`)
    describe.skip(name, fn)
  }
}

module.exports = { describeWithExtractor }
