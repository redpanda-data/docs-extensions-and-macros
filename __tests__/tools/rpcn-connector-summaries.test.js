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
const { generateConnectorDiffJson, printDeltaReport } = require('../../tools/redpanda-connect/report-delta');
const renderConnectFields = require('../../tools/redpanda-connect/helpers/renderConnectFields');

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

  test('detects a new field nested under an existing group, not just new top-level fields', () => {
    // aws_s3's "sqs" group already exists in both versions; only a field
    // nested inside it is new. A diff that only compares top-level field
    // names would see "sqs" unchanged and report zero new fields, even
    // though sqs.zero_key_warn_interval is genuinely new.
    const oldIndex = {
      inputs: [
        {
          name: 'aws_s3',
          config: {
            children: [
              { name: 'bucket', description: 'Bucket name.' },
              {
                name: 'sqs',
                children: [
                  { name: 'url', description: 'Queue URL.' }
                ]
              }
            ]
          }
        }
      ]
    };
    const newIndex = {
      inputs: [
        {
          name: 'aws_s3',
          config: {
            children: [
              { name: 'bucket', description: 'Bucket name.' },
              {
                name: 'sqs',
                children: [
                  { name: 'url', description: 'Queue URL.' },
                  { name: 'zero_key_warn_interval', description: 'Warn interval.' }
                ]
              }
            ]
          }
        }
      ]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.103.1',
      newVersion: '4.104.0'
    });

    expect(diff.summary.newFields).toBe(1);
    const added = diff.details.newFields.find(f => f.field === 'sqs.zero_key_warn_interval');
    expect(added).toBeDefined();
    expect(added.component).toBe('inputs:aws_s3');
  });

  test('reports a newly added group once, not once per field inside it', () => {
    const oldIndex = {
      inputs: [{ name: 'kafka', config: { children: [{ name: 'topics', kind: 'scalar' }] } }]
    };
    const newIndex = {
      inputs: [{
        name: 'kafka',
        config: {
          children: [
            { name: 'topics', kind: 'scalar' },
            {
              name: 'sasl',
              kind: 'scalar',
              description: 'SASL settings.',
              children: [
                { name: 'mechanism', kind: 'scalar' },
                { name: 'user', kind: 'scalar' },
                { name: 'password', kind: 'scalar' }
              ]
            }
          ]
        }
      }]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, { oldVersion: '1.0.0', newVersion: '1.1.0' });

    // The group row already covers everything inside it.
    expect(diff.details.newFields.map(f => f.field)).toEqual(['sasl']);
    expect(diff.summary.newFields).toBe(1);
  });

  test('reports a removed group once, not once per field inside it', () => {
    const withSasl = () => ({
      inputs: [{
        name: 'kafka',
        config: {
          children: [
            { name: 'topics', kind: 'scalar' },
            {
              name: 'sasl',
              kind: 'scalar',
              children: [
                { name: 'mechanism', kind: 'scalar' },
                { name: 'user', kind: 'scalar' },
                { name: 'password', kind: 'scalar' }
              ]
            }
          ]
        }
      }]
    });
    const newIndex = {
      inputs: [{ name: 'kafka', config: { children: [{ name: 'topics', kind: 'scalar' }] } }]
    };

    const diff = generateConnectorDiffJson(withSasl(), newIndex, { oldVersion: '1.0.0', newVersion: '1.1.0' });

    expect(diff.details.removedFields.map(f => f.field)).toEqual(['sasl']);
    expect(diff.summary.removedFields).toBe(1);
  });

  test('still reports a field removed from a group that survives', () => {
    const children = (saslChildren) => ([
      { name: 'topics', kind: 'scalar' },
      { name: 'sasl', kind: 'scalar', children: saslChildren }
    ]);
    const oldIndex = {
      inputs: [{ name: 'kafka', config: { children: children([{ name: 'mechanism', kind: 'scalar' }, { name: 'user', kind: 'scalar' }]) } }]
    };
    const newIndex = {
      inputs: [{ name: 'kafka', config: { children: children([{ name: 'mechanism', kind: 'scalar' }]) } }]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, { oldVersion: '1.0.0', newVersion: '1.1.0' });

    expect(diff.details.removedFields.map(f => f.field)).toEqual(['sasl.user']);
  });

  test('leaves a field that arrives already deprecated out of the new-field set', () => {
    // renderConnectFields renders no heading for a deprecated field, so a
    // what's-new row would link to a fragment that does not exist.
    const oldIndex = {
      inputs: [{ name: 'aws_s3', config: { children: [{ name: 'sqs', kind: 'scalar', children: [{ name: 'url', kind: 'scalar' }] }] } }]
    };
    const newChildren = [{
      name: 'sqs',
      kind: 'scalar',
      children: [
        { name: 'url', kind: 'scalar' },
        { name: 'legacy_poll', kind: 'scalar', is_deprecated: true, description: 'Old polling.' },
        { name: 'wait_time', kind: 'scalar', description: 'Wait time.' }
      ]
    }];
    const newIndex = { inputs: [{ name: 'aws_s3', config: { children: newChildren } }] };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, { oldVersion: '1.0.0', newVersion: '1.1.0' });

    expect(diff.details.newFields.map(f => f.field)).toEqual(['sqs.wait_time']);
    expect(String(renderConnectFields(newChildren, ''))).not.toContain('legacy_poll');
  });

  test('keeps the [] marker on a field nested under an array-of-object group', () => {
    // `sasl` is kind: array in the real connect data, so the reference page
    // heads the field `sasl[].aws.tcp`. A what's-new row saying
    // `sasl.aws.tcp` publishes a config path that does not exist.
    const saslChildren = (awsExtra = []) => ([
      {
        name: 'sasl',
        kind: 'array',
        type: 'object',
        children: [
          { name: 'mechanism', kind: 'scalar', type: 'string' },
          {
            name: 'aws',
            kind: 'scalar',
            type: 'object',
            children: [{ name: 'region', kind: 'scalar', type: 'string' }, ...awsExtra]
          }
        ]
      }
    ]);
    const oldIndex = { inputs: [{ name: 'redpanda', config: { children: saslChildren() } }] };
    const newChildren = saslChildren([
      { name: 'tcp', kind: 'scalar', type: 'string', description: 'TCP settings.' }
    ]);
    const newIndex = { inputs: [{ name: 'redpanda', config: { children: newChildren } }] };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.103.1',
      newVersion: '4.104.0'
    });
    const paths = diff.details.newFields.map(f => f.field);

    expect(paths).toContain('sasl[].aws.tcp');
    expect(paths).not.toContain('sasl.aws.tcp');

    // Every reported path must match a heading the reference page renders,
    // because the what's-new table links to those headings.
    const headings = String(renderConnectFields(newChildren, ''))
      .split('\n')
      .filter(line => line.startsWith('=== '))
      .map(line => line.replace(/^=== `?|`?$/g, ''));
    paths.forEach(fieldPath => expect(headings).toContain(fieldPath));

    // The link target is unchanged: the anchor normalizes the marker away.
    expect(fieldAnchor('sasl[].aws.tcp')).toBe('sasl-aws-tcp');
    expect(fieldAnchor('sasl[].aws.tcp')).toBe(fieldAnchor('sasl.aws.tcp'));
  });

  test('stamps the diff target version onto a new field when the source data carries none', () => {
    const oldIndex = { inputs: [{ name: 'foo', config: { children: [] } }] };
    const newIndex = {
      inputs: [{ name: 'foo', config: { children: [{ name: 'bar', description: 'A field.' } ] } }]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.103.1',
      newVersion: '4.104.0'
    });

    expect(diff.details.newFields[0].introducedIn).toBe('4.104.0');
  });

  test('prefers a field-level version over the diff target version, when the source data has one', () => {
    const oldIndex = { inputs: [{ name: 'foo', config: { children: [] } }] };
    const newIndex = {
      inputs: [{ name: 'foo', config: { children: [{ name: 'bar', introducedInVersion: '4.99.0' }] } }]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.103.1',
      newVersion: '4.104.0'
    });

    expect(diff.details.newFields[0].introducedIn).toBe('4.99.0');
  });
});

