'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  pagesFor,
  unifiedDiff,
  diffGenerated,
  formatMarkdown,
  resolveComponentsDir
} = require('../../../tools/connect-docs/diff-generated')

const BIN = path.join(__dirname, '..', '..', '..', 'bin', 'doc-tools.js')
const ROOT = 'https://docs.redpanda.com/connect/'

function tree (files, { layout = 'modules' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdd-'))
  const prefix = layout === 'docs' ? 'modules/components' : layout === 'modules' ? 'components' : ''
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, prefix, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, text)
  }
  return dir
}

describe('connect-docs-diff: pagesFor', () => {
  test.each([
    ['partials/fields/inputs/kafka.adoc', 'components/inputs/kafka/'],
    ['partials/descriptions/processors/http.adoc', 'components/processors/http/'],
    ['partials/metadata/outputs/aws_s3.adoc', 'components/outputs/aws_s3/'],
    ['partials/examples/caches/redis.adoc', 'components/caches/redis/'],
    ['partials/availability/tracers/none.adoc', 'components/tracers/none/'],
    // The generator writes rate-limits for some families and rate_limits for
    // others; the page directory is rate_limits.
    ['partials/fields/rate-limits/local.adoc', 'components/rate_limits/local/'],
    ['partials/descriptions/rate_limits/local.adoc', 'components/rate_limits/local/'],
    ['examples/common/inputs/kafka.yaml', 'components/inputs/kafka/'],
    ['examples/advanced/rate-limits/redis.yaml', 'components/rate_limits/redis/'],
    ['partials/fields/config/http.adoc', 'components/http/about/'],
    ['partials/fields/config/templates.adoc', 'configuration/templating/'],
    ['examples/common/config/logger.yaml', 'components/logger/about/'],
    ['partials/bloblang/methods.adoc', 'guides/bloblang/methods/'],
    ['partials/bloblang/functions.adoc', 'guides/bloblang/functions/']
  ])('%s -> %s', (rel, page) => {
    expect(pagesFor(rel).map((p) => p.page)).toEqual([page])
  })

  test('a Bloblang function or method partial maps to its section of the guide', () => {
    expect(pagesFor('partials/bloblang-methods/capitalize.adoc')).toEqual([{ page: 'guides/bloblang/methods/', anchor: 'capitalize' }])
    expect(pagesFor('partials/bloblang-functions/uuid_v4.adoc')).toEqual([{ page: 'guides/bloblang/functions/', anchor: 'uuid_v4' }])
  })

  test('files with no single page map to nothing rather than a guess', () => {
    expect(pagesFor('partials/fields/config/pipeline.adoc')).toEqual([])
    expect(pagesFor('partials/platforms/catalog.json')).toEqual([])
    expect(pagesFor('partials/fields/unknown_type/x.adoc')).toEqual([])
  })
})

