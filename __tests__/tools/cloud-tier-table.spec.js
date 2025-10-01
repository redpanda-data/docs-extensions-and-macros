const path = require('path');
const fs = require('fs');
const { generateCloudTierTable } = require('../../tools/cloud-tier-table/generate-cloud-tier-table.js');

describe('generateCloudTierTable', () => {
  it('should generate a markdown table from mock YAML using public tiers', async () => {
    const input = path.resolve(__dirname, '../docs-data/mock-tier.yml');
    const masterDataPath = path.resolve(__dirname, '../docs-data/mock-master-data.yaml');
    const result = await generateCloudTierTable({
      input,
      output: '',
      format: 'md',
      template: undefined,
      masterDataPath
    });
    expect(result).toContain('| Tier | Cloud Provider | Machine Type | Number of Nodes');
    expect(result).toContain('Basic Tier');
    expect(result).toContain('Advanced Tier');
    expect(result).not.toContain('Internal Tier'); // Should not include non-public tiers
  });

  it('should only include public tiers from master-data', async () => {
    const input = path.resolve(__dirname, '../docs-data/mock-tier.yml');
    const masterDataPath = path.resolve(__dirname, '../docs-data/mock-master-data.yaml');
    const result = await generateCloudTierTable({
      input,
      output: '',
      format: 'md',
      template: undefined,
      masterDataPath
    });
    expect(result).toContain('Basic Tier');
    expect(result).toContain('Advanced Tier');
    expect(result).not.toContain('Internal Tier'); // isPublic: false should be excluded
  });

  it('should use display names from master-data instead of config profile names', async () => {
    const input = path.resolve(__dirname, '../docs-data/mock-tier.yml');
    const masterDataPath = path.resolve(__dirname, '../docs-data/mock-master-data.yaml');
    const result = await generateCloudTierTable({
      input,
      output: '',
      format: 'md',
      template: undefined,
      masterDataPath
    });
    expect(result).toContain('Basic Tier'); // displayName from master-data
    expect(result).toContain('Advanced Tier'); // displayName from master-data
    expect(result).not.toContain('test-tier-basic'); // config profile name should not appear
    expect(result).not.toContain('test-tier-advanced'); // config profile name should not appear
  });

  it('should include advertised limits from master-data', async () => {
    const input = path.resolve(__dirname, '../docs-data/mock-tier.yml');
    const masterDataPath = path.resolve(__dirname, '../docs-data/mock-master-data.yaml');
    const result = await generateCloudTierTable({
      input,
      output: '',
      format: 'md',
      template: undefined,
      masterDataPath
    });
    expect(result).toContain('Max Ingress (bps)');
    expect(result).toContain('Max Egress (bps)');
    expect(result).toContain('Max Partitions');
    expect(result).toContain('Max Client Connections');
    expect(result).toContain('1000000'); // Basic tier ingress
    expect(result).toContain('5000000'); // Advanced tier ingress
  });
});