describe('printDeltaReport - console report agrees with the diff JSON', () => {
  const oldIndex = { inputs: [{ name: 'aws_s3', config: { children: [{ name: 'bucket', kind: 'scalar' }] } }] };
  const newIndex = {
    inputs: [{
      name: 'aws_s3',
      config: { children: [{ name: 'bucket', kind: 'scalar' }, { name: 'region', kind: 'scalar' }] }
    }]
  };

  const capture = (fn) => {
    const out = [];
    const log = jest.spyOn(console, 'log').mockImplementation(msg => out.push(String(msg === undefined ? '' : msg)));
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(msg => { out.push(String(msg)); return true; });
    try {
      fn();
    } finally {
      log.mockRestore();
      write.mockRestore();
    }
    return out.join('');
  };

  test('stamps the diff target version onto a new field, like the diff JSON does', () => {
    const report = capture(() => printDeltaReport(oldIndex, newIndex, { newVersion: '4.104.0' }));
    const diff = generateConnectorDiffJson(oldIndex, newIndex, { oldVersion: '4.103.1', newVersion: '4.104.0' });

    expect(report).toContain('introducedIn: 4.104.0');
    expect(diff.details.newFields[0].introducedIn).toBe('4.104.0');
  });

  test('reports an added group once, like the diff JSON does', () => {
    const withGroup = {
      inputs: [{
        name: 'aws_s3',
        config: {
          children: [
            { name: 'bucket', kind: 'scalar' },
            { name: 'sqs', kind: 'scalar', children: [{ name: 'url', kind: 'scalar' }, { name: 'wait', kind: 'scalar' }] }
          ]
        }
      }]
    };
    const report = capture(() => printDeltaReport(oldIndex, withGroup, { newVersion: '4.104.0' }));

    expect(report).toContain('inputs:aws_s3 → sqs');
    expect(report).not.toContain('sqs.url');
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

  test('keeps distinct "Introduced in" versions apart when two components gain the same field', () => {
    const table = buildFieldsTable([
      { component: 'inputs:a', field: 'urls', description: 'Urls A.', introducedIn: '3.58.0' },
      { component: 'inputs:b', field: 'urls', description: 'Urls B.', introducedIn: '4.23.0' }
    ], cap, { showIntroducedIn: true });

    expect(table).toContain('|3.58.0');
    expect(table).toContain('|4.23.0');
    expect(table.match(/\|urls\n/g)).toHaveLength(2);
    expect(table).toContain('xref:components:inputs/a.adoc#urls[a]');
    expect(table).toContain('xref:components:inputs/b.adoc#urls[b]');
  });

  test('still merges components that gained the same field in the same release', () => {
    const table = buildFieldsTable([
      { component: 'inputs:a', field: 'urls', description: 'Urls.', introducedIn: '4.23.0' },
      { component: 'inputs:b', field: 'urls', description: 'Urls.', introducedIn: '4.23.0' }
    ], cap, { showIntroducedIn: true });

    expect(table.match(/\|urls\n/g)).toHaveLength(1);
    expect(table).toContain('xref:components:inputs/a.adoc#urls[a]');
    expect(table).toContain('xref:components:inputs/b.adoc#urls[b]');
  });

  test('merges components into one row when the version column is off', () => {
    const table = buildFieldsTable([
      { component: 'inputs:a', field: 'urls', description: 'Urls A.', introducedIn: '3.58.0' },
      { component: 'inputs:b', field: 'urls', description: 'Urls B.', introducedIn: '4.23.0' }
    ], cap);

    expect(table.match(/\|urls\n/g)).toHaveLength(1);
  });

  test('omits the "Introduced in" column by default', () => {
    const table = buildFieldsTable([
      { component: 'inputs:aws_s3', field: 'sqs.zero_key_warn_interval', description: 'Warn interval.', introducedIn: '4.104.0' }
    ], cap);

    expect(table).not.toContain('Introduced in');
  });

  test('adds an "Introduced in" column when showIntroducedIn is set', () => {
    const table = buildFieldsTable([
      { component: 'inputs:aws_s3', field: 'sqs.zero_key_warn_interval', description: 'Warn interval.', introducedIn: '4.104.0' }
    ], cap, { showIntroducedIn: true });

    expect(table).toContain('|Field |Description |Affected components |Introduced in');
    expect(table).toContain('|4.104.0');
  });

  test('"Introduced in" column falls back to a dash when a field has no version', () => {
    const table = buildFieldsTable([
      { component: 'inputs:aws_s3', field: 'sqs.zero_key_warn_interval', description: 'Warn interval.' }
    ], cap, { showIntroducedIn: true });

    expect(table).toContain('|-\n');
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

  test('flattens bare URL macros and internal xref shorthand out of the meta text', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-url-'));
    fs.mkdirSync(path.join(root, 'tracers'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tracers', 'open_telemetry_collector.adoc'),
      '= open_telemetry_collector\n// tag::single-source[]\n:type: tracer\n\nBody.\n');
    fs.mkdirSync(path.join(root, 'outputs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'outputs', 'broker.adoc'),
      '= broker\n// tag::single-source[]\n:type: output\n\nBody.\n');
    const result = backfillPageDescriptions({
      tracers: [{ name: 'open_telemetry_collector', summary: 'Send tracing events to an https://opentelemetry.io/docs/collector/[Open Telemetry collector^].' }],
      outputs: [{ name: 'broker', summary: 'Allows you to route messages to multiple child outputs using a range of brokering <<patterns>>.' }],
    }, { pagesRoot: root });
    expect(result.backfilled).toEqual(['tracers/open_telemetry_collector', 'outputs/broker']);
    expect(fs.readFileSync(path.join(root, 'tracers', 'open_telemetry_collector.adoc'), 'utf8'))
      .toContain(':description: Send tracing events to an Open Telemetry collector.');
    expect(fs.readFileSync(path.join(root, 'outputs', 'broker.adoc'), 'utf8'))
      .toContain(':description: Allows you to route messages to multiple child outputs using a range of brokering patterns.');
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
