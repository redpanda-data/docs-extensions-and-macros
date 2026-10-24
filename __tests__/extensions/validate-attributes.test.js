'use strict'

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const { parseTaxonomy } = require('../../extension-utils/taxonomy')

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'taxonomy')
const VALID = yaml.load(fs.readFileSync(path.join(FIXTURES, 'valid-categories.yml'), 'utf8'))['page-valid-categories']
const TAXONOMY = parseTaxonomy(fs.readFileSync(path.join(FIXTURES, 'taxonomy.yml')))

function page (categories, { component = 'streaming', relative = `${categories.replace(/\W+/g, '-')}.adoc` } = {}) {
  return {
    src: { component, relative },
    asciidoc: { attributes: { 'page-categories': categories, 'page-relative-src-path': relative } },
  }
}

/** Run validate-attributes over pages; `taxonomy: null` stands for a build without taxonomy.yml. */
async function run (pages, { taxonomy = TAXONOMY } = {}) {
  const lines = { warn: [], debug: [], info: [] }
  const logger = { warn: (m) => lines.warn.push(m), debug: (m) => lines.debug.push(m), info: (m) => lines.info.push(m), error: () => {} }
  const handlers = {}
  const context = { getLogger: () => logger, on: (event, fn) => { handlers[event] = fn; return context } }
  require('../../extensions/validate-attributes').register.call(context, { config: {} })
  const siteCatalog = { attributeFile: { 'page-valid-categories': VALID }, taxonomy }
  const contentCatalog = { findBy: () => pages }
  await handlers.documentsConverted({ contentCatalog, siteCatalog })
  return lines
}

describe('validate-attributes with the taxonomy', () => {
  test('legacy values produce exactly the old page-categories', async () => {
    const withTaxonomy = page('Iceberg, Security')
    const without = page('Iceberg, Security')
    await run([withTaxonomy])
    await run([without], { taxonomy: null })
    expect(withTaxonomy.asciidoc.attributes['page-categories']).toBe('Iceberg, Security, Deployment, Management')
    expect(withTaxonomy.asciidoc.attributes['page-categories']).toBe(without.asciidoc.attributes['page-categories'])
  })

  test('keeps the authored list for the taxonomy, before parents are added', async () => {
    const p = page('Iceberg, Security')
    await run([p])
    expect(p.asciidoc.attributes['page-categories-authored']).toBe('Iceberg, Security')
  })

  test('new labels map back to their legacy category and are not reported invalid', async () => {
    const p = page('Iceberg Topics, Replication')
    const lines = await run([p])
    expect(p.asciidoc.attributes['page-categories']).toBe('Iceberg, Data Replication, Deployment, High Availability')
    expect(lines.warn.filter((w) => /Invalid categor/.test(w))).toEqual([])
  })

  test('a label that differs from a legacy category only in case keeps the legacy spelling', async () => {
    const p = page('Disaster recovery, Stream processing')
    const lines = await run([p])
    const legacy = page('Disaster Recovery, Stream Processing')
    await run([legacy])
    expect(p.asciidoc.attributes['page-categories']).toBe('Disaster Recovery, Stream Processing, High Availability')
    expect(p.asciidoc.attributes['page-categories']).toBe(legacy.asciidoc.attributes['page-categories'])
    expect(lines.warn).toEqual([])
  })

  test('a value only the taxonomy knows, with no legacy label, is dropped from page-categories without a warning', async () => {
    const p = page('Security, Postgres')
    const lines = await run([p])
    expect(p.asciidoc.attributes['page-categories']).toBe('Security, Management')
    expect(lines.warn).toEqual([])
  })

  test('deprecated values warn once per value, not once per page', async () => {
    const pages = [page('Iceberg', { relative: 'a.adoc' }), page('Iceberg, Integration', { relative: 'b.adoc' }), page('Management', { relative: 'c.adoc' })]
    const lines = await run(pages)
    expect(lines.warn).toEqual([
      "page-categories value 'Iceberg' is deprecated; use 'Iceberg Topics' instead (2 pages): streaming:a.adoc, streaming:b.adoc",
      "page-categories value 'Integration' is deprecated; no single value replaces it; see its definition in taxonomy.yml and choose per page (1 page): streaming:b.adoc",
      "page-categories value 'Management' is deprecated; use 'Operate' instead (1 page): streaming:c.adoc",
    ])
  })

  test('labs and solutions pages are left to the legacy check', async () => {
    const labs = page('Iceberg', { component: 'labs' })
    const solution = page('Iceberg, Deployment', { component: 'solutions' })
    const lines = await run([labs, solution])
    expect(lines.warn).toEqual([])
    expect(labs.asciidoc.attributes['page-categories']).toBe('Iceberg, Deployment')
    expect(solution.asciidoc.attributes['page-categories-authored']).toBeUndefined()
  })

  test('an unknown value still warns per page and is dropped, as before', async () => {
    const p = page('Security, Nonsense')
    const lines = await run([p])
    expect(p.asciidoc.attributes['page-categories']).toBe('Security, Management')
    expect(lines.warn[0]).toBe("Invalid category 'Nonsense' in Security-Nonsense.adoc")
    expect(lines.warn[1]).toMatch(/^Invalid categories detected/)
  })

  test('a legacy category missing from the taxonomy is reported as a gap and kept', async () => {
    const p = page('Troubleshooting')
    const lines = await run([p])
    expect(p.asciidoc.attributes['page-categories']).toBe('Troubleshooting')
    expect(lines.warn).toEqual(["page-categories value 'Troubleshooting' is in valid-categories.yml but not in taxonomy.yml; add it to the taxonomy (1 page): streaming:Troubleshooting.adoc"])
  })

  test('two values that are one concept warn, as the PR check does', async () => {
    const lines = await run([page('Iceberg, Iceberg Topics', { relative: 'd.adoc' })])
    expect(lines.warn).toContain("page-categories value 'Iceberg Topics' is the same concept as page-categories value 'Iceberg': Iceberg Topics (topic). Keep one (1 page): streaming:d.adoc")
  })

  test('a drifting page-topic-type warns', async () => {
    const p = page('Security', { relative: 'e.adoc' })
    p.asciidoc.attributes['page-topic-type'] = 'concepts'
    const lines = await run([p])
    expect(lines.warn).toEqual(["page-topic-type 'concepts' should be the ID concept (1 page): streaming:e.adoc"])
  })

  test('a page with no categories still gets its page-topic-type checked', async () => {
    const p = { src: { component: 'streaming', relative: 'f.adoc' }, asciidoc: { attributes: { 'page-topic-type': 'concepts', 'page-relative-src-path': 'f.adoc' } } }
    const lines = await run([p])
    expect(lines.warn).toEqual(["page-topic-type 'concepts' should be the ID concept (1 page): streaming:f.adoc"])
    expect(p.asciidoc.attributes['page-categories-authored']).toBeUndefined()
    // Control: a valid content type on an uncategorized page is silent.
    const ok = { src: { component: 'streaming', relative: 'g.adoc' }, asciidoc: { attributes: { 'page-topic-type': 'concept' } } }
    expect((await run([ok])).warn).toEqual([])
  })

  test('without taxonomy.yml the behavior is unchanged and no authored copy is written', async () => {
    const p = page('Iceberg Topics, Security')
    const lines = await run([p], { taxonomy: null })
    expect(p.asciidoc.attributes['page-categories']).toBe('Security, Management')
    expect(p.asciidoc.attributes['page-categories-authored']).toBeUndefined()
    expect(lines.warn[0]).toBe("Invalid category 'Iceberg Topics' in Iceberg-Topics-Security.adoc")
  })
})
