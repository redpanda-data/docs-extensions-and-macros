'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { parseTaxonomy } = require('../../extension-utils/taxonomy')
const concepts = require('../../extensions/solutions-catalog/concepts')
const recsIndex = require('../../extensions/solutions-catalog/recs-index')
const { runCli } = require('../../tools/recommendations-diff')

/**
 * doc-tools recommendations-diff scores the changed pages at the merge base
 * and at HEAD with the solutions-catalog scoring, against a published
 * doc-concepts.json. The index here is built with the extension's own
 * builder (recs-index.js) from concepts the extension's own functions derive,
 * so it has the shape a build publishes.
 */

const ROOT = path.join(__dirname, '..', '..')
const TAXONOMY_FILE = path.join(ROOT, '__tests__', 'fixtures', 'taxonomy', 'taxonomy.yml')
const taxonomy = parseTaxonomy(fs.readFileSync(TAXONOMY_FILE))

function solutionRecord (id, { useCases = [], technologies = [], categories = [], platforms = ['self-managed', 'cloud'], relatedDocs = [], title } = {}) {
  const record = { id, categoriesRaw: categories, useCases, technologies, industries: [], platforms, platformsAuthored: true }
  const derived = concepts.solutionConcepts(taxonomy, record)
  return {
    id,
    title: title || `Solution ${id}`,
    url: `/solutions/${id}/`,
    status: 'published',
    featured: false,
    lastModified: '2026-10-01',
    platforms,
    concepts: derived.concepts,
    conceptFacets: derived.facets,
    relatedDocKeys: new Set(relatedDocs),
    relatedDocTwins: new Map(),
  }
}

const docEntry = (key, categories, extra = {}) => ({ key, title: key.split(':').pop(), url: `/${key.replace(/:/g, '/')}`, deployment: '', concepts: concepts.docConcepts(taxonomy, { categories }), ...extra })

const SOLUTIONS = [
  solutionRecord('cdc', { useCases: ['Change data capture'], technologies: ['PostgreSQL'], categories: ['Iceberg Topics'] }),
  solutionRecord('dr', { useCases: ['Disaster recovery'], technologies: ['rpk'], categories: ['Replication'] }),
  solutionRecord('sp', { useCases: ['Stream processing'], technologies: ['Redpanda Connect'], categories: ['Security'] }),
]

const INDEX_DOCS = [
  docEntry('streaming:manage:cdc.adoc', ['Security']),
  docEntry('streaming:manage:dr.adoc', ['Disaster recovery', 'Replication']),
  docEntry('streaming:develop:capture.adoc', ['Change data capture', 'PostgreSQL']),
]

const makeIndex = ({ solutions = SOLUTIONS, docs = INDEX_DOCS } = {}) => JSON.parse(JSON.stringify(recsIndex.buildDocConceptsIndex({
  docs,
  solutions,
  relationships: [],
  settings: { maxRelated: 3, minScore: 0.6 },
  siteUrl: 'https://docs.redpanda.com',
  generatedAt: '2026-10-24T00:00:00.000Z',
})))

function git (cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

/** A repo with `base` files on main and `head` files (null deletes) on a PR branch. */
function makeRepo (base, head) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recs-diff-'))
  const write = (files) => {
    for (const [rel, text] of Object.entries(files)) {
      const abs = path.join(root, rel)
      if (text === null) fs.rmSync(abs, { force: true })
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, text)
      }
    }
  }
  git(root, 'init', '-q', '-b', 'main')
  write(base)
  git(root, 'add', '-A')
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
  git(root, 'checkout', '-qb', 'pr')
  write(head)
  git(root, 'add', '-A')
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'pr')
  return root
}

const page = (title, categories) => `= ${title}\n${categories ? `:page-categories: ${categories}\n` : ''}\nBody.\n`
const overview = (title, { useCases, technologies, categories = 'Security', status = 'published' }) => `= ${title}\n:page-layout: solution\n:page-solution-status: ${status}\n:page-categories: ${categories}\n:page-solution-use-cases: ${useCases}\n:page-solution-technologies: ${technologies}\n:page-solution-platforms: self-managed, cloud\n\nBody.\n`

