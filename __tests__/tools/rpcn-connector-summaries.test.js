'use strict';

/**
 * Tests for whats-new description summarization and config-component
 * platform metadata in the Redpanda Connect docs generator.
 *
 * Covers two bugs observed in rp-connect-docs auto-docs PR output:
 * 1. capToTwoSentences truncated descriptions containing Antora xref
 *    macros (periods inside try.adoc / catch.adoc broke sentence
 *    splitting, discarding all leading text).
 * 2. config-type components (e.g. error_handling) never received a
 *    cloudSupported flag from binary analysis, so the diff JSON marked
 *    them cloudSupported: false while binaryAnalysis.details listed
 *    them as cloud-supported.
 */

// The handler transitively requires the Octokit client (ESM-only under
// Jest); stub it out since these tests never touch GitHub.
jest.mock('../../cli-utils/octokit-client', () => ({}));

const { capToTwoSentences, augmentConnectorData, buildCleanOssData, fieldAnchor, buildFieldsTable, buildChangedDefaultsTable } = require('../../tools/redpanda-connect/rpcn-connector-docs-handler');
const { generateConnectorDiffJson } = require('../../tools/redpanda-connect/report-delta');

describe('capToTwoSentences - xref and filename protection', () => {
  test('does not truncate descriptions containing xref macros', () => {
    const description = 'This processor combines the behaviour of the xref:components:processors/try.adoc[`try`] and xref:components:processors/catch.adoc[`catch`] processors into a single block with an explicit recovery path. Because it contains both the fallible step and its recovery within a single processor, it is the recommended way to handle expected errors when strict error handling is enabled.';

    const result = capToTwoSentences(description);

    // The regression produced the fragment "adoc[`catch`] processors into..."
    expect(result.startsWith('This processor combines')).toBe(true);
    expect(result).toContain('xref:components:processors/try.adoc[`try`]');
    expect(result).toContain('xref:components:processors/catch.adoc[`catch`]');
    expect(result.startsWith('adoc[')).toBe(false);
  });

  test('splits at real sentence boundaries around bare filenames', () => {
    const description = 'Reads settings from config.yaml at startup. Changes require a restart. A third sentence should be dropped.';

    const result = capToTwoSentences(description);

    expect(result).toBe('Reads settings from config.yaml at startup. Changes require a restart.');
  });

  test('keeps leading text when an unprotected mid-token period precedes the first boundary', () => {
    const description = 'Uses internal.token values here. Second sentence follows.';

    const result = capToTwoSentences(description);

    expect(result.startsWith('Uses internal.token values here.')).toBe(true);
  });

  test('still caps plain descriptions to two sentences', () => {
    const description = 'First sentence. Second sentence. Third sentence.';

    expect(capToTwoSentences(description)).toBe('First sentence. Second sentence.');
  });
});

describe('augmentConnectorData - config components', () => {
  const binaryAnalysis = {
    comparison: {
      inCloud: [
        { type: 'processors', name: 'mapping', status: 'stable' },
        { type: 'config', name: 'error_handling', status: '' }
      ]
    },
    cgoOnly: []
  };

  test('stamps cloudSupported on config components found in the cloud binary', () => {
    const connectorData = {
      processors: [{ name: 'mapping', type: 'processor', status: 'stable' }],
      config: [{ name: 'error_handling', type: 'object', kind: 'scalar' }]
    };

    const { augmentedData } = augmentConnectorData(connectorData, binaryAnalysis);

    const errorHandling = augmentedData.config.find(c => c.name === 'error_handling');
    expect(errorHandling.cloudSupported).toBe(true);
    expect(errorHandling.requiresCgo).toBe(false);
  });

  test('marks config components absent from the cloud binary as not cloud supported', () => {
    const connectorData = {
      config: [{ name: 'self_managed_only_block', type: 'object', kind: 'scalar' }]
    };

    const { augmentedData } = augmentConnectorData(connectorData, binaryAnalysis);

    const block = augmentedData.config.find(c => c.name === 'self_managed_only_block');
    expect(block.cloudSupported).toBe(false);
  });
});

