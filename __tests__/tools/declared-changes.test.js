'use strict'

const { declaredChanges, MAX_BYTES } = require('../../tools/declared-changes')

// The streaming-enterprise PR template, as an author leaves it when the PR
// has no user-facing change.
const TEMPLATE_NONE = [
  '## Backports Required',
  '',
  '- [x] none - not a bug fix',
  '',
  '## UX Changes',
  '',
  '<!--',
  'REQUIRED if this PR adds or changes anything a user sees, types, or configures.',
  'Otherwise, `none`.',
  '-->',
  '',
  '* none',
  '',
  '## User impact and why',
  '',
  '<!--',
  'Optional.',
  '-->',
  '',
  '## Release Notes',
  '',
  '<!--',
  '### Bug Fixes',
  '',
  '* Short description of the bug fix.',
  '-->',
  '',
  '* none',
  '',
  '🤖 Generated with [Claude Code](https://claude.com/claude-code)'
].join('\r\n')

function body ({ ux = '* none', impact = '', notes = '* none', tail = '' } = {}) {
  return [
    '## Cover letter', '', 'Some text.', '',
    '## UX Changes', '', ux, '',
    '## User impact and why', '', impact, '',
    '## Release Notes', '', notes, '',
    tail
  ].join('\n')
}

describe('declaredChanges', () => {
  test('the template left at none declares nothing, including notes inside comments', () => {
    expect(declaredChanges(TEMPLATE_NONE)).toEqual({ declared: false, sections: [], text: '', hash: null })
  })

  test('an empty or missing description declares nothing', () => {
    expect(declaredChanges('').declared).toBe(false)
    expect(declaredChanges(null).declared).toBe(false)
    expect(declaredChanges('Fixes CORE-1').declared).toBe(false)
  })

  test('the shape that was missed (streaming-enterprise 928) is declared', () => {
    // UX Changes and a Features note, no doc string in the diff.
    const r = declaredChanges(body({
      ux: '- `GET /v1/features/enterprise` can now list `cluster_cores_over_limit`.',
      notes: '### Features\n\n* Clusters running more than 50 cores in total now require an Enterprise license.'
    }))
    expect(r.declared).toBe(true)
    expect(r.sections).toEqual(['UX Changes', 'Release Notes: Features'])
    expect(r.text).toMatch(/cluster_cores_over_limit/)
    expect(r.text).toMatch(/### Features\n\n\* Clusters running more than 50 cores/)
    expect(r.hash).toMatch(/^[0-9a-f]{16}$/)
  })

  test('an Improvements note alone is declared (streaming-enterprise 579)', () => {
    const r = declaredChanges(body({ notes: '### Improvements\n\n* Upgrades can be finalized manually.' }))
    expect(r.sections).toEqual(['Release Notes: Improvements'])
  })

  test('bug-fix notes alone are not a declared change', () => {
    expect(declaredChanges(body({ notes: '### Bug Fixes\n\n* Fixed a crash.' })).declared).toBe(false)
    expect(declaredChanges(body({ notes: '### Bug Fix\n\n* Fixed a crash.' })).declared).toBe(false)
  })

  test('a bug fix next to a feature keeps only the feature', () => {
    const r = declaredChanges(body({ notes: '### Bug Fixes\n\n* Fixed a crash.\n\n### Features\n\n* New thing.' }))
    expect(r.sections).toEqual(['Release Notes: Features'])
    expect(r.text).not.toMatch(/crash/)
  })

  test('a sub-section that says none is not declared', () => {
    expect(declaredChanges(body({ notes: '### Features\n\n* none' })).declared).toBe(false)
  })

  test('none with an explanation, N/A and None all count as none', () => {
    for (const ux of ['* none - internal refactor', '- N/A', 'None.', 'n/a']) {
      expect(declaredChanges(body({ ux })).declared).toBe(false)
    }
  })

  test('user impact is carried as context but never declares on its own', () => {
    expect(declaredChanges(body({ impact: 'Users see faster startup.' })).declared).toBe(false)
    const r = declaredChanges(body({ ux: 'New flag `--x`.', impact: 'Users see faster startup.' }))
    expect(r.sections).toEqual(['UX Changes', 'User impact and why'])
    expect(r.text).toMatch(/## User impact and why\n\nUsers see faster startup\./)
  })

  test('the hash changes with the declaration and only with it', () => {
    const a = declaredChanges(body({ ux: 'New flag `--x`.' }))
    const b = declaredChanges(body({ ux: 'New flag `--x`.', tail: '## Testing\n\nRan it.' }))
    const c = declaredChanges(body({ ux: 'New flag `--y`.' }))
    expect(b.hash).toBe(a.hash)
    expect(c.hash).not.toBe(a.hash)
  })

  test('a level-3 heading outside Release Notes does not end a section', () => {
    const r = declaredChanges(body({ ux: '### Admin API\n\nNew endpoint.' }))
    expect(r.text).toMatch(/### Admin API\n\nNew endpoint\./)
  })

  test('an unterminated comment hides the rest, rather than leaking template text', () => {
    expect(declaredChanges('## UX Changes\n\n<!-- REQUIRED if ...\n\n### Features\n* x').declared).toBe(false)
  })

  test('a huge declaration is cut and marked', () => {
    const r = declaredChanges(body({ ux: 'x'.repeat(MAX_BYTES * 2) }))
    expect(Buffer.byteLength(r.text)).toBeLessThan(MAX_BYTES + 200)
    expect(r.text).toMatch(/Cut at \d+ bytes/)
  })
})
