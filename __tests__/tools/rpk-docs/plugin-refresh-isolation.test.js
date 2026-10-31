'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

// The handler destructures spawnSync at load time, so mock it first
jest.mock('child_process')
const { spawnSync } = require('child_process')

const {
  fetchPluginSubtree,
  recordPluginVersions
} = require('../../../tools/rpk-docs/rpk-docs-handler.js')

const connectTree = {
  name: 'rpk',
  commands: [{
    name: 'connect',
    commands: [
      { name: 'install' },
      { name: 'run', usage: 'rpk connect run [flags]', flags: [{ name: 'log-level', type: 'string', from_plugin: true }] }
    ]
  }]
}

describe('fetchPluginSubtree temporary HOME', () => {
  let homes

  beforeEach(() => {
    spawnSync.mockReset()
    homes = []
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const recordHome = (opts) => {
    const home = opts && opts.env && opts.env.HOME
    if (home) homes.push({ home, existed: fs.existsSync(home) })
  }

  test('is removed after a successful refresh', () => {
    spawnSync.mockImplementation((cmd, args, opts) => {
      recordHome(opts)
      if (args[0] === '--print-tree') return { status: 0, stdout: JSON.stringify(connectTree), stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    })
    const { node, version } = fetchPluginSubtree({ plugin: 'connect', pluginVersion: '4.1.0', rpkBinPath: '/bin/rpk' })
    expect(node.name).toBe('connect')
    expect(version).toBe('4.1.0')
    expect(homes.length).toBeGreaterThan(0)
    expect(homes.every(h => h.existed)).toBe(true)
    expect(new Set(homes.map(h => h.home)).size).toBe(1)
    expect(fs.existsSync(homes[0].home)).toBe(false)
  })

  test('is removed when the refresh fails', () => {
    spawnSync.mockImplementation((cmd, args, opts) => {
      recordHome(opts)
      return { status: 1, stdout: '', stderr: 'boom' }
    })
    expect(() => fetchPluginSubtree({ plugin: 'connect', rpkBinPath: '/bin/rpk' })).toThrow(/Failed to install plugin 'connect'/)
    expect(homes.length).toBeGreaterThan(0)
    expect(homes[0].existed).toBe(true)
    expect(fs.existsSync(homes[0].home)).toBe(false)
  })
})

describe('recordPluginVersions', () => {
  const fetchLatest = (plugin) => `${plugin}-latest`
  const treeWith = (...commands) => ({ name: 'rpk', commands })
  const shim = (name) => ({ name, commands: [{ name: 'install' }, { name: 'uninstall' }, { name: 'upgrade' }] })
  const rpkCheck = (flags) => ({ name: 'check', flags, commands: [] })

  test('records rpk check when its install succeeded, though it has no subcommands', () => {
    const tree = treeWith(rpkCheck([{ name: 'version', type: 'bool' }]), connectTree.commands[0], shim('k8s'))
    expect(recordPluginVersions(tree, { installedPlugins: ['check', 'connect'], fetchLatest }))
      .toEqual({ check: 'check-latest', connect: 'connect-latest' })
  })

  test('records rpk check when the tree carries its flags', () => {
    const tree = treeWith(rpkCheck([{ name: 'admin-url', type: 'string', from_plugin: true }]))
    expect(recordPluginVersions(tree, { pluginPins: { check: '0.2.0' }, fetchLatest })).toEqual({ check: '0.2.0' })
  })

  test('skips rpk check when nothing shows it installed', () => {
    const tree = treeWith(rpkCheck([{ name: 'version', type: 'bool' }]), shim('k8s'))
    expect(recordPluginVersions(tree, { installedPlugins: ['k8s'], fetchLatest })).toEqual({})
  })
})
