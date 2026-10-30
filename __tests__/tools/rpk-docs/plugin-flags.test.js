'use strict'

const { parseCobraFlags, enrichPluginTreeWithFlags } = require('../../../tools/rpk-docs/rpk-docs-handler.js')

describe('parseCobraFlags', () => {
  const HELP = [
    'Reconcile LLM providers from one or more YAML manifests.',
    '',
    'Usage:',
    '  rpk ai llm-provider apply [flags]',
    '',
    'Flags:',
    '      --allow-empty            Allow applying zero manifests',
    '  -f, --file strings           Manifest paths, - for stdin (default [])',
    '  -h, --help                   help for apply',
    '      --timeout duration       How long to wait for the reconcile to',
    '                               complete before giving up (default 30s)',
    '  -o, --format string          Output format (default "text")',
    '',
    'Global Flags:',
    '  -c, --config string   rpk config file',
    '  -v, --verbose         enable verbose logging',
    '',
    'Use "rpk ai llm-provider apply [command] --help" for more information.'
  ].join('\n')

  test('parses local flags with shorthand, type, and default', () => {
    const flags = parseCobraFlags(HELP)
    const byName = Object.fromEntries(flags.map(f => [f.name, f]))

    expect(byName['allow-empty']).toMatchObject({ type: 'bool' })
    expect(byName['file']).toMatchObject({ shorthand: 'f', type: 'strings', default: '[]' })
    expect(byName['format']).toMatchObject({ shorthand: 'o', type: 'string', default: '"text"' })
  })

  test('joins wrapped descriptions and extracts trailing defaults', () => {
    const flags = parseCobraFlags(HELP)
    const timeout = flags.find(f => f.name === 'timeout')
    expect(timeout.description).toBe('How long to wait for the reconcile to complete before giving up')
    expect(timeout.default).toBe('30s')
  })

  test('skips --help and the Global Flags section', () => {
    const flags = parseCobraFlags(HELP)
    expect(flags.map(f => f.name)).not.toContain('help')
    expect(flags.map(f => f.name)).not.toContain('config')
    expect(flags.map(f => f.name)).not.toContain('verbose')
  })

  test('returns empty for help without a Flags section', () => {
    expect(parseCobraFlags('Usage:\n  rpk ai\n\nUse "rpk ai --help".')).toEqual([])
    expect(parseCobraFlags('')).toEqual([])
  })
})

describe('enrichPluginTreeWithFlags', () => {
  test('fills flagless commands and leaves shim flags alone', () => {
    const node = {
      name: 'ai',
      commands: [
        { name: 'install', flags: [{ name: 'ai-version', type: 'string' }], commands: [] },
        { name: 'auth', commands: [{ name: 'login', commands: [] }] }
      ]
    }
    const calls = []
    const enriched = enrichPluginTreeWithFlags(node, (argPath) => {
      calls.push(argPath.join(' '))
      return 'Flags:\n      --no-browser   Print the URL instead of opening it\n'
    })

    // install already has flags: not queried
    expect(calls).not.toContain('ai install')
    expect(calls).toContain('ai auth login')
    const login = node.commands[1].commands[0]
    expect(login.flags).toHaveLength(1)
    expect(login.flags[0]).toMatchObject({ name: 'no-browser', type: 'bool' })
    expect(node.commands[0].flags[0].name).toBe('ai-version')
    expect(enriched).toBeGreaterThanOrEqual(2) // root + auth + login minus empties
  })

  test('help failures are non-fatal', () => {
    const node = { name: 'ai', commands: [{ name: 'run', commands: [] }] }
    const enriched = enrichPluginTreeWithFlags(node, () => null)
    expect(enriched).toBe(0)
    expect(node.commands[0].flags).toBeUndefined()
  })
})

