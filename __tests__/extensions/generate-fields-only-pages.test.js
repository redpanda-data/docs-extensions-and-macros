'use strict'

describe('generate-fields-only-pages extension', () => {
  let extension

  beforeEach(() => {
    extension = require('../../extensions/generate-fields-only-pages.js')
  })

  test('warns when dataPath is not provided and no attachment fallback exists', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
    const mockContentCatalog = {
      getComponent: jest.fn(() => ({
        latest: {
          version: 'master'
        }
      })),
      findBy: jest.fn(() => [])
    }
    const mockContext = {
      getLogger: () => logger,
      on: jest.fn((event, handler) => {
        if (event === 'contentClassified') {
          handler({ contentCatalog: mockContentCatalog, siteCatalog: {} })
        }
      })
    }

    extension.register.call(mockContext, {})

    expect(logger.warn).toHaveBeenCalledWith('No dataPath configured and no JSON attachment found in the components module of the redpanda-connect content catalog. Skipping field-only page generation.')
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

  test('errors when datapath resource ID cannot be resolved', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
    const mockContentCatalog = {
      getComponent: jest.fn(() => ({
        latest: {
          version: 'master'
        }
      })),
      resolveResource: jest.fn(() => null)
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
        datapath: 'redpanda-connect::attachment$docs-data/connect-missing.json'
      }
    })

    expect(logger.error).toHaveBeenCalledWith(
      "Could not resolve connector data resource 'redpanda-connect::attachment$docs-data/connect-missing.json' in content catalog. Skipping field-only page generation."
    )
  })

  test('errors on invalid format', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
    const mockContext = {
      getLogger: () => logger,
      on: jest.fn()
    }

    extension.register.call(mockContext, {
      config: {
        format: 'invalid'
      }
    })

    expect(logger.error).toHaveBeenCalledWith("Invalid format 'invalid'. Must be 'nested' or 'table'. Disabling extension.")
    expect(mockContext.on).not.toHaveBeenCalled()
  })

  test('loads connector data from content catalog attachment by default', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
    const testData = {
      inputs: [
        {
          name: 'fallback_input',
          children: [
            {
              name: 'host',
              type: 'string',
              default: 'localhost',
              description: 'Host to connect to'
            }
          ]
        }
      ]
    }
    const addedFiles = []
    const attachment = {
      src: { relative: 'connect-4.88.0.json' },
      contents: Buffer.from(JSON.stringify(testData), 'utf8')
    }
    const mockContentCatalog = {
      getComponent: jest.fn(() => ({
        latest: {
          version: 'master'
        }
      })),
      findBy: jest.fn(() => [attachment]),
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

    extension.register.call(mockContext, { config: {} })

    expect(addedFiles.length).toBe(1)
    expect(addedFiles[0].src.relative).toBe('fields/inputs/fallback_input.adoc')
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Loaded connector data from content catalog attachment'))
    expect(logger.warn).not.toHaveBeenCalledWith('No dataPath configured and no JSON attachment found in the components module of the redpanda-connect content catalog. Skipping field-only page generation.')
  })

  test('generates field-only pages using Handlebars (nested format)', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    }

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

    const resourceId = 'redpanda-connect::attachment$docs-data/connect-latest.json'
    const mockResource = {
      contents: Buffer.from(JSON.stringify(testData), 'utf8')
    }

    const addedFiles = []
    const mockContentCatalog = {
      getComponent: jest.fn(() => ({
        latest: {
          version: 'master'
        }
      })),
      resolveResource: jest.fn((ref) => ref === resourceId ? mockResource : null),
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
        datapath: resourceId
      }
    })

    // Check that a file was added
    expect(addedFiles.length).toBe(1)
    expect(addedFiles[0].src.relative).toBe('fields/inputs/test_input.adoc')
    expect(addedFiles[0].isFieldOnlyPage).toBe(true)

    // Check the content uses Handlebars rendering
    const content = addedFiles[0].contents.toString()
    expect(content).toContain('=== `url`')
    expect(content).toContain('The URL to connect to')
    expect(content).toContain('*Type*: `string`')
    expect(content).toContain('*Default*: `http://localhost`')
    expect(content).toContain('=== `timeout`')
    expect(content).toContain('*Type*: `int`')
    expect(content).toContain('*Default*: `30`')

    expect(logger.info).toHaveBeenCalledWith('Generated 1 field-only pages')
  })

  test('generates field-only pages using table format', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    }

    const testData = {
      outputs: [
        {
          name: 'test_output',
          children: [
            {
              name: 'host',
              type: 'string',
              default: 'localhost',
              description: 'The hostname to connect to'
            },
            {
              name: 'port',
              type: 'int',
              default: 9092,
              description: 'The port number'
            },
            {
              name: 'options',
              type: 'object',
              kind: 'map',
              description: 'Additional options',
              children: [
                {
                  name: 'retry',
                  type: 'bool',
                  default: true,
                  description: 'Enable retry'
                }
              ]
            }
          ]
        }
      ]
    }

    const resourceId = 'redpanda-connect::attachment$docs-data/connect-latest.json'
    const mockResource = {
      contents: Buffer.from(JSON.stringify(testData), 'utf8')
    }

    const addedFiles = []
    const mockContentCatalog = {
      getComponent: jest.fn(() => ({
        latest: {
          version: 'master'
        }
      })),
      resolveResource: jest.fn((ref) => ref === resourceId ? mockResource : null),
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
        format: 'table',
        datapath: resourceId
      }
    })

    // Check that a file was added
    expect(addedFiles.length).toBe(1)
    expect(addedFiles[0].src.relative).toBe('fields/outputs/test_output.adoc')
    expect(addedFiles[0].isFieldOnlyPage).toBe(true)

    // Check the content uses table format
    const content = addedFiles[0].contents.toString()
    expect(content).toContain('[cols="2,1,1,4"]')
    expect(content).toContain('|===')
    expect(content).toContain('|Field |Type |Default |Description')
    expect(content).toContain('|`host`')
    expect(content).toContain('|`string`')
    expect(content).toContain('|`localhost`')
    expect(content).toContain('|The hostname to connect to')
    expect(content).toContain('|`port`')
    expect(content).toContain('|`int`')
    expect(content).toContain('|`9092`')
    expect(content).toContain('|The port number')
    // Check nested field appears in table
    expect(content).toContain('|`options.retry`')
    expect(content).toContain('|`bool`')
    expect(content).toContain('|`true`')

    expect(logger.info).toHaveBeenCalledWith('Generated 1 field-only pages')
  })

  test('skips components without fields', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }

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

    const resourceId = 'redpanda-connect::attachment$docs-data/connect-latest.json'
    const mockResource = {
      contents: Buffer.from(JSON.stringify(testData), 'utf8')
    }

    const addedFiles = []
    const mockContentCatalog = {
      getComponent: jest.fn(() => ({
        latest: {
          version: 'master'
        }
      })),
      resolveResource: jest.fn((ref) => ref === resourceId ? mockResource : null),
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
        datapath: resourceId
      }
    })

    // No files should be generated
    expect(addedFiles.length).toBe(0)
    expect(logger.info).toHaveBeenCalledWith('Generated 0 field-only pages')
  })
})
