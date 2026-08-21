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
 * The same four-replacement escape had grown three private copies (one of them
 * partial, escaping quotes only). Keep it at one: this check fails if a copy
 * comes back, so nobody has to notice it in review.
 */
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
  }).filter((file) => file !== shared)

  test.each(jsFiles)('%s does not define its own escape', (file) => {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8')
    expect(source).not.toMatch(/function\s+escape(Html|Attr)\s*\(/)
    // Replacing anything WITH &quot; is hand-rolled attribute escaping. The
    // reverse direction (unescaping &quot; back to a quote) is unrelated.
    expect(source).not.toMatch(/replace\([^)]*,\s*['"]&quot;['"]\)/)
  })
})
