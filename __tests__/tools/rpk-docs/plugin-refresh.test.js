'use strict'

const {
  splicePluginNode,
  preserveLinuxOnlyCommands,
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

    test('keeps the tree linux_only_commands list through a splice', () => {
      const treeWithMarkers = { ...baseTree, linux_only_commands: ['rpk debug bundle', 'rpk iotune'] }
      const result = splicePluginNode(treeWithMarkers, 'connect', installedNode)
      expect(result.linux_only_commands).toEqual(['rpk debug bundle', 'rpk iotune'])
    })
  })

  describe('preserveLinuxOnlyCommands', () => {
    const linuxOnly = ['rpk debug bundle', 'rpk iotune']

    test('inherits the snapshot list when the working tree lacks it', () => {
      const result = preserveLinuxOnlyCommands(baseTree, { ...baseTree, linux_only_commands: linuxOnly })
      expect(result.linux_only_commands).toEqual(linuxOnly)
      // Copies, not aliases: mutating the result must not touch the snapshot
      expect(result.linux_only_commands).not.toBe(linuxOnly)
      expect(result.commands).toBe(baseTree.commands)
    })

    test('keeps the working tree list when it already has one', () => {
      const tree = { ...baseTree, linux_only_commands: linuxOnly }
      const result = preserveLinuxOnlyCommands(tree, { ...baseTree, linux_only_commands: ['rpk other'] })
      expect(result).toBe(tree)
      expect(result.linux_only_commands).toEqual(linuxOnly)
    })

    test('is a no-op when neither tree carries the list', () => {
      expect(preserveLinuxOnlyCommands(baseTree, baseTree)).toBe(baseTree)
      expect(preserveLinuxOnlyCommands(baseTree, undefined)).toBe(baseTree)
      expect(preserveLinuxOnlyCommands(null, baseTree)).toBe(null)
    })

    test('refresh persistence chain keeps markers for the saved snapshot', () => {
      // Mirrors the --plugin save path: derive the working tree from the
      // snapshot, splice the fresh subtree, then preserve before persisting.
      const snapshot = {
        raw_tree: { ...baseTree, linux_only_commands: linuxOnly },
        tree: { ...baseTree, linux_only_commands: linuxOnly }
      }
      let tree = snapshot.raw_tree || snapshot.tree
      tree = preserveLinuxOnlyCommands(tree, snapshot.tree || snapshot.raw_tree)
      tree = splicePluginNode(tree, 'connect', installedNode)
      tree = preserveLinuxOnlyCommands(tree, snapshot.raw_tree || snapshot.tree)
      expect(tree.linux_only_commands).toEqual(linuxOnly)
    })

    test('refresh persistence chain restores markers when only the enhanced tree has them', () => {
      // Older snapshots may carry the field on only one stored tree; the
      // derivation step must inherit it so the re-saved snapshot keeps it.
      const snapshot = {
        raw_tree: { ...baseTree },
        tree: { ...baseTree, linux_only_commands: linuxOnly }
      }
      let tree = snapshot.raw_tree || snapshot.tree
      tree = preserveLinuxOnlyCommands(tree, snapshot.tree || snapshot.raw_tree)
      expect(tree.linux_only_commands).toEqual(linuxOnly)
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
