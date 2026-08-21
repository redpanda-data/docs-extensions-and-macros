'use strict'

const { escapeHtml } = require('../../extension-utils/html-utils')

describe('escapeHtml', () => {
  test('escapes the characters that break out of content and attributes', () => {
    expect(escapeHtml('<b>x</b>')).toBe('&lt;b&gt;x&lt;/b&gt;')
    expect(escapeHtml('a & b')).toBe('a &amp; b')
    expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;')
    expect(escapeHtml('/a/" onmouseover="alert(1)')).toBe('/a/&quot; onmouseover=&quot;alert(1)')
  })

  test('escapes the ampersand first, so an escape cannot be re-escaped into markup', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  test('returns an empty string for falsy values', () => {
    expect(escapeHtml('')).toBe('')
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })

  test('stringifies non-strings', () => {
    expect(escapeHtml(42)).toBe('42')
  })

  test('is the single implementation: nobody keeps a private copy', () => {
    const { execFileSync } = require('child_process')
    const path = require('path')
    const repoRoot = path.join(__dirname, '..', '..')
    let hits = ''
    try {
      hits = execFileSync('grep', [
        '-rn', 'replace(/&/g', '--include=*.js',
        'macros', 'extensions', 'extension-utils', 'cli-utils', 'asciidoc-extensions', 'tools'
      ], { cwd: repoRoot, encoding: 'utf8' })
    } catch (error) {
      // grep exits 1 when there are no matches
      hits = error.status === 1 ? '' : (() => { throw error })()
    }
    const files = hits.split('\n').filter(Boolean).map(line => line.split(':')[0])
    expect([...new Set(files)]).toEqual(['extension-utils/html-utils.js'])
  })
})
