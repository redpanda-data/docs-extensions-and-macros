/* Example use in the playbook
* antora:
    extensions:
 *    - require: ./extensions/add-global-attributes.js
       org: example
       repo: test
       branch: main
*/

const yaml = require('js-yaml');
const fetch = require('node-fetch');

module.exports.register = function ({ config }) {
  const logger = this.getLogger('global-attributes-extension')
  this
    .on('playbookBuilt', async ({ playbook }) => {

      const globalAttributesUrl = `https://api.github.com/repos/${config.org}/${config.repo}/contents/global-attributes?ref=${config.branch}`;


      // Request the contents of the directory from the GitHub API
      const response = await fetch(globalAttributesUrl, {
        headers: { 'Accept': 'application/vnd.github.v3+json' }
      });

      if (response.ok) {
        const directoryContents = await response.json();

        // Filter out only YAML files
        const yamlFiles = directoryContents.filter(file => file.name.endsWith('.yaml') || file.name.endsWith('.yml'));

        let globalAttributes = {};
        for (let file of yamlFiles) {
          // Request each file and parse its YAML content
          const fileResponse = await fetch(file.download_url);
          const fileContent = await fileResponse.text();
          const fileData = yaml.load(fileContent);
          globalAttributes = {...globalAttributes, ...fileData};
        }

        // Merge the global attributes with the playbook's asciidoc.attributes object
        playbook.asciidoc.attributes = {...globalAttributes, ...playbook.asciidoc.attributes};

      } else {
        logger.warn(`Could not fetch global attributes: ${response.statusText}`);
        return
      }

      console.log('Merged global attributes into playbook');
    });
}
