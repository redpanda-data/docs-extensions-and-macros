'use strict';

const path = require('path');
const fs = require('fs');
const handlebars = require('handlebars');
const yaml = require('yaml');
const helpers = require('../../tools/redpanda-connect/helpers/index.js');

// Register every helper under handlebars so `{{> fields}}`, `{{> examples}}`, etc. work
Object.entries(helpers).forEach(([name, fn]) => {
  handlebars.registerHelper(name, fn);
});

// Expose each helper globally so tests can call uppercase(), eq(), ne(), etc.
if (typeof global !== 'undefined') {
  global.uppercase = helpers.uppercase;
  global.eq = helpers.eq;
  global.ne = helpers.ne;
  global.renderYamlList = helpers.renderYamlList;
  global.renderConnectFields = helpers.renderConnectFields;
  global.renderConnectExamples = helpers.renderConnectExamples;
  global.renderLeafField = helpers.renderLeafField;
  global.renderObjectField = helpers.renderObjectField;
  global.buildConfigYaml = helpers.buildConfigYaml;
  global.commonConfig = helpers.commonConfig;
  global.advancedConfig = helpers.advancedConfig;
}

const {
  generateRpcnConnectorDocs,
  mergeOverrides,
  resolveReferences
} = require('../../tools/redpanda-connect/generate-rpcn-connector-docs');

