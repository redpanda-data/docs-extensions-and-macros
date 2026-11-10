'use strict'

const { extractSuggestion, similarity, classify, perDeclaration, formatMarkdown } = require('../../../tools/doc-strings-review/acceptance-report')

// Shaped like the real cases from streaming-enterprise (PR 1414 and others):
// a configuration.cc declaration, the lines a suggestion was posted against,
// and the file as merged.
const ORIGINAL = [
  '  , consumer_offsets_topic_batch_cache_enabled(',
  '      *this,',
  '      "consumer_offsets_topic_batch_cache_enabled",',
  '      "Enables the batch cache for the consumer offsets topic. A change takes "',
  '      "effect without a restart, from each "',
  '      "consumer offsets partition\'s next log segment.",',
  '      {.needs_restart = needs_restart::no, .visibility = visibility::tunable},',
  '      true)'
].join('\n')
const SUGGESTION = [
  '  , consumer_offsets_topic_batch_cache_enabled(',
  '      *this,',
  '      "consumer_offsets_topic_batch_cache_enabled",',
  '      "Enables the batch cache for the `__consumer_offsets` topic, so that "',
  '      "reads of recently written offset commits are served from memory "',
  '      "instead of from disk. A change takes effect without a restart, from "',
  '      "each `__consumer_offsets` partition\'s next log segment.",',
  '      {.needs_restart = needs_restart::no, .visibility = visibility::tunable},',
  '      true)'
].join('\n')
const wrap = (decl) => ['// configuration.cc', '  , other_property(', '      *this,', '      "other_property",', '      "Something else.",', '      {},', '      1)', decl, '  , enable_shadow_linking(', '      *this,', '      true)'].join('\n')

describe('extractSuggestion', () => {
  it('reads the first suggestion block and nothing else', () => {
    const body = 'Clearer wording:\n\n```suggestion\nnew line\n```\n<sub>doc-strings-review:fp=7820439d2d7906c1</sub>'
    expect(extractSuggestion(body)).toBe('new line\n')
    expect(extractSuggestion('No block here.')).toBeNull()
  })
})

describe('similarity', () => {
  it('is 1 for the same words and 0 for none in common', () => {
    expect(similarity('a b c', 'a  b\nc')).toBe(1)
    expect(similarity('a b c', 'x y z')).toBe(0)
    expect(similarity('a b c d', 'a b x d')).toBeCloseTo(0.75)
  })
})

describe('classify', () => {
  it('taken: the merged file contains the suggestion', () => {
    expect(classify({ suggestion: SUGGESTION, original: ORIGINAL, final: wrap(SUGGESTION) })).toBe('taken')
  })

  it('declined: the original merged unchanged', () => {
    expect(classify({ suggestion: SUGGESTION, original: ORIGINAL, final: wrap(ORIGINAL) })).toBe('declined')
  })

  it('adapted: the suggestion, edited before merge', () => {
    const edited = SUGGESTION.replace('so that "', 'so "').replace('instead of from disk', 'instead of disk')
    expect(classify({ suggestion: SUGGESTION, original: ORIGINAL, final: wrap(edited) })).toBe('adapted')
  })

  it('rewritten: the author wrote their own version, nearer the original', () => {
    const own = ORIGINAL.replace('A change takes "', 'Changes apply "')
    expect(classify({ suggestion: SUGGESTION, original: ORIGINAL, final: wrap(own) })).toBe('rewritten')
  })

  it('unclear: a suggestion that only adds a trailing period cannot be told apart', () => {
    const orig = '      sm::description("Total size in bytes of the memtables in the L1 metastore LSM tree"),'
    const sugg = '      sm::description("Total size in bytes of the memtables in the L1 metastore LSM tree."),'
    const merged = '      sm::description("Total size in bytes of the active memtables in the L1 metastore LSM tree"),'
    expect(classify({ suggestion: sugg, original: orig, final: wrap(merged) })).toBe('unclear')
  })

  it('removed: the file is gone, or nothing like either version is left', () => {
    expect(classify({ suggestion: SUGGESTION, original: ORIGINAL, final: null })).toBe('removed')
    expect(classify({ suggestion: SUGGESTION, original: ORIGINAL, final: wrap('') })).toBe('removed')
  })

  it('finds an edited description even when its first quoted line changed', () => {
    // Metrics: the anchor a naive match would use is the description itself.
    const orig = '      sm::description(\n          "Number of LSM table cache misses for the L1 metastore database. "\n          "Counts every lookup that missed."),'
    const sugg = '      sm::description(\n          "Number of reads of the L1 metastore that missed the LSM table "\n          "cache and went to object storage."),'
    const merged = '      sm::description(\n          "Number of reads of the L1 metastore that missed the LSM table "\n          "cache."),'
    expect(classify({ suggestion: sugg, original: orig, final: wrap(merged) })).toBe('adapted')
  })
})

describe('perDeclaration', () => {
  it('keeps the last suggestion on each string', () => {
    const rows = [
      { repo: 'r', pr: 1, path: 'a.cc', decl: 'x', created: '2026-10-01T00:00:00Z', outcome: 'declined' },
      { repo: 'r', pr: 1, path: 'a.cc', decl: 'x', created: '2026-10-02T00:00:00Z', outcome: 'taken' },
      { repo: 'r', pr: 1, path: 'a.cc', decl: 'y', created: '2026-10-01T00:00:00Z', outcome: 'declined' }
    ]
    expect(perDeclaration(rows).map((r) => r.outcome).sort()).toEqual(['declined', 'taken'])
  })
})

describe('formatMarkdown', () => {
  it('states the rate over merged PRs only, and breaks it down by repo and surface', () => {
    const rows = [
      { repo: 'redpanda-data/streaming-enterprise', pr: 1, path: 'src/v/config/configuration.cc', surface: 'properties', decl: 'a', created: '2026-10-01T00:00:00Z', outcome: 'taken', replies: 0, url: 'u1' },
      { repo: 'redpanda-data/streaming-enterprise', pr: 1, path: 'src/v/config/configuration.cc', surface: 'properties', decl: 'b', created: '2026-10-01T00:00:00Z', outcome: 'declined', replies: 1, url: 'u2' },
      { repo: 'redpanda-data/connect', pr: 2, path: 'internal/impl/x.go', surface: 'connect', decl: 'c', created: '2026-11-01T00:00:00Z', outcome: 'open', replies: 0, url: 'u3' }
    ]
    const md = formatMarkdown(rows, { since: '2026-09-01', until: '2026-11-10' })
    expect(md).toMatch(/Of 2 suggestions on merged PRs, \*\*50% were taken or adapted\*\*/)
    expect(md).toMatch(/## By repo[\s\S]*\| streaming-enterprise \| 2 \| 50% \|/)
    expect(md).toMatch(/## By surface[\s\S]*\| properties \|/)
    expect(md).toMatch(/\| connect \| 1 \| - \|/)
    expect(md).toMatch(/\[streaming-enterprise#1\]\(u2\)/)
  })
})
