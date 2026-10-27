'use strict'

const fs = require('fs')
const path = require('path')
const { parseTaxonomy } = require('../../extension-utils/taxonomy')
const { parseHeader } = require('../../tools/check-metadata')
const {
  buildMatcher,
  matchText,
  pageParts,
  parseCardinality,
  suggestForPage,
  DEFAULT_MIN_SCORE,
  DEFAULT_LIMIT,
} = require('../../extension-utils/metadata-suggest')

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'taxonomy')
const taxonomy = parseTaxonomy(fs.readFileSync(path.join(FIXTURES, 'taxonomy.yml'), 'utf8'))

// A small taxonomy for the cases the fixture does not cover: a two-letter
// label, a longer label that contains a shorter one, and a tight cardinality.
const small = parseTaxonomy(`
schema-version: 1
schemes:
  - id: topic
    cardinality: { docs: 0-1 }
    concepts:
      - { id: security, prefLabel: Security }
      - { id: monitoring, prefLabel: Monitoring }
      - { id: connectors, prefLabel: Connectors }
  - id: technology
    cardinality: { docs: 0-n, solutions: 1-n }
    concepts:
      - { id: go, prefLabel: Go, altLabels: [Golang] }
      - { id: apache-kafka, prefLabel: Apache Kafka, altLabels: [Kafka] }
      - { id: kafka-connect, prefLabel: Kafka Connect }
`)

const suggest = (content, options = {}) => suggestForPage(content, { taxonomy, parseHeader, ...options })
const ids = (result) => result.suggestions.map((s) => s.conceptId)

describe('matchText', () => {
  const matcher = buildMatcher(taxonomy)
  const smallMatcher = buildMatcher(small)

  test('matches labels case-insensitively on word boundaries', () => {
    expect(matchText(matcher, 'Read from postgres and RPK').map((h) => h.ids[0])).toEqual(['postgresql', 'rpk'])
    expect(matchText(matcher, 'postgresqlx and rpkx')).toEqual([])
  })

  test('splits code literals into words, so postgres_cdc names PostgreSQL and CDC', () => {
    const hits = matchText(matcher, 'the `postgres_cdc` input')
    expect(hits.map((h) => h.ids[0])).toEqual(['postgresql', 'change-data-capture'])
    expect(hits.map((h) => h.via)).toEqual(['altLabel', 'altLabel'])
  })

  test('folds a plural s on both sides', () => {
    expect(matchText(smallMatcher, 'a connector').map((h) => h.ids[0])).toEqual(['connectors'])
  })

  test('prefers the longest label at a position', () => {
    expect(matchText(smallMatcher, 'Run Kafka Connect next to Kafka').map((h) => h.ids[0])).toEqual(['kafka-connect', 'apache-kafka'])
  })

  test('matches a two-letter label only in its exact case and not at a sentence start', () => {
    const got = (text) => matchText(smallMatcher, text).map((h) => h.ids[0])
    expect(got('Write a Go service.')).toEqual(['go'])
    expect(got('Go to Settings.')).toEqual([])
    expect(got('Save it. Go to Settings.')).toEqual([])
    expect(got('let it go')).toEqual([])
    expect(got('use golang')).toEqual(['go'])
  })

  test('sends a deprecated label to its live replacement and never to the deprecated concept', () => {
    const hits = matchText(matcher, 'About Data Replication and Integration')
    expect(hits).toEqual([expect.objectContaining({ ids: ['replication'], via: 'deprecated-label' })])
  })

  test('does not match task, content-type, or deployment labels', () => {
    expect(matchText(matcher, 'Day-2 operations on Kubernetes in Redpanda Cloud: a concept')).toEqual([])
  })
})

