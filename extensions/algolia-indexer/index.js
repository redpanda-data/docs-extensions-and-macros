'use strict'

const generateIndex = require('./generate-index')
const algoliasearch = require('algoliasearch')
const http = require('http')
const https = require('https')
const _ = require('lodash')

// Increase thread pool size for better HTTP performance
process.env.UV_THREADPOOL_SIZE = 16

/**
 * Algolia indexing for an Antora documentation site.
 *
 * @module antora-algolia-indexer
 */
function register ({
  config: {
    indexLatestOnly,
    excludes,
    ...unknownOptions
  }
}) {
  const logger = this.getLogger('algolia-indexer-extension')

  // Validate required environment variables
  const requiredEnvVars = ['ALGOLIA_ADMIN_API_KEY', 'ALGOLIA_APP_ID', 'ALGOLIA_INDEX_NAME']
  const missingVars = requiredEnvVars.filter(v => !process.env[v])

  if (missingVars.length > 0) {
    logger.info(`Algolia indexing disabled - missing environment variables: ${missingVars.join(', ')}`)
    return
  }

  // Validate unknown options
  if (Object.keys(unknownOptions).length) {
    const keys = Object.keys(unknownOptions)
    throw new Error(`Unrecognized option${keys.length > 1 ? 's' : ''} specified: ${keys.join(', ')}`)
  }

  // Create HTTP agents with connection pooling
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 })
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 })

  // Connect and authenticate with Algolia
  const client = algoliasearch(process.env.ALGOLIA_APP_ID, process.env.ALGOLIA_ADMIN_API_KEY, {
    httpAgent: httpAgent,
    httpsAgent: httpsAgent
  })
  const index = client.initIndex(process.env.ALGOLIA_INDEX_NAME)

  this.on('beforePublish', async ({ playbook, contentCatalog }) => {
    const algolia = generateIndex(playbook, contentCatalog, { indexLatestOnly, excludes, logger })

    if (!algolia || Object.keys(algolia).length === 0) {
      logger.warn('No content to index for Algolia')
      return
    }

    const existingObjectsMap = new Map()

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
      logger.info(`Loaded ${existingObjectsMap.size} existing objects from Algolia index`)
    } catch (err) {
      logger.error(`Error browsing existing Algolia objects: ${JSON.stringify(err)}`)
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
        }))

        const updateObjectActions = objectsToUpdate.map(object => ({
          action: 'updateObject',
          indexName: process.env.ALGOLIA_INDEX_NAME,
          body: object
        }))

        const batchActions = [...addObjectActions, ...updateObjectActions]

        // FIXED: Only send batch if there are actions to perform
        if (batchActions.length > 0) {
          try {
            await client.multipleBatch(batchActions)
            logger.debug(`Batch completed: ${objectsToAdd.length} added, ${objectsToUpdate.length} updated for ${c}/${v}`)
          } catch (error) {
            logger.error(`Error uploading records to Algolia: ${error.message}`)
          }
        }
      }
    }

    // Identify objects to delete (stale content)
    for (const [objectID, obj] of existingObjectsMap) {
      // Only delete Doc pages (not API) and Labs that aren't interactive
      const shouldDelete = (obj.type === 'Doc' && !obj.objectID.includes('/api/')) ||
                          (!obj.type) ||
                          (obj.type === 'Lab' && !obj.interactive)

      if (shouldDelete) {
        objectsToDelete.push(objectID)
      }
    }

    if (objectsToDelete.length > 0) {
      logger.info(`Deleting ${objectsToDelete.length} outdated records...`)
      logger.debug(`Objects to delete: ${JSON.stringify(objectsToDelete)}`)

      try {
        await index.deleteObjects(objectsToDelete)
        logger.info(`Successfully deleted ${objectsToDelete.length} outdated records`)
      } catch (error) {
        logger.error(`Error deleting records from Algolia: ${error.message}`)
      }
    }

    // Summary
    logger.info(`Algolia sync complete: ${totalObjectsToAdd} added, ${totalObjectsToUpdate} updated, ${objectsToDelete.length} deleted`)

    if (totalObjectsToAdd === 0 && totalObjectsToUpdate === 0 && objectsToDelete.length === 0) {
      logger.info('Index is up to date - no changes needed')
    }
  })

  // Cleanup HTTP agents on process exit
  // NOTE: This registers a global handler. In watch mode, agents will persist
  // between builds, which is generally fine for connection reuse.
  process.on('exit', () => {
    httpAgent.destroy()
    httpsAgent.destroy()
  })
}

module.exports = { generateIndex, register }
