const GetLatestRedpandaVersion = require('./get-latest-redpanda-version');
const GetLatestConsoleVersion = require('./get-latest-console-version');
const GetLatestOperatorVersion = require('./get-latest-operator-version');
const GetLatestHelmChartVersion = require('./get-latest-redpanda-helm-version');
const chalk = require('chalk');

module.exports.register = function ({ config }) {
  const logger = this.getLogger('set-latest-version-extension');
  if (!process.env.REDPANDA_GITHUB_TOKEN) {
    logger.warn('REDPANDA_GITHUB_TOKEN environment variable not set. Attempting unauthenticated request.');
  }

  this.on('contentClassified', async ({ contentCatalog }) => {
    try {
      const results = await Promise.allSettled([
        GetLatestRedpandaVersion(),
        GetLatestConsoleVersion(),
        GetLatestOperatorVersion(),
        GetLatestHelmChartVersion()
      ]);

      // Extracting results with fallbacks if promises were rejected
      const LatestRedpandaVersion = results[0].status === 'fulfilled' ? results[0].value : null;
      const LatestConsoleVersion = results[1].status === 'fulfilled' ? results[1].value : null;
      const LatestOperatorVersion = results[2].status === 'fulfilled' ? results[2].value : null;
      const LatestHelmChartVersion = results[3].status === 'fulfilled' ? results[3].value : null;

      const components = await contentCatalog.getComponents();
      components.forEach(component => {
        component.versions.forEach(({ name, version, asciidoc }) => {
          if (LatestConsoleVersion) {
            asciidoc.attributes['latest-console-version'] = LatestConsoleVersion;
            logger.info(`Set Redpanda Console version to ${LatestConsoleVersion} in ${name} ${version}`);
          }
        });

        if (!component.latest.asciidoc) {
          component.latest.asciidoc = { attributes: {} };
        }

        // Handle each version setting with appropriate logging
        if (LatestRedpandaVersion) {
          component.latest.asciidoc.attributes['full-version'] = LatestRedpandaVersion[0];
          component.latest.asciidoc.attributes['latest-release-commit'] = LatestRedpandaVersion[1];
          logger.info(`Set the latest Redpanda version to ${LatestRedpandaVersion[0]} ${LatestRedpandaVersion[1]}`);
        } else {
          logger.warn("Failed to get the latest Redpanda version - using defaults");
        }

        if (LatestOperatorVersion) {
          component.latest.asciidoc.attributes['latest-operator-version'] = LatestOperatorVersion;
          logger.info(`Set the latest Redpanda Operator version to ${LatestOperatorVersion}`);
        } else {
          logger.warn("Failed to get the latest Operator version from GitHub - using default");
        }

        if (LatestHelmChartVersion) {
          component.latest.asciidoc.attributes['latest-redpanda-helm-chart-version'] = LatestHelmChartVersion;
          logger.info(`Set the latest Redpanda Helm chart version to ${LatestHelmChartVersion}`);
        } else {
          logger.warn("Failed to get the latest Helm Chart version - using default");
        }
      });

      console.log(`${chalk.green('Updated Redpanda documentation versions successfully.')}`);
    } catch (error) {
      logger.error(`Error updating versions: ${error}`);
    }
  });
};
