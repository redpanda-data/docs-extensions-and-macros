'use strict'

const fs = require('fs')
const path = require('path')

/**
 * The macro test harness builds a second playbook, and its header promises it is
 * identical to the normal local playbook apart from the content sources and the
 * output directory. Nothing enforced that, and it had silently drifted: the
 * harness was missing set-available-attachment-versions and
 * render-property-descriptions, so `scripts/macro-test.sh` reported on a build
 * where two of the extensions under test never ran -- and every diagnostic
 * counter for them read zero, which looks exactly like "no problems".
 *
 * Asserting the sets match is the durable fix. Anything intentionally different
 * goes in ONLY_IN with a reason, so a deliberate difference is a visible
 * decision rather than an omission nobody notices.
 */
const REPO = path.join(__dirname, '..')
const MAIN = 'local-antora-playbook.yml'
const HARNESS = 'local-macro-test-playbook.yml'

// Extensions deliberately registered in one playbook only.
const ONLY_IN = {
  [MAIN]: [],
  [HARNESS]: [],
}

function registrations (file) {
  const source = fs.readFileSync(path.join(REPO, file), 'utf8')
  const found = new Set()
  const rx = /(?:require:\s*|-\s*)'\.\/((?:extensions|macros|asciidoc-extensions)\/[\w./-]+)'/g
  let match
  while ((match = rx.exec(source)) !== null) found.add(match[1].replace(/\.js$/, ''))
  return found
}

describe('the macro test harness matches the local playbook', () => {
  const main = registrations(MAIN)
  const harness = registrations(HARNESS)

  it('reads a plausible number of registrations from both', () => {
    // Guard the parser itself: a regex that matched nothing would make every
    // assertion below pass vacuously.
    expect(main.size).toBeGreaterThan(10)
    expect(harness.size).toBeGreaterThan(10)
  })

  it('registers every extension the local playbook does', () => {
    const missing = [...main].filter((e) => !harness.has(e) && !ONLY_IN[MAIN].includes(e))
    expect(missing).toEqual([])
  })

  it('registers nothing the local playbook does not', () => {
    const extra = [...harness].filter((e) => !main.has(e) && !ONLY_IN[HARNESS].includes(e))
    expect(extra).toEqual([])
  })
})
