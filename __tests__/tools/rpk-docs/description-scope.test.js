'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { generateRpkDocs } = require('../../../tools/rpk-docs/generate-rpk-docs.js')

describe('descriptionScope', () => {
  const tree = {
    name: 'rpk',
    description: 'Root command',
    commands: [{ name: 'topic', description: 'Topic command.', usage: 'rpk topic [flags]', flags: [] }],
    global_flags: []
  }

  async function render (descriptionScope) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-scope-'))
    const overrides = { commands: { 'rpk topic': { description: 'Scoped description.', descriptionScope } } }
    await generateRpkDocs({ tree, overrides, outputDir: tmp, rpkVersion: 'test', pluginVersions: {} })
    const page = fs.readFileSync(path.join(tmp, 'rpk-topic.adoc'), 'utf8')
    fs.rmSync(tmp, { recursive: true, force: true })
    return page
  }

  test('wraps a cloud-scoped description in the cloud conditional', async () => {
    // The schema's value for cloud-only descriptions is "cloud".
    expect(await render('cloud')).toMatch(/ifdef::env-cloud\[\]\nScoped description\.\nendif::\[\]/)
  })

  test('wraps a self-hosted description in the not-cloud conditional', async () => {
    expect(await render('self-hosted')).toMatch(/ifndef::env-cloud\[\]\nScoped description\.\nendif::\[\]/)
  })

  test('leaves a description scoped to both unconditional', async () => {
    const page = await render('both')
    expect(page).toContain('Scoped description.')
    expect(page).not.toMatch(/if(n)?def::env-cloud\[\]\nScoped description/)
  })
})
