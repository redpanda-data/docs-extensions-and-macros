'use strict'
const https = require('https');
const Papa = require('papaparse');

const CSV_PATH = 'redpanda_connect.csv'
const GITHUB_OWNER = 'redpanda-data'
const GITHUB_REPO = 'rp-connect-docs'
const GITHUB_REF = 'connect-csv'
/* const csvUrl = 'https://localhost:3000/csv';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; */

module.exports.register = function ({ config,contentCatalog }) {
    const logger = this.getLogger('redpanda-connect-info-extension');

  async function loadOctokit() {
    const { Octokit } = await import('@octokit/rest');
    if (!process.env.REDPANDA_GITHUB_TOKEN) return new Octokit()
    return new Octokit({
      auth: process.env.REDPANDA_GITHUB_TOKEN,
    });
  }

  this.once('contentClassified', async ({ siteCatalog, contentCatalog }) => {
    const redpandaConnect = contentCatalog.getComponents().find(component => component.name === 'redpanda-connect')
    const redpandaCloud = contentCatalog.getComponents().find(component => component.name === 'redpanda-cloud')
    if (!redpandaConnect) return
    const pages = contentCatalog.getPages()
    try {
      // Fetch CSV data and parse it
      const csvData = await fetchCSV();
      const parsedData = Papa.parse(csvData, { header: true, skipEmptyLines: true });
      const enrichedData = enrichCsvDataWithUrls(parsedData, pages, logger);
      parsedData.data = enrichedData
      if(redpandaConnect)
        redpandaConnect.latest.asciidoc.attributes.csvData = parsedData;
      if(redpandaCloud)
        redpandaCloud.latest.asciidoc.attributes.csvData = parsedData;

    } catch (error) {
      logger.error('Error fetching or parsing CSV data:', error.message);
      logger.error(error.stack);
    }
  });

  async function fetchCSV() {
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
      return [];
    }
  }

  function enrichCsvDataWithUrls(parsedData, connectPages, logger) {
    return parsedData.data.map(row => {
      // Create a new object with trimmed keys and values
      const trimmedRow = Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key.trim(), value.trim()])
      );
      const connector = trimmedRow.connector;
      const type = trimmedRow.type;
      let url = '';
      for (const file of connectPages) {
        const filePath = file.path;
        if (filePath.endsWith(`${connector}.adoc`) && filePath.includes(`pages/${type}s/`)) {
          url = `../${type}s/${connector}`;
          break;
        }
      }
      if (!url) {
        logger.warn(`No matching URL found for connector: ${connector} of type: ${type}`);
      }
      return {
        ...trimmedRow,
        url: url
      };
    });
  }
}
