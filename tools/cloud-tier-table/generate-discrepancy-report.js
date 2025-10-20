#!/usr/bin/env node

const { generateCloudTierTable } = require('./generate-cloud-tier-table.js');
const Papa = require('papaparse');

/**
 * Compute the percentage difference from an advertised value to an actual value.
 * @param {number} advertised - The reference (advertised) value.
 * @param {number} actual - The observed or configured value to compare.
 * @returns {number|null} The percentage difference ((actual - advertised) / advertised * 100); `null` if `advertised` is falsy or zero.
 */
function calculatePercentageDiff(advertised, actual) {
  if (!advertised || advertised === 0) return null;
  return ((actual - advertised) / advertised) * 100;
}

/**
 * Convert a bytes-per-second value into a human-readable Mbps or Kbps string.
 * @param {number} bps - Bytes per second; falsy values (e.g., 0, null, undefined) produce `'N/A'`.
 * @returns {string} A formatted throughput string like `"<n.n> Mbps"` or `"<n.n> Kbps"`, or `'N/A'` when input is falsy.
 */
function formatThroughput(bps) {
  if (!bps) return 'N/A';
  const mbps = bps / (1024 * 1024);
  if (mbps < 1) {
    const kbps = bps / 1024;
    return `${kbps.toFixed(1)} Kbps`;
  }
  return `${mbps.toFixed(1)} Mbps`;
}

/**
 * Format a number with locale-specific thousands separators.
 *
 * If `num` is null or undefined the function returns `"N/A"`; a numeric `0` is formatted normally.
 * @param {number} num - The number to format.
 * @returns {string} The number formatted with locale-specific separators, or `"N/A"` if input is null or undefined.
 */
function formatNumber(num) {
  if (!num && num !== 0) return 'N/A';
  return num.toLocaleString();
}

/**
 * Classifies a percentage difference into a severity level.
 * @param {number} percentDiff - Percentage difference (positive if actual > advertised, negative if actual < advertised).
 * @returns {string} `unknown` if `percentDiff` is null or undefined; otherwise `minor` for absolute percentage <= 5, `moderate` for <= 25, `major` for <= 50, and `critical` for > 50.
 */
function getSeverity(percentDiff) {
  if (percentDiff === null || percentDiff === undefined) return 'unknown';
  const abs = Math.abs(percentDiff);
  if (abs <= 5) return 'minor';
  if (abs <= 25) return 'moderate';
  if (abs <= 50) return 'major';
  return 'critical';
}

/**
 * Get severity emoji
 * @param {string} severity - Severity level
 * @returns {string} Emoji
 */
function getSeverityEmoji(severity) {
  switch (severity) {
    case 'minor': return '🟢';
    case 'moderate': return '🟡';
    case 'major': return '🟠';
    case 'critical': return '🔴';
    default: return '⚪';
  }
}

/**
 * Safely parse an integer from tier data with error handling
 * @param {Object} tier - Tier data object
 * @param {string} key - Key to parse from tier data
 * @param {string} tierName - Tier name for logging
 * @returns {number} Parsed integer or 0 if invalid
 */
function safeParseInt(tier, key, tierName) {
  const value = tier[key];
  if (value === undefined || value === null || value === '') {
    console.warn(`Warning: Missing value for key "${key}" in tier "${tierName}"`);
    return 0;
  }
  
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    console.warn(`Warning: Invalid numeric value "${value}" for key "${key}" in tier "${tierName}"`);
    return 0;
  }
  
  return parsed;
}

/**
 * Create a discrepancy analysis entry for a single metric.
 *
 * @param {string} metricName - Human-readable metric name.
 * @param {number} advertised - Advertised/configured value to compare against.
 * @param {number} actual - Actual observed or configured value.
 * @param {(value: number) => string} formatter - Formatter that converts numeric values to display strings.
 * @returns {{metric: string, advertised: number, advertisedFormatted: string, actual: number, actualFormatted: string, percentageDiff: number|null, severity: string, emoji: string}} An object containing the metric name, raw and formatted advertised/actual values, the percentage difference (or `null` if unavailable), severity label, and a severity emoji.
 */
function analyzeMetric(metricName, advertised, actual, formatter) {
  const percentageDiff = calculatePercentageDiff(advertised, actual);
  const severity = getSeverity(percentageDiff);
  
  return {
    metric: metricName,
    advertised: advertised,
    advertisedFormatted: formatter(advertised),
    actual: actual,
    actualFormatted: formatter(actual),
    percentageDiff: percentageDiff,
    severity: severity,
    emoji: getSeverityEmoji(severity)
  };
}

