'use strict'
const https = require('https');
const Papa = require('papaparse');

//const csvUrl = 'https://raw.githubusercontent.com/redpanda-data/rp-connect-docs/connect-csv/redpanda_connect.csv';
const csvUrl = 'https://localhost:3000/csv';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

module.exports.register = function ({ config,contentCatalog }) {
    const logger = this.getLogger('redpanda-connect-info-extension');

    this.once('contentClassified', async ({ siteCatalog, contentCatalog }) => {
        const redpandaConnect = contentCatalog.getComponents().find(component => component.name === 'redpanda-connect')
        const pages = contentCatalog.getPages()
        try {
            // Fetch CSV data and parse it
            const csvData = await fetchCSV(csvUrl);
            const parsedData = Papa.parse(csvData, { header: true });
            const enrichedData = enrichCsvDataWithUrls(parsedData,pages,logger);
            parsedData.data = enrichedData
            redpandaConnect.latest.asciidoc.attributes.csvData = parsedData;  
            
        } catch (error) {
            logger.error('Error fetching or parsing CSV data:', error.message);
            logger.error(error.stack);
        }
    });

    function fetchCSV(url) {
        return new Promise((resolve, reject) => {
            https.get(url, (response) => {
                let data = '';
                response.on('data', (chunk) => {
                    data += chunk;
                });
                response.on('end', () => {
                    resolve(data);
                });
            }).on('error', (error) => {
                reject(error);
                logger.error('Error fetching or parsing CSV data:', error);
            });
        });
    }

    function enrichCsvDataWithUrls(parsedData, connectPages, logger) {
        return parsedData.data.map(row => {
          const connector = row.connector;
          const type = row.type;
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
            ...row,
            url: url
          };
        });
      }
}
