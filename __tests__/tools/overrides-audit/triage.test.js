'use strict'

const triage = require('../../../tools/overrides-audit/triage')
const { VERDICTS } = triage

/**
 * Build a minimal valid triage candidate.
 *
 * @param {Object} fields - Fields to merge over the defaults.
 * @returns {Object} Candidate object.
 */
function candidate (fields = {}) {
  return {
    name: 'test_property',
    upstream_candidate_text: 'The override says this clearly.',
    source_text: 'The source says something else.',
    source_file: 'src/v/config/configuration.cc',
    source_line: 1000,
    ...fields
  }
}

describe('buildTriagePrompt', () => {
  test('contains the property name, both texts, and instructions for all three verdicts', () => {
    const prompt = triage.buildTriagePrompt(candidate())
    expect(prompt).toContain('test_property')
    expect(prompt).toContain('The override says this clearly.')
    expect(prompt).toContain('The source says something else.')
    expect(prompt).toContain('UPSTREAM_OVERRIDE')
    expect(prompt).toContain('RETIRE_OVERRIDE')
    expect(prompt).toContain('AMBIGUOUS')
  })

  test('instructs strict JSON with no markdown fences and no outside prose', () => {
    const prompt = triage.buildTriagePrompt(candidate())
    expect(prompt).toMatch(/strict JSON/i)
    expect(prompt).toMatch(/markdown code fences/i)
    expect(prompt).toContain('"verdict"')
    expect(prompt).toContain('"reason"')
  })

  test('instructs choosing AMBIGUOUS over guessing on uncertainty', () => {
    const prompt = triage.buildTriagePrompt(candidate())
    expect(prompt).toMatch(/AMBIGUOUS/)
    expect(prompt.toLowerCase()).toMatch(/uncertain/)
  })

  test('throws when upstream_candidate_text is missing', () => {
    const bad = candidate()
    delete bad.upstream_candidate_text
    expect(() => triage.buildTriagePrompt(bad)).toThrow(/upstream_candidate_text/)
  })

  test('throws when source_text is missing', () => {
    const bad = candidate()
    delete bad.source_text
    expect(() => triage.buildTriagePrompt(bad)).toThrow(/source_text/)
  })
})

describe('parseTriageResponse', () => {
  describe('valid responses pass through unchanged', () => {
    test.each([
      ['UPSTREAM_OVERRIDE', 'The override adds real detail the source text lacks.'],
      ['RETIRE_OVERRIDE', 'Source now says the same thing, so the override is no longer needed.'],
      ['AMBIGUOUS', 'Both texts add distinct information; a human should decide.']
    ])('%s', (verdict, reason) => {
      const raw = JSON.stringify({ verdict, reason })
      const result = triage.parseTriageResponse(raw)
      expect(result).toEqual({ verdict, reason, triageFailed: false })
    })

    test('unwraps a fenced JSON response that is otherwise valid', () => {
      const raw = '```json\n' + JSON.stringify({ verdict: 'UPSTREAM_OVERRIDE', reason: 'Clear improvement.' }) + '\n```'
      const result = triage.parseTriageResponse(raw)
      expect(result).toEqual({ verdict: 'UPSTREAM_OVERRIDE', reason: 'Clear improvement.', triageFailed: false })
    })

    test('unwraps a bare (unlabeled) fenced JSON response', () => {
      const raw = '```\n' + JSON.stringify({ verdict: 'RETIRE_OVERRIDE', reason: 'Source is now as good.' }) + '\n```'
      const result = triage.parseTriageResponse(raw)
      expect(result).toEqual({ verdict: 'RETIRE_OVERRIDE', reason: 'Source is now as good.', triageFailed: false })
    })
  })

  describe('failure modes all fall back to a safe AMBIGUOUS result', () => {
    test.each([
      ['null input', null],
      ['undefined input', undefined],
      ['empty string input', ''],
      ['whitespace-only input', '   \n  '],
      ['non-JSON prose', 'I think this override is fine and should probably be upstreamed, honestly.'],
      ['truncated/malformed JSON', '{"verdict": "UPSTREAM_OVERRIDE", "reason": "Cut off mid'],
      ['unbalanced braces', '{"verdict": "AMBIGUOUS", "reason": "Missing close"'],
      ['JSON array instead of object', JSON.stringify(['UPSTREAM_OVERRIDE', 'reason text'])],
      ['valid JSON with invalid verdict string', JSON.stringify({ verdict: 'MAYBE_UPSTREAM', reason: 'Not a real verdict.' })],
      ['valid JSON with a case-variant verdict', JSON.stringify({ verdict: 'upstream_override', reason: 'Lowercase should not be accepted.' })],
      ['valid JSON with missing verdict', JSON.stringify({ reason: 'No verdict field at all.' })],
      ['valid JSON with missing reason', JSON.stringify({ verdict: 'AMBIGUOUS' })],
      ['valid JSON with empty-string reason', JSON.stringify({ verdict: 'AMBIGUOUS', reason: '' })],
      ['valid JSON with non-string reason', JSON.stringify({ verdict: 'AMBIGUOUS', reason: 42 })]
    ])('%s', (_label, raw) => {
      const result = triage.parseTriageResponse(raw)
      expect(result.verdict).toBe(VERDICTS.AMBIGUOUS)
      expect(result.triageFailed).toBe(true)
      expect(typeof result.reason).toBe('string')
      expect(result.reason.length).toBeGreaterThan(0)
    })

    test('failure reasons are distinct and specific per failure mode', () => {
      const noResponse = triage.parseTriageResponse('')
      const badJson = triage.parseTriageResponse('not json at all {{{')
      const badVerdict = triage.parseTriageResponse(JSON.stringify({ verdict: 'NOPE', reason: 'x' }))
      const missingReason = triage.parseTriageResponse(JSON.stringify({ verdict: 'AMBIGUOUS' }))

      const reasons = [noResponse.reason, badJson.reason, badVerdict.reason, missingReason.reason]
      // Every failure mode gets its own specific explanation, not one generic
      // catch-all string reused everywhere.
      expect(new Set(reasons).size).toBe(reasons.length)
      expect(noResponse.reason.toLowerCase()).toMatch(/no response/)
      expect(badJson.reason.toLowerCase()).toMatch(/not valid json/)
      expect(badVerdict.reason.toLowerCase()).toMatch(/verdict/)
      expect(missingReason.reason.toLowerCase()).toMatch(/reason/)
    })
  })
})

