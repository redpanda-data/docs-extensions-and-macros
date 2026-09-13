'use strict'

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const extension = require('../../extensions/solutions-catalog/index')
const collect = require('../../extensions/solutions-catalog/collect')
const validate = require('../../extensions/solutions-catalog/validate')
const relationships = require('../../extensions/solutions-catalog/relationships')
const outputs = require('../../extensions/solutions-catalog/outputs')

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'solutions')
const VALID_CATEGORIES = yaml.load(fs.readFileSync(path.join(FIXTURES, 'valid-categories.yml'), 'utf8'))['page-valid-categories']
const RELATIONSHIPS_YML = fs.readFileSync(path.join(FIXTURES, 'relationships.yml'), 'utf8')
const RELATIONSHIPS_INVALID_YML = fs.readFileSync(path.join(FIXTURES, 'relationships-invalid.yml'), 'utf8')

const ORIGIN = 'https://github.com/redpanda-data/solutions.git'

// ---------------------------------------------------------------------------
// Fixture builders. Pages mirror the shape Antora hands to extensions at
// documentsConverted: src (with origin), asciidoc.attributes, converted HTML in
// contents, out, pub.
// ---------------------------------------------------------------------------

function urlFor (component, version, module, relative) {
  const stem = relative.replace(/\.adoc$/, '')
  const segments = [component]
  if (version) segments.push(version)
  if (module !== 'ROOT') segments.push(module)
  if (stem !== 'index') segments.push(stem)
  return `/${segments.join('/')}/`
}

function makePage ({ component = 'solutions', version = '', module, relative, attrs = {}, html = '', title, originUrl = ORIGIN }) {
  const url = urlFor(component, version, module, relative)
  return {
    src: { component, version, module, relative, family: 'page', origin: { url: originUrl } },
    asciidoc: { doctitle: title || relative.replace(/\.adoc$/, ''), attributes: { ...attrs } },
    contents: Buffer.from(html),
    out: { path: `${url.slice(1)}index.html` },
    pub: { url },
  }
}

function makeAttachment ({ component = 'solutions', version = '', module, relative }) {
  const url = `/${[component, version, module].filter(Boolean).join('/')}/_attachments/${relative}`
  return {
    src: { component, version, module, relative, family: 'attachment' },
    out: { path: url.slice(1) },
    pub: { url },
  }
}

function makeAlias ({ component = 'solutions', version = '', module, relative, target }) {
  const url = urlFor(component, version, module, relative)
  return {
    src: { component, version, module, relative, family: 'alias' },
    rel: target,
    out: { path: `${url.slice(1)}index.html` },
    pub: { url },
  }
}

function makePartial ({ component = 'solutions', version = '', module = 'ROOT', relative, text }) {
  return {
    src: { component, version, module, relative, family: 'partial' },
    contents: Buffer.from(text),
  }
}

const OVERVIEW_HTML = (title, extra = '') =>
  `<article class="doc"><h1>${title}</h1><p>Lede.</p>` +
  '<h2 id="architecture">Architecture</h2><p>Diagram.</p>' +
  '<h2 id="prerequisites">Prerequisites</h2><p>Docker.</p>' +
  '<h2 id="production-considerations">Production considerations</h2><p>Table.</p>' +
  `${extra}</article>`

const STEP_HTML = (title, verify = '<h2 id="verify">Verify the result</h2><p>rpk topic list</p>') =>
  `<article class="doc"><h1>${title}</h1><p>Do the thing.</p>${verify}</article>`

const OVERVIEW_ATTRS = {
  'page-layout': 'solution',
  'page-topic-type': 'solution',
  description: 'Build a live leaderboard from game events.',
  'page-solution-version': 'v1.2.3',
  'page-solution-difficulty': 'intermediate',
  'page-solution-duration': '45',
  'page-solution-status': 'published',
  'page-solution-featured': '',
  'page-solution-download': 'authenticated',
  'page-solution-platforms': 'self-managed, cloud',
  'page-solution-technologies': 'Go, Protobuf',
  'page-categories': 'Stream Processing, Clients',
  'page-solution-steps': 'start-environment, build-leaderboard, verify-end-to-end',
  'page-solution-related-docs': 'streaming:develop:consumer-offsets.adoc',
  'page-git-modified-date': '2026-09-01',
}

/**
 * A complete, valid solution: overview + three steps + one attachment.
 * `mutate` can edit the overview attrs / html / steps before pages are built.
 */
function makeSolution (id, { attrs = {}, steps, overviewHtml, stepHtml, title } = {}) {
  const overviewAttrs = { ...OVERVIEW_ATTRS, ...attrs }
  const stepIds = steps || collect.parseList(overviewAttrs['page-solution-steps'])
  const overview = makePage({
    module: id,
    relative: 'index.adoc',
    title: title || `Solution ${id}`,
    attrs: overviewAttrs,
    html: overviewHtml || OVERVIEW_HTML(title || `Solution ${id}`, '<a href="_attachments/docker-compose.yml">compose</a>'),
  })
  const stepPages = stepIds.map((stepId, i) => makePage({
    module: id,
    relative: `${stepId}.adoc`,
    title: `Step ${stepId}`,
    attrs: { 'page-layout': 'solution-step', description: `Step ${stepId}`, ...(i === 0 ? { 'page-solution-step-duration': '5' } : {}) },
    html: (stepHtml && stepHtml[stepId]) || STEP_HTML(`Step ${stepId}`),
  }))
  return {
    pages: [overview, ...stepPages],
    attachments: [makeAttachment({ module: id, relative: 'docker-compose.yml' })],
  }
}

function makeLanding () {
  return makePage({ module: 'ROOT', relative: 'index.adoc', title: 'Redpanda Solutions', attrs: { 'page-layout': 'solutions-home', description: 'Landing' }, html: '<div class="hero"></div>' })
}

function makeDoc ({ component = 'streaming', version = '26.2', module = 'develop', relative = 'consumer-offsets.adoc', attrs = {}, title } = {}) {
  return makePage({
    component, version, module, relative,
    title: title || relative,
    attrs: { 'page-categories': 'Stream Processing, Clients', ...attrs },
    html: `<article class="doc"><h1>${title || relative}</h1></article>`,
    originUrl: 'https://github.com/redpanda-data/docs.git',
  })
}

function makeComponents (extra = []) {
  const solutionsVersion = { version: '', asciidoc: { attributes: {} } }
  const streaming262 = { version: '26.2', asciidoc: { attributes: {} } }
  const streaming261 = { version: '26.1', asciidoc: { attributes: {} } }
  return [
    { name: 'solutions', title: 'Solutions', latest: solutionsVersion, versions: [solutionsVersion] },
    { name: 'streaming', title: 'Streaming', latest: streaming262, versions: [streaming262, streaming261] },
    { name: 'home', title: 'Home', latest: { version: '', asciidoc: { attributes: {} } }, versions: [{ version: '', asciidoc: { attributes: {} } }] },
    ...extra,
  ]
}

function makeCatalog ({ pages = [], attachments = [], partials = [], components = makeComponents() }) {
  const files = [...pages, ...attachments, ...partials]
  const matches = (file, criteria) => Object.entries(criteria).every(([k, v]) => v === undefined || file.src[k] === v)
  return {
    getComponents: () => components,
    getComponent: (name) => components.find((c) => c.name === name),
    getFiles: () => files,
    findBy: (criteria) => files.filter((f) => matches(f, criteria)),
    resolveResource: (spec, _ctx, defaultFamily = 'page') => {
      const m = String(spec).match(/^(?:([^@:]+)@)?([^:]+):([^:]*):(.+)$/)
      if (!m) return undefined
      const [, , component, module, relative] = m
      return files.find((f) => f.src.family === defaultFamily && f.src.component === component && f.src.module === (module || 'ROOT') && f.src.relative === relative)
    },
  }
}