describe('Utility Helpers', () => {
  test('uppercase: should convert string to uppercase', () => {
    expect(uppercase('hello')).toBe('HELLO');
    expect(uppercase('MixedCase')).toBe('MIXEDCASE');
    expect(uppercase(123)).toBe('123');
  });

  test('eq: should return true iff two values are strictly equal', () => {
    expect(eq(1, 1)).toBe(true);
    expect(eq('foo', 'foo')).toBe(true);
    expect(eq(true, false)).toBe(false);
    expect(eq(1, '1')).toBe(false);
    expect(eq(null, undefined)).toBe(false);
  });

  test('ne: should return true iff two values are not strictly equal', () => {
    expect(ne(1, 2)).toBe(true);
    expect(ne('bar', 'baz')).toBe(true);
    expect(ne(5, 5)).toBe(false);
    expect(ne(false, false)).toBe(false);
  });

  describe('mergeOverrides', () => {
    it('overrides description and type at top level', () => {
      const base = {
        name: 'fieldA',
        description: 'original desc',
        type: 'string',
        extra: 'keep me',
      };
      const overrides = {
        description: 'new desc',
        type: 'int',
      };
      const merged = mergeOverrides(base, overrides);
      expect(merged.name).toBe('fieldA');
      expect(merged.description).toBe('new desc');
      expect(merged.type).toBe('int');
      expect(merged.extra).toBe('keep me');
    });

    it('recursively overrides children in arrays by matching name', () => {
      const base = {
        config: [
          { name: 'foo', description: 'desc1', type: 'string' },
          { name: 'bar', description: 'desc2', type: 'bool' }
        ]
      };
      const overrides = {
        config: [
          { name: 'bar', description: 'overridden', type: 'bool' }
        ]
      };
      const merged = mergeOverrides(base, overrides);
      expect(merged.config.length).toBe(2);
      expect(merged.config[0].description).toBe('desc1');
      expect(merged.config[1].description).toBe('overridden');
    });

    it('ignores overrides for non-existent names', () => {
      const base = {
        config: [
          { name: 'foo', description: 'desc1', type: 'string' }
        ]
      };
      const overrides = {
        config: [
          { name: 'baz', description: 'no match' }
        ]
      };
      const merged = mergeOverrides(base, overrides);
      expect(merged.config[0].name).toBe('foo');
      expect(merged.config[0].description).toBe('desc1');
    });

    it('deep-merges nested objects that are not arrays', () => {
      const base = {
        parent: {
          child: {
            name: 'inner',
            description: 'orig',
            type: 'string'
          },
          other: 'unchanged'
        }
      };
      const overrides = {
        parent: {
          child: {
            description: 'overridden'
          }
        }
      };
      const merged = mergeOverrides(base, overrides);
      expect(merged.parent.child.description).toBe('overridden');
      expect(merged.parent.other).toBe('unchanged');
    });
  });

  describe('resolveReferences', () => {
    it('resolves basic $ref references', () => {
      const data = {
        definitions: {
          client_certs: {
            description: 'A list of client certificates to use for mTLS authentication.'
          }
        },
        inputs: [
          {
            name: 'kafka',
            config: {
              children: [
                {
                  name: 'client_certs',
                  '$ref': '#/definitions/client_certs'
                }
              ]
            }
          }
        ]
      };

      const resolved = resolveReferences(data, data);
      expect(resolved.inputs[0].config.children[0].name).toBe('client_certs');
      expect(resolved.inputs[0].config.children[0].description).toBe('A list of client certificates to use for mTLS authentication.');
      expect(resolved.inputs[0].config.children[0]['$ref']).toBeUndefined();
    });

    it('resolves multiple references to the same definition', () => {
      const data = {
        definitions: {
          timeout: {
            description: 'Maximum time to wait for response.',
            type: 'string'
          }
        },
        inputs: [
          {
            name: 'http',
            config: {
              children: [
                {
                  name: 'timeout',
                  '$ref': '#/definitions/timeout'
                }
              ]
            }
          }
        ],
        outputs: [
          {
            name: 'http',
            config: {
              children: [
                {
                  name: 'timeout',
                  '$ref': '#/definitions/timeout'
                }
              ]
            }
          }
        ]
      };

      const resolved = resolveReferences(data, data);
      expect(resolved.inputs[0].config.children[0].description).toBe('Maximum time to wait for response.');
      expect(resolved.outputs[0].config.children[0].description).toBe('Maximum time to wait for response.');
      expect(resolved.inputs[0].config.children[0].type).toBe('string');
      expect(resolved.outputs[0].config.children[0].type).toBe('string');
    });

    it('preserves existing properties when resolving references', () => {
      const data = {
        definitions: {
          base_config: {
            description: 'Base configuration options.',
            type: 'object'
          }
        },
        inputs: [
          {
            name: 'test',
            config: {
              children: [
                {
                  name: 'config',
                  '$ref': '#/definitions/base_config',
                  required: true,
                  default: {}
                }
              ]
            }
          }
        ]
      };

      const resolved = resolveReferences(data, data);
      const field = resolved.inputs[0].config.children[0];
      expect(field.name).toBe('config');
      expect(field.description).toBe('Base configuration options.');
      expect(field.type).toBe('object');
      expect(field.required).toBe(true);
      expect(field.default).toEqual({});
    });

    it('handles nested references in arrays', () => {
      const data = {
        definitions: {
          auth_config: {
            description: 'Authentication configuration',
            children: [
              {
                name: 'username',
                description: 'Username for authentication'
              }
            ]
          }
        },
        inputs: [
          {
            name: 'service1',
            '$ref': '#/definitions/auth_config'
          },
          {
            name: 'service2', 
            '$ref': '#/definitions/auth_config'
          }
        ]
      };

      const resolved = resolveReferences(data, data);
      expect(resolved.inputs[0].description).toBe('Authentication configuration');
      expect(resolved.inputs[1].description).toBe('Authentication configuration');
      expect(resolved.inputs[0].children[0].name).toBe('username');
      expect(resolved.inputs[1].children[0].name).toBe('username');
    });

    it('throws error for non-existent reference path', () => {
      const data = {
        definitions: {},
        inputs: [
          {
            name: 'test',
            '$ref': '#/definitions/nonexistent'
          }
        ]
      };

      expect(() => {
        resolveReferences(data, data);
      }).toThrow('Failed to resolve reference "#/definitions/nonexistent"');
    });

    it('throws error for invalid reference format', () => {
      const data = {
        inputs: [
          {
            name: 'test',
            '$ref': 'invalid-ref-format'
          }
        ]
      };

      expect(() => {
        resolveReferences(data, data);
      }).toThrow('Unsupported reference format: invalid-ref-format');
    });

    it('handles deeply nested reference paths', () => {
      const data = {
        definitions: {
          nested: {
            level1: {
              level2: {
                description: 'Deep nested description'
              }
            }
          }
        },
        inputs: [
          {
            name: 'test',
            '$ref': '#/definitions/nested/level1/level2'
          }
        ]
      };

      const resolved = resolveReferences(data, data);
      expect(resolved.inputs[0].description).toBe('Deep nested description');
    });

    it('resolves references in real overrides.json structure', () => {
      // Create a test structure similar to the actual overrides.json but with $ref
      const data = {
        definitions: {
          client_certs: {
            description: 'A list of client certificates to use. For each certificate, specify values for either the `cert` and `key` fields, or the `cert_file` and `key_file` fields.'
          }
        },
        outputs: [
          {
            name: 'amqp_0_9',
            config: {
              children: [
                {
                  name: 'tls',
                  children: [
                    {
                      name: 'client_certs',
                      '$ref': '#/definitions/client_certs'
                    }
                  ]
                }
              ]
            }
          },
          {
            name: 'elasticsearch',
            config: {
              children: [
                {
                  name: 'tls',
                  children: [
                    {
                      name: 'client_certs',
                      '$ref': '#/definitions/client_certs'
                    }
                  ]
                }
              ]
            }
          }
        ]
      };

      const resolved = resolveReferences(data, data);
      const amqpClientCerts = resolved.outputs[0].config.children[0].children[0];
      const esClientCerts = resolved.outputs[1].config.children[0].children[0];
      
      expect(amqpClientCerts.name).toBe('client_certs');
      expect(amqpClientCerts.description).toBe('A list of client certificates to use. For each certificate, specify values for either the `cert` and `key` fields, or the `cert_file` and `key_file` fields.');
      expect(esClientCerts.name).toBe('client_certs');
      expect(esClientCerts.description).toBe('A list of client certificates to use. For each certificate, specify values for either the `cert` and `key` fields, or the `cert_file` and `key_file` fields.');
    });

    it('returns primitive values unchanged', () => {
      expect(resolveReferences(null, {})).toBeNull();
      expect(resolveReferences(undefined, {})).toBeUndefined();
      expect(resolveReferences('string', {})).toBe('string');
      expect(resolveReferences(42, {})).toBe(42);
      expect(resolveReferences(true, {})).toBe(true);
    });

    it('handles empty objects and arrays', () => {
      const root = { definitions: {} };
      expect(resolveReferences({}, root)).toEqual({});
      expect(resolveReferences([], root)).toEqual([]);
    });
  });

  describe('renderConnectFields & renderConnectExamples', () => {
    const minimalField = [
      {
        name: 'timeout',
        type: 'int',
        kind: 'scalar',
        description: 'Timeout in seconds.',
        default: 30
      }
    ];

    const nestedField = [
      {
        name: 'parent',
        type: 'object',
        kind: 'scalar',
        description: 'Parent object.',
        children: [
          {
            name: 'childA',
            type: 'string',
            kind: 'scalar',
            description: 'A nested child.',
            default: 'foo'
          }
        ]
      }
    ];

    it('renders a single scalar field with description, type, and default', () => {
      const result = renderConnectFields(minimalField).toString();
      expect(result).toContain("=== `timeout`");
      expect(result).toContain("Timeout in seconds.");
      expect(result).toContain("*Type*: `int`");
      expect(result).toContain("*Default*: `30`");
    });

    it('recursively renders nested children with correct path', () => {
      const result = renderConnectFields(nestedField).toString();
      expect(result).toContain("=== `parent`");
      expect(result).toContain("Parent object.");
      expect(result).toContain("=== `parent.childA`");
      expect(result).toContain("A nested child.");
      expect(result).toContain("*Type*: `string`");
      expect(result).toContain("*Default*: `foo`");
    });

    it('renders examples for array of strings using YAML flow style', () => {
      const exampleField = [
        {
          name: 'notes',
          type: 'string',
          kind: 'array',
          description: 'An array of notes.',
          examples: [
            ['single line note', 'another single note'],
            ['multi\nline\nnote']
          ]
        }
      ];
      const result = renderConnectFields(exampleField).toString();

      // 1) Check that "notes:" appears in flow style (with brackets)
      // Strings with whitespace should be quoted
      expect(result).toMatch(/notes: \["single line note", "another single note"\]/);

      // 2) Check that multi-line strings are rendered in flow style and quoted
      expect(result).toMatch(/notes: \["multi[\s\S]*line[\s\S]*note"\]/);
    });

    it('renders a list of example configs in renderConnectExamples', () => {
      const examples = [
        {
          title: 'Example One',
          summary: 'This is a summary.',
          config: `
input:
  foo: bar
`
        }
      ];
      const result = renderConnectExamples(examples).toString();
      expect(result).toContain('=== Example One');
      expect(result).toContain('This is a summary.');
      expect(result).toContain('[source,yaml]');
      expect(result).toContain('input:\n  foo: bar');
    });
  });

  describe('End-to-End Rendering with a Minimal Template', () => {
    // We'll only test “connectors” and “caches” here, leaving out “config” entirely.
    const tmpDir = path.join(__dirname, 'tmp-output');
    let originalCwd;

    const baseData = {
      connectors: [
        {
          name: 'MyConnector',
          description: 'A simple connector.',
          config: {
            children: [
              {
                name: 'timeout',
                type: 'int',
                kind: 'scalar',
                description: 'Timeout in ms.',
                default: 1000
              }
            ]
          }
        }
      ],
      caches: [
        {
          name: 'memory',
          type: 'cache',
          status: 'stable',
          plugin: true,
          summary:
            'Stores key/value pairs in a map held in memory. This cache is therefore reset every time the service restarts. Each item in the cache has a TTL set from the moment it was last edited, after which it will be removed during the next compaction.',
          description:
            'The compaction interval determines how often the cache is cleared of expired items, and this process is only triggered on writes to the cache. Access to the cache is blocked during this process.\n\n' +
            'Item expiry can be disabled entirely by setting the `compaction_interval` to an empty string.\n\n' +
            'The field `init_values` can be used to prepopulate the memory cache with any number of key/value pairs which are exempt from TTLs:\n\n' +
            '```yaml\n' +
            'cache_resources:\n' +
            '  - label: foocache\n' +
            '    memory:\n' +
            '      default_ttl: 60s\n' +
            '      init_values:\n' +
            '        foo: bar\n' +
            '```',
          categories: null,
          config: {
            name: '', // we will skip writing a full-doc for “config” entry here
            type: 'object',
            kind: 'scalar',
            children: [
              {
                name: 'compaction_interval',
                type: 'string',
                kind: 'scalar',
                description:
                  'How often (e.g. "30s", "5m") the cache is compacted; leave empty to disable expiry.',
                default: '60s'
              },
              {
                name: 'init_values',
                type: 'object',
                kind: 'scalar',
                description:
                  'Initial key→value pairs to seed the cache; these never expire until explicitly overwritten.',
                examples: [
                  {
                    foo: 'bar',
                    baz: 'qux'
                  }
                ]
              }
            ]
          }
        }
      ]
    };

    // Minimal template: for any top-level entry, render:
    //   • {{name}} as title
    //   • {{description}}
    //   • if it has "config.children", render them
    //
    const minimalTemplate = `
= {{name}}

{{#if description}}
{{description}}

{{/if}}

{{#if config}}
=== Config Section
{{{renderConnectFields config.children}}}
{{/if}}
`;

    let dataFile, templateFile;

    beforeAll(() => {
      // Ensure tmp-output exists and is empty
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      fs.mkdirSync(tmpDir, { recursive: true });

      // Save and change cwd into tmpDir so generateRpcnConnectorDocs writes inside tmpDir
      originalCwd = process.cwd();
      process.chdir(tmpDir);

      // Write baseData to YAML
      dataFile = path.join(tmpDir, 'base-data.yaml');
      fs.writeFileSync(dataFile, yaml.stringify(baseData), 'utf8');

      // Write minimalTemplate to a .hbs file
      templateFile = path.join(tmpDir, 'minimal-template.hbs');
      fs.writeFileSync(templateFile, minimalTemplate, 'utf8');
    });

    afterAll(() => {
      // Restore cwd and clean up the entire tmp-output directory
      process.chdir(originalCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes .adoc files with the expected content for MyConnector and memory cache', () => {
      // Generate docs without requesting full-doc drafts
      return generateRpcnConnectorDocs({
        data: dataFile,
        template: templateFile
      }).then(() => {
        // Paths under tmpDir/modules/components/partials
        const basePartials = path.join(tmpDir, 'modules', 'components', 'partials');
        const connFieldsPartial = path.join(
          basePartials, 'fields', 'connectors', 'MyConnector.adoc'
        );
        const cacheFieldsPartial = path.join(
          basePartials, 'fields', 'caches', 'memory.adoc'
        );

        expect(fs.existsSync(connFieldsPartial)).toBe(true);
        expect(fs.existsSync(cacheFieldsPartial)).toBe(true);

        // Inspect fields partial for MyConnector
        const connFieldsContent = fs.readFileSync(connFieldsPartial, 'utf8');
        expect(connFieldsContent).toContain('=== `timeout`');
        expect(connFieldsContent).toContain('*Type*: `int`');
        expect(connFieldsContent).toContain('*Default*: `1000`');

        // Inspect fields partial for memory cache
        const cacheFieldsContent = fs.readFileSync(cacheFieldsPartial, 'utf8');
        expect(cacheFieldsContent).toContain('=== `compaction_interval`');
        expect(cacheFieldsContent).toContain('*Type*: `string`');
        expect(cacheFieldsContent).toContain('*Default*: `60s`');
        expect(cacheFieldsContent).toContain('=== `init_values`');
        expect(cacheFieldsContent).toMatch(
          /\[source,yaml\][\s\S]*foo: bar[\s\S]*baz: qux[\s\S]*----/
        );

        // No full-doc files should exist when writeFullDrafts is false
        const fullConnector = path.join(tmpDir, 'modules', 'components', 'partials', 'drafts', 'MyConnector.adoc');
        expect(fs.existsSync(fullConnector)).toBe(false);

        const fullCache = path.join(tmpDir, 'modules', 'components', 'partials', 'drafts', 'memory.adoc');
        expect(fs.existsSync(fullCache)).toBe(false);
      });
    });

    it('correctly emits full-doc drafts when writeFullDrafts=true', () => {
      return generateRpcnConnectorDocs({
        data: dataFile,
        template: templateFile,
        templateIntro: templateFile,
        writeFullDrafts: true
      }).then(() => {
        const draftsBase = path.join(tmpDir, 'modules', 'components', 'partials', 'drafts');
        const fullConnector = path.join(draftsBase, 'MyConnector.adoc');
        const fullCache    = path.join(draftsBase, 'memory.adoc');

        expect(fs.existsSync(fullConnector)).toBe(true);
        expect(fs.existsSync(fullCache)).toBe(true);

        const fullConnectorContent = fs.readFileSync(fullConnector, 'utf8');
        expect(fullConnectorContent).toContain('= MyConnector');
        expect(fullConnectorContent).toContain('A simple connector.');
        expect(fullConnectorContent).toMatch(/=== Config Section/);
        expect(fullConnectorContent).toContain('=== `timeout`');
        expect(fullConnectorContent).toContain('*Type*: `int`');
        expect(fullConnectorContent).toContain('*Default*: `1000`');

        const fullCacheContent = fs.readFileSync(fullCache, 'utf8');
        expect(fullCacheContent).toContain('= memory');
        expect(fullCacheContent).toContain('The compaction interval determines how often');
        expect(fullCacheContent).toMatch(/=== Config Section/);
        expect(fullCacheContent).toContain('=== `compaction_interval`');
        expect(fullCacheContent).toContain('*Default*: `60s`');
      });
    });
  });
});