describe('generateConnectorDiffJson - config component status and cloud support', () => {
  test('new config component without a status does not report its type as status', () => {
    const oldIndex = { config: [] };
    const newIndex = {
      config: [
        {
          name: 'error_handling',
          type: 'object',
          kind: 'scalar',
          description: 'Configures engine-wide error handling behaviour.',
          cloudSupported: true
        }
      ]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.97.0',
      newVersion: '4.98.0'
    });

    const added = diff.details.newComponents.find(c => c.name === 'error_handling');
    expect(added).toBeDefined();
    expect(added.status).toBe('');
    expect(added.status).not.toBe('object');
    expect(added.cloudSupported).toBe(true);
  });

  test('diff component entry agrees with binaryAnalysis cloud-supported details', () => {
    const oldIndex = { config: [] };
    const newIndex = {
      config: [
        {
          name: 'error_handling',
          type: 'object',
          kind: 'scalar',
          description: 'Configures engine-wide error handling behaviour.',
          cloudSupported: true
        }
      ]
    };
    const binaryAnalysis = {
      ossVersion: '4.98.0',
      cloudVersion: '4.98.0',
      comparison: {
        inCloud: [{ type: 'config', name: 'error_handling', status: '' }],
        ossOnly: [],
        cloudOnly: []
      }
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.97.0',
      newVersion: '4.98.0',
      binaryAnalysis
    });

    const added = diff.details.newComponents.find(c => c.name === 'error_handling');
    const inDetails = (diff.binaryAnalysis.details.cloudSupported || [])
      .some(c => c.type === 'config' && c.name === 'error_handling');

    expect(inDetails).toBe(true);
    expect(added.cloudSupported).toBe(true);
  });
});

describe('buildCleanOssData - pure OSS snapshot for binary analysis', () => {
  // Simulate the persisted data file after a previous run's augmentation: the
  // handler writes augmentConnectorData() output back to connect-<version>.json,
  // so the next run reloads augmentation-only cloud-only/cgo-only entries.
  const makeAugmentedIndex = () => {
    const raw = {
      processors: [
        { name: 'mapping', type: 'processor', config: { children: [] } }
      ],
      config: [
        { name: 'error_handling', type: 'object', kind: 'scalar', description: 'Engine-wide error handling.' }
      ]
    };
    const binaryAnalysis = {
      comparison: {
        inCloud: [
          { type: 'processors', name: 'mapping', status: 'stable' },
          { type: 'config', name: 'error_handling', status: '' }
        ],
        cloudOnly: [
          { type: 'config', name: 'cloud_only_block', status: '' },
          { type: 'processors', name: 'cloud_only_proc', status: '' }
        ]
      },
      cgoOnly: [
        { type: 'config', name: 'cgo_only_block' }
      ]
    };
    return augmentConnectorData(raw, binaryAnalysis).augmentedData;
  };

  test('drops augmentation-only cloud-only and cgo-only config entries', () => {
    const augmented = makeAugmentedIndex();
    // Sanity: augmentation added the extra config entries this run.
    expect(augmented.config.map(c => c.name).sort())
      .toEqual(['cgo_only_block', 'cloud_only_block', 'error_handling']);

    const clean = buildCleanOssData(augmented);

    // Only the genuine OSS config entry survives.
    expect(clean.config.map(c => c.name)).toEqual(['error_handling']);
  });

  test('strips platform metadata from surviving config entries', () => {
    const clean = buildCleanOssData(makeAugmentedIndex());
    const errorHandling = clean.config.find(c => c.name === 'error_handling');

    expect(errorHandling).toBeDefined();
    expect(errorHandling).not.toHaveProperty('cloudSupported');
    expect(errorHandling).not.toHaveProperty('requiresCgo');
    expect(errorHandling).not.toHaveProperty('cloudOnly');
    // Genuine OSS content is preserved.
    expect(errorHandling.kind).toBe('scalar');
    expect(errorHandling.description).toBe('Engine-wide error handling.');
  });

  test('still drops augmentation-only entries from standard connector types', () => {
    const clean = buildCleanOssData(makeAugmentedIndex());
    // cloud_only_proc has no config/fields wrapper, so it is dropped;
    // the genuine mapping processor is kept with metadata stripped.
    expect(clean.processors.map(c => c.name)).toEqual(['mapping']);
    expect(clean.processors[0]).not.toHaveProperty('cloudSupported');
    expect(clean.processors[0]).not.toHaveProperty('requiresCgo');
  });

  test('leaves a raw OSS index (no augmentation markers) unchanged in membership', () => {
    const raw = {
      config: [
        { name: 'error_handling', type: 'object', kind: 'scalar', description: 'x' }
      ],
      processors: [
        { name: 'mapping', type: 'processor', config: { children: [] } }
      ]
    };
    const clean = buildCleanOssData(raw);
    expect(clean.config.map(c => c.name)).toEqual(['error_handling']);
    expect(clean.processors.map(c => c.name)).toEqual(['mapping']);
  });
});

