const base = require('./jest.config.js');

// CI's test-all job additionally excludes the MCP contract and integration
// suites, which run in their own jobs. Extending the base array keeps
// jest.config.js the single source of truth for exclusions: an entry added
// there is honored here automatically, which a CLI --testPathIgnorePatterns
// override would silently drop (the flag REPLACES the config array).
module.exports = {
  ...base,
  testPathIgnorePatterns: [
    ...base.testPathIgnorePatterns,
    '__tests__/mcp/cli-contract.test.js',
    '__tests__/mcp/integration.test.js',
  ],
};
