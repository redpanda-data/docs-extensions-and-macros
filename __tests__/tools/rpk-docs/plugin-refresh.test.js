'use strict'

const {
  splicePluginNode,
  preserveLinuxOnlyCommands,
  pluginNodeHasRealCommands,
  addSingleCommandPluginFlags,
  managedPluginRelPath,
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

    test('true for a single-command plugin with flags from the plugin', () => {
      const node = {
        name: 'check',
        flags: [{ name: 'all', type: 'bool', from_plugin: true }],
        commands: [{ name: 'install' }, { name: 'uninstall' }, { name: 'upgrade' }]
      }
      expect(pluginNodeHasRealCommands(node)).toBe(true)
    })
  })

  describe('addSingleCommandPluginFlags', () => {
    // Trimmed from redpanda-check 0.2.0's own --help
    const checkHelp = [
      'Validates a Redpanda deployment against production readiness standards.',
      '',
      'Usage:',
      '  redpanda-check [flags]',
      '',
      'Flags:',
      '      --admin-url strings       Admin API addresses (comma-separated)',
      '  -a, --all                     Show all checks including passing and skipped',
      '      --format string           Output format: text, json (default "text")',
      '  -h, --help                    help for redpanda-check',
      '      --version                 Print version and exit',
      ''
    ].join('\n')

    const shimRoot = () => ({
      name: 'check',
      flags: [{ name: 'version', type: 'bool', description: 'Print the installed redpanda-check plugin version' }],
      commands: [{ name: 'install' }, { name: 'uninstall' }, { name: 'upgrade' }]
    })

    test('adds plugin flags, marked from_plugin, sorted with the shim flags', () => {
      const node = shimRoot()
      expect(addSingleCommandPluginFlags(node, checkHelp)).toBe(3)
      expect(node.flags.map(f => f.name)).toEqual(['admin-url', 'all', 'format', 'version'])
      const all = node.flags.find(f => f.name === 'all')
      expect(all).toMatchObject({ shorthand: 'a', type: 'bool', from_plugin: true })
      expect(node.flags.find(f => f.name === 'format').default).toBe('"text"')
      expect(pluginNodeHasRealCommands(node)).toBe(true)
    })

    test('keeps the shim flag on a name clash', () => {
      const node = shimRoot()
      addSingleCommandPluginFlags(node, checkHelp)
      const version = node.flags.find(f => f.name === 'version')
      expect(version.description).toBe('Print the installed redpanda-check plugin version')
      expect(version.from_plugin).toBeUndefined()
    })

    test('adds nothing when the help is missing', () => {
      const node = shimRoot()
      expect(addSingleCommandPluginFlags(node, null)).toBe(0)
      expect(node.flags.map(f => f.name)).toEqual(['version'])
      expect(pluginNodeHasRealCommands(node)).toBe(false)
    })
  })

  test('managedPluginRelPath matches where rpk installs managed plugins', () => {
    expect(managedPluginRelPath('check')).toBe('.local/bin/.rpk.managed-check')
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

describe('detectProtectedPlugins', () => {
  const { detectProtectedPlugins } = require('../../../tools/rpk-docs/generate-rpk-docs.js')
  const shim = ['install', 'uninstall', 'upgrade'].map(n => ({ path: `rpk check ${n}`, command: { name: n } }))

  test('protects a shim-only plugin', () => {
    const commands = [{ path: 'rpk check', command: { name: 'check', flags: [{ name: 'version' }] } }, ...shim]
    expect(detectProtectedPlugins(commands)).toContain('check')
  })

  test('does not protect a single-command plugin whose root has plugin flags', () => {
    const commands = [
      { path: 'rpk check', command: { name: 'check', flags: [{ name: 'all', from_plugin: true }, { name: 'version' }] } },
      ...shim
    ]
    expect(detectProtectedPlugins(commands)).not.toContain('check')
  })
})
