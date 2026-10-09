'use strict'

const generateIndex = require('../../extensions/algolia-indexer/generate-index.js')

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

// Build HTML mirroring Antora's render of a doc page: an `article.doc` with an
// h1, an intro paragraph, and a set of section headings (with ids) plus body text.
function buildArticle ({ h1 = 'Reference', intro = 'Intro paragraph.', sections = [] }) {
  const body = sections
    .map(({ name, level = 'h3' }) =>
      `<div class="sect2"><${level} id="${name}">${name}</${level}>` +
      `<div class="paragraph"><p>Description for ${name}.</p></div></div>`)
    .join('')
  return `<article class="doc"><h1>${h1}</h1>` +
    `<div class="paragraph"><p>${intro}</p></div>${body}</article>`
}

const component = { name: 'redpanda', title: 'Self-Managed', latest: { version: '25.3' } }

function makePage (html, overrides = {}) {
  return {
    contents: Buffer.from(html),
    out: { dirname: 'current/reference', basename: 'page.html' },
    pub: { url: '/current/reference/page' },
    src: { component: 'redpanda', version: '25.3', origin: {} },
    asciidoc: { attributes: {} },
    ...overrides
  }
}

function runIndex (page) {
  const result = generateIndex(
    { site: { url: 'https://docs.redpanda.com' } },
    {
      getPages: (fn) => [page].filter((p) => fn(p) !== undefined),
      getComponent: () => component,
      getComponentVersion: () => component.latest,
      getComponents: () => [component]
    },
    { logger: noopLogger }
  )
  return result[component.name][page.src.version]
}

// Approximate the same tokenization the indexer uses to size chunks.
function tokenCount (titles) {
  return titles.reduce(
    (sum, t) => sum + (String(t.t).split(/[\s_./:-]+/).filter(Boolean).length || 1),
    0
  )
}

