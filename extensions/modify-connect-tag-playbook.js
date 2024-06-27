'use strict';

const GetLatestConnectTag = require('./version-fetcher/get-latest-connect');

module.exports.register = function ({ config }) {
  const logger = this.getLogger('modify-connect-tag-playbook-extension');

  this.on('contextStarted', async ({ playbook }) => {
    try {
      // Fetch the latest release tag for redpanda-data/connect
      const sourceUrl = 'https://github.com/redpanda-data/connect';
      if (playbook && playbook.content && playbook.content.sources) {
        const source = playbook.content.sources.find(source => source.url === sourceUrl);
        if (source) {
          const latestTag = await GetLatestConnectTag();
          if (latestTag) {
            source.tags[0] = `v${latestTag}`;
            this.updateVariables({ playbook });
          }
        }
      }
    } catch (error) {
      console.error('Failed to update playbook with the latest Redpanda Connect tag:', error);
    }
  });
}
