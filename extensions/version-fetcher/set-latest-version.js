/* Example:
antora:
  extensions:
  - require: ./extensions/setLatestVersion.js
*/

const GetLatestRedpandaVersion = require('./getLatestRedpandaVersion');
const GetLatestConsoleVersion = require('./getLatestConsoleVersion');
const chalk = require('chalk')


module.exports.register = function ({ config }) {
  const logger = this.getLogger('set-latest-version-extension')
  if (!process.env.REDPANDA_GITHUB_TOKEN) {
    logger.warn('REDPANDA_GITHUB_TOKEN environment variable not set. Attempting unauthenticated request.');
  }
  this
    .on('playbookBuilt', async ({ playbook }) => {
      try {
        const LatestConsoleVersion = await GetLatestConsoleVersion();
        if (!LatestConsoleVersion) {
          logger.warn(`Failed to get latest Console version from GitHub`)
          return
        }
        if (!playbook.asciidoc) {
          playbook.asciidoc = {};
        }

        if (!playbook.asciidoc.attributes) {
          playbook.asciidoc.attributes = {};
        }
        playbook.asciidoc.attributes['latest-console-version'] = LatestConsoleVersion
        console.log(`${chalk.green('Set Redpanda Console version to')} ${chalk.bold(LatestConsoleVersion)}`);
      } catch(error) {
        logger.warn(error)
      }
    })
    .on('contentClassified', async ({ contentCatalog }) => {
      try {
        const LatestRedpandaVersion = await GetLatestRedpandaVersion();
        const components = await contentCatalog.getComponents();
        for (let i = 0; i < components.length; i++) {
          let component = components[i];
          if (LatestRedpandaVersion.length !== 2 || !LatestRedpandaVersion[0]) {
            logger.warn('Failed to get the latest Redpanda versions - using defaults');
            return
          }
          if (component.name === 'ROOT') {

            if (!component.latest.asciidoc) {
              component.latest.asciidoc = {};
            }

            if (!component.latest.asciidoc.attributes) {
              component.latest.asciidoc.attributes = {};
            }

            component.latest.asciidoc.attributes['full-version'] = `${LatestRedpandaVersion[0]}`;
            component.latest.asciidoc.attributes['latest-release-commit'] = `${LatestRedpandaVersion[1]}`;
            console.log(`${chalk.green('Set Redpanda version to')} ${chalk.bold(LatestRedpandaVersion[0])} ${chalk.bold(LatestRedpandaVersion[1])}`)
          }
        }
      } catch(error) {
        logger.warn(error)
      }
    })
}