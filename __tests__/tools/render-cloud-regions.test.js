const renderCloudRegions = require('../../tools/cloud-regions/render-cloud-regions');

const sampleProviders = [
  {
    name: 'GCP',
    regions: [
      {
        name: 'us-central1',
        zones: 'a,b,c',
        tiers: ['Standard: BYOC, Dedicated', 'Premium: BYOC']
      },
      {
        name: 'europe-west1',
        zones: 'a,b',
        tiers: ['Standard: BYOC']
      }
    ]
  },
  {
    name: 'AWS',
    regions: [
      {
        name: 'us-east-1',
        zones: 'a,b,c',
        tiers: ['Standard: Dedicated']
      }
    ]
  }
];

describe('renderCloudRegions', () => {
  it('renders Markdown output with timestamp and bullet points', () => {
    const out = renderCloudRegions({ providers: sampleProviders, format: 'md', lastUpdated: '2024-06-01T12:00:00Z' });
    expect(out).toContain('<details>');
    expect(out).toContain('<h3>GCP</h3>');
    expect(out).toContain('us-central1');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>Standard: BYOC, Dedicated</li>');
  });

  it('renders AsciiDoc output with timestamp and bullet points', () => {
    const out = renderCloudRegions({ providers: sampleProviders, format: 'adoc', lastUpdated: '2024-06-01T12:00:00Z' });
    expect(out).toContain('=== GCP');
    expect(out).toContain('|us-central1');
    expect(out).toContain('* Standard: BYOC, Dedicated');
  });

  it('throws for empty providers', () => {
    expect(() => renderCloudRegions({ providers: [], format: 'md' })).toThrow();
  });
});