function createContext (config = {}) {
  const handlers = {}
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  const ctx = {
    getLogger: () => logger,
    on: (event, handler) => { handlers[event] = handler },
  }
  extension.register.call(ctx, { config })
  return { ctx, handlers, logger }
}

/**
 * Register and run the three hooks over the given content. Returns everything a
 * test may want to inspect. Throws whatever the extension throws.
 */
async function run ({
  solutions = [makeSolution('leaderboard')],
  landing = makeLanding(),
  docs = [makeDoc()],
  relationshipsText = RELATIONSHIPS_YML,
  components,
  config = {},
  env = {},
  hooks = ['contentClassified', 'documentsConverted', 'navigationBuilt', 'beforePublish'],
  beforeNavigationBuilt,
} = {}) {
  const pages = [...(landing ? [landing] : []), ...solutions.flatMap((s) => s.pages), ...docs]
  const attachments = solutions.flatMap((s) => s.attachments)
  const partials = relationshipsText === null ? [] : [makePartial({ relative: 'relationships.yml', text: relationshipsText })]
  const catalog = makeCatalog({ pages, attachments, partials, components })
  const siteCatalog = { attributeFile: { 'page-valid-categories': VALID_CATEGORIES }, unpublishedPages: [], addFile: jest.fn() }
  const playbook = { site: { url: 'https://docs.redpanda.com' } }

  const savedEnv = { ...process.env }
  Object.assign(process.env, env)
  try {
    const { handlers, logger } = createContext(config)
    if (hooks.includes('contentClassified')) await handlers.contentClassified({ contentCatalog: catalog, siteCatalog, playbook })
    if (hooks.includes('documentsConverted')) await handlers.documentsConverted({ contentCatalog: catalog, siteCatalog, playbook })
    if (beforeNavigationBuilt) beforeNavigationBuilt(siteCatalog)
    if (hooks.includes('navigationBuilt')) await handlers.navigationBuilt({ contentCatalog: catalog, siteCatalog, playbook })
    if (hooks.includes('beforePublish')) await handlers.beforePublish({ contentCatalog: catalog, siteCatalog, playbook })
    return { catalog, siteCatalog, logger, pages, docs, solutions }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
    Object.assign(process.env, savedEnv)
  }
}

const attr = (page, name) => page.asciidoc.attributes[name]
const json = (page, name) => JSON.parse(attr(page, name))
const addedFile = (siteCatalog, name) => {
  const call = siteCatalog.addFile.mock.calls.find(([f]) => f.out.path.endsWith(name))
  return call ? JSON.parse(call[0].contents.toString('utf8')) : undefined
}

// ---------------------------------------------------------------------------

describe('solutions-catalog: happy path', () => {
  let result, overview, steps, doc

  beforeAll(async () => {
    result = await run()
    overview = result.solutions[0].pages[0]
    steps = result.solutions[0].pages.slice(1)
    doc = result.docs[0]
  })

  test('writes page-solution with derived id, repo, tag, asset', () => {
    const record = json(overview, 'page-solution')
    expect(record.id).toBe('leaderboard')
    expect(record.repo).toBe('redpanda-data/solutions')
    expect(record.tag).toBe('leaderboard/v1.2.3')
    expect(record.asset).toBe('leaderboard-v1.2.3.zip')
    expect(record.version).toBe('v1.2.3')
    expect(record.download).toBe('authenticated')
    expect(record.featured).toBe(true)
    expect(record.duration).toBe(45)
    expect(record.attachments).toEqual([{ name: 'docker-compose.yml', url: '/solutions/leaderboard/_attachments/docker-compose.yml' }])
    expect(record.lastModified).toBe('2026-09-01')
  })

  test('orders steps by page-solution-steps, not alphabetically', () => {
    const record = json(overview, 'page-solution')
    expect(record.steps.map((s) => s.id)).toEqual(['start-environment', 'build-leaderboard', 'verify-end-to-end'])
    expect(record.steps.map((s) => s.order)).toEqual([1, 2, 3])
    expect(record.steps[0].duration).toBe(5)
    expect(record.steps[1].duration).toBeNull()
    expect(record.steps[0].url).toBe('/solutions/leaderboard/start-environment/')
  })

  test('adds parent categories and rewrites page-categories', () => {
    const record = json(overview, 'page-solution')
    expect(record.categories).toEqual(['Stream Processing', 'Clients', 'Development'])
    expect(attr(overview, 'page-categories')).toBe('Stream Processing, Clients, Development')
  })

  test('resolves explicit related docs with provenance', () => {
    const record = json(overview, 'page-solution')
    expect(record.relatedDocs).toEqual([
      { id: 'streaming:develop:consumer-offsets.adoc', title: 'consumer-offsets.adoc', url: '/streaming/26.2/develop/consumer-offsets/', provenance: 'explicit' },
    ])
  })

  test('strips inline markup from titles before they enter JSON', async () => {
    const solution = makeSolution('leaderboard', { title: 'Use <code>rpk</code> &amp; friends' })
    solution.pages[1].asciidoc.doctitle = 'Start <em>fast</em>'
    const doc = makeDoc({ title: 'Consumer <code>offsets</code>' })
    const other = makeSolution('other', { title: 'Other <b>one</b>', attrs: { 'page-solution-related-docs': undefined, 'page-categories': 'rpk' } })
    delete other.pages[0].asciidoc.attributes['page-solution-related-docs']
    solution.pages[0].asciidoc.attributes['page-solution-related-solutions'] = 'other'
    const res = await run({ solutions: [solution, other], docs: [doc] })
    const record = json(solution.pages[0], 'page-solution')
    expect(record.title).toBe('Use rpk & friends')
    expect(record.steps[0].title).toBe('Start fast')
    expect(record.relatedDocs[0].title).toBe('Consumer offsets')
    expect(record.relatedSolutions[0].title).toBe('Other one')
    expect(json(solution.pages[0], 'page-solution-nav').overview.title).toBe('Use rpk & friends')
    expect(attr(solution.pages[1], 'page-solution-prev-title')).toBe('Use rpk & friends')
    expect(json(doc, 'page-related-solutions')[0].title).toBe('Use rpk & friends')
    expect(addedFile(res.siteCatalog, 'solutions.json').solutions.find((s) => s.id === 'leaderboard').title).toBe('Use rpk & friends')
  })

  test('writes nav, prev/next, step index and count on every page', () => {
    const nav = json(overview, 'page-solution-nav')
    expect(nav.home).toEqual({ title: 'Solutions', url: '/solutions/' })
    expect(nav.overview.url).toBe('/solutions/leaderboard/')
    expect(nav.steps).toHaveLength(3)

    expect(attr(overview, 'page-solution-step-index')).toBe('0')
    expect(attr(overview, 'page-solution-step-count')).toBe('3')
    expect(attr(overview, 'page-solution-next-url')).toBe('/solutions/leaderboard/start-environment/')
    expect(attr(overview, 'page-solution-prev-url')).toBeUndefined()

    const byId = Object.fromEntries(steps.map((p) => [collect.stepIdOf(p), p]))
    expect(attr(byId['start-environment'], 'page-solution-step-index')).toBe('1')
    expect(attr(byId['start-environment'], 'page-solution-prev-url')).toBe('/solutions/leaderboard/')
    expect(attr(byId['start-environment'], 'page-solution-prev-title')).toBe('Solution leaderboard')
    expect(attr(byId['start-environment'], 'page-solution-next-url')).toBe('/solutions/leaderboard/build-leaderboard/')
    expect(attr(byId['build-leaderboard'], 'page-solution-step-index')).toBe('2')
    expect(attr(byId['verify-end-to-end'], 'page-solution-step-index')).toBe('3')
    expect(attr(byId['verify-end-to-end'], 'page-solution-prev-url')).toBe('/solutions/leaderboard/build-leaderboard/')
    expect(attr(byId['verify-end-to-end'], 'page-solution-next-url')).toBeUndefined()
    expect(json(byId['verify-end-to-end'], 'page-solution-nav')).toEqual(nav)
  })

  test('mirrors overview scalars onto step pages', () => {
    const step = steps[0]
    expect(attr(step, 'page-solution-id')).toBe('leaderboard')
    expect(attr(step, 'page-solution-step-id')).toBe('start-environment')
    expect(attr(step, 'page-solution-version')).toBe('v1.2.3')
    expect(attr(step, 'page-solution-difficulty')).toBe('intermediate')
    expect(attr(step, 'page-solution-duration')).toBe('45')
    expect(attr(step, 'page-solution-status')).toBe('published')
    expect(attr(step, 'page-solution-download')).toBe('authenticated')
    expect(attr(step, 'page-solution-featured')).toBe('true')
    expect(attr(step, 'page-solution-technologies')).toBe('Go, Protobuf')
    expect(attr(step, 'page-solution-platforms')).toBe('self-managed, cloud')
    expect(attr(step, 'page-solution-asset')).toBe('leaderboard-v1.2.3.zip')
    expect(attr(step, 'page-solution-repo')).toBe('redpanda-data/solutions')
    // the step keeps its own description
    expect(attr(step, 'description')).toBe('Step start-environment')
    expect(attr(step, 'page-solution-description')).toBe(OVERVIEW_ATTRS.description)
  })

  test('decorates the related doc with page-related-solutions (explicit wins)', () => {
    const recs = json(doc, 'page-related-solutions')
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({
      id: 'leaderboard',
      url: '/solutions/leaderboard/',
      provenance: 'explicit',
      score: 1,
      difficulty: 'intermediate',
      duration: 45,
      technologies: ['Go', 'Protobuf'],
    })
  })

  test('publishes solutions.json and solutions-graph.json with the expected shape', () => {
    const catalog = addedFile(result.siteCatalog, 'assets/data/solutions.json')
    expect(catalog.siteUrl).toBe('https://docs.redpanda.com')
    expect(typeof catalog.generatedAt).toBe('string')
    expect(catalog.solutions.map((s) => s.id)).toEqual(['leaderboard'])
    expect(catalog.facets.categories).toEqual([
      { value: 'Clients', count: 1 }, { value: 'Development', count: 1 }, { value: 'Stream Processing', count: 1 },
    ])
    expect(catalog.facets.difficulty).toEqual([{ value: 'intermediate', count: 1 }])
    expect(catalog.facets.platforms).toEqual([{ value: 'cloud', count: 1 }, { value: 'self-managed', count: 1 }])
    expect(catalog.facets.technologies.map((t) => t.value)).toEqual(['Go', 'Protobuf'])

    const graph = addedFile(result.siteCatalog, 'assets/data/solutions-graph.json')
    expect(graph.settings).toEqual({ maxRelated: 3, minScore: 0.3 })
    expect(graph.edges).toEqual([
      expect.objectContaining({ doc: 'streaming:develop:consumer-offsets.adoc', solution: 'leaderboard', provenance: 'explicit', score: 1, shown: true, rank: 1 }),
    ])
  })

  test('sets the solutions-catalog attribute on every component version', () => {
    for (const component of result.catalog.getComponents()) {
      for (const version of component.versions) {
        const value = version.asciidoc.attributes['solutions-catalog']
        expect(typeof value).toBe('string')
        expect(JSON.parse(value).solutions[0].id).toBe('leaderboard')
      }
    }
  })

  test('warns about the pending relationship instead of using it', () => {
    const info = result.logger.info.mock.calls.map((c) => c[0]).join('\n')
    expect(info).toMatch(/1 pending relationship/)
  })
})

