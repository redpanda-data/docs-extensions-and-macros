'use strict';

const buildConfigYaml = require('../../tools/redpanda-connect/helpers/buildConfigYaml');

describe('buildConfigYaml', () => {
  const sampleChildren = [
    {
      name: 'host',
      type: 'string',
      kind: 'scalar',
      description: 'The host to connect to.',
      default: 'localhost'
    },
    {
      name: 'port',
      type: 'int',
      kind: 'scalar',
      description: 'The port number.',
      default: 8080
    }
  ];

  describe('label field inclusion', () => {
    it('should include label for inputs', () => {
      const result = buildConfigYaml('inputs', 'kafka', sampleChildren, false);
      expect(result).toContain('inputs:');
      expect(result).toContain('  label: ""');
      expect(result).toContain('  kafka:');
    });

    it('should include label for outputs', () => {
      const result = buildConfigYaml('outputs', 'kafka', sampleChildren, false);
      expect(result).toContain('outputs:');
      expect(result).toContain('  label: ""');
      expect(result).toContain('  kafka:');
    });

    it('should include label for processors', () => {
      const result = buildConfigYaml('processors', 'jq', sampleChildren, false);
      expect(result).toContain('processors:');
      expect(result).toContain('  label: ""');
      expect(result).toContain('  jq:');
    });

    it('should NOT include label for metrics', () => {
      const result = buildConfigYaml('metrics', 'prometheus', sampleChildren, false);
      expect(result).toContain('metrics:');
      expect(result).not.toContain('  label: ""');
      expect(result).toContain('  prometheus:');
    });

    it('should NOT include label for caches', () => {
      const result = buildConfigYaml('caches', 'memory', sampleChildren, false);
      expect(result).toContain('caches:');
      expect(result).not.toContain('  label: ""');
      expect(result).toContain('  memory:');
    });

    it('should NOT include label for buffers', () => {
      const result = buildConfigYaml('buffers', 'memory', sampleChildren, false);
      expect(result).toContain('buffers:');
      expect(result).not.toContain('  label: ""');
      expect(result).toContain('  memory:');
    });

    it('should NOT include label for tracers', () => {
      const result = buildConfigYaml('tracers', 'jaeger', sampleChildren, false);
      expect(result).toContain('tracers:');
      expect(result).not.toContain('  label: ""');
      expect(result).toContain('  jaeger:');
    });

    it('should NOT include label for rate-limits', () => {
      const result = buildConfigYaml('rate-limits', 'local', sampleChildren, false);
      expect(result).toContain('rate-limits:');
      expect(result).not.toContain('  label: ""');
      expect(result).toContain('  local:');
    });

    it('should NOT include label for scanners', () => {
      const result = buildConfigYaml('scanners', 'csv', sampleChildren, false);
      expect(result).toContain('scanners:');
      expect(result).not.toContain('  label: ""');
      expect(result).toContain('  csv:');
    });
  });

  describe('basic structure', () => {
    it('should render children fields with correct indentation', () => {
      const result = buildConfigYaml('inputs', 'kafka', sampleChildren, false);

      // Check that children are rendered with 4-space indent
      expect(result).toContain('    host:');
      expect(result).toContain('    port:');
    });

    it('should filter out advanced fields when includeAdvanced is false', () => {
      const fieldsWithAdvanced = [
        ...sampleChildren,
        {
          name: 'advanced_option',
          type: 'bool',
          kind: 'scalar',
          description: 'An advanced option.',
          is_advanced: true
        }
      ];

      const result = buildConfigYaml('inputs', 'kafka', fieldsWithAdvanced, false);
      expect(result).not.toContain('advanced_option:');
    });

    it('should include advanced fields when includeAdvanced is true', () => {
      const fieldsWithAdvanced = [
        ...sampleChildren,
        {
          name: 'advanced_option',
          type: 'bool',
          kind: 'scalar',
          description: 'An advanced option.',
          is_advanced: true
        }
      ];

      const result = buildConfigYaml('inputs', 'kafka', fieldsWithAdvanced, true);
      expect(result).toContain('advanced_option:');
    });

    it('should filter out deprecated fields', () => {
      const fieldsWithDeprecated = [
        ...sampleChildren,
        {
          name: 'old_option',
          type: 'string',
          kind: 'scalar',
          description: 'A deprecated option.',
          is_deprecated: true
        }
      ];

      const result = buildConfigYaml('inputs', 'kafka', fieldsWithDeprecated, true);
      expect(result).not.toContain('old_option:');
      // Ensure non-deprecated fields are still present
      expect(result).toContain('host:');
      expect(result).toContain('port:');
    });
  });

  describe('complex field types', () => {
    it('should render object fields with nested children', () => {
      const fieldsWithObject = [
        {
          name: 'tls',
          type: 'object',
          kind: 'map',
          description: 'TLS configuration.',
          children: [
            {
              name: 'enabled',
              type: 'bool',
              kind: 'scalar',
              default: false
            },
            {
              name: 'skip_verify',
              type: 'bool',
              kind: 'scalar',
              default: false
            }
          ]
        }
      ];

      const result = buildConfigYaml('inputs', 'kafka', fieldsWithObject, false);
      expect(result).toContain('tls:');
      expect(result).toContain('enabled:');
      expect(result).toContain('skip_verify:');
    });

    it('should render array-of-objects as empty array', () => {
      const fieldsWithArrayOfObjects = [
        {
          name: 'client_certs',
          type: 'object',
          kind: 'array',
          description: 'Client certificates.',
          children: [
            {
              name: 'cert',
              type: 'string',
              kind: 'scalar'
            },
            {
              name: 'key',
              type: 'string',
              kind: 'scalar'
            }
          ]
        }
      ];

      const result = buildConfigYaml('inputs', 'kafka', fieldsWithArrayOfObjects, false);
      // Array-of-objects should render as empty array, not expanded
      expect(result).toContain('client_certs: []');
      // Should NOT contain the child fields expanded
      expect(result).not.toContain('cert:');
      expect(result).not.toContain('key:');
    });

    it('should render simple arrays correctly', () => {
      const fieldsWithArray = [
        {
          name: 'addresses',
          type: 'string',
          kind: 'array',
          description: 'List of addresses.',
          default: []
        }
      ];

      const result = buildConfigYaml('inputs', 'kafka', fieldsWithArray, false);
      expect(result).toContain('addresses:');
    });

    it('should handle empty children array for object map', () => {
      const fieldsWithEmptyChildren = [
        {
          name: 'metadata',
          type: 'object',
          kind: 'map',
          description: 'Metadata with no fields.',
          children: []
        }
      ];

      const result = buildConfigYaml('inputs', 'kafka', fieldsWithEmptyChildren, false);
      expect(result).toContain('metadata:');
      // Should not contain any child keys since children is empty
      expect(result.split('\n').filter(line => line.includes('metadata:')).length).toBe(1);
    });

    it('should handle empty children array for object array', () => {
      const fieldsWithEmptyChildren = [
        {
          name: 'items',
          type: 'object',
          kind: 'array',
          description: 'Array of items with no fields.',
          children: []
        }
      ];

      const result = buildConfigYaml('inputs', 'kafka', fieldsWithEmptyChildren, false);
      // Array-of-objects with empty children should render as empty array
      expect(result).toContain('items: []');
    });
  });
});