describe('pageParts', () => {
  test('separates the title, description, path, headings, and body, and drops link targets and attribute references', () => {
    const parts = pageParts(`= Secure it
:description: How to secure it.
:page-categories: Security

Intro with xref:manage:security/tls.adoc[a link] and {attr}.

== Monitoring

[source,go]
----
fmt.Println("x")
----
`, parseHeader, { file: 'modules/manage/pages/security/tls.adoc' })
    expect(parts.title).toEqual({ text: 'Secure it', line: 1 })
    expect(parts.description.line).toBe(2)
    expect(parts.path.text).toBe('manage / security / tls')
    expect(parts.headings).toEqual([{ text: 'Monitoring', line: 7 }])
    expect(parts.body.map((b) => b.text).join(' ')).not.toMatch(/manage:security|attr/)
    expect(parts.body.find((b) => b.sourceLanguage)).toEqual({ text: '', line: 9, sourceLanguage: 'go' })
  })

  test('reads included partials, with their own line numbers, limited to the selected tags', () => {
    const readInclude = jest.fn((target) => (target === 'partial$shared.adoc'
      ? { file: 'modules/ROOT/partials/shared.adoc', content: 'skip me\n// tag::a[]\n== Tiered Storage\n// end::a[]\n' }
      : null))
    const parts = pageParts('= Page\n\ninclude::partial$shared.adoc[tag=a]\ninclude::example$x.yaml[]\n', parseHeader, { readInclude })
    expect(parts.headings).toEqual([{ text: 'Tiered Storage', line: 3, source: 'modules/ROOT/partials/shared.adoc' }])
    expect(parts.body).toEqual([])
  })
})