describe('fillPluginFlags', () => {
  const { fillPluginFlags, pluginTreeHasFlags } = require('../../../tools/rpk-docs/rpk-docs-handler.js')

  const node = (subFlags) => ({
    name: 'ai',
    flags: [],
    commands: [
      { name: 'install', flags: [{ name: 'ai-version', type: 'string' }], commands: [] },
      { name: 'agent', flags: [], commands: [{ name: 'create', flags: subFlags, commands: [] }] }
    ]
  })

  test('uses the tree and runs no --help when plugin commands already have flags', () => {
    const calls = []
    const n = node([{ name: 'name', type: 'string', default: '', required: true, from_plugin: true }])
    const result = fillPluginFlags(n, (argPath) => { calls.push(argPath); return null })
    expect(result).toEqual({ source: 'tree', enriched: 0 })
    expect(calls).toEqual([])
  })

  test('uses plugin flags on the root of a plugin with no subcommands', () => {
    // rpk check: one command, with rpk's own --version beside the plugin's flags
    const n = { name: 'check', flags: [{ name: 'version', type: 'bool' }, { name: 'all', type: 'bool', from_plugin: true }], commands: [] }
    expect(fillPluginFlags(n, () => { throw new Error('no --help expected') })).toEqual({ source: 'tree', enriched: 0 })
  })

  test('does not take rpk flags on the root or the shim for plugin flags', () => {
    const n = { name: 'check', flags: [{ name: 'version', type: 'bool' }], commands: [] }
    expect(pluginTreeHasFlags(n)).toBe(false)
  })

  test('ignores the install shim when deciding, and falls back to --help', () => {
    const n = node([])
    expect(pluginTreeHasFlags(n)).toBe(false)
    const help = 'Flags:\n      --name string   agent name\n'
    const result = fillPluginFlags(n, (argPath) => argPath.join(' ') === 'ai agent create' ? help : null)
    expect(result).toEqual({ source: 'help', enriched: 1 })
    expect(n.commands[1].commands[0].flags.map(f => f.name)).toEqual(['name'])
  })

  test('reports none when neither source has flags', () => {
    expect(fillPluginFlags(node([]), () => null)).toEqual({ source: 'none', enriched: 0 })
  })
})

describe('mergeVisibleDeprecationsIntoOverrides', () => {
  const fs = require('fs')
  const path = require('path')
  const os = require('os')
  const { mergeVisibleDeprecationsIntoOverrides } = require('../../../tools/rpk-docs/rpk-docs-handler.js')

  const tree = {
    name: 'rpk',
    commands: [
      { name: 'oldcmd', commands: [] },
      { name: 'topic', commands: [] }
    ]
  }

  let dir, overridesPath
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-merge-'))
    overridesPath = path.join(dir, 'overrides.json')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('annotates visible deprecated commands, skips hidden ones', () => {
    fs.writeFileSync(overridesPath, JSON.stringify({ commands: {} }))
    mergeVisibleDeprecationsIntoOverrides({
      'rpk oldcmd': { deprecated: true, deprecatedMessage: 'use rpk newcmd', replacement: 'See `rpk newcmd`.' },
      'rpk hiddencmd': { deprecated: true, _note: 'Hidden: true' }
    }, tree, overridesPath)

    const result = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
    expect(result.commands['rpk oldcmd']).toMatchObject({
      deprecated: true,
      deprecatedMessage: 'use rpk newcmd',
      replacement: 'See `rpk newcmd`.'
    })
    // hiddencmd is not in the tree: no page to annotate
    expect(result.commands['rpk hiddencmd']).toBeUndefined()
  })

  test('never overwrites curated deprecation overrides', () => {
    fs.writeFileSync(overridesPath, JSON.stringify({
      commands: { 'rpk oldcmd': { deprecated: false, deprecatedMessage: 'curated text' } }
    }))
    mergeVisibleDeprecationsIntoOverrides({
      'rpk oldcmd': { deprecated: true, deprecatedMessage: 'scanner text' }
    }, tree, overridesPath)

    const result = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
    expect(result.commands['rpk oldcmd'].deprecated).toBe(false)
    expect(result.commands['rpk oldcmd'].deprecatedMessage).toBe('curated text')
  })

  test('no-op when nothing to annotate', () => {
    fs.writeFileSync(overridesPath, JSON.stringify({ commands: {} }))
    const before = fs.readFileSync(overridesPath, 'utf8')
    mergeVisibleDeprecationsIntoOverrides({}, tree, overridesPath)
    expect(fs.readFileSync(overridesPath, 'utf8')).toBe(before)
  })
})

describe('parseUrfaveFlags (Redpanda Connect help format)', () => {
  const { parseUrfaveFlags, parseHelpFlags } = require('../../../tools/rpk-docs/rpk-docs-handler.js')

  const HELP = [
    'NAME:',
    '   redpanda-connect run - Run',
    '',
    'OPTIONS:',
    '   --log.level value                     override the log level',
    '   --set value, -s value [ --set value, -s value ]   set a field',
    '   --chilled                             continue on lint errors (default: false)',
    '   --watcher, -w                         watch config files (default: false)',
    '',
    'GLOBAL OPTIONS:',
    '   --verbose   noisy'
  ].join('\n')

  test('parses names, shorthands, types, and defaults', () => {
    const flags = parseUrfaveFlags(HELP)
    const byName = Object.fromEntries(flags.map(f => [f.name, f]))
    expect(byName['log.level']).toMatchObject({ type: 'string' })
    expect(byName['set']).toMatchObject({ shorthand: 's', type: 'strings' })
    expect(byName['chilled']).toMatchObject({ type: 'bool', default: 'false' })
    expect(byName['watcher']).toMatchObject({ shorthand: 'w', type: 'bool' })
    expect(flags.map(f => f.name)).not.toContain('verbose')
  })

  test('parseHelpFlags dispatches by section header', () => {
    expect(parseHelpFlags(HELP).length).toBe(4)
    expect(parseHelpFlags('Flags:\n      --no-browser   print URL\n').length).toBe(1)
    expect(parseHelpFlags('Usage: nothing here')).toEqual([])
  })
})

