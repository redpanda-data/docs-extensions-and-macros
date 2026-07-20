'use strict';

const path = require('path');
const fs = require('fs');
const handlebars = require('handlebars');
const helpers = require('../../tools/redpanda-connect/helpers/index.js');

Object.entries(helpers).forEach(([name, fn]) => handlebars.registerHelper(name, fn));

const {
  locateMetadata,
  extractMetadata,
  typeDirFor,
  metadataIncludeLine,
  descriptionWithMetadataInclude,
} = require('../../tools/redpanda-connect/metadata-utils.js');

const { generateRpcnConnectorDocs } = require('../../tools/redpanda-connect/generate-rpcn-connector-docs.js');

const METADATA_TEMPLATE = path.resolve(
  __dirname, '../../tools/redpanda-connect/templates/metadata-partials.hbs'
);

const SAMPLE = [
  'Streams changes from a database.',
  '',
  '== Metadata',
  '',
  'This input adds the following metadata fields to each message:',
  '',
  '- database_schema: The schema.',
  '- operation: The operation.',
  '',
  '== Permissions',
  '',
  'Needs LogMiner privileges.',
].join('\n');

describe('metadata-utils: locateMetadata', () => {
  test('locates the section and returns offsets that round-trip to the block', () => {
    const found = locateMetadata(SAMPLE);
    expect(found).not.toBeNull();
    expect(SAMPLE.slice(found.start, found.end)).toBe(found.block);
    expect(found.block.startsWith('== Metadata')).toBe(true);
    // Terminates before the next level-2 heading, trailing blank lines trimmed.
    expect(found.block).toContain('- operation: The operation.');
    expect(found.block).not.toContain('== Permissions');
    expect(found.block.endsWith('.')).toBe(true);
  });

  test('returns null when there is no metadata section', () => {
    expect(locateMetadata('Just prose.')).toBeNull();
    expect(locateMetadata('')).toBeNull();
    expect(locateMetadata(null)).toBeNull();
    expect(locateMetadata(undefined)).toBeNull();
  });

  test('handles a metadata section at end of string', () => {
    const desc = 'Intro.\n\n== Metadata\n\n- x: y\n';
    const found = locateMetadata(desc);
    expect(found.block).toBe('== Metadata\n\n- x: y');
  });

  test('does not match a non-metadata heading such as "== Metadata fields"', () => {
    expect(locateMetadata('Intro.\n\n== Metadata fields\n\n- x: y')).toBeNull();
  });

  test('a level-3 subheading inside the section does not terminate it', () => {
    const desc = 'Intro.\n\n== Metadata\n\n- a: 1\n\n=== Notes\n\nmore\n\n== Permissions\n\nperms';
    const found = locateMetadata(desc);
    expect(found.block).toContain('=== Notes');
    expect(found.block).not.toContain('== Permissions');
  });

  test('ignores a "== Metadata" line inside a ---- delimited block', () => {
    const desc = [
      'Intro.', '',
      '[source,text]', '----', '== Metadata', 'not a real heading', '----',
    ].join('\n');
    expect(locateMetadata(desc)).toBeNull();
  });

  test('a heading-like line inside a ---- block does not terminate the section', () => {
    const desc = [
      'Intro.', '',
      '== Metadata', '',
      'Example output:', '',
      '----', '== Permissions', '----', '',
      '- a: 1', '',
      '== Permissions', '', 'perms',
    ].join('\n');
    const found = locateMetadata(desc);
    expect(found.block).toContain('- a: 1');
    // The real terminator is the heading outside the block.
    expect(found.block.endsWith('- a: 1')).toBe(true);
  });
});

describe('metadata-utils: extractMetadata', () => {
  test('returns the block for a description with metadata, or "" otherwise', () => {
    expect(extractMetadata(SAMPLE)).toContain('This input adds the following metadata fields');
    expect(extractMetadata('no metadata here')).toBe('');
  });
});

describe('metadata-utils: typeDirFor / metadataIncludeLine', () => {
  test('derives the plural type directory', () => {
    expect(typeDirFor({ type: 'input' })).toBe('inputs');
    expect(typeDirFor({ type: 'inputs' })).toBe('inputs');
    expect(typeDirFor({ typeDir: 'caches', type: 'cache' })).toBe('caches');
    expect(typeDirFor({})).toBe('');
  });

  test('builds the Antora include directive', () => {
    expect(metadataIncludeLine({ type: 'input', name: 'oracledb_cdc' }))
      .toBe('include::connect:components:partial$metadata/inputs/oracledb_cdc.adoc[]');
  });
});

