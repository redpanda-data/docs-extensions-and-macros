'use strict'

const report = require('../../../tools/overrides-audit/report')

/**
 * Build a minimal triaged candidate row (the shape triage.js's
 * triageCandidate produces).
 *
 * @param {Object} fields - Fields to merge over the defaults.
 * @returns {Object} Triaged candidate row.
 */
function triaged (fields = {}) {
  return {
    name: 'retention_ms',
    upstream_candidate_text: 'How long to retain data, in milliseconds.',
    source_text: 'Retention period.',
    source_file: 'src/v/config/configuration.cc',
    source_line: 1000,
    agent_verdict: 'AMBIGUOUS',
    agent_reason: 'Both texts add real information.',
    triage_failed: false,
    ...fields
  }
}

describe('buildUpstreamSection', () => {
  test('empty array produces a non-empty "nothing this run" string', () => {
    const out = report.buildUpstreamSection([])
    expect(typeof out).toBe('string')
    expect(out.length).toBeGreaterThan(0)
    expect(out.toLowerCase()).toMatch(/nothing|no .*upstream/)
  })

  test('a single candidate includes the property name, the reason, and the closing sentence', () => {
    const row = triaged({
      name: 'retention_ms',
      agent_verdict: 'UPSTREAM_OVERRIDE',
      agent_reason: 'The override explains units the source text omits.'
    })
    const out = report.buildUpstreamSection([row])
    expect(out).toContain('retention_ms')
    expect(out).toContain('The override explains units the source text omits.')
    expect(out).toContain('This PR ports that into the source description')
    expect(out).toContain('becomes redundant and retires itself automatically')
  })

  test('a multi-candidate case includes all candidates and only UPSTREAM_OVERRIDE ones', () => {
    const a = triaged({ name: 'prop_a', agent_verdict: 'UPSTREAM_OVERRIDE', agent_reason: 'Reason A.' })
    const b = triaged({ name: 'prop_b', agent_verdict: 'UPSTREAM_OVERRIDE', agent_reason: 'Reason B.' })
    const c = triaged({ name: 'prop_c', agent_verdict: 'RETIRE_OVERRIDE', agent_reason: 'Reason C.' })
    const out = report.buildUpstreamSection([a, b, c])
    expect(out).toContain('prop_a')
    expect(out).toContain('prop_b')
    expect(out).not.toContain('prop_c')
  })

  test('excludes a triage_failed row even when its agent_verdict is UPSTREAM_OVERRIDE', () => {
    const row = triaged({ name: 'failed_prop', agent_verdict: 'UPSTREAM_OVERRIDE', triage_failed: true })
    const out = report.buildUpstreamSection([row])
    expect(out).not.toContain('failed_prop')
    expect(out.toLowerCase()).toMatch(/nothing/)
  })

  test.each([
    ['missing', undefined],
    ['null', null],
    ['a string', 'false'],
    ['a number', 0]
  ])('excludes an UPSTREAM_OVERRIDE row whose triage_failed is %s', (_label, value) => {
    const row = triaged({ name: 'unknown_state_prop', agent_verdict: 'UPSTREAM_OVERRIDE', triage_failed: value })
    if (value === undefined) delete row.triage_failed
    const out = report.buildUpstreamSection([row])
    expect(out).not.toContain('unknown_state_prop')
    expect(out.toLowerCase()).toMatch(/nothing/)
  })

  test('a SPLIT row says the override stays after the prose ships', () => {
    const split = triaged({ name: 'split_prop', class: 'KEEP_UNTIL_UPSTREAMED', agent_verdict: 'UPSTREAM_OVERRIDE' })
    const plain = triaged({ name: 'plain_prop', class: 'UPSTREAMABLE', agent_verdict: 'UPSTREAM_OVERRIDE' })
    const splitOut = report.buildUpstreamSection([split])
    expect(splitOut).toContain('The docs override stays after it ships')
    expect(splitOut).not.toContain('retires itself automatically')
    expect(report.buildUpstreamSection([plain])).toContain('retires itself automatically')
  })
})

