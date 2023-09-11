'use strict'

const generateIndex = require('./generate-index')
const chalk = require('chalk')
const algoliasearch = require('algoliasearch')
const fs = require('fs')
const path = require('path')
const _ = require('lodash')

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

  // Connect and authenticate with Algolia
  client = algoliasearch(process.env.ALGOLIA_APP_ID, process.env.ALGOLIA_ADMIN_API_KEY)
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
          } else {
            objectsToAdd.push(obj)
            totalObjectsToAdd++
          }
        }

        // Upload new records only if the objects have been updated or they are new.
        // See https://www.algolia.com/doc/api-reference/api-methods/save-objects/
        if (objectsToUpdate.length) {
          index.saveObjects(objectsToUpdate)
            .then(() => {
              logger.info(`Updated records for ${c} version ${v}`)
            })
            .catch(error => {
              logger.error(`Error updating objects to Algolia: ${error.message}`)
            })
        }
        if (objectsToAdd.length) {
          index.saveObjects(objectsToAdd)
            .then(() => {
              logger.info(`Added records for ${c} version ${v}`)
            })
            .catch(error => {
              logger.error(`Error adding objects to Algolia: ${error.message}`)
            })
        }

        siteCatalog.addFile({
          mediaType: 'application/json',
          contents: Buffer.from(JSON.stringify(algolia[c][v])),
          src: { stem: `algolia-${c}` },
          out: { path: `algolia-${c}-${v}.json` },
          pub: { url: `/algolia-${c}-${v}.json`, rootPath: '' }
        })
      }
    }

    index.setSettings({
      attributesForFaceting: ['version', 'product']
    })

    console.log(chalk.green('Updated records:' + totalObjectsToUpdate))
    console.log(chalk.green('New records:' + totalObjectsToAdd))

    totalObjectsToAdd === 0 && totalObjectsToUpdate === 0 && console.log(chalk.green('No changes made'))

    try {
      let recordCount = 0

      await index.browseObjects({
        query: '',
        batch: batch => {
          recordCount += batch.length
        }
      })

      console.log(chalk.green('Total records:', recordCount))
    } catch (err) {
      logger.error(JSON.stringify(err))
    }
  })
}

module.exports = { generateIndex, register }
