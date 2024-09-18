/* Example use in the playbook
* antora:
    extensions:
 *    - require: ./extensions/generate-rp-connect-info.js
*/

'use strict'
const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

const CSV_PATH = 'redpanda_connect.csv'
const GITHUB_OWNER = 'redpanda-data'
const GITHUB_REPO = 'rp-connect-docs'
const GITHUB_REF = 'main'

module.exports.register = function ({ config }) {
  const logger = this.getLogger('redpanda-connect-info-extension');

  async function loadOctokit() {
    const { Octokit } = await import('@octokit/rest');
    if (!process.env.REDPANDA_GITHUB_TOKEN) return new Octokit()
    return new Octokit({
      auth: process.env.REDPANDA_GITHUB_TOKEN,
    });
  }

  this.once('contentClassified', async ({ contentCatalog }) => {
    const redpandaConnect = contentCatalog.getComponents().find(component => component.name === 'redpanda-connect');
    const redpandaCloud = contentCatalog.getComponents().find(component => component.name === 'redpanda-cloud');
    if (!redpandaConnect) return;
    const pages = contentCatalog.getPages();

    try {
      // Fetch CSV data (either from local file or GitHub)
      const csvData = await fetchCSV(config.csvpath);
      const parsedData = Papa.parse(csvData, { header: true, skipEmptyLines: true });
      const enrichedData = enrichCsvDataWithUrls(parsedData, pages, logger);
      parsedData.data = enrichedData;

      if (redpandaConnect) {
        redpandaConnect.latest.asciidoc.attributes.csvData = parsedData;
      }
      if (redpandaCloud) {
        redpandaCloud.latest.asciidoc.attributes.csvData = parsedData;
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
   * This function enriches the parsed CSV data with URLs for Redpanda Connect and Redpanda Cloud.
   * It processes each row from the parsed CSV, checks if cloud support is available, and then appends
   * the corresponding URLs from the pages provided for both Redpanda Connect and Redpanda Cloud.
   * 
   * Expected data structure for each row in the CSV:
   * 
   * {
   *   "connector": "workflow",                   // The unique name of the connector.
   *   "type": "processor",                       // The type of connector.
   *   "commercial_name": "workflow",             // The commercial name of the connector.
   *   "available_connect_version": "0.0.0",      // The version of Redpanda Connect that supports this connector.
   *   "support_level": "certified",              // Support level for the connector (e.g., 'certified', 'community').
   *   "deprecated": "n",                         // 'y' if the connector is deprecated, 'n' otherwise.
   *   "is_cloud_supported": "y",                 // 'y' if supported on Redpanda Cloud, 'n' otherwise.
   *   "cloud_ai": "y",                           // 'y' if cloud-specific AI features are supported.
   *   "is_licensed": "n",                        // 'y' if the connector requires an enterprise license.
   * }
   *
   * The function enriches this structure with two additional fields:
   * - `redpandaConnectUrl`: The URL to the connector's page on Redpanda Connect.
   * - `redpandaCloudUrl`: The URL to the connector's page on Redpanda Cloud (if cloud support is available).
   *
   * @param {object} parsedData - The CSV data parsed into an object. Contains the connector details.
   * @param {array} pages - The list of pages to map the URLs, where the URLs for Redpanda Connect and Redpanda Cloud are found.
   * @param {object} logger - The logger used for error handling.
   *
   * @returns {array} - The enriched data, where each row contains the original CSV data and additional URLs:
   *
   * [
   *   {
   *     "connector": "workflow",
   *     "type": "processor",
   *     "commercial_name": "workflow",
   *     "available_connect_version": "0.0.0",
   *     "support_level": "certified",
   *     "deprecated": "n",
   *     "is_cloud_supported": "y",
   *     "cloud_ai": "y",
   *     "is_licensed": "n",
   *     "redpandaConnectUrl": "/redpanda-connect/components/processors/workflow/", // URL for Redpanda Connect.
   *     "redpandaCloudUrl": "/redpanda-cloud/develop/connect/components/processors/workflow/" // URL for Redpanda Cloud (if supported).
   *   },
   *   ...
   * ]
   */
  function enrichCsvDataWithUrls(parsedData, pages, logger) {
    return parsedData.data.map(row => {
      // Create a new object with trimmed keys and values
      const trimmedRow = Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key.trim(), value.trim()])
      );
      const connector = trimmedRow.connector;
      const type = trimmedRow.type;
      const isCloudSupported = trimmedRow.is_cloud_supported === 'y'; // Check cloud support

      // Variables for the Redpanda Connect and Cloud URLs
      let redpandaConnectUrl = '';
      let redpandaCloudUrl = '';

      // Iterate over all pages to look for both Redpanda Connect and Cloud URLs
      for (const file of pages) {
        const component = file.src.component;
        const filePath = file.path;

        // Check for Redpanda Connect URLs
        if (
          component === 'redpanda-connect' &&
          filePath.endsWith(`${connector}.adoc`) &&
          filePath.includes(`pages/${type}s/`)
        ) {
          redpandaConnectUrl = file.pub.url;
        }

        // Only check for Redpanda Cloud URLs if cloud is supported
        if (
          isCloudSupported &&
          component === 'redpanda-cloud' &&
          filePath.endsWith(`${connector}.adoc`) &&
          filePath.includes(`${type}s/`)
        ) {
          redpandaCloudUrl = file.pub.url;
        }
      }

      // Log a warning if neither URL was found (only warn for missing cloud if it should support cloud)
      if (!redpandaConnectUrl && (!redpandaCloudUrl && isCloudSupported)) {
        logger.warn(`No matching URL found for connector: ${connector} of type: ${type}`);
      }

      // Return enriched data with both URLs
      return {
        ...trimmedRow,
        redpandaConnectUrl,
        redpandaCloudUrl,
      };
    });
  }
}