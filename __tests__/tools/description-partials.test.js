'use strict';

const path = require('path');
const fs = require('fs');
const handlebars = require('handlebars');
const helpers = require('../../tools/redpanda-connect/helpers/index.js');

Object.entries(helpers).forEach(([name, fn]) => handlebars.registerHelper(name, fn));

const {
  descriptionIncludeLine,
} = require('../../tools/redpanda-connect/metadata-utils.js');

const renderConnectDescription = require('../../tools/redpanda-connect/helpers/renderConnectDescription.js');
const { generateRpcnConnectorDocs } = require('../../tools/redpanda-connect/generate-rpcn-connector-docs.js');

describe('metadata-utils: descriptionIncludeLine', () => {
  test('builds the descriptions partial include path from type and name', () => {
    expect(descriptionIncludeLine({ type: 'output', name: 'sql_raw' }))
      .toBe('include::connect:components:partial$descriptions/outputs/sql_raw.adoc[]');
  });

  test('respects an explicit typeDir', () => {
    expect(descriptionIncludeLine({ typeDir: 'caches', name: 'memory' }))
      .toBe('include::connect:components:partial$descriptions/caches/memory.adoc[]');
  });
});

describe('renderConnectDescription helper', () => {
  test('replaces an inline == Metadata block with the metadata partial include', () => {
    const item = {
      type: 'input',
      name: 'thing',
      description: [
        'Reads from a thing.',
        '',
        '== Metadata',
        '',
        '- a: one',
        '',
        '== Permissions',
        '',
        'Needs access.',
      ].join('\n'),
    };
    const out = renderConnectDescription(item);
    expect(out).toContain('Reads from a thing.');
    expect(out).toContain('include::connect:components:partial$metadata/inputs/thing.adoc[]');
    expect(out).toContain('== Permissions');
    // The metadata bullets themselves are de-duplicated out of the description.
    expect(out).not.toContain('- a: one');
  });

  test('passes a structured description through unchanged (no collapsing)', () => {
    // Long, but carries its own headings: already navigable, must not collapse.
    const body = 'Intro paragraph.\n\n== Details\n\n' + 'word '.repeat(500);
    const out = renderConnectDescription({ type: 'output', name: 'x', description: body });
    expect(out).not.toContain('[%collapsible]');
    expect(out).toContain('== Details');
  });

  test('collapses a long, heading-less prose wall after the first paragraph', () => {
    const lead = 'This is the lead paragraph that stays visible.';
    const tail = 'Follow-up detail. ' + 'more '.repeat(400);
    const out = renderConnectDescription({
      type: 'output', name: 'x', description: `${lead}\n\n${tail}`,
    });
    expect(out.startsWith(lead)).toBe(true);
    expect(out).toContain('.More details');
    expect(out).toContain('[%collapsible]');
    expect(out).toContain('====');
    expect(out).toContain('Follow-up detail.');
  });

  test('leaves a short prose description untouched', () => {
    const out = renderConnectDescription({ type: 'output', name: 'x', description: 'Short and sweet.' });
    expect(out).toBe('Short and sweet.');
  });

  test('collapse can be disabled via the hash option', () => {
    const body = 'Lead.\n\n' + 'x '.repeat(2000);
    const out = renderConnectDescription(
      { type: 'output', name: 'x', description: body },
      { hash: { collapse: false } },
    );
    expect(out).not.toContain('[%collapsible]');
  });

  test('returns empty string for a missing description', () => {
    expect(renderConnectDescription({ type: 'output', name: 'x' })).toBe('');
  });
});

describe('generator writes a regenerated description partial', () => {
  const tmpDir = path.join(__dirname, 'tmp-description-output');
  let originalCwd, dataFile, templateFile;

  beforeAll(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    const data = {
      outputs: [
        {
          name: 'sql_raw',
          type: 'output',
          version: '3.65.0',
          summary: 'Executes an arbitrary SQL query for each message.',
          description: [
            'Runs a query.',
            '',
            '== Metadata',
            '',
            '- kafka_partition: The partition.',
          ].join('\n'),
          config: { children: [{ name: 'dsn', type: 'string', kind: 'scalar', description: 'A field.' }] },
        },
      ],
    };
    dataFile = path.join(tmpDir, 'data.json');
    fs.writeFileSync(dataFile, JSON.stringify(data), 'utf8');
    templateFile = path.join(tmpDir, 'main.hbs');
    fs.writeFileSync(templateFile, '= {{name}}\n', 'utf8');
  });

  afterAll(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('emits partials/descriptions/<type>/<name>.adoc with summary, version, and metadata include', () => {
    return generateRpcnConnectorDocs({ data: dataFile, template: templateFile }).then(() => {
      const dPath = path.join(
        tmpDir, 'modules', 'components', 'partials', 'descriptions', 'outputs', 'sql_raw.adoc'
      );
      expect(fs.existsSync(dPath)).toBe(true);

      const content = fs.readFileSync(dPath, 'utf8');
      expect(content).toContain('This content is autogenerated. Do not edit manually.');
      expect(content).toContain('Executes an arbitrary SQL query for each message.');
      expect(content).toContain('Introduced in version 3.65.0.');
      expect(content).toContain('Runs a query.');
      // Metadata is emitted as its own partial and included, not inlined here.
      expect(content).toContain('include::connect:components:partial$metadata/outputs/sql_raw.adoc[]');
      expect(content).not.toContain('- kafka_partition: The partition.');
    });
  });
});