describe('solutions-catalog: non-solution modules', () => {
  // `examples` holds public tutorial code published as attachments for Product
  // Docs pages. Like ROOT it is not a solution: no validation, no index.adoc
  // requirement, and it never reaches the catalog, nav, or graph.
  function examplesModule ({ withPage = false } = {}) {
    const attachments = [makeAttachment({ module: 'examples', relative: 'quickstart/docker-compose.yml' })]
    const pages = withPage
      ? [makePage({ module: 'examples', relative: 'quickstart.adoc', title: 'Quickstart code', attrs: { 'page-categories': 'Clients' }, html: '<article class="doc"><h1>Quickstart code</h1></article>' })]
      : []
    return { pages, attachments }
  }

  test('examples is a reserved id and a non-solution module', () => {
    expect(collect.RESERVED_IDS).toContain('examples')
    expect(collect.NON_SOLUTION_MODULES).toEqual(['ROOT', 'examples'])
  })

  test('an attachments-only examples module passes every hook untouched', async () => {
    const result = await run({ solutions: [makeSolution('leaderboard'), examplesModule()] })
    const catalog = addedFile(result.siteCatalog, 'solutions.json')
    expect(catalog.solutions.map((s) => s.id)).toEqual(['leaderboard'])
    const graph = addedFile(result.siteCatalog, 'solutions-graph.json')
    expect(graph.edges.some((e) => e.solution === 'examples')).toBe(false)
  })

  test('an examples module with pages but no index.adoc is not validated as a solution', async () => {
    const examples = examplesModule({ withPage: true })
    const result = await run({ solutions: [makeSolution('leaderboard'), examples] })
    const page = examples.pages[0]
    expect(page.out).toBeDefined()
    expect(attr(page, 'page-solution')).toBeUndefined()
    expect(attr(page, 'page-solution-nav')).toBeUndefined()
    expect(attr(page, 'page-related-solutions')).toBeUndefined()
    const nav = json(result.solutions[0].pages[0], 'page-solution-nav')
    expect(nav.steps.map((s) => s.id)).not.toContain('quickstart')
    expect(addedFile(result.siteCatalog, 'solutions.json').solutions.map((s) => s.id)).toEqual(['leaderboard'])
  })

  test('no solution can point at examples as a related solution', async () => {
    const solution = makeSolution('leaderboard', { attrs: { 'page-solution-related-solutions': 'examples' } })
    await expect(run({ solutions: [solution, examplesModule()] })).rejects.toThrow(/entry "examples" is not a solution/)
  })

  test('a relationships.yml entry for examples is orphaned, not an edge', async () => {
    const text = 'relationships:\n  - solution: examples\n    doc: streaming:develop:consumer-offsets.adoc\n    status: approved\n'
    const result = await run({ solutions: [makeSolution('leaderboard'), examplesModule()], relationshipsText: text })
    expect(result.logger.warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/orphaned, solution "examples"/)
    expect(addedFile(result.siteCatalog, 'solutions-graph.json').edges.some((e) => e.solution === 'examples')).toBe(false)
  })
})

