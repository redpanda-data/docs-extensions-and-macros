/**
 * Overrides Audit - Agent Triage Layer
 *
 * classify.js is deterministic: any UPSTREAMABLE or SPLIT KEEP_UNTIL_UPSTREAMED
 * candidate whose override text differs from source is treated as "our text
 * is better, push it upstream." That is not always true. Source can be
 * independently improved between audit runs to something as good as or
 * better than the override, and classify.js has no way to notice: it only
 * compares normalized text for equality, never for which one reads better.
 *
 * This module is the missing judgment step. It does not call an LLM itself -
 * a GitHub Actions workflow in the docs repo owns that call. This module only
 * (a) builds the prompt that call should send, and (b) parses whatever text
 * comes back into one of three verdicts, defaulting to the safest one
 * (AMBIGUOUS, meaning "leave the override alone, ask a human") on any
 * uncertainty at all. Silently guessing UPSTREAM_OVERRIDE or RETIRE_OVERRIDE
 * on a malformed response would either write bad prose into engineering
 * source or delete an override that source has not actually caught up to -
 * both worse than asking a human.
 */

'use strict'

const VERDICTS = Object.freeze({
  UPSTREAM_OVERRIDE: 'UPSTREAM_OVERRIDE',
  RETIRE_OVERRIDE: 'RETIRE_OVERRIDE',
  AMBIGUOUS: 'AMBIGUOUS'
})

const VALID_VERDICTS = new Set(Object.values(VERDICTS))
const ALLOWED_RESPONSE_KEYS = new Set(['verdict', 'reason'])

/**
 * Build the plain-text prompt an external LLM call should send for one
 * triage candidate.
 *
 * The prompt is written for a reader who has never seen this codebase: it
 * explains the two texts being compared, the three possible verdicts in
 * plain terms, and when to refuse to choose. It requires strict JSON back
 * with no markdown fences and no surrounding prose, because parseTriageResponse
 * has to be able to trust the shape of a well-behaved response and only fall
 * back defensively for a badly-behaved one.
 *
 * @param {Object} candidate - A classify.js manifest row for a `description`
 *   field classified UPSTREAMABLE or KEEP_UNTIL_UPSTREAMED (SPLIT), extended
 *   with `source_text` (see classify.js's `common.source_text`).
 * @param {string} candidate.name - Property (or command) name.
 * @param {string} candidate.upstream_candidate_text - The override's candidate text.
 * @param {string} candidate.source_text - The current source description text.
 * @param {string} [candidate.source_file] - File the source description lives in.
 * @param {number} [candidate.source_line] - Line the source description starts at.
 * @returns {string} The prompt text.
 * @throws {Error} When `candidate` is missing `upstream_candidate_text` or `source_text`.
 *   This is a programming-error guard, not the agent-response fallback below:
 *   a caller that hands this function a REDUNDANT row, or any row that never
 *   got a source_text, has a bug that should fail loudly, not produce a
 *   prompt that quietly asks an LLM to compare a real string to `undefined`.
 */
function buildTriagePrompt (candidate) {
  if (!candidate || typeof candidate.upstream_candidate_text !== 'string') {
    throw new Error(`buildTriagePrompt: candidate for "${candidate && candidate.name}" is missing upstream_candidate_text`)
  }
  if (typeof candidate.source_text !== 'string') {
    throw new Error(`buildTriagePrompt: candidate for "${candidate.name}" is missing source_text`)
  }

  const location = candidate.source_file
    ? `${candidate.source_file}${candidate.source_line !== undefined ? `:${candidate.source_line}` : ''}`
    : 'unknown location'

  return `You are triaging one property description for a documentation team.

A documentation site publishes reference docs for a configuration property named "${candidate.name}". Its description currently comes from a manually written "override" that the docs team keeps because, at some point in the past, the engineering source code's own description of this property was missing, wrong, or worse than what the docs team wrote. Engineering source now defines its own description for the same property, at ${location}.

Your job is to compare the two descriptions below and decide what should happen next.

OVERRIDE TEXT (currently shown to docs readers, and a candidate to copy into engineering source):
"""
${candidate.upstream_candidate_text}
"""

CURRENT SOURCE TEXT (what engineering's own code says today):
"""
${candidate.source_text}
"""

Choose exactly one of these three verdicts:

1. UPSTREAM_OVERRIDE - The override text is genuinely better or more complete than the source text. The right move is to copy the override's wording into the engineering source code, so that source eventually says what the override already says.

2. RETIRE_OVERRIDE - The source text has caught up to, or become as good as or better than, the override in substance. There is no longer a good reason to keep the override. The right move is to delete the docs-side override entirely and let the docs site render the source text as-is, without ever touching engineering source.

3. AMBIGUOUS - You cannot confidently choose between the two options above. Choose this if you are genuinely uncertain, if the two texts each contain distinct real information and neither one is a strict subset of the other (so picking one would lose real content), or if judging the two texts correctly requires technical knowledge of this system that cannot be confirmed from the text alone. When in doubt, choose AMBIGUOUS rather than guessing. Guessing wrong here either writes bad text into engineering source code or throws away a description a docs reader currently relies on, so it is always safer to flag this for a human than to guess.

Respond with strict JSON only. Do not use markdown code fences. Do not include any words, explanation, or punctuation outside the JSON object. The response must be exactly one JSON object shaped like this:

{"verdict": "UPSTREAM_OVERRIDE" | "RETIRE_OVERRIDE" | "AMBIGUOUS", "reason": "one or two plain-English sentences a non-engineer documentation reviewer can understand, explaining the comparison you made and why this verdict follows from it"}
`
}

