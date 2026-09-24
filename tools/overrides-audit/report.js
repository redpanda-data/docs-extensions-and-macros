/**
 * Overrides Audit - Triage Report Sections
 *
 * Formats triaged candidates (classify.js rows extended with agent_verdict /
 * agent_reason / triage_failed by triage.js's triageCandidate) into the
 * plain-English markdown sections a downstream workflow glues into PR and
 * issue bodies. This module never calls `gh` itself; it only builds strings.
 *
 * Every builder here returns a non-empty string even for an empty input
 * array, so a caller can always embed the return value directly into a
 * larger PR/issue body without checking for emptiness first.
 */

'use strict'

/**
 * Render one candidate's property name as a markdown subsection heading.
 *
 * @param {string} name - Property (or command) name.
 * @returns {string} Markdown heading line.
 */
function heading (name) {
  return `## ${name}`
}

/**
 * Render a labeled block of text as an indented markdown blockquote, so long
 * override/source text cannot be confused with the surrounding prose.
 *
 * @param {string} label - Label line, e.g. "Override text:".
 * @param {string} text - The text to quote.
 * @returns {string} Markdown block.
 */
function quotedBlock (label, text) {
  const quoted = String(text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `${label}\n\n${quoted}`
}

/**
 * Build the "nothing happened this run" placeholder for an empty section.
 * Never an empty string: this is meant to be embedded directly into a larger
 * PR/issue body, and an empty string there reads as a rendering bug rather
 * than "there was nothing to report."
 *
 * @param {string} noun - What there was none of, e.g. "properties to upstream".
 * @returns {string} A one-line markdown message.
 */
function nothingThisRun (noun) {
  return `Nothing to report: no ${noun} this run.`
}

/**
 * Whether a row carries an explicitly successful triage state.
 *
 * triageCandidate always emits a boolean triage_failed, so anything other
 * than exactly false (missing, null, a string, a number) is a row this code
 * cannot trust. Such a row stays out of the actionable sections and lands in
 * the ambiguous digest instead.
 *
 * @param {Object} row - A triaged candidate row.
 * @returns {boolean} True only when triage_failed is exactly false.
 */
function triageSucceeded (row) {
  return row.triage_failed === false
}

/**
 * Build the markdown section listing candidates the agent triage layer
 * decided are genuinely better in the override and should be ported
 * upstream into engineering source (verdict UPSTREAM_OVERRIDE).
 *
 * @param {Object[]} candidates - Triaged rows (from triage.js's triageCandidate).
 * @returns {string} Markdown section, always non-empty.
 */
function buildUpstreamSection (candidates) {
  const rows = (candidates || []).filter((c) => c.agent_verdict === 'UPSTREAM_OVERRIDE' && triageSucceeded(c))
  if (rows.length === 0) return nothingThisRun('property descriptions to upstream')

  const parts = [
    `Found ${rows.length} property description${rows.length === 1 ? '' : 's'} worth porting upstream into engineering source.`
  ]
  for (const row of rows) {
    parts.push([
      heading(row.name),
      row.agent_reason,
      // A SPLIT row's override also carries audience-scoped paragraphs or
      // docs-only markup that the candidate text leaves out, so porting the
      // prose alone does not make the override redundant.
      row.class === 'KEEP_UNTIL_UPSTREAMED'
        ? 'This PR ports that into the source description. The docs override stays after it ships, because it also carries audience-scoped paragraphs or docs-only markup that source does not; that content needs handling separately before the override can retire.'
        : 'This PR ports that into the source description; once merged and released, the docs override becomes redundant and retires itself automatically.'
    ].join('\n\n'))
  }
  return parts.join('\n\n')
}

/**
 * Build the markdown section listing candidates the agent triage layer
 * decided source has caught up to or surpassed, so the docs-side override
 * should simply be deleted (verdict RETIRE_OVERRIDE). Engineering source is
 * never touched for these.
 *
 * @param {Object[]} candidates - Triaged rows (from triage.js's triageCandidate).
 * @returns {string} Markdown section, always non-empty.
 */
function buildRetirementSection (candidates) {
  const rows = (candidates || []).filter((c) => c.agent_verdict === 'RETIRE_OVERRIDE' && triageSucceeded(c))
  if (rows.length === 0) return nothingThisRun('overrides to retire')

  const parts = [
    `Found ${rows.length} docs override${rows.length === 1 ? '' : 's'} that source has caught up to; retiring them rather than touching engineering source.`
  ]
  for (const row of rows) {
    parts.push([
      heading(row.name),
      row.agent_reason,
      quotedBlock('Override text (current docs override):', row.upstream_candidate_text),
      quotedBlock('Source text (what docs will render instead):', row.source_text),
      '**Retiring this override; docs will now render source\'s description.**'
    ].join('\n\n'))
  }
  return parts.join('\n\n')
}

/**
 * Build one combined markdown digest of every candidate the agent triage
 * layer could not confidently resolve either way: a real AMBIGUOUS verdict,
 * a failed/malformed triage response (triage_failed: true), and a row with
 * no explicit triage state (triage_failed missing or not a boolean) get exactly
 * the same treatment here, because all three are equally unresolved from a
 * human's point of view - a parse failure is not quietly dropped just
 * because it never produced a real verdict.
 *
 * This is one digest, not one artifact per property, matching this
 * codebase's "one rolling artifact, idempotently rebuilt every run" pattern
 * (see tools/rpk-docs/generate-plugin-stubs.js for that idiom elsewhere):
 * it is meant to become the body of a single rolling tracking issue that
 * gets replaced wholesale each run, not appended to.
 *
 * @param {Object[]} candidates - Triaged rows (from triage.js's triageCandidate).
 * @returns {string} Markdown digest, always non-empty.
 */
function buildAmbiguousDigest (candidates) {
  const rows = (candidates || []).filter((c) => c.agent_verdict === 'AMBIGUOUS' || !triageSucceeded(c))
  if (rows.length === 0) return nothingThisRun('ambiguous property descriptions')

  const parts = [
    `${rows.length} property description${rows.length === 1 ? '' : 's'} could not be confidently triaged and need a human call.`
  ]
  for (const row of rows) {
    parts.push([
      heading(row.name),
      quotedBlock('Override text:', row.upstream_candidate_text),
      quotedBlock('Source text:', row.source_text),
      row.agent_reason,
      'Needs a human call.'
    ].join('\n\n'))
  }
  return parts.join('\n\n')
}

module.exports = {
  buildUpstreamSection,
  buildRetirementSection,
  buildAmbiguousDigest
}
