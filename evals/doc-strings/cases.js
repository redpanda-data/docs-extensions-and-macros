'use strict'

/**
 * Eval case definitions.
 *
 * Case kinds (executed by run-evals.js):
 * - rewrite: behavior A (doc-strings-review.yml suggestion blocks). A real
 *   lint finding goes in; the suggestion comes out, is APPLIED to the
 *   fixture, and the verdict is computed by re-running lint-strings plus the
 *   surface extractor over the result.
 * - upstream: behavior B (upstream-doc-strings.yml, not built yet - these
 *   cases define the contract for it). A real overrides-audit
 *   candidate goes in; the edit is applied and verified by re-running the
 *   audit (class must flip) and the extractor (text must match, nothing else
 *   may change).
 * - prose-review: behavior D (the declaration-gated Claude pass). A diff
 *   that is mechanically CLEAN (zero lint findings) but semantically vacuous
 *   goes in; the model must produce a suggestion, which is applied and
 *   verified like a rewrite (re-lint clean, extraction intact, substance
 *   restored). Its sabotage swaps in a fully conforming rewording, where the
 *   model must stay silent and the case therefore fails.
 * - negative-review / negative-audit: behavior C. Fully conforming input;
 *   the model FAILS the case by producing any suggestion or claiming any
 *   finding. `sabotageEdits` swaps in a violating fixture to prove the case
 *   can fail (run-evals.js --sabotage <id>).
 *
 * Every `expectRules` list is a precondition asserted against the REAL lint
 * run before the model is ever called - if the fixture drifts, the case
 * aborts as HARNESS_ERROR instead of silently testing something else.
 */

