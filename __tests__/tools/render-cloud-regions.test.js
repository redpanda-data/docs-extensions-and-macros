const fs = require('fs');
const os = require('os');
const path = require('path');
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

  // The renderer takes the template path as already contained: the CLI resolves
  // and checks it (see __tests__/tools/cloud-regions-cli.test.js), so an absolute
  // path is legitimate input here.
  it('renders a custom template when one is provided', () => {
    const templateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-regions-')), 'custom.hbs');
    fs.writeFileSync(templateFile, '{{#each providers}}PROVIDER:{{name}} {{#each regions}}[{{name}}]{{/each}}\n{{/each}}', 'utf8');
    try {
      const out = renderCloudRegions({ providers: sampleProviders, format: 'adoc', template: templateFile });
      expect(out).toContain('PROVIDER:GCP [europe-west1][us-central1]');
      expect(out).toContain('PROVIDER:AWS [us-east-1]');
      expect(out).not.toContain('=== GCP');
    } finally {
      fs.rmSync(path.dirname(templateFile), { recursive: true, force: true });
    }
  });

  it('falls back to the bundled template when no custom template is provided', () => {
    const out = renderCloudRegions({ providers: sampleProviders, format: 'adoc' });
    expect(out).toContain('=== GCP');
  });

  it('reports a syntax error in a custom template as a compile failure', () => {
    const templateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-regions-')), 'broken.hbs');
    fs.writeFileSync(templateFile, '{{#each providers}}{{name}}', 'utf8');
    try {
      expect(() => renderCloudRegions({ providers: sampleProviders, format: 'adoc', template: templateFile }))
        .toThrow(/Failed to compile Handlebars template/);
    } finally {
      fs.rmSync(path.dirname(templateFile), { recursive: true, force: true });
    }
  });

  it('exposes the cluster type filter to a custom template', () => {
    const templateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-regions-')), 'custom.hbs');
    fs.writeFileSync(templateFile, '== {{clusterType}} regions\n{{#each providers}}{{displayName}}\n{{/each}}', 'utf8');
    try {
      const out = renderCloudRegions({
        providers: [{ name: 'GCP', displayName: 'Google Cloud Platform (GCP)', regions: sampleProviders[0].regions }],
        format: 'adoc',
        template: templateFile,
        clusterType: 'BYOC'
      });
      expect(out).toContain('== BYOC regions');
      expect(out).toContain('Google Cloud Platform (GCP)');
    } finally {
      fs.rmSync(path.dirname(templateFile), { recursive: true, force: true });
    }
  });

  describe.each(['adoc', 'md'])('bundled %s intro', (format) => {
    it('names the cluster type when the data was filtered', () => {
      const out = renderCloudRegions({ providers: sampleProviders, format, clusterType: 'BYOC' });
      expect(out).toContain('This table lists only the tiers available for BYOC clusters.');
      expect(out).not.toContain('and the cluster type (BYOC, Dedicated)');
    });

    it('keeps the unfiltered wording when the data was not filtered', () => {
      const out = renderCloudRegions({ providers: sampleProviders, format });
      expect(out).toContain('Availability depends on the region and the cluster type (BYOC, Dedicated).');
      expect(out).not.toContain('This table lists only');
    });
  });
});
