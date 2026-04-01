'use strict';

const { generatePRSummary, generateMultiVersionPRSummary } = require('../../tools/redpanda-connect/pr-summary-formatter');

describe('PR Summary - Platform Detection', () => {
  // Base diff data structure
  const createDiffData = (newComponents) => ({
    comparison: {
      oldVersion: '4.79.0',
      newVersion: '4.81.0',
      timestamp: '2026-04-01T00:00:00.000Z'
    },
    summary: {
      newComponents: newComponents.length,
      newFields: 0,
      removedComponents: 0,
      removedFields: 0,
      deprecatedComponents: 0,
      deprecatedFields: 0,
      changedDefaults: 0
    },
    details: {
      newComponents,
      newFields: [],
      removedComponents: [],
      removedFields: [],
      deprecatedComponents: [],
      deprecatedFields: [],
      changedDefaults: []
    }
  });

  describe('Action Items - Self-Hosted Only Label', () => {
    it('should label connectors in notInCloud as self-hosted only', () => {
      const diffData = createDiffData([
        { type: 'inputs', name: 'file', status: 'stable', description: 'A file input' }
      ]);

      const binaryAnalysis = {
        cloudVersion: '4.82.0',
        comparison: {
          inCloud: [],
          notInCloud: [
            { type: 'inputs', name: 'file', status: 'stable' }
          ],
          cloudOnly: []
        }
      };

      const summary = generatePRSummary(diffData, binaryAnalysis);

      expect(summary).toContain('Document new `file` inputs (self-hosted only)');
      expect(summary).toContain('[ ] Document new `file` inputs (self-hosted only)');
    });

    it('should NOT label connectors in cloudOnly as self-hosted only', () => {
      const diffData = createDiffData([
        { type: 'inputs', name: 'aws_cloudwatch_logs', status: 'stable', description: 'AWS CloudWatch Logs input' }
      ]);

      const binaryAnalysis = {
        cloudVersion: '4.82.0',
        comparison: {
          inCloud: [],
          notInCloud: [],
          cloudOnly: [
            { type: 'inputs', name: 'aws_cloudwatch_logs', status: 'stable' }
          ]
        }
      };

      const summary = generatePRSummary(diffData, binaryAnalysis);

      // Should NOT contain self-hosted only label
      expect(summary).not.toContain('(self-hosted only)');

      // Should be listed in cloud docs update section
      expect(summary).toContain('☁️ Cloud Docs Update Required');
    });

    it('should NOT label connectors in inCloud as self-hosted only', () => {
      const diffData = createDiffData([
        { type: 'inputs', name: 'kafka', status: 'stable', description: 'Kafka input' }
      ]);

      const binaryAnalysis = {
        cloudVersion: '4.82.0',
        comparison: {
          inCloud: [
            { type: 'inputs', name: 'kafka', status: 'stable' }
          ],
          notInCloud: [],
          cloudOnly: []
        }
      };

      const summary = generatePRSummary(diffData, binaryAnalysis);

      // Should NOT contain self-hosted only label
      expect(summary).not.toContain('(self-hosted only)');

      // Should have cloud indicator
      expect(summary).toContain('☁️ **CLOUD SUPPORTED**');
    });
  });

  describe('Detailed Breakdown - Platform Categorization', () => {
    it('should categorize connectors correctly in detailed breakdown', () => {
      const diffData = createDiffData([
        { type: 'inputs', name: 'kafka', status: 'stable', description: 'Kafka input' },
        { type: 'inputs', name: 'file', status: 'stable', description: 'File input' },
        { type: 'inputs', name: 'aws_cloudwatch_logs', status: 'stable', description: 'AWS CloudWatch Logs input' }
      ]);

      const binaryAnalysis = {
        cloudVersion: '4.82.0',
        comparison: {
          inCloud: [
            { type: 'inputs', name: 'kafka', status: 'stable' }
          ],
          notInCloud: [
            { type: 'inputs', name: 'file', status: 'stable' }
          ],
          cloudOnly: [
            { type: 'inputs', name: 'aws_cloudwatch_logs', status: 'stable' }
          ]
        }
      };

      const summary = generatePRSummary(diffData, binaryAnalysis);

      // Should have both cloud supported and self-hosted sections in detailed breakdown
      expect(summary).toContain('☁️ Cloud Supported:');
      expect(summary).toContain('Self-Hosted Only:');

      // Cloud supported should include both kafka (inCloud) and aws_cloudwatch_logs (cloudOnly)
      const cloudSupportedMatch = summary.match(/\*\*☁️ Cloud Supported:\*\*[\s\S]*?(?=\*\*Self-Hosted Only:|####)/);
      expect(cloudSupportedMatch).toBeTruthy();
      const cloudSupportedSection = cloudSupportedMatch[0];
      expect(cloudSupportedSection).toContain('kafka');
      expect(cloudSupportedSection).toContain('aws_cloudwatch_logs');

      // Self-hosted only should only include file
      const selfHostedMatch = summary.match(/\*\*Self-Hosted Only:\*\*[\s\S]*?(?=####|<\/details>)/);
      expect(selfHostedMatch).toBeTruthy();
      const selfHostedSection = selfHostedMatch[0];
      expect(selfHostedSection).toContain('file');
      expect(selfHostedSection).not.toContain('kafka');
      expect(selfHostedSection).not.toContain('aws_cloudwatch_logs');
    });
  });

  describe('Draft Indicators - Cloud Symbol', () => {
    it('should show cloud indicator for connectors in inCloud', () => {
      const diffData = createDiffData([
        { type: 'inputs', name: 'kafka', status: 'stable', description: 'Kafka input' }
      ]);

      const binaryAnalysis = {
        cloudVersion: '4.82.0',
        comparison: {
          inCloud: [
            { type: 'inputs', name: 'kafka', status: 'stable' }
          ],
          notInCloud: [],
          cloudOnly: []
        }
      };

      const draftedConnectors = [
        {
          path: 'modules/components/pages/inputs/kafka.adoc',
          name: 'kafka',
          type: 'inputs',
          status: 'stable',
          requiresCgo: false,
          cloudOnly: false
        }
      ];

      const summary = generatePRSummary(diffData, binaryAnalysis, draftedConnectors);

      // Should have cloud indicator in drafted connectors section
      const draftedMatch = summary.match(/📝 Newly Drafted[\s\S]*?(?=###|$)/);
      expect(draftedMatch).toBeTruthy();
      const draftedSection = draftedMatch[0];
      expect(draftedSection).toContain('kafka');
      expect(draftedSection).toContain('☁️');
    });

    it('should show cloud indicator for connectors in cloudOnly', () => {
      const diffData = createDiffData([
        { type: 'inputs', name: 'aws_cloudwatch_logs', status: 'stable', description: 'AWS CloudWatch Logs input' }
      ]);

      const binaryAnalysis = {
        cloudVersion: '4.82.0',
        comparison: {
          inCloud: [],
          notInCloud: [],
          cloudOnly: [
            { type: 'inputs', name: 'aws_cloudwatch_logs', status: 'stable' }
          ]
        }
      };

      const draftedConnectors = [
        {
          path: 'modules/components/partials/components/cloud-only/inputs/aws_cloudwatch_logs.adoc',
          name: 'aws_cloudwatch_logs',
          type: 'inputs',
          status: 'stable',
          requiresCgo: false,
          cloudOnly: true
        }
      ];

      const summary = generatePRSummary(diffData, binaryAnalysis, draftedConnectors);

      // Should have cloud indicator in drafted connectors section
      const draftedMatch = summary.match(/📝 Newly Drafted[\s\S]*?(?=###|$)/);
      expect(draftedMatch).toBeTruthy();
      const draftedSection = draftedMatch[0];
      expect(draftedSection).toContain('aws_cloudwatch_logs');
      expect(draftedSection).toContain('☁️');
    });

    it('should NOT show cloud indicator for self-hosted only connectors', () => {
      const diffData = createDiffData([
        { type: 'inputs', name: 'file', status: 'stable', description: 'File input' }
      ]);

      const binaryAnalysis = {
        cloudVersion: '4.82.0',
        comparison: {
          inCloud: [],
          notInCloud: [
            { type: 'inputs', name: 'file', status: 'stable' }
          ],
          cloudOnly: []
        }
      };

      const draftedConnectors = [
        {
          path: 'modules/components/pages/inputs/file.adoc',
          name: 'file',
          type: 'inputs',
          status: 'stable',
          requiresCgo: false,
          cloudOnly: false
        }
      ];

      const summary = generatePRSummary(diffData, binaryAnalysis, draftedConnectors);

      // Get drafted section
      const draftedMatch = summary.match(/📝 Newly Drafted[\s\S]*?(?=###|$)/);
      expect(draftedMatch).toBeTruthy();
      const draftedSection = draftedMatch[0];
      expect(draftedSection).toContain('file');

      // Should NOT have cloud indicator for file input
      const fileMatch = draftedSection.match(/`file`[^\n]*/);
      expect(fileMatch).toBeTruthy();
      expect(fileMatch[0]).not.toContain('☁️');
    });
  });

  describe('Cloud Docs Update Section', () => {
    it('should list both inCloud and cloudOnly connectors', () => {
      const diffData = createDiffData([
        { type: 'inputs', name: 'kafka', status: 'stable', description: 'Kafka input' },
        { type: 'inputs', name: 'aws_cloudwatch_logs', status: 'stable', description: 'AWS CloudWatch Logs input' }
      ]);

      const binaryAnalysis = {
        cloudVersion: '4.82.0',
        comparison: {
          inCloud: [
            { type: 'inputs', name: 'kafka', status: 'stable' }
          ],
          notInCloud: [],
          cloudOnly: [
            { type: 'inputs', name: 'aws_cloudwatch_logs', status: 'stable' }
          ]
        }
      };

      const summary = generatePRSummary(diffData, binaryAnalysis);

      // Should mention 2 connectors available in cloud
      expect(summary).toContain('☁️ Cloud Docs Update Required');
      expect(summary).toContain('**2** new connectors are available in Redpanda Cloud');
    });

    it('should show different include syntax for cloud-only vs regular cloud connectors', () => {
      const diffData = createDiffData([
        { type: 'inputs', name: 'kafka', status: 'stable', description: 'Kafka input' },
        { type: 'inputs', name: 'aws_cloudwatch_logs', status: 'stable', description: 'AWS CloudWatch Logs input' }
      ]);

      const binaryAnalysis = {
        cloudVersion: '4.82.0',
        comparison: {
          inCloud: [
            { type: 'inputs', name: 'kafka', status: 'stable' }
          ],
          notInCloud: [],
          cloudOnly: [
            { type: 'inputs', name: 'aws_cloudwatch_logs', status: 'stable' }
          ]
        }
      };

      const summary = generatePRSummary(diffData, binaryAnalysis);

      // Should have both syntax examples
      expect(summary).toContain('For connectors in pages:');
      expect(summary).toContain('include::redpanda-connect:components:page$type/connector-name.adoc[tag=single-source]');

      expect(summary).toContain('For cloud-only connectors (in partials):');
      expect(summary).toContain('include::redpanda-connect:components:partial$components/cloud-only/type/connector-name.adoc[tag=single-source]');
    });
  });

  describe('Regression Tests - Original Bug', () => {
    it('should not create contradictory labels for aws_cloudwatch_logs', () => {
      // This is the original bug scenario from the user's report
      const diffData = createDiffData([
        { type: 'inputs', name: 'aws_cloudwatch_logs', status: 'stable', description: 'AWS CloudWatch Logs input' }
      ]);

      const binaryAnalysis = {
        cloudVersion: '4.82.0-rc2',
        comparison: {
          inCloud: [],
          notInCloud: [],
          cloudOnly: [
            { type: 'inputs', name: 'aws_cloudwatch_logs', status: 'stable' }
          ]
        },
        cgoOnly: [
          { type: 'inputs', name: 'aws_cloudwatch_logs', status: 'stable' }
        ]
      };

      const draftedConnectors = [
        {
          path: 'modules/components/partials/components/cloud-only/inputs/aws_cloudwatch_logs.adoc',
          name: 'aws_cloudwatch_logs',
          type: 'inputs',
          status: 'stable',
          requiresCgo: true,
          cloudOnly: true
        }
      ];

      const summary = generatePRSummary(diffData, binaryAnalysis, draftedConnectors);

      // Should NOT say self-hosted only
      expect(summary).not.toContain('aws_cloudwatch_logs inputs (self-hosted only)');

      // Should say cloud docs update required
      expect(summary).toContain('☁️ Cloud Docs Update Required');
      expect(summary).toContain('**1** new connector is available in Redpanda Cloud');

      // Draft should be in cloud-only directory
      expect(summary).toContain('modules/components/partials/components/cloud-only/inputs/aws_cloudwatch_logs.adoc');

      // Should have cloud indicator in drafted section
      const draftedMatch = summary.match(/📝 Newly Drafted[\s\S]*?(?=###|$)/);
      expect(draftedMatch).toBeTruthy();
      const draftedSection = draftedMatch[0];
      expect(draftedSection).toContain('☁️');
      expect(draftedSection).toContain('🔧'); // cgo indicator
    });
  });
});

describe('Multi-Version PR Summary', () => {
  // Helper to create a master diff structure
  const createMasterDiff = (releases) => ({
    metadata: {
      generatedAt: new Date().toISOString(),
      startVersion: releases[0]?.fromVersion || 'unknown',
      endVersion: releases[releases.length - 1]?.toVersion || 'unknown',
      processedReleases: releases.length
    },
    totalSummary: {
      versions: releases.map(r => r.toVersion),
      releaseCount: releases.length,
      newComponents: releases.reduce((sum, r) => sum + (r.summary?.newComponents || 0), 0),
      newFields: releases.reduce((sum, r) => sum + (r.summary?.newFields || 0), 0),
      removedFields: releases.reduce((sum, r) => sum + (r.summary?.removedFields || 0), 0),
      deprecatedFields: releases.reduce((sum, r) => sum + (r.summary?.deprecatedFields || 0), 0)
    },
    releases
  });

  // Helper to create a release entry
  const createRelease = (fromVersion, toVersion, newComponents = [], options = {}) => ({
    fromVersion,
    toVersion,
    date: new Date().toISOString(),
    summary: {
      newComponents: newComponents.length,
      newFields: options.newFields || 0,
      removedFields: options.removedFields || 0,
      deprecatedFields: options.deprecatedFields || 0
    },
    details: {
      newComponents,
      newFields: [],
      removedFields: [],
      deprecatedFields: []
    },
    binaryAnalysis: options.binaryAnalysis || null
  });

  describe('Basic Summary Generation', () => {
    it('should generate summary for multiple releases', () => {
      const masterDiff = createMasterDiff([
        createRelease('4.50.0', '4.51.0', [
          { type: 'inputs', name: 'postgres_cdc', status: 'beta' }
        ]),
        createRelease('4.51.0', '4.52.0', [
          { type: 'outputs', name: 'elasticsearch_v9', status: 'stable' }
        ])
      ]);

      const summary = generateMultiVersionPRSummary(masterDiff);

      expect(summary).toContain('Multi-Release Update');
      expect(summary).toContain('4.50.0 → 4.52.0');
      expect(summary).toContain('Releases Processed:** 2');
    });

    it('should show per-release breakdown', () => {
      const masterDiff = createMasterDiff([
        createRelease('4.50.0', '4.51.0', [
          { type: 'inputs', name: 'postgres_cdc', status: 'beta' }
        ]),
        createRelease('4.51.0', '4.52.0', [
          { type: 'outputs', name: 'elasticsearch_v9', status: 'stable' }
        ])
      ]);

      const summary = generateMultiVersionPRSummary(masterDiff);

      expect(summary).toContain('Version 4.51.0');
      expect(summary).toContain('Version 4.52.0');
      expect(summary).toContain('`postgres_cdc`');
      expect(summary).toContain('`elasticsearch_v9`');
    });

    it('should aggregate totals across releases', () => {
      const masterDiff = createMasterDiff([
        createRelease('4.50.0', '4.51.0', [
          { type: 'inputs', name: 'postgres_cdc', status: 'beta' }
        ], { newFields: 5 }),
        createRelease('4.51.0', '4.52.0', [
          { type: 'outputs', name: 'elasticsearch_v9', status: 'stable' }
        ], { newFields: 10 })
      ]);

      const summary = generateMultiVersionPRSummary(masterDiff);

      expect(summary).toContain('**2** new connectors');
      expect(summary).toContain('**15** new fields');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty releases array', () => {
      const masterDiff = createMasterDiff([]);

      const summary = generateMultiVersionPRSummary(masterDiff);

      expect(summary).toContain('No releases to process');
      expect(summary).toContain('PR_SUMMARY_END');
    });

    it('should handle releases with no changes', () => {
      const masterDiff = createMasterDiff([
        createRelease('4.50.0', '4.51.0', []),
        createRelease('4.51.0', '4.52.0', [])
      ]);

      const summary = generateMultiVersionPRSummary(masterDiff);

      expect(summary).toContain('No documentation changes in this release');
    });

    it('should handle missing metadata gracefully', () => {
      const masterDiff = {
        totalSummary: { newComponents: 0, newFields: 0 },
        releases: []
      };

      const summary = generateMultiVersionPRSummary(masterDiff);

      expect(summary).toContain('unknown → unknown');
      expect(summary).toContain('Releases Processed:** 0');
    });

    it('should handle missing binaryAnalysis gracefully', () => {
      const masterDiff = createMasterDiff([
        createRelease('4.50.0', '4.51.0', [
          { type: 'inputs', name: 'test_connector', status: 'stable' }
        ])
      ]);

      const summary = generateMultiVersionPRSummary(masterDiff);

      // Should not crash and connector line should not show cloud indicator
      expect(summary).toContain('`test_connector`');
      const connectorLine = summary.split('\n').find(line => line.includes('`test_connector`'));
      expect(connectorLine).toBeDefined();
      expect(connectorLine).not.toContain('☁️');
    });

    it('should handle missing details gracefully', () => {
      const masterDiff = {
        metadata: {
          startVersion: '4.50.0',
          endVersion: '4.51.0',
          processedReleases: 1
        },
        totalSummary: { newComponents: 1 },
        releases: [{
          fromVersion: '4.50.0',
          toVersion: '4.51.0',
          summary: { newComponents: 1 },
          // details intentionally missing
        }]
      };

      const summary = generateMultiVersionPRSummary(masterDiff);

      // Should not crash
      expect(summary).toContain('Version 4.51.0');
    });
  });

  describe('Platform Indicators', () => {
    it('should show cloud indicator for cloud-supported connectors', () => {
      const masterDiff = createMasterDiff([
        createRelease('4.50.0', '4.51.0', [
          { type: 'inputs', name: 'kafka', status: 'stable' }
        ], {
          binaryAnalysis: {
            comparison: {
              inCloud: [{ type: 'inputs', name: 'kafka' }],
              cloudOnly: [],
              notInCloud: []
            }
          }
        })
      ]);

      const summary = generateMultiVersionPRSummary(masterDiff);

      expect(summary).toContain('`kafka` (inputs, stable) ☁️');
    });

    it('should show cgo indicator for cgo-only connectors', () => {
      const masterDiff = createMasterDiff([
        createRelease('4.50.0', '4.51.0', [
          { type: 'inputs', name: 'zmq4', status: 'stable' }
        ], {
          binaryAnalysis: {
            comparison: { inCloud: [], cloudOnly: [], notInCloud: [] },
            cgoOnly: [{ type: 'inputs', name: 'zmq4' }]
          }
        })
      ]);

      const summary = generateMultiVersionPRSummary(masterDiff);

      expect(summary).toContain('`zmq4` (inputs, stable) 🔧');
    });
  });

  describe('Action Items', () => {
    it('should generate action items with version attribution', () => {
      const masterDiff = createMasterDiff([
        createRelease('4.50.0', '4.51.0', [
          { type: 'inputs', name: 'postgres_cdc', status: 'beta' }
        ]),
        createRelease('4.51.0', '4.52.0', [
          { type: 'outputs', name: 'elasticsearch_v9', status: 'stable' }
        ])
      ]);

      const summary = generateMultiVersionPRSummary(masterDiff);

      // New format: `connector` type — introduced in **version**
      expect(summary).toContain('`postgres_cdc` inputs — introduced in **4.51.0**');
      expect(summary).toContain('`elasticsearch_v9` outputs — introduced in **4.52.0**');
    });

    it('should label self-hosted-only connectors in action items', () => {
      const masterDiff = createMasterDiff([
        createRelease('4.50.0', '4.51.0', [
          { type: 'inputs', name: 'file', status: 'stable' }
        ], {
          binaryAnalysis: {
            comparison: {
              inCloud: [],
              cloudOnly: [],
              notInCloud: [{ type: 'inputs', name: 'file' }]
            }
          }
        })
      ]);

      const summary = generateMultiVersionPRSummary(masterDiff);

      // New format: grouped under "Self-hosted only:" with 🖥️ indicator
      expect(summary).toContain('Self-hosted only:');
      expect(summary).toContain('`file` inputs 🖥️ — introduced in **4.51.0**');
    });

    it('should show cloud indicator in action items for cloud connectors', () => {
      const masterDiff = createMasterDiff([
        createRelease('4.50.0', '4.51.0', [
          { type: 'inputs', name: 'kafka', status: 'stable' }
        ], {
          binaryAnalysis: {
            comparison: {
              inCloud: [{ type: 'inputs', name: 'kafka' }],
              cloudOnly: [],
              notInCloud: []
            }
          }
        })
      ]);

      const summary = generateMultiVersionPRSummary(masterDiff);

      // New format: grouped under "Cloud-supported (higher priority):" with ☁️
      expect(summary).toContain('Cloud-supported (higher priority):');
      expect(summary).toContain('`kafka` inputs ☁️ — introduced in **4.51.0**');
    });
  });

  describe('Auto-detection', () => {
    it('should auto-detect multi-version format in generatePRSummary', () => {
      const masterDiff = createMasterDiff([
        createRelease('4.50.0', '4.51.0', [
          { type: 'inputs', name: 'test', status: 'stable' }
        ])
      ]);

      // Call generatePRSummary with a master diff (should auto-detect)
      const summary = generatePRSummary(masterDiff);

      expect(summary).toContain('Multi-Release Update');
    });
  });
});
