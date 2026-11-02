'use strict'

const fs = require('fs')
const path = require('path')
const { escapeHtml } = require('../../extension-utils/html-utils')

const repoRoot = path.join(__dirname, '..', '..')

describe('escapeHtml', () => {
  test.each([
    ['ampersands first, so escapes are not double-escaped', 'a & b', 'a &amp; b'],
    ['angle brackets', '</div><script>alert(1)</script>', '&lt;/div&gt;&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['double quotes, which end an attribute', 'a" onmouseover="x', 'a&quot; onmouseover=&quot;x'],
    ['JSON, which is mostly quotes', '{"config":"a&b"}', '{&quot;config&quot;:&quot;a&amp;b&quot;}'],
  ])('escapes %s', (_label, input, expected) => {
    expect(escapeHtml(input)).toBe(expected)
  })

  test.each([
    [null, ''],
    [undefined, ''],
    ['', ''],
    [0, '0'],
    [false, 'false'],
  ])('coerces %p to %p', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected)
  })
})

/**
 * The same four-replacement escape had grown private copies (one of them
 * partial, escaping quotes only). Keep it at one: this check fails if a new copy
 * comes back, so nobody has to notice it in review.
 *
 * KNOWN_COPIES records the copies that exist today and are deliberately NOT
 * consolidated yet, each with the reason. The list is an admission of debt, not
 * a licence: anything not on it fails, so a new copy cannot arrive quietly, and
 * removing an entry is how the debt gets paid.
 */
const KNOWN_COPIES = Object.freeze({
  // Empty: the badge.js copy this list existed for is consolidated now that
  // PR #266, which was adding call sites to it, has merged. Add an entry only
  // with a reason and a plan to remove it; the test below fails on a stale one.
})

describe('no private copies of the HTML escape', () => {
  const shared = path.join('extension-utils', 'html-utils.js')

  const jsFiles = ['extensions', 'macros', 'extension-utils', 'asciidoc-extensions'].flatMap((dir) => {
    const walk = (relative) =>
      fs.readdirSync(path.join(repoRoot, relative), { withFileTypes: true }).flatMap((entry) => {
        const next = path.join(relative, entry.name)
        if (entry.isDirectory()) return walk(next)
        return entry.name.endsWith('.js') ? [next] : []
      })
    return walk(dir)
  }).filter((file) => file !== shared && !(file in KNOWN_COPIES))

  test.each(jsFiles)('%s does not define its own escape', (file) => {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8')
    expect(source).not.toMatch(/function\s+escape(Html|Attr)\s*\(/)
    // Replacing anything WITH &quot; is hand-rolled attribute escaping. The
    // reverse direction (unescaping &quot; back to a quote) is unrelated.
    expect(source).not.toMatch(/replace\([^)]*,\s*['"]&quot;['"]\)/)
  })

  // An entry that no longer describes a real copy is a mute button left on by
  // accident, so it has to fail too: either the copy is gone and the entry
  // should go with it, or the file moved and the entry is not protecting
  // anything.
  const excused = Object.keys(KNOWN_COPIES)
  const eachExcused = excused.length ? test.each(excused) : (_name, _fn) => {}
  eachExcused('%s still contains the copy it is excused for', (file) => {
    const full = path.join(repoRoot, file)
    expect(fs.existsSync(full)).toBe(true)
    const source = fs.readFileSync(full, 'utf8')
    const hasCopy = /function\s+escape(Html|Attr)\s*\(/.test(source) ||
      /const\s+escape(Html|Attr)\s*=/.test(source) ||
      /replace\([^)]*,\s*['"]&quot;['"]\)/.test(source)
    expect(hasCopy).toBe(true)
  })
})
