'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { generateRpkDocs, flagDefaultToShow } = require('../../../tools/rpk-docs/generate-rpk-docs.js')

describe('flagDefaultToShow', () => {
  test('shows a non-zero default', () => {
    expect(flagDefaultToShow({ type: 'string', default: 'debug' })).toBe('debug')
    expect(flagDefaultToShow({ type: 'int', default: 300 })).toBe('300')
    expect(flagDefaultToShow({ type: 'bool', default: true })).toBe('true')
    expect(flagDefaultToShow({ type: 'duration', default: '10s' })).toBe('10s')
  })

  test('hides zero values, as rpk --help does', () => {
    for (const value of ['', 0, false, [], '0', '0s', '[]', 'false', null, undefined]) {
      expect(flagDefaultToShow({ type: 'string', default: value })).toBeUndefined()
    }
  })

  test('drops the quotes cobra puts around a scraped string default', () => {
    expect(flagDefaultToShow({ type: 'string', default: '"ask"' })).toBe('ask')
    expect(flagDefaultToShow({ type: 'string', default: '""' })).toBeUndefined()
  })

  test('hides the default of a required flag', () => {
    expect(flagDefaultToShow({ type: 'int', default: 5, required: true })).toBeUndefined()
  })

  test('leaves a description that already states its default', () => {
    expect(flagDefaultToShow({ type: 'string', default: 'x', description: 'Mode (default x)' })).toBeUndefined()
    expect(flagDefaultToShow({ type: 'string', default: 'x', description: 'Mode. Default: x' })).toBeUndefined()
    expect(flagDefaultToShow({ type: 'int32', default: -1, description: 'Partitions; -1 defaults to the cluster setting' })).toBeUndefined()
    expect(flagDefaultToShow({ type: 'string', default: 'x', description: 'Mode. The default is x' })).toBeUndefined()
  })

  test('hides a path under the home directory of the machine that saved the snapshot', () => {
    expect(flagDefaultToShow({ type: 'string', default: '/root/.local/bin', description: 'Destination directory' })).toBeUndefined()
    expect(flagDefaultToShow({ type: 'string', default: '/home/runner/.config/rpk', description: 'Directory' })).toBeUndefined()
    expect(flagDefaultToShow({ type: 'string', default: '/Users/jake/.local/bin', description: 'Directory' })).toBeUndefined()
    expect(flagDefaultToShow({ type: 'string', default: '/etc/redpanda/redpanda.yaml', description: 'Config file' })).toBe('/etc/redpanda/redpanda.yaml')
  })
})

describe('flag table', () => {
  test('prints Required and Default in the flag row', async () => {
    const tree = {
      name: 'rpk',
      description: 'Root command',
      commands: [{
        name: 'loggers',
        description: 'Set loggers.',
        usage: 'rpk loggers [flags]',
        flags: [
          { name: 'level', shorthand: 'l', type: 'string', description: 'Log level to set', default: 'debug', required: false },
          { name: 'expiry-seconds', shorthand: 'e', type: 'int', description: 'Seconds to persist', default: 300, required: false },
          { name: 'node-id', type: 'int', description: 'Broker to apply the change on', default: 0, required: true },
          { name: 'all', type: 'bool', description: 'Every logger', default: false, required: false }
        ]
      }],
      global_flags: []
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-defaults-'))
    await generateRpkDocs({ tree, outputDir: tmp, rpkVersion: 'test', pluginVersions: {} })
    const page = fs.readFileSync(path.join(tmp, 'rpk-loggers.adoc'), 'utf8')
    fs.rmSync(tmp, { recursive: true, force: true })

    expect(page).toContain('|-l, --level |string |Log level to set. Default: `debug`.')
    expect(page).toContain('|-e, --expiry-seconds |int |Seconds to persist. Default: `300`.')
    expect(page).toContain('|--node-id |int |Broker to apply the change on. *Required.*')
    expect(page).not.toMatch(/--node-id[^\n]*Default/)
    expect(page).toMatch(/\|--all \|bool \|Every logger\.\n/)
  })
})
