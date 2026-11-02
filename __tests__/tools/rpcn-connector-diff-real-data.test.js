'use strict';

/**
 * Regression test for the connector delta report over REAL connector index
 * data, not hand-built fixtures.
 *
 * The fixtures are inputs:redpanda_migrator as published in connect-4.63.0 and
 * connect-4.70.0, copied verbatim out of the connect index files in
 * rp-connect-docs and trimmed to that one component. That single real pair
 * covers the three things hand-built two-field fixtures never caught:
 *
 * 1. `sasl` is an array of objects, so the published heading is
 *    `sasl[].aws.tcp`. A report saying `sasl.aws.tcp` publishes a config path
 *    that does not exist.
 * 2. Three whole groups arrive in 4.70.0 (`tcp`, `schema_registry`, and `tcp`
 *    under `sasl[].aws`). Reporting every descendant turns 5 changes into 46
 *    rows in the what's-new table.
 * 3. Every field the diff reports has to have a heading on the rendered
 *    reference page, or its what's-new link points at nothing.
 */

// The handler transitively requires the Octokit client (ESM-only under Jest).
jest.mock('../../cli-utils/octokit-client', () => ({}));

const path = require('path');
const fs = require('fs');

const { generateConnectorDiffJson } = require('../../tools/redpanda-connect/report-delta');
const { flattenConnectFields } = require('../../tools/redpanda-connect/helpers/flattenConnectFields');
const renderConnectFields = require('../../tools/redpanda-connect/helpers/renderConnectFields');
const { buildFieldsTable, capToTwoSentences } = require('../../tools/redpanda-connect/rpcn-connector-docs-handler');

const fixture = (version) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'docs-data', 'connect-index', `${version}-inputs-redpanda_migrator.json`),
  'utf8'
));

const OLD_VERSION = '4.63.0';
const NEW_VERSION = '4.70.0';

describe('connector delta report over real connect-4.63.0 to connect-4.70.0 data', () => {
  const oldIndex = fixture(OLD_VERSION);
  const newIndex = fixture(NEW_VERSION);
  const diff = generateConnectorDiffJson(oldIndex, newIndex, {
    oldVersion: OLD_VERSION,
    newVersion: NEW_VERSION
  });

  test('reports each added group once, with the array marker the docs publish', () => {
    expect(diff.details.newFields.map(f => f.field)).toEqual([
      'sasl[].aws.tcp',
      'tcp',
      'regexp_topics_include[]',
      'regexp_topics_exclude[]',
      'schema_registry'
    ]);
    expect(diff.summary.newFields).toBe(5);
  });

  test('reports each removed field once', () => {
    expect(diff.details.removedFields.map(f => f.field)).toEqual([
      'timely_nacks_maximum_wait',
      'output_resource',
      'replication_factor_override',
      'replication_factor',
      'multi_header',
      'batch_size'
    ]);
  });

  test('every reported field has a heading on the rendered reference page', () => {
    const headings = String(renderConnectFields(newIndex.inputs[0].config.children, ''))
      .split('\n')
      .filter(line => line.startsWith('=== '))
      .map(line => line.replace(/^=== `?|`?$/g, ''));

    diff.details.newFields.forEach(f => expect(headings).toContain(f.field));
  });

  test('the published what\'s-new table shows valid config paths', () => {
    const table = buildFieldsTable(diff.details.newFields, capToTwoSentences, { showIntroducedIn: true });

    expect(table).toContain('|sasl[].aws.tcp\n');
    expect(table).not.toContain('|sasl.aws.tcp\n');
    // One "Introduced in" cell per reported field, stamped with the release.
    expect((table.match(/\n\|4\.70\.0\n/g) || []).length).toBe(5);
  });

  test('real field data does carry per-field version metadata', () => {
    // The fallback to the diff target version is a fallback, not the only
    // path: real fields do carry `version`, and it can predate the release
    // being compared.
    const withVersion = flattenConnectFields(newIndex.inputs[0].config.children, { arrayMarker: true })
      .filter(f => f.field.version);

    expect(withVersion.length).toBeGreaterThan(0);
    expect(withVersion.map(f => `${f.path}=${f.field.version}`)).toContain('sasl[].aws.credentials.from_ec2_role=4.2.0');
  });
});
