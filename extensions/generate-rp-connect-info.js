'use strict'
const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

const CSV_PATH = 'internal/plugins/info.csv'
const GITHUB_OWNER = 'redpanda-data'
const GITHUB_REPO = 'connect'
const GITHUB_REF = 'main'

module.exports.register = function ({ config }) {
  const logger = this.getLogger('redpanda-connect-info-extension');

  async function loadOctokit() {
    const { Octokit } = await import('@octokit/rest');
    const { getGitHubToken } = require('../cli-utils/github-token')
    const token = getGitHubToken()
    return token ? new Octokit({ auth: token }) : new Octokit();
  }

  this.once('contentClassified', async ({ contentCatalog }) => {
    const redpandaConnect = contentCatalog.getComponents().find(component => component.name === 'redpanda-connect');
    const redpandaCloud = contentCatalog.getComponents().find(component => component.name === 'redpanda-cloud');
    const preview = contentCatalog.getComponents().find(component => component.name === 'preview');
    if (!redpandaConnect) return;
    const pages = contentCatalog.getPages();

    try {
      // Fetch CSV data (either from local file or GitHub)
      const csvData = await fetchCSV(config.csvpath);
      const parsedData = Papa.parse(csvData, { header: true, skipEmptyLines: true });
      const enrichedData = translateCsvData(parsedData, pages, logger);
      parsedData.data = enrichedData;

      if (redpandaConnect) {
        redpandaConnect.latest.asciidoc.attributes.csvData = parsedData;
      }
      if (redpandaCloud) {
        redpandaCloud.latest.asciidoc.attributes.csvData = parsedData;
      }
      // For previewing the data on our extensions site
      if (preview) {
        preview.latest.asciidoc.attributes.csvData = parsedData;
      }

    } catch (error) {
      logger.error('Error fetching or parsing CSV data:', error.message);
      logger.error(error.stack);
    }
  });

  // Check for local CSV file first. If not found, fetch from GitHub
  async function fetchCSV(localCsvPath) {
    if (localCsvPath && fs.existsSync(localCsvPath)) {
      if (path.extname(localCsvPath).toLowerCase() !== '.csv') {
        throw new Error(`Invalid file type: ${localCsvPath}. Expected a CSV file.`);
      }
      logger.info(`Loading CSV data from local file: ${localCsvPath}`);
      return fs.readFileSync(localCsvPath, 'utf8');
    } else {
      logger.info('Local CSV file not found. Fetching from GitHub...');
      return await fetchCsvFromGitHub();
    }
  }

  // Fetch CSV data from GitHub
  async function fetchCsvFromGitHub() {
    const octokit = await loadOctokit();
    try {
      const { data: fileContent } = await octokit.rest.repos.getContent({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path: CSV_PATH,
        ref: GITHUB_REF,
      });
      return Buffer.from(fileContent.content, 'base64').toString('utf8');
    } catch (error) {
      console.error('Error fetching Redpanda Connect catalog from GitHub:', error);
      return '';
    }
  }

  /**
   * Transforms and enriches parsed CSV connector data with normalized fields and documentation URLs.
   *
   * Each row is trimmed, mapped to expected output fields, and enriched with documentation URLs for Redpanda Connect and Cloud components if available. The `support` field is normalized, and licensing information is derived. Logs a warning if documentation URLs are missing for non-deprecated, non-SQL driver connectors that indicate cloud support.
   *
   * @param {object} parsedData - Parsed CSV data containing connector rows.
   * @param {array} pages - Array of page objects used to resolve documentation URLs.
   * @param {object} logger - Logger instance for warning about missing documentation.
   * @returns {array} Array of enriched connector objects with normalized fields and URLs.
   */
  function translateCsvData(parsedData, pages, logger) {
    return parsedData.data.map(row => {
      // Create a new object with trimmed keys and values
      const trimmedRow = Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key.trim(), value.trim()])
      );

      // Map fields from the trimmed row to the desired output
      const connector = trimmedRow.name;
      const type = trimmedRow.type;
      const commercial_name = trimmedRow.commercial_name;
      const available_connect_version = trimmedRow.version;
      const deprecated = trimmedRow.deprecated.toLowerCase() === 'y' ? 'y' : 'n';
      const is_cloud_supported = trimmedRow.cloud.toLowerCase() === 'y' ? 'y' : 'n';
      const cloud_ai = trimmedRow.cloud_with_gpu.toLowerCase() === 'y' ? 'y' : 'n';
      // Handle enterprise to certified conversion and set enterprise license flag
      const originalSupport = trimmedRow.support.toLowerCase();
      const support_level = originalSupport === 'enterprise' ? 'certified' : originalSupport;
      const is_licensed = originalSupport === 'enterprise' ? 'Yes' : 'No';

      // Redpanda Connect and Cloud enrichment URLs
      let redpandaConnectUrl = '';
      let redpandaCloudUrl = '';

      function isConnectorDocPath (filePath, type) {
        const dirsToCheck = [
          `pages/${type}s/`,
          `partials/components/${type}s/`
        ];
        return dirsToCheck.some(dir => filePath.includes(dir));
      }

      function isCloudDoc(file, connector, type) {
        return (
          file.src.component === 'redpanda-cloud' &&
          file.path.includes(`connect/components/${type}s/${connector}.adoc`)
        );
      }

      // Look for both Redpanda Connect and Cloud URLs
      for (const file of pages) {
        const { component } = file.src;      // such as 'redpanda-connect'
        const { path: filePath } = file;     // such as modules/.../pages/sinks/foo.adoc

        if (
          component === 'redpanda-connect' &&
          filePath.endsWith(`/${connector}.adoc`) &&
          isConnectorDocPath(filePath, type)
        ) {
          redpandaConnectUrl = file.pub.url;
        }

        // -------------------------------------------------
        // Redpanda Cloud (only if cloud supported)
        // -------------------------------------------------
        if (is_cloud_supported === 'y' && isCloudDoc(file, connector, type)) {
          redpandaCloudUrl = file.pub.url;
        }
      }

      if (
        deprecated !== 'y' &&
        !connector.includes('sql_driver') &&
        !redpandaConnectUrl &&
        !(is_cloud_supported === 'y' && redpandaCloudUrl)
      ) {
        logger.warn(`Self-Managed docs missing for: ${connector} of type: ${type}`);
      }

      if (
        is_cloud_supported === 'y' &&
        !redpandaCloudUrl &&
        redpandaConnectUrl
      ) {
        logger.warn(`Cloud docs missing for: ${connector} of type: ${type}`);
      }

      // Return the translated and enriched row
      return {
        connector,
        type,
        commercial_name,
        available_connect_version,
        support_level,  // "enterprise" is replaced with "certified"
        deprecated,
        is_cloud_supported,
        cloud_ai,
        is_licensed,  // "Yes" if the original support level was "enterprise"
        redpandaConnectUrl,
        redpandaCloudUrl,
      };
    });
  }
}