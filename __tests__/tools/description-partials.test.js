'use strict';

const path = require('path');
const fs = require('fs');
const handlebars = require('handlebars');
const helpers = require('../../tools/redpanda-connect/helpers/index.js');

Object.entries(helpers).forEach(([name, fn]) => handlebars.registerHelper(name, fn));

const {
  descriptionIncludeLine,
  metadataIncludeLine,
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

describe('markdown fence awareness: fence interiors pass through byte-identical', () => {
  const {
    escapePlaceholderBraces,
    ensureHeadingSeparation,
    hasStructuralHeadings,
    hasMarkdownHeadings,
    firstHeadingDepth,
  } = renderConnectDescription;

  // A fenced example whose interior exercises every rewriter: a glued
  // #-comment line (ensureHeadingSeparation must NOT push a blank line into
  // the example), a {token} placeholder (escapePlaceholderBraces must NOT
  // prepend a backslash — `\{endpoint}` renders with a literal backslash),
  // and a `==` line (the scanners must not count it as a heading).
  const fenceInterior = [
    '## endpoint config',
    'url: {endpoint}/v1/logs',
    '== not a heading',
  ].join('\n');
  const body = [
    'Prose with a real {placeholder} outside.',
    '```yaml',
    fenceInterior,
    '```',
    '',
    'Trailing prose {token}.',
  ].join('\n');

  test('escapePlaceholderBraces and ensureHeadingSeparation leave the fence interior untouched, prose still escaped (otlp_http corruption case)', () => {
    const out = escapePlaceholderBraces(ensureHeadingSeparation(body));
    // Byte-identical passthrough of the whole fenced block.
    expect(out).toContain('```yaml\n' + fenceInterior + '\n```');
    // Prose outside the fence still gets the escape.
    expect(out).toContain('Prose with a real \\{placeholder} outside.');
    expect(out).toContain('Trailing prose \\{token}.');
  });

  test('renderConnectDescription end-to-end never corrupts a fenced example', () => {
    const out = renderConnectDescription({ type: 'output', name: 'otlp_http', description: body });
    expect(out).toContain('url: {endpoint}/v1/logs');
    expect(out).not.toContain('\\{endpoint}');
    expect(out).toContain('```yaml\n## endpoint config');
  });

  test('the heading scanners ignore fence interiors (``` and ~~~)', () => {
    expect(hasStructuralHeadings(body)).toBe(false);
    expect(hasMarkdownHeadings(body)).toBe(false);
    expect(firstHeadingDepth(body)).toBe(null);
    expect(hasMarkdownHeadings('Prose.\n\n~~~\n## a comment\n~~~')).toBe(false);
  });

  test('delimiters keep layered state: a ---- inside a fence is content, not a block opener', () => {
    // If the ---- leaked into block state, the real heading after the fence
    // would be swallowed as "inside a listing block".
    expect(hasStructuralHeadings('```\n----\n```\n\n== Real heading\n\nProse.')).toBe(true);
  });
});

describe('generator blanks description partials orphaned by connectors deleted upstream', () => {
  const tmpDir = path.join(__dirname, 'tmp-description-orphan');
  let originalCwd, templateFile;
  const keptPath = path.join(
    tmpDir, 'modules', 'components', 'partials', 'descriptions', 'inputs', 'still_here.adoc'
  );
  const orphanPath = path.join(
    tmpDir, 'modules', 'components', 'partials', 'descriptions', 'inputs', 'deleted_upstream.adoc'
  );

  function writeData (names) {
    const data = {
      inputs: names.map((name) => ({
        name,
        type: 'input',
        description: `Reads things for ${name}.`,
        config: { children: [{ name: 'foo', type: 'string', kind: 'scalar', description: 'A field.' }] },
      })),
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

  test('a partial whose connector vanished from the dataset is blanked and reported', async () => {
    // First run: both connectors exist.
    await generateRpcnConnectorDocs({ data: writeData(['still_here', 'deleted_upstream']), template: templateFile });
    expect(fs.readFileSync(orphanPath, 'utf8')).toContain('Reads things for deleted_upstream.');

    // Second run: deleted_upstream is gone from the dataset entirely, so the
    // in-loop stale handling never sees it. The post-loop sweep must.
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    let result, logged;
    try {
      result = await generateRpcnConnectorDocs({ data: writeData(['still_here']), template: templateFile });
      logged = logSpy.mock.calls.map(args => args.join(' ')).join('\n');
    } finally {
      logSpy.mockRestore();
    }

    // The orphan survives as a file (includes stay resolvable) but is blanked.
    expect(fs.existsSync(orphanPath)).toBe(true);
    const content = fs.readFileSync(orphanPath, 'utf8');
    expect(content).not.toContain('Reads things for deleted_upstream.');
    expect(content).toContain('intentionally empty');

    // The surviving connector's partial is untouched.
    expect(fs.readFileSync(keptPath, 'utf8')).toContain('Reads things for still_here.');

    // Reported in descriptionReports (surfaces in the PR summary) and logged.
    expect(result.descriptionReports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        connector: 'inputs/deleted_upstream',
        message: expect.stringContaining('Connector removed upstream'),
      }),
    ]));
    expect(logged).toContain(path.join('descriptions', 'inputs', 'deleted_upstream.adoc'));

    // Merged-return sanity: this PR's report key coexists with the keys main
    // added for lost sections and description backfill.
    expect(result).toHaveProperty('lostSectionWarnings');
    expect(result).toHaveProperty('descriptionBackfill');
  });

  test('an already-blanked orphan is not re-reported on the next run', async () => {
    const result = await generateRpcnConnectorDocs({ data: writeData(['still_here']), template: templateFile });
    expect(result.descriptionReports).toEqual([]);
    expect(fs.readFileSync(orphanPath, 'utf8')).toContain('intentionally empty');
  });
});

