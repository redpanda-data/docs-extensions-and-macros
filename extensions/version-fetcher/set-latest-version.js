const GetLatestRedpandaVersion = require('./get-latest-redpanda-version')
const GetLatestConsoleVersion = require('./get-latest-console-version')
const GetLatestOperatorVersion = require('./get-latest-operator-version')
const GetLatestHelmChartVersion = require('./get-latest-redpanda-helm-version')
const GetLatestConnectVersion = require('./get-latest-connect')
const chalk = require('chalk')
const semver = require('semver')

module.exports.register = function ({ config }) {
  const logger = this.getLogger('set-latest-version-extension')
  if (!process.env.REDPANDA_GITHUB_TOKEN) {
    logger.warn('REDPANDA_GITHUB_TOKEN environment variable not set. Attempting unauthenticated request.')
  }

  this.on('contentClassified', async ({ contentCatalog }) => {
    try {
      const results = await Promise.allSettled([
        GetLatestRedpandaVersion(),
        GetLatestConsoleVersion(),
        GetLatestOperatorVersion(),
        GetLatestHelmChartVersion(),
        GetLatestConnectVersion()
      ])

      const LatestRedpandaVersion = results[0].status === 'fulfilled' ? results[0].value : null
      const LatestConsoleVersion = results[1].status === 'fulfilled' ? results[1].value : null
      const LatestOperatorVersion = results[2].status === 'fulfilled' ? results[2].value : null
      const LatestHelmChartVersion = results[3].status === 'fulfilled' ? results[3].value : null
      const LatestConnectVersion = results[4].status === 'fulfilled' ? results[4].value : null

      const components = await contentCatalog.getComponents()
      components.forEach(component => {
        component.versions.forEach(({ name, version, asciidoc }) => {
          if (LatestConsoleVersion) {
            asciidoc.attributes['latest-console-version'] = `${LatestConsoleVersion}@`
            logger.info(`Set Redpanda Console version to ${LatestConsoleVersion} in ${name} ${version}`)
          }
          if (LatestConnectVersion) {
            asciidoc.attributes['latest-connect-version'] = `${LatestConnectVersion}@`
            logger.info(`Set Redpanda Connect version to ${LatestConnectVersion} in ${name} ${version}`)
          }
          if (LatestRedpandaVersion && LatestRedpandaVersion.latestRcRelease) {
            asciidoc.attributes['redpanda-beta-version'] = `${LatestRedpandaVersion.latestRcRelease.version}@`
            asciidoc.attributes['redpanda-beta-commit'] = `${LatestRedpandaVersion.latestRcRelease.commitHash}@`
            logger.info(`Updated to latest Redpanda RC version: ${LatestRedpandaVersion.latestRcRelease.version} with commit: ${LatestRedpandaVersion.latestRcRelease.commitHash}`)
        }
        })

        if (!component.latest.asciidoc) {
          component.latest.asciidoc = { attributes: {} }
        }

        if (LatestRedpandaVersion && semver.valid(LatestRedpandaVersion.latestRedpandaRelease.version)) {
          let currentVersion = component.latest.asciidoc.attributes['full-version'] || '0.0.0'
          if (semver.gt(LatestRedpandaVersion.latestRedpandaRelease.version, currentVersion)) {
            component.latest.asciidoc.attributes['full-version'] = `${LatestRedpandaVersion.latestRedpandaRelease.version}@`
            component.latest.asciidoc.attributes['latest-release-commit'] = `${LatestRedpandaVersion.latestRedpandaRelease.commitHash}@`
            logger.info(`Updated to latest Redpanda version: ${LatestRedpandaVersion.latestRedpandaRelease.version} with commit: ${LatestRedpandaVersion.latestRedpandaRelease.commitHash}`)
          }
        }

        if (LatestOperatorVersion) {
          component.latest.asciidoc.attributes['latest-operator-version'] = `${LatestOperatorVersion}@`
          logger.info(`Updated to latest Redpanda Operator version: ${LatestOperatorVersion}`)
        }

        if (LatestHelmChartVersion) {
          component.latest.asciidoc.attributes['latest-redpanda-helm-chart-version'] = `${LatestHelmChartVersion}@`
          logger.info(`Updated to latest Redpanda Helm chart version: ${LatestHelmChartVersion}`)
        }
      })

      console.log(`${chalk.green('Updated Redpanda documentation versions successfully.')}`)
    } catch (error) {
      logger.error(`Error updating versions: ${error}`)
    }
  })
}