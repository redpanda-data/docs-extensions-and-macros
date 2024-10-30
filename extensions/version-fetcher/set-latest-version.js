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
        redpanda: latestRedpandaResult.status === 'fulfilled' ? latestRedpandaResult.value : null,
        console: latestConsoleResult.status === 'fulfilled' ? latestConsoleResult.value : null,
        operator: latestOperatorResult.status === 'fulfilled' ? latestOperatorResult.value : null,
        helmChart: latestHelmChartResult.status === 'fulfilled' ? latestHelmChartResult.value : null,
        connect: latestConnectResult.status === 'fulfilled' ? latestConnectResult.value : null,
      };

      const components = await contentCatalog.getComponents();
      components.forEach(component => {
        const prerelease = component.latestPrerelease;

        component.versions.forEach(({ name, version, asciidoc }) => {
          if (prerelease?.version === version) {
            asciidoc.attributes['page-component-version-is-prerelease'] = 'true';
          }

          setVersionAttribute(asciidoc, 'latest-console-version', latestVersions.console, name, version);
          setVersionAttribute(asciidoc, 'latest-connect-version', latestVersions.connect, name, version);

          if (latestVersions.redpanda?.latestRcRelease?.version) {
            asciidoc.attributes['redpanda-beta-version'] = `v${latestVersions.redpanda.latestRcRelease.version}`;
            asciidoc.attributes['redpanda-beta-commit'] = `${latestVersions.redpanda.latestRcRelease.commitHash}`;
            logger.info(`Set Redpanda RC version ${latestVersions.redpanda.latestRcRelease.version} in ${name} ${version}`);
          }
        });

        if (!component.latest.asciidoc) component.latest.asciidoc = { attributes: {} };

        if (semver.valid(latestVersions.redpanda?.latestRedpandaRelease?.version)) {
          const currentVersion = component.latest.asciidoc.attributes['full-version'] || '0.0.0';
          if (semver.gt(latestVersions.redpanda.latestRedpandaRelease.version, currentVersion)) {
            component.latest.asciidoc.attributes['full-version'] = `${latestVersions.redpanda.latestRedpandaRelease.version}`;
            component.latest.asciidoc.attributes['latest-redpanda-version'] = `v${latestVersions.redpanda.latestRedpandaRelease.version}`;
            component.latest.asciidoc.attributes['latest-release-commit'] = `${latestVersions.redpanda.latestRedpandaRelease.commitHash}`;
            logger.info(`Updated Redpanda release version to ${latestVersions.redpanda.latestRedpandaRelease.version}`);
          }
        }

        setVersionAttribute(component.latest.asciidoc, 'latest-operator-version', latestVersions.operator);
        setVersionAttribute(component.latest.asciidoc, 'latest-redpanda-helm-chart-version', latestVersions.helmChart);
      });

      console.log(chalk.green('Updated Redpanda documentation versions successfully.'));
    } catch (error) {
      logger.error(`Error updating versions: ${error}`);
    }
  });

  function setVersionAttribute(asciidoc, attributeName, versionData, name, version) {
    if (versionData) {
      asciidoc.attributes[attributeName] = `${versionData}`;
      if (name && version) {
        logger.info(`Set ${attributeName} to ${versionData} in ${name} ${version}`);
      } else {
        logger.info(`Updated ${attributeName} to ${versionData}`);
      }
    }
  }
};
