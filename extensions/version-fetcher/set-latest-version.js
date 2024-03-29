/* Example:
antora:
  extensions:
  - require: ./extensions/setLatestVersion.js
*/

const GetLatestRedpandaVersion = require('./get-latest-redpanda-version');
const GetLatestConsoleVersion = require('./get-latest-console-version');
const GetLatestOperatorVersion = require('./get-latest-operator-version');
const chalk = require('chalk')


module.exports.register = function ({ config }) {
  const logger = this.getLogger('set-latest-version-extension')
  if (!process.env.REDPANDA_GITHUB_TOKEN) {
    logger.warn('REDPANDA_GITHUB_TOKEN environment variable not set. Attempting unauthenticated request.');
  }
  this
    .on('contentClassified', async ({ contentCatalog }) => {
      try {
        const LatestRedpandaVersion = await GetLatestRedpandaVersion();
        const LatestConsoleVersion = await GetLatestConsoleVersion();
        const LatestOperatorVersion = await GetLatestOperatorVersion();
        if (LatestRedpandaVersion.length !== 2 || !LatestRedpandaVersion[0]) {
          logger.warn('Failed to get the latest Redpanda version - using defaults');
        }
        if (!LatestConsoleVersion) {
          logger.warn(`Failed to get latest Console version from GitHub - using default`)
        }
        if (!LatestOperatorVersion) {
          logger.warn(`Failed to get latest Operator version from GitHub - using default`)
        }
        const components = await contentCatalog.getComponents();
        for (let i = 0; i < components.length; i++) {
          let component = components[i];

          component.versions.forEach(({name, version, asciidoc}) => {
            if (LatestConsoleVersion) {
              asciidoc.attributes['latest-console-version'] = `${LatestConsoleVersion}`;
              logger.info(`Set Redpanda Console version to')} ${LatestConsoleVersion} in ${name} ${version}`);
            }
          })

          if (!component.latest.asciidoc) {
            component.latest.asciidoc = {};
          }

          if (!component.latest.asciidoc.attributes) {
            component.latest.asciidoc.attributes = {};
          }

          if (LatestRedpandaVersion.length !== 2 || !LatestRedpandaVersion[0]) continue;

          component.latest.asciidoc.attributes['full-version'] = `${LatestRedpandaVersion[0]}`;
          component.latest.asciidoc.attributes['latest-release-commit'] = `${LatestRedpandaVersion[1]}`;
          logger.info(`Set the latest Redpanda version to ${LatestRedpandaVersion[0]} ${LatestRedpandaVersion[1]}`)

          if (!LatestOperatorVersion) continue;

          component.latest.asciidoc.attributes['latest-operator-version'] = `${LatestOperatorVersion}`;
          logger.info(`Set the latest Redpanda Operator version to ${LatestOperatorVersion}`)
        }
        console.log(`${chalk.green('Set Redpanda Console version to')} ${chalk.bold(LatestConsoleVersion)}`);
        console.log(`${chalk.green('Set the latest Redpanda version to')} ${chalk.bold(LatestRedpandaVersion[0])} ${chalk.bold(LatestRedpandaVersion[1])}`)
        console.log(`${chalk.green('Set the latest Redpanda Operator version to')} ${chalk.bold(LatestOperatorVersion)}`)
      } catch(error) {
        logger.warn(error)
      }
    })
}