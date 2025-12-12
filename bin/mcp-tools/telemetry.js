/**
 * Usage Telemetry and Statistics
 *
 * Tracks usage of prompts, resources, and tools to provide insights
 * into adoption and identify unused features.
 */

const fs = require('fs');
const path = require('path');

/**
 * Usage statistics tracker
 */
class UsageStats {
  constructor() {
    this.prompts = new Map(); // name count
    this.resources = new Map(); // uri count
    this.tools = new Map(); // name count
    this.startTime = new Date();
    this.lastReportTime = new Date();
  }

  /**
   * Record prompt usage
   * @param {string} name - Prompt name
   */
  recordPrompt(name) {
    const count = this.prompts.get(name) || 0;
    this.prompts.set(name, count + 1);
  }

  /**
   * Record resource usage
   * @param {string} uri - Resource URI
   */
  recordResource(uri) {
    const count = this.resources.get(uri) || 0;
    this.resources.set(uri, count + 1);
  }

  /**
   * Record tool usage
   * @param {string} name - Tool name
   */
  recordTool(name) {
    const count = this.tools.get(name) || 0;
    this.tools.set(name, count + 1);
  }

  /**
   * Get stats summary
   * @returns {Object} Statistics summary
   */
  getSummary() {
    const now = new Date();
    const uptime = Math.floor((now - this.startTime) / 1000); // seconds
    const timeSinceLastReport = Math.floor((now - this.lastReportTime) / 1000);

    return {
      uptime,
      timeSinceLastReport,
      promptCount: this.prompts.size,
      resourceCount: this.resources.size,
      toolCount: this.tools.size,
      totalPromptCalls: Array.from(this.prompts.values()).reduce((a, b) => a + b, 0),
      totalResourceCalls: Array.from(this.resources.values()).reduce((a, b) => a + b, 0),
      totalToolCalls: Array.from(this.tools.values()).reduce((a, b) => a + b, 0),
      prompts: Object.fromEntries(this.prompts),
      resources: Object.fromEntries(this.resources),
      tools: Object.fromEntries(this.tools)
    };
  }

  /**
   * Get top N most used items
   * @param {Map} map - Map to get top from
   * @param {number} n - Number of items
   * @returns {Array} Top N items as [name, count] pairs
   */
  getTopN(map, n = 5) {
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  }

  /**
   * Format stats for display
   * @returns {string} Formatted stats
   */
  format() {
    const summary = this.getSummary();
    const lines = [];

    lines.push('MCP Server Usage Statistics');
    lines.push('='.repeat(60));
    lines.push('');

    // Uptime
    const hours = Math.floor(summary.uptime / 3600);
    const minutes = Math.floor((summary.uptime % 3600) / 60);
    lines.push(`Uptime: ${hours}h ${minutes}m`);
    lines.push('');

    // Totals
    lines.push(`Total calls:`);
    lines.push(`  Prompts: ${summary.totalPromptCalls}`);
    lines.push(`  Resources: ${summary.totalResourceCalls}`);
    lines.push(`  Tools: ${summary.totalToolCalls}`);
    lines.push('');

    // Top prompts
    if (this.prompts.size > 0) {
      lines.push('Most used prompts:');
      const topPrompts = this.getTopN(this.prompts, 5);
      topPrompts.forEach(([name, count]) => {
        lines.push(`  ${name}: ${count} calls`);
      });
      lines.push('');
    }

    // Top resources
    if (this.resources.size > 0) {
      lines.push('Most used resources:');
      const topResources = this.getTopN(this.resources, 5);
      topResources.forEach(([uri, count]) => {
        lines.push(`  ${uri}: ${count} calls`);
      });
      lines.push('');
    }

    // Top tools
    if (this.tools.size > 0) {
      lines.push('Most used tools:');
      const topTools = this.getTopN(this.tools, 5);
      topTools.forEach(([name, count]) => {
        lines.push(`  ${name}: ${count} calls`);
      });
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Export stats to JSON file
   * @param {string} filepath - Path to export to
   */
  exportToFile(filepath) {
    const summary = this.getSummary();
    summary.exportedAt = new Date().toISOString();

    fs.writeFileSync(filepath, JSON.stringify(summary, null, 2), 'utf8');
  }

  /**
   * Reset stats (for periodic reporting)
   */
  reset() {
    this.lastReportTime = new Date();
    // Don't reset the maps - keep cumulative stats
  }
}

/**
 * Create a periodic reporter
 * @param {UsageStats} stats - Stats instance
 * @param {number} intervalMs - Interval in milliseconds
 * @returns {NodeJS.Timeout} Interval handle
 */
function createPeriodicReporter(stats, intervalMs = 3600000) {
  return setInterval(() => {
    const output = stats.format();
    console.error('\n' + output);
    stats.reset();
  }, intervalMs);
}

/**
 * Create a shutdown handler to export stats
 * @param {UsageStats} stats - Stats instance
 * @param {string} baseDir - Base directory for export
 */
function createShutdownHandler(stats, baseDir) {
  const handler = () => {
    const exportPath = path.join(baseDir, 'mcp-usage-stats.json');
    try {
      stats.exportToFile(exportPath);
      console.error(`\nUsage stats exported to: ${exportPath}`);
    } catch (err) {
      console.error(`Failed to export usage stats: ${err.message}`);
    }
  };

  process.on('SIGINT', () => {
    handler();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    handler();
    process.exit(0);
  });

  return handler;
}

module.exports = {
  UsageStats,
  createPeriodicReporter,
  createShutdownHandler
};
