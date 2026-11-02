module.exports = {
  // Test environment
  testEnvironment: 'node',

  // Test match patterns
  testMatch: [
    '**/__tests__/**/*.test.js'
  ],

  // Exclude CGO test from normal runs (use npm run test:cgo for CI/CD)
  testPathIgnorePatterns: [
    '/node_modules/',
    '__tests__/tools/cgo-detection.test.js'
  ],

  // Coverage configuration
  collectCoverageFrom: [
    'bin/**/*.js',
    'extensions/**/*.js',
    'macros/**/*.js',
    'tools/**/*.js',
    '!**/node_modules/**',
    '!**/__tests__/**'
  ],

  // Reporters configuration
  reporters: [
    'default',
    [
      'jest-junit',
      {
        outputDirectory: 'test-results',
        outputName: 'junit.xml',
        classNameTemplate: '{classname}',
        titleTemplate: '{title}',
        ancestorSeparator: ' › ',
        usePathForSuiteName: true
      }
    ]
  ],

  // Test timeout
  testTimeout: 30000
};