describe('metadata-utils: descriptionWithMetadataInclude', () => {
  test('replaces the block in place, preserving surrounding sections', () => {
    const out = descriptionWithMetadataInclude({
      description: SAMPLE, type: 'input', name: 'oracledb_cdc',
    });
    expect(out).toContain('Streams changes from a database.');
    expect(out).toContain('include::connect:components:partial$metadata/inputs/oracledb_cdc.adoc[]');
    expect(out).toContain('== Permissions');
    // Metadata bullets no longer inline; include sits before Permissions.
    expect(out).not.toContain('- database_schema: The schema.');
    expect(out.indexOf('partial$metadata')).toBeLessThan(out.indexOf('== Permissions'));
  });

  test('returns the description unchanged when there is no metadata section', () => {
    const desc = 'Just an intro, no metadata.';
    expect(descriptionWithMetadataInclude({ description: desc, type: 'input', name: 'x' })).toBe(desc);
  });

  test('is safe on empty/missing description', () => {
    expect(descriptionWithMetadataInclude({ type: 'input', name: 'x' })).toBe('');
    expect(descriptionWithMetadataInclude({})).toBe('');
  });
});

describe('metadata-partials.hbs template', () => {
  const tpl = handlebars.compile(fs.readFileSync(METADATA_TEMPLATE, 'utf8'));

  test('renders the banner and the metadata block when present', () => {
    const out = tpl({ description: SAMPLE });
    expect(out).toContain('This content is autogenerated. Do not edit manually.');
    expect(out).toContain('== Metadata');
    expect(out).toContain('- database_schema: The schema.');
  });

  test('renders nothing meaningful when there is no metadata section', () => {
    const out = tpl({ description: 'no metadata' });
    expect(out.trim()).toBe('');
  });
});

describe('generator writes a regenerated metadata partial', () => {
  const tmpDir = path.join(__dirname, 'tmp-metadata-output');
  let originalCwd, dataFile, templateFile;

  beforeAll(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    const data = {
      inputs: [
        {
          name: 'with_meta',
          type: 'input',
          description: SAMPLE,
          config: { children: [{ name: 'foo', type: 'string', kind: 'scalar', description: 'A field.' }] },
        },
        {
          name: 'no_meta',
          type: 'input',
          description: 'A connector with no metadata section.',
          config: { children: [{ name: 'bar', type: 'string', kind: 'scalar', description: 'A field.' }] },
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

  test('emits partials/metadata/<type>/<name>.adoc only for components with a metadata section', () => {
    return generateRpcnConnectorDocs({ data: dataFile, template: templateFile }).then(() => {
      const metaRoot = path.join(tmpDir, 'modules', 'components', 'partials', 'metadata', 'inputs');
      const withMeta = path.join(metaRoot, 'with_meta.adoc');
      const noMeta = path.join(metaRoot, 'no_meta.adoc');

      expect(fs.existsSync(withMeta)).toBe(true);
      expect(fs.existsSync(noMeta)).toBe(false);

      const content = fs.readFileSync(withMeta, 'utf8');
      expect(content).toContain('This content is autogenerated. Do not edit manually.');
      expect(content).toContain('== Metadata');
      expect(content).toContain('- database_schema: The schema.');
      expect(content).not.toContain('== Permissions');
    });
  });
});

describe('generator empties a stale metadata partial when the section is removed', () => {
  const tmpDir = path.join(__dirname, 'tmp-metadata-stale');
  let originalCwd, dataFile, templateFile;
  const metaPath = path.join(
    tmpDir, 'modules', 'components', 'partials', 'metadata', 'inputs', 'dropped_meta.adoc'
  );

  beforeAll(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    // Seed a pre-existing generated partial, as if an earlier run wrote it while
    // the connector still documented metadata.
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, '== Metadata\n\n- old: stale metadata\n', 'utf8');

    // The connector's description no longer has a `== Metadata` section.
    const data = {
      inputs: [
        {
          name: 'dropped_meta',
          type: 'input',
          description: 'This connector no longer documents metadata.',
          config: { children: [{ name: 'foo', type: 'string', kind: 'scalar', description: 'A field.' }] },
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

  test('keeps the file (include stays resolvable) but blanks its content', () => {
    return generateRpcnConnectorDocs({ data: dataFile, template: templateFile }).then(() => {
      // The file must survive so any hardcoded include directive still resolves.
      expect(fs.existsSync(metaPath)).toBe(true);
      const content = fs.readFileSync(metaPath, 'utf8');
      // Stale metadata is gone...
      expect(content).not.toContain('stale metadata');
      expect(content).not.toContain('- old:');
      // ...replaced by a banner-only (comment) file that renders nothing.
      expect(content).toContain('This content is autogenerated. Do not edit manually.');
      expect(content).toContain('intentionally empty');
    });
  });
});