describe('buildRetirementSection', () => {
  test('empty array produces a non-empty "nothing this run" string', () => {
    const out = report.buildRetirementSection([])
    expect(typeof out).toBe('string')
    expect(out.length).toBeGreaterThan(0)
    expect(out.toLowerCase()).toMatch(/nothing|no .*retire/)
  })

  test('a single candidate includes the property name, reason, both texts, and the closing bolded sentence', () => {
    const row = triaged({
      name: 'segment_bytes',
      agent_verdict: 'RETIRE_OVERRIDE',
      agent_reason: 'Source now says the same thing as the override.',
      upstream_candidate_text: 'Override wording.',
      source_text: 'Source wording.'
    })
    const out = report.buildRetirementSection([row])
    expect(out).toContain('segment_bytes')
    expect(out).toContain('Source now says the same thing as the override.')
    expect(out).toContain('Override wording.')
    expect(out).toContain('Source wording.')
    expect(out).toContain('**Retiring this override; docs will now render source\'s description.**')
  })

  test('a multi-candidate case includes all candidates and only RETIRE_OVERRIDE ones', () => {
    const a = triaged({ name: 'prop_a', agent_verdict: 'RETIRE_OVERRIDE', agent_reason: 'Reason A.' })
    const b = triaged({ name: 'prop_b', agent_verdict: 'RETIRE_OVERRIDE', agent_reason: 'Reason B.' })
    const c = triaged({ name: 'prop_c', agent_verdict: 'UPSTREAM_OVERRIDE', agent_reason: 'Reason C.' })
    const out = report.buildRetirementSection([a, b, c])
    expect(out).toContain('prop_a')
    expect(out).toContain('prop_b')
    expect(out).not.toContain('prop_c')
  })

  test.each([
    ['missing', undefined],
    ['null', null],
    ['a string', 'false'],
    ['a number', 0]
  ])('excludes a RETIRE_OVERRIDE row whose triage_failed is %s', (_label, value) => {
    const row = triaged({ name: 'unknown_state_prop', agent_verdict: 'RETIRE_OVERRIDE', triage_failed: value })
    if (value === undefined) delete row.triage_failed
    const out = report.buildRetirementSection([row])
    expect(out).not.toContain('unknown_state_prop')
    expect(out.toLowerCase()).toMatch(/nothing/)
  })

  test('excludes a triage_failed row even when its agent_verdict is RETIRE_OVERRIDE', () => {
    const row = triaged({ name: 'failed_prop', agent_verdict: 'RETIRE_OVERRIDE', triage_failed: true })
    const out = report.buildRetirementSection([row])
    expect(out).not.toContain('failed_prop')
    expect(out.toLowerCase()).toMatch(/nothing/)
  })
})

describe('buildAmbiguousDigest', () => {
  test('empty array produces a non-empty "nothing this run" string', () => {
    const out = report.buildAmbiguousDigest([])
    expect(typeof out).toBe('string')
    expect(out.length).toBeGreaterThan(0)
    expect(out.toLowerCase()).toMatch(/nothing|no .*ambiguous/)
  })

  test('a single genuinely AMBIGUOUS candidate includes the name, reason, both texts, and "Needs a human call."', () => {
    const row = triaged({
      name: 'compression_type',
      agent_verdict: 'AMBIGUOUS',
      agent_reason: 'Both texts add distinct real information.',
      triage_failed: false
    })
    const out = report.buildAmbiguousDigest([row])
    expect(out).toContain('compression_type')
    expect(out).toContain('Both texts add distinct real information.')
    expect(out).toContain('Needs a human call.')
  })

  test('a multi-candidate case includes all of them', () => {
    const a = triaged({ name: 'prop_a', agent_verdict: 'AMBIGUOUS', agent_reason: 'Reason A.' })
    const b = triaged({ name: 'prop_b', agent_verdict: 'AMBIGUOUS', agent_reason: 'Reason B.' })
    const out = report.buildAmbiguousDigest([a, b])
    expect(out).toContain('prop_a')
    expect(out).toContain('prop_b')
  })

  test('excludes candidates that were resolved either way', () => {
    const resolved = triaged({ name: 'resolved_prop', agent_verdict: 'UPSTREAM_OVERRIDE', agent_reason: 'Clear.' })
    const out = report.buildAmbiguousDigest([resolved])
    expect(out).not.toContain('resolved_prop')
  })

  test('includes a triage_failed row alongside a genuine AMBIGUOUS row, treating both the same way', () => {
    const genuine = triaged({
      name: 'genuine_ambiguous_prop',
      agent_verdict: 'AMBIGUOUS',
      agent_reason: 'Both texts add distinct real information; a human should decide.',
      triage_failed: false
    })
    const failed = triaged({
      name: 'failed_triage_prop',
      agent_verdict: 'AMBIGUOUS',
      agent_reason: 'The triage response was not valid JSON.',
      triage_failed: true
    })
    const out = report.buildAmbiguousDigest([genuine, failed])

    expect(out).toContain('genuine_ambiguous_prop')
    expect(out).toContain('Both texts add distinct real information; a human should decide.')
    expect(out).toContain('failed_triage_prop')
    expect(out).toContain('The triage response was not valid JSON.')

    // Both get the same "Needs a human call." treatment, not a different
    // callout for the parse-failure case.
    const humanCallCount = out.split('Needs a human call.').length - 1
    expect(humanCallCount).toBe(2)
  })

  test.each([
    ['missing', undefined],
    ['null', null],
    ['a string', 'false'],
    ['a number', 0]
  ])('includes an actionable-verdict row whose triage_failed is %s (an unknown state is unresolved)', (_label, value) => {
    const row = triaged({ name: 'unknown_state_prop', agent_verdict: 'RETIRE_OVERRIDE', triage_failed: value })
    if (value === undefined) delete row.triage_failed
    const out = report.buildAmbiguousDigest([row])
    expect(out).toContain('unknown_state_prop')
    expect(out).toContain('Needs a human call.')
  })

  test('a triage_failed row with a non-AMBIGUOUS agent_verdict is still included (a failure is always unresolved)', () => {
    // Defensive: triage.js only ever sets agent_verdict to AMBIGUOUS when
    // triage_failed is true, but the digest filters on triage_failed
    // directly so a future producer of this shape cannot accidentally hide
    // a failed triage by mislabeling its verdict.
    const row = triaged({
      name: 'oddly_labeled_prop',
      agent_verdict: 'UPSTREAM_OVERRIDE',
      agent_reason: 'Should not actually happen, but must not be silently dropped.',
      triage_failed: true
    })
    const out = report.buildAmbiguousDigest([row])
    expect(out).toContain('oddly_labeled_prop')
  })
})