describe('summaries are brace-escaped like description bodies', () => {
  const tmpDir = path.join(__dirname, 'tmp-description-summary-braces');
  let originalCwd, templateFile, dataFile;
  const dPath = path.join(
    tmpDir, 'modules', 'components', 'partials', 'descriptions', 'outputs', 'braced_summary.adoc'
  );

  beforeAll(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    templateFile = path.join(tmpDir, 'main.hbs');
    fs.writeFileSync(templateFile, '= {{name}}\n', 'utf8');
    const data = {
      outputs: [
        {
          name: 'braced_summary',
          type: 'output',
          summary: 'Sends batches to {endpoint} for processing.',
          description: 'Longer prose.',
          config: { children: [{ name: 'x', type: 'string', kind: 'scalar', description: 'A field.' }] },
        },
      ],
    };
    dataFile = path.join(tmpDir, 'data.json');
    fs.writeFileSync(dataFile, JSON.stringify(data), 'utf8');
  });

  afterAll(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('the emitted partial escapes {placeholder} in both the body summary and the :description: attribute', () => {
    return generateRpcnConnectorDocs({ data: dataFile, template: templateFile }).then(() => {
      const content = fs.readFileSync(dPath, 'utf8');
      // Body copy of the summary.
      expect(content).toContain('Sends batches to \\{endpoint} for processing.');
      // Attribute copy: without the escape Asciidoctor consumes {endpoint}
      // as a missing attribute reference and drops it from search snippets.
      expect(content).toContain(':description: Sends batches to \\{endpoint} for processing.');
      expect(content).not.toContain(':description: Sends batches to {endpoint}');
    });
  });

  renderTest('Asciidoctor round-trips the escaped summary back to literal braces', () => {
    return generateRpcnConnectorDocs({ data: dataFile, template: templateFile }).then(() => {
      const page = [
        '= braced_summary',
        `include::${dPath}[tag=attrs]`,
        '',
        `include::${dPath}[tag=body]`,
      ].join('\n');
      const pagePath = path.join(tmpDir, 'page.adoc');
      fs.writeFileSync(pagePath, page, 'utf8');
      const doc = asciidoctor.loadFile(pagePath, { safe: 'unsafe' });
      expect(doc.getAttribute('description')).toBe('Sends batches to {endpoint} for processing.');
      expect(doc.convert()).toContain('{endpoint}');
    });
  });
});