/**
 * Builds a discrepancy analysis object for a cloud tier.
 *
 * @param {Object} tier - Tier data object containing configuration and advertised values. Expected keys include:
 *   `Tier` or `tier_name`, `cloud_provider`, `machine_type`, `nodes_count`,
 *   `advertisedMaxIngress`, `advertisedMaxEgress`, `advertisedMaxPartitionCount`, `advertisedMaxClientCount`,
 *   `kafka_throughput_limit_node_in_bps`, `kafka_throughput_limit_node_out_bps`,
 *   `topic_partitions_per_shard`, `kafka_connections_max`.
 * @returns {Object} An analysis object with:
 *   - `tierName` (string): tier identifier,
 *   - `cloudProvider` (string),
 *   - `machineType` (string),
 *   - `nodeCount` (number),
 *   - `discrepancies` (Array): list of per-metric analysis objects (metric name, advertised value, actual/config value, formatted values, percentageDiff, severity, emoji).
 */
function analyzeTierDiscrepancies(tier) {
  const tierName = tier.Tier || tier.tier_name;
  const analysis = {
    tierName: tierName,
    cloudProvider: tier.cloud_provider,
    machineType: tier.machine_type,
    nodeCount: tier.nodes_count,
    discrepancies: []
  };

  // Ingress throughput analysis
  const advertisedIngress = safeParseInt(tier, 'advertisedMaxIngress', tierName);
  const configIngress = safeParseInt(tier, 'kafka_throughput_limit_node_in_bps', tierName);
  analysis.discrepancies.push(analyzeMetric(
    'Ingress Throughput',
    advertisedIngress,
    configIngress,
    formatThroughput
  ));

  // Egress throughput analysis
  const advertisedEgress = safeParseInt(tier, 'advertisedMaxEgress', tierName);
  const configEgress = safeParseInt(tier, 'kafka_throughput_limit_node_out_bps', tierName);
  analysis.discrepancies.push(analyzeMetric(
    'Egress Throughput',
    advertisedEgress,
    configEgress,
    formatThroughput
  ));

  // Partition count analysis
  const advertisedPartitions = safeParseInt(tier, 'advertisedMaxPartitionCount', tierName);
  const partitionsPerShard = safeParseInt(tier, 'topic_partitions_per_shard', tierName);
  const nodeCount = safeParseInt(tier, 'nodes_count', tierName);
  const configPartitions = partitionsPerShard * nodeCount;
  analysis.discrepancies.push(analyzeMetric(
    'Max Partitions',
    advertisedPartitions,
    configPartitions,
    formatNumber
  ));

  // Client connections analysis
  const advertisedClients = safeParseInt(tier, 'advertisedMaxClientCount', tierName);
  const configClients = safeParseInt(tier, 'kafka_connections_max', tierName);
  analysis.discrepancies.push(analyzeMetric(
    'Max Client Connections',
    advertisedClients,
    configClients,
    formatNumber
  ));

  return analysis;
}

/**
 * Generate a comprehensive discrepancy report for Redpanda Cloud Tier configurations.
 *
 * Produces a report that compares advertised tier values against actual configuration values
 * and classifies discrepancies by severity. The report can be returned as Markdown (default)
 * or as a JSON string containing the generated date, a summary, and per-tier analyses.
 *
 * @param {Object} [options] - Options to control input sources and output format.
 * @param {string} [options.input] - URL or path to the install-pack source used to derive tier data.
 * @param {string} [options.masterData] - URL or path to master-data.yaml used to resolve advertised values.
 * @param {string} [options.format] - Output format: 'markdown' or 'json' (case-insensitive). Defaults to 'markdown'.
 * @returns {string} The generated report as a formatted string (Markdown or JSON).
 * @throws {Error} If CSV parsing fails, an unsupported format is requested, or report generation encounters an error.
 */