describe('fieldAnchor - fragment anchors for field heading IDs', () => {
  // Connector field docs render fields as section headings (for example,
  // `=== `batching.byte_size``) and the docs site sets idprefix: '' and
  // idseparator: '-', so the rendered heading IDs replace dots with hyphens
  // and drop `[]` array markers. Verified against Asciidoctor.js 2.x with
  // those attributes and against the published pages (for example,
  // <h3 id="batching-byte_size"> and <h3 id="credentials-host_public_key">).

  test('leaves simple field names unchanged', () => {
    expect(fieldAnchor('checkpoint_limit')).toBe('checkpoint_limit');
    expect(fieldAnchor('use_batch')).toBe('use_batch');
  });

  test('replaces dots in nested field names with hyphens', () => {
    expect(fieldAnchor('batching.byte_size')).toBe('batching-byte_size');
    expect(fieldAnchor('credentials.host_public_key')).toBe('credentials-host_public_key');
  });

  test('drops array markers', () => {
    expect(fieldAnchor('sasl[]')).toBe('sasl');
    expect(fieldAnchor('regexp_topics_exclude[]')).toBe('regexp_topics_exclude');
  });

  test('handles deep paths that mix array markers and dots', () => {
    expect(fieldAnchor('sasl[].aws.credentials.from_ec2_role')).toBe('sasl-aws-credentials-from_ec2_role');
    expect(fieldAnchor('batching.processors[]')).toBe('batching-processors');
  });

  test('collapses consecutive separators into a single hyphen', () => {
    // A mid-path array marker produces adjacent invalid characters and a
    // dot; Asciidoctor squeezes the run into one separator.
    expect(fieldAnchor('foo[].bar')).toBe('foo-bar');
    expect(fieldAnchor('foo..bar')).toBe('foo-bar');
  });

  test('downcases names, matching Asciidoctor ID generation', () => {
    expect(fieldAnchor('TLS.Enabled')).toBe('tls-enabled');
  });

  test('deletes invalid characters outright, matching InvalidSectionIdCharsRx', () => {
    // Asciidoctor removes these characters rather than turning them into
    // separators, so `foo/bar` renders as <h3 id="foobar">.
    expect(fieldAnchor('foo/bar')).toBe('foobar');
    expect(fieldAnchor('a:b')).toBe('ab');
  });

  test('falls back to the raw name when normalization empties it', () => {
    // A pathological name must not emit a malformed `#[...]` xref fragment.
    expect(fieldAnchor('///')).toBe('///');
  });
});

describe('buildFieldsTable - whats-new field links', () => {
  const cap = (s) => s;

  test('links simple fields with the bare field name as the fragment', () => {
    const table = buildFieldsTable([
      { component: 'processors:aws_dynamodb_partiql', field: 'use_batch', description: 'Batch mode.' }
    ], cap);

    expect(table).toContain('* xref:components:processors/aws_dynamodb_partiql.adoc#use_batch[aws_dynamodb_partiql]');
  });

  test('links nested fields with a hyphenated fragment matching the rendered heading ID', () => {
    const table = buildFieldsTable([
      { component: 'inputs:sftp', field: 'credentials.host_public_key', description: 'Host key.' }
    ], cap);

    expect(table).toContain('* xref:components:inputs/sftp.adoc#credentials-host_public_key[sftp]');
    // The visible field name in the table keeps its original dotted form.
    expect(table).toContain('|credentials.host_public_key\n');
    expect(table).not.toContain('adoc#credentials.host_public_key[');
  });

  test('links array fields without the [] marker in the fragment', () => {
    const table = buildFieldsTable([
      { component: 'inputs:kafka_franz', field: 'regexp_topics_exclude[]', description: 'Exclusions.' }
    ], cap);

    expect(table).toContain('* xref:components:inputs/kafka_franz.adoc#regexp_topics_exclude[kafka_franz]');
  });
});

describe('buildChangedDefaultsTable - whats-new changed default links', () => {
  const cap = (s) => s;

  test('uses the derived anchor for nested fields', () => {
    const table = buildChangedDefaultsTable([
      {
        component: 'outputs:kafka_franz',
        field: 'batching.byte_size',
        oldDefault: 0,
        newDefault: 1024,
        description: 'Batch size in bytes.'
      }
    ], cap);

    expect(table).toContain('* xref:components:outputs/kafka_franz.adoc#batching-byte_size[kafka_franz]');
    // The visible field name in the table keeps its original dotted form.
    expect(table).toContain('|batching.byte_size\n');
  });
});

