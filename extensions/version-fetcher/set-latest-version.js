'use strict';

const { raiseListenerLimit } = require('../util/raise-listener-limit')

module.exports.register = function ({ config }) {
  raiseListenerLimit(this)
  const GetLatestRedpandaVersion = require('./get-latest-redpanda-version');
  const GetLatestDockerTag = require('./fetch-latest-docker-tag');
  const GetLatestHelmChartVersionFromOperator = require('./get-latest-redpanda-helm-version-from-operator');
  const GetLatestConnectVersion = require('./get-latest-connect');
  const logger = this.getLogger('set-latest-version-extension');

  const { getGitHubToken } = require('../../cli-utils/github-token');
  // Shared with tools/bundle-openapi.js so there is one major.minor derivation.
  const { toShortVersion } = require('../../cli-utils/version');
  const token = getGitHubToken();

  if (!token) {
    logger.warn('GitHub token not set (REDPANDA_GITHUB_TOKEN, GITHUB_TOKEN, or GH_TOKEN). Attempting unauthenticated request.');
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
      auth: token || undefined,
    };
    const github = new OctokitWithRetries(githubOptions);
    const dockerNamespace = 'redpandadata'

    try {
      const [
        latestRedpandaResult,
        latestConsoleResult,
        latestOperatorResult,
        latestConnectResult,
      ] = await Promise.allSettled([
        GetLatestRedpandaVersion(github, owner, 'redpanda', logger),
        GetLatestDockerTag(dockerNamespace, 'console', logger),
        GetLatestDockerTag(dockerNamespace, 'redpanda-operator', logger),
        GetLatestConnectVersion(github, owner, 'connect', logger),
      ]);
      
      // Get the Helm chart version after we have the operator version (for both stable and beta)
      let latestHelmChartResult = { status: 'rejected', reason: 'Operator result not fulfilled' };
      
      if (latestOperatorResult.status === 'fulfilled') {
        try {
          const helmChartVersions = await GetLatestHelmChartVersionFromOperator(
            github,
            owner,
            'redpanda-operator',
            latestOperatorResult.value?.latestStableRelease,
            latestOperatorResult.value?.latestBetaRelease,
            logger
          );
          
          latestHelmChartResult = { 
            status: 'fulfilled', 
            value: helmChartVersions 
          };
        } catch (error) {
          latestHelmChartResult = { 
            status: 'rejected', 
            reason: error.message || 'Unknown error fetching Helm chart version'
          };
          logger.error(`Helm chart lookup failed: ${error.message || error}`);
        }
      } else {
        logger.error(`Helm chart lookup failed: Operator version not available`);
      }

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

          // Set operator and helm chart attributes via helper function. These keep
          // their raw fetched form, including the "v" prefix on
          // latest-operator-version, because docs pages pass that value straight
          // to `helm --version`. Only the short sibling is derived.
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
            if (latestVersions.redpanda.latestRcRelease.commitHash) {
              asciidoc.attributes['redpanda-beta-commit'] = latestVersions.redpanda.latestRcRelease.commitHash;
            }
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

        // For the Redpanda GA release, always publish latest-redpanda-version,
        // latest-redpanda-tag, latest-redpanda-version-short and
        // latest-release-commit. They describe the newest release, so they must
        // not depend on how the component pins full-version: consuming repos seed
        // full-version at the current GA (both docs and cloud-docs sit at 26.2.1
        // today), which made the whole block unreachable and left those
        // attributes unset until Redpanda shipped something strictly newer.
        const gaRelease = latestVersions.redpanda?.latestRedpandaRelease;
        if (semver.valid(gaRelease?.version)) {
          setVersionAndTagAttributes(component.latest.asciidoc, 'latest-redpanda', gaRelease.version, component.latest.name, component.latest.version);
          // An unresolvable tag leaves the commit hash null. Leave any antora.yml
          // fallback in place rather than overwriting it with nothing.
          if (gaRelease.commitHash) {
            component.latest.asciidoc.attributes['latest-release-commit'] = gaRelease.commitHash;
          }

          // Required for backwards compatibility. Some docs still use full-version,
          // and treat it as a floor, so only ever move it forwards. An unparseable
          // pin counts as no pin, otherwise semver.gt throws and aborts the run.
          const pinnedVersion = component.latest.asciidoc.attributes['full-version'];
          if (!semver.valid(pinnedVersion) || semver.gt(gaRelease.version, pinnedVersion)) {
            component.latest.asciidoc.attributes['full-version'] = sanitizeVersion(gaRelease.version);
          }
        }
      });

      // Report what resolved and what did not. A failed lookup resolves to a null
      // release rather than rejecting, so dereferencing it here used to throw and
      // replace the real cause with a bare TypeError from the logger.
      const summary = [
        ['Redpanda', latestVersions.redpanda?.latestRedpandaRelease?.version, latestVersions.redpanda?.latestRcRelease?.version],
        ['Connect', latestVersions.connect],
        ['Console', latestVersions.console?.latestStableRelease, latestVersions.console?.latestBetaRelease],
        ['Operator', latestVersions.operator?.latestStableRelease, latestVersions.operator?.latestBetaRelease],
        ['Helm chart', latestVersions.helmChart?.latestStableRelease, latestVersions.helmChart?.latestBetaRelease],
      ];
      const unresolved = summary.filter(([, stableVersion]) => !stableVersion).map(([label]) => label);
      if (unresolved.length) {
        logger.error(`Could not resolve the latest version of: ${unresolved.join(', ')}. Pages that reference the matching attributes render the attribute name instead of a version unless antora.yml seeds a fallback.`);
        logger.info('Updated Redpanda documentation versions with gaps:');
      } else {
        logger.info('Updated Redpanda documentation versions successfully:');
      }
      summary.forEach(([label, stableVersion, betaVersion]) => {
        logger.info(`- ${label}: ${stableVersion || 'unknown'}${betaVersion ? ', beta: ' + betaVersion : ''}`);
      });
    } catch (error) {
      logger.error(`Error updating versions: ${error}`);
    }
  });

  // Helper function to set latest-*version, latest-*tag, and latest-*version-short attributes
  function setVersionAndTagAttributes(asciidoc, baseName, versionData, name = '', version = '') {
    if (versionData) {
      const versionWithoutPrefix = sanitizeVersion(versionData);
      asciidoc.attributes[`${baseName}-version`] = versionWithoutPrefix; // Without "v" prefix
      asciidoc.attributes[`${baseName}-tag`] = `${versionData}`;

      setShortVersionAttribute(asciidoc, `${baseName}-version`, versionWithoutPrefix);

      if (name && version) {
        logger.debug(`Set ${baseName}-version to ${versionWithoutPrefix} and ${baseName}-tag to ${versionData} in ${name} ${version}`);
      } else {
        logger.debug(`Updated ${baseName}-version to ${versionWithoutPrefix} and ${baseName}-tag to ${versionData}`);
      }
    }
  }

  // Helper function to set the major.minor sibling of a *-version attribute (for
  // example, latest-operator-version v25.1.3 -> latest-operator-version-short
  // 25.1). Release channels that are not versions (for example, nightly) get no
  // short attribute rather than a misleading one.
  function setShortVersionAttribute(asciidoc, versionKey, versionData) {
    if (!versionData || typeof versionData !== 'string') return;
    if (!versionKey.endsWith('-version')) return;
    const shortVersion = toShortVersion(sanitizeVersion(versionData));
    if (shortVersion) {
      asciidoc.attributes[`${versionKey}-short`] = shortVersion;
    }
  }

  // Helper function to sanitize version by removing "v" prefix
  function sanitizeVersion(version) {
    return version.replace(/^v/, '');
  }

  // Helper function to update multiple attributes based on a list of mappings.
  // Gated on the value, not just the condition: gating on the enclosing object
  // alone assigned `undefined` whenever the fetch returned an object without
  // the field, and that clobbered the antora.yml fallback instead of falling
  // back to it. The visible symptom was a literal {latest-operator-version} in
  // the published release-notes pages.
  function updateAttributes(asciidoc, mappings) {
    mappings.forEach(({ condition, key, value }) => {
      if (condition && value) {
        asciidoc.attributes[key] = value;
        setShortVersionAttribute(asciidoc, key, value);
      }
    });
  }
};