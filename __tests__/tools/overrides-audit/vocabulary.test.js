'use strict'

/**
 * The triage prompt and the report are shared by every audit surface. Each
 * surface has its own words for the thing it audits (vocabulary.js).
 *
 * The property wording must not move. The prompts that run for properties and
 * rpk were evaluated as written, so these tests pin their exact text by hash:
 * a change to the shared text fails here and has to be made on purpose, with
 * the evaluation it needs.
 */

const crypto = require('crypto')
const triage = require('../../../tools/overrides-audit/triage')
const report = require('../../../tools/overrides-audit/report')
const { vocabulary, DEFAULT } = require('../../../tools/overrides-audit/vocabulary')

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)

const candidate = {
  name: 'log_segment_ms',
  upstream_candidate_text: 'Override text.',
  source_text: 'Source text.',
  source_file: 'src/v/config/configuration.cc',
  source_line: 12
}
const triaged = [
  { ...candidate, agent_verdict: 'UPSTREAM_OVERRIDE', agent_reason: 'Better.', triage_failed: false },
  { ...candidate, name: 'b', agent_verdict: 'AMBIGUOUS', agent_reason: 'Unclear.', triage_failed: false },
  { ...candidate, name: 'c', agent_verdict: 'RETIRE_OVERRIDE', agent_reason: 'Caught up.', triage_failed: false }
]

describe('audit vocabulary', () => {
  describe('the property wording is unchanged', () => {
    test('triage prompt', () => {
      expect(hash(triage.buildTriagePrompt(candidate))).toBe('ca56b878fefdfb7f')
    })

    test.each([
      ['buildUpstreamSection', '35750b9b84ddb79f', 'a07ab569758e5564'],
      ['buildRetirementSection', '27ac977505cfc669', '100d1964a2bee275'],
      ['buildAmbiguousDigest', 'c2df7c5bd99b1a6b', '8981e1ea183ddeb8'],
      ['buildUnlocatableSection', 'd9552f31f089870d', 'd9552f31f089870d']
    ])('%s, with candidates and with none', (builder, withRows, empty) => {
      expect(hash(report[builder](triaged))).toBe(withRows)
      expect(hash(report[builder]([]))).toBe(empty)
    })

    test('an unknown surface gets the property wording', () => {
      expect(vocabulary('no-such-surface')).toBe(DEFAULT)
      expect(vocabulary(undefined)).toBe(DEFAULT)
    })
  })

  describe('the metrics wording', () => {
    const metric = { ...candidate, name: 'redpanda_cluster_brokers', surface: 'metrics' }
    const prompt = triage.buildTriagePrompt(metric)

    test('the triage prompt speaks of a metric, never of a property', () => {
      expect(prompt).toContain('You are triaging one metric description for a documentation team.')
      expect(prompt).toContain('reference docs for a metric named "redpanda_cluster_brokers"')
      expect(prompt).not.toMatch(/property/i)
    })

    test('the triage prompt says a help string takes no terminal period', () => {
      expect(prompt).toContain('A help string takes no terminal period')
    })

    test('the rest of the triage prompt is the property prompt', () => {
      const property = triage.buildTriagePrompt({ ...metric, surface: undefined })
      const tail = (text) => text.slice(text.indexOf('Your job is to compare'))
      expect(tail(prompt)).toBe(tail(property))
    })

    test('the report counts metric descriptions, from the rows or from the surface given', () => {
      const rows = triaged.map((row) => ({ ...row, surface: 'metrics' }))
      expect(report.buildUpstreamSection(rows)).toContain('Found 1 metric description worth porting upstream')
      expect(report.buildAmbiguousDigest(rows)).toContain('1 metric description could not be confidently triaged')
      expect(report.buildUpstreamSection([], { surface: 'metrics' })).toBe('Nothing to report: no metric descriptions to upstream this run.')
      expect(report.buildAmbiguousDigest([], { surface: 'metrics' })).toBe('Nothing to report: no ambiguous metric descriptions this run.')
    })
  })
})
