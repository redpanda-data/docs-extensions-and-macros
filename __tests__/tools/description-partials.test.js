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

  test('passes every description through unchanged: no collapsing, no demotion', () => {
    // Collapsible wrapping was evaluated and rejected: it hides primary
    // content, breaks on bodies with their own ==== delimiters, and
    // find/deep-link behavior into closed details is browser-dependent.
    // Heading demotion was rejected: the description renders before the
    // page's first == section, so demoted headings are out of sequence.
    const structured = 'Intro paragraph.\n\n== Details\n\n' + 'word '.repeat(500);
    expect(renderConnectDescription({ type: 'output', name: 'x', description: structured }))
      .toBe(structured.trim());

    const wall = 'Lead paragraph.\n\n' + 'more '.repeat(600);
    const out = renderConnectDescription({ type: 'output', name: 'x', description: wall });
    expect(out).toBe(wall.trim());
    expect(out).not.toContain('[%collapsible]');
  });

  test('returns empty string for a missing description', () => {
    expect(renderConnectDescription({ type: 'output', name: 'x' })).toBe('');
  });

  renderTest('Asciidoctor renders embedded headings as clean top-level sections (published-page parity)', () => {
    const body = [
      'Lead paragraph.',
      '',
      '== Credentials',
      '',
      'How to authenticate.',
      '',
      '=== Key pair authentication',
      '',
      'Details.',
    ].join('\n');
    const out = renderConnectDescription({ type: 'output', name: 'snowflake_put', description: body });
    const mem = asciidoctor.MemoryLogger.create();
    asciidoctor.LoggerManager.setLogger(mem);
    const html = asciidoctor.convert(`= snowflake_put\n\n${out}\n\n== Fields\n\nfields`);
    // Passthrough produces the same h2/h3 structure the published pages have
    // today, with zero section-sequence warnings. (Demotion produces
    // "section title out of sequence" for every embedded heading.)
    expect(html).toMatch(/<h2[^>]*>(<a[^>]*><\/a>)?Credentials/);
    expect(html).toMatch(/<h3[^>]*>(<a[^>]*><\/a>)?Key pair authentication/);
    expect(mem.getMessages().length).toBe(0);
  });
});

describe('hasStructuralHeadings', () => {
  const { hasStructuralHeadings, LONG_HEADINGLESS_THRESHOLD } = renderConnectDescription;

  test('detects headings outside listing blocks and ignores ones inside', () => {
    expect(hasStructuralHeadings('Prose.\n\n== Section\n\nMore.')).toBe(true);
    expect(hasStructuralHeadings('Prose.\n\n----\n== not a heading\n----\n')).toBe(false);
    expect(hasStructuralHeadings('Just prose.')).toBe(false);
  });

  test('exports the reporting threshold', () => {
    expect(LONG_HEADINGLESS_THRESHOLD).toBe(1200);
  });

  test('markdown ## headings do not count as structure', () => {
    // The descriptions that render worst are exactly the ones whose only
    // structure is markdown headings — they must NOT be exempted from the
    // long-description report.
    expect(hasStructuralHeadings('Prose.\n\n## Markdown heading\n\nMore.')).toBe(false);
  });
});

describe('hasMarkdownHeadings', () => {
  const { hasMarkdownHeadings } = renderConnectDescription;

  test('detects markdown headings outside listing blocks only', () => {
    expect(hasMarkdownHeadings('Prose.\n\n## Section\n\nMore.')).toBe(true);
    expect(hasMarkdownHeadings('Prose.\n\n----\n## comment in code\n----\n')).toBe(false);
    expect(hasMarkdownHeadings('Prose.\n\n== AsciiDoc only.')).toBe(false);
  });
});

