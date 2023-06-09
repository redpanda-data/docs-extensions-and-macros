'use strict'

const generateIndex       = require('./generate-index')
const chalk               = require('chalk')
const algoliasearch       = require('algoliasearch');
const fs                  = require('fs');
const path                = require('path');

/**
 * Algolia indexing for an Antora documentation site.
 *
 * @module antora-algolia-indexer
 */
function register ({
  config: {
    languages,
    indexLatestOnly,
    excludes = ['.thumbs','script', '.page-versions','.feedback-section','.banner-container'],
    snippetLength = 100,
    ...unknownOptions
  }
}) {
  const logger = this.getLogger('algolia-indexer')

  var algoliaIsEnabled = false;
  if (process.env.ALGOLIA_ADMIN_API_KEY) algoliaIsEnabled = true

  var client;
  var index;

  if (algoliaIsEnabled) {
    // Connect and authenticate with Algolia
    client = algoliasearch(process.env.ALGOLIA_APP_ID, process.env.ALGOLIA_ADMIN_API_KEY);

    // Create a new index and add a record
    index = client.initIndex(process.env.ALGOLIA_INDEX_NAME);
  }

  if (Object.keys(unknownOptions).length) {
    const keys = Object.keys(unknownOptions)
    throw new Error(`Unrecognized option${keys.length > 1 ? 's' : ''} specified for ${packageName}: ${keys.join(', ')}`)
  }

  this.on('beforePublish', ({ playbook, siteCatalog, contentCatalog }) => {
    const algolia = generateIndex(playbook, contentCatalog, { indexLatestOnly, excludes, logger })
    // write the Algolia indexes
    var algoliaCount = 0
    Object.keys(algolia).forEach((c) => {
      Object.keys(algolia[c]).forEach((v) => {
        algoliaCount += algolia[c][v].length
        if (algoliaIsEnabled) {
          // Save all records to the index
          index.saveObjects(algolia[c][v]).wait();
        }
        siteCatalog.addFile({
          mediaType: 'application/json',
          contents: Buffer.from(
            JSON.stringify(algolia[c][v])
          ),
          src: { stem: `algolia-${c}` },
          out: { path: `algolia-${c}-${v}.json` },
          pub: { url: `/algolia-${c}-${v}.json`, rootPath: '' },
        })
      })
    })
    if (algoliaIsEnabled) {
      index.setSettings({
        attributesForFaceting: [
          'version',
          'product'
        ]
      })
      console.log(`${chalk.bold(algoliaCount)} Algolia index entries created`)
      // Get and print the count of all records in the index
      let recordCount = 0;
      index
        .browseObjects({
          query: '', // for all records
          batch: batch => {
            recordCount += batch.length;
          }
        })
        .then(() => {
          console.log('Total Records:', recordCount);
        })
        .catch(err => console.log(err));
    }
  })
}

module.exports = { generateIndex, register }

