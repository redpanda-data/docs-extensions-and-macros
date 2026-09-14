'use strict'

// Provenance for the download toolbox: every snippet on a solution page that
// came from an `include::example$...` must say which file, and which region of
// it, the reader is looking at.
//
// These tests render through Antora's own AsciiDoc loader, so they exercise the
// real contract this depends on: Antora's include processor pushes the resolved
// file onto the reader carrying its source record and a parent cursor, and
// block source locations exist only when `sourcemap` is set.

const extension = require('../../asciidoc-extensions/add-solution-file-provenance')
const { tagFromDirective } = extension

// @antora/asciidoc-loader is a transitive dependency (via @antora/site-generator),
// so it may not be hoisted. Resolve it the way the repo's other loader-backed
// tests do.
let loadAsciiDoc = null
try {
  loadAsciiDoc = require('@antora/asciidoc-loader')
} catch (_) {
  try {
    const { createRequire } = require('module')
    loadAsciiDoc = createRequire(require.resolve('@antora/site-generator'))('@antora/asciidoc-loader')
  } catch (_) { /* render tests are skipped */ }
}
const renderTest = loadAsciiDoc ? test : test.skip

const GO = `package main

// tag::handler[]
func handler() {}
// end::handler[]

func main() {}
`
const MAKEFILE = `# tag::topics[]
topics:
	rpk topic create player-events
# end::topics[]
`

function exampleFile (relative, contents) {
  return {
    src: {
      component: 'solutions',
      version: '',
      module: 'multiplayer-gaming',
      family: 'example',
      relative,
      basename: relative.split('/').pop(),
      path: `docs/modules/multiplayer-gaming/examples/${relative}`,
    },
    contents: Buffer.from(contents),
  }
}

const EXAMPLES = new Map([
  ['services/leaderboard/main.go', exampleFile('services/leaderboard/main.go', GO)],
  ['Makefile', exampleFile('Makefile', MAKEFILE)],
])

const contentCatalog = {
  resolveResource: (target) => {
    const found = String(target).match(/example\$(.+)$/)
    return found ? EXAMPLES.get(found[1]) : undefined
  },
  getById: () => undefined,
  getByPath: () => undefined,
  getComponent: () => undefined,
}

function makePage (body, { component = 'solutions' } = {}) {
  const path = `docs/modules/multiplayer-gaming/pages/build-leaderboard.adoc`
  return {
    src: { component, version: '', module: 'multiplayer-gaming', family: 'page', relative: 'build-leaderboard.adoc', path },
    contents: Buffer.from(`= Build the leaderboard\n\n${body}`),
    path,
  }
}

function render (body, { component = 'solutions', sourcemap = true } = {}) {
  const page = makePage(body, { component })
  return loadAsciiDoc(page, contentCatalog, { extensions: [extension], sourcemap }).convert()
}

/** The listing blocks of a rendered page, as {classes, file, tag}. */
function listings (html) {
  return [...html.matchAll(/<div class="([^"]*listingblock[^"]*)"([^>]*)>/g)].map(([, classes, attrs]) => ({
    classes,
    file: (attrs.match(/data-solution-file="([^"]*)"/) || [])[1],
    tag: (attrs.match(/data-solution-tag="([^"]*)"/) || [])[1],
  }))
}

const EXCERPT = '[,go]\n----\ninclude::example$services/leaderboard/main.go[tags=handler]\n----\n'
const WHOLE_FILE = '[,go]\n----\ninclude::example$services/leaderboard/main.go[]\n----\n'
const HAND_WRITTEN = '[,bash]\n----\nrpk topic create player-events\n----\n'