describe('summaryAttribute helper', () => {
  const summaryAttribute = require('../../tools/redpanda-connect/helpers/summaryAttribute.js');

  test('flattens multi-line summaries to a single attribute-safe line', () => {
    expect(summaryAttribute('Executes a query\nfor each message.'))
      .toBe('Executes a query for each message.');
  });

  test('passes single-line summaries through and handles empties', () => {
    expect(summaryAttribute('Already one line.')).toBe('Already one line.');
    expect(summaryAttribute('')).toBe('');
    expect(summaryAttribute(undefined)).toBe('');
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

  test('emits attrs and body tags so pages can refresh :description: and the body from one file', () => {
    return generateRpcnConnectorDocs({ data: dataFile, template: templateFile }).then(() => {
      const dPath = path.join(
        tmpDir, 'modules', 'components', 'partials', 'descriptions', 'outputs', 'sql_raw.adoc'
      );
      const content = fs.readFileSync(dPath, 'utf8');
      expect(content).toContain('// tag::attrs[]');
      expect(content).toContain(':description: Executes an arbitrary SQL query for each message.');
      expect(content).toContain('// end::attrs[]');
      expect(content).toContain('// tag::body[]');
      expect(content).toContain('// end::body[]');
      // The attribute line sits inside the attrs tag, before the body tag.
      const attrLine = content.indexOf(':description: Executes');
      expect(attrLine).toBeGreaterThan(content.indexOf('// tag::attrs[]'));
      expect(attrLine).toBeLessThan(content.indexOf('// tag::body[]'));
    });
  });

  renderTest('a page consuming both tags gets a fresh :description: attribute and body', () => {
    return generateRpcnConnectorDocs({ data: dataFile, template: templateFile }).then(() => {
      const dPath = path.join(
        tmpDir, 'modules', 'components', 'partials', 'descriptions', 'outputs', 'sql_raw.adoc'
      );
      const page = [
        '= sql_raw',
        `include::${dPath}[tag=attrs]`,
        '',
        `include::${dPath}[tag=body]`,
        '',
        '== Fields',
        '',
        'fields',
      ].join('\n');
      const pagePath = path.join(tmpDir, 'page.adoc');
      fs.writeFileSync(pagePath, page, 'utf8');
      const doc = asciidoctor.loadFile(pagePath, { safe: 'unsafe' });
      expect(doc.getAttribute('description')).toBe('Executes an arbitrary SQL query for each message.');
      const html = doc.convert();
      expect(html).toContain('Executes an arbitrary SQL query for each message.');
      expect(html).toContain('Runs a query.');
    });
  });

  test('reports long heading-less descriptions as upstream structure candidates', () => {
    const wallData = {
      outputs: [
        {
          name: 'walloftext',
          type: 'output',
          summary: 'Writes somewhere.',
          description: 'Lead paragraph. ' + 'prose '.repeat(300),
          config: { children: [{ name: 'dsn', type: 'string', kind: 'scalar', description: 'A field.' }] },
        },
      ],
    };
    const wallFile = path.join(tmpDir, 'wall.json');
    fs.writeFileSync(wallFile, JSON.stringify(wallData), 'utf8');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    return generateRpcnConnectorDocs({ data: wallFile, template: templateFile }).then(() => {
      const warned = warnSpy.mock.calls.map(args => args.join(' ')).join('\n');
      warnSpy.mockRestore();
      expect(warned).toContain('Long heading-less description: outputs/walloftext');
      expect(warned).toContain('adding == sections upstream');
    }, (err) => { warnSpy.mockRestore(); throw err; });
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

describe('summary-only and escapable-summary connectors (CodeRabbit findings)', () => {
  const tmpDir = path.join(__dirname, 'tmp-description-summary-only');
  let originalCwd, templateFile;

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

  test('a connector with a summary but no description still gets a partial (40 real connectors)', () => {
    const data = {
      outputs: [
        {
          name: 'summary_only',
          type: 'output',
          summary: "Caches messages & forwards them to Bob's <special> queue.",
          config: { children: [{ name: 'x', type: 'string', kind: 'scalar', description: 'A field.' }] },
        },
      ],
    };
    const dataFile = path.join(tmpDir, 'data.json');
    fs.writeFileSync(dataFile, JSON.stringify(data), 'utf8');
    return generateRpcnConnectorDocs({ data: dataFile, template: templateFile }).then(() => {
      const dPath = path.join(
        tmpDir, 'modules', 'components', 'partials', 'descriptions', 'outputs', 'summary_only.adoc'
      );
      expect(fs.existsSync(dPath)).toBe(true);
      const content = fs.readFileSync(dPath, 'utf8');
      // Not blanked as "removed upstream"
      expect(content).not.toContain('intentionally empty');
      expect(content).toContain('// tag::attrs[]');
      // The attribute value is raw text, never HTML-escaped
      expect(content).toContain(":description: Caches messages & forwards them to Bob's <special> queue.");
      expect(content).not.toContain('&amp;');
      expect(content).not.toContain('&#x27;');
      expect(content).not.toContain('&lt;');
    });
  });
});

describe('placeholder escaping and heading-sequence reporting', () => {
  test('escapes brace placeholders in prose and spans, never in listing blocks', () => {
    const { escapePlaceholderBraces } = renderConnectDescription;
    const input = 'Posts to `{endpoint}/v1/traces` and /data/{api_version}/graphql.\n\n----\ncurl {endpoint}/v1/logs\n----';
    const out = escapePlaceholderBraces(input);
    expect(out).toContain('`\\{endpoint}/v1/traces`');
    expect(out).toContain('/data/\\{api_version}/graphql');
    // Inside the listing block the braces are already literal
    expect(out).toContain('curl {endpoint}/v1/logs');
  });

  test('renderConnectDescription applies the escaping (otlp_http case)', () => {
    const out = renderConnectDescription({
      type: 'output', name: 'otlp_http',
      description: 'Traces go to `{endpoint}/v1/traces`.',
    });
    expect(out).toContain('\\{endpoint}');
  });

  test('firstHeadingDepth flags markdown ### and asciidoc === starts, accepts == and ##', () => {
    const { firstHeadingDepth } = renderConnectDescription;
    expect(firstHeadingDepth('Intro.\n\n### Prerequisites\n\nBody.')).toBe(3);
    expect(firstHeadingDepth('Intro.\n\n=== Apache Polaris\n\nBody.')).toBe(3);
    expect(firstHeadingDepth('Intro.\n\n== Operators\n\n=== to_json')).toBe(2);
    expect(firstHeadingDepth('No headings at all.')).toBe(null);
    expect(firstHeadingDepth('----\n=== inside block\n----\nprose')).toBe(null);
  });
});

describe('ensureHeadingSeparation', () => {
  const { ensureHeadingSeparation } = renderConnectDescription;

  test('inserts the blank line a glued heading needs (protobuf case)', () => {
    const input = 'Prose paragraph.\n== Operators\n\n=== `to_json`\n\nBody.';
    const out = ensureHeadingSeparation(input);
    expect(out).toContain('Prose paragraph.\n\n== Operators');
  });

  test('leaves already-separated headings and listing blocks alone', () => {
    const ok = 'Prose.\n\n== Section\n\n----\ntext\n== not a heading\n----';
    expect(ensureHeadingSeparation(ok)).toBe(ok);
  });
});
