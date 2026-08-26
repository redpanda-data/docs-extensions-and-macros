'use strict'

/**
 * Prompt templates for the doc-strings evals.
 *
 * Each template mirrors the essence of a production prompt:
 * - rewrite: the Claude step of doc-strings-review.yml (redpanda /
 *   redpanda-operator PR review with GitHub suggestion blocks).
 * - upstreamPort: the Claude step of upstream-doc-strings.yml, which is not
 *   built yet - this prompt is the contract it will have to meet (docs repo's
 *   override-upstreaming workflow).
 * - negativeReview / negativeAudit: the same review posture pointed at fully
 *   conforming input - the false-positive guard.
 *
 * The one deliberate difference from production: a strict OUTPUT CONTRACT
 * section, because the harness executes the output mechanically instead of
 * posting it through the GitHub MCP tools. Contract sections define WHERE
 * the answer goes, never what a good answer says - quality is judged by
 * re-running the deterministic tools on the applied output.
 */

/**
 * The per-surface writing contract, condensed from the doc-strings skill
 * (redpanda .claude/skills/doc-strings/SKILL.md) and the lint rule set.
 */
const SURFACE_CONTRACT = `Writing standard for user-facing doc strings (these strings are published
verbatim to docs.redpanda.com by the doc generators):

- Every description is a complete thought that states the effect and when an
  operator would change the setting - never a restatement of the name.
- State defaults, units, and valid ranges in prose. Spell out units.
- No internal jargon (NTP, seastar, nullopt, stm, smp): users set null, not
  nullopt.

Per-surface contract:
- Properties (src/v/config/): verbatim AsciiDoc - keep backticks balanced, no
  raw | outside backticks, no unknown {attr} references. Sentence case,
  terminal period. State the default shown in the declaration.
- Metrics (sm::description): zero escaping downstream - no | or {attr} at
  all. Capitalized, NO terminal period. Never echo the metric name.
- rpk (src/go/rpk/pkg/cli/): Short = one line, capitalized, no period. Flag
  usage = capitalized, no period, never an echo of the flag name. In Long, an
  ALLCAPS line becomes a section heading; a standalone ==== or ---- line
  breaks the generated page.`

/**
 * Rewrite prompt (behaviors A1-A4): one deterministic lint finding, model
 * must produce a GitHub suggestion block replacing the full declaration span.
 */
function rewrite ({ finding, columnLimit, language }) {
  const cpp = language === 'cpp'
  return `You are reviewing user-facing doc strings only. The JSON below holds one
deterministic finding from doc-tools lint-strings: surface, name, file,
line_start/line_end, the current string, the exact declaration_text of the
span, and the rule violations.

\`\`\`json
${JSON.stringify(finding, null, 2)}
\`\`\`

${SURFACE_CONTRACT}

Produce a GitHub suggestion block that replaces the FULL declaration span
(lines ${finding.line_start}..${finding.line_end} of ${finding.file}, shown
verbatim in declaration_text). Requirements:
- Fix every rule violation listed in the finding.
- The rewritten description must state effect${cpp ? ', default, and units where the declaration shows them (the default value is visible as an argument in declaration_text)' : ' and follow cobra conventions'}; never restate the name.
${cpp
    ? `- Re-wrap the description as clang-format-style adjacent string literals;
  every line of the suggestion must stay within ${columnLimit} columns.
- Keep every non-description argument and all surrounding syntax
  byte-identical: same name argument, same metadata, same default, same
  commas, braces, and indentation.`
    : `- Change ONLY the usage/help string literal; everything else on the line
  (function call, flag name, shorthand, default value, variable) must stay
  byte-identical.`}
- Do not review code logic and do not touch any other declaration.

OUTPUT CONTRACT (machine-parsed): reply with exactly one fenced block tagged
"suggestion" containing the complete replacement for lines
${finding.line_start}..${finding.line_end} - nothing else, no other fenced
blocks:

\`\`\`suggestion
<replacement lines>
\`\`\`
`
}

/**
 * Upstream-port prompt (behaviors B1-B2): mirror of the docs repo's
 * upstream-doc-strings.yml Claude step (not yet built; see the module
 * header), adapted to a text-only contract.
 */
