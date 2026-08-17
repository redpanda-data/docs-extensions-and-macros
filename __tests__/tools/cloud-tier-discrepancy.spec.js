const path = require('path');
const { generateDiscrepancyReport } = require('../../tools/cloud-tier-table/generate-discrepancy-report.js');

const input = path.resolve(__dirname, '../docs-data/mock-tier.yml');
const masterData = path.resolve(__dirname, '../docs-data/mock-master-data.yaml');

describe('generateDiscrepancyReport', () => {
  let warnSpy;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('reads actual config values (non-zero actuals, no missing-value warnings)', async () => {
    const report = await generateDiscrepancyReport({
      input,
      masterData,
      format: 'json'
    });
    const parsed = JSON.parse(report);

    expect(parsed.analyses).toHaveLength(2);

    // Every metric must have a real (non-zero) actual value: the analyzer
    // previously received a CSV without the actual-config columns, so every
    // actual parsed as 0 and every metric reported -100% critical.
    parsed.analyses.forEach(analysis => {
      expect(analysis.discrepancies).toHaveLength(4);
      analysis.discrepancies.forEach(disc => {
        expect(disc.actual).toBeGreaterThan(0);
        expect(disc.percentageDiff).not.toBe(-100);
      });
    });

    // No "Missing value" warnings for any analyzer column
    const missingValueWarnings = warnSpy.mock.calls
      .map(args => String(args[0]))
      .filter(msg => msg.includes('Missing value'));
    expect(missingValueWarnings).toHaveLength(0);
  });

  it('computes sane percentages from the mock fixtures', async () => {
    const report = await generateDiscrepancyReport({
      input,
      masterData,
      format: 'json'
    });
    const parsed = JSON.parse(report);

    // Advanced Tier: advertised ingress/egress match the config exactly
    const advanced = parsed.analyses.find(a => a.tierName === 'Advanced Tier');
    expect(advanced).toBeDefined();

    const ingress = advanced.discrepancies.find(d => d.metric === 'Ingress Throughput');
    expect(ingress.advertised).toBe(5000000);
    expect(ingress.actual).toBe(5000000);
    expect(ingress.percentageDiff).toBe(0);
    expect(ingress.severity).toBe('minor');

    const egress = advanced.discrepancies.find(d => d.metric === 'Egress Throughput');
    expect(egress.advertised).toBe(10000000);
    expect(egress.actual).toBe(10000000);
    expect(egress.percentageDiff).toBe(0);

    // Max Partitions: 100 partitions/shard * 5 nodes = 500 vs advertised 1000
    const partitions = advanced.discrepancies.find(d => d.metric === 'Max Partitions');
    expect(partitions.advertised).toBe(1000);
    expect(partitions.actual).toBe(500);
    expect(partitions.percentageDiff).toBe(-50);

    const clients = advanced.discrepancies.find(d => d.metric === 'Max Client Connections');
    expect(clients.advertised).toBe(500);
    expect(clients.actual).toBe(500);
    expect(clients.percentageDiff).toBe(0);

    // Not everything is critical
    const severities = parsed.analyses.flatMap(a => a.discrepancies.map(d => d.severity));
    expect(severities).toContain('minor');
    expect(severities.every(s => s === 'critical')).toBe(false);
  });

  it('formats throughput using binary byte units, not bits', async () => {
    const report = await generateDiscrepancyReport({
      input,
      masterData,
      format: 'markdown'
    });

    expect(report).toContain('MiB/s');
    expect(report).not.toContain('Mbps');
    expect(report).not.toContain('Kbps');
  });
});
