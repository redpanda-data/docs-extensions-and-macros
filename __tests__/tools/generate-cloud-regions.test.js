const { processCloudRegions } = require('../../tools/cloud-regions/generate-cloud-regions');

const sampleYaml = `
regions:
  - name: us-east-1
    cloudProvider: CLOUD_PROVIDER_AWS
    zones: [use1-az1, use1-az2]
    redpandaProductAvailability:
      tier-1-aws:
        redpandaProductName: tier-1-aws
        clusterTypes: [CLUSTER_TYPE_BYOC, CLUSTER_TYPE_DEDICATED]
      tier-2-aws:
        redpandaProductName: tier-2-aws
        clusterTypes: [CLUSTER_TYPE_BYOC]
      tier-private-aws:
        redpandaProductName: tier-private-aws
        clusterTypes: [CLUSTER_TYPE_BYOC]
  - name: eu-west-3
    cloudProvider: CLOUD_PROVIDER_AWS
    zones: [euw3-az1]
    redpandaProductAvailability:
      tier-1-aws:
        redpandaProductName: tier-1-aws
        clusterTypes: [CLUSTER_TYPE_DEDICATED]
  - name: us-west1
    cloudProvider: CLOUD_PROVIDER_GCP
    zones: [us-west1-a]
    redpandaProductAvailability:
      tier-1-gcp:
        redpandaProductName: tier-1-gcp
        clusterTypes: [CLUSTER_TYPE_FMC]
products:
  - name: tier-1-aws
    isPublic: true
  - name: tier-2-aws
    isPublic: true
  - name: tier-1-gcp
    isPublic: true
  - name: tier-private-aws
    isPublic: false
`;

// The upstream YAML gains cluster types over time. This one carries a type that
// clusterTypeMap does not map, alongside a private tier that offers a second
// unmapped type.
const serverlessYaml = `
regions:
  - name: us-east-1
    cloudProvider: CLOUD_PROVIDER_AWS
    zones: [use1-az1]
    redpandaProductAvailability:
      tier-serverless-aws:
        redpandaProductName: tier-serverless-aws
        clusterTypes: [CLUSTER_TYPE_SERVERLESS, CLUSTER_TYPE_BYOC]
      tier-secret-aws:
        redpandaProductName: tier-secret-aws
        clusterTypes: [CLUSTER_TYPE_SECRET]
products:
  - name: tier-serverless-aws
    isPublic: true
  - name: tier-secret-aws
    isPublic: false
`;

function regionNames(providers, providerName) {
  const provider = providers.find((p) => p.name === providerName);
  return provider ? provider.regions.map((r) => r.name) : [];
}