function upstreamPort ({ candidate, fileRel, numberedFile, columnLimit }) {
  return `The candidate below is a property description override to upstream into an
engineering checkout: the docs team maintains this text as an override, and
it must move into the C++ source string it currently masks.

\`\`\`json
${JSON.stringify(candidate, null, 2)}
\`\`\`

1. Find the property declaration for "${candidate.name}" in ${fileRel} (the
   description is the 3rd constructor argument, wrapped as adjacent string
   literals). The full file, with 1-indexed line numbers, is below.
2. Replace the description with upstream_candidate_text, re-wrapped as
   clang-format-style adjacent string literals; every replacement line must
   stay within ${columnLimit} columns. Keep every other argument
   byte-identical, including indentation, commas, and braces.
3. The candidate text is already stripped of docs-only macros; if any xref:,
   glossterm:, include::, ifdef::, or {attribute} markup remains anywhere,
   drop that markup (keep the plain text) rather than porting it.

Edit only the description string of this one property. Do not reformat
surrounding code and do not touch any other declaration.

${fileRel}:
\`\`\`
${numberedFile}
\`\`\`

OUTPUT CONTRACT (machine-parsed): reply with a first line of the form
LINES <start>-<end>
giving the 1-indexed inclusive span of the FULL declaration you are
replacing (from the property's first line through its closing line), then
exactly one fenced block tagged "replacement" containing the complete
replacement for that span - nothing else:

\`\`\`replacement
<replacement lines>
\`\`\`
`
}

/**
 * Negative control: PR review over a fully conforming diff. The model gets
 * the same review posture as production but must decide for itself that
 * nothing warrants a suggestion or a doc-impact finding.
 */
function negativeReview ({ diff }) {
  return `You are reviewing user-facing doc strings only, in suggest-only posture.
The unified diff below is a pull request against a redpanda checkout; it
touches doc strings that are published verbatim to docs.redpanda.com.

${SURFACE_CONTRACT}

Review every doc string changed in the diff against the contract:
- For each declaration whose NEW string violates the contract, output a line
  "FILE <path> LINES <start>-<end>" followed by one fenced block tagged
  "suggestion" with the corrected declaration span.
- Do not flag subjective polish: a string that already states effect,
  default, and units, and satisfies the per-surface contract, gets NO
  suggestion. Never bikeshed phrasing.
- PUBLISHED-CONTENT IMPACT: HIGH-IMPACT means the diff changes a default,
  unit, or observable behavior that published docs state, or removes or
  renames a user-facing surface, or adds a brand-new user-facing surface. A
  wording-only clarification of a description is NOT high-impact. If (and
  only if) high-impact entries exist, also output one fenced block tagged
  "json" of the form {"doc_impact": [{"surface", "name", "change_kind",
  "summary"}]}. When there are none, output no json block at all.

OUTPUT CONTRACT (machine-parsed): if there are no violations and no
high-impact entries, reply with exactly:
NO_SUGGESTIONS

The diff:
\`\`\`diff
${diff}
\`\`\`
`
}

/**
 * Negative control: findings audit over a fully conforming metrics file.
 * The model must claim zero findings, as a machine-parsed JSON verdict.
 */
function negativeAudit ({ fileRel, numberedFile }) {
  return `You are auditing user-facing metric help strings (sm::description) in the
C++ source file below. These strings are published verbatim: they become the
Prometheus # HELP text and the metrics reference on docs.redpanda.com.

${SURFACE_CONTRACT}

Audit every sm::description string in the file against the contract and
report each violation. Do not flag subjective polish: a string that already
satisfies the per-surface contract is NOT a finding, and inventing a finding
is worse than missing one.

${fileRel}:
\`\`\`
${numberedFile}
\`\`\`

OUTPUT CONTRACT (machine-parsed): reply with exactly one fenced block tagged
"json" and nothing else:

\`\`\`json
{"findings": [{"name": "<metric>", "rule": "<which contract rule>", "message": "<why>"}]}
\`\`\`

If every string conforms, "findings" must be an empty array.
`
}

module.exports = { SURFACE_CONTRACT, rewrite, upstreamPort, negativeReview, negativeAudit }