async function generateDiscrepancyReport(options = {}) {
  const {
    input = 'https://api.github.com/repos/redpanda-data/cloudv2/contents/install-pack',
    masterData = 'https://api.github.com/repos/redpanda-data/cloudv2-infra/contents/master-data.yaml',
    format = 'markdown'
  } = options;

  try {
    // Get the raw data by generating table with CSV format
    const tableData = await generateCloudTierTable({
      input,
      masterData,
      format: 'csv',
      output: null
    });

    // Parse CSV data using papaparse for robust handling of quotes, commas, and newlines
    const parseResult = Papa.parse(tableData.trim(), {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => header.trim().replace(/^"|"$/g, ''), // Remove surrounding quotes
      transform: (value) => value.trim().replace(/^"|"$/g, '') // Remove surrounding quotes from values
    });
    
    if (parseResult.errors.length > 0) {
      throw new Error(`CSV parsing failed: ${parseResult.errors.map(e => e.message).join(', ')}`);
    }
    
    const rows = parseResult.data;

    // Analyze each tier
    const analyses = rows.map(analyzeTierDiscrepancies);

    // Normalize format input and validate
    const mode = (format || 'markdown').toLowerCase();
    if (!['markdown', 'json'].includes(mode)) {
      throw new Error(`Unsupported format: ${format}. Supported formats are 'markdown' and 'json'.`);
    }

    // Generate report
    let report = '';

    if (mode === 'markdown') {
      report += '# Redpanda Cloud Tier Discrepancy Report\n\n';
      report += `Generated on: ${new Date().toISOString().split('T')[0]}\n\n`;
      report += '## Executive Summary\n\n';
      
      // Summary statistics
      let totalIssues = 0;
      let criticalIssues = 0;
      let majorIssues = 0;
      let moderateIssues = 0;
      let minorIssues = 0;

      analyses.forEach(analysis => {
        analysis.discrepancies.forEach(disc => {
          if (disc.severity !== 'minor') totalIssues++;
          switch (disc.severity) {
            case 'critical': criticalIssues++; break;
            case 'major': majorIssues++; break;
            case 'moderate': moderateIssues++; break;
            case 'minor': minorIssues++; break;
          }
        });
      });

      report += `- **Total Tiers Analyzed**: ${analyses.length}\n`;
      report += `- **Total Issues Found**: ${totalIssues}\n`;
      report += `- **🔴 Critical Issues**: ${criticalIssues}\n`;
      report += `- **🟠 Major Issues**: ${majorIssues}\n`;
      report += `- **🟡 Moderate Issues**: ${moderateIssues}\n`;
      report += `- **🟢 Minor Issues**: ${minorIssues}\n\n`;

      report += '## Detailed Analysis\n\n';

      // Group by cloud provider
      const groupedByProvider = {};
      analyses.forEach(analysis => {
        if (!groupedByProvider[analysis.cloudProvider]) {
          groupedByProvider[analysis.cloudProvider] = [];
        }
        groupedByProvider[analysis.cloudProvider].push(analysis);
      });

      Object.keys(groupedByProvider).sort().forEach(provider => {
        report += `### ${provider}\n\n`;
        
        groupedByProvider[provider].forEach(analysis => {
          report += `#### ${analysis.tierName} (${analysis.machineType})\n\n`;
          report += `**Configuration**: ${analysis.nodeCount} nodes\n\n`;
          
          // Create table for this tier
          report += '| Metric | Advertised | Actual | Difference | Status |\n';
          report += '|--------|------------|--------|------------|--------|\n';
          
          analysis.discrepancies.forEach(disc => {
            const diffText = disc.percentageDiff !== null 
              ? `${disc.percentageDiff > 0 ? '+' : ''}${disc.percentageDiff.toFixed(1)}%`
              : 'N/A';
            
            report += `| ${disc.metric} | ${disc.advertisedFormatted} | ${disc.actualFormatted} | ${diffText} | ${disc.emoji} ${disc.severity} |\n`;
          });
          
          report += '\n';
          
          // Highlight major issues
          const majorIssues = analysis.discrepancies.filter(d => ['critical', 'major'].includes(d.severity));
          if (majorIssues.length > 0) {
            report += '**⚠️ Major Issues:**\n';
            majorIssues.forEach(issue => {
              const direction = issue.percentageDiff > 0 ? 'higher' : 'lower';
              report += `- ${issue.metric}: Config is ${Math.abs(issue.percentageDiff).toFixed(1)}% ${direction} than advertised\n`;
            });
            report += '\n';
          }
        });
      });

      report += '## Recommendations\n\n';
      report += '1. **🔴 Critical/Major Issues**: Immediate review required for tiers with >25% discrepancies\n';
      report += '2. **📊 Throughput Alignment**: Standardize ingress/egress limits across machine types within tiers\n';
      report += '3. **👥 Client Connection Review**: Many config limits are significantly lower than advertised\n';
      report += '4. **📈 Partition Capacity**: Some tiers exceed advertised partition limits in config\n';
      report += '5. **🔄 Regular Audits**: Implement automated checks to prevent future discrepancies\n\n';

    } else if (mode === 'json') {
      report = JSON.stringify({
        generatedDate: new Date().toISOString(),
        summary: {
          totalTiers: analyses.length,
          totalIssues: analyses.reduce((sum, a) => sum + a.discrepancies.filter(d => d.severity !== 'minor').length, 0)
        },
        analyses
      }, null, 2);
    }

    return report;

  } catch (error) {
    throw new Error(`Failed to generate discrepancy report: ${error.message}`);
  }
}

module.exports = {
  generateDiscrepancyReport,
  analyzeTierDiscrepancies,
  calculatePercentageDiff,
  formatThroughput,
  formatNumber
};

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    const value = args[i + 1];
    options[key] = value;
  }

  generateDiscrepancyReport(options)
    .then(report => {
      console.log(report);
    })
    .catch(error => {
      console.error('Error:', error.message);
      process.exit(1);
    });
}