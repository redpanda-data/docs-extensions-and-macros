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