describe('buildUpstreamSection excludes rows with no source location', () => {
  test('an UPSTREAM_OVERRIDE row with no source_file is excluded, not just carried along', () => {
    const row = triaged({ name: 'plugin_cmd', agent_verdict: 'UPSTREAM_OVERRIDE' })
    delete row.source_file
    const out = report.buildUpstreamSection([row])
    expect(out).not.toContain('plugin_cmd')
    expect(out.toLowerCase()).toMatch(/nothing/)
  })
})

describe('buildUnlocatableSection', () => {
  test('empty array produces a non-empty "nothing this run" string', () => {
    const out = report.buildUnlocatableSection([])
    expect(typeof out).toBe('string')
    expect(out.length).toBeGreaterThan(0)
    expect(out.toLowerCase()).toMatch(/nothing/)
  })

  test('includes an UPSTREAM_OVERRIDE row with no source_file', () => {
    const row = triaged({ name: 'rpk ai agent', agent_verdict: 'UPSTREAM_OVERRIDE', agent_reason: 'Source text is thin.' })
    delete row.source_file
    const out = report.buildUnlocatableSection([row])
    expect(out).toContain('rpk ai agent')
    expect(out).toContain('Source text is thin.')
    expect(out).toContain('manual upstream PR')
  })

  test('excludes a row that DOES have a source_file', () => {
    const located = triaged({ name: 'rpk topic create', agent_verdict: 'UPSTREAM_OVERRIDE' })
    const out = report.buildUnlocatableSection([located])
    expect(out).not.toContain('rpk topic create')
    expect(out.toLowerCase()).toMatch(/nothing/)
  })

  test('excludes RETIRE_OVERRIDE and AMBIGUOUS rows even without a source_file', () => {
    const retire = triaged({ name: 'retire_me', agent_verdict: 'RETIRE_OVERRIDE' })
    delete retire.source_file
    const ambiguous = triaged({ name: 'ambiguous_one', agent_verdict: 'AMBIGUOUS' })
    delete ambiguous.source_file
    const out = report.buildUnlocatableSection([retire, ambiguous])
    expect(out).not.toContain('retire_me')
    expect(out).not.toContain('ambiguous_one')
  })

  test('excludes a triage_failed row even when its agent_verdict is UPSTREAM_OVERRIDE', () => {
    const row = triaged({ name: 'failed_one', agent_verdict: 'UPSTREAM_OVERRIDE', triage_failed: true })
    delete row.source_file
    const out = report.buildUnlocatableSection([row])
    expect(out).not.toContain('failed_one')
  })
})
