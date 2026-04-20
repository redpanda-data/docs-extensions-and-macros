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

  test('warns when dataPath is not provided', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
    const mockContext = {
      getLogger: () => logger,
      on: jest.fn()
    }

    extension.register.call(mockContext, {})

    expect(logger.warn).toHaveBeenCalledWith('No dataPath configured. Skipping field-only page generation.')
    expect(mockContext.on).not.toHaveBeenCalled()
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

  test('warns when dataPath is missing', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
    const mockContext = {
      getLogger: () => logger,
      on: jest.fn()
    }

    extension.register.call(mockContext, { config: {} })

    expect(logger.warn).toHaveBeenCalledWith('No dataPath configured. Skipping field-only page generation.')
    expect(mockContext.on).not.toHaveBeenCalled()
  })

  test('generates field-only pages using Handlebars', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    }

    // Create test data file
    const testDataPath = path.join(tmpDir, 'test-data.json')
    const testData = {
      inputs: [
        {
          name: 'test_input',
          config: {
            children: [
              {
                name: 'url',
                type: 'string',
                default: 'http://localhost',
                description: 'The URL to connect to'
              },
              {
                name: 'timeout',
                type: 'int',
                default: 30,
                description: 'Connection timeout in seconds'
              }
            ]
          }
        }
      ]
    }
    fs.writeFileSync(testDataPath, JSON.stringify(testData))

    const addedFiles = []
    const mockContentCatalog = {
      getComponent: jest.fn(() => ({
        latest: {
          version: 'master'
        }
      })),
      getPages: jest.fn(() => []),
      addFile: jest.fn((file) => {
        addedFiles.push(file)
        return file
      })
    }

    const mockContext = {
      getLogger: () => logger,
      on: jest.fn((event, handler) => {
        if (event === 'contentClassified') {
          handler({ contentCatalog: mockContentCatalog, siteCatalog: {} })
        }
      })
    }

    extension.register.call(mockContext, {
      config: {
        datapath: testDataPath
      }
    })

    // Check that a file was added
    expect(addedFiles.length).toBe(1)
    expect(addedFiles[0].src.relative).toBe('fields/inputs/test_input.adoc')
    expect(addedFiles[0].isFieldOnlyPage).toBe(true)

    // Check the content uses Handlebars rendering
    const content = addedFiles[0].contents.toString()
    expect(content).toContain('= test_input Fields')
    expect(content).toContain('=== `url`')
    expect(content).toContain('The URL to connect to')
    expect(content).toContain('*Type*: `string`')
    expect(content).toContain('*Default*: `http://localhost`')
    expect(content).toContain('=== `timeout`')
    expect(content).toContain('*Type*: `int`')
    expect(content).toContain('*Default*: `30`')

    expect(logger.info).toHaveBeenCalledWith('Generated 1 field-only pages')
  })

  test('skips components without fields', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }

    // Create test data with no fields
    const testDataPath = path.join(tmpDir, 'test-data.json')
    const testData = {
      inputs: [
        {
          name: 'test_input_no_fields',
          config: {
            children: []
          }
        }
      ]
    }
    fs.writeFileSync(testDataPath, JSON.stringify(testData))

    const addedFiles = []
    const mockContentCatalog = {
      getComponent: jest.fn(() => ({
        latest: {
          version: 'master'
        }
      })),
      getPages: jest.fn(() => []),
      addFile: jest.fn((file) => {
        addedFiles.push(file)
        return file
      })
    }

    const mockContext = {
      getLogger: () => logger,
      on: jest.fn((event, handler) => {
        if (event === 'contentClassified') {
          handler({ contentCatalog: mockContentCatalog, siteCatalog: {} })
        }
      })
    }

    extension.register.call(mockContext, {
      config: {
        datapath: testDataPath
      }
    })

    // No files should be generated
    expect(addedFiles.length).toBe(0)
    expect(logger.info).toHaveBeenCalledWith('Generated 0 field-only pages')
  })
})
