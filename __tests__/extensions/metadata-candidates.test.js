'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseTaxonomy } = require('../../extension-utils/taxonomy')
const { parseHeader } = require('../../tools/check-metadata')
const { buildMatcher, pageParts } = require('../../extension-utils/metadata-suggest')
const { loadTerminology, pageCandidates, aggregateCandidates } = require('../../extension-utils/metadata-candidates')

const taxonomy = parseTaxonomy(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'taxonomy', 'taxonomy.yml'), 'utf8'))
const matcher = buildMatcher(taxonomy, { allLabels: true })
const candidates = (content, options) => pageCandidates(pageParts(content, parseHeader, { file: 'modules/a/pages/p.adoc' }), matcher, options)
const terms = (list) => list.map((c) => c.term)
const by = (list, term) => list.find((c) => c.term === term)

const PAGE = `= Stream changes into a lakehouse
:description: Capture changes with Debezium and write Parquet files.

Debezium reads the log. The pipeline writes Parquet files, and Debezium keeps offsets.
Parquet files land in Amazon S3, and Amazon S3 keeps them.
Use the \`postgres_cdc\` input or the \`aws_s3\` output, and \`aws_s3\` output again.
See xref:connect:components:outputs/sql_raw.adoc[] and xref:connect:components:outputs/sql_raw.adoc[the output].
Kubernetes and Kubernetes, PostgreSQL and PostgreSQL, Redpanda Connect and Redpanda Connect.
The Table shows a table. The Table again.
Snowflake catalog. Snowflake catalog.
Set \`retention_bytes\` and \`retention_bytes\`.

----
Ignored Literal Ignored Literal
----
`

describe('pageCandidates', () => {
  const found = candidates(PAGE)
  const by = Object.fromEntries(found.map((c) => [c.term, c]))

  test('finds repeated capitalized terms and component identifiers that no label matches', () => {
    expect(terms(found)).toEqual(expect.arrayContaining(['Debezium', 'Parquet', 'Amazon S3', 'aws_s3', 'sql_raw']))
  })

  test('each candidate has a count, lines, a facet, and the cue; a sentence-start mention is not counted', () => {
    expect(by.Debezium).toEqual({ term: 'Debezium', count: 2, lines: [{ line: 2 }, { line: 4 }], facet: null, cue: 'none' })
    expect(by.Parquet).toEqual(expect.objectContaining({ count: 2, facet: 'technology', cue: 'format-name' }))
    expect(by.aws_s3).toEqual(expect.objectContaining({ count: 2, lines: [{ line: 6 }], facet: 'technology', cue: 'connector-name' }))
    expect(by.sql_raw).toEqual(expect.objectContaining({ count: 2, facet: 'technology', cue: 'connector-name' }))
    expect(by['Amazon S3']).toEqual(expect.objectContaining({ count: 2, facet: null, cue: 'none' }))
    expect(candidates('= X\n\nWe use Remote Read Replicas, and Remote Read Replicas.\n')).toEqual([expect.objectContaining({ term: 'Remote Read Replicas', facet: 'topic', cue: 'title-case-name' })])
  })

  test('drops terms a label matches in any scheme, deprecated ones included', () => {
    for (const t of ['Kubernetes', 'PostgreSQL', 'Redpanda Connect', 'postgres_cdc']) expect(terms(found)).not.toContain(t)
    expect(terms(candidates('= X\n\nIceberg and Iceberg in a sentence.\n'))).toEqual([])
  })

  test('drops common English, words also written in lowercase, identifiers that are not components, and code blocks', () => {
    for (const t of ['Table', 'The Table', 'Use', 'retention_bytes', 'Ignored Literal']) expect(terms(found)).not.toContain(t)
  })

  test('drops a cue-less single word that only starts sentences', () => {
    expect(terms(candidates('= X\n\nFoo is here. Foo is there.\n'))).toEqual([])
    expect(terms(candidates('= X\n\nWe use Foo here and Foo there.\n'))).toEqual(['Foo'])
  })

  test('drops terms in the terminology list', () => {
    const t = new Set(['debezium', 'amazon s3'])
    expect(terms(candidates(PAGE, { terminology: t }))).not.toEqual(expect.arrayContaining(['Debezium']))
    expect(terms(candidates(PAGE, { terminology: t }))).not.toContain('Amazon S3')
  })

  test('needs minCount occurrences on the page', () => {
    expect(terms(candidates('= X\n\nWe use Foo once.\n'))).toEqual([])
    expect(terms(candidates('= X\n\nWe use Foo once.\n', { minCount: 1 }))).toEqual(['Foo'])
  })

  test('is deterministic', () => {
    expect(candidates(PAGE)).toEqual(candidates(PAGE))
  })
})

