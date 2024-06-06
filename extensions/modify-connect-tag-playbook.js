'use strict';

const GetLatestConnectTag = require('./version-fetcher/get-latest-connect')

module.exports.register = function ({ config }) {
  const logger = this.getLogger('modify-connect-tag-playbook-extension');

  this.on('contextStarted', async ({ playbook }) => {
    try {
      // Fetch the latest release tag for redpanda-data/connect
      const latestTag = await GetLatestConnectTag();

      // Update the playbook with the latest tag
      const newPlaybook = JSON.parse(JSON.stringify(playbook));
      newPlaybook.content.sources.forEach((source) => {
        if (source.url === 'https://github.com/redpanda-data/connect' && latestTag) {
          source.tags[0] = latestTag;
        }
      });
      this.updateVariables({ playbook: newPlaybook });
    } catch (error) {
      console.error('Failed to update playbook with the latest Redpanda Connect tag:', error);
    }
  });
}