describe('connect-docs-diff: unifiedDiff', () => {
  test('produces a standard unified diff with context', () => {
    const a = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n'
    const b = 'one\ntwo\nthree\nFOUR\nfive\nsix\nseven\n'
    expect(unifiedDiff(a, b, { oldName: 'a/x', newName: 'b/x' })).toBe([
      '--- a/x', '+++ b/x', '@@ -1,7 +1,7 @@', ' one', ' two', ' three', '-four', '+FOUR', ' five', ' six', ' seven', ''
    ].join('\n'))
  })

  test('an added file diffs against nothing', () => {
    expect(unifiedDiff('', 'a\nb\n', { oldName: '/dev/null', newName: 'b/x' })).toBe('--- /dev/null\n+++ b/x\n@@ -0,0 +1,2 @@\n+a\n+b\n')
  })

  test('identical text gives no diff', () => {
    expect(unifiedDiff('same\n', 'same\n')).toBe('')
  })

  test('distant changes become separate hunks', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`)
    const changed = lines.slice()
    changed[2] = 'X'
    changed[25] = 'Y'
    const out = unifiedDiff(lines.join('\n') + '\n', changed.join('\n') + '\n')
    expect(out.match(/^@@/gm)).toHaveLength(2)
    expect(out).toMatch(/@@ -1,6 \+1,6 @@/)
    expect(out).toMatch(/@@ -23,7 \+23,7 @@/)
  })
})

describe('connect-docs-diff: diffGenerated', () => {
  const base = {
    'partials/fields/inputs/kafka.adoc': '= Fields\n\n=== `addresses`\n\nOld description.\n',
    'partials/fields/outputs/legacy.adoc': '= Fields\n',
    'partials/bloblang-methods/capitalize.adoc': '= capitalize\n\nConverts a string to title case.\n',
    'examples/common/inputs/kafka.yaml': 'input:\n  kafka: {}\n',
    'partials/platforms/catalog.json': '{"a":1}\n'
  }
  const head = {
    'partials/fields/inputs/kafka.adoc': '= Fields\n\n=== `addresses`\n\nNew description.\n',
    'partials/bloblang-methods/capitalize.adoc': '= capitalize\n\nConverts the first letter of each word to uppercase.\n',
    'examples/common/inputs/kafka.yaml': 'input:\n  kafka: {}\n',
    'partials/fields/processors/new_thing.adoc': '= Fields\n',
    'partials/platforms/catalog.json': '{"a":2}\n'
  }

  test('changed, added, and removed files map to the right published URLs', () => {
    const result = diffGenerated({ baseDir: tree(base), headDir: tree(head) })
    expect(result.summary).toEqual({ files: 5, added: 1, removed: 1, changed: 3, pages: 4, unmapped: 1 })
    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]))
    expect(byPath['modules/components/partials/fields/inputs/kafka.adoc']).toMatchObject({ status: 'changed', pages: [expect.objectContaining({ url: `${ROOT}components/inputs/kafka/` })] })
    expect(byPath['modules/components/partials/fields/processors/new_thing.adoc']).toMatchObject({ status: 'added', pages: [expect.objectContaining({ url: `${ROOT}components/processors/new_thing/` })] })
    expect(byPath['modules/components/partials/fields/outputs/legacy.adoc']).toMatchObject({ status: 'removed', pages: [expect.objectContaining({ url: `${ROOT}components/outputs/legacy/` })] })
    expect(byPath['modules/components/partials/bloblang-methods/capitalize.adoc'].pages[0].url).toBe(`${ROOT}guides/bloblang/methods/#capitalize`)
    // Unchanged files are not listed.
    expect(byPath['modules/components/examples/common/inputs/kafka.yaml']).toBeUndefined()
    expect(result.unmapped).toEqual(['modules/components/partials/platforms/catalog.json'])
    expect(result.pages.map((p) => p.sitePath)).toEqual([
      'connect/components/inputs/kafka/index.html',
      'connect/components/outputs/legacy/index.html',
      'connect/components/processors/new_thing/index.html',
      'connect/guides/bloblang/methods/index.html'
    ])
  })

  test('accepts a docs dir, a modules dir, or a components dir as the tree root', () => {
    const files = { 'partials/fields/inputs/kafka.adoc': 'x\n' }
    for (const layout of ['docs', 'modules', 'components']) {
      const dir = tree(files, { layout })
      expect(fs.existsSync(path.join(resolveComponentsDir(dir), 'partials'))).toBe(true)
    }
    expect(() => resolveComponentsDir(fs.mkdtempSync(path.join(os.tmpdir(), 'cdd-empty-')))).toThrow(/not a generated docs tree/)
  })

  test('Markdown lists the changed pages with links and the diffs in collapsible blocks', () => {
    const md = formatMarkdown(diffGenerated({ baseDir: tree(base), headDir: tree(head) }))
    expect(md).toMatch(/5 generated files differ from the merge base \(3 changed, 1 added, 1 removed\), on 4 published pages/)
    expect(md).toContain(`| [/connect/components/inputs/kafka/](${ROOT}components/inputs/kafka/) | partials/fields/inputs/kafka.adoc (changed) |`)
    expect(md).toContain(`[partials/bloblang-methods/capitalize.adoc](${ROOT}guides/bloblang/methods/#capitalize) (changed)`)
    expect(md).toContain('<summary>modules/components/partials/fields/inputs/kafka.adoc (changed)</summary>')
    expect(md).toContain('-Old description.\n+New description.')
    expect(md).toContain('--- /dev/null')
    expect(md).toMatch(/no single page/)
  })

  test('a diff that contains a code fence gets a longer fence, so it cannot close the block early', () => {
    const md = formatMarkdown(diffGenerated({
      baseDir: tree({ 'partials/descriptions/inputs/x.adoc': 'old\n' }),
      headDir: tree({ 'partials/descriptions/inputs/x.adoc': '```yaml\nnew\n```\n' })
    }))
    expect(md).toMatch(/^````diff$/m)
    expect(md).toMatch(/^````$/m)
  })

  test('the Markdown is capped, with a note saying how many diffs were left out', () => {
    const big = {}
    const big2 = {}
    for (let i = 0; i < 40; i++) {
      big[`partials/fields/inputs/i${i}.adoc`] = 'a\n'.repeat(200)
      big2[`partials/fields/inputs/i${i}.adoc`] = 'b\n'.repeat(200)
    }
    const md = formatMarkdown(diffGenerated({ baseDir: tree(big), headDir: tree(big2) }), { maxBytes: 10000 })
    expect(Buffer.byteLength(md)).toBeLessThan(12000)
    expect(md).toMatch(/_\d+ more diffs are not shown: the summary is capped at 10000 bytes\._/)
  })

  test('no changes says so', () => {
    const md = formatMarkdown(diffGenerated({ baseDir: tree(base), headDir: tree(base) }))
    expect(md).toMatch(/does not change the generated reference docs/)
  })

  test('CLI prints JSON with page URLs and exits 0; a missing tree exits 2', () => {
    const r = spawnSync('node', [BIN, 'connect-docs-diff', tree(base), tree(head), '--format', 'json'], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    const json = JSON.parse(r.stdout)
    expect(json.summary.files).toBe(5)
    expect(json.files.find((f) => f.status === 'added').pages).toEqual([`${ROOT}components/processors/new_thing/`])
    const missing = spawnSync('node', [BIN, 'connect-docs-diff', '/no/such/base', tree(head)], { encoding: 'utf8' })
    expect(missing.status).toBe(2)
  })
})
