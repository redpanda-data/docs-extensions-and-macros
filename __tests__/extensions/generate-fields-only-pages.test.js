'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

describe('generate-fields-only-pages extension', () => {
  let tmpDir
  let extension

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fields-only-test-'))
    process.chdir(tmpDir)
    extension = require('../../extensions/generate-fields-only-pages.js')
  })

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('uses default configuration values', () => {
    const mockContext = {
      getLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      }),
      on: jest.fn()
    }

    extension.register.call(mockContext, {})

    expect(mockContext.on).toHaveBeenCalledWith('contentClassified', expect.any(Function))
  })

  test('disables extension when enabled: false', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
    const mockContext = {
      getLogger: () => logger,
      on: jest.fn()
    }

    extension.register.call(mockContext, { config: { enabled: false } })

    expect(logger.info).toHaveBeenCalledWith('Extension disabled via config')
    expect(mockContext.on).not.toHaveBeenCalled()
  })

  test('rejects invalid format', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
    const mockContext = {
      getLogger: () => logger,
      on: jest.fn()
    }

    extension.register.call(mockContext, { config: { format: 'invalid' } })

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Invalid format 'invalid'"))
    expect(mockContext.on).not.toHaveBeenCalled()
  })

  test('rejects invalid headingLevel', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
    const mockContext = {
      getLogger: () => logger,
      on: jest.fn()
    }

    // Note: Antora lowercases config keys, so use 'headinglevel' not 'headingLevel'
    extension.register.call(mockContext, { config: { headinglevel: 7 } })

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid headingLevel'))
    expect(mockContext.on).not.toHaveBeenCalled()
  })

  test('warns when dataPath is missing', async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
    const handlers = {}

    const mockContext = {
      getLogger: () => logger,
      on: (event, handler) => {
        handlers[event] = handler
      }
    }

    const mockContentCatalog = {
      getComponents: () => [],
      getPages: () => [],
      addFile: jest.fn()
    }

    extension.register.call(mockContext, { config: {} })

    await handlers['contentClassified']({ contentCatalog: mockContentCatalog, siteCatalog: {} })

    expect(logger.warn).toHaveBeenCalledWith('No dataPath specified in config. Skipping field-only page generation.')
  })

  test('generates nested format pages with default heading level', async () => {
    // Create test data file
    const testData = {
      inputs: [
        {
          name: 'test_input',
          type: 'input',
          config: {
            children: [
              {
                name: 'url',
                type: 'string',
                description: 'The URL to connect to',
                default: 'http://localhost'
              },
              {
                name: 'timeout',
                type: 'int',
                description: 'Connection timeout in seconds',
                default: 30
              }
            ]
          }
        }
      ]
    }

    const dataPath = path.join(tmpDir, 'test-data.json')
    fs.writeFileSync(dataPath, JSON.stringify(testData))

    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
    const handlers = {}

    const mockContext = {
      getLogger: () => logger,
      on: (event, handler) => {
        handlers[event] = handler
      }
    }

    const addedFiles = []
    const mockContentCatalog = {
      getComponents: () => [{
        name: 'redpanda-connect',
        latest: {
          version: '1.0.0'
        }
      }],
      getPages: () => [],  // No existing pages for mock
      addFile: jest.fn((fileSpec) => {
        // Mock the file object that would be returned
        const mockFile = {
          ...fileSpec,
          path: fileSpec.path || 'mock-path.adoc',
          dirname: 'mock-dir',
          basename: 'mock.adoc',
          asciidoc: {}
        }
        addedFiles.push(mockFile)
        return mockFile
      })
    }

    extension.register.call(mockContext, {
      config: {
        datapath: dataPath,  // Note: Antora lowercases config keys
        format: 'nested',
        headinglevel: 2
      }
    })

    await handlers['contentClassified']({ contentCatalog: mockContentCatalog, siteCatalog: {} })

    // Check that a file was added
    expect(addedFiles.length).toBe(1)
    expect(addedFiles[0].src.relative).toBe('fields/inputs/test_input.adoc')

    // Check the content
    const content = addedFiles[0].contents.toString()
    expect(content).toContain('= test_input Fields')
    expect(content).toContain('== `url`')
    expect(content).toContain('The URL to connect to')
    expect(content).toContain('*Type*: `string`')
    expect(content).toContain('*Default*: `"http://localhost"`')
    expect(content).toContain('== `timeout`')
    expect(content).toContain('*Type*: `int`')
    expect(content).toContain('*Default*: `30`')

    expect(logger.info).toHaveBeenCalledWith('Generated 1 field-only pages in nested format')
  })

  test('generates table format pages', async () => {
    const testData = {
      outputs: [
        {
          name: 'test_output',
          type: 'output',
          config: {
            children: [
              {
                name: 'destination',
                type: 'string',
                description: 'Where to send data'
              }
            ]
          }
        }
      ]
    }

    const dataPath = path.join(tmpDir, 'test-data.json')
    fs.writeFileSync(dataPath, JSON.stringify(testData))

    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
    const handlers = {}

    const mockContext = {
      getLogger: () => logger,
      on: (event, handler) => {
        handlers[event] = handler
      }
    }

    const addedFiles = []
    const mockContentCatalog = {
      getComponents: () => [{
        name: 'redpanda-connect',
        latest: {
          version: '1.0.0'
        }
      }],
      getPages: () => [],  // No existing pages for mock
      addFile: jest.fn((fileSpec) => {
        // Mock the file object that would be returned
        const mockFile = {
          ...fileSpec,
          path: fileSpec.path || 'mock-path.adoc',
          dirname: 'mock-dir',
          basename: 'mock.adoc',
          asciidoc: {}
        }
        addedFiles.push(mockFile)
        return mockFile
      })
    }

    extension.register.call(mockContext, {
      config: {
        datapath: dataPath,  // Note: Antora lowercases config keys
        format: 'table'
      }
    })

    await handlers['contentClassified']({ contentCatalog: mockContentCatalog, siteCatalog: {} })

    expect(addedFiles.length).toBe(1)
    const content = addedFiles[0].contents.toString()
    expect(content).toContain('[cols="2,1,1,4"]')
    expect(content).toContain('|===')
    expect(content).toContain('|Field |Type |Default |Description')
    expect(content).toContain('|`destination`')
    expect(content).toContain('|`string`')
    expect(content).toContain('Where to send data')
  })

  test('uses custom heading level in nested format', async () => {
    const testData = {
      processors: [
        {
          name: 'test_processor',
          type: 'processor',
          config: {
            children: [
              {
                name: 'field',
                type: 'string',
                description: 'Field to process'
              }
            ]
          }
        }
      ]
    }

    const dataPath = path.join(tmpDir, 'test-data.json')
    fs.writeFileSync(dataPath, JSON.stringify(testData))

    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
    const handlers = {}

    const mockContext = {
      getLogger: () => logger,
      on: (event, handler) => {
        handlers[event] = handler
      }
    }

    const addedFiles = []
    const mockContentCatalog = {
      getComponents: () => [{
        name: 'redpanda-connect',
        latest: {
          version: '1.0.0'
        }
      }],
      getPages: () => [],  // No existing pages for mock
      addFile: jest.fn((fileSpec) => {
        // Mock the file object that would be returned
        const mockFile = {
          ...fileSpec,
          path: fileSpec.path || 'mock-path.adoc',
          dirname: 'mock-dir',
          basename: 'mock.adoc',
          asciidoc: {}
        }
        addedFiles.push(mockFile)
        return mockFile
      })
    }

    extension.register.call(mockContext, {
      config: {
        datapath: dataPath,  // Note: Antora lowercases config keys
        format: 'nested',
        headinglevel: 3
      }
    })

    await handlers['contentClassified']({ contentCatalog: mockContentCatalog, siteCatalog: {} })

    const content = addedFiles[0].contents.toString()
    // Should use === for level 3
    expect(content).toContain('=== `field`')
  })

  test('skips components without fields', async () => {
    const testData = {
      inputs: [
        {
          name: 'no_fields',
          type: 'input'
          // No config.children
        }
      ]
    }

    const dataPath = path.join(tmpDir, 'test-data.json')
    fs.writeFileSync(dataPath, JSON.stringify(testData))

    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
    const handlers = {}

    const mockContext = {
      getLogger: () => logger,
      on: (event, handler) => {
        handlers[event] = handler
      }
    }

    const mockContentCatalog = {
      getComponents: () => [{
        name: 'redpanda-connect',
        latest: {
          version: '1.0.0'
        }
      }],
      addFile: jest.fn()
    }

    extension.register.call(mockContext, {
      config: {
        datapath: dataPath  // Note: Antora lowercases config keys
      }
    })

    await handlers['contentClassified']({ contentCatalog: mockContentCatalog, siteCatalog: {} })

    expect(mockContentCatalog.addFile).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith('Generated 0 field-only pages in nested format')
  })
})
