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
    expect(usEast.tiers).toEqual(['tier-1-aws: BYOC', 'tier-2-aws: BYOC']);
  });

  it('filters by cluster type Dedicated and maps FMC to Dedicated', () => {
    const providers = processCloudRegions(sampleYaml, { clusterType: 'Dedicated' });
    expect(regionNames(providers, 'AWS')).toEqual(['us-east-1', 'eu-west-3']);
    expect(regionNames(providers, 'GCP')).toEqual(['us-west1']);
    const usEast = providers.find((p) => p.name === 'AWS').regions[0];
    expect(usEast.tiers).toEqual(['tier-1-aws: Dedicated']);
  });

  it('accepts the cluster type case-insensitively', () => {
    const providers = processCloudRegions(sampleYaml, { clusterType: 'byoc' });
    expect(regionNames(providers, 'AWS')).toEqual(['us-east-1']);
  });

  it('throws on an unsupported cluster type', () => {
    expect(() => processCloudRegions(sampleYaml, { clusterType: 'Serverless' })).toThrow(/Unsupported cluster type/);
  });
});
