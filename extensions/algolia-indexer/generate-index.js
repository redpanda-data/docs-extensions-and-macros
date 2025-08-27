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
  const unixTimestamp = Math.floor(Date.now() / 1000)

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

    /* Skip pages marked as "noindex" for "robots"
    const noindex = root.querySelector('meta[name=robots][content=noindex]')
    if (noindex) {
      continue
    }*/

    // Compute a flag identifying if the current page is in the
    // "current" component version.
    // When indexLatestOnly is set, we only index the current version.
    const component = contentCatalog.getComponent(page.src.component)
    const thisVersion = contentCatalog.getComponentVersion(component, page.src.version)
    const latestVersion = component.latest
    const isCurrent = thisVersion === latestVersion

    if (indexLatestOnly && !isCurrent) continue

    // capture the component name and version
    const cname = component.name
    const version = page.src.origin.descriptor.prerelease ? page.src.origin.descriptor.displayVersion : page.src.version;

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

    // Start handling the article content
    const article = root.querySelector('article.doc')
    if (!article) {
      logger.warn(`Page is not an article...skipping ${page.pub.url}`)
      continue
    }

    // handle titles
    const h1 = article.querySelector('h1')
    if (!h1) {
      logger.warn(`No H1 in ${page.pub.url}...skipping`)
      continue
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
    const contentElements = article.querySelectorAll('p, table, li');
    let contentText = '';
    let currentSize = 0;
    // Maximum size in bytes
    const MAX_SIZE = 50000;
    const encoder = new TextEncoder();
    contentElements.forEach(element => {
      let elementText = '';
      if (element.tagName === 'TABLE') {
        element.querySelectorAll('tr').forEach(tr => {
          tr.querySelectorAll('td, th').forEach(cell => {
            elementText += cell.text + ' ';
          });
        });
      } else {
        elementText = decode(element.rawText);
      }
      const elementSize = encoder.encode(elementText).length;
      if (currentSize + elementSize > MAX_SIZE) {
        return;
      } else {
        contentText += elementText;
        currentSize += elementSize;
      }
    });

    var text = contentText.replace(/\n/g, ' ')
      .replace(/\r/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    let tag;
    if (component.title === 'home') {
      // Collect all unique component titles except 'home'
      const allComponentTitles = Object.values(contentCatalog.components || contentCatalog._components || {})
        .map(c => c.title)
        .filter(title => title && title !== 'home');
      tag = Array.from(new Set(allComponentTitles));
    } else {
      tag = `${component.title} ${version ? 'v' + version : ''}`.trim();
    }
    var indexItem;
    const deployment = page.asciidoc?.attributes['env-kubernetes'] ? 'Kubernetes' : page.asciidoc?.attributes['env-linux'] ? 'Linux' : page.asciidoc?.attributes['env-docker'] ? 'Docker' : page.asciidoc?.attributes['page-cloud'] ? 'Redpanda Cloud' : ''

    const categories = page.asciidoc?.attributes['page-categories']
    ? page.asciidoc.attributes['page-categories'].split(',').map(category => category.trim())
    : []

    var indexItem = {
      title: documentTitle,
      version: version,
      text: text,
      intro: intro,
      objectID: urlPath + page.pub.url,
      titles: titles,
      categories: categories,
      unixTimestamp: unixTimestamp,
    }

    if (component.name !== 'redpanda-labs') {
      indexItem.product = component.title;
      indexItem.breadcrumbs = breadcrumbs;
      indexItem.type = 'Doc';
      indexItem._tags = Array.isArray(tag) ? tag : [tag];
    } else {
      indexItem.deployment = deployment;
      indexItem.type = 'Lab';
      indexItem.interactive = false;
      indexItem._tags = Array.isArray(tag) ? tag : [tag];
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