describe('solutions-catalog: idle without a solutions component', () => {
  test('every hook is a no-op', async () => {
    const components = makeComponents().filter((c) => c.name !== 'solutions')
    const result = await run({ solutions: [], landing: null, relationshipsText: null, components })
    expect(result.siteCatalog.addFile).not.toHaveBeenCalled()
    expect(attr(result.docs[0], 'page-related-solutions')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------

describe('solutions-catalog: structural fatals (contentClassified)', () => {
  test('missing landing page', async () => {
    await expect(run({ landing: null, hooks: ['contentClassified'] })).rejects.toThrow(/landing page ROOT\/pages\/index\.adoc is missing/)
  })

  // `examples` is reserved by being a non-solution module (see the dedicated
  // describe): it never reaches this check, so it is excluded here.
  test.each(collect.RESERVED_IDS.filter((id) => !collect.NON_SOLUTION_MODULES.includes(id)))('reserved module name %s', async (id) => {
    await expect(run({ solutions: [makeSolution(id)], hooks: ['contentClassified'] })).rejects.toThrow(/is reserved/)
  })

  test('module without an overview', async () => {
    const solution = makeSolution('orphan')
    solution.pages = solution.pages.slice(1) // drop index.adoc
    await expect(run({ solutions: [solution], hooks: ['contentClassified'] })).rejects.toThrow(/orphan: module has no pages\/index\.adoc overview/)
  })

  test('runs on pages that have no asciidoc yet (as Antora provides them at contentClassified)', async () => {
    const strip = (solution) => { for (const p of solution.pages) delete p.asciidoc; return solution }
    const landing = makeLanding(); delete landing.asciidoc
    await expect(run({ solutions: [strip(makeSolution('download'))], landing, hooks: ['contentClassified'] })).rejects.toThrow(/download: module name is reserved/)
    const ok = strip(makeSolution('leaderboard'))
    await expect(run({ solutions: [ok], landing, docs: [], hooks: ['contentClassified'] })).resolves.toBeTruthy()
  })

  test('module name that is not a slug', async () => {
    await expect(run({ solutions: [makeSolution('Not_A_Slug')], hooks: ['contentClassified'] })).rejects.toThrow(/lower-case slug/)
  })

  test('relationships.yml that fails the schema', async () => {
    await expect(run({ relationshipsText: RELATIONSHIPS_INVALID_YML, hooks: ['contentClassified'] })).rejects.toThrow(/relationships\.yml\/relationships\/0\/status must be equal to one of the allowed values/)
  })

  test('relationships.yml that is not YAML', async () => {
    await expect(run({ relationshipsText: 'relationships: [\n  - {', hooks: ['contentClassified'] })).rejects.toThrow(/could not be parsed/)
  })

  test('a missing relationships.yml only warns', async () => {
    const result = await run({ relationshipsText: null })
    expect(result.logger.warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/relationships\.yml not found/)
  })
})

describe('solutions-catalog: metadata fatals (documentsConverted)', () => {
  const cases = [
    ['missing description', { description: undefined }, /description is required/],
    ['missing version', { 'page-solution-version': undefined }, /page-solution-version is required/],
    ['malformed version', { 'page-solution-version': '1.2.3' }, /must match vX\.Y\.Z/],
    ['bad difficulty', { 'page-solution-difficulty': 'hard' }, /page-solution-difficulty must be one of/],
    ['missing duration', { 'page-solution-duration': undefined }, /page-solution-duration is required/],
    ['duration below range', { 'page-solution-duration': '2' }, /between 5 and 600/],
    ['duration above range', { 'page-solution-duration': '601' }, /between 5 and 600/],
    ['duration not an integer', { 'page-solution-duration': '45m' }, /between 5 and 600/],
    ['bad status', { 'page-solution-status': 'live' }, /page-solution-status must be one of/],
    ['bad download', { 'page-solution-download': 'maybe' }, /page-solution-download must be one of/],
    ['bad platform', { 'page-solution-platforms': 'mainframe' }, /page-solution-platforms contains unknown values: mainframe/],
    ['missing technologies', { 'page-solution-technologies': undefined }, /page-solution-technologies is required/],
    ['missing categories', { 'page-categories': undefined }, /page-categories is required/],
    ['unknown category', { 'page-categories': 'Clients, Gaming' }, /page-categories contains unknown values: Gaming/],
    ['deprecated without superseded-by', { 'page-solution-status': 'deprecated' }, /page-solution-superseded-by is required when status is deprecated/],
    ['overview layout', { 'page-layout': 'default' }, /pages\/index\.adoc must set :page-layout: solution/],
    ['related doc not fully qualified', { 'page-solution-related-docs': 'consumer-offsets.adoc' }, /must be a fully qualified page ID/],
    ['related doc unresolved', { 'page-solution-related-docs': 'streaming:develop:nope.adoc' }, /does not resolve to a page/],
    ['related solution unknown', { 'page-solution-related-solutions': 'ghost' }, /page-solution-related-solutions entry "ghost" is not a solution/],
    ['related solution is itself', { 'page-solution-related-solutions': 'leaderboard' }, /must not list the solution itself/],
    ['steps missing', { 'page-solution-steps': undefined }, /page-solution-steps is required/],
    ['steps list index', { 'page-solution-steps': 'index, start-environment, build-leaderboard, verify-end-to-end' }, /must not list index/],
  ]

  test.each(cases)('%s', async (_name, attrs, rx) => {
    const overrides = {}
    for (const [k, v] of Object.entries(attrs)) overrides[k] = v
    const solution = makeSolution('leaderboard', { attrs: overrides, steps: collect.parseList(OVERVIEW_ATTRS['page-solution-steps']) })
    // undefined attrs must actually be absent, not the string "undefined"
    for (const [k, v] of Object.entries(attrs)) if (v === undefined) delete solution.pages[0].asciidoc.attributes[k]
    await expect(run({ solutions: [solution] })).rejects.toThrow(rx)
  })

  test('step layout must be solution-step', async () => {
    const solution = makeSolution('leaderboard')
    solution.pages[1].asciidoc.attributes['page-layout'] = 'default'
    await expect(run({ solutions: [solution] })).rejects.toThrow(/step start-environment must set :page-layout: solution-step/)
  })

  test('step duration must be an integer', async () => {
    const solution = makeSolution('leaderboard')
    solution.pages[1].asciidoc.attributes['page-solution-step-duration'] = 'five'
    await expect(run({ solutions: [solution] })).rejects.toThrow(/page-solution-step-duration must be an integer/)
  })

  test('landing layout must be solutions-home', async () => {
    const landing = makeLanding()
    landing.asciidoc.attributes['page-layout'] = 'default'
    await expect(run({ landing })).rejects.toThrow(/ROOT\/pages\/index\.adoc must set :page-layout: solutions-home/)
  })

  test('duplicate relationship pair', async () => {
    const text = RELATIONSHIPS_YML + '\n  - solution: leaderboard\n    doc: streaming:develop:consumer-offsets.adoc\n    status: rejected\n'
    await expect(run({ relationshipsText: text })).rejects.toThrow(/duplicate pair leaderboard <-> streaming:develop:consumer-offsets\.adoc/)
  })

  test('collects every error into one throw', async () => {
    const solution = makeSolution('leaderboard', { attrs: { 'page-solution-difficulty': 'hard', 'page-solution-version': 'nope' } })
    let message
    try { await run({ solutions: [solution] }) } catch (err) { message = err.message }
    expect(message).toMatch(/2 errors/)
    expect(message).toMatch(/difficulty must be one of/)
    expect(message).toMatch(/must match vX\.Y\.Z/)
  })
})

describe('solutions-catalog: step bijection', () => {
  test('a listed step with no page is fatal', async () => {
    const solution = makeSolution('leaderboard', { steps: ['start-environment', 'build-leaderboard'] })
    await expect(run({ solutions: [solution] })).rejects.toThrow(/lists "verify-end-to-end" but pages\/verify-end-to-end\.adoc does not exist/)
  })

  test('a page not listed in page-solution-steps is fatal', async () => {
    const solution = makeSolution('leaderboard')
    solution.pages.push(makePage({ module: 'leaderboard', relative: 'extra.adoc', attrs: { 'page-layout': 'solution-step' }, html: STEP_HTML('Extra') }))
    await expect(run({ solutions: [solution] })).rejects.toThrow(/pages\/extra\.adoc exists but is not listed in page-solution-steps/)
  })

  test('a step listed twice is fatal', async () => {
    const solution = makeSolution('leaderboard', { attrs: { 'page-solution-steps': 'start-environment, start-environment, build-leaderboard, verify-end-to-end' }, steps: ['start-environment', 'build-leaderboard', 'verify-end-to-end'] })
    await expect(run({ solutions: [solution] })).rejects.toThrow(/lists "start-environment" more than once/)
  })
})

describe('solutions-catalog: section checks on converted HTML', () => {
  test.each(['Architecture', 'Prerequisites', 'Production considerations'])('published overview without h2 %s', async (missing) => {
    const html = OVERVIEW_HTML('Solution leaderboard', '<a href="_attachments/docker-compose.yml">c</a>').replace(`>${missing}</h2>`, '>Something else</h2>')
    const solution = makeSolution('leaderboard', { overviewHtml: html })
    await expect(run({ solutions: [solution] })).rejects.toThrow(new RegExp(`missing an h2 "${missing}"`))
  })

  test('heading text is normalized (case, whitespace, trailing punctuation)', async () => {
    const html = OVERVIEW_HTML('x').replace('>Production considerations</h2>', '>  PRODUCTION\n Considerations:  </h2>')
    const solution = makeSolution('leaderboard', { overviewHtml: html })
    await expect(run({ solutions: [solution] })).resolves.toBeTruthy()
  })

  test('published step without a Verify section is fatal', async () => {
    const solution = makeSolution('leaderboard', { stepHtml: { 'build-leaderboard': STEP_HTML('b', '<h2 id="check">Check the result</h2>') } })
    await expect(run({ solutions: [solution] })).rejects.toThrow(/published step build-leaderboard needs an h2\/h3 starting with "Verify"/)
  })

  test('a [.solution-verify] block satisfies the step check', async () => {
    const solution = makeSolution('leaderboard', { stepHtml: { 'build-leaderboard': STEP_HTML('b', '<div class="paragraph solution-verify"><p>rpk topic list</p></div>') } })
    await expect(run({ solutions: [solution] })).resolves.toBeTruthy()
  })

  test('an h3 starting with Verify satisfies the step check', async () => {
    const solution = makeSolution('leaderboard', { stepHtml: { 'build-leaderboard': STEP_HTML('b', '<h3 id="v">Verify: leaderboard updates</h3>') } })
    await expect(run({ solutions: [solution] })).resolves.toBeTruthy()
  })

  test('draft solutions skip the section checks', async () => {
    const solution = makeSolution('leaderboard', {
      attrs: { 'page-solution-status': 'draft' },
      overviewHtml: '<article class="doc"><h1>x</h1></article>',
      stepHtml: { 'build-leaderboard': STEP_HTML('b', '') },
    })
    await expect(run({ solutions: [solution], config: { include_drafts: true } })).resolves.toBeTruthy()
  })

  test('a link to a missing attachment is fatal', async () => {
    const solution = makeSolution('leaderboard', { overviewHtml: OVERVIEW_HTML('x', '<a href="_attachments/missing.env">env</a>') })
    await expect(run({ solutions: [solution] })).rejects.toThrow(/index\.adoc links to attachment "missing\.env" which does not exist/)
  })

  test('a relative attachment link from a step resolves against the step URL', async () => {
    // /solutions/leaderboard/build-leaderboard/ + ../_attachments/f -> /solutions/leaderboard/_attachments/f
    const ok = makeSolution('leaderboard', { stepHtml: { 'build-leaderboard': STEP_HTML('b') .replace('</article>', '<a href="../_attachments/docker-compose.yml">c</a></article>') } })
    await expect(run({ solutions: [ok] })).resolves.toBeTruthy()
    const bad = makeSolution('leaderboard', { stepHtml: { 'build-leaderboard': STEP_HTML('b').replace('</article>', '<a href="../_attachments/nope.yml">c</a></article>') } })
    await expect(run({ solutions: [bad] })).rejects.toThrow(/build-leaderboard\.adoc links to attachment "nope\.yml" which does not exist/)
  })

  test('links to another module\'s or component\'s attachments, or off-site, are not checked', async () => {
    const extra = '<a href="/solutions/other-solution/_attachments/theirs.yml">a</a>' +
      '<a href="../../streaming/26.2/get-started/_attachments/docker-compose/redpanda.yml">b</a>' +
      '<a href="https://example.com/solutions/leaderboard/_attachments/external.yml">c</a>' +
      '<a href="../examples/_attachments/quickstart/docker-compose.yml">d</a>'
    const solution = makeSolution('leaderboard', { overviewHtml: OVERVIEW_HTML('x', extra) })
    await expect(run({ solutions: [solution] })).resolves.toBeTruthy()
  })

  test('attachmentPrefixOf and attachmentLinkTargets', () => {
    expect(validate.attachmentPrefixOf('/solutions/leaderboard/')).toBe('/solutions/leaderboard/_attachments/')
    const html = '<a href="../_attachments/a%20b.yml">1</a><a href="/solutions/leaderboard/_attachments/c.yml#x">2</a><a href="/solutions/zzz/_attachments/d.yml">3</a><a href="mailto:x@y">4</a>'
    expect(validate.attachmentLinkTargets(html, { pageUrl: '/solutions/leaderboard/step/', attachmentPrefix: '/solutions/leaderboard/_attachments/' })).toEqual(['a b.yml', 'c.yml'])
    expect(validate.attachmentLinkTargets(html, {})).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('solutions-catalog: status handling', () => {
  test('drafts are unpublished by default', async () => {
    const draft = makeSolution('sandbox', { attrs: { 'page-solution-status': 'draft', 'page-solution-related-docs': undefined } })
    delete draft.pages[0].asciidoc.attributes['page-solution-related-docs']
    const result = await run({ solutions: [makeSolution('leaderboard'), draft] })
    for (const page of draft.pages) expect(page.out).toBeUndefined()
    expect(result.siteCatalog.unpublishedPages).toEqual(expect.arrayContaining(['/solutions/sandbox/', '/solutions/sandbox/start-environment/']))
    const catalog = addedFile(result.siteCatalog, 'solutions.json')
    expect(catalog.solutions.map((s) => s.id)).toEqual(['leaderboard'])
    const graph = addedFile(result.siteCatalog, 'solutions-graph.json')
    expect(graph.edges.some((e) => e.solution === 'sandbox')).toBe(false)
    expect(attr(draft.pages[0], 'page-solution')).toBeUndefined()
  })

  test.each([
    ['config include_drafts', { config: { include_drafts: true } }],
    ['env SOLUTIONS_INCLUDE_DRAFTS', { env: { SOLUTIONS_INCLUDE_DRAFTS: 'true' } }],
  ])('drafts build with %s but are never recommended', async (_name, options) => {
    const draft = makeSolution('sandbox', { attrs: { 'page-solution-status': 'draft' } })
    const result = await run({ solutions: [draft], ...options })
    for (const page of draft.pages) expect(page.out).toBeDefined()
    expect(result.siteCatalog.unpublishedPages).toEqual([])
    expect(json(draft.pages[0], 'page-solution').status).toBe('draft')
    expect(attr(result.docs[0], 'page-related-solutions')).toBeUndefined()
    const graph = addedFile(result.siteCatalog, 'solutions-graph.json')
    expect(graph.edges[0]).toMatchObject({ solution: 'sandbox', shown: false })
    expect(graph.edges[0].reason).toMatch(/status is draft/)
    // drafts are not catalog entries
    expect(addedFile(result.siteCatalog, 'solutions.json').solutions).toEqual([])
    expect(result.logger.warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/building 1 draft solution/)
  })

  test('deprecated solutions publish, appear in the catalog, and are excluded from recommendations', async () => {
    const old = makeSolution('old-way', { attrs: { 'page-solution-status': 'deprecated', 'page-solution-superseded-by': 'leaderboard' } })
    const result = await run({ solutions: [makeSolution('leaderboard'), old] })
    expect(old.pages[0].out).toBeDefined()
    const catalog = addedFile(result.siteCatalog, 'solutions.json')
    expect(catalog.solutions.find((s) => s.id === 'old-way')).toMatchObject({ status: 'deprecated', supersededBy: 'leaderboard' })
    const recs = json(result.docs[0], 'page-related-solutions')
    expect(recs.map((r) => r.id)).toEqual(['leaderboard'])
    const edge = addedFile(result.siteCatalog, 'solutions-graph.json').edges.find((e) => e.solution === 'old-way')
    expect(edge.shown).toBe(false)
    expect(edge.reason).toMatch(/status is deprecated/)
  })

  test('warns when no published solution is featured, and omits page-solution-featured', async () => {
    const solution = makeSolution('leaderboard', { attrs: { 'page-solution-featured': 'false' } })
    const result = await run({ solutions: [solution] })
    expect(result.logger.warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/no published solution is featured/)
    for (const page of solution.pages) expect(attr(page, 'page-solution-featured')).toBeUndefined()
    expect(json(solution.pages[0], 'page-solution').featured).toBe(false)
  })

  test('drafts take their attachments, images, and aliases with them, and the list survives a reset', async () => {
    const draft = makeSolution('sandbox', { attrs: { 'page-solution-status': 'draft' } })
    delete draft.pages[0].asciidoc.attributes['page-solution-related-docs']
    const alias = makeAlias({ module: 'sandbox', relative: 'old-name.adoc', target: draft.pages[0] })
    const image = { src: { component: 'solutions', version: '', module: 'sandbox', relative: 'arch.svg', family: 'image' }, out: { path: 'x' }, pub: { url: '/solutions/sandbox/_images/arch.svg' } }
    draft.attachments.push(alias, image)
    const result = await run({
      solutions: [makeSolution('leaderboard'), draft],
      // unpublish-pages registered after us would do exactly this
      beforeNavigationBuilt: (siteCatalog) => { siteCatalog.unpublishedPages = [] },
    })
    for (const file of [...draft.pages, ...draft.attachments]) expect(file.out).toBeUndefined()
    expect(result.siteCatalog.unpublishedPages).toEqual(expect.arrayContaining(['/solutions/sandbox/', '/solutions/sandbox/start-environment/', '/solutions/sandbox/old-name/']))
    expect(new Set(result.siteCatalog.unpublishedPages).size).toBe(result.siteCatalog.unpublishedPages.length)
    // attachments and images are files, not pages: not in the unpublished URL list
    expect(result.siteCatalog.unpublishedPages).not.toContain('/solutions/sandbox/_attachments/docker-compose.yml')
    // a live solution's files are untouched
    for (const file of result.solutions[0].attachments) expect(file.out).toBeDefined()
  })

  test('ensureUnpublished is idempotent and tolerates a missing array', () => {
    const siteCatalog = {}
    extension.ensureUnpublished(siteCatalog, ['/a/', '/b/'])
    extension.ensureUnpublished(siteCatalog, ['/b/', '/c/'])
    expect(siteCatalog.unpublishedPages).toEqual(['/a/', '/b/', '/c/'])
    extension.ensureUnpublished(siteCatalog, [])
    expect(siteCatalog.unpublishedPages).toEqual(['/a/', '/b/', '/c/'])
  })
})

// ---------------------------------------------------------------------------

describe('solutions-catalog: recommendation ranking', () => {
  // One doc, three solutions with different signals.
  const REL = [
    'relationships:',
    '  - solution: approved-one',
    '    doc: streaming:develop:consumer-offsets.adoc',
    '    status: approved',
    '    source: editor',
    '    confidence: 0.95',
    '    reason: editor said so',
  ].join('\n')

  test('explicit > editor-approved > category', async () => {
    const explicit = makeSolution('explicit-one', { attrs: { 'page-categories': 'rpk' } })
    const approved = makeSolution('approved-one', { attrs: { 'page-categories': 'rpk', 'page-solution-related-docs': undefined } })
    delete approved.pages[0].asciidoc.attributes['page-solution-related-docs']
    const category = makeSolution('category-one', { attrs: { 'page-solution-related-docs': undefined } })
    delete category.pages[0].asciidoc.attributes['page-solution-related-docs']

    const result = await run({ solutions: [category, approved, explicit], relationshipsText: REL })
    const recs = json(result.docs[0], 'page-related-solutions')
    expect(recs.map((r) => [r.id, r.provenance, r.score])).toEqual([
      ['explicit-one', 'explicit', 1],
      ['approved-one', 'editor-approved', 0.95],
      ['category-one', 'category', 0.7],
    ])
    expect(recs[1].reason).toMatch(/editor said so/)
    expect(recs[2].reason).toBe('shares categories Stream Processing, Clients (Development)')
  })

  test('approved score has a 0.9 floor', () => {
    const { related } = relationships.computeRelatedSolutions({
      docs: [{ key: 'd', url: '/d/', categories: [], deployment: '' }],
      solutions: [{ id: 's', title: 'S', url: '/s/', status: 'published', featured: false, categories: [], platforms: ['self-managed'], technologies: [], relatedDocKeys: new Set() }],
      relationships: [{ solutionId: 's', docKey: 'd', status: 'approved', confidence: 0.4, reason: '' }],
      categoryMap: null,
    })
    expect(related.get('d')[0].score).toBe(0.9)
  })

  test('parent-only overlap stays below the threshold and is never shown', async () => {
    const doc = makeDoc({ attrs: { 'page-categories': 'Development' } })
    const solution = makeSolution('leaderboard', { attrs: { 'page-solution-related-docs': undefined } })
    delete solution.pages[0].asciidoc.attributes['page-solution-related-docs']
    const result = await run({ solutions: [solution], docs: [doc], relationshipsText: 'relationships: []' })
    expect(attr(doc, 'page-related-solutions')).toBeUndefined()
    const [edge] = addedFile(result.siteCatalog, 'solutions-graph.json').edges
    expect(edge).toMatchObject({ provenance: 'category', score: 0.1, shown: false })
    expect(edge.reason).toMatch(/below 0\.3/)
  })

  test('a single shared subcategory is enough to show', async () => {
    const doc = makeDoc({ attrs: { 'page-categories': 'Clients' } })
    const solution = makeSolution('leaderboard', { attrs: { 'page-solution-related-docs': undefined } })
    delete solution.pages[0].asciidoc.attributes['page-solution-related-docs']
    const result = await run({ solutions: [solution], docs: [doc], relationshipsText: 'relationships: []' })
    // Clients (0.3) + parent Development (0.1) = 0.4
    expect(json(doc, 'page-related-solutions')[0]).toMatchObject({ provenance: 'category', score: 0.4 })
  })

  test('category score is capped at 0.85', () => {
    const map = { subcategories: new Set(['a', 'b', 'c', 'd']), categories: new Set(['P']) }
    expect(relationships.categoryScore(['a', 'b', 'c', 'd', 'P'], ['a', 'b', 'c', 'd', 'P'], map).score).toBe(0.85)
  })

  test('shows at most max_related, in deterministic order', async () => {
    const solutions = ['alpha', 'bravo', 'charlie', 'delta'].map((id) => {
      const s = makeSolution(id, { attrs: { 'page-solution-featured': 'false', 'page-git-modified-date': '2026-01-01' } })
      delete s.pages[0].asciidoc.attributes['page-solution-related-docs']
      return s
    })
    const result = await run({ solutions, relationshipsText: 'relationships: []' })
    const recs = json(result.docs[0], 'page-related-solutions')
    // equal score, none featured, equal dates: title asc decides
    expect(recs.map((r) => r.id)).toEqual(['alpha', 'bravo', 'charlie'])
    const edges = addedFile(result.siteCatalog, 'solutions-graph.json').edges
    const delta = edges.find((e) => e.solution === 'delta')
    expect(delta.shown).toBe(false)
    expect(delta.reason).toMatch(/rank 4 exceeds max_related 3/)
    expect(edges.filter((e) => e.shown).map((e) => e.rank)).toEqual([1, 2, 3])
  })

  test('max_related is configurable', async () => {
    const solutions = ['alpha', 'bravo'].map((id) => {
      const s = makeSolution(id)
      delete s.pages[0].asciidoc.attributes['page-solution-related-docs']
      return s
    })
    const result = await run({ solutions, relationshipsText: 'relationships: []', config: { max_related: 1 } })
    expect(json(result.docs[0], 'page-related-solutions')).toHaveLength(1)
  })

  test('tie-breaks: score, then featured, then lastModified desc, then title asc', async () => {
    const mk = (id, attrs) => {
      const s = makeSolution(id, { attrs })
      delete s.pages[0].asciidoc.attributes['page-solution-related-docs']
      return s
    }
    const solutions = [
      mk('zulu', { 'page-solution-featured': 'false', 'page-git-modified-date': '2026-03-01' }),
      mk('yankee', { 'page-solution-featured': 'false', 'page-git-modified-date': '2026-03-01' }),
      mk('xray', { 'page-solution-featured': 'false', 'page-git-modified-date': '2026-05-01' }),
      mk('whiskey', { 'page-solution-featured': 'true', 'page-git-modified-date': '2025-01-01' }),
    ]
    const result = await run({ solutions, relationshipsText: 'relationships: []', config: { max_related: 10 } })
    const recs = json(result.docs[0], 'page-related-solutions')
    // whiskey: featured. xray: newest. yankee before zulu: title asc.
    expect(recs.map((r) => r.id)).toEqual(['whiskey', 'xray', 'yankee', 'zulu'])
  })

  test('rejected relationships suppress the edge and keep it in the graph with shown:false', async () => {
    const solution = makeSolution('leaderboard')
    delete solution.pages[0].asciidoc.attributes['page-solution-related-docs']
    const text = 'relationships:\n  - solution: leaderboard\n    doc: streaming:develop:consumer-offsets.adoc\n    status: rejected\n    reason: not really related\n'
    const result = await run({ solutions: [solution], relationshipsText: text })
    expect(attr(result.docs[0], 'page-related-solutions')).toBeUndefined()
    const [edge] = addedFile(result.siteCatalog, 'solutions-graph.json').edges
    expect(edge).toMatchObject({ provenance: 'rejected', shown: false, rank: null })
    expect(edge.reason).toMatch(/not really related/)
  })

  test('rejected beats explicit in both directions and warns', async () => {
    const text = 'relationships:\n  - solution: leaderboard\n    doc: streaming:develop:consumer-offsets.adoc\n    status: rejected\n    reason: wrong page\n'
    const result = await run({ relationshipsText: text })
    expect(attr(result.docs[0], 'page-related-solutions')).toBeUndefined()
    expect(json(result.solutions[0].pages[0], 'page-solution').relatedDocs).toEqual([])
    expect(result.logger.warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/leaderboard: page-solution-related-docs lists streaming:develop:consumer-offsets\.adoc but relationships\.yml rejects the pair/)
    const [edge] = addedFile(result.siteCatalog, 'solutions-graph.json').edges
    expect(edge).toMatchObject({ provenance: 'rejected', shown: false })
  })

  test('pending relationships are ignored entirely', async () => {
    const solution = makeSolution('leaderboard', { attrs: { 'page-categories': 'rpk' } })
    delete solution.pages[0].asciidoc.attributes['page-solution-related-docs']
    const text = 'relationships:\n  - solution: leaderboard\n    doc: streaming:develop:consumer-offsets.adoc\n    status: pending\n    source: ml\n    confidence: 0.99\n'
    const result = await run({ solutions: [solution], relationshipsText: text })
    expect(attr(result.docs[0], 'page-related-solutions')).toBeUndefined()
    expect(addedFile(result.siteCatalog, 'solutions-graph.json').edges).toEqual([])
  })

  test('orphaned relationships warn and are dropped', async () => {
    const text = 'relationships:\n  - solution: ghost\n    doc: streaming:develop:consumer-offsets.adoc\n    status: approved\n  - solution: leaderboard\n    doc: streaming:develop:missing.adoc\n    status: approved\n'
    const result = await run({ relationshipsText: text })
    const warnings = result.logger.warn.mock.calls.map((c) => c[0]).join('\n')
    expect(warnings).toMatch(/orphaned, solution "ghost"/)
    expect(warnings).toMatch(/orphaned, doc "streaming:develop:missing\.adoc"/)
  })
})

describe('solutions-catalog: platform filter', () => {
  test('applies to category edges only', async () => {
    const cloudDoc = makeDoc({ component: 'cloud', version: '', module: 'develop', relative: 'cloud-page.adoc', attrs: { 'page-cloud': true } })
    const cloudVersion = { version: '', asciidoc: { attributes: {} } }
    const components = makeComponents([{ name: 'cloud', title: 'Cloud', latest: cloudVersion, versions: [cloudVersion] }])

    const selfManagedOnly = makeSolution('sm-category', { attrs: { 'page-solution-platforms': 'self-managed' } })
    delete selfManagedOnly.pages[0].asciidoc.attributes['page-solution-related-docs']
    const selfManagedExplicit = makeSolution('sm-explicit', { attrs: { 'page-solution-platforms': 'self-managed', 'page-solution-related-docs': 'cloud:develop:cloud-page.adoc', 'page-categories': 'rpk' } })
    const both = makeSolution('both', { attrs: { 'page-solution-related-docs': undefined } })
    delete both.pages[0].asciidoc.attributes['page-solution-related-docs']

    const result = await run({ solutions: [selfManagedOnly, selfManagedExplicit, both], docs: [cloudDoc], components, relationshipsText: 'relationships: []' })
    const recs = json(cloudDoc, 'page-related-solutions')
    expect(recs.map((r) => r.id)).toEqual(['sm-explicit', 'both'])
    const hidden = addedFile(result.siteCatalog, 'solutions-graph.json').edges.find((e) => e.solution === 'sm-category')
    expect(hidden.shown).toBe(false)
    expect(hidden.reason).toMatch(/Redpanda Cloud page, solution platforms self-managed/)
  })

  test('Kubernetes, Linux, and Docker docs need self-managed; unmarked docs match everything', () => {
    expect(relationships.platformCompatible('Kubernetes', ['cloud'])).toBe(false)
    expect(relationships.platformCompatible('Linux', ['self-managed'])).toBe(true)
    expect(relationships.platformCompatible('Docker', ['self-managed', 'cloud'])).toBe(true)
    expect(relationships.platformCompatible('Redpanda Cloud', ['self-managed'])).toBe(false)
    expect(relationships.platformCompatible('', ['cloud'])).toBe(true)
  })
})

describe('solutions-catalog: eligible doc pages', () => {
  test('excludes umbrella layouts, utility components, old versions, unpublished pages, and opt-outs', async () => {
    const docs = [
      makeDoc({ relative: 'ok.adoc' }),
      makeDoc({ relative: 'old.adoc', version: '26.1' }),
      makeDoc({ relative: 'landing.adoc', attrs: { 'page-layout': 'component-home-v3' } }),
      makeDoc({ relative: 'role.adoc', attrs: { 'page-role': 'home' } }),
      makeDoc({ relative: 'optout.adoc', attrs: { 'page-exclude-related-solutions': '' } }),
      makeDoc({ component: 'home', version: '', module: 'ROOT', relative: 'index.adoc' }),
    ]
    const unpublished = makeDoc({ relative: 'gone.adoc' })
    delete unpublished.out
    docs.push(unpublished)
    const solution = makeSolution('leaderboard', { attrs: { 'page-solution-related-docs': 'streaming:develop:ok.adoc' } })
    await run({ solutions: [solution], docs, relationshipsText: 'relationships: []' })
    const decorated = docs.filter((d) => attr(d, 'page-related-solutions')).map((d) => d.src.relative)
    expect(decorated).toEqual(['ok.adoc'])
  })
})

// ---------------------------------------------------------------------------

describe('solutions-catalog: pure helpers', () => {
  test.each([
    ['https://github.com/redpanda-data/solutions.git', 'redpanda-data/solutions'],
    ['https://github.com/redpanda-data/solutions', 'redpanda-data/solutions'],
    ['git@github.com:redpanda-data/solutions.git', 'redpanda-data/solutions'],
    ['ssh://git@github.com/redpanda-data/solutions.git', 'redpanda-data/solutions'],
    ['https://user:token@github.com/redpanda-data/solutions/', 'redpanda-data/solutions'],
    ['file:///Users/me/solutions', ''],
    ['', ''],
    [undefined, ''],
  ])('deriveRepo(%s) -> %s', (input, expected) => {
    expect(collect.deriveRepo(input)).toBe(expected)
  })

  test('parseFlag treats a bare attribute as true and "false" as false', () => {
    expect(collect.parseFlag('')).toBe(true)
    expect(collect.parseFlag('true')).toBe(true)
    expect(collect.parseFlag('false')).toBe(false)
    expect(collect.parseFlag(undefined)).toBe(false)
  })

  test('normalizeHeading', () => {
    expect(validate.normalizeHeading('  Production\n  Considerations: ')).toBe('production considerations')
    expect(validate.normalizeHeading('Verify!')).toBe('verify')
  })

  test('resolveConfig accepts camelCase and snake_case, with defaults and env', () => {
    expect(extension.resolveConfig({}, {})).toEqual({ maxRelated: 3, minScore: 0.3, networkChecks: 'auto', includeDrafts: false })
    expect(extension.resolveConfig({ maxRelated: 5, minScore: 0.5, networkChecks: true, includeDrafts: 'true' }, {})).toEqual({ maxRelated: 5, minScore: 0.5, networkChecks: true, includeDrafts: true })
    expect(extension.resolveConfig({ max_related: '2', network_checks: 'false' }, { SOLUTIONS_INCLUDE_DRAFTS: 'true' })).toEqual({ maxRelated: 2, minScore: 0.3, networkChecks: false, includeDrafts: true })
    expect(extension.resolveConfig({ include_drafts: false }, { SOLUTIONS_INCLUDE_DRAFTS: 'true' }).includeDrafts).toBe(false)
    expect(extension.resolveConfig({ max_related: 'lots' }, {}).maxRelated).toBe(3)
  })

  test('shouldRunNetworkChecks: explicit wins, auto needs CI and a token', () => {
    expect(extension.shouldRunNetworkChecks(true, {})).toBe(true)
    expect(extension.shouldRunNetworkChecks(false, { CI: 'true' })).toBe(false)
    expect(extension.shouldRunNetworkChecks('auto', {})).toBe(false)
    expect(extension.shouldRunNetworkChecks('auto', { CI: 'true' }, () => false)).toBe(false)
    expect(extension.shouldRunNetworkChecks('auto', { CI: 'true' }, () => true)).toBe(true)
  })

  test('checkReleases warns on a missing release, a missing asset, and API errors', async () => {
    const logger = { warn: jest.fn(), info: jest.fn() }
    const records = [
      { id: 'a', status: 'published', repo: 'o/r', tag: 'a/v1.0.0', asset: 'a-v1.0.0.zip' },
      { id: 'b', status: 'published', repo: 'o/r', tag: 'b/v1.0.0', asset: 'b-v1.0.0.zip' },
      { id: 'c', status: 'published', repo: 'o/r', tag: 'c/v1.0.0', asset: 'c-v1.0.0.zip' },
      { id: 'd', status: 'published', repo: 'o/r', tag: 'd/v1.0.0', asset: 'd-v1.0.0.zip' },
      { id: 'draft', status: 'draft', repo: 'o/r', tag: 'draft/v1.0.0', asset: 'x' },
    ]
    const octokit = { rest: { repos: { getReleaseByTag: jest.fn(async ({ tag }) => {
      if (tag === 'a/v1.0.0') return { data: { assets: [{ name: 'a-v1.0.0.zip' }] } }
      if (tag === 'b/v1.0.0') return { data: { assets: [] } }
      if (tag === 'c/v1.0.0') { const e = new Error('Not Found'); e.status = 404; throw e }
      throw new Error('boom')
    }) } } }
    await extension.checkReleases(records, logger, octokit)
    expect(octokit.rest.repos.getReleaseByTag).toHaveBeenCalledTimes(4)
    const warnings = logger.warn.mock.calls.map((c) => c[0])
    expect(warnings).toHaveLength(3)
    expect(warnings[0]).toMatch(/o\/r@b\/v1\.0\.0 exists but has no asset b-v1\.0\.0\.zip/)
    expect(warnings[1]).toMatch(/o\/r@c\/v1\.0\.0 not published yet/)
    expect(warnings[2]).toMatch(/could not check release o\/r@d\/v1\.0\.0: boom/)
  })

  test('the shipped relationships schema accepts the fixture and rejects unknown keys', () => {
    const check = relationships.createRelationshipsValidator()
    expect(check(relationships.parseRelationships(RELATIONSHIPS_YML))).toBe(true)
    expect(check({ relationships: [{ solution: 'a', doc: 'x:y:z.adoc', status: 'approved', extra: 1 }] })).toBe(false)
    expect(check({ relationships: [{ solution: 'a', doc: 'not-qualified.adoc', status: 'approved' }] })).toBe(false)
  })

  test('parseRelationships keeps unquoted dates as strings', () => {
    const data = relationships.parseRelationships('relationships:\n  - solution: a\n    doc: x:y:z.adoc\n    status: approved\n    reviewedAt: 2026-09-12\n')
    expect(data.relationships[0].reviewedAt).toBe('2026-09-12')
    expect(relationships.createRelationshipsValidator()(data)).toBe(true)
  })

  test('buildCatalog keeps published and deprecated only', () => {
    const recs = ['published', 'deprecated', 'draft'].map((status, i) => ({ id: `s${i}`, status, categories: [], technologies: [], platforms: [], difficulty: 'beginner' }))
    const catalog = outputs.buildCatalog(recs, { siteUrl: 'x', generatedAt: 't' })
    expect(catalog.solutions.map((s) => s.status)).toEqual(['published', 'deprecated'])
    expect(catalog.facets.difficulty).toEqual([{ value: 'beginner', count: 2 }])
  })
})
