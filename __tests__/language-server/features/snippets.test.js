'use strict'

/**
 * Snippets: every snippet renders exactly the text of the file it comes from
 * (golden checks against the source, so a template change needs no edit in
 * the server), and none is offered outside its context.
 *
 * The standards and solutions fixtures stand in for two private repositories.
 * Set DOCS_LS_REAL_STANDARDS to a docs-team-standards checkout and
 * DOCS_LS_REAL_SOLUTIONS to a redpanda-solutions checkout to run the golden
 * checks against the real files too.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const snippets = require('../../../language-server/features/snippets')
const { createDispatcher } = require('../../../language-server/dispatch')
const { loadWorkspace } = require('../../../language-server/workspace')
const { buildWorkspace, noFetch, write } = require('../fixture')

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'snippets')
const STANDARDS = path.join(FIXTURES, 'standards')
const SOLUTIONS = path.join(FIXTURES, 'solutions')
const PROPERTY_GUIDE = path.join(__dirname, '..', '..', '..', 'macros', 'PROPERTY_AND_ENTERPRISE_REFERENCES.adoc')
const { renderSnippet, templateSnippet, contextAt } = snippets

const SNIPPET = 15

function copyTree (from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(path.join(from, e.name), path.join(to, e.name))
    else fs.copyFileSync(path.join(from, e.name), path.join(to, e.name))
  }
}

// Parts only these tests need, passed as builders (see fixture.js).
const parts = {
  repo (root) { fs.mkdirSync(path.join(root, '.git'), { recursive: true }) },
  solutionTemplates (root, from) { copyTree(path.join(from === true ? SOLUTIONS : from, 'templates'), path.join(root, 'templates')) },
  docDetective (root, config) { write(root, path.join('setup-tests', '.doc-detective.json'), config) },
}

const load = (root, settings = { standardsPath: STANDARDS }) =>
  loadWorkspace(root, { env: {}, fetch: noFetch, modules: [snippets], settings })

const features = createDispatcher()
const docAt = (root, relative, text) => ({ uri: pathToFileURL(path.join(root, relative)).href, languageId: 'asciidoc', version: 1, text })
const complete = (ws, relative, text, position) =>
  features.completion(docAt(ws.root, relative, text), position, ws).filter((i) => i.kind === SNIPPET)
const labels = (items) => items.map((i) => i.label)
const rendered = (item) => renderSnippet(item.textEdit.newText)
const endOf = (text) => { const lines = text.split('\n'); return { line: lines.length - 1, character: lines[lines.length - 1].length } }

const BODY = ['= A page', ':description: Something.', '', 'Some text.', '', ''].join('\n')
const BODY_END = { line: 5, character: 0 }

describe('renderSnippet and templateSnippet', () => {
  test('placeholders, choices and escapes render to their defaults', () => {
    expect(renderSnippet('a ${1:one} $2 ${3} ${4|x,y|} \\$5 \\} \\\\ $0')).toBe('a one   x $5 } \\ ')
    expect(renderSnippet('${1:outer ${2:inner}}')).toBe('outer inner')
  })

  test('a template renders back to itself, with each [Placeholder] a tab stop', () => {
    const text = '= [Verb] [Specific Task]\n[NOTE]\n====\nSee xref:a.adoc[Some Page] and {attr}, $5.\n====\n* [ ] {x}\n[source,bash]\ninclude::x$y.sh[tag=run]\n'
    const snippet = templateSnippet(text)
    expect(renderSnippet(snippet)).toBe(text)
    expect(snippet).toContain('${1:[Verb]} ${2:[Specific Task]}')
    // Negative controls: block styles, macro attribute lists and checkboxes stay text.
    expect(snippet).not.toMatch(/\$\{\d+:\[NOTE\]\}/)
    expect(snippet).not.toMatch(/\$\{\d+:\[Some Page\]\}/)
    expect(snippet).not.toMatch(/\$\{\d+:\[source/)
    expect(snippet.match(/\$\{\d+:/g)).toHaveLength(2)
  })
})

describe('contextAt', () => {
  test('page, header, body, and nothing mid-line or inside blocks', () => {
    expect(contextAt('', { line: 0, character: 0 }).kind).toBe('page')
    expect(contextAt('= A\n\n', { line: 1, character: 0 }).kind).toBe('body')
    // A new line inside the header, above an attribute entry, is still the header.
    expect(contextAt('= A\n:a: 1\n\n:b: 2\n\nBody.\n', { line: 2, character: 0 }).kind).toBe('header')
    // Typing on the blank line that ends the header is the body.
    expect(contextAt('= A\n:a: 1\nNOTE\nBody.\n', { line: 2, character: 4 }).kind).toBe('body')
    expect(contextAt(BODY, BODY_END).kind).toBe('body')
    expect(contextAt(BODY, { line: 3, character: 4 })).toBeNull()
    const listing = '= A\n\n----\n\n----\n'
    expect(contextAt(listing, { line: 3, character: 0 })).toBeNull()
    const comment = '= A\n\n////\n\n////\n'
    expect(contextAt(comment, { line: 3, character: 0 })).toBeNull()
  })
})

describe('snippets from docs-team-standards', () => {
  let ws
  beforeAll(async () => {
    ws = await load(buildWorkspace({ pages: { 'modules/ROOT/pages/a.adoc': BODY } }))
  })

  test('each page template renders exactly its file, only on a page with no title', () => {
    const items = complete(ws, 'modules/ROOT/pages/new.adoc', '', { line: 0, character: 0 })
    expect(labels(items).sort()).toEqual(['page: concepts', 'page: how-to'])
    for (const name of ['how-to', 'concepts']) {
      const item = items.find((i) => i.label === `page: ${name}`)
      expect(item.insertTextFormat).toBe(2)
      expect(rendered(item)).toBe(fs.readFileSync(path.join(STANDARDS, 'resources', 'templates', `${name}-template.adoc`), 'utf8'))
    }
    // Negative control: no page template once the page has a title.
    expect(labels(complete(ws, 'modules/ROOT/pages/a.adoc', BODY, BODY_END)).filter((l) => l.startsWith('page:'))).toEqual([])
  })

  test('tabs render the first example under Tab syntax', () => {
    const item = complete(ws, 'modules/ROOT/pages/a.adoc', BODY, BODY_END).find((i) => i.label === 'tabs')
    const source = fs.readFileSync(path.join(STANDARDS, 'resources', 'antora', 'context-switchers-tabs.md'), 'utf8')
    const text = rendered(item)
    expect(text).toContain('Tab A::')
    expect(source).toContain('## Tab syntax\n\nTabs use the `asciidoctor-tabs` extension:\n\n```asciidoc\n' + text + '\n```')
    expect(item.textEdit.newText).toContain('${1:Tab A}::')
  })

  test('admonitions are the rows of the style guide table, nothing else', () => {
    const items = complete(ws, 'modules/ROOT/pages/a.adoc', BODY, BODY_END)
    const admonitions = items.filter((i) => /^[A-Z]+( block)?$/.test(i.label))
    expect(labels(admonitions)).toEqual(['NOTE', 'NOTE block', 'TIP', 'TIP block', 'CAUTION', 'CAUTION block'])
    // WARNING sits in another section's table, so it is not offered.
    expect(labels(items)).not.toContain('WARNING')
    expect(admonitions.find((i) => i.label === 'TIP').detail).toBe('A way to make things easier or indicates a best practice')
    expect(admonitions.find((i) => i.label === 'NOTE').textEdit.newText).toBe('NOTE: $0')
    expect(rendered(admonitions.find((i) => i.label === 'CAUTION block'))).toBe('[CAUTION]\n====\n\n====')
  })

  test('// Source: renders the example line, with the ref and the quote as tab stops', () => {
    const item = complete(ws, 'modules/ROOT/pages/a.adoc', BODY, BODY_END).find((i) => i.label === '// Source:')
    expect(rendered(item)).toBe('// Source: redpanda-data/console@v3.2.0:frontend/src/config.ts:40-52 "enabled: true"')
    expect(item.textEdit.newText).toBe('// Source: ${1:redpanda-data/console@v3.2.0:frontend/src/config.ts:40-52} "${2:enabled: true}"')
  })

  test('after // only comment snippets are offered, and the typed prefix is replaced', () => {
    const text = BODY + '//'
    const items = complete(ws, 'modules/ROOT/pages/a.adoc', text, { line: 5, character: 2 })
    expect(labels(items)).toEqual(['// Source:'])
    expect(items[0].textEdit.range).toEqual({ start: { line: 5, character: 0 }, end: { line: 5, character: 2 } })
  })

  test('nothing in the header, mid-line, inside a listing, or after prop:', () => {
    const header = '= A page\n:description: Something.\n\n:page-topic-type: how-to\n\nBody.\n'
    expect(contextAt(header, { line: 2, character: 0 }).kind).toBe('header')
    expect(complete(ws, 'modules/ROOT/pages/a.adoc', header, { line: 2, character: 0 })).toEqual([])
    expect(complete(ws, 'modules/ROOT/pages/a.adoc', BODY, { line: 3, character: 4 })).toEqual([])
    const listing = BODY + '----\n\n----\n'
    expect(complete(ws, 'modules/ROOT/pages/a.adoc', listing, { line: 6, character: 0 })).toEqual([])
    const prop = BODY + 'Set prop:'
    expect(complete(ws, 'modules/ROOT/pages/a.adoc', prop, endOf(prop))).toEqual([])
  })

  test('a template change changes the snippet with no edit to the server', async () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-ls-standards-'))
    copyTree(STANDARDS, copy)
    const file = path.join(copy, 'resources', 'antora', 'context-switchers-tabs.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Tab B::', 'Kubernetes::'))
    const changed = await load(buildWorkspace({}), { standardsPath: copy })
    const item = complete(changed, 'modules/ROOT/pages/a.adoc', BODY, BODY_END).find((i) => i.label === 'tabs')
    expect(rendered(item)).toContain('Kubernetes::')
    expect(rendered(item)).not.toContain('Tab B::')
  })
})

describe('without docs-team-standards', () => {
  test('its snippets are off with a note; the package\'s own snippets stay', async () => {
    const ws = await load(buildWorkspace({}), {})
    const items = complete(ws, 'modules/ROOT/pages/a.adoc', BODY, BODY_END)
    if (fs.existsSync(snippets.VENDORED_STANDARDS)) {
      expect(labels(items)).toContain('tabs')
      return
    }
    expect(ws.notes.join('\n')).toMatch(/snippets from docs-team-standards are off: set redpandaDocs.standardsPath/)
    expect(labels(items)).toEqual(['prop: reference', 'propval: sentence'])
    expect(complete(ws, 'modules/ROOT/pages/new.adoc', '', { line: 0, character: 0 })).toEqual([])
  })

  test('a standardsPath that is not a checkout says so', async () => {
    const ws = await load(buildWorkspace({}), { standardsPath: os.tmpdir() })
    expect(ws.notes.join('\n')).toMatch(/redpandaDocs.standardsPath \(.*\) has no resources\/templates/)
  })
})

describe('prop: and propval: snippets', () => {
  test('render the design page examples, each name a mirrored tab stop', async () => {
    const ws = await load(buildWorkspace({}), {})
    const items = complete(ws, 'modules/ROOT/pages/a.adoc', BODY, BODY_END)
    const guide = fs.readFileSync(PROPERTY_GUIDE, 'utf8')
    const prop = items.find((i) => i.label === 'prop: reference')
    const propval = items.find((i) => i.label === 'propval: sentence')
    for (const item of [prop, propval]) expect(guide).toContain('[,asciidoc]\n----\n' + rendered(item) + '\n----')
    expect(prop.textEdit.newText).toBe('prop:${1:cloud_storage_enabled}[]')
    expect(propval.textEdit.newText).toMatch(/^Set prop:\$\{1:(\w+)\}\[\], which defaults to propval:\$\{1:\1\}\[\$\{2:default\}\]\.$/)
  })
})

describe('solution snippets', () => {
  const STEP = ['= Create the topics', ':page-layout: solution-step', '', 'Intro.', '', '== In production', '', ''].join('\n')
  const STEP_END = { line: 7, character: 0 }
  let ws
  beforeAll(async () => {
    const root = buildWorkspace({
      repo: true,
      solutionTemplates: true,
      pages: {
        'modules/demo/pages/index.adoc': '= Demo\n:page-layout: solution\n:page-solution-steps: create-topics, verify-end-to-end\n',
        'modules/demo/pages/create-topics.adoc': STEP,
        'modules/demo/partials/production/_all.adoc': '[#prod-security]\n=== Security\n\ninclude::partial$production/security.adoc[tag=detail]\n\n[#prod-iceberg-commit-timing]\n=== Iceberg commit timing\n',
        'modules/demo/partials/production/security.adoc': '// tag::summary[]\nUse TLS.\n// end::summary[]\n',
        'modules/demo/partials/production/iceberg-commit-timing.adoc': '// tag::summary[]\nCommit less often.\n// end::summary[]\n',
      },
    }, { parts })
    ws = await load(root)
  })

  test('the step skeleton renders exactly the step template, only on a new page', () => {
    const items = complete(ws, 'modules/demo/pages/new-step.adoc', '', { line: 0, character: 0 })
    expect(labels(items)).toEqual(['page: solution step'])
    const template = path.join(SOLUTIONS, 'templates', 'solution', 'docs-module', 'pages', 'step.adoc')
    expect(rendered(items[0])).toBe(fs.readFileSync(template, 'utf8'))
    // Negative controls: not on the overview page, and the topic-type templates are not offered here.
    expect(complete(ws, 'modules/demo/pages/index.adoc', '', { line: 0, character: 0 })).toEqual([])
  })

  test('the template\'s own production note renders exactly its [.production-note] block', () => {
    const items = complete(ws, 'templates/solution/docs-module/pages/step.adoc', STEP, STEP_END).filter((i) => i.label.startsWith('production note'))
    const template = fs.readFileSync(path.join(SOLUTIONS, 'templates', 'solution', 'docs-module', 'pages', 'step.adoc'), 'utf8')
    const block = /\[\.production-note\]\n[\s\S]*?\n--\n[\s\S]*?\n--/.exec(template)[0]
    expect(labels(items)).toEqual(['production note: brokers-and-replication'])
    expect(rendered(items[0])).toBe(block + '\n')
  })

  test('a step page gets one note per topic in its module, linked to its last step', () => {
    const items = complete(ws, 'modules/demo/pages/create-topics.adoc', STEP, STEP_END).filter((i) => i.label.startsWith('production note'))
    expect(labels(items)).toEqual(['production note: iceberg-commit-timing', 'production note: security'])
    expect(rendered(items[1])).toBe([
      '[.production-note]',
      '.In production',
      '--',
      'include::partial$production/security.adoc[tag=summary]',
      'For the full picture, see xref:verify-end-to-end.adoc#prod-security[Production considerations: security].',
      '--',
      '',
    ].join('\n'))
    // The title is a tab stop, because a proper noun cannot be told from the files.
    expect(items[0].textEdit.newText).toContain('[Production considerations: ${1:iceberg commit timing}]')
  })

  test('no production note on a page that is not a solution step', () => {
    const overview = '= Demo\n:page-layout: solution\n\n'
    expect(complete(ws, 'modules/demo/pages/index.adoc', overview, { line: 2, character: 0 }).filter((i) => i.label.startsWith('production note'))).toEqual([])
    expect(complete(ws, 'modules/demo/pages/other.adoc', BODY, BODY_END).filter((i) => i.label.startsWith('production note'))).toEqual([])
  })

  test('outside the solutions repository there is no step skeleton or note', async () => {
    const docs = await load(buildWorkspace({ repo: true }, { parts }))
    expect(labels(complete(docs, 'modules/ROOT/pages/new.adoc', '', { line: 0, character: 0 }))).not.toContain('page: solution step')
    expect(complete(docs, 'modules/ROOT/pages/s.adoc', STEP, STEP_END).filter((i) => i.label.startsWith('production note'))).toEqual([])
  })
})

describe('Doc Detective inline test', () => {
  const V2 = { fileTypes: [{ name: 'AsciiDoc', extensions: ['.adoc'], testStartStatementOpen: '// (test start', testStartStatementClose: ')', testEndStatement: '// (test end)', stepStatementOpen: '// (step', stepStatementClose: ')' }] }
  const V3 = { fileTypes: [{ name: 'AsciiDoc', extensions: ['adoc'], inlineStatements: { testStart: ['// \\(test start(.*?)\\)'], testEnd: ['// \\(test end\\)'], step: ['// \\(step(.*?)\\)'] } }] }
  const inline = async (config) => {
    const ws = await load(buildWorkspace(config ? { repo: true, docDetective: config } : { repo: true }, { parts }), {})
    return complete(ws, 'modules/ROOT/pages/a.adoc', BODY, BODY_END).find((i) => i.label === 'Doc Detective inline test')
  }

  test('a v2 config\'s statements make the block', async () => {
    expect(rendered(await inline(V2))).toBe('// (test start {"id": "test-id", "description": "What this test proves"})\n// (step {})\n\n// (test end)')
  })

  test('a v3 config\'s patterns are turned back into text', async () => {
    expect(rendered(await inline(V3))).toBe('// (test start {"testId": "test-id", "description": "What this test proves"})\n// (step {})\n\n// (test end)')
  })

  test('a changed statement changes the block', async () => {
    const changed = JSON.parse(JSON.stringify(V2))
    changed.fileTypes[0].testEndStatement = '// (end of test)'
    expect(rendered(await inline(changed))).toMatch(/\n\/\/ \(end of test\)$/)
  })

  test('not offered without a config, or when the config has no literal AsciiDoc statements', async () => {
    expect(await inline(null)).toBeUndefined()
    expect(await inline({ fileTypes: [{ ...V2.fileTypes[0], extensions: ['.md'] }] })).toBeUndefined()
    expect(await inline({ fileTypes: [{ ...V3.fileTypes[0], inlineStatements: { testStart: ['^\\s*<!-- test (\\w+)'], testEnd: ['x'], step: ['y(.*)'] } }] })).toBeUndefined()
  })
})

const REAL_STANDARDS = process.env.DOCS_LS_REAL_STANDARDS
const REAL_SOLUTIONS = process.env.DOCS_LS_REAL_SOLUTIONS

;(REAL_STANDARDS ? describe : describe.skip)('real docs-team-standards checkout', () => {
  test('every snippet renders text that is in its source file', async () => {
    const ws = await load(buildWorkspace({}), { standardsPath: REAL_STANDARDS })
    const page = complete(ws, 'modules/ROOT/pages/new.adoc', '', { line: 0, character: 0 })
    const templates = fs.readdirSync(path.join(REAL_STANDARDS, 'resources', 'templates')).filter((f) => f.endsWith('-template.adoc'))
    expect(page).toHaveLength(templates.length)
    for (const f of templates) {
      const item = page.find((i) => i.label === `page: ${f.replace(/-template\.adoc$/, '')}`)
      expect(rendered(item)).toBe(fs.readFileSync(path.join(REAL_STANDARDS, 'resources', 'templates', f), 'utf8'))
    }
    const body = complete(ws, 'modules/ROOT/pages/a.adoc', BODY, BODY_END)
    const tabs = fs.readFileSync(path.join(REAL_STANDARDS, snippets.STANDARDS_FILES.tabs), 'utf8')
    expect(tabs).toContain('```asciidoc\n' + rendered(body.find((i) => i.label === 'tabs')) + '\n```')
    const fresh = fs.readFileSync(path.join(REAL_STANDARDS, snippets.STANDARDS_FILES.freshSources), 'utf8')
    expect(fresh.split('\n')).toContain(rendered(body.find((i) => i.label === '// Source:')))
    const guide = fs.readFileSync(path.join(REAL_STANDARDS, snippets.STANDARDS_FILES.styleGuide), 'utf8')
    const admonitions = body.filter((i) => /^[A-Z]+$/.test(i.label))
    expect(admonitions.length).toBeGreaterThan(0)
    for (const a of admonitions) expect(guide).toContain(`| ${a.label} | ${a.detail} |`)
  })
})

;(REAL_SOLUTIONS ? describe : describe.skip)('real redpanda-solutions checkout', () => {
  test('the step skeleton is the template, and each single-topic note on a real step page is the snippet for its topic', async () => {
    const ws = await load(path.join(REAL_SOLUTIONS, 'docs'), {})
    const template = path.join(REAL_SOLUTIONS, 'templates', 'solution', 'docs-module', 'pages', 'step.adoc')
    const [skeleton] = complete(ws, 'modules/x/pages/new.adoc', '', { line: 0, character: 0 })
    expect(rendered(skeleton)).toBe(fs.readFileSync(template, 'utf8'))
    const modules = path.join(REAL_SOLUTIONS, 'docs', 'modules')
    let checked = 0
    for (const mod of fs.readdirSync(modules)) {
      const pages = path.join(modules, mod, 'pages')
      if (!fs.existsSync(pages)) continue
      for (const f of fs.readdirSync(pages).filter((p) => p.endsWith('.adoc'))) {
        const text = fs.readFileSync(path.join(pages, f), 'utf8')
        const blocks = [...text.matchAll(/^\[\.production-note\]\n\.In production\n--\n(include::[^\n]+\n)(For the full picture[^\n]+\n)--$/gm)]
        if (!blocks.length) continue
        const items = complete(ws, `modules/${mod}/pages/${f}`, text, { line: text.split('\n').length - 1, character: 0 })
        for (const b of blocks) {
          const topic = /production\/([^/[\]]+)\.adoc/.exec(b[1])[1]
          const title = /Production considerations: ([^\]]+)\]/.exec(b[2])
          const item = items.find((i) => i.label === `production note: ${topic}`)
          expect(item).toBeDefined()
          // The title is the one tab stop: put the page's own title in it.
          const snippet = title ? item.textEdit.newText.replace(/\$\{1:[^}]*\}/, title[1]) : item.textEdit.newText
          expect(renderSnippet(snippet)).toBe(b[0] + '\n')
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })
})
