'use strict'

const {
  splicePluginNode,
  pluginNodeHasRealCommands,
  REFRESHABLE_PLUGINS,
  PLUGIN_INSTALL_VERSION_FLAGS,
  PLUGIN_MANIFEST_SLUGS
} = require('../../../tools/rpk-docs/rpk-docs-handler.js')

describe('Plugin refresh (--plugin mode)', () => {
  const shimOnlyNode = {
    name: 'k8s',
    description: 'Kubernetes plugin',
    commands: [
      { name: 'install' },
      { name: 'uninstall' },
      { name: 'upgrade' }
    ]
  }

  const installedNode = {
    name: 'connect',
    description: 'Redpanda Connect plugin',
    commands: [
      { name: 'install' },
      { name: 'uninstall' },
      { name: 'upgrade' },
      { name: 'run', description: 'Run a pipeline' },
      { name: 'lint', description: 'Lint a config' }
    ]
  }

  const baseTree = {
    name: 'rpk',
    global_flags: [{ name: '--config' }],
    commands: [
      { name: 'topic', commands: [{ name: 'create' }] },
      { name: 'connect', commands: [{ name: 'install' }, { name: 'run', description: 'old run' }] },
      { name: 'cluster', commands: [{ name: 'health' }] }
    ]
  }

  describe('pluginNodeHasRealCommands', () => {
    test('false for a shim-only node (install/uninstall/upgrade)', () => {
      expect(pluginNodeHasRealCommands(shimOnlyNode)).toBe(false)
    })

    test('true when real plugin commands are present', () => {
      expect(pluginNodeHasRealCommands(installedNode)).toBe(true)
    })

    test('false for a node with no subcommands', () => {
      expect(pluginNodeHasRealCommands({ name: 'ai' })).toBe(false)
    })
  })

  describe('splicePluginNode', () => {
    test('replaces the plugin node and keeps everything else', () => {
      const result = splicePluginNode(baseTree, 'connect', installedNode)

      expect(result.commands.map(c => c.name)).toEqual(['topic', 'connect', 'cluster'])
      const connect = result.commands.find(c => c.name === 'connect')
      expect(connect.commands.map(c => c.name)).toContain('lint')
      expect(result.commands.find(c => c.name === 'topic')).toBe(baseTree.commands[0])
      expect(result.global_flags).toEqual(baseTree.global_flags)
    })

    test('does not mutate the input tree', () => {
      splicePluginNode(baseTree, 'connect', installedNode)
      const connect = baseTree.commands.find(c => c.name === 'connect')
      expect(connect.commands.find(c => c.name === 'run').description).toBe('old run')
    })

    test('throws when the plugin is not in the base tree', () => {
      expect(() => splicePluginNode(baseTree, 'k8s', shimOnlyNode))
        .toThrow(/not present in the base tree/)
    })
  })

  describe('plugin constants', () => {
    test('every refreshable plugin has a version pin flag', () => {
      for (const plugin of REFRESHABLE_PLUGINS) {
        expect(PLUGIN_INSTALL_VERSION_FLAGS[plugin]).toMatch(/^--[a-z-]+$/)
      }
    })

    test('oxla is not refreshable (stub with no installable binary)', () => {
      expect(REFRESHABLE_PLUGINS).not.toContain('oxla')
    })

    test('ai maps to the rpai manifest slug', () => {
      expect(PLUGIN_MANIFEST_SLUGS.ai).toBe('rpai')
    })
  })
})