describe('suggestForPage', () => {
  test('suggests concepts the text names, with score, reason, and evidence', () => {
    const r = suggest(`= Tiered Storage
:description: Offload to Tiered Storage.

Tiered Storage keeps data. Tiered Storage again.
`)
    expect(r.kind).toBe('docs')
    expect(r.suggestions).toEqual([expect.objectContaining({
      facet: 'topic',
      attribute: 'page-categories',
      conceptId: 'tiered-storage',
      label: 'Tiered Storage',
      reason: 'named in the title, the description and 2 body mentions',
    })])
    const [s] = r.suggestions
    expect(s.score).toBeGreaterThan(DEFAULT_MIN_SCORE.docs)
    expect(s.evidence.map((e) => [e.location, e.line])).toEqual([['title', 1], ['description', 2], ['body', 4]])
    expect(s.evidence[0]).toEqual(expect.objectContaining({ term: 'Tiered Storage', label: 'Tiered Storage', via: 'prefLabel' }))
  })

  test('weights title over description over headings over body', () => {
    const scoreIn = (content) => suggest(content, { minScore: 0 }).suggestions.find((s) => s.conceptId === 'security').score
    const title = scoreIn('= Security\n\nx\n')
    const description = scoreIn('= X\n:description: Security\n\nx\n')
    const heading = scoreIn('= X\n\n== Security\n')
    const body = scoreIn('= X\n\nSecurity.\n')
    expect(title).toBeGreaterThan(description)
    expect(description).toBeGreaterThan(heading)
    expect(heading).toBeGreaterThan(body)
  })

  test('counts the page path', () => {
    const r = suggest('= X\n\nx\n', { file: 'modules/manage/pages/tiered-storage/index.adoc' })
    expect(ids(r)).toEqual(['tiered-storage'])
    expect(r.suggestions[0].evidence[0].location).toBe('path')
  })

  test('honors --min-score and keeps a passing mention out by default', () => {
    const page = '= X\n\nSecurity is mentioned once.\n'
    expect(ids(suggest(page))).toEqual([])
    expect(ids(suggest(page, { minScore: 0 }))).toEqual(['security'])
  })

  test('skips what the page already carries, and what that implies', () => {
    const r = suggest(`= Iceberg Topics and Replication
:page-categories: Iceberg Topics, Replication

== Apache Iceberg
== High Availability
`)
    expect(ids(r)).toEqual([])
    expect(r.existing['page-categories']).toEqual(['iceberg-topics', 'replication'])
  })

  test('resolves deprecated carried values before skipping', () => {
    const r = suggest('= Iceberg Topics\n:page-categories: Iceberg\n\nx\n')
    expect(ids(r)).not.toContain('iceberg-topics')
  })

  test('never suggests a deprecated concept', () => {
    const r = suggest('= Data Replication\n:description: Integration with Data Replication.\n\n== Integration\n', { minScore: 0 })
    expect(ids(r)).toEqual(['replication'])
    expect(r.suggestions[0].evidence[0].via).toBe('deprecated-label')
    for (const s of r.suggestions) expect(taxonomy.get(s.conceptId).deprecated).toBe(false)
  })

  test('respects implies: Iceberg Topics implies Apache Iceberg in the same attribute', () => {
    const r = suggest('= Iceberg Topics\n:description: Apache Iceberg tables from Iceberg Topics.\n\nx\n')
    expect(ids(r)).toEqual(['iceberg-topics'])
    expect(r.suggestions[0].implies).toEqual([{ conceptId: 'apache-iceberg', label: 'Apache Iceberg', facet: 'technology' }])
  })

  test('prefers a narrower concept over its broader one', () => {
    const r = suggest('= Replication and High Availability\n:description: High Availability through Replication.\n\nx\n')
    expect(ids(r)).toEqual(['replication'])
    expect(r.suggestions[0].implies.map((i) => i.conceptId)).toEqual(['high-availability'])
  })

  test('stays within the facet cardinality, counting carried values', () => {
    const page = '= Security and Monitoring\n:description: Security, Monitoring, Connectors.\n\nx\n'
    const free = suggestForPage(page, { taxonomy: small, parseHeader })
    expect(free.suggestions.filter((s) => s.facet === 'topic')).toHaveLength(1)
    const full = suggestForPage(`= X\n:page-categories: Security\n${page.split('\n').slice(1).join('\n')}`, { taxonomy: small, parseHeader })
    expect(full.suggestions.filter((s) => s.facet === 'topic')).toEqual([])
  })

  test('caps each facet at --limit', () => {
    const page = '= Go and Kafka Connect and Apache Kafka\n\nx\n'
    expect(suggestForPage(page, { taxonomy: small, parseHeader, limit: 2 }).suggestions).toHaveLength(2)
    expect(DEFAULT_LIMIT.docs).toBe(3)
  })

  test('on a solution overview, suggests use cases and technologies in their own attributes', () => {
    const r = suggest(`= Change data capture from Postgres
:page-layout: solution
:page-solution-platforms: docker
:description: Capture Postgres changes with Redpanda Connect into Iceberg Topics.

Body names Postgres.
`)
    expect(r.kind).toBe('solution')
    const by = Object.fromEntries(r.suggestions.map((s) => [s.conceptId, s.attribute]))
    expect(by).toEqual({
      'change-data-capture': 'page-solution-use-cases',
      postgresql: 'page-solution-technologies',
      'redpanda-connect': 'page-solution-technologies',
      'iceberg-topics': 'page-categories',
      'apache-iceberg': 'page-solution-technologies',
    })
    const iceberg = r.suggestions.find((s) => s.conceptId === 'apache-iceberg')
    expect(iceberg).toEqual(expect.objectContaining({ impliedBy: 'iceberg-topics', reason: 'implied by Iceberg Topics, which the page is suggested' }))
  })

  test('on a solution overview, a carried topic still suggests the technology it implies', () => {
    const r = suggest('= X\n:page-layout: solution\n:page-categories: Iceberg Topics\n:page-solution-use-cases: CDC\n:page-solution-technologies: Postgres\n\nx\n')
    expect(ids(r)).toEqual(['apache-iceberg'])
    expect(r.needs).toEqual([])
  })

  test('treats a page with page-solution facets as a solution, and reports a required facet with no value', () => {
    const r = suggest('= X\n:page-solution-technologies: rpk\n\nx\n')
    expect(r.kind).toBe('solution')
    expect(r.needs).toEqual([expect.objectContaining({ facet: 'use-case', attribute: 'page-solution-use-cases', min: 1 })])
  })

  test('uses a lower default minimum score for solutions', () => {
    expect(DEFAULT_MIN_SCORE.solution).toBeLessThan(DEFAULT_MIN_SCORE.docs)
    const body = '\nThe service writes to Postgres. Postgres keeps it. Read Postgres, then Postgres again.\n'
    expect(ids(suggest(`= X\n:page-layout: solution\n${body}`))).toContain('postgresql')
    expect(ids(suggest(`= X\n${body}`))).toEqual([])
  })

  test('counts a source block language as a code literal', () => {
    const r = suggestForPage('= X\n\n[source,go]\n----\nx\n----\n\n[source,go]\n----\ny\n----\n', { taxonomy: small, parseHeader, minScore: 0 })
    expect(r.suggestions[0]).toEqual(expect.objectContaining({ conceptId: 'go', reason: 'named in 2 body mentions' }))
    expect(r.suggestions[0].evidence[0].via).toBe('source-language')
  })

  test('is deterministic', () => {
    const page = fs.readFileSync(path.join(__dirname, 'metadata-suggest.test.js'), 'utf8')
    expect(suggest(page, { minScore: 0 })).toEqual(suggest(page, { minScore: 0 }))
  })
})

describe('parseCardinality', () => {
  test('reads ranges with n as unbounded', () => {
    expect(parseCardinality('0-3')).toEqual({ min: 0, max: 3 })
    expect(parseCardinality('1-n')).toEqual({ min: 1, max: Infinity })
    expect(parseCardinality(undefined)).toEqual({ min: 0, max: Infinity })
  })
})
