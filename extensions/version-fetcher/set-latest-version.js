/* Example:
antora:
  extensions:
  - require: ./extensions/setLatestVersion.js
*/

const GetLatestRedpandaVersion = require('./getLatestRedpandaVersion');

module.exports.register = function ({ config }) {
  const logger = this.getLogger('set-latest-version-extension')
  if (!process.env.GITHUB_TOKEN) return
  this
    .on('contentClassified', async ({ contentCatalog }) => {
        const LatestRedpandaVersion = await GetLatestRedpandaVersion();
        const components = await contentCatalog.getComponents();
        for (let i = 0; i < components.length; i++) {
          let component = components[i];
          if (LatestRedpandaVersion.length !== 2) logger.warn('Could not find the latest Redpanda versions - using defaults');
          if (component.name === 'redpanda') {
            component.latest.asciidoc.attributes['full-version'] = `${LatestRedpandaVersion[0]}`;
            component.latest.asciidoc.attributes['latest-release-commit'] = `${LatestRedpandaVersion[1]}`;
            return components;
          }
        }
      })
}