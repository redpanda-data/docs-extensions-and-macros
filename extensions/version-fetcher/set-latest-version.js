/* Example:
antora:
  extensions:
  - require: ./extensions/setLatestVersion.js
*/

const GetLatestRedpandaVersion = require('./getLatestRedpandaVersion');
const GetLatestConsoleVersion = require('./getLatestConsoleVersion');

module.exports.register = function ({ config }) {
  const logger = this.getLogger('set-latest-version-extension')
  if (!process.env.REDPANDA_GITHUB_TOKEN) {
    logger.warn('REDPANDA_GITHUB_TOKEN environment variable not set. Attempting unauthenticated request.');
  }
  this
    .on('playbookBuilt', async ({ playbook }) => {
      try {
        const LatestConsoleVersion = await GetLatestConsoleVersion();
        if (!playbook.asciidoc) {
          playbook.asciidoc = {};
        }

        if (!playbook.asciidoc.attributes) {
          playbook.asciidoc.attributes = {};
        }
        playbook.asciidoc.attributes['latest-console-version'] = LatestConsoleVersion
        console.log(`Set Redpanda Console version to ${LatestConsoleVersion}`);
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
          if (LatestRedpandaVersion.length !== 2) logger.warn('Could not find the latest Redpanda versions - using defaults');
          if (component.name === 'ROOT') {

            if (!component.latest.asciidoc) {
              component.latest.asciidoc = {};
            }

            if (!component.latest.asciidoc.attributes) {
              component.latest.asciidoc.attributes = {};
            }

            component.latest.asciidoc.attributes['full-version'] = `${LatestRedpandaVersion[0]}`;
            component.latest.asciidoc.attributes['latest-release-commit'] = `${LatestRedpandaVersion[1]}`;
            console.log(`Set Redpanda version to ${LatestRedpandaVersion[0]} ${LatestRedpandaVersion[1]}`)
          }
        }
      } catch(error) {
        logger.warn(error)
      }
    })
}