describe('solution snippet provenance', () => {
  renderTest('an excerpt carries the file and the tag it selected', () => {
    const [block] = listings(render(EXCERPT))
    expect(block.file).toBe('services/leaderboard/main.go')
    expect(block.tag).toBe('handler')
    expect(block.classes).toContain('sol-snippet')
  })

  renderTest('a whole-file include carries the file and no tag', () => {
    const [block] = listings(render(WHOLE_FILE))
    expect(block.file).toBe('services/leaderboard/main.go')
    expect(block.tag).toBeUndefined()
  })

  renderTest('the singular tag= spelling works too', () => {
    const [block] = listings(render('[,make]\n----\ninclude::example$Makefile[tag=topics]\n----\n'))
    expect(block).toMatchObject({ file: 'Makefile', tag: 'topics' })
  })

  renderTest('a listing that is not an include carries nothing', () => {
    const [block] = listings(render(HAND_WRITTEN))
    expect(block.file).toBeUndefined()
    expect(block.tag).toBeUndefined()
    expect(block.classes).not.toContain('sol-snippet')
  })

  renderTest('a page outside the solutions component carries nothing', () => {
    const html = render(EXCERPT, { component: 'streaming' })
    expect(html).not.toContain('data-solution-file')
    expect(html).not.toContain('sol-snippet')
  })

  renderTest('nothing is emitted without sourcemap, which is why the extension turns it on', () => {
    const html = render(EXCERPT, { sourcemap: false })
    expect(html).not.toContain('data-solution-file')
  })

  renderTest('a selection of several regions names the file but no single tag', () => {
    const [block] = listings(render('[,go]\n----\ninclude::example$services/leaderboard/main.go[tags=handler;main]\n----\n'))
    expect(block.file).toBe('services/leaderboard/main.go')
    expect(block.tag).toBeUndefined()
  })

  renderTest('every snippet on a mixed page is stamped independently, and no marker leaks', () => {
    const html = render(`${EXCERPT}\n${HAND_WRITTEN}\n${WHOLE_FILE}\n[,make]\n----\ninclude::example$Makefile[tag=topics]\n----\n`)
    expect(listings(html).map((b) => [b.file, b.tag])).toEqual([
      ['services/leaderboard/main.go', 'handler'],
      [undefined, undefined],
      ['services/leaderboard/main.go', undefined],
      ['Makefile', 'topics'],
    ])
    expect(html).not.toMatch(/sol-snippet-\d/)
  })

  renderTest('an existing role on the block survives', () => {
    const html = render('[.wide,go]\n----\ninclude::example$services/leaderboard/main.go[]\n----\n')
    const [block] = listings(html)
    expect(block.classes).toContain('wide')
    expect(block.classes).toContain('sol-snippet')
    expect(block.file).toBe('services/leaderboard/main.go')
  })
})

describe('solution snippet provenance: tag parsing', () => {
  test.each([
    ['include::example$a.go[tags=handler]', 'handler'],
    ['include::example$a.go[tag=topics]', 'topics'],
    ['  include::example$a.go[tags=x,indent=0]', 'x'],
    ['include::example$a.go[indent=0,tags=x]', 'x'],
    ['include::example$a.go[tags="quoted"]', 'quoted'],
    ['include::example$a.go[]', ''],
    ['include::example$a.go[lines=1..4]', ''],
    ['include::example$a.go[tags=a;b]', ''],
    ['include::example$a.go[tags=!secret]', ''],
    ['include::example$a.go[tags=*]', ''],
    ['rpk topic create x', ''],
    ['', ''],
  ])('%s -> %s', (line, expected) => {
    expect(tagFromDirective(line)).toBe(expected)
  })
})

// The seam between the two halves of the feature: what the tree processor
// stamps into the HTML is exactly what the catalog turns into the download
// allowlist. Authored includes in, allowlist out.
describe('solution snippet provenance: feeds the download allowlist', () => {
  const { collectSnippetFiles } = require('../../extensions/solutions-catalog/collect')

  renderTest('the allowlist is the set of files the page actually includes', () => {
    const body = [
      EXCERPT,
      HAND_WRITTEN,
      WHOLE_FILE,
      '[,make]\n----\ninclude::example$Makefile[tag=topics]\n----\n',
    ].join('\n')
    const html = render(body)
    const page = { contents: Buffer.from(html) }

    expect(collectSnippetFiles([page])).toEqual(['Makefile', 'services/leaderboard/main.go'])
    // The hand-written block contributes nothing, and main.go is listed once
    // even though two blocks render it.
    expect(collectSnippetFiles([page])).toHaveLength(2)
  })

  renderTest('a page with only hand-written listings contributes nothing', () => {
    expect(collectSnippetFiles([{ contents: Buffer.from(render(HAND_WRITTEN)) }])).toEqual([])
  })
})