describe('triageCandidate', () => {
  test('combines a candidate and a valid raw response, renaming fields to snake_case', () => {
    const raw = JSON.stringify({ verdict: 'UPSTREAM_OVERRIDE', reason: 'The override is clearer.' })
    const result = triage.triageCandidate(candidate(), raw)

    expect(result.name).toBe('test_property')
    expect(result.upstream_candidate_text).toBe('The override says this clearly.')
    expect(result.source_text).toBe('The source says something else.')
    expect(result.agent_verdict).toBe('UPSTREAM_OVERRIDE')
    expect(result.agent_reason).toBe('The override is clearer.')
    expect(result.triage_failed).toBe(false)
    // The camelCase parse-result shape must not leak onto the manifest row.
    expect(result.verdict).toBeUndefined()
    expect(result.reason).toBeUndefined()
    expect(result.triageFailed).toBeUndefined()
  })

  test('combines a candidate and a failed raw response, marking triage_failed', () => {
    const result = triage.triageCandidate(candidate(), 'garbage, not json')
    expect(result.agent_verdict).toBe('AMBIGUOUS')
    expect(result.triage_failed).toBe(true)
    expect(typeof result.agent_reason).toBe('string')
    expect(result.agent_reason.length).toBeGreaterThan(0)
    // Original candidate fields survive the merge.
    expect(result.name).toBe('test_property')
  })

  test('routes a RETIRE_OVERRIDE verdict on a SPLIT candidate to AMBIGUOUS', () => {
    const raw = JSON.stringify({ verdict: 'RETIRE_OVERRIDE', reason: 'Source has caught up.' })
    const result = triage.triageCandidate(candidate({ class: 'KEEP_UNTIL_UPSTREAMED' }), raw)
    expect(result.agent_verdict).toBe('AMBIGUOUS')
    expect(result.triage_failed).toBe(false)
    expect(result.agent_reason).toContain('Source has caught up.')
    expect(result.agent_reason).toMatch(/cannot be retired whole/)
  })

  test('keeps RETIRE_OVERRIDE for a non-SPLIT candidate and UPSTREAM_OVERRIDE for a SPLIT one', () => {
    const retire = JSON.stringify({ verdict: 'RETIRE_OVERRIDE', reason: 'Source has caught up.' })
    const upstream = JSON.stringify({ verdict: 'UPSTREAM_OVERRIDE', reason: 'Override is clearer.' })
    expect(triage.triageCandidate(candidate({ class: 'UPSTREAMABLE' }), retire).agent_verdict).toBe('RETIRE_OVERRIDE')
    expect(triage.triageCandidate(candidate({ class: 'KEEP_UNTIL_UPSTREAMED' }), upstream).agent_verdict).toBe('UPSTREAM_OVERRIDE')
  })
})