describe('backfillPageDescriptions - self-healing page headers', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { backfillPageDescriptions } = require('../../tools/redpanda-connect/generate-rpcn-connector-docs');

  const data = {
    caches: [
      { name: 'multilevel', summary: 'Combines multiple caches as levels,\nacross them.' },
      { name: 'has_desc', summary: 'Should not be used.' },
      { name: 'no_summary', summary: '' },
      { name: 'no_page', summary: 'Page does not exist.' },
    ],
    'bloblang-functions': [{ name: 'not_a_page_family', summary: 'Ignored.' }],
  };

  test('inserts a tagged description into headers that lack one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
    fs.mkdirSync(path.join(root, 'caches'), { recursive: true });
    fs.writeFileSync(path.join(root, 'caches', 'multilevel.adoc'),
      '= multilevel\n// tag::single-source[]\n:type: cache\n:status: stable\n\nBody.\n// end::single-source[]\n');
    fs.writeFileSync(path.join(root, 'caches', 'has_desc.adoc'),
      '= has_desc\n// tag::single-source[]\n:description: Already here.\n\nBody.\n// end::single-source[]\n');
    fs.writeFileSync(path.join(root, 'caches', 'no_summary.adoc'),
      '= no_summary\n// tag::single-source[]\n:type: cache\n\nBody.\n// end::single-source[]\n');

    const result = backfillPageDescriptions(data, { pagesRoot: root });
    expect(result.backfilled).toEqual(['caches/multilevel']);
    expect(result.skippedNoSummary).toEqual(['caches/no_summary']);

    const lines = fs.readFileSync(path.join(root, 'caches', 'multilevel.adoc'), 'utf8').split('\n');
    // Inserted at the end of the header (before the first blank line),
    // summary flattened to one line, wrapped in the meta tag region.
    expect(lines[4]).toBe('// tag::meta[]');
    expect(lines[5]).toBe(':description: Combines multiple caches as levels, across them.');
    expect(lines[6]).toBe('// end::meta[]');
    expect(lines[7]).toBe('');
    // Pages that already have one are untouched
    expect(fs.readFileSync(path.join(root, 'caches', 'has_desc.adoc'), 'utf8')).toContain(':description: Already here.');

    // Idempotent: second run backfills nothing
    expect(backfillPageDescriptions(data, { pagesRoot: root }).backfilled).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('flattens AsciiDoc markup out of the meta text', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-md-'));
    fs.mkdirSync(path.join(root, 'processors'), { recursive: true });
    fs.writeFileSync(path.join(root, 'processors', 'workflow.adoc'),
      '= workflow\n// tag::single-source[]\n:type: processor\n\nBody.\n');
    const result = backfillPageDescriptions({
      processors: [{ name: 'workflow', summary: 'Executes a topology of xref:components:processors/branch.adoc[`branch` processors], in parallel.' }],
    }, { pagesRoot: root });
    expect(result.backfilled).toEqual(['processors/workflow']);
    const page = fs.readFileSync(path.join(root, 'processors', 'workflow.adoc'), 'utf8');
    expect(page).toContain(':description: Executes a topology of branch processors, in parallel.');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('maps the rate-limits data key to the rate_limits pages directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-rl-'));
    fs.mkdirSync(path.join(root, 'rate_limits'), { recursive: true });
    fs.writeFileSync(path.join(root, 'rate_limits', 'local.adoc'),
      '= local\n// tag::single-source[]\n:type: rate_limit\n\nBody.\n');
    const result = backfillPageDescriptions({
      'rate-limits': [{ name: 'local', summary: 'A simple X every Y rate limit.' }],
    }, { pagesRoot: root });
    expect(result.backfilled).toEqual(['rate_limits/local']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('dry run reports without writing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-dry-'));
    fs.mkdirSync(path.join(root, 'caches'), { recursive: true });
    const page = '= multilevel\n// tag::single-source[]\n:type: cache\n\nBody.\n';
    fs.writeFileSync(path.join(root, 'caches', 'multilevel.adoc'), page);
    const result = backfillPageDescriptions(data, { pagesRoot: root, dryRun: true });
    expect(result.backfilled).toEqual(['caches/multilevel']);
    expect(fs.readFileSync(path.join(root, 'caches', 'multilevel.adoc'), 'utf8')).toBe(page);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('mergeOverrides honors summary overrides', () => {
  const { mergeOverrides } = require('../../tools/redpanda-connect/generate-rpcn-connector-docs');

  test('a top-level summary override reaches the component', () => {
    // overrides.json has carried summary overrides (zmq4, ffi) that were
    // silently dropped: 'summary' was missing from scalarKeys and fell
    // through every merge branch.
    const data = { inputs: [{ name: 'zmq4', summary: '' }] };
    mergeOverrides(data, { inputs: [{ name: 'zmq4', summary: 'Consumes messages from a ZeroMQ socket.' }] });
    expect(data.inputs[0].summary).toBe('Consumes messages from a ZeroMQ socket.');
  });
});