describe('algolia-indexer generate-index (DOC-1878 chunking)', () => {
  // Algolia only indexes ~the first 290 words of a record. Long reference pages put
  // hundreds of property/metric names in the titles array, so names past that window
  // were unsearchable. The indexer now splits those pages into multiple records.
  test('long /properties/ pages are split into multiple bounded records', () => {
    const sections = Array.from({ length: 400 }, (_, i) => ({
      name: `cluster_property_number_${i}_setting_ms`
    }))
    const page = makePage(
      buildArticle({ h1: 'Cluster Configuration Properties', sections }),
      { pub: { url: '/current/reference/properties/cluster-properties' } }
    )

    const records = runIndex(page)

    // More than one record, and each record's titles stay within the budget.
    expect(records.length).toBeGreaterThan(1)
    for (const rec of records) {
      expect(tokenCount(rec.titles)).toBeLessThanOrEqual(180)
    }

    // Every heading is present across the chunks (none dropped).
    const allTitles = records.flatMap((r) => r.titles.map((t) => t.t))
    expect(allTitles).toHaveLength(400)
    // A name that previously fell past the indexing window now lives in a small,
    // fully-indexed chunk.
    const deepName = 'cluster_property_number_300_setting_ms'
    const owning = records.filter((r) => r.titles.some((t) => t.t === deepName))
    expect(owning).toHaveLength(1)
    expect(tokenCount(owning[0].titles)).toBeLessThanOrEqual(180)
  })

  test('chunk objectIDs are unique; first keeps the page URL, rest deep-link to anchors', () => {
    const sections = Array.from({ length: 400 }, (_, i) => ({ name: `prop_${i}_value_ms` }))
    const page = makePage(
      buildArticle({ h1: 'Cluster Configuration Properties', sections }),
      { pub: { url: '/current/reference/properties/cluster-properties' } }
    )

    const records = runIndex(page)
    const ids = records.map((r) => r.objectID)

    expect(new Set(ids).size).toBe(ids.length) // unique
    expect(ids[0]).toBe('/current/reference/properties/cluster-properties')
    for (const id of ids.slice(1)) {
      expect(id).toMatch(/^\/current\/reference\/properties\/cluster-properties#prop_\d+_value_ms$/)
    }

    // Every chunk shares one clean `url` (no #fragment) for deep-link href + dedupe.
    for (const rec of records) {
      expect(rec.url).toBe('/current/reference/properties/cluster-properties')
      expect(rec.url).not.toContain('#')
    }
  })

  test('metrics-style pages (>30 headings, no /properties/ url) are also chunked', () => {
    const sections = Array.from({ length: 200 }, (_, i) => ({ name: `redpanda_metric_${i}_total` }))
    const page = makePage(buildArticle({ h1: 'Public Metrics', sections }))

    const records = runIndex(page)

    expect(records.length).toBeGreaterThan(1)
    expect(records.flatMap((r) => r.titles.map((t) => t.t)))
      .toContain('redpanda_metric_150_total')
  })

  test('normal short pages remain a single record with the base objectID', () => {
    const page = makePage(buildArticle({
      h1: 'Some guide',
      sections: [{ name: 'step-one' }, { name: 'step-two' }]
    }))

    const records = runIndex(page)

    expect(records).toHaveLength(1)
    expect(records[0].objectID).toBe('/current/reference/page')
    expect(records[0].text).toContain('Description for step-one')
  })
})

describe('algolia-indexer generate-index (Solutions records)', () => {
  const solutionsComponent = { name: 'solutions', title: 'Solutions', latest: { version: '' } }

  function runSolutions (page) {
    return generateIndex(
      { site: { url: 'https://docs.redpanda.com' } },
      {
        getPages: (fn) => [page].filter((p) => fn(p) !== undefined),
        getComponent: () => solutionsComponent,
        getComponentVersion: () => solutionsComponent.latest,
        getComponents: () => [component, solutionsComponent]
      },
      { logger: noopLogger }
    )[solutionsComponent.name]['']
  }

  test('pages in the solutions component become type Solution with facet fields', () => {
    const page = makePage(buildArticle({ h1: 'Build a leaderboard', sections: [{ name: 'verify' }] }), {
      out: { dirname: 'solutions/leaderboard/build-leaderboard', basename: 'index.html' },
      pub: { url: '/solutions/leaderboard/build-leaderboard/' },
      src: { component: 'solutions', version: '', origin: {} },
      asciidoc: {
        attributes: {
          'page-layout': 'solution-step',
          'page-solution-id': 'leaderboard',
          'page-solution-step-id': 'build-leaderboard',
          'page-solution-difficulty': 'intermediate',
          'page-solution-duration': '45',
          'page-solution-step-duration': '10',
          'page-solution-technologies': 'Go, Protobuf',
          'page-solution-platforms': 'self-managed, cloud',
          'page-solution-status': 'published',
          'page-categories': 'Clients'
        }
      }
    })
    const [record] = runSolutions(page)
    expect(record).toMatchObject({
      type: 'Solution',
      product: 'Solutions',
      _tags: ['Solutions'],
      solutionId: 'leaderboard',
      stepId: 'build-leaderboard',
      difficulty: 'intermediate',
      duration: 10,
      technologies: ['Go', 'Protobuf'],
      platforms: ['self-managed', 'cloud'],
      status: 'published',
      categories: ['Clients']
    })
    expect(record.deployment).toBeUndefined()
    expect(record.interactive).toBeUndefined()
  })

  test('the solutions landing page is indexed from metadata like other umbrella layouts', () => {
    const html = '<html><head><meta name="description" content="Runnable Redpanda solutions"></head>' +
      '<body><h1 class="hero-title">Redpanda Solutions</h1></body></html>'
    const page = makePage(html, {
      out: { dirname: 'solutions', basename: 'index.html' },
      pub: { url: '/solutions/' },
      src: { component: 'solutions', version: '', origin: {} },
      asciidoc: { attributes: { 'page-layout': 'solutions-home' } }
    })
    const [record] = runSolutions(page)
    expect(record.type).toBe('Solution')
    expect(record.title).toBe('Redpanda Solutions')
    expect(record.intro).toBe('Runnable Redpanda solutions')
    expect(record.stepId).toBe('')
  })

  const TRAIL = [['/', 'Home'], ['/solutions/', 'Solutions'], ['/solutions/leaderboard/', 'Leaderboard'], ['/solutions/leaderboard/start-environment/', 'Start the environment']]
  const trailHtml = () => '<nav class="breadcrumbs"><ul>' +
    TRAIL.map(([u, t]) => `<li><a href="${u}">${t}</a></li>`).join('') + '</ul></nav>'
  // The layout renders the trail in the toolbar and again inside article.doc.
  const stepHtml = (h1) => `<html><body><div class="toolbar">${trailHtml()}</div>` +
    `<article class="doc">${trailHtml()}<h1>${h1}</h1><div class="paragraph"><p>Do it.</p></div></article></body></html>`

  function solutionPage ({ url, relative, attrs, html }) {
    return makePage(html, {
      out: { dirname: url.replace(/^\/|\/$/g, ''), basename: 'index.html' },
      pub: { url },
      src: { component: 'solutions', version: '', relative, origin: {} },
      asciidoc: { attributes: attrs }
    })
  }

  const RECORD = JSON.stringify({
    id: 'leaderboard',
    title: 'Multiplayer game events with a live leaderboard',
    duration: 50,
    useCases: ['Event-driven microservices'],
    industries: ['Gaming']
  })

  const stepAttrs = (extra = {}) => ({
    'page-layout': 'solution-step',
    'page-solution': RECORD,
    'page-solution-id': 'leaderboard',
    'page-solution-title': 'Multiplayer game events with a live leaderboard',
    'page-solution-step-id': 'start-environment',
    'page-solution-duration': '50',
    ...extra
  })

  test('breadcrumbs come from the article only, so the trail is not doubled', () => {
    const [record] = runSolutions(solutionPage({
      url: '/solutions/leaderboard/start-environment/',
      relative: 'start-environment.adoc',
      attrs: stepAttrs(),
      html: stepHtml('Start the environment')
    }))
    expect(record.breadcrumbs.map((b) => b.t)).toEqual(TRAIL.map(([, t]) => t))
    expect(record.breadcrumbs.map((b) => b.u)).toEqual(TRAIL.map(([u]) => u.replace(/\/$/, '') || '/'))
  })

  test('breadcrumbs are not doubled on Doc records either', () => {
    const [record] = runIndex(makePage(stepHtml('Doc')))
    expect(record.breadcrumbs).toHaveLength(TRAIL.length)
  })

  test('step records carry solutionTitle so identical step titles can be told apart', () => {
    const [record] = runSolutions(solutionPage({
      url: '/solutions/leaderboard/start-environment/',
      relative: 'start-environment.adoc',
      attrs: stepAttrs(),
      html: stepHtml('Start the environment')
    }))
    expect(record.title).toBe('Start the environment')
    expect(record.solutionTitle).toBe('Multiplayer game events with a live leaderboard')
  })

  test('a step with no duration of its own gets null, never the solution total', () => {
    const [record] = runSolutions(solutionPage({
      url: '/solutions/leaderboard/start-environment/',
      relative: 'start-environment.adoc',
      attrs: stepAttrs(),
      html: stepHtml('Start the environment')
    }))
    expect(record.duration).toBeNull()
  })

  test('the overview record carries useCases and industries, searchable through keywords', () => {
    const attrs = stepAttrs({ 'page-layout': 'solution' })
    delete attrs['page-solution-step-id']
    const html = '<html><head><meta name="keywords" content="leaderboard"><meta name="description" content="Build it"></head>' +
      '<body><h1>Multiplayer game events with a live leaderboard</h1></body></html>'
    const [record] = runSolutions(solutionPage({ url: '/solutions/leaderboard/', relative: 'index.adoc', attrs, html }))
    expect(record.stepId).toBe('')
    expect(record.duration).toBe(50)
    expect(record.useCases).toEqual(['Event-driven microservices'])
    expect(record.industries).toEqual(['Gaming'])
    expect(record.keywords).toEqual(['leaderboard', 'Event-driven microservices', 'Gaming'])
  })

  test('step records do not repeat the solution facets', () => {
    const [record] = runSolutions(solutionPage({
      url: '/solutions/leaderboard/start-environment/',
      relative: 'start-environment.adoc',
      attrs: stepAttrs(),
      html: stepHtml('Start the environment')
    }))
    expect(record.useCases).toBeUndefined()
    expect(record.industries).toBeUndefined()
    expect(record.keywords).toEqual([])
  })

  test('non-solutions components still produce Doc records', () => {
    const page = makePage(buildArticle({ h1: 'Doc' }))
    const [record] = runIndex(page)
    expect(record.type).toBe('Doc')
    expect(record.solutionId).toBeUndefined()
  })
})
