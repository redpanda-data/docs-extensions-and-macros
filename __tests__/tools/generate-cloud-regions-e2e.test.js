'use strict'

// The cluster-type filter is threaded through three hops: buildCloudRegions
// resolves it, generateCloudRegions passes it on, renderCloudRegions puts it in
// the Handlebars context. Testing the hops individually leaves the middle one
// unpinned: deleting `clusterType: resolvedClusterType` from the
// renderCloudRegions call left the whole suite green while the real CLI silently
// reverted to the unfiltered wording. This drives the entrypoint instead, with
// only the network stubbed, so the pass-through itself has to survive.

jest.mock('../../cli-utils/octokit-client', () => ({
  repos: {
    getContent: jest.fn(async () => ({
      data: {
        type: 'file',
        content: Buffer.from(global.__CLOUD_REGIONS_YAML__, 'utf8').toString('base64'),
      },
    })),
  },
}))

const { generateCloudRegions } = require('../../tools/cloud-regions/generate-cloud-regions')

global.__CLOUD_REGIONS_YAML__ = `
regions:
  - name: us-east-1
    cloudProvider: CLOUD_PROVIDER_AWS
    zones: [use1-az1, use1-az2]
    redpandaProductAvailability:
      tier-1-aws:
        redpandaProductName: tier-1-aws
        clusterTypes: [CLUSTER_TYPE_BYOC]
      tier-2-aws:
        redpandaProductName: tier-2-aws
        clusterTypes: [CLUSTER_TYPE_DEDICATED]
products:
  - name: tier-1-aws
    isPublic: true
  - name: tier-2-aws
    isPublic: true
`

const args = { owner: 'o', repo: 'r', path: 'p', format: 'adoc' }

describe('generateCloudRegions threads the cluster type through to the output', () => {
  it('says only BYOC tiers are listed when filtered to BYOC', async () => {
    const out = await generateCloudRegions({ ...args, clusterType: 'BYOC' })
    expect(out).toMatch(/only the tiers available for BYOC clusters/)
    // and the unfiltered sentence must be gone, or the filter did not reach the template
    expect(out).not.toMatch(/cluster type \(BYOC, Dedicated\)/)
  })

  it('says only Dedicated tiers are listed when filtered to Dedicated', async () => {
    const out = await generateCloudRegions({ ...args, clusterType: 'Dedicated' })
    expect(out).toMatch(/only the tiers available for Dedicated clusters/)
  })

  it('keeps the unfiltered wording when no cluster type is given', async () => {
    const out = await generateCloudRegions({ ...args })
    expect(out).not.toMatch(/only the tiers available for/)
  })

  it('reaches a custom template too, so the context is not template-specific', async () => {
    const fs = require('fs')
    const os = require('os')
    const path = require('path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-tpl-'))
    const tpl = path.join(dir, 't.hbs')
    fs.writeFileSync(tpl, 'CLUSTER_TYPE={{clusterType}}')
    try {
      const out = await generateCloudRegions({ ...args, clusterType: 'byoc', template: tpl })
      expect(out.trim()).toBe('CLUSTER_TYPE=BYOC')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
