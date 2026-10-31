'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

// The handler destructures spawnSync at load time, so mock it first
jest.mock('child_process')
const { spawnSync } = require('child_process')

const {
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