/**
 * Extract a JSON value from raw agent response text. Accepts only a whole
 * JSON response or one wrapped in a single pair of markdown code fences, the
 * one common way a model fails to follow "strict JSON only" without changing
 * what it said. Prose around the JSON is rejected rather than stripped: that
 * prose can contradict the embedded verdict (for example "I cannot decide"
 * followed by a RETIRE_OVERRIDE object), so it is not safe to trust the object.
 *
 * @param {string} text - Raw response text.
 * @returns {*} The parsed value.
 * @throws {Error} When the (unfenced) response is not valid JSON.
 */
function extractJson (text) {
  let candidate = text.trim()

  // Strip a single pair of markdown code fences, ```json ... ``` or ``` ... ```.
  const fenceMatch = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenceMatch) candidate = fenceMatch[1].trim()

  return JSON.parse(candidate)
}

/**
 * The safe, conservative fallback result for any response the parser cannot
 * fully trust.
 *
 * @param {string} reason - Specific, human-readable explanation of what went wrong.
 * @returns {{verdict: string, reason: string, triageFailed: boolean}}
 */
function ambiguousFallback (reason) {
  return { verdict: VERDICTS.AMBIGUOUS, reason, triageFailed: true }
}

/**
 * Defensively parse whatever text an LLM triage call returned.
 *
 * Clean JSON and JSON wrapped in markdown fences are accepted. JSON
 * surrounded by stray prose, an empty or truncated response, or JSON that
 * parses but carries an invalid or missing verdict or reason, or any field
 * other than verdict and reason, is treated as
 * a triage failure and mapped to the same safe AMBIGUOUS
 * fallback: this function's job is to never let a malformed response be
 * mistaken for a real UPSTREAM_OVERRIDE or RETIRE_OVERRIDE call.
 *
 * @param {string} rawText - Raw text returned by the LLM call.
 * @returns {{verdict: string, reason: string, triageFailed: boolean}}
 */
function parseTriageResponse (rawText) {
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    return ambiguousFallback('The triage call returned no response.')
  }

  let parsed
  try {
    parsed = extractJson(rawText)
  } catch {
    return ambiguousFallback('The triage response was not valid JSON.')
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return ambiguousFallback('The triage response was valid JSON but not a JSON object.')
  }

  // The prompt asks for exactly { verdict, reason }. An extra field such as
  // needs_human_review or confidence can contradict the verdict, and nothing
  // downstream reads it, so treat any extra key as a failed triage rather
  // than silently dropping it.
  const extraKeys = Object.keys(parsed).filter((key) => !ALLOWED_RESPONSE_KEYS.has(key))
  if (extraKeys.length > 0) {
    return ambiguousFallback(`The triage response included unexpected fields: ${extraKeys.join(', ')}.`)
  }

  // Case-sensitive on purpose: a case variant (e.g. "upstream_override") is a
  // real deviation from the required response shape, worth surfacing as a
  // failure rather than silently normalizing away.
  if (typeof parsed.verdict !== 'string' || !VALID_VERDICTS.has(parsed.verdict)) {
    return ambiguousFallback('The triage response used an unrecognized verdict value.')
  }

  if (typeof parsed.reason !== 'string' || parsed.reason.trim().length === 0) {
    return ambiguousFallback('The triage response was missing a reason.')
  }

  return { verdict: parsed.verdict, reason: parsed.reason, triageFailed: false }
}

/**
 * Combine a classify.js candidate row with the parsed result of a triage
 * call, producing a manifest row extended with the agent's verdict.
 *
 * Field names follow classify.js's snake_case manifest-row convention rather
 * than parseTriageResponse's camelCase return shape.
 *
 * @param {Object} candidate - A classify.js manifest row.
 * @param {string} rawAgentResponse - Raw text returned by the LLM triage call.
 * A RETIRE_OVERRIDE verdict on a SPLIT (KEEP_UNTIL_UPSTREAMED) candidate is
 * downgraded to AMBIGUOUS, because retiring that override would also delete
 * its audience-scoped or docs-only content.
 *
 * @returns {Object} `candidate` merged with `agent_verdict`, `agent_reason`, `triage_failed`.
 */
function triageCandidate (candidate, rawAgentResponse) {
  let { verdict, reason, triageFailed } = parseTriageResponse(rawAgentResponse)
  // A SPLIT (KEEP_UNTIL_UPSTREAMED) override also carries audience-scoped
  // paragraphs or docs-only markup that the candidate text leaves out.
  // Retiring the whole override would delete that content, so even when
  // source prose has caught up, route the row to a human instead.
  if (verdict === VERDICTS.RETIRE_OVERRIDE && candidate && candidate.class === 'KEEP_UNTIL_UPSTREAMED') {
    verdict = VERDICTS.AMBIGUOUS
    reason = `${reason} This override also carries audience-scoped paragraphs or docs-only markup that source does not, so it cannot be retired whole. Decide what to do with that content.`
  }
  return {
    ...candidate,
    agent_verdict: verdict,
    agent_reason: reason,
    triage_failed: triageFailed
  }
}

module.exports = {
  VERDICTS,
  buildTriagePrompt,
  parseTriageResponse,
  triageCandidate
}
