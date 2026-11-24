'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  handleRpkDocsGeneration,
  resolveTargetBranch,
  mainOnlyPluginsToProtect
} = require('../../../tools/rpk-docs/rpk-docs-handler.js')

describe('mainOnlyPluginsToProtect', () => {
  test('version branches protect rpk ai', () => {
    expect(mainOnlyPluginsToProtect('beta')).toEqual(['ai'])
    expect(mainOnlyPluginsToProtect('v/26.2')).toEqual(['ai'])
    expect(mainOnlyPluginsToProtect('v-WIP/26.3')).toEqual(['ai'])
  })

  test('main, other branches, and an unknown branch protect nothing', () => {
    expect(mainOnlyPluginsToProtect('main')).toEqual([])
    expect(mainOnlyPluginsToProtect('jake/fix-rpk')).toEqual([])
    expect(mainOnlyPluginsToProtect('beta-notes')).toEqual([])
    expect(mainOnlyPluginsToProtect(null)).toEqual([])
  })

  test('a run that refreshes rpk ai itself is not blocked', () => {
    expect(mainOnlyPluginsToProtect('beta', 'ai')).toEqual([])
    expect(mainOnlyPluginsToProtect('beta', 'connect')).toEqual(['ai'])
  })
})

describe('resolveTargetBranch', () => {
  test('explicit wins, then GITHUB_BASE_REF', () => {
    expect(resolveTargetBranch('/nonexistent', 'v/26.1', { GITHUB_BASE_REF: 'beta' })).toBe('v/26.1')
    expect(resolveTargetBranch('/nonexistent', undefined, { GITHUB_BASE_REF: 'beta' })).toBe('beta')
  })
})

describe('full regeneration on a version branch', () => {
  let repo
  let cwd

  const snapshot = {
    rpk_version: 'v9.9.9',
    plugin_versions: { ai: '1.0.0' },
    tree: null,
    raw_tree: {
      name: 'rpk',
      description: 'rpk',
      usage: 'rpk [command]',
      commands: [
        {
          name: 'ai',
          description: 'AI commands',
          usage: 'rpk ai [command]',
          flags: [],
          commands: [{ name: 'agent', description: 'Manage agents', usage: 'rpk ai agent [flags]', flags: [], commands: [] }]
        },
        { name: 'topic', description: 'Manage topics', usage: 'rpk topic [command]', flags: [], commands: [] }
      ]
    }
  }

  const aiPartial = () => path.join(repo, 'modules', 'reference', 'partials', 'rpk-ai', 'rpk-ai-agent.adoc')
  const topicPage = () => path.join(repo, 'modules', 'reference', 'pages', 'rpk', 'rpk-topic.adoc')

  const setup = (branch) => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-main-only-'))
    spawnSync('git', ['init', '-q', '-b', branch], { cwd: repo })
    fs.mkdirSync(path.join(repo, 'docs-data'))
    fs.mkdirSync(path.dirname(aiPartial()), { recursive: true })
    fs.mkdirSync(path.dirname(topicPage()), { recursive: true })
    fs.writeFileSync(aiPartial(), 'main-owned content\n')
    fs.writeFileSync(path.join(repo, 'docs-data', 'rpk-v9.9.9.json'), JSON.stringify(snapshot))
    fs.writeFileSync(path.join(repo, 'docs-data', 'rpk-overrides.json'), JSON.stringify({ commands: { 'rpk ai': { asPartial: true } } }))
    process.chdir(repo)
  }

  const run = () => handleRpkDocsGeneration({
    fromJson: path.join(repo, 'docs-data', 'rpk-v9.9.9.json'),
    outputDir: path.join(repo, 'modules', 'reference', 'pages', 'rpk')
  })

  beforeEach(() => {
    cwd = process.cwd()
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    delete process.env.GITHUB_BASE_REF
  })

  afterEach(() => {
    process.chdir(cwd)
    fs.rmSync(repo, { recursive: true, force: true })
    jest.restoreAllMocks()
  })

  test('on beta, rpk ai partials are left untouched and core pages render', async () => {
    setup('beta')
    await run()
    expect(fs.readFileSync(aiPartial(), 'utf8')).toBe('main-owned content\n')
    expect(fs.existsSync(topicPage())).toBe(true)
  })

  test('on main, rpk ai partials are regenerated', async () => {
    setup('main')
    await run()
    expect(fs.readFileSync(aiPartial(), 'utf8')).not.toBe('main-owned content\n')
    expect(fs.readFileSync(aiPartial(), 'utf8')).toContain('Manage agents')
  })
})
