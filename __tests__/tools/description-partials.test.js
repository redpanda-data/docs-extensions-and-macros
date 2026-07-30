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

// @asciidoctor/core is a transitive dependency (via @antora/asciidoc-loader),
// so it may not be hoisted to the top-level node_modules. Resolve it the same
// way Antora's loader does; skip the render-level assertions if unavailable.
let asciidoctor = null;
try {
  asciidoctor = require('@asciidoctor/core')();
} catch (_) {
  try {
    const { createRequire } = require('module');
    asciidoctor = createRequire(require.resolve('@antora/asciidoc-loader'))('@asciidoctor/core')();
  } catch (_) { /* optional: render tests are skipped */ }
}
const renderTest = asciidoctor ? test : test.skip;

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

  test('passes through a long body containing ==== delimiters (delimiter collision)', () => {
    // The collapsible wrapper is itself a ====-delimited block. A body with
    // its own ==== delimiters (admonition/example blocks, as in the
    // http_server output) must not be wrapped: the nested opening ====
    // would terminate the collapsible early and leak the rest of the body.
    const body = [
      'Lead paragraph explaining the connector. ' + 'pad '.repeat(300),
      '',
      '[CAUTION]',
      '.Endpoint caveats',
      '====',
      'Do not expose this endpoint publicly without auth.',
      '====',
      '',
      'Trailing prose after the admonition.',
    ].join('\n');
    const out = renderConnectDescription({ type: 'output', name: 'http_server', description: body });
    expect(out).not.toContain('[%collapsible]');
    expect(out).not.toContain('.More details');
    // The admonition block survives intact, delimiters and all.
    expect(out).toBe(body.trim());
  });

  renderTest('Asciidoctor render of a ====-carrying body keeps the admonition intact (no leaked blocks)', () => {
    const body = [
      'Lead paragraph. ' + 'pad '.repeat(300),
      '',
      '[CAUTION]',
      '.Endpoint caveats',
      '====',
      'Do not expose this endpoint publicly without auth.',
      '====',
      '',
      'Trailing prose after the admonition.',
    ].join('\n');
    const out = renderConnectDescription({ type: 'output', name: 'http_server', description: body });
    const html = asciidoctor.convert(out);
    // The caution renders as a styled admonition, not as leaked paragraphs.
    expect(html).toContain('admonitionblock caution');
    expect(html).toContain('Endpoint caveats');
    // No collapsible and no stray empty example block (the ==== body renders
    // as the admonition, not as a bare example block).
    expect(html).not.toContain('<details');
    expect(html).not.toContain('exampleblock');
  });

  renderTest('Asciidoctor render of the plain collapsible case keeps all content inside the block', () => {
    const lead = 'This is the lead paragraph that stays visible.';
    const tail = 'Follow-up detail sentinel. ' + 'more '.repeat(400);
    const out = renderConnectDescription({
      type: 'output', name: 'x', description: `${lead}\n\n${tail}`,
    });
    const html = asciidoctor.convert(out);
    const detailsStart = html.indexOf('<details>');
    const detailsEnd = html.indexOf('</details>');
    expect(detailsStart).toBeGreaterThan(-1);
    // The tail is inside the collapsible, and nothing renders after it.
    expect(html.indexOf('Follow-up detail sentinel.')).toBeGreaterThan(detailsStart);
    expect(html.indexOf('Follow-up detail sentinel.')).toBeLessThan(detailsEnd);
    expect(html.slice(detailsEnd + '</details>'.length).trim().replace(/<\/div>/g, '').trim()).toBe('');
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
      // Non-connector data key: no reference page will ever include a
      // description partial for these, so none must be emitted.
      config: [
        {
          name: 'logger',
          type: 'object',
          description: 'Configures the service-wide logger.',
          config: { children: [{ name: 'level', type: 'string', kind: 'scalar', description: 'A field.' }] },
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

  test('does not emit description partials for non-connector data keys such as config', () => {
    return generateRpcnConnectorDocs({ data: dataFile, template: templateFile }).then(() => {
      const configsDir = path.join(
        tmpDir, 'modules', 'components', 'partials', 'descriptions', 'configs'
      );
      expect(fs.existsSync(configsDir)).toBe(false);
    });
  });
});

describe('generator empties a stale description partial when the description is removed', () => {
  const tmpDir = path.join(__dirname, 'tmp-description-stale');
  let originalCwd, templateFile;
  const dPath = path.join(
    tmpDir, 'modules', 'components', 'partials', 'descriptions', 'inputs', 'dropped_desc.adoc'
  );

  function writeData (withDescription) {
    const data = {
      inputs: [
        {
          name: 'dropped_desc',
          type: 'input',
          ...(withDescription ? { description: 'Reads from a thing that still exists upstream.' } : {}),
          config: { children: [{ name: 'foo', type: 'string', kind: 'scalar', description: 'A field.' }] },
        },
      ],
    };
    const dataFile = path.join(tmpDir, 'data.json');
    fs.writeFileSync(dataFile, JSON.stringify(data), 'utf8');
    return dataFile;
  }

  beforeAll(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    templateFile = path.join(tmpDir, 'main.hbs');
    fs.writeFileSync(templateFile, '= {{name}}\n', 'utf8');
  });

  afterAll(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('keeps the file (include stays resolvable) but blanks its content and logs', async () => {
    // First run: the connector still has a description, so a partial is written.
    await generateRpcnConnectorDocs({ data: writeData(true), template: templateFile });
    expect(fs.existsSync(dPath)).toBe(true);
    expect(fs.readFileSync(dPath, 'utf8')).toContain('Reads from a thing that still exists upstream.');

    // Second run: the description disappeared upstream.
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    let logged;
    try {
      await generateRpcnConnectorDocs({ data: writeData(false), template: templateFile });
      logged = logSpy.mock.calls.map(args => args.join(' ')).join('\n');
    } finally {
      logSpy.mockRestore();
    }

    // The file must survive so any hardcoded include directive still resolves...
    expect(fs.existsSync(dPath)).toBe(true);
    const content = fs.readFileSync(dPath, 'utf8');
    // ...but the stale description is gone, replaced by a banner-only file.
    expect(content).not.toContain('Reads from a thing that still exists upstream.');
    expect(content).toContain('This content is autogenerated. Do not edit manually.');
    expect(content).toContain('intentionally empty');

    // And a human-facing log line points at the stale partial.
    expect(logged).toContain('Description removed upstream');
    expect(logged).toContain(path.join('descriptions', 'inputs', 'dropped_desc.adoc'));
  });
});
