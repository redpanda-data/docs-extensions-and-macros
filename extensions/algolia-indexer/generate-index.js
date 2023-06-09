'use strict'

const { parse }   = require('node-html-parser')
const { decode }  = require('html-entities')
const path        = require('path')
const URL         = require('url')
const chalk       = require('chalk')

/**
 * Generates an Algolia index:
 *
 * Iterates over the specified pages and creates the indexes.
 *
 * @memberof algolia-indexer
 *
 * @param {Object} playbook - The configuration object for Antora.
 * @param {Object} contentCatalog - The Antora content catalog, with pages and metadata.
 * @param {Object} [config={}] - Configuration options
 * @param {Boolean} config.indexLatestOnly - If true, only index the latest version of any given page.
 * @param {Object} config.logger - Logger to use
 * @typedef {Object} SearchIndexData
 * @returns {SearchIndexData} A data object that contains the Algolia index
 */
function generateIndex (playbook, contentCatalog, { indexLatestOnly = false, excludes = [], logger } = {}) {
  if (!logger) logger = process.env.NODE_ENV === 'test' ? { info: () => undefined } : console

  const algolia = {}

  console.log(chalk.cyan('Indexing...'))

  // Select indexable pages
  const pages = contentCatalog.getPages((page) => {
    if (!page.out || page.asciidoc?.attributes?.noindex != null) return
    return {}
  })
  if (!pages.length) return {}

  // Handle the site URL
  let siteUrl = playbook.site.url
  if (!siteUrl) {
    siteUrl = ''
  }
  if (siteUrl.charAt(siteUrl.length - 1) === '/') {
    siteUrl = siteUrl.substr(0, siteUrl.length - 1)
  }
  const urlPath = extractUrlPath(siteUrl)

  const documents = {}
  var algoliaCount = 0

  for (var i = 0; i < pages.length; i++) {
    const page = pages[i]
    const root = parse(
      page.contents,
      {
        blockTextElements: {
          code: true,
        },
      }
    )

    // skip pages marked as "noindex" for "robots"
    const noindex = root.querySelector('meta[name=robots][content=noindex]')
    if (noindex) {
      continue
    }

    // Compute a flag identifying if the current page is in the
    // "current" component version.
    // When indexLatestOnly is set, we only index the current version.
    const component = contentCatalog.getComponent(page.src.component)
    const home = contentCatalog.getComponent('home')
    const thisVersion = contentCatalog.getComponentVersion(component, page.src.version)
    const latestVersion = component.latest
    const isCurrent = thisVersion === latestVersion

    if (indexLatestOnly && !isCurrent) continue

    // capture the component name and version
    const cname = component.name
    const version = page.src.version

    // handle the page keywords
    const kw = root.querySelector('meta[name=keywords]')
    var keywords = []
    if (kw) {
      keywords = kw.getAttribute('content')
      keywords = keywords ? keywords.split(/,\s*/) : []
    }

    // gather page breadcrumbs
    const breadcrumbs = []
    root.querySelectorAll('nav.breadcrumbs > ul > li a')
      .forEach((elem) => {
        var url = path.resolve(
          path.join('/', page.out.dirname),
          elem.getAttribute('href')
        )
        breadcrumbs.push({
          u: url,
          t: elem.text
        })
      })

    const images = {
      'get started': 'get-started-icon.png',
      'develop': 'develop-icon.png',
      'deploy': 'deploy-icon.png',
      'manage': 'manage-icon.png'
    }

    var image = {}

    if (breadcrumbs.length > 1) {
      const lowercaseBreadcrumb = breadcrumbs[1].t.toLowerCase()
      for (let key in images) {
        if (lowercaseBreadcrumb.includes(key)) {
          image.src = `${home.url}_images/${images[key]}`
          image.alt = key
          break
        }
      }
    }

    // Start handling the article content
    const article = root.querySelector('article.doc')
    if (!article) {
      logger.warn(`Page is not an article...skipping ${page.pub.url}`)
      continue
    }

    // handle titles
    const h1 = article.querySelector('h1')
    if (!h1) {
      logger.error(`No H1 in ${page.pub.url}`)
      process.exit(1)
    }
    const documentTitle = h1.text
    h1.remove()

    const titles = []
    article.querySelectorAll('h2,h3,h4,h5,h6').forEach((title) => {
      var id = title.getAttribute('id')
      if (id) {
        titles.push({
          t: title.text,
          h: id,
        })
      }
      title.remove()
    })

    // exclude elements within the article that should not be indexed
    excludes.forEach((excl) => {
      if (!excl) return
      article.querySelectorAll(excl).map((e) =>  e.remove())
    })

    var intro = article.querySelector('p');
    // decode any HTML entities
    intro = decode(intro.rawText);

    // establish structure in the Algolia index
    if (!(cname in algolia)) algolia[cname] = {}
    if (!(version in algolia[cname])) algolia[cname][version] = []

    // Handle the article text
    var text = decode(article.text)
    text = text.replace(/\n/g, ' ')
      .replace(/\r/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length > 90000) text = text.substr(0, 90000)

    var tag = `${component.title}-${version}`

    const indexItem = {
      title: documentTitle,
      product: component.title,
      version: version,
      image: image? image: '',
      text: text,
      breadcrumbs: breadcrumbs,
      intro: intro,
      objectID: urlPath + page.pub.url,
      titles: titles,
      keywords: keywords,
      _tags: [tag]
    }

    algolia[cname][version].push(indexItem)
    algoliaCount++
  }

  return algolia
}

// Extract the path from a URL
function extractUrlPath (url) {
  if (url) {
    if (url.charAt() === '/') return url
    const urlPath = URL.parse(url).pathname
    return urlPath === '/' ? '' : urlPath
  }
  return ''
}

module.exports = generateIndex