const CASES = [
  {
    id: 'prop-empty-description',
    kind: 'rewrite',
    description: 'Property with an empty description string; model must write a full declaration rewrite that states effect and default',
    layout: 'properties',
    target: 'compaction_ctrl_update_interval_ms',
    language: 'cpp',
    columnLimit: 80,
    expectRules: ['empty-description']
  },
  {
    id: 'prop-tautology-no-period',
    kind: 'rewrite',
    description: 'Property description that merely restates the name and lacks a terminal period',
    layout: 'properties',
    edits: [{ find: '"Cluster identifier.",', replace: '"Cluster identifier",' }],
    target: 'cluster_id',
    language: 'cpp',
    columnLimit: 80,
    expectRules: ['name-echo', 'missing-terminal-period']
  },
  {
    id: 'metric-name-echo',
    kind: 'rewrite',
    description: 'Metric help string that echoes the metric name; the rewrite must carry NO terminal period',
    layout: 'metrics',
    target: 'start_offset',
    targetKind: '',
    language: 'cpp',
    columnLimit: 80,
    expectRules: ['name-echo', 'starts-lowercase']
  },
  {
    id: 'rpk-flag-lowercase-period',
    kind: 'rewrite',
    description: 'rpk flag usage string that starts lowercase and ends with a period; only the usage literal may change',
    layout: 'rpk',
    edits: [{
      find: 'cmd.Flags().StringVar(&dest, "trailing-period", "", "Writes the output to the given path.")',
      replace: 'cmd.Flags().StringVar(&dest, "output-path", "", "writes the output to the given path.")'
    }],
    target: 'output-path',
    targetKind: 'flag',
    language: 'go',
    columnLimit: null,
    singleLine: true,
    expectRules: ['starts-lowercase', 'rpk-terminal-period']
  },
  {
    id: 'connect-xref-module',
    kind: 'rewrite',
    description: 'Connect field description with a module-less xref, which breaks on the Cloud page; the link must stay and gain a module',
    layout: 'connect-input',
    edits: [{
      find: 'f = f.Description("Only things whose name starts with this prefix are read.")',
      replace: 'f = f.Description("Only things whose name starts with this prefix are read. To filter on other attributes, use a xref:bloblang/about.adoc[Bloblang] mapping.")'
    }],
    target: 'prefix',
    targetKind: 'field',
    language: 'go',
    columnLimit: null,
    singleLine: true,
    expectRules: ['connect-xref-module'],
    // Deleting the link also re-lints clean, so the link must survive,
    // qualified, to the same page.
    stringMustMatch: 'xref:(?:[a-z-]+:){1,2}bloblang/about\\.adoc\\['
  },
  {
    id: 'connect-short-description-markup',
    kind: 'rewrite',
    description: 'Connect ShortDescription with inline markup, which form-based editors show literally; the rewrite must be plain text in the shared helper',
    layout: 'connect-common',
    target: 'storage_account',
    targetKind: 'field-short',
    targetRule: 'connect-short-description-markup',
    language: 'go',
    columnLimit: null,
    expectRules: ['connect-short-description-markup'],
    stringMustMatch: '[Ss]torage account',
    stringMustNotMatch: '[`*]|xref:|https?://'
  },
  {
    id: 'upstream-clean',
    kind: 'upstream',
    description: 'UPSTREAMABLE override ported into the C++ source; audit must reclassify it REDUNDANT afterwards',
    layout: 'properties',
    target: 'cloud_storage_upload_ctrl_p_coeff',
    columnLimit: 80,
    overrides: {
      properties: {
        cloud_storage_upload_ctrl_p_coeff: {
          description: 'Proportional coefficient for the upload PID controller, which adjusts upload concurrency in response to the upload backlog. Default is -2.0.'
        }
      }
    },
    expectClassBefore: 'UPSTREAMABLE',
    expectClassAfter: 'REDUNDANT'
  },
  {
    id: 'upstream-split',
    kind: 'upstream',
    description: 'SPLIT override (contains an xref) ported as stripped prose; the docs markup must NOT reappear in source, and the audit must reclassify KEEP',
    layout: 'properties',
    target: 'kafka_batch_max_bytes',
    columnLimit: 80,
    overrides: {
      properties: {
        kafka_batch_max_bytes: {
          description: 'Maximum size of a batch processed by the server, measured in bytes. If the batch is compressed, the limit applies to the xref:manage:cluster-maintenance/compression.adoc[compressed batch size]. Default is 1048576 bytes.'
        }
      }
    },
    expectClassBefore: 'KEEP_UNTIL_UPSTREAMED',
    expectClassAfter: 'KEEP'
  },
  {
    id: 'prose-vacuous-clean',
    kind: 'prose-review',
    description: 'Mechanically clean but vacuous property rewording; the model must suggest a rewrite that restores substance, and the applied result must still lint clean',
    layout: 'properties',
    target: 'kafka_batch_max_bytes',
    columnLimit: 80,
    diffEdits: [{
      find: '      "Maximum size of a batch processed by the server. If the batch is "\n' +
            '      "compressed, the limit applies to the compressed batch size. Default "\n' +
            '      "is 1048576 bytes.",',
      replace: '      "Controls how the server processes large requests.",'
    }],
    // Sabotage: the same fully conforming rewording negative-property-diff
    // uses. The model must rightly stay silent on it, which makes this
    // case's must-suggest check fail and proves the case can fail.
    sabotageEdits: [{
      find: '      "Maximum size of a batch processed by the server. If the batch is "\n' +
            '      "compressed, the limit applies to the compressed batch size. Default "\n' +
            '      "is 1048576 bytes.",',
      replace: '      "Maximum size in bytes of a batch processed by the server. If the "\n' +
               '      "batch is compressed, this limit applies to the compressed batch "\n' +
               '      "size.",'
    }],
    // The vacuous string dodges every rule while saying nothing about WHAT
    // is limited. Earlier versions of these fixtures also restated the
    // concrete default ("Default is 1048576 bytes."), which the standard says
    // to delete; the old hand-written prompt did not carry that rule, so the
    // "conforming" text only looked conforming. Each fixture now plants only
    // the defect its case tests. The removed diff lines show the model the original, so a
    // substantive rewrite names the thing: a batch.
    mustMentionAny: ['batch']
  },
  {
    id: 'terminology-misuse',
    kind: 'prose-review',
    description: 'Lint-clean, substantive description that lowercases the product name; terminology.md names that form incorrect, so the model must suggest the canonical casing',
    layout: 'properties',
    target: 'kafka_batch_max_bytes',
    columnLimit: 80,
    terminologyFixture: 'terminology.md',
    diffEdits: [{
      find: '      "Maximum size of a batch processed by the server. If the batch is "\n' +
            '      "compressed, the limit applies to the compressed batch size. Default "\n' +
            '      "is 1048576 bytes.",',
      replace: '      "Maximum size in bytes of a batch the redpanda broker accepts. If "\n' +
               '      "the batch is compressed, the limit applies to the compressed "\n' +
               '      "batch size.",'
    }],
    // Sabotage: identical rewording with the canonical casing; the model
    // must stay silent there, so this case fails, proving it can fail.
    sabotageEdits: [{
      find: '      "Maximum size of a batch processed by the server. If the batch is "\n' +
            '      "compressed, the limit applies to the compressed batch size. Default "\n' +
            '      "is 1048576 bytes.",',
      replace: '      "Maximum size in bytes of a batch the Redpanda broker accepts. If "\n' +
               '      "the batch is compressed, the limit applies to the compressed "\n' +
               '      "batch size.",'
    }],
    mustMentionAny: ['Redpanda'],
    mustNotMention: ['redpanda']
  },
  {
    id: 'negative-property-diff',
    kind: 'negative-review',
    description: 'Diff with a fully conforming property rewording; the model must produce zero suggestions and zero doc-impact findings',
    layout: 'properties',
    diffEdits: [{
      find: '      "Maximum size of a batch processed by the server. If the batch is "\n' +
            '      "compressed, the limit applies to the compressed batch size. Default "\n' +
            '      "is 1048576 bytes.",',
      replace: '      "Maximum size in bytes of a batch processed by the server. If the "\n' +
               '      "batch is compressed, this limit applies to the compressed batch "\n' +
               '      "size.",'
    }],
    sabotageEdits: [{
      find: '      "Maximum size of a batch processed by the server. If the batch is "\n' +
            '      "compressed, the limit applies to the compressed batch size. Default "\n' +
            '      "is 1048576 bytes.",',
      replace: '      "batch max bytes",'
    }]
  },
  {
    id: 'negative-connect-diff',
    kind: 'negative-review',
    description: 'Diff with a conforming connect field rewording; the model must post no comment and write no doc-impact file',
    layout: 'connect-input',
    diffEdits: [{
      find: 'f = f.Description("Only things whose name starts with this prefix are read.")',
      replace: 'f = f.Description("Only things whose names begin with this prefix are read.")'
    }],
    sabotageEdits: [{
      find: 'f = f.Description("Only things whose name starts with this prefix are read.")',
      replace: 'f = f.Description("Only things whose name starts with this prefix are read. To filter on other attributes, use a xref:bloblang/about.adoc[Bloblang] mapping.")'
    }]
  },
  {
    id: 'negative-metrics-file',
    kind: 'negative-audit',
    description: 'Fully conforming metrics file; the model must claim zero findings',
    layout: 'metrics-conforming',
    sabotageEdits: [{
      find: 'sm::description("Total number of records consumed from this "\n' +
            '                          "partition by Kafka fetch requests")',
      replace: 'sm::description("records fetched.")'
    }]
  }
]

module.exports = { CASES }
