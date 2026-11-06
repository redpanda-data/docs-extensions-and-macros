'use strict'

/**
 * Links from lint-strings rules to the docs team standard each one enforces.
 *
 * Every rule carries a `standard` (one of these URLs) and a `why` (what
 * breaks for readers when the rule is violated). Both are printed by
 * `doc-tools lint-strings --list-rules`, appended to findings, and rendered
 * into the Rules section of CLI_REFERENCE.adoc, so the rule objects are the
 * only list. Anchors are GitHub heading slugs on the main branch.
 */
const BASE = 'https://github.com/redpanda-data/docs-team-standards/blob/main/resources/writing-style/'

const strings = (anchor) => `${BASE}embedded-reference-strings.md#${anchor}`

const STANDARD = Object.freeze({
  qualityBar: strings('the-quality-bar'),
  reviewingADiff: strings('reviewing-a-diff-that-touches-these-strings'),
  properties: strings('config-properties-verbatim-asciidoc'),
  metrics: strings('metrics-verbatim-zero-escaping'),
  rpk: strings('rpk-commands-and-flags-transformed'),
  helm: strings('helm-chart-values-helm-docs-markers'),
  crd: strings('crd-fields-go-doc-comments'),
  connect: strings('connect-fields-governed-in-the-connect-repo'),
  api: strings('api-fields-and-operations-proto-published-as-markdown'),
  styleFormatting: `${BASE}style-guide.md#formatting-conventions`,
  doNotUseWords: `${BASE}terminology.md#do-not-use-word-list`
})

module.exports = { STANDARD, STANDARDS_BASE: BASE }
