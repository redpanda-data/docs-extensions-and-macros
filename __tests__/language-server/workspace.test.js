'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { findComponentRoot, loadWorkspace } = require('../../language-server/workspace')
const { makeWorkspace, noFetch } = require('./workspace-fixture')

describe('findComponentRoot', () => {
  test('finds the antora.yml above a page', () => {
    const root = makeWorkspace({ pages: { 'modules/manage/pages/a.adoc': '= A\n' } })
    expect(findComponentRoot(path.join(root, 'modules/manage/pages/a.adoc'))).toBe(root)
  })

  test('returns null outside a component', () => {
    expect(findComponentRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'no-antora-')))).toBeNull()
  })
})

describe('loadWorkspace', () => {
  test('loads the property file for the component release series, with the build loader', async () => {
    const ws = await loadWorkspace(makeWorkspace(), { env: {}, fetch: noFetch })
    expect(ws.component).toMatchObject({ name: 'streaming', version: '26.2' })
    expect(ws.properties).toMatchObject({ tag: 'v26.2.4', surface: 'all' })
    expect(ws.properties.properties).toHaveProperty('log_segment_ms')
  })

  test('a release series with no property file gets none, not a neighbouring release', async () => {
    const ws = await loadWorkspace(makeWorkspace({ version: '25.3' }), { env: {}, fetch: noFetch })
    expect(ws.properties).toBeNull()
    expect(ws.notes.join('\n')).toMatch(/no property data for streaming@25.3/)
  })

  test('a Cloud component borrows the streaming file from REDPANDA_DOCS_PATH', async () => {
    const docs = makeWorkspace({ taxonomy: false })
    const cloud = makeWorkspace({ name: 'redpanda-cloud', version: null, attributes: { 'env-cloud': true }, properties: false })
    const ws = await loadWorkspace(cloud, { env: { REDPANDA_DOCS_PATH: docs }, fetch: noFetch })
    expect(ws.properties).toMatchObject({ tag: 'v26.2.4', surface: 'cloud', component: 'streaming' })
  })

  test('a Cloud component without a docs checkout has no property data', async () => {
    const cloud = makeWorkspace({ name: 'redpanda-cloud', version: null, attributes: { 'env-cloud': true }, properties: false })
    const ws = await loadWorkspace(cloud, { env: {}, fetch: noFetch })
    expect(ws.properties).toBeNull()
  })

  test('loads the taxonomy and the legacy category list from the checkout', async () => {
    const root = makeWorkspace()
    const ws = await loadWorkspace(root, { env: {}, fetch: noFetch })
    expect(ws.taxonomySource).toBe(path.join(root, 'shared/modules/ROOT/attachments/taxonomy.yml'))
    expect(ws.taxonomy.get('iceberg-topics').prefLabel).toBe('Iceberg Topics')
    expect(ws.isLegacyCategory('Troubleshooting')).toBe(true)
  })

  test('works without a taxonomy and says why', async () => {
    const ws = await loadWorkspace(makeWorkspace({ taxonomy: false }), { env: {}, fetch: noFetch })
    expect(ws.taxonomy).toBeNull()
    expect(ws.notes.join('\n')).toMatch(/taxonomy not loaded/)
  })
})