describe('usage arguments from --help', () => {
  const { parseCobraUsageArgs, fillUsageArgsFromHelp, fillPluginFlags } = require('../../../tools/rpk-docs/rpk-docs-handler.js')
  const help = (line) => `Get an agent\n\nUsage:\n  ${line}\n\nFlags:\n  -h, --help   help for get\n`

  test('reads the arguments after the command path, whatever the binary name', () => {
    expect(parseCobraUsageArgs(help('rpai agent get <name> [flags]'), ['ai', 'agent', 'get'])).toBe('<name>')
    expect(parseCobraUsageArgs(help('rpk ai agent transcript get <agent> <conversation-id> [flags]'), ['ai', 'agent', 'transcript', 'get']))
      .toBe('<agent> <conversation-id>')
  })

  test('returns null without arguments, without a match, for groups, and for urfave help', () => {
    expect(parseCobraUsageArgs(help('rpai trace get [flags]'), ['ai', 'trace', 'get'])).toBeNull()
    expect(parseCobraUsageArgs(help('rpai agent get <name> [flags]'), ['ai', 'model', 'get'])).toBeNull()
    expect(parseCobraUsageArgs('Usage:\n  rpai agent [command]\n', ['ai', 'agent'])).toBeNull()
    expect(parseCobraUsageArgs(help('rpai <x>'), ['ai'])).toBeNull()
    expect(parseCobraUsageArgs('USAGE:\n   rpk connect lint [command options] [arguments...]\n', ['connect', 'lint'])).toBeNull()
    expect(parseCobraUsageArgs('', ['ai', 'agent'])).toBeNull()
  })

  test('adds the arguments to a usage that has none, keeping [flags]', () => {
    const cmd = { name: 'get', usage: 'rpk ai agent get [flags]' }
    expect(fillUsageArgsFromHelp(cmd, ['ai', 'agent', 'get'], help('rpai agent get <name> [flags]'))).toBe(true)
    expect(cmd.usage).toBe('rpk ai agent get <name> [flags]')

    const bare = { name: 'get', usage: 'rpk ai agent get' }
    fillUsageArgsFromHelp(bare, ['ai', 'agent', 'get'], help('rpai agent get <name> [flags]'))
    expect(bare.usage).toBe('rpk ai agent get <name>')
  })

  test('keeps a usage that already has arguments, and one --help cannot improve', () => {
    const fromTree = { name: 'get', usage: 'rpk ai agent get <name> [flags]' }
    expect(fillUsageArgsFromHelp(fromTree, ['ai', 'agent', 'get'], help('rpai agent get <other> [flags]'))).toBe(false)
    expect(fromTree.usage).toBe('rpk ai agent get <name> [flags]')

    const noArgs = { name: 'get', usage: 'rpk ai trace get [flags]' }
    expect(fillUsageArgsFromHelp(noArgs, ['ai', 'trace', 'get'], help('rpai trace get [flags]'))).toBe(false)
    expect(noArgs.usage).toBe('rpk ai trace get [flags]')
  })

  test('a tree without plugin flags takes usage arguments from --help', () => {
    const node = {
      name: 'ai',
      usage: 'rpk ai [flags]',
      commands: [{ name: 'agent', usage: 'rpk ai agent', commands: [{ name: 'get', usage: 'rpk ai agent get [flags]', commands: [] }] }]
    }
    const helps = {
      'ai': 'Usage:\n  rpk ai [flags]\n  rpk ai [command]\n',
      'ai agent': 'Usage:\n  rpai agent [command]\n',
      'ai agent get': help('rpai agent get <name> [flags]')
    }
    fillPluginFlags(node, (argPath) => helps[argPath.join(' ')] || null)
    expect(node.usage).toBe('rpk ai [flags]')
    expect(node.commands[0].usage).toBe('rpk ai agent')
    expect(node.commands[0].commands[0].usage).toBe('rpk ai agent get <name> [flags]')
  })

  test('a tree with plugin flags keeps its own usage and runs no --help', () => {
    const node = {
      name: 'ai',
      commands: [{
        name: 'get',
        usage: 'rpk ai get <name> [flags]',
        flags: [{ name: 'format', type: 'string', from_plugin: true }],
        commands: []
      }]
    }
    const calls = []
    expect(fillPluginFlags(node, (p) => { calls.push(p); return null }).source).toBe('tree')
    expect(calls).toEqual([])
    expect(node.commands[0].usage).toBe('rpk ai get <name> [flags]')
  })
})
