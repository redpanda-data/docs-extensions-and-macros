/* Example use in the playbook
* antora:
    extensions:
 *    - require: ./extensions/add-global-attributes.js
       org: example
       repo: test
       branch: main
*/

const yaml = require('js-yaml');
const { Octokit } = require("@octokit/rest");
const { retry } = require("@octokit/plugin-retry");
const OctokitWithRetries = Octokit.plugin(retry);

module.exports.register = function ({ config }) {
  const logger = this.getLogger('global-attributes-extension')
  if (!process.env.GLOBAL_ATTRIBUTES_GITHUB_TOKEN) {
    logger.warn('Cannot get global attributes')
    logger.warn('GITHUB_TOKEN environment variable not set')
    return
  }
  this
    .on('playbookBuilt', async ({ playbook }) => {

      const globalAttributesUrl = `/repos/${config.org}/${config.repo}/contents/global-attributes?ref=${config.branch}`;

      const github = new OctokitWithRetries({
        userAgent: 'Redpanda Docs',
        baseUrl: 'https://api.github.com',
        auth: process.env.GLOBAL_ATTRIBUTES_GITHUB_TOKEN
      });

      // Request the contents of the directory from the GitHub API
      const response = await github.request('GET ' + globalAttributesUrl);

      if (response.status === 200) {
        const directoryContents = response.data;

        // Filter out only YAML files
        const yamlFiles = directoryContents.filter(file => file.name.endsWith('.yaml') || file.name.endsWith('.yml'));

        let globalAttributes = {};
        for (let file of yamlFiles) {
          const fileResponse = await github.request('GET ' + file.download_url);
          const fileData = yaml.load(fileResponse.data);
          globalAttributes = {...globalAttributes, ...fileData};
        }

        playbook.asciidoc.attributes = {...globalAttributes, ...playbook.asciidoc.attributes};

      } else {
        logger.warn(`Could not fetch global attributes: ${response.statusText}`);
        return
      }

      console.log('Merged global attributes into playbook');
    });
}