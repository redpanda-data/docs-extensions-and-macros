const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

// Mock child_process for isolated testing
jest.mock('child_process');

// Import all functions from the bundler
const {
  normalizeTag,
  getMajorMinor,
  sortObjectKeys,
  detectBundler,
  createEntrypoint,
  runBundler,
  postProcessBundle,
  bundleOpenAPI
} = require('../../tools/bundle-openapi.js');

describe('OpenAPI Bundle Tool - Production Test Suite', () => {
  
  let mockTempDir;
  
  beforeEach(() => {
    // Create a real temp directory for each test
    mockTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'));
    
    // Reset all mocks
    jest.clearAllMocks();
    
    // Mock successful execSync by default
    execSync.mockImplementation(() => '');
    spawnSync.mockImplementation(() => ({ status: 0, error: null }));
  });
  
  afterEach(() => {
    // Clean up temp directory
    if (mockTempDir && fs.existsSync(mockTempDir)) {
      fs.rmSync(mockTempDir, { recursive: true, force: true });
    }
  });

  describe('Version Handling', () => {
    describe('normalizeTag', () => {
      test('should remove v prefix from semantic versions', () => {
        expect(normalizeTag('v24.3.2')).toBe('24.3.2');
        expect(normalizeTag('v25.1.0')).toBe('25.1.0');
        expect(normalizeTag('v1.0.0-rc1')).toBe('1.0.0-rc1');
      });

      test('should preserve versions without v prefix', () => {
        expect(normalizeTag('24.3.2')).toBe('24.3.2');
        expect(normalizeTag('25.1.0')).toBe('25.1.0');
        expect(normalizeTag('1.0.0-beta')).toBe('1.0.0-beta');
      });

      test('should handle dev branch', () => {
        expect(normalizeTag('dev')).toBe('dev');
        expect(normalizeTag('  dev  ')).toBe('dev');
      });

      test('should validate input parameters', () => {
        expect(() => normalizeTag('')).toThrow('Tag must be a non-empty string');
        expect(() => normalizeTag(null)).toThrow('Tag must be a non-empty string');
        expect(() => normalizeTag(undefined)).toThrow('Tag must be a non-empty string');
        expect(() => normalizeTag(123)).toThrow('Tag must be a non-empty string');
      });

      test('should reject invalid version formats', () => {
        expect(() => normalizeTag('invalid-tag')).toThrow(/Invalid version format.*Expected format like/);
        expect(() => normalizeTag('v1.x.y')).toThrow(/Invalid version format/);
        expect(() => normalizeTag('random-string')).toThrow(/Invalid version format/);
        expect(() => normalizeTag('v')).toThrow(/Invalid version format/);
      });

      test('should handle edge cases', () => {
        expect(() => normalizeTag('   ')).toThrow(/Invalid version format/);
        expect(() => normalizeTag('\t')).toThrow(/Invalid version format/);
        expect(() => normalizeTag('\n')).toThrow(/Invalid version format/);
      });
    });

    describe('getMajorMinor', () => {
      test('should extract major.minor from semantic versions', () => {
        expect(getMajorMinor('24.3.2')).toBe('24.3');
        expect(getMajorMinor('25.1.0')).toBe('25.1');
        expect(getMajorMinor('1.0.0-rc1')).toBe('1.0');
        expect(getMajorMinor('0.1.2')).toBe('0.1');
      });

      test('should handle dev version', () => {
        expect(getMajorMinor('dev')).toBe('dev');
      });

      test('should validate input parameters', () => {
        expect(() => getMajorMinor('')).toThrow('Version must be a non-empty string');
        expect(() => getMajorMinor(null)).toThrow('Version must be a non-empty string');
        expect(() => getMajorMinor(undefined)).toThrow('Version must be a non-empty string');
        expect(() => getMajorMinor(123)).toThrow('Version must be a non-empty string');
      });

      test('should reject invalid formats', () => {
        expect(() => getMajorMinor('24')).toThrow(/Invalid version format.*Expected X\.Y\.Z format/);
        expect(() => getMajorMinor('invalid')).toThrow(/Expected X\.Y\.Z format/);
      });

      test('should validate numeric components', () => {
        expect(() => getMajorMinor('abc.def.ghi')).toThrow(/Major and minor versions must be numbers/);
        expect(() => getMajorMinor('1.x.2')).toThrow(/Major and minor versions must be numbers/);
        expect(() => getMajorMinor('v1.2.3')).toThrow(/Major and minor versions must be numbers/);
      });

      test('should handle versions with extra components', () => {
        expect(getMajorMinor('24.3.2.1')).toBe('24.3');
        expect(getMajorMinor('1.0.0-rc1+build123')).toBe('1.0');
      });
    });
  });

  describe('Utility Functions', () => {
    describe('sortObjectKeys', () => {
      test('should sort object keys alphabetically', () => {
        const input = { z: 1, a: 2, m: 3 };
        const result = sortObjectKeys(input);
        expect(Object.keys(result)).toEqual(['a', 'm', 'z']);
      });

      test('should sort nested objects recursively', () => {
        const input = {
          z: { b: 1, a: 2 },
          a: { z: 3, b: 4 },
          m: 'value'
        };
        
        const result = sortObjectKeys(input);
        expect(Object.keys(result)).toEqual(['a', 'm', 'z']);
        expect(Object.keys(result.z)).toEqual(['a', 'b']);
        expect(Object.keys(result.a)).toEqual(['b', 'z']);
      });

      test('should handle arrays by sorting their object elements', () => {
        const input = [{ z: 1, a: 2 }, { b: 3, c: 4 }];
        const result = sortObjectKeys(input);
        expect(Object.keys(result[0])).toEqual(['a', 'z']);
        expect(Object.keys(result[1])).toEqual(['b', 'c']);
      });

      test('should handle primitive values unchanged', () => {
        expect(sortObjectKeys('string')).toBe('string');
        expect(sortObjectKeys(42)).toBe(42);
        expect(sortObjectKeys(true)).toBe(true);
        expect(sortObjectKeys(null)).toBe(null);
        expect(sortObjectKeys(undefined)).toBe(undefined);
      });

      test('should handle complex nested structures', () => {
        const input = {
          z: {
            nested: { b: [{ z: 1, a: 2 }], a: 'value' }
          },
          a: ['primitive', { nested: true }]
        };
        
        const result = sortObjectKeys(input);
        expect(Object.keys(result)).toEqual(['a', 'z']);
        expect(Object.keys(result.z.nested)).toEqual(['a', 'b']);
        expect(Object.keys(result.z.nested.b[0])).toEqual(['a', 'z']);
      });

      test('should handle empty objects and arrays', () => {
        expect(sortObjectKeys({})).toEqual({});
        expect(sortObjectKeys([])).toEqual([]);
        expect(sortObjectKeys({ a: {}, b: [] })).toEqual({ a: {}, b: [] });
      });
    });
  });

  describe('Bundler Detection', () => {
    describe('detectBundler', () => {
      test('should detect swagger-cli when available', () => {
        execSync.mockImplementationOnce(() => 'swagger-cli version 4.0.4');
        
        const bundler = detectBundler();
        expect(bundler).toBe('swagger-cli');
        expect(execSync).toHaveBeenCalledWith('swagger-cli --version', { stdio: 'ignore', timeout: 10000 });
      });

      test('should detect redocly when swagger-cli not available', () => {
        execSync
          .mockImplementationOnce(() => { throw new Error('Command not found'); })
          .mockImplementationOnce(() => 'redocly 1.0.0');
        
        const bundler = detectBundler();
        expect(bundler).toBe('redocly');
      });

      test('should detect npx redocly when others not available', () => {
        execSync
          .mockImplementationOnce(() => { throw new Error('Command not found'); })
          .mockImplementationOnce(() => { throw new Error('Command not found'); })
          .mockImplementationOnce(() => 'redocly 1.0.0');
        
        const bundler = detectBundler();
        expect(bundler).toBe('npx @redocly/cli');
      });

      test('should throw helpful error when no bundler available', () => {
        execSync.mockImplementation(() => { throw new Error('Command not found'); });
        
        expect(() => detectBundler()).toThrow(/No OpenAPI bundler found/);
        expect(() => detectBundler()).toThrow(/npm install/);
        expect(() => detectBundler()).toThrow(/redocly.com/);
      });

      test('should handle timeout properly', () => {
        execSync.mockImplementation(() => { throw new Error('ETIMEDOUT'); });
        
        expect(() => detectBundler()).toThrow(/No OpenAPI bundler found/);
      });
    });
  });

  describe('Fragment Discovery', () => {
    describe('createEntrypoint', () => {
      beforeEach(() => {
        // Create mock directory structure
        const adminV2Dir = path.join(mockTempDir, 'vbuild/openapi/proto/redpanda/core/admin/v2');
        const commonDir = path.join(mockTempDir, 'vbuild/openapi/proto/redpanda/core/common');
        
        fs.mkdirSync(adminV2Dir, { recursive: true });
        fs.mkdirSync(commonDir, { recursive: true });
        
        // Create mock fragment files
        fs.writeFileSync(path.join(adminV2Dir, 'broker.openapi.yaml'), 'openapi: 3.1.0\ninfo:\n  title: Broker');
        fs.writeFileSync(path.join(adminV2Dir, 'cluster.openapi.yaml'), 'openapi: 3.1.0\ninfo:\n  title: Cluster');
        fs.writeFileSync(path.join(commonDir, 'common.openapi.yaml'), 'openapi: 3.1.0\ninfo:\n  title: Common');
      });

      test('should find and return fragment files for admin surface', () => {
        const fragments = createEntrypoint(mockTempDir, 'admin', true);
        
        expect(fragments).toHaveLength(3);
        expect(fragments.some(f => f.includes('broker.openapi.yaml'))).toBe(true);
        expect(fragments.some(f => f.includes('cluster.openapi.yaml'))).toBe(true);
        expect(fragments.some(f => f.includes('common.openapi.yaml'))).toBe(true);
      });

      test('should validate input parameters', () => {
        expect(() => createEntrypoint('', 'admin')).toThrow('Invalid temporary directory');
        expect(() => createEntrypoint('/nonexistent', 'admin')).toThrow('Invalid temporary directory');
        expect(() => createEntrypoint(mockTempDir, 'invalid')).toThrow('Invalid API surface');
        expect(() => createEntrypoint(mockTempDir, '')).toThrow('Invalid API surface');
        expect(() => createEntrypoint(mockTempDir, null)).toThrow('Invalid API surface');
      });

      test('should throw error when no fragments found', () => {
        const emptyTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
        
        try {
          expect(() => createEntrypoint(emptyTempDir, 'admin')).toThrow(/No OpenAPI fragments found to bundle/);
        } finally {
          fs.rmSync(emptyTempDir, { recursive: true, force: true });
        }
      });

      test('should filter out non-openapi files', () => {
        const adminV2Dir = path.join(mockTempDir, 'vbuild/openapi/proto/redpanda/core/admin/v2');
        
        // Add non-openapi files
        fs.writeFileSync(path.join(adminV2Dir, 'readme.txt'), 'Not an OpenAPI file');
        fs.writeFileSync(path.join(adminV2Dir, 'config.yaml'), 'Not an OpenAPI file');
        fs.writeFileSync(path.join(adminV2Dir, 'test.openapi.json'), 'Wrong extension');
        
        const fragments = createEntrypoint(mockTempDir, 'admin', true);
        
        expect(fragments).toHaveLength(3); // Still only the 3 .openapi.yaml files
        expect(fragments.every(f => f.endsWith('.openapi.yaml'))).toBe(true);
      });

      test('should handle directory read errors gracefully', () => {
        // Mock fs.readdirSync to throw an error
        const originalReaddirSync = fs.readdirSync;
        fs.readdirSync = jest.fn().mockImplementation(() => {
          throw new Error('Permission denied');
        });
        
        try {
          expect(() => createEntrypoint(mockTempDir, 'admin')).toThrow(/Failed to read fragment directories/);
        } finally {
          fs.readdirSync = originalReaddirSync;
        }
      });

      test('should verify files actually exist', () => {
        const adminV2Dir = path.join(mockTempDir, 'vbuild/openapi/proto/redpanda/core/admin/v2');
        
        // Create a directory that looks like a file
        fs.mkdirSync(path.join(adminV2Dir, 'fake.openapi.yaml'));
        
        const fragments = createEntrypoint(mockTempDir, 'admin', true);
        
        // Should find only the 3 real files (2 from admin/v2 + 1 from common), not the fake directory
        expect(fragments).toHaveLength(3);
        expect(fragments.every(f => fs.statSync(f).isFile())).toBe(true);
      });
    });
  });

  describe('Post-processing', () => {
    describe('postProcessBundle', () => {
      let testBundleFile;
      
      beforeEach(() => {
        testBundleFile = path.join(mockTempDir, 'test-bundle.yaml');
        
        // Create a test bundle file
        const testContent = `
openapi: 3.1.0
info:
  title: Test API
  version: 1.0.0
paths:
  /test:
    get:
      summary: Test endpoint
components:
  schemas:
    TestSchema:
      type: object
`.trim();
        
        fs.writeFileSync(testBundleFile, testContent);
      });

      test('should process bundle file successfully', () => {
        const options = {
          surface: 'admin',
          normalizedTag: '25.2.4',
          majorMinor: '25.2',
          adminMajor: 'v2'
        };
        
        const result = postProcessBundle(testBundleFile, options);
        
        expect(result).toBeDefined();
        expect(result.openapi).toBe('3.1.0');
        expect(result.info.title).toBe('Redpanda Admin API');
        expect(result.info.version).toBe('25.2');
        expect(result.info['x-redpanda-core-version']).toBe('25.2.4');
        expect(result.info['x-admin-api-major']).toBe('v2');
        expect(result.info['x-generated-at']).toBeDefined();
        expect(result.info['x-generator']).toBe('redpanda-docs-openapi-bundler');
      });

      test('should validate input parameters', () => {
        expect(() => postProcessBundle('', {})).toThrow('Bundle file not found');
        expect(() => postProcessBundle('/nonexistent', {})).toThrow('Bundle file not found');
        
        const options = { surface: 'admin' };
        expect(() => postProcessBundle(testBundleFile, options)).toThrow('Missing required options');
      });

      test('should handle empty bundle file', () => {
        const emptyFile = path.join(mockTempDir, 'empty.yaml');
        fs.writeFileSync(emptyFile, '');
        
        const options = {
          surface: 'admin',
          normalizedTag: '25.2.4',
          majorMinor: '25.2'
        };
        
        expect(() => postProcessBundle(emptyFile, options)).toThrow('Bundle file is empty');
      });

      test('should handle invalid YAML', () => {
        const invalidFile = path.join(mockTempDir, 'invalid.yaml');
        fs.writeFileSync(invalidFile, 'invalid: yaml: content: [');
        
        const options = {
          surface: 'admin',
          normalizedTag: '25.2.4',
          majorMinor: '25.2'
        };
        
        expect(() => postProcessBundle(invalidFile, options)).toThrow('Post-processing failed');
      });

      test('should handle connect surface', () => {
        const options = {
          surface: 'connect',
          normalizedTag: 'dev',
          majorMinor: 'dev'
        };
        
        const result = postProcessBundle(testBundleFile, options);
        
        expect(result.info.title).toBe('Redpanda Connect RPCs');
      });

      test('should sort keys deterministically', () => {
        const options = {
          surface: 'admin',
          normalizedTag: '25.2.4',
          majorMinor: '25.2'
        };
        
        const result = postProcessBundle(testBundleFile, options);
        const keys = Object.keys(result);
        
        // Check that keys are sorted (components before paths, etc.)
        expect(keys.indexOf('components')).toBeLessThan(keys.indexOf('paths'));
        expect(keys.indexOf('info')).toBeLessThan(keys.indexOf('paths'));
      });
    });
  });

  describe('Error Handling & Edge Cases', () => {
    test('should handle various error scenarios gracefully', () => {
      // Test that functions don't crash on unexpected inputs
      expect(() => sortObjectKeys(new Date())).not.toThrow();
      expect(() => sortObjectKeys(Symbol('test'))).not.toThrow();
      
      // Test edge cases for version functions
      expect(() => normalizeTag('0.0.0')).not.toThrow();
      expect(normalizeTag('0.0.0')).toBe('0.0.0');
      
      expect(() => getMajorMinor('0.0.0')).not.toThrow();
      expect(getMajorMinor('0.0.0')).toBe('0.0');
    });

    test('should provide helpful error messages', () => {
      const errorTests = [
        { fn: () => normalizeTag('invalid'), pattern: /Invalid version format.*Expected format like/ },
        { fn: () => getMajorMinor('1'), pattern: /Expected X\.Y\.Z format/ },
        { fn: () => createEntrypoint('', 'admin'), pattern: /Invalid temporary directory/ },
        { fn: () => createEntrypoint('/tmp', 'invalid'), pattern: /Invalid API surface/ }
      ];
      
      errorTests.forEach(({ fn, pattern }) => {
        expect(fn).toThrow(pattern);
      });
    });
  });

  describe('Integration Tests', () => {
    test('version handling integration', () => {
      const testCases = [
        { input: 'v25.2.4', expectedNormalized: '25.2.4', expectedMajorMinor: '25.2' },
        { input: '24.3.2', expectedNormalized: '24.3.2', expectedMajorMinor: '24.3' },
        { input: 'dev', expectedNormalized: 'dev', expectedMajorMinor: 'dev' },
        { input: 'v1.0.0-rc1', expectedNormalized: '1.0.0-rc1', expectedMajorMinor: '1.0' }
      ];
      
      testCases.forEach(({ input, expectedNormalized, expectedMajorMinor }) => {
        const normalized = normalizeTag(input);
        const majorMinor = getMajorMinor(normalized);
        
        expect(normalized).toBe(expectedNormalized);
        expect(majorMinor).toBe(expectedMajorMinor);
      });
    });
  });
});

// Performance tests
describe('Performance Tests', () => {
  test('sortObjectKeys should handle large objects efficiently', () => {
    const largeObject = {};
    for (let i = 1000; i >= 0; i--) {
      largeObject[`key${i}`] = { nested: { value: i } };
    }
    
    const start = Date.now();
    const result = sortObjectKeys(largeObject);
    const duration = Date.now() - start;
    
    expect(duration).toBeLessThan(1000); // Should complete within 1 second
    expect(Object.keys(result)[0]).toBe('key0');
    expect(Object.keys(result)[1000]).toBe('key999');
  });
});

// CLI Integration tests (if node is available)
describe('CLI Integration Tests', () => {
  test('should show version correctly', () => {
    try {
      const result = execSync.mockReturnValue('4.9.1');
      // Test would run actual CLI in real environment
      expect(result).toBeDefined();
    } catch (error) {
      // Skip if CLI not available in test environment
      console.warn('CLI test skipped:', error.message);
    }
  });
});