describe('processCloudRegions', () => {
  it('includes all cluster types when no filter is given', () => {
    const providers = processCloudRegions(sampleYaml);
    expect(providers.map((p) => p.displayName)).toEqual(['Google Cloud Platform (GCP)', 'Amazon Web Services (AWS)']);
    expect(regionNames(providers, 'AWS')).toEqual(['us-east-1', 'eu-west-3']);
    expect(regionNames(providers, 'GCP')).toEqual(['us-west1']);
    const usEast = providers.find((p) => p.name === 'AWS').regions[0];
    expect(usEast.tiers).toContain('tier-1-aws: BYOC, Dedicated');
    expect(usEast.tiers.join()).not.toContain('tier-private-aws');
  });

  it('filters regions and tiers by cluster type BYOC', () => {
    const providers = processCloudRegions(sampleYaml, { clusterType: 'BYOC' });
    // eu-west-3 is Dedicated-only, so it must be dropped
    expect(regionNames(providers, 'AWS')).toEqual(['us-east-1']);
    // us-west1 is FMC-only, which maps to Dedicated
    expect(regionNames(providers, 'GCP')).toEqual([]);
    const usEast = providers.find((p) => p.name === 'AWS').regions[0];
    // The whole table is BYOC, so tiers carry no per-row cluster type suffix
    expect(usEast.tiers).toEqual(['tier-1-aws', 'tier-2-aws']);
  });

  it('filters by cluster type Dedicated and maps FMC to Dedicated', () => {
    const providers = processCloudRegions(sampleYaml, { clusterType: 'Dedicated' });
    expect(regionNames(providers, 'AWS')).toEqual(['us-east-1', 'eu-west-3']);
    expect(regionNames(providers, 'GCP')).toEqual(['us-west1']);
    const usEast = providers.find((p) => p.name === 'AWS').regions[0];
    expect(usEast.tiers).toEqual(['tier-1-aws']);
  });

  it('accepts the cluster type case-insensitively', () => {
    const providers = processCloudRegions(sampleYaml, { clusterType: 'byoc' });
    expect(regionNames(providers, 'AWS')).toEqual(['us-east-1']);
  });

  it('throws on an unsupported cluster type', () => {
    expect(() => processCloudRegions(sampleYaml, { clusterType: 'Serverless' })).toThrow(/Unsupported cluster type/);
  });

  it('keeps the per-tier cluster types when no filter is given', () => {
    const providers = processCloudRegions(sampleYaml);
    const usEast = providers.find((p) => p.name === 'AWS').regions[0];
    expect(usEast.tiers).toEqual(['tier-1-aws: BYOC, Dedicated', 'tier-2-aws: BYOC']);
  });

  it('filters on a cluster type the source data adds but this tool does not map', () => {
    const providers = processCloudRegions(serverlessYaml, { clusterType: 'CLUSTER_TYPE_SERVERLESS' });
    expect(regionNames(providers, 'AWS')).toEqual(['us-east-1']);
    const usEast = providers.find((p) => p.name === 'AWS').regions[0];
    expect(usEast.tiers).toEqual(['tier-serverless-aws']);
  });

  it('lists the cluster types the source data offers when one is unsupported', () => {
    expect(() => processCloudRegions(serverlessYaml, { clusterType: 'Nope' }))
      .toThrow('Unsupported cluster type: Nope. Use one of: BYOC, CLUSTER_TYPE_SERVERLESS, Dedicated.');
  });

  it('ignores cluster types that only private tiers offer', () => {
    expect(() => processCloudRegions(sampleYaml, { clusterType: 'Serverless' })).toThrow(/Unsupported cluster type/);
  });

  it('warns once about a cluster type it does not map', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const yaml = serverlessYaml.replace(/CLUSTER_TYPE_SERVERLESS/g, 'CLUSTER_TYPE_ONLY_HERE');
      processCloudRegions(yaml);
      processCloudRegions(yaml);
      const unmapped = warn.mock.calls.filter((call) => /CLUSTER_TYPE_ONLY_HERE/.test(call[0]));
      expect(unmapped).toHaveLength(1);
      expect(unmapped[0][0]).toMatch(/Unmapped cluster type/);
    } finally {
      warn.mockRestore();
    }
  });

  it('says the cluster type filter is why a provider has no tiers', () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      processCloudRegions(sampleYaml, { clusterType: 'BYOC' });
      expect(info.mock.calls.map((call) => call[0]).join('\n'))
        .toContain("No public tiers available for BYOC clusters found for provider 'GCP'.");
    } finally {
      info.mockRestore();
    }
  });

  it('joins zones with a comma and a space so long lists can wrap in a table cell', () => {
    const providers = processCloudRegions(sampleYaml);
    const usEast = providers.find((p) => p.name === 'AWS').regions[0];
    expect(usEast.zones).toBe('use1-az1, use1-az2');
  });

  it('sorts zones so that reordering them upstream is not a docs change', () => {
    const shuffled = sampleYaml.replace(
      'zones: [use1-az1, use1-az2]',
      'zones: [use1-az10, use1-az2, use1-az1]'
    );
    const providers = processCloudRegions(shuffled);
    const usEast = providers.find((p) => p.name === 'AWS').regions[0];
    expect(usEast.zones).toBe('use1-az1, use1-az2, use1-az10');
  });
});