describe('orphan sweep blast-radius guard', () => {
  const tmpDir = path.join(__dirname, 'tmp-description-sweep-guard');
  let originalCwd, templateFile;
  const descRoot = path.join(tmpDir, 'modules', 'components', 'partials', 'descriptions', 'inputs');

  function writeData (count, offset = 0) {
    const data = {
      inputs: Array.from({ length: count }, (_, i) => ({
        name: `conn_${i + offset}`,
        type: 'input',
        description: `Reads things for conn_${i + offset}.`,
        config: { children: [{ name: 'foo', type: 'string', kind: 'scalar', description: 'A field.' }] },
      })),
    };
    const dataFile = path.join(tmpDir, 'data.json');
    fs.writeFileSync(dataFile, JSON.stringify(data), 'utf8');
    return dataFile;
  }

  function run (opts) {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    return generateRpcnConnectorDocs({ template: templateFile, ...opts }).then((result) => {
      const errors = errSpy.mock.calls.map((a) => a.join(' ')).join('\n');
      errSpy.mockRestore();
      logSpy.mockRestore();
      return { result, errors };
    }, (err) => {
      errSpy.mockRestore();
      logSpy.mockRestore();
      throw err;
    });
  }

  function bodies () {
    return fs.readdirSync(descRoot)
      .filter((f) => f.endsWith('.adoc'))
      .filter((f) => fs.readFileSync(path.join(descRoot, f), 'utf8').includes('Reads things for'))
      .length;
  }

  beforeEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    templateFile = path.join(tmpDir, 'main.hbs');
    fs.writeFileSync(templateFile, '= {{name}}\n', 'utf8');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('refuses to blank the tree when a truncated dataset orphans most of it', async () => {
    // Run 1: the complete dataset.
    await run({ data: writeData(20) });
    expect(bodies()).toBe(20);

    // Run 2: the same tool pointed at a dataset that only carries one
    // component (a truncated fetch, a hand-made subset, a half-succeeded
    // --force-fresh). Without a guard this blanks 19 published partials.
    const { result, errors } = await run({ data: writeData(1) });

    expect(bodies()).toBe(20);
    expect(result.orphanSweepSkipped).toEqual({
      orphans: 19,
      partialsOnDisk: 20,
      connectors: expect.arrayContaining(['inputs/conn_19']),
    });
    expect(errors).toContain('Orphan sweep refused');
    expect(errors).toContain('19 of 20 description partial(s) (95%)');
    // The refusal is reported to the PR summary, not just the workflow log.
    expect(result.descriptionReports).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('Orphan sweep refused') }),
    ]));
    // Nothing was reported as removed upstream, because nothing was.
    expect(result.descriptionReports.some((r) => /removed upstream/.test(r.message))).toBe(false);
  });

  test('the explicit opt-in still sweeps the same truncated dataset', async () => {
    await run({ data: writeData(20) });
    const { result } = await run({ data: writeData(1), pruneOrphanedDescriptions: true });

    expect(bodies()).toBe(1);
    expect(result.orphanSweepSkipped).toBeNull();
    expect(result.descriptionReports.filter((r) => /removed upstream/.test(r.message))).toHaveLength(19);
  });

  // Negative controls: the guard must not be a blanket "never sweep".
  test('a plausible small upstream deletion is still swept', async () => {
    await run({ data: writeData(20) });
    const { result } = await run({ data: writeData(18) });

    expect(bodies()).toBe(18);
    expect(result.orphanSweepSkipped).toBeNull();
    expect(result.descriptionReports.filter((r) => /removed upstream/.test(r.message))).toHaveLength(2);
  });

  test('a large but proportionally small deletion is still swept', async () => {
    // 15 of 200 is over the always-allowed count but under the 10% fraction,
    // so the fraction arm of the guard (not just the count arm) is exercised.
    await run({ data: writeData(200) });
    const { result } = await run({ data: writeData(185) });

    expect(bodies()).toBe(185);
    expect(result.orphanSweepSkipped).toBeNull();
    expect(result.descriptionReports.filter((r) => /removed upstream/.test(r.message))).toHaveLength(15);
  });
});

describe('rate limits: the partial is written where its include line points', () => {
  const tmpDir = path.join(__dirname, 'tmp-description-rate-limits');
  let originalCwd, templateFile, dataFile;
  const partialsRoot = path.join(tmpDir, 'modules', 'components', 'partials');

  beforeAll(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    // The upstream dataset key is 'rate-limits' while item.type is
    // 'rate_limit' and the pages directory is 'rate_limits'.
    const data = {
      'rate-limits': [
        {
          name: 'local',
          type: 'rate_limit',
          summary: 'A simple X every Y rate limit.',
          description: 'Shared across components.\n\n== Metadata\n\n- a: one',
          config: { children: [{ name: 'count', type: 'int', kind: 'scalar', description: 'A field.' }] },
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

  test('the description and metadata partials land on the path the include lines use', async () => {
    await generateRpcnConnectorDocs({ data: dataFile, template: templateFile });

    const item = { type: 'rate_limit', name: 'local' };
    // The include line a page (or the migration) writes...
    const descInclude = descriptionIncludeLine(item);
    const metaInclude = metadataIncludeLine(item);
    expect(descInclude).toContain('partial$descriptions/rate_limits/local.adoc');
    expect(metaInclude).toContain('partial$metadata/rate_limits/local.adoc');

    // ...must name a file that exists. Resolve the partial$ target the way
    // Antora does: <partials root>/<the path after partial$>.
    const resolve = (line) => path.join(
      partialsRoot, line.match(/partial\$([^[]+)/)[1]
    );
    expect(fs.existsSync(resolve(descInclude))).toBe(true);
    expect(fs.existsSync(resolve(metaInclude))).toBe(true);

    // The hyphenated spelling must not also exist: two directories for one
    // component family is how the mismatch came back last time.
    expect(fs.existsSync(path.join(partialsRoot, 'descriptions', 'rate-limits'))).toBe(false);
    expect(fs.existsSync(path.join(partialsRoot, 'metadata', 'rate-limits'))).toBe(false);

    // Fields and examples are unchanged: published pages already include
    // them under the raw data-key spelling, so that path must not move.
    expect(fs.existsSync(path.join(partialsRoot, 'fields', 'rate-limits', 'local.adoc'))).toBe(true);
  });
});
