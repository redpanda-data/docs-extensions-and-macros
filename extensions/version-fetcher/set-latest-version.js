'use strict';

module.exports.register = function ({ config }) {
  const GetLatestRedpandaVersion = require('./get-latest-redpanda-version');
  const GetLatestConsoleVersion = require('./get-latest-console-version');
  const GetLatestOperatorVersion = require('./get-latest-operator-version');
  const GetLatestHelmChartVersion = require('./get-latest-redpanda-helm-version');
  const GetLatestConnectVersion = require('./get-latest-connect');
  const chalk = require('chalk');
  const logger = this.getLogger('set-latest-version-extension');

  if (!process.env.REDPANDA_GITHUB_TOKEN) {
    logger.warn('REDPANDA_GITHUB_TOKEN environment variable not set. Attempting unauthenticated request.');
  }

  this.on('contentClassified', async ({ contentCatalog }) => {
    const { Octokit } = await import("@octokit/rest");
    const { retry } = await import("@octokit/plugin-retry");
    const semver = await import("semver");
    const OctokitWithRetries = Octokit.plugin(retry);

    const owner = 'redpanda-data';
    const githubOptions = {
      userAgent: 'Redpanda Docs',
      baseUrl: 'https://api.github.com',
      auth: process.env.REDPANDA_GITHUB_TOKEN || undefined,
    };
    const github = new OctokitWithRetries(githubOptions);

    try {
      const [
        latestRedpandaResult,
        latestConsoleResult,
        latestOperatorResult,
        latestHelmChartResult,
        latestConnectResult,
      ] = await Promise.allSettled([
        GetLatestRedpandaVersion(github, owner, 'redpanda'),
        GetLatestConsoleVersion(github, owner, 'console'),
        GetLatestOperatorVersion(github, owner, 'redpanda-operator'),
        GetLatestHelmChartVersion(github, owner, 'helm-charts', 'charts/redpanda/Chart.yaml'),
        GetLatestConnectVersion(github, owner, 'connect'),
      ]);

      const latestVersions = {
        redpanda: latestRedpandaResult.status === 'fulfilled' ? latestRedpandaResult.value : {},
        console: latestConsoleResult.status === 'fulfilled' ? latestConsoleResult.value : undefined,
        operator: latestOperatorResult.status === 'fulfilled' ? latestOperatorResult.value : undefined,
        helmChart: latestHelmChartResult.status === 'fulfilled' ? latestHelmChartResult.value : undefined,
        connect: latestConnectResult.status === 'fulfilled' ? latestConnectResult.value : undefined,
      };

      const components = await contentCatalog.getComponents();
      components.forEach(component => {
        const prerelease = component.latestPrerelease;

        component.versions.forEach(({ name, version, asciidoc }) => {
          if (prerelease?.version === version) {
            asciidoc.attributes['page-component-version-is-prerelease'] = 'true';
          }

          // Set operator and helm chart attributes
          if (latestVersions.operator) {
            asciidoc.attributes['latest-operator-version'] = latestVersions.operator;
          }
          if (latestVersions.helmChart) {
            asciidoc.attributes['latest-redpanda-helm-chart-version'] = latestVersions.helmChart;
          }

          // Set attributes for console and connect versions
          if (latestVersions.console) {
            setVersionAndTagAttributes(asciidoc, 'latest-console', latestVersions.console, name, version);
          }
          if (latestVersions.connect) {
            setVersionAndTagAttributes(asciidoc, 'latest-connect', latestVersions.connect, name, version);
          }

          // Special handling for Redpanda RC versions if in beta
          if (latestVersions.redpanda?.latestRcRelease?.version) {
            setVersionAndTagAttributes(asciidoc, 'redpanda-beta', latestVersions.redpanda.latestRcRelease.version, name, version)
            asciidoc.attributes['redpanda-beta-commit'] = latestVersions.redpanda.latestRcRelease.commitHash;
          }
        });

        if (!component.latest.asciidoc) component.latest.asciidoc = { attributes: {} };

        // For Redpanda GA version, set both latest-redpanda-version and latest-redpanda-tag if available
        if (semver.valid(latestVersions.redpanda?.latestRedpandaRelease?.version)) {
          const currentVersion = component.latest.asciidoc.attributes['full-version'] || '0.0.0';
          if (semver.gt(latestVersions.redpanda.latestRedpandaRelease.version, currentVersion)) {
            component.latest.asciidoc.attributes['full-version'] = sanitizeVersion(latestVersions.redpanda.latestRedpandaRelease.version);
            setVersionAndTagAttributes(component.latest.asciidoc, 'latest-redpanda', latestVersions.redpanda.latestRedpandaRelease.version);
            component.latest.asciidoc.attributes['latest-release-commit'] = latestVersions.redpanda.latestRedpandaRelease.commitHash;
            logger.info(`Updated Redpanda release version to ${latestVersions.redpanda.latestRedpandaRelease.version}`);
          }
        }
      });

      console.log(chalk.green('Updated Redpanda documentation versions successfully.'));
    } catch (error) {
      logger.error(`Error updating versions: ${error}`);
    }
  });

  // Helper function to set both latest-*version and latest-*tag attributes
  function setVersionAndTagAttributes(asciidoc, baseName, versionData, name = '', version = '') {
    if (versionData) {
      const versionWithoutPrefix = sanitizeVersion(versionData);
      asciidoc.attributes[`${baseName}-version`] = versionWithoutPrefix; // Without "v" prefix
      asciidoc.attributes[`${baseName}-tag`] = `${versionData}`;

      if (name && version) {
        logger.info(`Set ${baseName}-version to ${versionWithoutPrefix} and ${baseName}-tag to ${versionData} in ${name} ${version}`);
      } else {
        logger.info(`Updated ${baseName}-version to ${versionWithoutPrefix} and ${baseName}-tag to ${versionData}`);
      }
    }
  }

  // Helper function to sanitize version by removing "v" prefix
  function sanitizeVersion(version) {
    return version.replace(/^v/, '');
  }
};
