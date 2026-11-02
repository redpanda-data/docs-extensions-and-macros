'use strict'

const { maskComments, collectStringConsts, evalStringExpr } = require('../../../tools/lint-strings/go-source')

describe('collectStringConsts (single-const form)', () => {
  it('resolves a top-level const whose value fits on one line', () => {
    const src = maskComments('const greeting = "hello there"\n')
    const consts = collectStringConsts(src)
    expect(consts.get('greeting')).toBe('hello there')
  })

  it('resolves a multi-line, unparenthesized string concatenation joined by +', () => {
    const src = maskComments(
      'const longHelp = "first part " +\n\t"second part."\n'
    )
    const consts = collectStringConsts(src)
    expect(consts.get('longHelp')).toBe('first part second part.')
  })

  it('resolves a concatenation spanning more than two lines', () => {
    const src = maskComments(
      'const longHelp = "one " +\n\t"two " +\n\t"three."\n'
    )
    const consts = collectStringConsts(src)
    expect(consts.get('longHelp')).toBe('one two three.')
  })

  it('still stops at the real statement end after a wrapped concatenation', () => {
    const src = maskComments(
      'const longHelp = "first part " +\n\t"second part."\n' +
      'const other = "unrelated"\n'
    )
    const consts = collectStringConsts(src)
    expect(consts.get('longHelp')).toBe('first part second part.')
    expect(consts.get('other')).toBe('unrelated')
  })

  it('leaves a raw-string (backtick) const spanning lines unaffected', () => {
    const src = maskComments('const raw = `line one\nline two`\n')
    const consts = collectStringConsts(src)
    expect(consts.get('raw')).toBe('line one\nline two')
  })
})

describe('evalStringExpr with a wrapped const in scope', () => {
  it('resolves an identifier reference to the full, un-truncated concatenation', () => {
    const src = maskComments('const longHelp = "first part " +\n\t"second part."\n')
    const consts = collectStringConsts(src)
    const { verifiable, value } = evalStringExpr('longHelp', consts)
    expect(verifiable).toBe(true)
    expect(value).toBe('first part second part.')
  })
})
