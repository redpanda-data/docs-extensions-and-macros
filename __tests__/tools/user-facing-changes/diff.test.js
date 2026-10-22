'use strict'

const fs = require('fs')
const path = require('path')
const { parseDiff, sideSnippets, changedLines, excerpt } = require('../../../tools/user-facing-changes/diff')
const { stripComments, splitArgs, literalValue, matchBracket } = require('../../../tools/user-facing-changes/source')
const { makeDiff } = require('./helpers')

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'user-facing-changes', name), 'utf8')

describe('parseDiff', () => {
  test('numbers every hunk line on both sides', () => {
    const [file] = parseDiff(fixture('properties-default-changed.patch'))
    expect(file.path).toBe('src/v/config/configuration.cc')
    expect(file.hunks).toHaveLength(1)
    const [hunk] = file.hunks
    expect(hunk.oldStart).toBe(158)
    expect(hunk.header).toBe('configuration::configuration(ctor_key)')
    const minus = hunk.lines.find((l) => l.sign === '-')
    const plus = hunk.lines.find((l) => l.sign === '+')
    expect(minus).toMatchObject({ text: '      128,', oldLine: 164, newLine: null })
    expect(plus).toMatchObject({ text: '      256,', oldLine: null, newLine: 164 })
    const last = hunk.lines[hunk.lines.length - 1]
    expect(last).toMatchObject({ oldLine: 171, newLine: 171 })
  })

  test('reads new, deleted and renamed file headers', () => {
    const diff = makeDiff({ 'a/old.txt': 'x\n', 'gone.txt': 'y\n' }, { 'a/old.txt': 'x\n', 'fresh.txt': 'z\n' })
    const files = parseDiff(diff)
    expect(files.find((f) => f.path === 'fresh.txt').isNew).toBe(true)
    expect(files.find((f) => f.oldPath === 'gone.txt').isDeleted).toBe(true)
    expect(files.find((f) => f.path === 'a/old.txt')).toBeUndefined()
  })

  test('a content line that starts with --- or +++ is not a header', () => {
    const diff = makeDiff({ 'f.txt': 'a\nb\n' }, { 'f.txt': 'a\n--- not a header\n+++ nor this\nb\n' })
    const [file] = parseDiff(diff)
    expect(file.path).toBe('f.txt')
    expect(file.hunks[0].lines.filter((l) => l.sign === '+').map((l) => l.text)).toEqual(['--- not a header', '+++ nor this'])
  })
})

describe('sideSnippets and changedLines', () => {
  test('rebuilds each side from context plus its own lines, with the right start line', () => {
    const [file] = parseDiff(fixture('properties-default-changed.patch'))
    const [base] = sideSnippets(file, 'base')
    const [head] = sideSnippets(file, 'head')
    expect(base.startLine).toBe(158)
    expect(base.text).toMatch(/\n      128,\n/)
    expect(base.text).not.toMatch(/256/)
    expect(head.text).toMatch(/\n      256,\n/)
    expect(head.text).not.toMatch(/128/)
    expect(base.text.split('\n')).toHaveLength(head.text.split('\n').length)
    expect([...changedLines(file, 'head')]).toEqual([164])
    expect([...changedLines(file, 'base')]).toEqual([164])
  })
})

describe('excerpt', () => {
  test('quotes the hunk lines covering a span, with the -/+ pair kept together', () => {
    const [file] = parseDiff(fixture('properties-default-changed.patch'))
    const text = excerpt(file, 'head', 158, 165)
    expect(text.split('\n')[0]).toMatch(/^@@ -158,14 \+158,14 @@ configuration::configuration\(ctor_key\)$/)
    expect(text).toMatch(/^-      128,$/m)
    expect(text).toMatch(/^\+      256,$/m)
    expect(text).not.toMatch(/rpc_server_compress_replies/)
  })

  test('is capped so a finding never carries a whole file', () => {
    const big = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const diff = makeDiff({ 'f.txt': big }, { 'f.txt': big.replace(/line (\d+)/g, 'row $1') })
    const [file] = parseDiff(diff)
    const text = excerpt(file, 'head', 1, 80)
    expect(text.split('\n').length).toBeLessThanOrEqual(14)
    expect(text).toMatch(/more line\(s\)$/)
  })

  test('falls back to the nearest hunk when the span meets none', () => {
    const [file] = parseDiff(fixture('properties-default-changed.patch'))
    expect(excerpt(file, 'head', 1, 1)).toMatch(/^@@ -158/)
  })
})

describe('source helpers', () => {
  test('stripComments keeps line count and leaves strings alone', () => {
    const src = 'a("http://x", /* c1\nstill c1 */ "y // not a comment"); // tail\nb()'
    const out = stripComments(src)
    expect(out.split('\n')).toHaveLength(3)
    expect(out).toMatch(/"http:\/\/x"/)
    expect(out).toMatch(/"y \/\/ not a comment"/)
    expect(out).not.toMatch(/tail|c1/)
  })

  test('stripComments leaves a C++ raw string and a Go raw string intact', () => {
    expect(stripComments('R"(a // b /* c */)" x')).toBe('R"(a // b /* c */)" x')
    expect(stripComments('`a // b\n/* c */` // d')).toBe('`a // b\n/* c */`     ')
  })

  test('splitArgs respects brackets, strings, templates and lambdas', () => {
    const args = splitArgs('*this, "a, b", std::vector<int, alloc>{1, 2}, [](int v) { return v < 3, v > 1; }, {.min = 8}')
    expect(args).toEqual(['*this', '"a, b"', 'std::vector<int, alloc>{1, 2}', '[](int v) { return v < 3, v > 1; }', '{.min = 8}'])
  })

  test('splitArgs does not read a comparison as a template', () => {
    expect(splitArgs('a < b, c > d')).toEqual(['a < b', 'c > d'])
    expect(splitArgs('x->y, z')).toEqual(['x->y', 'z'])
  })

  test('literalValue joins adjacent literals and rejects non-literals', () => {
    expect(literalValue('"a" "b"')).toBe('ab')
    expect(literalValue('"a\\"b"')).toBe('a"b')
    expect(literalValue('128')).toBeNull()
    expect(literalValue('fmt::format("x")')).toBeNull()
  })

  test('matchBracket returns -1 for a cut span', () => {
    expect(matchBracket('f(a, (b)', 1)).toBe(-1)
    expect(matchBracket('f(a, (b))', 1)).toBe(8)
  })
})