describe('pageCandidates noise filters', () => {
  // The noise a corpus-wide run surfaced: the product name, SQL keywords, a
  // stop word from a Connect xref, Kubernetes kinds, and sales boilerplate.
  const NOISY = `= Connect to the database

We run Redpanda here, and Redpanda there. Redpanda Data builds it.
The query returns NULL when a row is missing, and NULL again. Use GROUP BY and GROUP BY.
See xref:connect:components:inputs/about.adoc[] and xref:connect:components:inputs/about.adoc[about inputs].
See xref:connect:components:processors/mapping.adoc[] and xref:connect:components:processors/mapping.adoc[].
See xref:connect:components:outputs/cache.adoc[] and xref:connect:components:outputs/cache.adoc[].
Each of the Pods restarts, and the Pods come back. A PersistentVolumeClaim binds, and the PersistentVolumeClaim stays.
Expose it through a NodePort Service, or a second NodePort Service. Two StorageClasses, and StorageClasses again.
To get a license, contact Redpanda Sales. For a trial license, contact Redpanda Sales.
This feature requires an Enterprise Edition license. Enterprise Edition licenses are sold by your account team.
We deploy with Redpanda Terraform, and Terraform again.
See xref:connect:components:outputs/redis.adoc[] and xref:connect:components:outputs/redis.adoc[]. Redis holds it.
`
  const found = candidates(NOISY, { max: Infinity })
  const got = terms(found)

  test.each([
    ['the product name', ['Redpanda', 'Redpanda Data', 'Data']],
    ['SQL and other language keywords', ['NULL', 'GROUP BY']],
    ['stop words, including a Connect component named with one', ['about', 'About']],
    ['Connect building blocks named with ordinary words', ['mapping', 'cache']],
    ['generic Kubernetes object kinds', ['Pods', 'PersistentVolumeClaim', 'NodePort Service', 'StorageClasses']],
    ['names that only appear in sales or licensing boilerplate', ['Redpanda Sales', 'Sales', 'Enterprise Edition']],
  ])('drops %s', (_name, noise) => {
    for (const t of noise) expect(got).not.toContain(t)
  })

  test('drops a label that starts with the product name, rather than what follows it', () => {
    const small = parseTaxonomy('schema-version: 1\nschemes:\n  - id: technology\n    concepts:\n      - { id: redpanda-console, prefLabel: Redpanda Console }\n')
    const parts = pageParts('= X\n\nWe use Redpanda Console, and Redpanda Console again.\n', parseHeader, {})
    expect(pageCandidates(parts, buildMatcher(small, { allLabels: true }))).toEqual([])
  })

  test('keeps what follows the product name, and a system named in a Connect xref', () => {
    expect(by(found, 'Terraform')).toEqual(expect.objectContaining({ count: 2 }))
    expect(by(found, 'redis')).toEqual(expect.objectContaining({ facet: 'technology', cue: 'connector-name' }))
  })

  test('a term mentioned outside a sales line is kept', () => {
    const page = '= X\n\nContact Redpanda Sales for a license.\nWe use Acme Widgets, and Acme Widgets.\nAcme Widgets license terms apply.\n'
    expect(terms(candidates(page))).toContain('Acme Widgets')
    expect(terms(candidates('= X\n\nAcme Widgets license, and the Acme Widgets license.\n'))).not.toContain('Acme Widgets')
  })
})

describe('aggregateCandidates', () => {
  test('lists each term with the pages it is on, most widespread first, and drops boilerplate', () => {
    const perPage = [
      { file: 'a.adoc', candidates: [{ term: 'Debezium', count: 2, lines: [{ line: 1 }], facet: null, cue: 'none' }] },
      { file: 'b.adoc', candidates: [{ term: 'Debezium', count: 1, lines: [{ line: 3 }], facet: 'technology', cue: 'connector-name' }, { term: 'Parquet', count: 5, lines: [{ line: 2 }], facet: 'technology', cue: 'format-name' }] },
      { file: 'c.adoc', candidates: [{ term: 'Once', count: 1, lines: [{ line: 2 }], facet: null, cue: 'none' }] },
    ]
    expect(aggregateCandidates(perPage)).toEqual([
      { term: 'Debezium', count: 3, pageCount: 2, facet: 'technology', cue: 'connector-name', pages: [{ file: 'a.adoc', count: 2, lines: [{ line: 1 }] }, { file: 'b.adoc', count: 1, lines: [{ line: 3 }] }] },
      { term: 'Parquet', count: 5, pageCount: 1, facet: 'technology', cue: 'format-name', pages: [{ file: 'b.adoc', count: 5, lines: [{ line: 2 }] }] },
    ])
    const many = Array.from({ length: 20 }, (_, i) => ({ file: `${i}.adoc`, candidates: [{ term: 'Everywhere', count: 1, lines: [{ line: 1 }], facet: null, cue: 'none' }] }))
    expect(aggregateCandidates(many)).toEqual([])
  })
})

describe('loadTerminology', () => {
  test('reads glossary partials, Markdown word lists except the brand list, and plain lists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminology-'))
    fs.mkdirSync(path.join(dir, 'terms'))
    fs.writeFileSync(path.join(dir, 'terms', 'acl.adoc'), '=== access control list (ACL)\n:term-name: ACL\n')
    fs.writeFileSync(path.join(dir, 'terminology.md'), '## General word list\n\n| Term | Description |\n|------|------|\n| `rpk` | x |\n| certificate authority (CA) | y |\n\n## Third-party brand word list\n\n| Term | Examples |\n|---|---|\n| Amazon S3 | z |\n')
    fs.writeFileSync(path.join(dir, 'extra.txt'), '# comment\nShadow Indexing\n')
    const { terms: t, sources } = loadTerminology([path.join(dir, 'terms'), path.join(dir, 'terminology.md'), path.join(dir, 'extra.txt'), path.join(dir, 'missing')])
    expect([...t].sort()).toEqual(['access control list', 'acl', 'ca', 'certificate authority', 'rpk', 'shadow indexing'])
    expect(sources).toHaveLength(3)
  })
})
