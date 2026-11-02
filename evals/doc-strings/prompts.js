'use strict'

/**
 * Prompt templates for the doc-strings evals.
 *
 * Only for behaviors whose production prompt does NOT live in this repo.
 * The doc-strings review's own cases (rewrite, prose-review, negative-review)
 * run the production prompt straight from doc-strings-review.yml through
 * production.js; a template here would be a second copy that drifts, which
 * is exactly how the old review templates ended up sharing no rule sentence
 * with the shipped prompt.
 * - upstreamPort: the docs repo's upstream-doc-strings.yml contract.
 * - negativeAudit: a findings audit over a fully conforming metrics file,
 *   the false-positive guard.
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
- State units and valid ranges in prose. Spell out units. The default renders
  from structured data, so do not restate a concrete default; explain a
  sentinel default (null, 0, -1, empty) instead.
- No internal jargon (NTP, seastar, nullopt, stm, smp): users set null, not
  nullopt.

Per-surface contract:
- Properties (src/v/config/): verbatim AsciiDoc - keep backticks balanced, no
  raw | outside backticks, no unknown {attr} references. Sentence case,
  terminal period. Explain what a sentinel default means, if there is one.
- Metrics (sm::description): zero escaping downstream - no | or {attr} at
  all. Capitalized, NO terminal period. Never echo the metric name.
- rpk (src/go/rpk/pkg/cli/): Short = one line, capitalized, no period. Flag
  usage = capitalized, no period, never an echo of the flag name. In Long, an
  ALLCAPS line becomes a section heading; a standalone ==== or ---- line
  breaks the generated page.
- Connect and benthos (ConfigSpec Summary, Description, Footnotes, field
  descriptions, annotated options, Bloblang docs): verbatim AsciiDoc page
  bodies, published on the self-managed Connect docs and on the Cloud docs,
  which set env-cloud. xref:, <<anchors>> and env-cloud conditionals are
  allowed. A conditional is block form only: ifdef::env-cloud[] or
  ifndef::env-cloud[] alone on a line at column 0 with nothing after the ],
  not even spaces, the whole paragraph inside, endif::[] alone on a line, a
  blank line before and after; never the single-line form, never in a
  Summary or example summary, never inside a code fence, never
  ifndef::env-cloud[] nested in ifdef::env-cloud[] or the reverse, and
  env-cloud is the only attribute. The Cloud docs and the Cloud binaries set
  env-cloud, and the text inside must read as a whole paragraph in both
  outputs. Other attributes, glossterm:, prop: and include:: do not belong
  in any source string.`

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
   drop that markup (keep the plain text) rather than porting it. That rule
   is for property strings. In Connect and benthos ConfigSpec strings, xref:,
   <<anchors>> and env-cloud block conditionals (ifdef::env-cloud[] or
   ifndef::env-cloud[] alone on a line at column 0 with nothing after the ],
   the paragraph inside, endif::[] alone on a line, blank lines around;
   never single-line, never in a Summary or example summary) are allowed
   and are kept.

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

module.exports = { SURFACE_CONTRACT, upstreamPort, negativeAudit }