async function cli (options, deps) {
  const out = []
  const err = []
  const log = jest.spyOn(console, 'log').mockImplementation((m) => out.push(String(m)))
  const error = jest.spyOn(console, 'error').mockImplementation((m) => err.push(String(m)))
  const before = process.exitCode
  try {
    const result = await runCli(options, deps)
    return { result, code: process.exitCode, stdout: out.join('\n'), stderr: err.join('\n') }
  } finally {
    log.mockRestore()
    error.mockRestore()
    process.exitCode = before
  }
}

function writeIndex (index = makeIndex()) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recs-index-')), 'doc-concepts.json')
  fs.writeFileSync(file, JSON.stringify(index))
  return file
}

const DOCS_ANTORA = 'name: streaming\nversion: 26.2\n'

describe('recommendations-diff: Product Docs pages', () => {
  test('a page gains a recommendation when its categories now share a use case and a technology', async () => {
    const root = makeRepo(
      { 'antora.yml': DOCS_ANTORA, 'modules/manage/pages/cdc.adoc': page('CDC', 'Security') },
      { 'modules/manage/pages/cdc.adoc': page('CDC', 'Change data capture, PostgreSQL') },
    )
    const summary = path.join(root, '..', `${path.basename(root)}-summary.md`)
    const { result, code, stdout } = await cli({ changed: 'main', root, index: writeIndex(), taxonomy: TAXONOMY_FILE, summary })
    expect(code).toBe(0)
    expect(result.status).toBe('ok')
    expect(result.changed.docs).toEqual([{ file: 'modules/manage/pages/cdc.adoc', doc: 'streaming:manage:cdc.adoc', inIndex: true }])
    expect(result.docs).toEqual([expect.objectContaining({
      doc: 'streaming:manage:cdc.adoc',
      appear: [expect.objectContaining({ solution: 'cdc', rank: 1, score: 0.6, provenance: 'category', shared: [{ id: 'change-data-capture', label: 'Change data capture' }, { id: 'postgresql', label: 'PostgreSQL' }] })],
      disappear: [],
      rerank: [],
    })])
    expect(result.summary).toEqual({ docs: 1, appear: 1, disappear: 0, rerank: 0 })
    expect(stdout).toMatch(/^ {2}\+ {5}cdc rank 1, score 0\.6 \(category\): Change data capture, PostgreSQL$/m)
    const md = fs.readFileSync(summary, 'utf8')
    expect(md).toMatch(/^### Solution recommendations$/m)
    expect(md).toContain('| `streaming:manage:cdc.adoc` | appears | Solution cdc (`cdc`) | 1 | 0.6 | Change data capture, PostgreSQL |')
  })

  test('a page loses a recommendation, with the reason the build gives', async () => {
    const root = makeRepo(
      { 'antora.yml': DOCS_ANTORA, 'modules/manage/pages/dr.adoc': page('DR', 'Disaster recovery, Replication') },
      { 'modules/manage/pages/dr.adoc': page('DR', 'Disaster recovery') },
    )
    const { result, code } = await cli({ changed: 'main', root, index: writeIndex(), taxonomy: TAXONOMY_FILE })
    expect(code).toBe(0)
    expect(result.docs).toEqual([expect.objectContaining({
      doc: 'streaming:manage:dr.adoc',
      appear: [],
      disappear: [expect.objectContaining({ solution: 'dr', rank: 1, score: 0.6, scoreNow: 0.3, shared: expect.arrayContaining([{ id: 'replication', label: 'Replication' }]), reason: expect.stringMatching(/hidden: score 0\.3 below 0\.6/) })],
    })])
  })

  test('a page whose categories change without moving a recommendation reports nothing', async () => {
    const root = makeRepo(
      { 'antora.yml': DOCS_ANTORA, 'modules/manage/pages/dr.adoc': page('DR', 'Disaster recovery, Replication') },
      { 'modules/manage/pages/dr.adoc': page('DR', 'Disaster recovery, Replication, Security') },
    )
    const summary = path.join(root, '..', `${path.basename(root)}-summary.md`)
    const { result } = await cli({ changed: 'main', root, index: writeIndex(), taxonomy: TAXONOMY_FILE, summary })
    expect(result.docs).toEqual([])
    expect(fs.readFileSync(summary, 'utf8')).toMatch(/No change to the recommendations shown on any page\. Checked 1 changed doc page\(s\) and 0 changed solution\(s\)/)
  })

  test('a new page is scored from its header; an excluded component and partials are skipped', async () => {
    const root = makeRepo(
      { 'antora.yml': DOCS_ANTORA, 'labs/antora.yml': 'name: labs\n' },
      {
        'modules/develop/pages/new.adoc': page('New', 'Stream processing, Redpanda Connect'),
        'modules/develop/partials/p.adoc': 'Change data capture.\n',
        'labs/modules/ROOT/pages/lab.adoc': page('Lab', 'Change data capture, PostgreSQL'),
      },
    )
    const { result } = await cli({ changed: 'main', root, index: writeIndex(), taxonomy: TAXONOMY_FILE })
    expect(result.changed.docs.map((d) => `${d.doc} ${d.inIndex}`)).toEqual(['labs:ROOT:lab.adoc false', 'streaming:develop:new.adoc false'])
    expect(result.docs.map((d) => `${d.doc} +${d.appear.map((a) => a.solution).join(',')}`)).toEqual(['streaming:develop:new.adoc +sp'])
    expect(result.docs[0].title).toBe('New')
  })
})

describe('recommendations-diff: solution overviews (redpanda-solutions)', () => {
  test('a facet change moves the recommendations of every published page it touches', async () => {
    // sp gains Change data capture and PostgreSQL: capture.adoc, which
    // carries both, now also gets sp. It ranks after cdc, which shares the
    // same two concepts and wins the tie on its title.
    const root = makeRepo(
      { 'antora.yml': 'name: solutions\nversion: ~\n', 'modules/sp/pages/index.adoc': overview('Solution sp', { useCases: 'Stream processing', technologies: 'Redpanda Connect' }) },
      { 'modules/sp/pages/index.adoc': overview('Solution sp', { useCases: 'Stream processing, Change data capture', technologies: 'Redpanda Connect, PostgreSQL' }) },
    )
    const { result, code, stdout } = await cli({ changed: 'main', root, index: writeIndex(), taxonomy: TAXONOMY_FILE })
    expect(code).toBe(0)
    expect(result.changed).toEqual({ docs: [], solutions: [{ file: 'modules/sp/pages/index.adoc', solution: 'sp', inIndex: true }] })
    expect(result.docs).toEqual([expect.objectContaining({
      doc: 'streaming:develop:capture.adoc',
      appear: [expect.objectContaining({ solution: 'sp', rank: 2, score: 0.6, shared: [{ id: 'change-data-capture', label: 'Change data capture' }, { id: 'postgresql', label: 'PostgreSQL' }] })],
    })])
    expect(stdout).toMatch(/0 changed doc page\(s\), 1 changed solution\(s\)/)
  })

  test('a solution that drops a use case disappears from the pages that relied on it', async () => {
    const root = makeRepo(
      { 'antora.yml': 'name: solutions\n', 'modules/cdc/pages/index.adoc': overview('Solution cdc', { useCases: 'Change data capture', technologies: 'PostgreSQL', categories: 'Iceberg Topics' }) },
      { 'modules/cdc/pages/index.adoc': overview('Solution cdc', { useCases: 'Data lakehouse', technologies: 'PostgreSQL', categories: 'Iceberg Topics' }) },
    )
    const { result } = await cli({ changed: 'main', root, index: writeIndex(), taxonomy: TAXONOMY_FILE })
    expect(result.docs).toEqual([expect.objectContaining({
      doc: 'streaming:develop:capture.adoc',
      disappear: [expect.objectContaining({ solution: 'cdc', score: 0.6, scoreNow: 0.3 })],
    })])
  })

  test('a new draft that the published build left out moves no recommendations', async () => {
    // Drafts sharing cdc's concepts would lower their rarity if scored.
    const draft = (id) => overview(`Solution ${id}`, { useCases: 'Change data capture', technologies: 'PostgreSQL', status: 'draft' })
    const root = makeRepo(
      { 'antora.yml': 'name: solutions\n' },
      { 'modules/d1/pages/index.adoc': draft('d1'), 'modules/d2/pages/index.adoc': draft('d2'), 'modules/d3/pages/index.adoc': draft('d3') },
    )
    const { result, code } = await cli({ changed: 'main', root, index: writeIndex(), taxonomy: TAXONOMY_FILE })
    expect(code).toBe(0)
    expect(result.changed.solutions).toHaveLength(3)
    expect(result.docs).toEqual([])
  })
})

describe('recommendations-diff: published data that cannot be read', () => {
  const root = () => makeRepo({ 'antora.yml': DOCS_ANTORA, 'modules/a/pages/x.adoc': page('X', 'Security') }, { 'modules/a/pages/x.adoc': page('X', 'Change data capture') })

  test.each([
    ['a network failure', async () => { throw new Error('getaddrinfo ENOTFOUND docs.example') }, /fetching https:\/\/docs\.example\/assets\/data\/doc-concepts\.json failed: getaddrinfo ENOTFOUND/],
    ['a 404', async () => ({ ok: false, status: 404, headers: new Map() }), /failed with HTTP 404/],
    ['a soft 404 HTML page', async () => ({ ok: true, status: 200, headers: new Map([['content-type', 'text/html']]), text: async () => '<html>' }), /is an HTML page, not the published JSON/],
    ['an index of another version', async () => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ ...makeIndex(), version: 99 }) }), /version 99 is not 1/],
  ])('%s is status unavailable, exit 0, and says so in the summary', async (_name, fetch, rx) => {
    const r = root()
    const summary = path.join(r, '..', `${path.basename(r)}-summary.md`)
    const { result, code, stdout } = await cli({ changed: 'main', root: r, origin: 'https://docs.example/', taxonomy: TAXONOMY_FILE, summary, output: path.join(r, '..', `${path.basename(r)}.json`) }, { fetch })
    expect(code).toBe(0)
    expect(result).toMatchObject({ status: 'unavailable', origin: 'https://docs.example', reason: expect.stringMatching(rx) })
    expect(stdout).toMatch(/^recommendations-diff: skipped: /)
    expect(fs.readFileSync(summary, 'utf8')).toMatch(/^Not checked: /m)
    expect(JSON.parse(fs.readFileSync(path.join(r, '..', `${path.basename(r)}.json`), 'utf8')).status).toBe('unavailable')
  })

  test('the index and the taxonomy come from the origin when the checkout has no taxonomy', async () => {
    const r = root()
    const seen = []
    const fetch = async (url) => {
      seen.push(url)
      if (url.endsWith('/assets/data/doc-concepts.json')) return { ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify(makeIndex()) }
      if (url.endsWith('/shared/_attachments/taxonomy.yml')) return { ok: true, status: 200, headers: new Map(), text: async () => fs.readFileSync(TAXONOMY_FILE, 'utf8') }
      return { ok: false, status: 404, headers: new Map() }
    }
    const { result } = await cli({ changed: 'main', root: r, origin: 'https://preview.example' }, { fetch })
    expect(result.status).toBe('ok')
    expect(seen).toEqual(expect.arrayContaining(['https://preview.example/assets/data/doc-concepts.json', 'https://preview.example/shared/_attachments/taxonomy.yml']))
  })

  test('no --changed, or a ref git does not know, is a usage error (exit 2)', async () => {
    expect((await cli({ root: root(), index: writeIndex() })).code).toBe(2)
    const bad = await cli({ changed: 'nope', root: root(), index: writeIndex(), taxonomy: TAXONOMY_FILE })
    expect(bad.code).toBe(2)
    expect(bad.stderr).toMatch(/git merge-base nope HEAD failed/)
  })
})

describe('recommendations-diff: the doc-tools binary', () => {
  test('runs and writes JSON', () => {
    const root = makeRepo(
      { 'antora.yml': DOCS_ANTORA, 'modules/manage/pages/cdc.adoc': page('CDC', 'Security') },
      { 'modules/manage/pages/cdc.adoc': page('CDC', 'Change data capture, PostgreSQL') },
    )
    const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'doc-tools.js'), 'recommendations-diff', '--changed', 'main', '--root', root, '--index', writeIndex(), '--taxonomy', TAXONOMY_FILE, '--format', 'json'], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(JSON.parse(res.stdout).summary).toEqual({ docs: 1, appear: 1, disappear: 0, rerank: 0 })
  })
})
