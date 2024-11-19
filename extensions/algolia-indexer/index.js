'use strict'

const generateIndex = require('./generate-index')
const algoliasearch = require('algoliasearch')
const http = require('http')
const https = require('https')
const _ = require('lodash')
process.env.UV_THREADPOOL_SIZE=16

/**
 * Algolia indexing for an Antora documentation site.
 *
 * @module antora-algolia-indexer
 */
function register({
  config: {
    indexLatestOnly,
    excludes,
    ...unknownOptions
  }
}) {
  const logger = this.getLogger('algolia-indexer-extension')

  if (!process.env.ALGOLIA_ADMIN_API_KEY || !process.env.ALGOLIA_APP_ID || !process.env.ALGOLIA_INDEX_NAME) return

  var client
  var index

  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

  // Connect and authenticate with Algolia using the custom agent
  client = algoliasearch(process.env.ALGOLIA_APP_ID, process.env.ALGOLIA_ADMIN_API_KEY, {
    httpAgent: httpAgent,
    httpsAgent: httpsAgent
  })
  index = client.initIndex(process.env.ALGOLIA_INDEX_NAME)

  if (Object.keys(unknownOptions).length) {
    const keys = Object.keys(unknownOptions)
    throw new Error(`Unrecognized option${keys.length > 1 ? 's' : ''} specified: ${keys.join(', ')}`)
  }

  this.on('beforePublish', async ({ playbook, siteCatalog, contentCatalog }) => {
    const algolia = generateIndex(playbook, contentCatalog, { indexLatestOnly, excludes, logger })
    let existingObjectsMap = new Map()

    // Save objects in a local cache to query later.
    // Avoids sending multiple requests.
    // browseObjects does not affect analytics or usage limits.
    // See https://www.algolia.com/doc/api-reference/api-methods/browse/#about-this-method
    try {
      await index.browseObjects({
        query: '',
        batch: batch => {
          for (const obj of batch) {
            existingObjectsMap.set(obj.objectID, obj)
          }
        }
      })
    } catch (err) {
      logger.error(JSON.stringify(err))
    }

    let totalObjectsToUpdate = 0
    let totalObjectsToAdd = 0
    const objectsToDelete = []

    for (const c of Object.keys(algolia)) {
      for (const v of Object.keys(algolia[c])) {
        const objectsToUpdate = []
        const objectsToAdd = []

        for (const obj of algolia[c][v]) {
          const existingObject = existingObjectsMap.get(obj.objectID)

          if (existingObject) {
            if (!_.isEqual(existingObject, obj)) {
              objectsToUpdate.push(obj)
              totalObjectsToUpdate++
            }
            existingObjectsMap.delete(obj.objectID)
          } else {
            objectsToAdd.push(obj)
            totalObjectsToAdd++
          }
        }

        const addObjectActions = objectsToAdd.map(object => ({
          action: 'addObject',
          indexName: process.env.ALGOLIA_INDEX_NAME,
          body: object
        }));

        const updateObjectActions = objectsToUpdate.map(object => ({
          action: 'updateObject',
          indexName: process.env.ALGOLIA_INDEX_NAME,
          body: object
        }));

        const batchActions = [...addObjectActions, ...updateObjectActions];

        // Upload new records only if the objects have been updated or they are new.
        // See https://www.algolia.com/doc/api-reference/api-methods/batch/?client=javascript
        await client.multipleBatch(batchActions).then(() => {
          console.log('Batch operations completed successfully');
        }).catch(error => {
          logger.error(`Error uploading records to Algolia: ${error.message}`);
        });
      }
    }

    for (const [objectID, obj] of existingObjectsMap) {
      if ((obj.type === 'Doc' && !obj.objectID.includes('/api/')) || (!obj.type) || (obj.type === 'Lab' && !obj.interactive)) {
        objectsToDelete.push(objectID)
      }
    }
    if (objectsToDelete.length > 0) {
      console.log(objectsToDelete)
      await index.deleteObjects(objectsToDelete).then(() => {
        console.log(`Deleted ${objectsToDelete.length} outdated records`);
      }).catch(error => {
        logger.error(`Error deleting records from Algolia: ${error.message}`);
      });
    }

    logger.info('Updated records:' + totalObjectsToUpdate)
    logger.info('New records:' + totalObjectsToAdd)

    totalObjectsToAdd === 0 && totalObjectsToUpdate === 0 && logger.info('No new records uploaded or existing records updated')
  })

  process.on('exit', () => {
    httpAgent.destroy()
    httpsAgent.destroy()
  })
}

module.exports = { generateIndex, register }
