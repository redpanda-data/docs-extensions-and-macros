'use strict'

// The inline-code pass (extension-utils/inline-code.js) is regex based, so it
// is checked on the real rpk corpus, rendered, not only on fixtures. Every
// help string is formatted twice, with the pass and without it, and both are
// converted with Asciidoctor. The pass may only add code spans: the visible
// text must not change, no backtick may print, and no span may be empty,
// nested, or cover half a token. Two bugs this caught: a span inside a
// monospace table column, and --cloud-secrets-* rendered as half code.

const path = require('path')
const Asciidoctor = require('@asciidoctor/core')()

const snapshot = require(path.join(__dirname, '../../docs-data/rpk-snapshot.json'))

// The real formatter first: jest.doMock is not scoped to isolateModules, so a
// require after it would get the mock too.
const withPass = require('../../../tools/rpk-docs/generate-rpk-docs').formatDescription
const withoutPass = (() => {
  let fn
  jest.isolateModules(() => {
    jest.doMock('../../../extension-utils/inline-code', () => ({
      ...jest.requireActual('../../../extension-utils/inline-code'),
      formatInlineCode: (text) => text,
    }))
    fn = require('../../../tools/rpk-docs/generate-rpk-docs').formatDescription
  })
  jest.dontMock('../../../extension-utils/inline-code')
  return fn
})()

function helpStrings (tree) {
  const out = []
  const walk = (cmd, names) => {
    const where = [...names, cmd.name]
    if (cmd.description) out.push([`${where.join(' ')} (description)`, cmd.description])
    for (const flag of [...(cmd.flags || []), ...(cmd.global_flags || [])]) {
      if (flag.description) out.push([`${where.join(' ')} --${flag.name}`, flag.description])
    }
    for (const child of cmd.commands || []) walk(child, where)
  }
  walk(tree, [])
  return out
}

const render = (source) => Asciidoctor.convert(source, { safe: 'safe', attributes: { 'attribute-missing': 'skip' } })
const visible = (html) => html
  .replace(/<[^>]+>/g, '')
  .replace(/&#821[67];/g, "'").replace(/&#822[01];/g, '"')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim()
const HALF_TOKEN = /[A-Za-z0-9*-]<code>|<\/code>[A-Za-z0-9*-]/

describe('inline-code pass on the real rpk corpus, rendered', () => {
  const tree = snapshot.raw_tree
  const strings = helpStrings(tree)
  const changed = []
  const problems = []

  beforeAll(() => {
    for (const [where, text] of strings) {
      const before = withoutPass(text)
      const after = withPass(text)
      if (before === after) continue
      changed.push(where)
      const hb = render(before)
      const ha = render(after)
      const issues = []
      if (visible(ha) !== visible(hb)) issues.push('visible text changed')
      if ((visible(ha).match(/`/g) || []).length > (visible(hb).match(/`/g) || []).length) issues.push('a backtick prints')
      if (/<code>\s*<\/code>/.test(ha)) issues.push('empty code span')
      if (/<code>[^<]*<code>/.test(ha)) issues.push('nested code span')
      if (HALF_TOKEN.test(ha) && !HALF_TOKEN.test(hb)) issues.push('code span covers half a token')
      if (issues.length) problems.push(`${where}: ${issues.join(', ')}`)
    }
  })

  test('the corpus is real and the pass changes some of it', () => {
    expect(strings.length).toBeGreaterThan(1000)
    expect(changed.length).toBeGreaterThan(0)
  })

  test('the pass only adds code spans that render cleanly', () => {
    expect(problems).toEqual([])
  })
})
