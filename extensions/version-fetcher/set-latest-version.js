'use strict';

module.exports.register = function ({ config }) {
  const GetLatestRedpandaVersion = require('./get-latest-redpanda-version');
  const GetLatestConsoleVersion = require('./get-latest-console-version');
  const GetLatestDockerTag = require('./fetch-latest-docker-tag');
  const GetLatestHelmChartVersion = require('./get-latest-redpanda-helm-version');
  const GetLatestConnectVersion = require('./get-latest-connect');
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
    const dockerNamespace = 'redpandadata'

    try {
      const [
        latestRedpandaResult,
        latestConsoleResult,
        latestOperatorResult,
        latestHelmChartResult,
        latestConnectResult,
      ] = await Promise.allSettled([
        GetLatestRedpandaVersion(github, owner, 'redpanda'),
        GetLatestDockerTag(dockerNamespace, 'console'),
        GetLatestDockerTag(dockerNamespace, 'redpanda-operator'),
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

          // Set operator and helm chart attributes via helper function
          updateAttributes(asciidoc, [
            { condition: latestVersions.operator, key: 'latest-operator-version', value: latestVersions.operator?.latestStableRelease },
            { condition: latestVersions.helmChart, key: 'latest-redpanda-helm-chart-version', value: latestVersions.helmChart?.latestStableRelease }
          ]);

          // Set attributes for console and connect versions
          [
            { condition: latestVersions.console, baseName: 'latest-console', value: latestVersions.console?.latestStableRelease },
            { condition: latestVersions.connect, baseName: 'latest-connect', value: latestVersions.connect }
          ].forEach(mapping => {
            if (mapping.condition && mapping.value) {
              setVersionAndTagAttributes(asciidoc, mapping.baseName, mapping.value, name, version);
            }
          });

          // Special handling for Redpanda RC versions if in beta
          if (latestVersions.redpanda?.latestRcRelease?.version) {
            setVersionAndTagAttributes(asciidoc, 'redpanda-beta', latestVersions.redpanda.latestRcRelease.version, name, version);
            asciidoc.attributes['redpanda-beta-commit'] = latestVersions.redpanda.latestRcRelease.commitHash;
          }
          if (latestVersions.console?.latestBetaRelease) {
            setVersionAndTagAttributes(asciidoc, 'console-beta', latestVersions.console.latestBetaRelease, name, version);
          }
          if (latestVersions.operator?.latestBetaRelease) {
            setVersionAndTagAttributes(asciidoc, 'operator-beta', latestVersions.operator.latestBetaRelease, name, version);
          }
          if (latestVersions.helmChart?.latestBetaRelease) {
            setVersionAndTagAttributes(asciidoc, 'helm-beta', latestVersions.helmChart.latestBetaRelease, name, version);
          }
        });

        if (!component.latest.asciidoc) component.latest.asciidoc = { attributes: {} };

        // For Redpanda GA version, set both latest-redpanda-version and latest-redpanda-tag if available
        if (semver.valid(latestVersions.redpanda?.latestRedpandaRelease?.version)) {
          const currentVersion = component.latest.asciidoc.attributes['full-version'] || '0.0.0';
          if (semver.gt(latestVersions.redpanda.latestRedpandaRelease.version, currentVersion)) {
            // Required for backwards compatibility. Some docs still use full-version
            component.latest.asciidoc.attributes['full-version'] = sanitizeVersion(latestVersions.redpanda.latestRedpandaRelease.version);
            setVersionAndTagAttributes(component.latest.asciidoc, 'latest-redpanda', latestVersions.redpanda.latestRedpandaRelease.version, component.latest.name, component.latest.version);
            component.latest.asciidoc.attributes['latest-release-commit'] = latestVersions.redpanda.latestRedpandaRelease.commitHash;
          }
        }
      });

      logger.info('Updated Redpanda documentation versions successfully.');
      logger.info(`Latest Redpanda version: ${latestVersions.redpanda.latestRedpandaRelease.version}`);
      if (latestVersions.redpanda.latestRCRelease) logger.info(`Latest Redpanda beta version: ${latestVersions.redpanda.latestRCRelease.version}`);
      logger.info(`Latest Connect version: ${latestVersions.connect}`);
      logger.info(`Latest Console version: ${latestVersions.console.latestStableRelease}`);
      if (latestVersions.console.latestBetaRelease) logger.info(`Latest Console beta version: ${latestVersions.console.latestBetaRelease}`);
      logger.info(`Latest Redpanda Helm chart version: ${latestVersions.helmChart}`);
      logger.info(`Latest Operator version: ${latestVersions.operator}`);
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
        logger.debug(`Set ${baseName}-version to ${versionWithoutPrefix} and ${baseName}-tag to ${versionData} in ${name} ${version}`);
      } else {
        logger.debug(`Updated ${baseName}-version to ${versionWithoutPrefix} and ${baseName}-tag to ${versionData}`);
      }
    }
  }

  // Helper function to sanitize version by removing "v" prefix
  function sanitizeVersion(version) {
    return version.replace(/^v/, '');
  }

  // Helper function to update multiple attributes based on a list of mappings
  function updateAttributes(asciidoc, mappings) {
    mappings.forEach(({ condition, key, value }) => {
      if (condition) {
        asciidoc.attributes[key] = value;
      }
    });
  }
};