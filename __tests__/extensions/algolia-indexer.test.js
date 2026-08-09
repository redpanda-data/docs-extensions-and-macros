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
