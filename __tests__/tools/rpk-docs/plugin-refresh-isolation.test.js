'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

// The handler destructures spawnSync at load time, so mock it first
jest.mock('child_process')
const { spawnSync } = require('child_process')

const {
  fetchPluginSubtree,
  isolatedPluginEnv,
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

describe('plugin refresh PATH isolation', () => {
  let tmp, pluginDir, toolDir, savedPath

  beforeEach(() => {
    spawnSync.mockReset()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-path-test-'))
    pluginDir = path.join(tmp, 'local-bin')
    toolDir = path.join(tmp, 'tools')
    fs.mkdirSync(pluginDir)
    fs.mkdirSync(toolDir)
    fs.writeFileSync(path.join(pluginDir, '.rpk.managed-rpai'), '#!/bin/sh\n', { mode: 0o755 })
    fs.writeFileSync(path.join(toolDir, 'tar'), '#!/bin/sh\n', { mode: 0o755 })
    savedPath = process.env.PATH
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env.PATH = savedPath
    jest.restoreAllMocks()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('drops PATH directories that hold rpk plugins and keeps the rest', () => {
    const otherPlugins = path.join(tmp, 'other')
    fs.mkdirSync(otherPlugins)
    fs.writeFileSync(path.join(otherPlugins, '.rpk-legacy'), '#!/bin/sh\n', { mode: 0o755 })
    fs.writeFileSync(path.join(otherPlugins, '.rpk.ac-foo'), '#!/bin/sh\n', { mode: 0o755 })
    const missing = path.join(tmp, 'missing')
    const env = isolatedPluginEnv('/tmp/home', {
      PATH: [pluginDir, toolDir, otherPlugins, missing].join(path.delimiter),
      KEEP: 'yes'
    })
    expect(env.HOME).toBe('/tmp/home')
    expect(env.KEEP).toBe('yes')
    expect(env.PATH).toBe([toolDir, missing].join(path.delimiter))
  })

  test('the refresh never runs rpk with a PATH that holds the caller\'s plugins', () => {
    process.env.PATH = [pluginDir, toolDir].join(path.delimiter)
    const rpkEnvs = []
    spawnSync.mockImplementation((cmd, args, opts) => {
      if (cmd === '/bin/rpk') rpkEnvs.push(opts.env)
      if (args[0] === '--print-tree') return { status: 0, stdout: JSON.stringify(connectTree), stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    })
    fetchPluginSubtree({ plugin: 'connect', pluginVersion: '4.1.0', rpkBinPath: '/bin/rpk' })
    expect(rpkEnvs.length).toBeGreaterThan(1)
    for (const env of rpkEnvs) {
      expect(env.PATH.split(path.delimiter)).toEqual([toolDir])
    }
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
