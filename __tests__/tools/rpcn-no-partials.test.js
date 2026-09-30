'use strict';

const path = require('path');
const fs = require('fs');
const { generateRpcnConnectorDocs } = require('../../tools/redpanda-connect/generate-rpcn-connector-docs.js');

const TEMPLATES = path.resolve(__dirname, '../../tools/redpanda-connect/templates');

// With writePartials false the connect repo publishes the generated partials,
// config snippets, and Bloblang reference, so the generator must not write
// any of them. Drafts are still written and still include the partials.
describe('generator with writePartials false', () => {
  const tmpDir = path.join(__dirname, 'tmp-rpcn-no-partials');
  let originalCwd, dataFile;

  const listFiles = (dir) => (fs.existsSync(dir)
    ? fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile())
    : []);

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    const data = {
      outputs: [{
        name: 'sql_raw',
        type: 'output',
        status: 'stable',
        version: '3.65.0',
        summary: 'Executes an arbitrary SQL query for each message.',
        description: 'Runs a query.\n\n== Metadata\n\n- kafka_partition: The partition.',
        examples: [{ title: 'Insert', summary: 'Inserts a row.', config: 'output:\n  sql_raw: {}\n' }],
        config: { children: [{ name: 'dsn', type: 'string', kind: 'scalar', description: 'A field.' }] },
      }],
      'bloblang-functions': [{ name: 'now', status: 'stable', description: 'Returns the time.' }],
      'bloblang-methods': [{ name: 'uppercase', status: 'stable', description: 'Uppercases.', categories: [{ Category: 'String Manipulation' }] }],
    };
    dataFile = path.join(tmpDir, 'data.json');
    fs.writeFileSync(dataFile, JSON.stringify(data), 'utf8');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const run = (extra) => generateRpcnConnectorDocs({
    data: dataFile,
    template: path.join(TEMPLATES, 'connector.hbs'),
    templateIntro: path.join(TEMPLATES, 'intro.hbs'),
    templateFields: path.join(TEMPLATES, 'fields-partials.hbs'),
    templateExamples: path.join(TEMPLATES, 'examples-partials.hbs'),
    includeBloblang: true,
    ...extra,
  });

  test('control: the default run writes partials, config snippets, and Bloblang pages', async () => {
    await run({ writeFullDrafts: false });
    const files = listFiles(path.join(tmpDir, 'modules'));
    expect(files).toEqual(expect.arrayContaining([
      path.join('components', 'partials', 'fields', 'outputs', 'sql_raw.adoc'),
      path.join('components', 'examples', 'common', 'outputs', 'sql_raw.yaml'),
      path.join('guides', 'pages', 'bloblang', 'functions.adoc'),
    ]));
  });

  test('a partials run writes nothing', async () => {
    const result = await run({ writeFullDrafts: false, writePartials: false });
    expect(listFiles(path.join(tmpDir, 'modules'))).toEqual([]);
    expect(result.partialsWritten).toBe(0);
  });

  test('a draft run writes only the draft page, which includes the connect partials', async () => {
    // The handler drafts from data filtered to the missing connectors, so
    // Bloblang entries never reach draft mode.
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    fs.writeFileSync(dataFile, JSON.stringify({ outputs: data.outputs }), 'utf8');
    const result = await run({ writeFullDrafts: true, writePartials: false });
    expect(result.draftsWritten).toBe(1);
    expect(listFiles(path.join(tmpDir, 'modules'))).toEqual([path.join('components', 'pages', 'outputs', 'sql_raw.adoc')]);
    const page = fs.readFileSync(path.join(tmpDir, 'modules', 'components', 'pages', 'outputs', 'sql_raw.adoc'), 'utf8');
    expect(page).toContain('include::connect:components:partial$descriptions/outputs/sql_raw.adoc[tag=body]');
    expect(page).toContain('include::connect:components:partial$fields/outputs/sql_raw.adoc[]');
  });
});
