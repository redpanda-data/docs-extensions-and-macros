'use strict'

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const { buildWorkspace } = require('./fixture')
const { findComponentRoot } = require('../../language-server/workspace')

describe('buildWorkspace', () => {
  test('writes each part where the docs repository keeps it', () => {
    const root = buildWorkspace({
      component: { name: 'streaming', version: '26.2' },
      terms: { acl: '=== access control list (ACL)\n:term-name: ACL\n' },
      registry: { features: [{ name: 'Audit Logging', scope: 'redpanda' }] },
      playbook: { site: { title: 'Docs' } },
      files: { 'docs-data/property-overrides.json': { properties: {} } },
      pages: { 'modules/manage/pages/a.adoc': '= A\n' },
    })
    const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
    expect(yaml.load(read('antora.yml'))).toMatchObject({ name: 'streaming', version: '26.2' })
    expect(read('shared/modules/terms/partials/acl.adoc')).toMatch(/^=== access control list/)
    expect(yaml.load(read('shared/modules/ROOT/partials/enterprise-features.yml')).features[0].name).toBe('Audit Logging')
    expect(yaml.load(read('antora-playbook.yml')).site.title).toBe('Docs')
    expect(JSON.parse(read('docs-data/property-overrides.json'))).toEqual({ properties: {} })
    // A page under shared/ belongs to the shared component, as in the docs repo.
    expect(findComponentRoot(path.join(root, 'shared/modules/terms/partials/acl.adoc'))).toBe(path.join(root, 'shared'))
    expect(findComponentRoot(path.join(root, 'modules/manage/pages/a.adoc'))).toBe(root)
  })

  test('takes extra parts as builders, and rejects an unknown part name', () => {
    const root = buildWorkspace({ mine: 'x' }, { parts: { mine: (r, value) => fs.writeFileSync(path.join(r, 'mine.txt'), value) } })
    expect(fs.readFileSync(path.join(root, 'mine.txt'), 'utf8')).toBe('x')
    expect(() => buildWorkspace({ mine: 'x' })).toThrow(/no part named mine/)
  })
})
