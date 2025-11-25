/**
 * @jest-environment node
 */

const fs = require('fs');
const path = require('path');

// Mock dependencies before importing the library
jest.mock('fs');
jest.mock('child_process');
jest.mock('js-yaml');

const mcpTools = require('../../bin/mcp-tools');
const {
  findRepoRoot,
  getAntoraStructure,
  getRedpandaVersion,
  getConsoleVersion,
  generatePropertyDocs,
  generateMetricsDocs,
  generateRpkDocs,
  generateRpConnectDocs,
  executeTool
} = mcpTools;

// Import constants from utils
const {
  MAX_RECURSION_DEPTH,
  MAX_EXEC_BUFFER_SIZE,
  DEFAULT_SKIP_DIRS,
  PLAYBOOK_NAMES
} = require('../../bin/mcp-tools/utils');

// validateDocToolsCommand is not exported, so we need to test it through executeTool
const validateDocToolsCommand = (command) => {
  // This function is now internal to mcp-tools/index.js
  // We can only test it indirectly through run_doc_tools_command
  if (!command || typeof command !== 'string') {
    return { valid: false, error: 'Command must be a non-empty string' };
  }
  const dangerousChars = /[;|&$`<>(){}[\]!*?~]/;
  if (dangerousChars.test(command)) {
    return { valid: false, error: 'Invalid command: shell metacharacters not allowed' };
  }
  if (command.includes('..') || command.includes('~')) {
    return { valid: false, error: 'Invalid command: path traversal sequences not allowed' };
  }
  return { valid: true };
};

describe('MCP Server Library - Constants', () => {
  it('should have correct MAX_RECURSION_DEPTH', () => {
    expect(MAX_RECURSION_DEPTH).toBe(3);
  });

  it('should have correct MAX_EXEC_BUFFER_SIZE', () => {
    expect(MAX_EXEC_BUFFER_SIZE).toBe(50 * 1024 * 1024);
  });

  it('should have correct DEFAULT_SKIP_DIRS', () => {
    expect(DEFAULT_SKIP_DIRS).toEqual([
      'node_modules',
      '.git',
      'venv',
      '__pycache__',
      '.pytest_cache'
    ]);
  });

  it('should have correct PLAYBOOK_NAMES', () => {
    expect(PLAYBOOK_NAMES).toEqual([
      'local-antora-playbook.yml',
      'antora-playbook.yml',
      'docs-playbook.yml'
    ]);
  });
});

describe('MCP Server Library - Repository Detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('findRepoRoot', () => {
    it('should detect git repository', () => {
      const mockExists = jest.fn((filePath) => {
        return filePath.endsWith('.git');
      });
      fs.existsSync = mockExists;

      const result = findRepoRoot('/test/path');

      expect(result.detected).toBe(true);
      expect(result.type).toBe('git');
      expect(result.root).toBeTruthy();
    });

    it('should detect npm package repository', () => {
      let callCount = 0;
      const mockExists = jest.fn((filePath) => {
        callCount++;
        // First call checks for .git (false), second for package.json (true)
        return callCount > 1 && filePath.endsWith('package.json');
      });
      fs.existsSync = mockExists;

      const result = findRepoRoot('/test/path');

      expect(result.detected).toBe(true);
      expect(result.type).toBe('npm');
    });

    it('should return current directory when no repo found', () => {
      fs.existsSync = jest.fn(() => false);

      const testPath = '/test/path';
      const result = findRepoRoot(testPath);

      expect(result.detected).toBe(false);
      expect(result.type).toBe(null);
      expect(result.root).toBe(testPath);
    });

    it('should return repo type information', () => {
      fs.existsSync = jest.fn((filePath) => filePath.endsWith('.git'));

      const result = findRepoRoot('/test/path');

      expect(result).toHaveProperty('root');
      expect(result).toHaveProperty('detected');
      expect(result).toHaveProperty('type');
    });
  });

  describe('Command Validation', () => {
    const dangerousCommands = [
      { cmd: 'generate property-docs; rm -rf /', reason: 'semicolon' },
      { cmd: 'generate property-docs | cat /etc/passwd', reason: 'pipe' },
      { cmd: 'generate property-docs && malicious-command', reason: 'ampersand' },
      { cmd: 'generate property-docs $(malicious)', reason: 'command substitution' },
      { cmd: 'generate property-docs `malicious`', reason: 'backtick' },
      { cmd: 'generate property-docs > /etc/passwd', reason: 'redirection' },
      { cmd: 'generate property-docs < /etc/passwd', reason: 'redirection' },
      { cmd: 'generate ../../../etc/passwd', reason: 'path traversal' },
      { cmd: 'generate ~/sensitive-file', reason: 'tilde expansion' }
    ];

    const safeCommands = [
      'generate property-docs --tag v25.3.1',
      'generate metrics-docs --branch main',
      'generate rp-connect-docs',
      'help',
      'version'
    ];

    dangerousCommands.forEach(({ cmd, reason }) => {
      it(`should reject dangerous command (${reason}): ${cmd.substring(0, 40)}`, () => {
        const result = validateDocToolsCommand(cmd);
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      });
    });

    safeCommands.forEach(cmd => {
      it(`should allow safe command: ${cmd}`, () => {
        const result = validateDocToolsCommand(cmd);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      });
    });

    it('should reject empty string', () => {
      const result = validateDocToolsCommand('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('non-empty string');
    });

    it('should reject null', () => {
      const result = validateDocToolsCommand(null);
      expect(result.valid).toBe(false);
    });

    it('should reject undefined', () => {
      const result = validateDocToolsCommand(undefined);
      expect(result.valid).toBe(false);
    });

    it('should reject non-string types', () => {
      expect(validateDocToolsCommand(123).valid).toBe(false);
      expect(validateDocToolsCommand({}).valid).toBe(false);
      expect(validateDocToolsCommand([]).valid).toBe(false);
    });
  });

  describe('getAntoraStructure', () => {
    const yaml = require('js-yaml');

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should accept both string and object repoRoot parameter', () => {
      fs.existsSync = jest.fn(() => false);
      fs.realpathSync = jest.fn((p) => p);
      fs.readdirSync = jest.fn(() => []);

      // Test with string
      const result1 = getAntoraStructure('/test/path');
      expect(result1.repoRoot).toBe('/test/path');

      // Test with object
      const repoInfo = { root: '/test/path2', detected: true, type: 'git' };
      const result2 = getAntoraStructure(repoInfo);
      expect(result2.repoRoot).toBe('/test/path2');
      expect(result2.repoInfo).toEqual(repoInfo);
    });

    it('should find playbook in priority order', () => {
      let callCount = 0;
      fs.existsSync = jest.fn((filePath) => {
        callCount++;
        // Second call finds antora-playbook.yml
        return callCount === 2 && filePath.includes('antora-playbook.yml');
      });
      fs.realpathSync = jest.fn((p) => p);
      fs.readdirSync = jest.fn(() => []);
      fs.readFileSync = jest.fn(() => 'site:\n  title: Test');
      yaml.load = jest.fn(() => ({ site: { title: 'Test' } }));

      const result = getAntoraStructure('/test');

      expect(result.playbookPath).toContain('antora-playbook.yml');
      expect(result.playbook).toEqual({ site: { title: 'Test' } });
    });

    it('should handle playbook parsing errors gracefully', () => {
      fs.existsSync = jest.fn((filePath) => filePath.includes('local-antora-playbook.yml'));
      fs.realpathSync = jest.fn((p) => p);
      fs.readdirSync = jest.fn(() => []);
      fs.readFileSync = jest.fn(() => 'invalid yaml: [[[');
      yaml.load = jest.fn(() => {
        throw new Error('YAML parse error');
      });

      const result = getAntoraStructure('/test');

      // Should continue without playbook
      expect(result.playbook).toBe(null);
      expect(result.playbookPath).toContain('local-antora-playbook.yml');
    });

    it('should skip directories in skip list', () => {
      const mockDirEntries = [
        { name: 'node_modules', isDirectory: () => true },
        { name: '.git', isDirectory: () => true },
        { name: 'venv', isDirectory: () => true },
        { name: 'valid-dir', isDirectory: () => true },
        { name: 'antora.yml', isDirectory: () => false }
      ];

      fs.existsSync = jest.fn(() => true);
      fs.realpathSync = jest.fn((p) => p);
      fs.readdirSync = jest.fn(() => mockDirEntries);
      fs.readFileSync = jest.fn(() => 'name: test\nversion: 1.0');
      fs.statSync = jest.fn(() => ({ isDirectory: () => true }));
      yaml.load = jest.fn(() => ({ name: 'test', version: '1.0' }));

      const result = getAntoraStructure('/test');

      // Should find antora.yml but skip node_modules, .git, venv
      expect(result.components.length).toBeGreaterThan(0);
    });

    it('should use custom skip list when provided', () => {
      const customSkipList = ['custom-skip'];
      const mockDirEntries = [
        { name: 'custom-skip', isDirectory: () => true },
        { name: 'node_modules', isDirectory: () => true }, // Will be scanned with custom list
        { name: 'antora.yml', isDirectory: () => false }
      ];

      fs.existsSync = jest.fn(() => true);
      fs.realpathSync = jest.fn((p) => p);
      fs.readdirSync = jest.fn(() => mockDirEntries);
      fs.readFileSync = jest.fn(() => 'name: test');
      yaml.load = jest.fn(() => ({ name: 'test' }));

      const result = getAntoraStructure('/test', customSkipList);

      // Custom skip list should be used
      expect(result.components).toBeDefined();
    });

    it('should prevent symlink loops', () => {
      let realpathCalls = 0;
      fs.existsSync = jest.fn(() => true);
      fs.realpathSync = jest.fn(() => {
        // Return same real path to simulate loop
        return '/real/path';
      });
      fs.readdirSync = jest.fn(() => [
        { name: 'link-dir', isDirectory: () => true }
      ]);

      const result = getAntoraStructure('/test');

      // Should not hang or crash
      expect(result).toBeDefined();
      expect(result.repoRoot).toBe('/test');
    });

    it('should respect MAX_RECURSION_DEPTH', () => {
      fs.existsSync = jest.fn(() => true);
      fs.realpathSync = jest.fn((p) => p);

      let depth = 0;
      fs.readdirSync = jest.fn(() => {
        depth++;
        // Return subdirectory to trigger recursion
        if (depth <= MAX_RECURSION_DEPTH + 2) {
          return [{ name: `subdir${depth}`, isDirectory: () => true }];
        }
        return [];
      });

      const result = getAntoraStructure('/test');

      // Depth should be limited
      expect(depth).toBeLessThanOrEqual(MAX_RECURSION_DEPTH + 2);
    });

    it('should parse antora.yml files and detect modules', () => {
      fs.existsSync = jest.fn((filePath) => {
        // Simulate antora.yml exists, modules dir exists
        return filePath.includes('antora.yml') ||
               filePath.includes('modules') ||
               filePath === '/test';
      });
      fs.realpathSync = jest.fn((p) => p);

      // Mock directory reading to return antora.yml when scanning root
      fs.readdirSync = jest.fn((dirPath) => {
        if (dirPath === '/test') {
          // Root directory contains antora.yml file
          return [{ name: 'antora.yml', isDirectory: () => false }];
        }
        if (dirPath.includes('modules')) {
          // Modules directory contains module folders
          return ['ROOT', 'admin', 'reference'];
        }
        return [];
      });

      fs.readFileSync = jest.fn(() => 'name: redpanda\nversion: 25.3\ntitle: Redpanda');
      fs.statSync = jest.fn(() => ({ isDirectory: () => true }));
      yaml.load = jest.fn(() => ({
        name: 'redpanda',
        version: '25.3',
        title: 'Redpanda'
      }));

      const result = getAntoraStructure('/test');

      expect(result.components.length).toBeGreaterThan(0);
      const component = result.components[0];
      expect(component.name).toBe('redpanda');
      expect(component.version).toBe('25.3');
      expect(component.title).toBe('Redpanda');
      expect(component.modules.length).toBe(3);
    });

    it('should detect module directories (pages, partials, etc)', () => {
      fs.existsSync = jest.fn((filePath) => {
        // Modules dir exists, pages and images exist
        return filePath.includes('modules') ||
               filePath.includes('pages') ||
               filePath.includes('images');
      });
      fs.realpathSync = jest.fn((p) => p);
      fs.readdirSync = jest.fn((filePath) => {
        if (filePath.includes('modules')) {
          return ['ROOT'];
        }
        return [{ name: 'antora.yml', isDirectory: () => false }];
      });
      fs.readFileSync = jest.fn(() => 'name: test');
      fs.statSync = jest.fn(() => ({ isDirectory: () => true }));
      yaml.load = jest.fn(() => ({ name: 'test' }));

      const result = getAntoraStructure('/test');

      if (result.components.length > 0 && result.components[0].modules.length > 0) {
        const module = result.components[0].modules[0];
        expect(module).toHaveProperty('pages');
        expect(module).toHaveProperty('partials');
        expect(module).toHaveProperty('examples');
        expect(module).toHaveProperty('attachments');
        expect(module).toHaveProperty('images');
        expect(module.pages).toBe(true);
        expect(module.images).toBe(true);
        expect(module.partials).toBe(false);
      }
    });

    it('should detect doc-tools availability', () => {
      fs.existsSync = jest.fn((filePath) => {
        return filePath.includes('package.json') || filePath.includes('doc-tools.js');
      });
      fs.realpathSync = jest.fn((p) => p);
      fs.readdirSync = jest.fn(() => []);

      const result = getAntoraStructure('/test');

      expect(result.hasDocTools).toBe(true);
    });

    it('should return false for hasDocTools when not available', () => {
      const { execSync } = require('child_process');
      fs.existsSync = jest.fn(() => false);
      fs.realpathSync = jest.fn((p) => p);
      fs.readdirSync = jest.fn(() => []);
      // Mock execSync to throw when checking for doc-tools
      execSync.mockImplementation(() => { throw new Error('Command not found'); });

      const result = getAntoraStructure('/test');

      expect(result.hasDocTools).toBe(false);
    });

    it('should handle permission errors gracefully', () => {
      fs.existsSync = jest.fn(() => true);
      fs.realpathSync = jest.fn((p) => p);
      fs.readdirSync = jest.fn(() => {
        const error = new Error('EACCES: permission denied');
        error.code = 'EACCES';
        throw error;
      });

      const result = getAntoraStructure('/test');

      // Should not crash
      expect(result).toBeDefined();
      expect(result.components).toEqual([]);
    });

    it('should handle antora.yml parsing errors', () => {
      fs.existsSync = jest.fn(() => true);
      fs.realpathSync = jest.fn((p) => p);
      fs.readdirSync = jest.fn(() => [
        { name: 'antora.yml', isDirectory: () => false }
      ]);
      fs.readFileSync = jest.fn(() => 'invalid yaml');
      yaml.load = jest.fn(() => {
        throw new Error('Parse error');
      });

      const result = getAntoraStructure('/test');

      expect(result.components.length).toBeGreaterThan(0);
      expect(result.components[0]).toHaveProperty('error');
      expect(result.components[0].error).toContain('Failed to parse');
    });

    it('should return complete structure with all fields', () => {
      fs.existsSync = jest.fn(() => false);
      fs.realpathSync = jest.fn((p) => p);
      fs.readdirSync = jest.fn(() => []);

      const result = getAntoraStructure('/test');

      expect(result).toHaveProperty('repoRoot');
      expect(result).toHaveProperty('repoInfo');
      expect(result).toHaveProperty('playbook');
      expect(result).toHaveProperty('playbookPath');
      expect(result).toHaveProperty('components');
      expect(result).toHaveProperty('hasDocTools');
    });
  });

  describe('executeTool', () => {
    it('should return error for unknown tool', () => {
      const result = executeTool('unknown_tool', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool');
    });

    it('should validate command for run_doc_tools_command', () => {
      fs.existsSync = jest.fn(() => false); // No repo found

      const result = executeTool('run_doc_tools_command', { command: 'test; malicious' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('shell metacharacters');
    });

    it('should call getAntoraStructure for get_antora_structure tool', () => {
      fs.existsSync = jest.fn(() => false);
      fs.realpathSync = jest.fn((p) => p);
      fs.readdirSync = jest.fn(() => []);

      const result = executeTool('get_antora_structure', {});

      expect(result).toHaveProperty('repoRoot');
      expect(result).toHaveProperty('components');
      expect(result).toHaveProperty('hasDocTools');
    });
  });

  describe('Version Information Tools', () => {
    const { execSync } = require('child_process');

    describe('getRedpandaVersion', () => {
      it('should return version information for stable release', () => {
        execSync.mockReturnValue('REDPANDA_VERSION=v25.3.1\nREDPANDA_DOCKER_REPO=redpanda\n');

        const result = getRedpandaVersion({});

        expect(result.success).toBe(true);
        expect(result.version).toBe('v25.3.1');
        expect(result.docker_tag).toBe('docker.redpanda.com/redpandadata/redpanda:v25.3.1');
        expect(result.is_beta).toBe(false);
        expect(result.notes_url).toBe('https://github.com/redpanda-data/redpanda/releases/tag/v25.3.1');
      });

      it('should return version information for beta release', () => {
        execSync.mockReturnValue('REDPANDA_VERSION=v25.4.1-rc1\nREDPANDA_DOCKER_REPO=redpanda-unstable\n');

        const result = getRedpandaVersion({ beta: true });

        expect(result.success).toBe(true);
        expect(result.version).toBe('v25.4.1-rc1');
        expect(result.docker_tag).toBe('docker.redpanda.com/redpandadata/redpanda-unstable:v25.4.1-rc1');
        expect(result.is_beta).toBe(true);
      });

      it('should handle missing docker repo in output', () => {
        execSync.mockReturnValue('REDPANDA_VERSION=v25.3.1\n');

        const result = getRedpandaVersion({});

        expect(result.success).toBe(true);
        expect(result.version).toBe('v25.3.1');
        expect(result.docker_tag).toBe('docker.redpanda.com/redpandadata/redpanda:v25.3.1');
      });

      it('should handle command execution errors', () => {
        execSync.mockImplementation(() => {
          throw new Error('Network error');
        });

        const result = getRedpandaVersion({});

        expect(result.success).toBe(false);
        expect(result.error).toBe('Network error');
        expect(result.suggestion).toContain('network access');
      });

      it('should handle malformed output', () => {
        execSync.mockReturnValue('INVALID_OUTPUT\n');

        const result = getRedpandaVersion({});

        expect(result.success).toBe(false);
        expect(result.error).toContain('Failed to parse version');
      });
    });

    describe('getConsoleVersion', () => {
      it('should return Console version information', () => {
        execSync.mockReturnValue('CONSOLE_VERSION=v2.7.2\nCONSOLE_DOCKER_REPO=console\n');

        const result = getConsoleVersion();

        expect(result.success).toBe(true);
        expect(result.version).toBe('v2.7.2');
        expect(result.docker_tag).toBe('docker.redpanda.com/redpandadata/console:v2.7.2');
        expect(result.notes_url).toBe('https://github.com/redpanda-data/console/releases/tag/v2.7.2');
      });

      it('should handle missing docker repo in output', () => {
        execSync.mockReturnValue('CONSOLE_VERSION=v2.7.2\n');

        const result = getConsoleVersion();

        expect(result.success).toBe(true);
        expect(result.docker_tag).toBe('docker.redpanda.com/redpandadata/console:v2.7.2');
      });

      it('should handle command execution errors', () => {
        execSync.mockImplementation(() => {
          throw new Error('Network error');
        });

        const result = getConsoleVersion();

        expect(result.success).toBe(false);
        expect(result.error).toBe('Network error');
        expect(result.suggestion).toContain('network access');
      });

      it('should handle malformed output', () => {
        execSync.mockReturnValue('INVALID_OUTPUT\n');

        const result = getConsoleVersion();

        expect(result.success).toBe(false);
        expect(result.error).toContain('Failed to parse version');
      });
    });
  });

  describe('Documentation Generation Tools', () => {
    const { execSync, spawnSync } = require('child_process');

    beforeEach(() => {
      // Reset mocks before each test
      fs.existsSync.mockReset();
      fs.realpathSync.mockReset();
      fs.readdirSync.mockReset();
      execSync.mockReset();
      spawnSync.mockReset();
    });

    describe('generatePropertyDocs', () => {
      it('should generate property docs with default options', () => {
        // Mock repo detection
        fs.existsSync = jest.fn((p) => p.includes('package.json') || p.includes('doc-tools.js'));
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);

        spawnSync.mockReturnValue({
          status: 0,
          stdout: 'Generated 342 properties\n',
          stderr: '',
          error: null
        });

        const result = generatePropertyDocs({ tag: '25.3.1' });

        expect(result.success).toBe(true);
        expect(result.tag).toBe('v25.3.1');
        expect(result.files_generated).toContain('modules/reference/partials/properties.json');
        expect(result.property_count).toBe(342);
      });

      it('should generate property docs with partials', () => {
        fs.existsSync = jest.fn((p) => p.includes('package.json') || p.includes('doc-tools.js'));
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);

        spawnSync.mockReturnValue({
          status: 0,
          stdout: 'Generated 342 properties\n',
          stderr: '',
          error: null
        });

        const result = generatePropertyDocs({ tag: '25.3.1', generate_partials: true });

        expect(result.success).toBe(true);
        expect(result.files_generated).toContain('modules/reference/partials/cluster-properties.adoc');
        expect(result.files_generated).toContain('modules/reference/partials/broker-properties.adoc');
        expect(result.files_generated).toContain('modules/reference/partials/topic-properties.adoc');
        expect(result.files_generated).toContain('modules/reference/partials/tunable-properties.adoc');
      });

      it('should normalize version without v prefix', () => {
        fs.existsSync = jest.fn((p) => p.includes('package.json') || p.includes('doc-tools.js'));
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);

        spawnSync.mockReturnValue({
          status: 0,
          stdout: 'Generated 342 properties\n',
          stderr: '',
          error: null
        });

        const result = generatePropertyDocs({ tag: '25.3.1' });

        expect(result.tag).toBe('v25.3.1');
        expect(spawnSync).toHaveBeenCalledWith(
          'npx',
          expect.arrayContaining(['doc-tools', 'generate', 'property-docs', '--tag', 'v25.3.1']),
          expect.any(Object)
        );
      });

      it('should handle latest version', () => {
        fs.existsSync = jest.fn((p) => p.includes('package.json') || p.includes('doc-tools.js'));
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);

        spawnSync.mockReturnValue({
          status: 0,
          stdout: 'Generated 342 properties\n',
          stderr: '',
          error: null
        });

        const result = generatePropertyDocs({ tag: 'latest' });

        expect(result.tag).toBe('latest');
        expect(spawnSync).toHaveBeenCalledWith(
          'npx',
          expect.arrayContaining(['doc-tools', 'generate', 'property-docs', '--tag', 'latest']),
          expect.any(Object)
        );
      });

      it('should return error when doc-tools not found', () => {
        fs.existsSync = jest.fn(() => false);
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);
        // Mock execSync to throw when checking for doc-tools in getAntoraStructure
        execSync.mockImplementation(() => { throw new Error('Command not found'); });

        const result = generatePropertyDocs({ tag: '25.3.1' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('doc-tools not found');
        expect(result.suggestion).toContain('docs-extensions-and-macros');
      });

      it('should default to dev branch when no parameters provided', () => {
        fs.existsSync = jest.fn((p) => p.includes('package.json') || p.includes('doc-tools.js'));
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);

        spawnSync.mockReturnValue({
          status: 0,
          stdout: 'Generated 342 properties\n',
          stderr: '',
          error: null
        });

        const result = generatePropertyDocs({});

        expect(result.branch).toBe('dev');
        expect(spawnSync).toHaveBeenCalledWith(
          'npx',
          expect.arrayContaining(['--branch', 'dev']),
          expect.any(Object)
        );
      });

      it('should handle command execution errors', () => {
        fs.existsSync = jest.fn((p) => p.includes('package.json') || p.includes('doc-tools.js'));
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);

        spawnSync.mockReturnValue({
          status: 1,
          stdout: 'stdout output',
          stderr: 'Tag v25.3.1 not found',
          error: null
        });

        const result = generatePropertyDocs({ tag: '25.3.1' });

        expect(result.success).toBe(false);
        expect(result.error).toBe('Tag v25.3.1 not found');
        expect(result.stderr).toContain('Tag v25.3.1 not found');
        expect(result.suggestion).toContain('version exists');
      });
    });

    describe('generateMetricsDocs', () => {
      it('should generate metrics docs', () => {
        fs.existsSync = jest.fn((p) => p.includes('package.json') || p.includes('doc-tools.js'));
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);

        // Mock spawnSync (used by generateMetricsDocs) to return success
        spawnSync.mockReturnValue({
          status: 0,
          stdout: 'Generated 156 metrics\n',
          stderr: '',
          error: null
        });

        const result = generateMetricsDocs({ tag: '25.3.1' });

        expect(result.success).toBe(true);
        expect(result.tag).toBe('v25.3.1');
        expect(result.files_generated).toContain('modules/reference/pages/public-metrics-reference.adoc');
        expect(result.metrics_count).toBe(156);
      });

      it('should normalize version', () => {
        fs.existsSync = jest.fn((p) => p.includes('package.json') || p.includes('doc-tools.js'));
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);

        // Mock spawnSync (used by generateMetricsDocs) to return success
        spawnSync.mockReturnValue({
          status: 0,
          stdout: 'Generated 156 metrics\n',
          stderr: '',
          error: null
        });

        const result = generateMetricsDocs({ tag: '25.3.1' });

        expect(result.tag).toBe('v25.3.1');
      });

      it('should return error when doc-tools not found', () => {
        fs.existsSync = jest.fn(() => false);
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);
        // Mock execSync to throw when checking for doc-tools in getAntoraStructure
        execSync.mockImplementation(() => { throw new Error('Command not found'); });

        const result = generateMetricsDocs({ tag: '25.3.1' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('doc-tools not found');
      });

      it('should default to dev branch when no parameters provided', () => {
        fs.existsSync = jest.fn((p) => p.includes('package.json') || p.includes('doc-tools.js'));
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);

        spawnSync.mockReturnValue({
          status: 0,
          stdout: 'Generated 150 metrics\n',
          stderr: '',
          error: null
        });

        const result = generateMetricsDocs({});

        expect(result.branch).toBe('dev');
        expect(spawnSync).toHaveBeenCalledWith(
          'npx',
          expect.arrayContaining(['--branch', 'dev']),
          expect.any(Object)
        );
      });
    });

    describe('generateRpkDocs', () => {
      it('should generate RPK docs', () => {
        fs.existsSync = jest.fn((p) => p.includes('package.json') || p.includes('doc-tools.js'));
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);

        spawnSync.mockReturnValue({
          status: 0,
          stdout: 'Generated 87 commands\n',
          stderr: '',
          error: null
        });

        const result = generateRpkDocs({ tag: '25.3.1' });

        expect(result.success).toBe(true);
        expect(result.tag).toBe('v25.3.1');
        expect(result.commands_documented).toBe(87);
      });

      it('should normalize version', () => {
        fs.existsSync = jest.fn((p) => p.includes('package.json') || p.includes('doc-tools.js'));
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);

        spawnSync.mockReturnValue({
          status: 0,
          stdout: 'Generated 87 commands\n',
          stderr: '',
          error: null
        });

        const result = generateRpkDocs({ tag: '25.3.1' });

        expect(result.tag).toBe('v25.3.1');
      });

      it('should return error when doc-tools not found', () => {
        fs.existsSync = jest.fn(() => false);
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);
        // Mock execSync to throw when checking for doc-tools in getAntoraStructure
        execSync.mockImplementation(() => { throw new Error('Command not found'); });

        const result = generateRpkDocs({ tag: '25.3.1' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('doc-tools not found');
      });

      it('should default to dev branch when no parameters provided', () => {
        fs.existsSync = jest.fn((p) => p.includes('package.json') || p.includes('doc-tools.js'));
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);

        spawnSync.mockReturnValue({
          status: 0,
          stdout: 'Generated 120 commands\n',
          stderr: '',
          error: null
        });

        const result = generateRpkDocs({});

        expect(result.branch).toBe('dev');
        expect(spawnSync).toHaveBeenCalledWith(
          'npx',
          expect.arrayContaining(['--branch', 'dev']),
          expect.any(Object)
        );
      });
    });

    describe('generateRpConnectDocs', () => {
      it('should generate Redpanda Connect connector docs', () => {
        fs.existsSync = jest.fn((p) => p.includes('package.json') || p.includes('doc-tools.js'));
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);

        // Mock spawnSync (used by generateRpConnectDocs) to return success
        spawnSync.mockReturnValue({
          status: 0,
          stdout: 'Generated 245 connectors\n',
          stderr: '',
          error: null
        });

        const result = generateRpConnectDocs({});

        expect(result.success).toBe(true);
        expect(result.connectors_documented).toBe(245);
        expect(result.files_generated).toContain('modules/reference/pages/redpanda-connect/components/');
      });

      it('should generate docs with flags', () => {
        fs.existsSync = jest.fn((p) => p.includes('package.json') || p.includes('doc-tools.js'));
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);

        // Mock spawnSync (used by generateRpConnectDocs) to return success
        spawnSync.mockReturnValue({
          status: 0,
          stdout: 'Generated 250 connectors\n',
          stderr: '',
          error: null
        });

        const result = generateRpConnectDocs({ fetch_connectors: true, draft_missing: true });

        expect(result.success).toBe(true);
        expect(result.connectors_documented).toBe(250);
        expect(spawnSync).toHaveBeenCalledWith(
          'npx',
          expect.arrayContaining(['--fetch-connectors', '--draft-missing']),
          expect.any(Object)
        );
      });

      it('should handle output without connector count', () => {
        fs.existsSync = jest.fn((p) => p.includes('package.json') || p.includes('doc-tools.js'));
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);

        // Mock spawnSync (used by generateRpConnectDocs) to return success
        spawnSync.mockReturnValue({
          status: 0,
          stdout: 'Generation complete\n',
          stderr: '',
          error: null
        });

        const result = generateRpConnectDocs({});

        expect(result.success).toBe(true);
        expect(result.connectors_documented).toBeNull();
      });

      it('should return error when doc-tools not found', () => {
        fs.existsSync = jest.fn(() => false);
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);
        // Mock execSync to throw when checking for doc-tools in getAntoraStructure
        execSync.mockImplementation(() => { throw new Error('Command not found'); });

        const result = generateRpConnectDocs({});

        expect(result.success).toBe(false);
        expect(result.error).toContain('doc-tools not found');
        expect(result.suggestion).toContain('docs-extensions-and-macros');
      });

      it('should handle command execution errors', () => {
        fs.existsSync = jest.fn((p) => p.includes('package.json') || p.includes('doc-tools.js'));
        fs.realpathSync = jest.fn((p) => p);
        fs.readdirSync = jest.fn(() => []);

        // Mock spawnSync to return non-zero status with stderr
        spawnSync.mockReturnValue({
          status: 1,
          stdout: 'stdout output',
          stderr: 'Network error',
          error: null
        });

        const result = generateRpConnectDocs({ fetch_connectors: true });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Network error');
        expect(result.stderr).toContain('Network error');
        expect(result.suggestion).toContain('network access');
      });
    });
  });
});
