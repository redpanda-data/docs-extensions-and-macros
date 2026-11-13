'use strict';
const { posix: path } = require('path')
const { escapeHtml } = require('../extension-utils/html-utils')

/**
 * Logos shipped in the docs-ui bundle under `img/logos/`, keyed by connector
 * name or by vendor/family token. This is the single source for connector
 * logos: `getConnectorIcon` falls back from the exact connector name to the
 * version-stripped name, then to the leading and trailing token runs, so a
 * vendor only needs one entry to cover its whole family (`gcp` covers
 * `gcp_pubsub`, `snowflake` covers `snowflake_put` and `sql_driver_snowflake`).
 */
const LOGO_FILES = {
  amqp: 'rabbit-mq.svg',
  avro: 'apacheavro.svg',
  aws: 'amazon-web-services.svg',
  aws_bedrock: 'awslambda.svg',
  aws_cloudwatch: 'awscloud-watch.svg',
  aws_dynamodb: 'awsdynamo-db.svg',
  aws_kinesis: 'awskinesis.svg',
  aws_lambda: 'awslambda.svg',
  aws_s3: 'awss3.svg',
  aws_sns: 'awssns.svg',
  aws_sqs: 'awssqs.svg',
  azure: 'microsoftazure.svg',
  beanstalkd: 'beanstalkd.svg',
  cassandra: 'cassandra.svg',
  clickhouse: 'clickhouse.svg',
  cohere: 'cohere.svg',
  couchbase: 'couchbase.svg',
  discord: 'discord.svg',
  elasticsearch: 'elasticsearch.svg',
  gcp: 'google-cloud.svg',
  gocosmos: 'microsoftazure.svg',
  google_drive: 'google-drive.svg',
  grok: 'elasticsearch.svg',
  hdfs: 'hadoop.svg',
  influxdb: 'influx-db.svg',
  javascript: 'java-script.svg',
  jq: 'jq.svg',
  json: 'json.svg',
  kafka: 'apache-kafka.svg',
  memcached: 'memcached.svg',
  microsoft_sql_server: 'microsoftsqlserver.svg',
  mongodb: 'mongo-db.svg',
  mqtt: 'mqtt.svg',
  mssql: 'microsoftsqlserver.svg',
  mysql: 'my-sql.svg',
  nanomsg: 'nanomsg.svg',
  nats: 'nats.svg',
  nsq: 'nsq.svg',
  openai: 'open-ai.svg',
  opensearch: 'open-search.svg',
  open_telemetry: 'open-telemetry.svg',
  oracle: 'oracle.svg',
  oracledb: 'oracle.svg',
  otlp: 'open-telemetry.svg',
  pg_stream: 'postgre-sql.svg',
  pinecone: 'pinecone.svg',
  postgres: 'postgre-sql.svg',
  postgresql: 'postgre-sql.svg',
  prometheus: 'prometheus.svg',
  protobuf: 'google-protocol-buffers.svg',
  pulsar: 'apache-pulsar.svg',
  pusher: 'pusher.svg',
  qdrant: 'qdrant.svg',
  // The Redpanda mark is not in the docs-ui bundle yet, so it is hot-linked.
  // Tracked as a docs-ui task: the asset belongs in the bundle like every other logo.
  redpanda: 'https://cdn.prod.website-files.com/68ed36e99e31581dedf5dc7c/68ed91d74b9cd10c98cb8e6e_footer-logo.svg',
  redis: 'redis.svg',
  sentry: 'sentry.svg',
  slack: 'slack.svg',
  snowflake: 'snowflake.svg',
  splunk: 'splunk.svg',
  websocket: 'web-socket.svg',
  xml: 'xml.svg',
}

/**
 * Connectors with no vendor logo that read better as a symbol than as the
 * generic plug. Checked after an exact logo match and before the family passes.
 */
const EMOJI_ICONS = {
  http_server: '🌐',
  http_client: '🌐',
  tcp: '🔌',
  udp: '🔌',
  sftp: '📁',
  ftp: '📁',
  file: '📄',
  stdin: '⌨️',
  stdout: '📺',
  sql_raw: '🗄️',
  sql_insert: '🗄️',
  sql_select: '🗄️',
  cache: '💾',
  rate_limit: '⏱️',
  batched: '📦',
  drop: '🗑️',
}

const logger = require('@antora/logger')('rp-connect-components-macro')
const { isCloudAvailable, typeFromRelative, useCasesByConnector } = require('../extensions/util/connect-catalog')

// Where the solutions-catalog extension publishes the Redpanda Solutions
// catalog, relative to the site root. The macro cannot read the
// `solutions-catalog` component attribute: that extension sets it at
// documentsConverted, after every page (and so this macro) has converted. The
// page fetches the published file instead, only once a use case is selected.
const SOLUTIONS_CATALOG_PATH = 'assets/data/solutions.json'

// The use-case chips on a connector's own page (component_type_dropdown). The
// catalog's styles load only on the catalog page, so these ship with the block.
const USE_CASE_TAG_ICON = '<svg class="connector-use-case-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M2 2.75C2 2.34 2.34 2 2.75 2h4.69c.2 0 .39.08.53.22l5.81 5.81a.75.75 0 0 1 0 1.06l-4.69 4.69a.75.75 0 0 1-1.06 0L2.22 7.97A.75.75 0 0 1 2 7.44V2.75zM5 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>'
const CONNECTOR_USE_CASES_CSS = `
.connector-use-cases { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.75rem; margin: 0.875rem 0 0; padding-top: 0.875rem; border-top: 1px solid rgba(15, 23, 42, 0.08); }
.connector-use-cases-label { font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #6b7280; }
.connector-use-cases-chips { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.doc .connector-use-cases a.connector-use-case { display: inline-flex; align-items: center; gap: 0.375rem; padding: 0.3125rem 0.75rem; border: 1px solid #f6c9bb; border-radius: 999px; background: #fdf0ec; color: #a32d0c; font-size: 0.8125rem; font-weight: 600; line-height: 1.2; text-decoration: none; transition: background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease; }
.doc .connector-use-cases a.connector-use-case:hover { background: #fbe1d8; border-color: #e2401b; box-shadow: 0 1px 2px rgba(226, 64, 27, 0.18); }
.doc .connector-use-cases a.connector-use-case:focus-visible { outline: 2px solid #e2401b; outline-offset: 2px; }
.connector-use-case-icon { flex: 0 0 auto; opacity: 0.85; }
.connector-use-case-arrow { display: inline-block; width: 0; overflow: hidden; opacity: 0; transform: translateX(-4px); transition: width 0.15s ease, opacity 0.15s ease, transform 0.15s ease; }
.doc .connector-use-cases a.connector-use-case:hover .connector-use-case-arrow, .doc .connector-use-cases a.connector-use-case:focus-visible .connector-use-case-arrow { width: 0.875em; opacity: 1; transform: none; }
html[data-theme="dark"] .connector-use-cases { border-top-color: rgba(255, 255, 255, 0.1); }
html[data-theme="dark"] .connector-use-cases-label { color: #9ca3af; }
html[data-theme="dark"] .doc .connector-use-cases a.connector-use-case { background: rgba(226, 64, 27, 0.14); border-color: rgba(241, 93, 97, 0.4); color: #ffb59e; }
html[data-theme="dark"] .doc .connector-use-cases a.connector-use-case:hover { background: rgba(226, 64, 27, 0.24); border-color: #f15d61; }
@media (prefers-reduced-motion: reduce) { .doc .connector-use-cases a.connector-use-case, .connector-use-case-arrow { transition: none; } }
`

// A use case is offered in the filter only when at least this many cards in
// the current view have it: an option that narrows the catalog to one or two
// cards reads as noise, and a tag that rare says more about tagging than use.
const USE_CASE_MIN_CARDS = 3

/**
 * The solutions in a solutions.json catalog that have any of the selected use
 * cases, in catalog order. A solution matches on a taxonomy concept ID
 * (`concepts.useCases[].id`, from the solutions-catalog extension with the
 * taxonomy), or on an authored `useCases` value that is the use case's ID,
 * label, or one of its taxonomy altLabels, ignoring case (catalogs built
 * without the taxonomy carry only the authored labels). Deprecated solutions
 * are left out. Runs in the browser (injected with toString) and in unit
 * tests, so it uses no outside names.
 *
 * @param {Object|null} catalog - the parsed solutions.json
 * @param {Array<string>} ids - selected use-case IDs
 * @param {Object<string,{label: string, altLabels: Array<string>}>} [info] -
 *   use-case ID -> its label and altLabels
 * @returns {Array<Object>}
 */
function matchSolutions (catalog, ids, info) {
  const list = catalog && Array.isArray(catalog.solutions) ? catalog.solutions : []
  const wanted = (ids || []).filter(Boolean)
  if (!wanted.length) return []
  const key = function (value) { return String(value == null ? '' : value).trim().toLowerCase() }
  const names = {}
  wanted.forEach(function (id) {
    const entry = (info && info[id]) || {}
    names[id] = [id, entry.label].concat(Array.isArray(entry.altLabels) ? entry.altLabels : []).filter(Boolean).map(key)
  })
  return list.filter(function (solution) {
    if (!solution || !solution.url || !solution.title || solution.status === 'deprecated') return false
    const concepts = (solution.concepts && Array.isArray(solution.concepts.useCases)) ? solution.concepts.useCases : []
    const conceptIds = concepts.map(function (c) { return c && c.id })
    const authored = (Array.isArray(solution.useCases) ? solution.useCases : []).map(key)
    return wanted.some(function (id) {
      return conceptIds.indexOf(id) !== -1 || authored.some(function (value) { return names[id].indexOf(value) !== -1 })
    })
  })
}

/**
 * One quiet line under the filters when a use case is selected and Redpanda
 * Solutions cover it: the catalog is about components, so solutions are a
 * hint, never a block of links competing with the cards. With one match it
 * links that solution by title; with more it links the Solutions landing page
 * filtered to the use cases (its `?use-case=` parameter takes the label).
 * Every value goes through `escape` (the shared escapeHtml). Runs in the
 * browser (injected with toString) and in unit tests.
 *
 * @param {Array<Object>} solutions - from matchSolutions
 * @param {Array<string>} ids - selected use-case IDs
 * @param {Object<string,{label: string}>} info - use-case ID -> its label
 * @param {Function} escape
 * @returns {string} HTML, empty when there are no solutions
 */
function solutionsMarkup (solutions, ids, info, escape) {
  if (!solutions || !solutions.length) return ''
  const names = ids.map(function (id) {
    const entry = info && info[id]
    return (entry && (typeof entry === 'string' ? entry : entry.label)) || id
  })
  const topic = names.join(' or ')
  if (solutions.length === 1) {
    return '<p class="catalog-solutions-hint">Redpanda Solution for ' + escape(topic) + ': ' +
      '<a href="' + escape(solutions[0].url) + '">' + escape(solutions[0].title) + '</a></p>'
  }
  // The landing page is the root of the solutions component: the first path
  // segment of a solution's URL (/solutions/cdc-to-lakehouse/ -> /solutions/)
  const home = (String(solutions[0].url).match(/^(?:[a-z]+:\/\/[^/]+)?\/[^/]+\//i) || [''])[0]
  const query = names.map(function (name) { return 'use-case=' + encodeURIComponent(name) }).join('&')
  const text = 'See ' + solutions.length + ' Redpanda Solutions for ' + escape(topic)
  return '<p class="catalog-solutions-hint">' + (home
    ? '<a href="' + escape(home + '?' + query) + '">' + text + '</a>'
    : text) + '</p>'
}

/**
 * The sentence the catalog's status region announces after a filter change.
 * Runs in the browser (injected with toString) and in unit tests.
 *
 * @param {{shown: number, total: number, search: string, useCases: Array<string>, filtered: boolean, solutions: (number|null)}} state
 *   `useCases` are the selected labels, `filtered` says whether any other
 *   filter narrows the cards, and `solutions` is the number of related
 *   solutions (null when none are known)
 * @returns {string}
 */
function catalogStatusText (state) {
  const parts = []
  if (state.search) parts.push('"' + state.search + '"')
  if (state.useCases && state.useCases.length) parts.push(state.useCases.join(' or '))
  let text
  if (!parts.length && !state.filtered) {
    text = 'Showing all ' + state.total + ' components.'
  } else {
    const what = parts.length ? parts.join(' and ') : 'these filters'
    text = state.shown === 0
      ? 'No components match ' + what + '.'
      : state.shown + (state.shown === 1 ? ' component matches ' : ' components match ') + what + '.'
  }
  if (state.solutions) text += ' ' + state.solutions + (state.solutions === 1 ? ' related solution.' : ' related solutions.')
  return text
}

// Filter layout: each dropdown filter is at least this wide, with this gap
const FILTER_MIN_WIDTH_PX = 180
const FILTER_GAP_PX = 16
// A lone filter (the Cloud catalog's Type) stops at this width
const FILTER_SINGLE_MAX_WIDTH_PX = 360

/**
 * Container queries that lay the dropdown filters out in balanced rows: as
 * many columns as fit at FILTER_MIN_WIDTH_PX, then evened out so no row is
 * left with a gap (4 filters go 4, 2x2, then 1 per row; 3 go 3, then 1 per
 * row). A filter in a short last row (5 filters in 3 columns) stretches to
 * fill it. A single filter keeps a dropdown's width instead of spanning the
 * panel. Exported for unit testing.
 *
 * @param {number} count - the number of dropdown filters
 * @returns {string} CSS
 */
function filterLayoutCss (count) {
  if (count <= 1) {
    return `@container catalog-filters (min-width: 0px) { .table-filters.component-catalog-filters > .filter-group { flex: 0 1 min(100%, ${FILTER_SINGLE_MAX_WIDTH_PX}px); } }`
  }
  const rules = []
  for (let fit = 1; fit <= count; fit++) {
    const minWidth = fit === 1 ? 0 : fit * FILTER_MIN_WIDTH_PX + (fit - 1) * FILTER_GAP_PX
    const columns = Math.ceil(count / Math.ceil(count / fit))
    const basis = columns === 1
      ? '100%'
      : `calc((100% - ${(columns - 1) * FILTER_GAP_PX}px) / ${columns} - 0.1px)`
    const rule = `.table-filters.component-catalog-filters > .filter-group { flex-basis: ${basis}; }`
    // A browser without container queries keeps the flex-basis fallback
    rules.push(`@container catalog-filters (min-width: ${minWidth}px) { ${rule} }`)
  }
  return rules.join('\n')
}

/**
 * Escaped HTML made safe to sit inside a JavaScript template literal (the
 * badge legend modal is built from one in the page script).
 */
function forTemplateLiteral (html) {
  return String(html).replace(/\\/g, '&#92;').replace(/`/g, '&#96;').replace(/\$\{/g, '&#36;{')
}

module.exports.filterLayoutCss = filterLayoutCss
module.exports.matchSolutions = matchSolutions
module.exports.solutionsMarkup = solutionsMarkup
module.exports.catalogStatusText = catalogStatusText
module.exports.USE_CASE_MIN_CARDS = USE_CASE_MIN_CARDS
module.exports.SOLUTIONS_CATALOG_PATH = SOLUTIONS_CATALOG_PATH

/**
 * Registers macros for use in Redpanda Connect contexts in the Redpanda documentation.
  * @param {Registry} registry - The Antora registry where this block macro is registered.
  * @param {Object} context - The Antora context that provides access to configuration data, such as parsed CSV content.
*/
module.exports.register = function (registry, context) {
  // `event` is set when a reader changed a filter (and not on page load), which
  // is when the status region announces the result.
  function filterComponentTable(event) {
    const nameInputElement = document.getElementById('componentTableSearch');
    const nameInput = nameInputElement ? nameInputElement.value.trim().toLowerCase() : '';
    const typeFilter = Array.from(document.querySelectorAll('#typeFilterMenu input[type="checkbox"]:checked')).map(checkbox => checkbox.value);
    // Check for the existence of support and enterprise license filters (optional)
    const supportFilterElement = document.querySelector('#supportFilterMenu');
    const supportFilter = supportFilterElement
      ? Array.from(supportFilterElement.querySelectorAll('input[type="checkbox"]:checked')).map(checkbox => checkbox.value)
      : [];
    // Check for cloud support filter (optional)
    const cloudSupportFilterElement = document.querySelector('#cloudSupportFilterMenu');
    const cloudSupportFilter = cloudSupportFilterElement
      ? Array.from(cloudSupportFilterElement.querySelectorAll('input[type="checkbox"]:checked')).map(checkbox => checkbox.value)
      : [];
    // Check for enterprise license filter (optional)
    const enterpriseFilterElement = document.querySelector('#enterpriseFilterMenu');
    const enterpriseFilter = enterpriseFilterElement
      ? Array.from(enterpriseFilterElement.querySelectorAll('input[type="checkbox"]:checked')).map(checkbox => checkbox.value)
      : [];
    // Use case filter (optional): nothing checked means no filter, since most
    // components have no use case
    const useCaseFilterElement = document.querySelector('#useCaseFilterMenu');
    const useCaseFilter = useCaseFilterElement
      ? Array.from(useCaseFilterElement.querySelectorAll('input[type="checkbox"]:checked')).map(checkbox => checkbox.value)
      : [];
    const params = getQueryParams();
    const enterpriseSupportFilter = params.support === 'enterprise';  // Check if 'support=enterprise' is in the URL
    const cloudSupportFilterFromUrl = params.support === 'cloud';  // Check if 'support=cloud' is in the URL
    const container = document.getElementById('componentCardsContainer');
    if (!container) return; // Exit early if container doesn't exist
    const cards = container.querySelectorAll('.component-card');
    if (!cards || cards.length === 0) return; // Exit early if no cards found
    let shownCount = 0;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      // data-search adds the card's use-case labels, IDs, and altLabels to its names
      const nameText = (card.dataset.search || card.dataset.name || '').toLowerCase();
      const typeText = (card.dataset.types || '').toLowerCase().split(',').map(item => item.trim());
      const supportText = (card.dataset.support || '').toLowerCase();
      const enterpriseSupportText = (card.dataset.licensed || '').toLowerCase();  // Yes or No
      const cloudSupportText = (card.dataset.cloud || '').toLowerCase();  // Yes or No
      const useCaseText = (card.dataset.useCases || '').split(',').filter(Boolean);
      // Check cloud support filter
      let cloudSupportMatch = true;
      if (cloudSupportFilter.length > 0 && !cloudSupportFilter.includes('')) {
        // If specific options are selected (not "All")
        cloudSupportMatch = cloudSupportFilter.some(value => {
          if (value === 'yes') return cloudSupportText === 'yes' || cloudSupportText.includes('yes');
          if (value === 'no') return cloudSupportText === 'no' || !cloudSupportText.includes('yes');
          return true;
        });
      }
      // Check enterprise license filter
      let enterpriseLicenseMatch = true;
      if (enterpriseFilter.length > 0 && !enterpriseFilter.includes('')) {
        // If specific options are selected (not "All")
        enterpriseLicenseMatch = enterpriseFilter.some(value => {
          if (value === 'yes') return enterpriseSupportText === 'yes' || enterpriseSupportText.includes('yes');
          if (value === 'no') return enterpriseSupportText === 'no' || !enterpriseSupportText.includes('yes');
          return true;
        });
      }
      // Determine if the card should be shown
      const showCard =
        ((!nameInput || nameText.includes(nameInput)) &&  // Filter by name if present
         (typeFilter.length === 0 || typeFilter.some(value => typeText.includes(value))) &&  // Filter by type
         (supportFilter.length === 0 || supportFilter.some(value => supportText.includes(value))) &&  // Filter by support if present
         (!enterpriseSupportFilter || supportText.includes('enterprise') || enterpriseSupportText === 'yes') && // Filter by enterprise support if 'support=enterprise' is in the URL
         (!cloudSupportFilterFromUrl || supportText.includes('cloud') || cloudSupportText === 'yes') &&  // Filter by cloud support if 'support=cloud' is in the URL
         cloudSupportMatch &&  // Filter by cloud support dropdown
         enterpriseLicenseMatch &&  // Filter by enterprise license dropdown
         (useCaseFilter.length === 0 || useCaseFilter.some(value => useCaseText.includes(value)))  // Filter by use case if any is checked
        );

      if (showCard) {
        shownCount++;
        card.classList.remove('hidden');
        card.removeAttribute('style');
      } else {
        card.classList.add('hidden');
        card.setAttribute('style', 'display: none !important; visibility: hidden !important; height: 0 !important; opacity: 0 !important;');
      }
    }
    // Update dropdown text based on selections
    updateDropdownText('typeFilter', 'All Types Selected', 'Types Selected');
    const supportMenu = document.getElementById('supportFilterMenu');
    if (supportMenu) {
      updateDropdownText('supportFilter', 'All Support Levels Selected', 'Support Levels Selected');
    }
    const cloudSupportMenu = document.getElementById('cloudSupportFilterMenu');
    if (cloudSupportMenu) {
      updateDropdownText('cloudSupportFilter', 'All Options Selected', 'Options Selected');
    }
    const enterpriseMenu = document.getElementById('enterpriseFilterMenu');
    if (enterpriseMenu) {
      updateDropdownText('enterpriseFilter', 'All Options Selected', 'Options Selected');
    }
    if (useCaseFilterElement) {
      // Not updateDropdownText: here nothing checked is the unfiltered state
      const useCaseToggleText = document.querySelector('#useCaseFilterToggle .dropdown-text');
      if (useCaseToggleText) {
        const checked = useCaseFilterElement.querySelectorAll('input[type="checkbox"]:checked');
        useCaseToggleText.textContent = checked.length === 0
          ? 'Any use case'
          : checked.length === 1
            ? checked[0].nextElementSibling.textContent
            : checked.length + ' use cases';
        // The full value as a tooltip when the toggle cuts it off
        const useCaseToggle = document.getElementById('useCaseFilterToggle');
        // The text's full width, from an unconstrained hidden copy beside it
        const probe = useCaseToggleText.cloneNode(true);
        probe.removeAttribute('id');
        probe.style.cssText = 'position:absolute;visibility:hidden;width:auto;max-width:none;flex:none;overflow:visible;';
        useCaseToggleText.parentNode.appendChild(probe);
        const fullWidth = probe.getBoundingClientRect().width;
        probe.remove();
        if (fullWidth > useCaseToggleText.getBoundingClientRect().width + 0.01) {
          useCaseToggle.setAttribute('title', useCaseToggleText.textContent);
        } else {
          useCaseToggle.removeAttribute('title');
        }
      }
    }
    // Empty state
    const emptyState = document.getElementById('componentCatalogEmpty');
    if (emptyState) emptyState.hidden = shownCount !== 0;
    // Status: what the filters left, then the related solutions once known
    const narrowed = ['typeFilterMenu', 'supportFilterMenu', 'cloudSupportFilterMenu', 'enterpriseFilterMenu']
      .some(id => !!document.querySelector('#' + id + ' input[type="checkbox"]:not(:checked)'));
    const statusState = {
      shown: shownCount,
      total: cards.length,
      search: nameInputElement ? nameInputElement.value.trim() : '',
      useCases: useCaseFilterElement
        ? Array.from(useCaseFilterElement.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.nextElementSibling.textContent)
        : [],
      filtered: narrowed,
      solutions: null
    };
    const setStatus = function (state) {
      const status = document.getElementById('componentCatalogStatus');
      if (status && event && typeof window.catalogStatusText === 'function') status.textContent = window.catalogStatusText(state);
    };
    if (useCaseFilterElement && typeof window.updateCatalogSolutions === 'function') {
      window.updateCatalogSolutions(useCaseFilter, function (solutionCount) {
        setStatus(Object.assign({}, statusState, { solutions: solutionCount || null }));
      });
    } else {
      setStatus(statusState);
    }
    // Update URL parameters based on current filter selections
    updateURLParameters();
  }
  function updateURLParameters() {
    const params = new URLSearchParams();
    // Get current filter values
    const nameInputElement = document.getElementById('componentTableSearch');
    const nameInput = nameInputElement ? nameInputElement.value.trim() : '';
    const typeFilter = Array.from(document.querySelectorAll('#typeFilterMenu input[type="checkbox"]:checked')).map(checkbox => checkbox.value);
    const supportFilterElement = document.querySelector('#supportFilterMenu');
    const supportFilter = supportFilterElement
      ? Array.from(supportFilterElement.querySelectorAll('input[type="checkbox"]:checked')).map(checkbox => checkbox.value)
      : [];
    const cloudSupportFilterElement = document.querySelector('#cloudSupportFilterMenu');
    const cloudSupportFilter = cloudSupportFilterElement
      ? Array.from(cloudSupportFilterElement.querySelectorAll('input[type="checkbox"]:checked')).map(checkbox => checkbox.value)
      : [];
    const enterpriseFilterElement = document.querySelector('#enterpriseFilterMenu');
    const enterpriseFilter = enterpriseFilterElement
      ? Array.from(enterpriseFilterElement.querySelectorAll('input[type="checkbox"]:checked')).map(checkbox => checkbox.value)
      : [];
    const useCaseFilter = Array.from(document.querySelectorAll('#useCaseFilterMenu input[type="checkbox"]:checked')).map(checkbox => checkbox.value);
    // Add parameters to URL if they have values
    if (nameInput) params.set('search', nameInput);
    if (typeFilter.length > 0) params.set('type', typeFilter.join(','));
    if (supportFilter.length > 0) params.set('support', supportFilter.join(','));
    if (cloudSupportFilter.length > 0 && !cloudSupportFilter.includes('')) {
      params.set('cloud', cloudSupportFilter.join(','));
    }
    if (enterpriseFilter.length > 0 && !enterpriseFilter.includes('')) {
      params.set('enterprise', enterpriseFilter.join(','));
    }
    if (useCaseFilter.length > 0) params.set('usecase', useCaseFilter.join(','));
    // Update the URL without refreshing the page
    const newURL = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
    window.history.replaceState({}, '', newURL);
  }
  /**
   * Gets the first URL (either Redpanda Connect or Redpanda Cloud) for a given connector from the typesArray.
   * If the cloud option is enabled (`isCloud = true`), it prefers the Redpanda Cloud URL; otherwise, it returns the Redpanda Connect URL.
   * 
   * @param {Array} typesArray - An array of types where each type has a list of commercial names with URLs.
   * @param {boolean} isCloud - A flag to indicate if Cloud URLs should be prioritized.
   * @returns {string} - The first found URL (either Redpanda Connect or Cloud), or an empty string if no URL is available.
   */
  function getFirstUrlFromTypesArray(typesArray, isCloud) {
    for (const [type, commercialNames] of typesArray) {
      for (const commercialName in commercialNames) {
        const { urls = {} } = commercialNames[commercialName];
        const redpandaConnectUrl = urls.redpandaConnectUrl || '';
        const redpandaCloudUrl = urls.redpandaCloudUrl || '';

        // Return Cloud URL if isCloud is true and Cloud URL exists
        if (isCloud && redpandaCloudUrl) {
          return redpandaCloudUrl;
        }
        // Return Connect URL if isCloud is false or no Cloud URL exists
        if (!isCloud && redpandaConnectUrl) {
          return redpandaConnectUrl;
        }
        // If Cloud URL exists but isCloud is false, fallback to Cloud URL if no Connect URL exists
        if (!isCloud && redpandaCloudUrl) {
          return redpandaCloudUrl;
        }
      }
    }
    return ''; // Return an empty string if no URL is found
  }
  const capitalize = s => s && s[0].toUpperCase() + s.slice(1);

  /**
   * Resolves the path from the page being converted to the root of the published
   * UI bundle, which is where docs-ui ships the connector logos
   * (`<ui root>/img/logos/*.svg`).
   *
   * Antora does not expose this as an AsciiDoc page attribute. It does put the
   * page's path back to the site root on the file it hands to AsciiDoc extensions
   * as `file.pub.rootPath`, and @antora/page-composer builds the UI templates'
   * own `uiRootPath` from that same value, so this returns exactly what the UI
   * uses for bundle assets, at any page depth.
   */
  /** Path from the page being converted to the site root (see resolveUiRootPath). */
  function resolveSiteRootPath () {
    const rootPath = context?.file?.pub?.rootPath;
    return typeof rootPath === 'string' && rootPath ? rootPath : '';
  }

  function resolveUiRootPath () {
    // Antora's default ui.output_dir, which every Redpanda playbook uses.
    const uiOutputDir = '_';
    const rootPath = context?.file?.pub?.rootPath;
    if (typeof rootPath === 'string' && rootPath) return path.join(rootPath, uiOutputDir);
    // No Antora file in context (for example, a unit-test harness): fall back to a
    // site-root-relative path, which holds for a site published at the domain root.
    return `/${uiOutputDir}`;
  }

  /**
   * Processes the parsed CSV data and returns a data structure organized by connector.
   *
   * This function processes each row in the CSV data to create a nested object where the key is the connector name.
   * Each connector contains:
   * - `types`: A Map of connector types, with associated URLs for Redpanda Connect and Redpanda Cloud.
   *    - Each type maps to commercial names and stores information on URLs, support level, and cloud support.
   * - `supportLevels`: A Map of support levels containing commercial names and whether the type supports cloud.
   * - `isLicensed`: A boolean flag indicating whether the connector requires an enterprise license.
   * - `isCloudConnectorSupported`: A boolean flag indicating whether any type of this connector supports Redpanda Cloud.
   *
   * Expected structure of the returned data:
   *
   * {
   *   "connectorName": {
   *     "types": Map {
   *       "Input": {   // Connector Type
   *         "commercial_name": {
   *           urls: {
   *             redpandaConnectUrl: "/redpanda-connect/components/inputs/connectorName/",
   *             redpandaCloudUrl: "/redpanda-cloud/develop/connect/components/inputs/connectorName/"
   *           },
   *           supportLevel: "certified",  // Support level for this commercial name
   *           isCloudSupported: true      // Whether this type supports cloud
   *         },
   *         ...
   *       },
   *       "Output": {  // Another Connector Type
   *         "commercial_name": {
   *           urls: {
   *             redpandaConnectUrl: "/redpanda-connect/components/outputs/connectorName/",
   *             redpandaCloudUrl: "/redpanda-cloud/develop/connect/components/outputs/connectorName/"
   *           },
   *           supportLevel: "community",  // Support level for this commercial name
   *           isCloudSupported: false     // Whether this type supports cloud
   *         },
   *         ...
   *       },
   *       ...
   *     },
   *     "isLicensed": "Yes" or "No",  // Indicates if the connector requires an Enterprise license.
   *     "isCloudConnectorSupported": true or false // Indicates if any type for this connector supports Redpanda Cloud.
   *   },
   *   ...
   * }
   *
   * Notes:
   * - For each connector, `types` is a `Map` that contains multiple connector types.
   * - For each type, there may be multiple commercial names. Each commercial name contains URLs, support levels, and cloud support flags.
   * - The `isCloudConnectorSupported` flag is set to `true` if any of the types for the connector support cloud.
   *
   * @param {object} parsedData - The CSV data parsed into an object.
   * @returns {object} - The processed connectors data structure.
   */
  function processConnectors(parsedData) {
    // A connector's use cases are the union across its types
    const useCases = useCasesByConnector(parsedData.data);
    return parsedData.data.reduce((connectors, row) => {
      const { connector, commercial_name, type, support_level, is_licensed, redpandaConnectUrl, redpandaCloudUrl, description } = row;
      // Available in standard or GPU Cloud pipelines
      const isCloudSupported = isCloudAvailable(row);

      // Initialize the connector if it's not already in the map
      if (!connectors[connector]) {
        connectors[connector] = {
          types: new Map(),
          isLicensed: is_licensed,
          isCloudConnectorSupported: false,
          description: description || '', // Add description from CSV
          useCases: useCases.get(connector) || []
        };
      } else if (!connectors[connector].description && description) {
        // Each row is one type's page: take the first type that has a description
        connectors[connector].description = description;
      }

      // Ensure type exists for the connector
      if (!connectors[connector].types.has(type)) {
        connectors[connector].types.set(type, {});
      }

      // Store the commercial name under the type
      if (!connectors[connector].types.get(type)[commercial_name]) {
        connectors[connector].types.get(type)[commercial_name] = {
          urls: {
            redpandaConnectUrl: redpandaConnectUrl || '',
            redpandaCloudUrl: redpandaCloudUrl || ''
          },
          supportLevel: support_level,
          isCloudSupported: isCloudSupported,
          gpuOnly: row.gpu_only === 'y',
          noGpu: row.no_gpu === 'y'
        };
      }

      // Check at the connector level if any commercial name supports cloud
      if (isCloudSupported) {
        connectors[connector].isCloudConnectorSupported = true;
      }

      return connectors;
    }, {});
  }

  /**
   * Processes parsed CSV data and groups SQL drivers by their support level.
   *
   * This function extracts the SQL drivers from the parsed CSV data, grouping
   * them into two categories: "certified" and "community". Each driver is also
   * associated with a flag indicating whether it supports cloud.
   *
   * @param {Object} parsedData - The parsed CSV data containing driver information.
   *   The expected structure of each row should contain at least the following:
   *   {
   *     connector: string,        // The name of the connector
   *     commercial_name: string,  // The commercial name of the SQL driver
   *     support_level: string,    // The support level ('certified', 'community')
   *     is_cloud_supported: string // 'y' or 'n', indicating if the driver supports cloud
   *   }
   *
   * @returns {Object} - An object with two properties:
   *   - `certified`: An array of SQL drivers with 'certified' support level. Each driver contains:
   *     - `commercialName`: The trimmed commercial name of the driver (for example, 'PostgreSQL').
   *     - `isCloudSupported`: A boolean indicating whether the driver supports cloud.
   *   - `community`: An array of SQL drivers with 'community' support level. Each driver contains:
   *     - `commercialName`: The trimmed commercial name of the driver (for example, 'Trino').
   *     - `isCloudSupported`: A boolean indicating whether the driver supports cloud.
   *
   * Example return structure:
   * {
   *   certified: [
   *     { commercialName: 'PostgreSQL', isCloudSupported: true },
   *     { commercialName: 'MySQL', isCloudSupported: true },
   *   ],
   *   community: [
   *     { commercialName: 'Trino', isCloudSupported: false },
   *     { commercialName: 'ClickHouse', isCloudSupported: false },
   *   ]
   * }
   */
  function processSqlDrivers(parsedData) {
    const sqlDrivers = {
      certified: [],
      community: []
    };

    parsedData.data.forEach(row => {
      const { connector: driverName, commercial_name, support_level } = row;
      const isCloudSupported = isCloudAvailable(row);
      const supportLevel = support_level.toLowerCase();

      // Only process SQL drivers
      if (driverName.startsWith('sql_driver')) {
        const driverData = {
          commercialName: commercial_name.trim(),
          isCloudSupported: isCloudSupported
        };

        // Group drivers based on their support level
        if (supportLevel === 'certified') {
          sqlDrivers.certified.push(driverData);
        } else if (supportLevel === 'community') {
          sqlDrivers.community.push(driverData);
        }
      }
    });

    return sqlDrivers;
  }

  /**
   * Resolves the icon for a connector card.
   *
   * Returns a tagged value so callers never have to sniff the string to tell a
   * logo URL from an emoji: `{ type: 'logo', url }` or `{ type: 'emoji', symbol }`.
   *
   * Lookup order, all against the single LOGO_FILES table:
   * 1. the exact connector name
   * 2. an emoji override (for example, `stdin`)
   * 3. the name without a version suffix (`elasticsearch_v8` -> `elasticsearch`)
   * 4. the longest leading token run (`aws_cloudwatch_logs` -> `aws_cloudwatch`)
   * 5. the trailing token run, for vendor-suffixed names (`sql_driver_snowflake` -> `snowflake`)
   * 6. name patterns, then the component type, then a generic plug
   *
   * @param {string} connector - The connector name
   * @param {Map} types - Map of component types (optional, used for generic type-based fallback icons)
   * @param {string} uiRootPath - Path from the current page to the UI bundle root
   * @returns {{type: 'logo', url: string}|{type: 'emoji', symbol: string}}
   */
  function getConnectorIcon(connector, types, uiRootPath) {
    const logo = file => ({
      type: 'logo',
      url: /^(https?:|data:)/.test(file) ? file : `${uiRootPath}/img/logos/${file}`
    });
    const emoji = symbol => ({ type: 'emoji', symbol });

    if (LOGO_FILES[connector]) return logo(LOGO_FILES[connector]);
    if (EMOJI_ICONS[connector]) return emoji(EMOJI_ICONS[connector]);

    // Version suffix (elasticsearch_v8 -> elasticsearch)
    const withoutVersion = connector.replace(/_v\d+$/i, '');
    if (withoutVersion !== connector && LOGO_FILES[withoutVersion]) {
      return logo(LOGO_FILES[withoutVersion]);
    }

    // Vendor family: longest leading token run first (aws_cloudwatch_logs ->
    // aws_cloudwatch), then the trailing tokens, which is where vendor-suffixed
    // names live (sql_driver_snowflake -> snowflake, ockam_kafka -> kafka).
    const tokens = withoutVersion.split('_');
    for (let end = tokens.length - 1; end > 0; end--) {
      const candidate = tokens.slice(0, end).join('_');
      if (LOGO_FILES[candidate]) return logo(LOGO_FILES[candidate]);
    }
    for (let start = 1; start < tokens.length; start++) {
      const candidate = tokens.slice(start).join('_');
      if (LOGO_FILES[candidate]) return logo(LOGO_FILES[candidate]);
    }

    // Pattern-based fallbacks
    if (connector.startsWith('sql_')) return emoji('🗄️');
    if (connector.endsWith('_cdc')) return emoji('🔄');
    if (connector.includes('http')) return emoji('🌐');

    // Type-based fallback icons (if types are provided)
    if (types && types.size > 0) {
      // Determine primary type for icon selection
      // Priority order: input > output > processor > scanner > others
      if (types.has('input')) return emoji('📥'); // Inbox tray - receiving data
      if (types.has('output')) return emoji('📤'); // Outbox tray - sending data
      if (types.has('processor')) return emoji('⚙️'); // Gear - processing/transforming
      if (types.has('scanner')) return emoji('🔍'); // Magnifying glass - scanning
      if (types.has('buffer')) return emoji('📦'); // Package - buffering
      if (types.has('cache')) return emoji('💾'); // Floppy disk - caching
      if (types.has('rate_limit')) return emoji('⏱️'); // Stopwatch - rate limiting
      if (types.has('metric')) return emoji('📊'); // Bar chart - metrics
      if (types.has('tracer')) return emoji('🔎'); // Magnifying glass tilted - tracing
    }

    // Default generic icon (plug for unknown connectors)
    return emoji('🔌');
  }

  /**
   * Generates HTML cards for the list of connectors, including their types, support levels, and cloud support.
   *
   * This function iterates over the provided connectors and generates an HTML card for each connector.
   * It includes type-specific information, support level (including SQL driver details), licensing, and cloud support as badges.
   *
   * @param {Object} connectors - An object containing the connector data, where each key is a connector name and
   *   each value contains details about its types, licensing, and cloud support.
   *   {
   *     types: Map - A map of connector types (for example, Input, Output, Processor), with associated commercial names.
   *     isLicensed: 'Yes' or 'No' - Indicates if the connector requires an enterprise license.
   *     isCloudConnectorSupported: true or false - Indicates if any type for this connector supports Redpanda Cloud.
   *   }
   * @param {Object} sqlDrivers - An object containing the SQL driver support data, separated by support level:
   *   {
   *     certified: Array<{ commercialName: string, isCloudSupported: boolean }>,
   *     community: Array<{ commercialName: string, isCloudSupported: boolean }>
   *   }
   * @param {boolean} isCloud - A flag indicating whether to filter by cloud support. If true, only cloud-supported connectors are shown.
   * @param {boolean} showAllInfo - A flag indicating whether to show all information or limit the data displayed (for example, for cloud-only views).
   *
   * @returns {string} - A string containing the generated HTML for the connector cards.
   *   The output is a string of HTML cards with:
   *   - Connector name
   *   - Connector types as badges (linked to Redpanda Connect or Cloud documentation URLs)
   *   - Support levels as badges (including SQL drivers if applicable)
   *   - Enterprise licensing badge
   *   - Cloud support badge
   */
  /** The [connector, details] entries that get a card in this view. */
  function shownConnectorEntries(connectors, isCloud) {
    return Object.entries(connectors)
      .filter(([_, details]) => {
        // SQL drivers are not components. They are listed as driver badges on the
        // sql_* cards, and the type filter deliberately offers no sql_driver
        // option, so a card for one is in the DOM but unreachable by any filter
        // or search. Do not emit it.
        const isSqlDriverOnly = Array.from(details.types.keys())
          .every(type => (type || '').toLowerCase() === 'sql_driver');
        if (isSqlDriverOnly) return false;
        // If isCloud is true, filter out rows that do not support cloud
        return !isCloud || details.isCloudConnectorSupported;
      });
  }

  /**
   * The use cases of a catalog view: `info` has every use case
   * generate-rp-connect-info resolved (csvData.useCases), by ID, and
   * `options` the ones the filter offers, in taxonomy order: those at least
   * USE_CASE_MIN_CARDS cards in this view have.
   */
  function useCaseView(csvData, connectors, isCloud) {
    const all = (Array.isArray(csvData.useCases) ? csvData.useCases : []).filter(useCase => useCase && useCase.id && useCase.label);
    const info = Object.fromEntries(all.map(useCase => [useCase.id, {
      label: useCase.label,
      definition: useCase.definition || '',
      altLabels: Array.isArray(useCase.altLabels) ? useCase.altLabels : []
    }]));
    const counts = new Map();
    for (const [, details] of shownConnectorEntries(connectors, isCloud)) {
      for (const id of details.useCases || []) counts.set(id, (counts.get(id) || 0) + 1);
    }
    const options = all
      .filter(useCase => (counts.get(useCase.id) || 0) >= USE_CASE_MIN_CARDS)
      .map(useCase => ({ id: useCase.id, ...info[useCase.id] }));
    return { info, options };
  }

  // The Self-Managed component catalog (the page with component_table::[]),
  // which the use-case chips on connector pages link to
  const CATALOG_PAGE = 'connect:components:about.adoc';

  /**
   * The "Use cases" line on a Self-Managed connector page: one chip per use
   * case the catalog's filter offers for this connector, each linking to the
   * catalog filtered to it (?usecase=<id>). Empty when the connector has none,
   * or when the catalog page is not in this build, so a chip never links to a
   * filter that does not exist.
   */
  function connectorUseCasesHtml(csvData, name, attributes) {
    if (!context.contentCatalog || !context.file || !context.file.pub) return '';
    const connectors = processConnectors(csvData);
    const details = connectors[Object.keys(connectors).find(c => c.trim().toLowerCase() === name.trim().toLowerCase())];
    if (!details || !details.useCases.length) return '';
    const { options } = useCaseView(csvData, connectors, false);
    const own = options.filter(({ id }) => details.useCases.includes(id));
    if (!own.length) return '';
    let catalog;
    try {
      catalog = context.contentCatalog.resolvePage(CATALOG_PAGE, context.file.src);
    } catch (e) {
      catalog = null;
    }
    if (!catalog || !catalog.pub || !catalog.pub.url) return '';
    const base = path.relative(context.file.pub.url, catalog.pub.url) || '.';
    const href = (id) => `${base.endsWith('/') ? base : base + '/'}?usecase=${encodeURIComponent(id)}`;
    const mergedNote = details.types.size > 1 ? " Applies to at least one of this component's types." : '';
    const chips = own.map(({ id, label, definition }) =>
      `<a class="connector-use-case" href="${escapeHtml(href(id))}" title="${escapeHtml((definition || `Use case: ${label}`) + mergedNote)}">` +
      `${USE_CASE_TAG_ICON}<span>${escapeHtml(label)}</span><span class="connector-use-case-arrow" aria-hidden="true">&rarr;</span></a>`
    ).join('');
    return `
            <div class="connector-use-cases" role="group" aria-labelledby="connectorUseCasesLabel">
              <span class="connector-use-cases-label" id="connectorUseCasesLabel">Use cases</span>
              <span class="connector-use-cases-chips">${chips}</span>
            </div>
            <style>${CONNECTOR_USE_CASES_CSS}</style>`;
  }

  /**
   * @param {Object<string,{label: string, definition: string, altLabels: Array<string>}>} useCaseInfo -
   *   every use case generate-rp-connect-info resolved, by ID (cards are searchable by all of them)
   * @param {Set<string>} offeredUseCases - the IDs the Use case filter offers (cards show chips for these)
   */
  function generateConnectorsHTMLCards(connectors, sqlDrivers, isCloud, showAllInfo, commercialNamesMap, uiRootPath, useCaseInfo = {}, offeredUseCases = new Set()) {
    return shownConnectorEntries(connectors, isCloud)
      .map(([connector, details], id) => {
        const { types, isCloudConnectorSupported, isLicensed } = details;
        // Use cases resolved against the taxonomy; chips only for the ones the filter offers
        const useCases = (details.useCases || []).filter(useCase => useCaseInfo[useCase]);
        const chipUseCases = useCases.filter(useCase => offeredUseCases.has(useCase));
        // A merged card (an input and an output, say) gets the union of its types' use cases
        const mergedNote = types.size > 1 ? "Applies to at least one of this component's types." : '';
        const useCaseBadges = chipUseCases
          .map(useCase => {
            const { label, definition } = useCaseInfo[useCase];
            const tooltip = [definition || `Use case: ${label}`, mergedNote].filter(Boolean).join(' ');
            return `<span class="badge badge-use-case" title="${escapeHtml(tooltip)}">${escapeHtml(label)}</span>`;
          })
          .join(' ');
        const useCaseSearchTerms = useCases
          .flatMap(useCase => [useCaseInfo[useCase].label, useCase, ...(useCaseInfo[useCase].altLabels || [])]);

        // The Cloud view lists only the types available in Cloud, in the badges
        // and in the type filter (http_server is an input in Cloud, not an output).
        const cloudView = isCloud && !showAllInfo;
        const shownTypes = Array.from(types.entries())
          .filter(([, commercialNames]) => !cloudView || Object.values(commercialNames).some(({ isCloudSupported }) => isCloudSupported));
        const typesList = shownTypes.map(([type]) => type);
        const typesDataAttr = typesList.join(',');

        // Get the first URL for the connector link
        const firstUrl = getFirstUrlFromTypesArray(Array.from(types.entries()), isCloud);

        // Generate type badges with links and tooltips
        const typeBadges = shownTypes
          .map(([type, commercialNames]) => {
            const uniqueCommercialNames = Object.keys(commercialNames);
            const badges = [];
            uniqueCommercialNames.forEach(commercialName => {
              const { urls = {}, isCloudSupported } = commercialNames[commercialName];
              if (cloudView && !isCloudSupported) return;
              const redpandaConnectUrl = urls.redpandaConnectUrl || '';
              const redpandaCloudUrl = urls.redpandaCloudUrl || '';
              let url = '';
              if (isCloud && !showAllInfo) {
                url = redpandaCloudUrl;
              } else {
                url = redpandaConnectUrl || redpandaCloudUrl;
              }
              // Always show the type badge, with or without a link
              if (url) {
                badges.push(`<a href="${escapeHtml(url)}" class="badge badge-type" title="Component type: ${escapeHtml(capitalize(type))}">${escapeHtml(capitalize(type))}</a>`);
              } else {
                badges.push(`<span class="badge badge-type" title="Component type: ${escapeHtml(capitalize(type))}">${escapeHtml(capitalize(type))}</span>`);
              }
            });
            const uniqueBadges = [...new Set(badges)];
            return uniqueBadges.join(' ');
          })
          .filter(item => item !== '')
          .join(' ');

        // Get support levels
        const supportLevels = Array.from(types.entries())
          .reduce((supportLevelMap, [type, commercialNames]) => {
            Object.entries(commercialNames).forEach(([commercialName, { supportLevel }]) => {
              if (!supportLevelMap[supportLevel]) {
                supportLevelMap[supportLevel] = {
                  types: new Set(),
                  commercialNames: new Map()
                };
              }
              supportLevelMap[supportLevel].types.add(type);
              if (!supportLevelMap[supportLevel].commercialNames.has(type)) {
                supportLevelMap[supportLevel].commercialNames.set(type, new Set());
              }
              if (commercialName.toLowerCase() !== connector.toLowerCase()) {
                supportLevelMap[supportLevel].commercialNames.get(type).add(commercialName);
              }
            });
            return supportLevelMap;
          }, {});

        // Generate support level badges with tooltips
        const supportBadges = Object.entries(supportLevels)
          .map(([supportLevel]) => {
            const tooltip = supportLevel.toLowerCase() === 'certified'
              ? 'Certified: Fully supported and tested by Redpanda'
              : 'Community: Community-supported connector';
            return `<span class="badge badge-support badge-support-${escapeHtml(supportLevel.toLowerCase())}" title="${tooltip}">${escapeHtml(capitalize(supportLevel))}</span>`;
          })
          .join(' ');

        const supportDataAttr = Object.keys(supportLevels).join(',');

        // Handle SQL drivers for SQL connectors - group by support level
        let sqlDriverBadges = '';
        if (connector.startsWith('sql_')) {
          const certifiedDrivers = sqlDrivers.certified.map(d => d.commercialName).join(', ');
          const communityDrivers = sqlDrivers.community.map(d => d.commercialName).join(', ');

          if (certifiedDrivers) {
            sqlDriverBadges += `<span class="badge badge-support badge-support-certified" title="Certified drivers: ${escapeHtml(certifiedDrivers)}">Certified: ${escapeHtml(certifiedDrivers)}</span>`;
          }
          if (communityDrivers) {
            sqlDriverBadges += `<span class="badge badge-support badge-support-community" title="Community drivers: ${escapeHtml(communityDrivers)}">Community: ${escapeHtml(communityDrivers)}</span>`;
          }
        }
        // Say which Cloud pipelines when every Cloud-available type agrees:
        // the ollama processors run only in GPU pipelines, and jira only outside them.
        const cloudEntries = Array.from(types.values())
          .flatMap(commercialNames => Object.values(commercialNames))
          .filter(({ isCloudSupported }) => isCloudSupported);
        const pipelineNote = cloudEntries.length && cloudEntries.every(e => e.gpuOnly)
          ? ' (GPU pipelines only)'
          : cloudEntries.length && cloudEntries.every(e => e.noGpu)
            ? ' (not in GPU pipelines)'
            : '';

        // Cloud support badge with tooltip, linked to the first Cloud-supported
        // type's Cloud page so the self-managed catalog still reaches Cloud docs
        const firstCloudUrl = (cloudEntries.find(({ urls = {} }) => urls.redpandaCloudUrl) || { urls: {} }).urls.redpandaCloudUrl;
        const cloudBadge = isCloudConnectorSupported && showAllInfo
          ? firstCloudUrl
            ? `<a href="${escapeHtml(firstCloudUrl)}" class="badge badge-cloud" title="Available in Redpanda Cloud${pipelineNote}">Cloud${pipelineNote}</a>`
            : `<span class="badge badge-cloud" title="Available in Redpanda Cloud${pipelineNote}">Cloud${pipelineNote}</span>`
          : '';

        // Enterprise license badge with tooltip
        const enterpriseBadge = isLicensed === 'Yes' && showAllInfo
          ? `<span class="badge badge-enterprise" title="Requires an Enterprise license">Enterprise</span>`
          : '';

        // Collect all unique commercial names for search
        const allCommercialNames = new Set();
        if (commercialNamesMap[connector]) {
          commercialNamesMap[connector].forEach(name => {
            if (name.toLowerCase() !== connector.toLowerCase() &&
                name.toLowerCase() !== 'n/a') {
              allCommercialNames.add(name);
            }
          });
        } else {
          Array.from(types.entries()).forEach(([type, commercialNames]) => {
            Object.keys(commercialNames).forEach(commercialName => {
              if (commercialName.toLowerCase() !== connector.toLowerCase() &&
                  commercialName.toLowerCase() !== 'n/a') {
                allCommercialNames.add(commercialName);
              }
            });
          });
        }
        const commercialNamesText = allCommercialNames.size > 0
          ? `<span class="search-terms">${escapeHtml(Array.from(allCommercialNames).join(' '))}</span>`
          : '';

        // Generate the card HTML
        return `
          <div class="component-card"
               id="component-${id}"
               data-name="${escapeHtml(`${connector.toLowerCase()} ${Array.from(allCommercialNames).join(' ').toLowerCase()}`)}"
               data-search="${escapeHtml([connector, ...allCommercialNames, ...useCaseSearchTerms].join(' ').toLowerCase())}"
               data-types="${escapeHtml(typesDataAttr.toLowerCase())}"
               data-support="${escapeHtml(supportDataAttr.toLowerCase())}"
               data-licensed="${escapeHtml(isLicensed.toLowerCase())}"
               data-cloud="${isCloudConnectorSupported ? 'yes' : 'no'}"${useCases.length ? `
               data-use-cases="${escapeHtml(useCases.join(','))}"` : ''}>
            <div class="card-header">
              <div class="card-header-content">
                ${firstUrl
                  // Same degradation as the type badge below: with no page to link
                  // to, the title is plain text rather than an anchor to nowhere.
                  ? `<a href="${escapeHtml(firstUrl)}" class="card-title-link">
                  <h3 class="card-title"><code>${escapeHtml(connector)}</code></h3>
                </a>`
                  : `<h3 class="card-title"><code>${escapeHtml(connector)}</code></h3>`}
                ${details.description
                  // No invented copy: a description comes from the component's own
                  // page, and a card without one simply has no description.
                  ? `<p class="card-description">${escapeHtml(details.description)}</p>`
                  : ''}
              </div>
              <div class="card-icon">
                ${(() => {
                  const icon = getConnectorIcon(connector, types, uiRootPath);
                  return icon.type === 'logo'
                    ? `<img src="${escapeHtml(icon.url)}" alt="" />`
                    : `<span class="card-icon-emoji" aria-hidden="true">${icon.symbol}</span>`;
                })()}
              </div>
            </div>
            <div class="card-body">
              <div class="card-badges">
                <div class="badge-group">
                  <span class="badge-group-label">Type</span>
                  <div class="badge-group-badges">
                    ${typeBadges}
                  </div>
                </div>
                ${(sqlDriverBadges || supportBadges) ? `
                <div class="badge-group">
                  <span class="badge-group-label">Support</span>
                  <div class="badge-group-badges">
                    ${sqlDriverBadges || supportBadges}
                  </div>
                </div>` : ''}
                ${(cloudBadge || enterpriseBadge) ? `
                <div class="badge-group">
                  <span class="badge-group-label">Availability</span>
                  <div class="badge-group-badges">
                    ${cloudBadge}
                    ${enterpriseBadge}
                  </div>
                </div>` : ''}
                ${useCaseBadges ? `
                <div class="badge-group">
                  <span class="badge-group-label">Use case</span>
                  <div class="badge-group-badges">
                    ${useCaseBadges}
                  </div>
                </div>` : ''}
              </div>
            </div>
            ${commercialNamesText}
          </div>`;
      })
      .filter(card => card !== '')
      .join('');
  }

  /**
   * Registers a block macro to generate a searchable and sortable table displaying connector data.
   *
   * This macro creates a dynamic HTML table that lists all available connectors, allowing filtering and sorting
   * by type, support level, and cloud support.
   *
   *
   * The table includes:
   * - Name: The name of the connector.
   * - Connector Type: The type of the connector.
   * - Support Level: The support level for each connector, including associated SQL drivers if applicable.
   * - Enterprise Licensed: Indicates whether the connector requires an Enterprise license.
   * - Cloud Support: Shows if the connector is supported in Redpanda Cloud.
   *
   * Filters:
   * - Type: Allows the user to filter by connector type.
   * - Support: Allows the user to filter by support level (if not in cloud view).
   * - Search: A text input field to search for connectors by name.
   *
   * Attributes:
   * - `all`: If specified, displays additional columns such as support level, enterprise licensing, and cloud support.
   *
   * Data Sources:
   * - `csvData`: Parsed CSV data that provides details about each connector.
   * - SQL driver data is processed separately using the `processSqlDrivers` function, which groups the drivers by support level.
   *
   * Example usage in AsciiDoc:
   * ```
   * component_table::[]
   * ```
   *
   * Example output:
   * ```
   * | Name  | Connector Type | Support Level    | Enterprise Licensed | Cloud Support |
   * |-------|----------------|----------------  |---------------------|-----|
   * | SQL   | Input, Output  | Certified        | No                  | No  |
   * ```
   *
   * @param {Object} parent - The parent document where the table will be inserted.
   * @param {string} target - Target element.
   * @param {Object} attributes - Positional attributes passed to the macro.
   *   - `all`: If provided, extra columns are shown.
   */
  registry.blockMacro(function () {
    const self = this;
    self.named('component_table');
    self.positionalAttributes(['all']); // Allows for displaying all data
    self.process((parent, target, attributes) => {
      const docAttributes = parent.getDocument().getAttributes();
      const isCloud = docAttributes['env-cloud'] !== undefined;
      const showAllInfo = attributes?.all

      const csvData = context.config?.attributes?.csvData || null;
      if (!csvData) return logger.error(`CSV data is not available for ${docAttributes['page-relative-src-path']}. Make sure your playbook includes the generate-rp-connect-info extension.`)

      // Path from this page to the UI bundle root, so logos resolve at any page depth
      const uiRootPath = resolveUiRootPath();

      // Get the enriched commercial names map (includes CSV + AsciiDoc names)
      const commercialNamesMap = context.config?.attributes?.commercialNamesMap || {};

      const sqlDriversData = processSqlDrivers(csvData);

      const types = new Set();
      const uniqueSupportLevel = new Set();
      csvData.data.forEach(row => {
        if (row.type && row.type.toLowerCase() !== 'sql_driver') types.add(row.type);
        if (row.support_level) uniqueSupportLevel.add(row.support_level);
      });

      const createDropdownCheckboxOptions = (values, id) =>
        Array.from(values)
          .map(value => `
            <label class="dropdown-checkbox-option">
              <input type="checkbox" value="${escapeHtml(value)}" checked>
              <span>${escapeHtml(capitalize(value).replace("_", " "))}</span>
            </label>`)
          .join('');

      // Use cases: the ones generate-rp-connect-info resolved against the docs
      // taxonomy (csvData.useCases, in taxonomy order). The filter offers one
      // only when at least USE_CASE_MIN_CARDS cards in this view have it. No
      // data, no filter.
      const connectors = processConnectors(csvData);
      const { info: useCaseInfo, options: useCaseOptions } = useCaseView(csvData, connectors, isCloud);
      const offeredUseCases = new Set(useCaseOptions.map(({ id }) => id));
      const solutionsUrl = `${resolveSiteRootPath() || ''}/${SOLUTIONS_CATALOG_PATH}`;

      // One dropdown filter. The toggle discloses a group of checkboxes (not
      // an ARIA menu, which promises arrow-key navigation the checkboxes do
      // not have), and it is named by the label plus its current value.
      const filterGroupHtml = ({ id, label, labelId = `${id}Label`, value, options }) => `
          <div class="filter-group">
            <label for="${id}Toggle" id="${labelId}">${label}:</label>
            <div class="dropdown-checkbox-wrapper">
              <button type="button" class="dropdown-checkbox-toggle" id="${id}Toggle" aria-expanded="false" aria-controls="${id}Menu" aria-labelledby="${labelId} ${id}Value">
                <span class="dropdown-text" id="${id}Value">${value}</span>
                <span class="dropdown-arrow" aria-hidden="true">▼</span>
              </button>
              <div class="dropdown-checkbox-menu" id="${id}Menu" role="group" aria-labelledby="${labelId}">
                ${options}
              </div>
            </div>
          </div>`;
      const yesNoOptions = `
                <label class="dropdown-checkbox-option">
                  <input type="checkbox" value="yes" checked>
                  <span>Yes</span>
                </label>
                <label class="dropdown-checkbox-option">
                  <input type="checkbox" value="no" checked>
                  <span>No</span>
                </label>`;

      let tableHtml = `
        <script>
          // Wrap everything to avoid breaking page scripts
          (function() {
            try {
              // Define all functions early so inline handlers can use them
              window.getQueryParams = function() {
                const params = {};
                const searchParams = new URLSearchParams(window.location.search);
                searchParams.forEach((value, key) => {
                  params[key] = value.toLowerCase();
                });
                return params;
              };

              window.filterComponentTable = ${filterComponentTable.toString()};
          window.updateURLParameters = ${updateURLParameters.toString()};
          window.catalogStatusText = ${catalogStatusText.toString()};

          // Clear filters: every checkbox filter back to its unfiltered state,
          // the search emptied, focus back in the search box
          window.clearCatalogFilters = function() {
            const search = document.getElementById('componentTableSearch');
            if (search) search.value = '';
            ['typeFilterMenu', 'supportFilterMenu', 'cloudSupportFilterMenu', 'enterpriseFilterMenu'].forEach(function(id) {
              document.querySelectorAll('#' + id + ' input[type="checkbox"]').forEach(function(cb) { cb.checked = true; });
            });
            document.querySelectorAll('#useCaseFilterMenu input[type="checkbox"]').forEach(function(cb) { cb.checked = false; });
            window.filterComponentTable({ type: 'clear' });
            if (search) search.focus();
          };
          ${useCaseOptions.length ? `
          // Solutions for the selected use cases, from the solutions catalog the
          // solutions-catalog extension publishes. Fetched once, on first use; a
          // build without it (or a failed fetch) shows nothing.
          (function() {
            const escapeHtml = ${escapeHtml.toString()};
            const matchSolutions = ${matchSolutions.toString()};
            const solutionsMarkup = ${solutionsMarkup.toString()};
            let catalogPromise = null;
            let latest = 0;
            const loadCatalog = function(url) {
              if (!catalogPromise) {
                catalogPromise = fetch(url, { headers: { Accept: 'application/json' } })
                  .then(response => (response.ok ? response.json() : null))
                  .catch(() => null);
              }
              return catalogPromise;
            };
            let rendered = '';
            // Shows the solutions for these use-case IDs, then calls done with
            // how many there are (0 when none or no catalog)
            window.updateCatalogSolutions = function(ids, done) {
              const finish = typeof done === 'function' ? done : function() {};
              const panel = document.getElementById('componentCatalogSolutions');
              if (!panel) return finish(0);
              const request = ++latest;
              const show = function(html) {
                // Same list as before: leave the DOM (and a reader's place in it) alone
                if (html === rendered) return;
                rendered = html;
                panel.innerHTML = html;
                panel.hidden = !html;
              };
              if (!ids || !ids.length) {
                show('');
                return finish(0);
              }
              let info = {};
              try { info = JSON.parse(panel.dataset.useCases || '{}'); } catch (e) {}
              loadCatalog(panel.dataset.solutionsUrl).then(function(catalog) {
                if (request !== latest) return; // a newer selection won
                const matches = matchSolutions(catalog, ids, info);
                show(solutionsMarkup(matches, ids, info, escapeHtml));
                finish(matches.length);
              });
            };
          })();` : ''}

          // Helper to close a specific dropdown
          window.closeDropdown = function(menu) {
            if (!menu) return;
            menu.classList.remove('show');
            const toggle = menu.parentNode.querySelector('.dropdown-checkbox-toggle');
            if (toggle) {
              toggle.classList.remove('open');
              toggle.setAttribute('aria-expanded', 'false');
            }
          };

          // Click outside handler - only attached when dropdown is open
          window.dropdownClickOutsideHandler = null;

          window.toggleDropdownCheckbox = function(filterId) {
            const toggle = document.getElementById(filterId + 'Toggle');
            const menu = document.getElementById(filterId + 'Menu');

            if (!toggle || !menu) return;

            const isOpen = menu.classList.contains('show');

            // Close all other dropdowns first
            document.querySelectorAll('.dropdown-checkbox-menu.show').forEach(dropdown => {
              if (dropdown !== menu) {
                window.closeDropdown(dropdown);
              }
            });

            if (isOpen) {
              // Closing this dropdown
              window.closeDropdown(menu);
              // Remove the click outside handler
              if (window.dropdownClickOutsideHandler) {
                document.removeEventListener('click', window.dropdownClickOutsideHandler);
                window.dropdownClickOutsideHandler = null;
              }
            } else {
              // Opening this dropdown
              menu.classList.add('show');
              toggle.classList.add('open');
              toggle.setAttribute('aria-expanded', 'true');

              // Add click outside handler (only once)
              if (!window.dropdownClickOutsideHandler) {
                window.dropdownClickOutsideHandler = function(event) {
                  // Check if click is inside a dropdown wrapper
                  if (event.target.closest('.dropdown-checkbox-wrapper')) {
                    // Click is inside dropdown, do nothing
                    return;
                  }
                  // Click is outside dropdowns - close them
                  document.querySelectorAll('.dropdown-checkbox-menu.show').forEach(window.closeDropdown);
                  // Remove this handler
                  document.removeEventListener('click', window.dropdownClickOutsideHandler);
                  window.dropdownClickOutsideHandler = null;
                };
                // Add on next tick so this click doesn't trigger it
                setTimeout(() => {
                  document.addEventListener('click', window.dropdownClickOutsideHandler, { capture: false, passive: true });
                }, 0);
              }
            }
          };

          // Escape closes an open filter dropdown and returns focus to its toggle
          document.addEventListener('keydown', function(event) {
            if (event.key !== 'Escape') return;
            document.querySelectorAll('.dropdown-checkbox-menu.show').forEach(menu => {
              window.closeDropdown(menu);
              const toggle = menu.parentNode.querySelector('.dropdown-checkbox-toggle');
              if (toggle) toggle.focus();
            });
          });

          window.updateDropdownText = function(filterId, allSelectedText, someSelectedText) {
            const menu = document.getElementById(filterId + 'Menu');
            const toggle = document.getElementById(filterId + 'Toggle');

            if (!menu || !toggle) return;

            const checkboxes = menu.querySelectorAll('input[type="checkbox"]');
            const checkedCount = menu.querySelectorAll('input[type="checkbox"]:checked').length;
            const totalCount = checkboxes.length;
            const textElement = toggle.querySelector('.dropdown-text');

            if (!textElement) return;

            function getSingularText(pluralText) {
              if (pluralText.includes('Types Selected')) return 'Type Selected';
              else if (pluralText.includes('Support Levels Selected')) return 'Support Level Selected';
              else if (pluralText.includes('Options Selected')) return 'Option Selected';
              else if (pluralText.includes('Items Selected')) return 'Item Selected';
              else if (pluralText.includes('Categories Selected')) return 'Category Selected';
              else if (pluralText.includes('Filters Selected')) return 'Filter Selected';
              else if (pluralText.endsWith('s Selected')) return pluralText.replace(/s Selected$/, ' Selected');
              else if (pluralText.endsWith('ies Selected')) return pluralText.replace(/ies Selected$/, 'y Selected');
              else return pluralText;
            }

            if (checkedCount === 0) {
              textElement.textContent = 'None Selected';
            } else if (checkedCount === totalCount) {
              textElement.textContent = allSelectedText;
            } else if (checkedCount === 1) {
              const checkedBox = menu.querySelector('input[type="checkbox"]:checked');
              if (checkedBox) {
                const label = checkedBox.nextElementSibling;
                textElement.textContent = label ? label.textContent : getSingularText(someSelectedText);
              }
            } else {
              textElement.textContent = checkedCount + ' ' + someSelectedText;
            }
          };

          // Returns the focusable elements inside the badge legend modal (for the focus trap)
          window.getBadgeLegendFocusableElements = function(modal) {
            return Array.from(modal.querySelectorAll(
              'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            ));
          };

          window.openBadgeLegend = function() {
            const modal = document.getElementById('badgeLegendModal');
            if (modal) {
              // Remember the trigger so focus can be restored on close
              window.badgeLegendTriggerElement = document.activeElement;
              modal.classList.add('show');
              document.body.style.overflow = 'hidden';
              // Move focus into the modal
              const focusable = window.getBadgeLegendFocusableElements(modal);
              if (focusable.length > 0) focusable[0].focus();
            }
          };

          window.closeBadgeLegend = function() {
            const modal = document.getElementById('badgeLegendModal');
            if (modal) {
              modal.classList.remove('show');
            }
            // Always restore page scrolling, whichever path closed the modal
            document.body.style.overflow = '';
            // Return focus to the element that opened the modal
            if (window.badgeLegendTriggerElement && typeof window.badgeLegendTriggerElement.focus === 'function') {
              window.badgeLegendTriggerElement.focus();
            }
            window.badgeLegendTriggerElement = null;
          };
            } catch (error) {
              console.error('[Component Catalog] Error loading functions:', error);
            }
          })();
        </script>
        <div class="table-filters component-catalog-filters">
          <div class="table-filters-search">
            <input class="table-search" type="text" id="componentTableSearch" placeholder="Search for components..." aria-label="Search components" style="flex: 1;">
            <button type="button" class="badge-legend-button" title="View badge legend" aria-label="View badge legend">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10 0C4.48 0 0 4.48 0 10s4.48 10 10 10 10-4.48 10-10S15.52 0 10 0zm1 15H9v-2h2v2zm0-4H9V5h2v6z"/>
              </svg>
            </button>
          </div>
${filterGroupHtml({ id: 'typeFilter', label: 'Type', value: 'All Types Selected', options: createDropdownCheckboxOptions(types, 'typeFilter') })}
      `;

      if (useCaseOptions.length) {
        tableHtml += filterGroupHtml({
          id: 'useCaseFilter',
          label: 'Use case',
          value: 'Any use case',
          options: `
                <button type="button" class="dropdown-checkbox-clear" id="useCaseFilterClear">Clear</button>${useCaseOptions.map(({ id, label, definition }) => `
                <label class="dropdown-checkbox-option"${definition ? ` title="${escapeHtml(definition)}"` : ''}>
                  <input type="checkbox" value="${escapeHtml(id)}">
                  <span>${escapeHtml(label)}</span>
                </label>`).join('')}`
        });
      }

      if (!isCloud) {
        tableHtml += filterGroupHtml({ id: 'supportFilter', label: 'Support', labelId: 'labelForSupportFilter', value: 'All Support Levels Selected', options: createDropdownCheckboxOptions(uniqueSupportLevel, 'supportFilter') });
      }

      if (showAllInfo) {
        tableHtml += filterGroupHtml({ id: 'cloudSupportFilter', label: 'Available in Cloud', value: 'All Options Selected', options: yesNoOptions });
        tableHtml += filterGroupHtml({ id: 'enterpriseFilter', label: 'Enterprise License', value: 'All Options Selected', options: yesNoOptions });
      }

      const filterCount = 1 + (useCaseOptions.length ? 1 : 0) + (isCloud ? 0 : 1) + (showAllInfo ? 2 : 0);

      tableHtml += `</div>
        <!-- CSS styles for card layout and modal -->
        <style>
          /* Filter panel: search on its own row, then the dropdown filters in
             balanced, equal-width columns (see filterLayoutCss). Selectors
             carry three classes to win over the UI bundle's .doc rules,
             including its column layout below 768px. */
          .table-filters.component-catalog-filters {
            container: catalog-filters / inline-size;
            /* Above the cards and the solutions list, so an open dropdown
               overlays them (the container is its own stacking context) */
            position: relative;
            z-index: 2;
            display: flex;
            flex-direction: row;
            flex-wrap: wrap;
            align-items: flex-end;
            gap: ${FILTER_GAP_PX}px;
          }

          .table-filters.component-catalog-filters > .table-filters-search {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            flex: 1 1 100%;
            min-width: 0;
          }

          .table-filters.component-catalog-filters .table-search {
            flex: 1 1 auto;
            min-width: 0;
            max-width: none;
            margin: 0;
          }

          .table-filters.component-catalog-filters > .filter-group {
            flex: 1 1 ${FILTER_MIN_WIDTH_PX}px;
            min-width: 0;
            max-width: none;
            margin: 0;
          }

          .table-filters.component-catalog-filters .dropdown-checkbox-wrapper {
            min-width: 0;
          }

          /* A long option label ("Change data capture") wraps in a narrow
             menu: keep the second line aligned with the first, not under the
             checkbox. */
          .table-filters.component-catalog-filters .dropdown-checkbox-option {
            display: flex;
            align-items: flex-start;
            gap: 0.5rem;
          }

          .table-filters.component-catalog-filters .dropdown-checkbox-option > input {
            flex: 0 0 auto;
            margin-top: 0.2em;
          }

          ${filterLayoutCss(filterCount)}

          .component-cards-container {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 1rem;
            margin-top: 1rem;
            padding-bottom: 2rem;
          }

          .component-card {
            border: 1px solid #e0e0e0;
            border-radius: 8px;
            background: white;
            transition: all 0.2s ease;
            display: flex;
            flex-direction: column;
          }

          .component-card.hidden {
            display: none !important;
          }

          .component-card:hover {
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
            transform: translateY(-2px);
            border-color: #d0d0d0;
          }

          .component-card .card-header {
            padding: 1rem 1rem 0.75rem 1rem;
            border-bottom: 1px solid #f0f0f0;
            display: flex;
            align-items: flex-start;
            gap: 1rem;
          }

          .component-card .card-header-content {
            flex: 1;
            min-width: 0;
          }

          .component-card .card-icon {
            flex-shrink: 0;
            width: 40px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
          }

          .component-card .card-icon img {
            width: 100%;
            height: 100%;
            object-fit: contain;
          }

          .component-card .card-icon-emoji {
            font-size: 2rem;
            line-height: 1;
          }

          .component-card .card-body {
            padding: 0.75rem 1rem 1rem 1rem;
          }

          .component-card .card-title-link {
            text-decoration: none;
            color: inherit;
            display: block;
          }

          .component-card .card-title-link:hover {
            color: #0066cc;
          }

          .component-card .card-title {
            margin: 0 0 0.375rem 0;
            font-size: 1rem;
            font-weight: 600;
            color: #333;
          }

          .component-card .card-title code {
            background: transparent;
            padding: 0;
            font-size: inherit;
            color: inherit;
          }

          .component-card .card-description {
            margin: 0;
            font-size: 0.8125rem;
            line-height: 1.5;
            color: #666;
          }


          .component-card .card-badges {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
          }

          .badge-group {
            display: flex;
            flex-direction: column;
            gap: 0.4rem;
          }

          .badge-group-label {
            font-size: 0.6875rem;
            font-weight: 600;
            color: #6b7280;
            text-transform: uppercase;
            letter-spacing: 0.05em;
          }

          .badge-group-badges {
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
            align-items: center;
          }

          /* Scoped to this macro's two badge containers (the card's
             .badge-group-badges and the legend modal's .badge-legend-item),
             not a bare .badge -- the site-wide .badge class from docs-ui's
             metadata.css (border-radius: 10px) is what badge:[] macro output
             uses on the same page, and a bare rule here overrode it.
             :where() keeps the specificity of a bare .badge, so the
             .badge-type, .badge-support, .badge-cloud and .badge-enterprise
             rules below still win by source order. */
          :where(.badge-group-badges, .badge-legend-item) .badge {
            display: inline-block;
            border-radius: 6px;
            text-decoration: none;
            cursor: help;
            transition: all 0.2s ease;
            line-height: 1.4;
          }

          .badge-type {
            white-space: nowrap;
          }

          .badge-support {
            white-space: normal;
            word-break: break-word;
          }

          .badge-cloud,
          .badge-enterprise {
            white-space: nowrap;
          }

          /* PRIMARY: Type badges - Subtle colors for easy scanning */
          .badge-type {
            padding: 0.35rem 0.75rem;
            font-size: 0.75rem;
            font-weight: 600;
            border: 1px solid;
            cursor: pointer;
            letter-spacing: 0.01em;
            border-radius: 4px;
          }

          /* Input - Soft blue */
          .badge-type[title*="Input"] {
            background: #eff6ff;
            color: #1e40af;
            border-color: #bfdbfe;
          }

          .badge-type[title*="Input"]:hover {
            background: #dbeafe;
          }

          /* Output - Soft green */
          .badge-type[title*="Output"] {
            background: #f0fdf4;
            color: #166534;
            border-color: #bbf7d0;
          }

          .badge-type[title*="Output"]:hover {
            background: #dcfce7;
          }

          /* Processor - Soft purple */
          .badge-type[title*="Processor"] {
            background: #faf5ff;
            color: #7c3aed;
            border-color: #e9d5ff;
          }

          .badge-type[title*="Processor"]:hover {
            background: #f3e8ff;
          }

          /* Others - Soft amber */
          .badge-type:not([title*="Input"]):not([title*="Output"]):not([title*="Processor"]) {
            background: #fefce8;
            color: #a16207;
            border-color: #fde68a;
          }

          .badge-type:not([title*="Input"]):not([title*="Output"]):not([title*="Processor"]):hover {
            background: #fef9c3;
          }

          /* SECONDARY: Support badges - Subtle outline style */
          .badge-support {
            padding: 0.4rem 0.75rem;
            font-size: 0.75rem;
            font-weight: 500;
            background: transparent;
            border: 1px solid;
            border-radius: 4px;
            display: inline-block;
            word-wrap: break-word;
            max-width: 100%;
          }

          .badge-support-certified {
            color: #047857;
            border-color: #6ee7b7;
          }

          .badge-support-certified:hover {
            background: #ecfdf5;
          }

          .badge-support-community {
            color: #7c2d12;
            border-color: #fdba74;
          }

          .badge-support-community:hover {
            background: #fff7ed;
          }

          /* TERTIARY: Status badges - Very subtle */
          .badge-cloud,
          .badge-enterprise {
            padding: 0.25rem 0.6rem;
            font-size: 0.65rem;
            font-weight: 500;
            border: 1px solid;
            border-radius: 4px;
          }

          .badge-cloud {
            background: #f0f9ff;
            color: #0c4a6e;
            border-color: #bae6fd;
          }

          .badge-cloud:hover {
            background: #e0f2fe;
          }

          .badge-enterprise {
            background: #fdf4ff;
            color: #86198f;
            border-color: #f0abfc;
          }

          .badge-enterprise:hover {
            background: #fae8ff;
          }

          /* Use case chips: neutral, the same size as the Availability badges */
          /* Same look as the use-case chips on connector pages */
          .badge-use-case {
            padding: 0.2rem 0.6rem;
            font-size: 0.68rem;
            font-weight: 600;
            border: 1px solid #f6c9bb;
            border-radius: 999px;
            background: #fdf0ec;
            color: #a32d0c;
            white-space: nowrap;
          }

          .catalog-visually-hidden {
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border: 0;
          }

          .catalog-empty {
            margin-top: 1rem;
            padding: 1rem;
            border: 1px dashed #d1d5db;
            border-radius: 8px;
            text-align: center;
          }

          .catalog-empty[hidden] {
            display: none;
          }

          .catalog-empty p {
            margin: 0 0 0.75rem 0;
          }

          .catalog-empty-clear,
          .dropdown-checkbox-clear {
            cursor: pointer;
            font: inherit;
            border-radius: 4px;
          }

          .catalog-empty-clear {
            padding: 0.4rem 0.9rem;
            border: 1px solid #d1d5db;
            background: #fff;
            color: #1f2937;
          }

          /* Clear, at the top of the Use case menu */
          .dropdown-checkbox-menu .dropdown-checkbox-clear {
            display: block;
            width: 100%;
            padding: 0.5rem 0.75rem;
            border: 0;
            border-bottom: 1px solid #e5e7eb;
            background: transparent;
            color: #1d4ed8;
            text-align: left;
            font-size: 0.875rem;
          }

          html[data-theme="dark"] .catalog-empty-clear {
            background: rgba(255, 255, 255, 0.07);
            border-color: rgba(255, 255, 255, 0.2);
            color: #fff;
          }

          html[data-theme="dark"] .dropdown-checkbox-menu .dropdown-checkbox-clear {
            color: #93c5fd;
            border-bottom-color: rgba(255, 255, 255, 0.1);
          }

          html[data-theme="dark"] .badge-use-case {
            background: rgba(226, 64, 27, 0.14);
            border-color: rgba(241, 93, 97, 0.4);
            color: #ffb59e;
          }

          /* At least 4.5:1 on the dark card background */
          html[data-theme="dark"] .badge-group-label {
            color: #9ca3af;
          }

          /* A quiet hint, not a panel: solutions are secondary to the cards */
          .catalog-solutions {
            margin: 0.75rem 0 0 0;
            font-size: 0.875rem;
            color: #4b5563;
          }

          .catalog-solutions .catalog-solutions-hint {
            margin: 0;
          }

          .catalog-solutions[hidden] {
            display: none;
          }

          html[data-theme="dark"] .catalog-solutions {
            color: #d0d5dd;
          }

          .badge-legend-button {
            background: #f5f5f5;
            border: 1px solid #e0e0e0;
            border-radius: 50%;
            width: 36px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.2s ease;
            color: #616161;
          }

          .badge-legend-button:hover {
            background: #e0e0e0;
            color: #333;
          }

          .badge-legend-modal {
            display: none;
            position: fixed !important;
            z-index: 10000 !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            height: 100% !important;
            background-color: rgba(0, 0, 0, 0.5) !important;
            animation: fadeIn 0.2s ease;
          }

          .badge-legend-modal.show {
            display: flex !important;
            align-items: center;
            justify-content: center;
          }

          .badge-legend-content {
            background-color: white;
            border-radius: 8px;
            max-width: 600px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
            animation: slideIn 0.3s ease;
            position: relative;
            z-index: 10001;
          }

          .badge-legend-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 1.5rem;
            border-bottom: 1px solid #e0e0e0;
          }

          .badge-legend-header h3 {
            margin: 0;
            font-size: 1.25rem;
            color: #333;
          }

          .badge-legend-close {
            background: none;
            border: none;
            font-size: 2rem;
            color: #6b7280;
            cursor: pointer;
            line-height: 1;
            padding: 0;
            width: 30px;
            height: 30px;
          }

          .badge-legend-close:hover {
            color: #333;
          }

          .badge-legend-body {
            padding: 1.5rem;
          }

          .badge-legend-section {
            margin-bottom: 2rem;
          }

          .badge-legend-section:last-child {
            margin-bottom: 0;
          }

          .badge-legend-section h4 {
            margin: 0 0 1rem 0;
            font-size: 1rem;
            color: #666;
            font-weight: 600;
          }

          .badge-legend-item {
            display: flex;
            align-items: flex-start;
            gap: 1rem;
            margin-bottom: 1rem;
          }

          .badge-legend-item:last-child {
            margin-bottom: 0;
          }

          .badge-legend-item .badge {
            flex-shrink: 0;
            margin-top: 0.15rem;
          }

          .badge-legend-item p {
            margin: 0;
            color: #666;
            line-height: 1.5;
          }

          .search-terms {
            position: absolute;
            left: -9999px;
            width: 1px;
            height: 1px;
            overflow: hidden;
          }

          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }

          @keyframes slideIn {
            from {
              transform: translateY(-20px);
              opacity: 0;
            }
            to {
              transform: translateY(0);
              opacity: 1;
            }
          }

          /* Dark mode styles */
          html[data-theme="dark"] .component-card {
            background: #1e2128;
            border-color: rgba(58, 63, 72, 0.3);
          }

          html[data-theme="dark"] .component-card:hover {
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            border-color: rgba(255, 255, 255, 0.15);
          }

          html[data-theme="dark"] .component-card .card-header {
            border-bottom-color: rgba(255, 255, 255, 0.07);
          }

          html[data-theme="dark"] .component-card .card-title {
            color: #fff;
          }

          html[data-theme="dark"] .component-card .card-description {
            color: #d0d5dd;
          }

          html[data-theme="dark"] .component-card .card-title-link:hover {
            color: #f15d61;
          }

          html[data-theme="dark"] :where(.badge-group-badges, .badge-legend-item) .badge {
            background: rgba(255, 255, 255, 0.07);
            border-color: rgba(255, 255, 255, 0.15);
            color: #d0d5dd;
          }

          /* .badge-input/.badge-output/.badge-processor/.badge-self-managed
             removed here: none of them are ever emitted by this macro (badge
             markup only ever carries class="badge badge-type", with the type
             itself in the title/text, never as its own class), and none had a
             light-mode rule either -- these were always fully dead, not a
             dark-mode-only regression. */

          html[data-theme="dark"] .badge-enterprise {
            background: rgba(202, 138, 4, 0.2);
            border-color: rgba(250, 197, 21, 0.3);
            color: #fde047;
          }

          html[data-theme="dark"] .badge-cloud {
            background: rgba(5, 150, 105, 0.2);
            border-color: rgba(110, 231, 183, 0.3);
            color: #6ee7b7;
          }

          html[data-theme="dark"] .badge-legend-button {
            background: rgba(255, 255, 255, 0.07);
            color: #d0d5dd;
          }

          html[data-theme="dark"] .badge-legend-button:hover {
            background: rgba(255, 255, 255, 0.12);
            color: #fff;
          }

          /* .badge-legend-overlay removed here: the overlay/backdrop is
             .badge-legend-modal itself (position: fixed, rgba(0,0,0,0.5)
             background, !important in light mode) -- no element ever carries
             a badge-legend-overlay class, and the black 50%-opacity backdrop
             already reads correctly against either theme. */

          html[data-theme="dark"] .badge-legend-content {
            background: #101828;
            border-color: rgba(255, 255, 255, 0.15);
          }

          html[data-theme="dark"] .badge-legend-header {
            background: rgba(255, 255, 255, 0.05);
            border-bottom-color: rgba(255, 255, 255, 0.1);
          }

          /* The legend title is <h3 id="badgeLegendTitle">, not a
             .badge-legend-title element. */
          html[data-theme="dark"] #badgeLegendTitle {
            color: #fff;
          }

          html[data-theme="dark"] .badge-legend-close {
            color: #d0d5dd;
          }

          html[data-theme="dark"] .badge-legend-close:hover {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
          }

          /* Section titles are a plain <h4> inside .badge-legend-section --
             there is no .badge-legend-section-title class. */
          html[data-theme="dark"] .badge-legend-section h4 {
            color: #fff;
          }

          html[data-theme="dark"] .badge-legend-item {
            border-bottom-color: rgba(255, 255, 255, 0.07);
          }

          html[data-theme="dark"] .badge-legend-item:hover {
            background: rgba(255, 255, 255, 0.05);
          }

          /* Item labels are a plain <p> inside .badge-legend-item -- there is
             no .badge-legend-item-label class. */
          html[data-theme="dark"] .badge-legend-item p {
            color: #d0d5dd;
          }

          /* Invert dark/black logos for visibility in dark mode */
          html[data-theme="dark"] .card-icon img[src*="apache-kafka.svg"],
          html[data-theme="dark"] .card-icon img[src*="cassandra.svg"],
          html[data-theme="dark"] .card-icon img[src*="java-script.svg"],
          html[data-theme="dark"] .card-icon img[src*="pinecone.svg"],
          html[data-theme="dark"] .card-icon img[src*="postgre-sql.svg"],
          html[data-theme="dark"] .card-icon img[src*="splunk.svg"] {
            filter: brightness(0) invert(1);
          }

          @media (max-width: 768px) {
            .component-cards-container {
              grid-template-columns: 1fr;
            }

            .badge-legend-content {
              width: 95%;
              max-height: 90vh;
            }

            .badge-legend-header,
            .badge-legend-body {
              padding: 1rem;
            }
          }
        </style>
        <div class="catalog-visually-hidden" id="componentCatalogStatus" role="status" aria-live="polite"></div>
        ${useCaseOptions.length ? `<div class="catalog-solutions" id="componentCatalogSolutions" hidden
             data-solutions-url="${escapeHtml(solutionsUrl)}"
             data-use-cases="${escapeHtml(JSON.stringify(Object.fromEntries(useCaseOptions.map(({ id, label, altLabels }) => [id, { label, altLabels }]))))}"></div>` : ''}
        <div class="catalog-empty" id="componentCatalogEmpty" hidden>
          <p>No components match these filters.</p>
          <button type="button" class="catalog-empty-clear" id="componentCatalogClear">Clear filters</button>
        </div>
        <div class="component-cards-container" id="componentCardsContainer">
          ${generateConnectorsHTMLCards(connectors, sqlDriversData, isCloud, showAllInfo, commercialNamesMap, uiRootPath, useCaseInfo, offeredUseCases)}
        </div>
        <script>
          // Badge legend modal functions
          (function() {
            try {
              // Create modal HTML
              const modalHTML = \`<div id="badgeLegendModal" class="badge-legend-modal" role="dialog" aria-labelledby="badgeLegendTitle" aria-modal="true">
          <div class="badge-legend-content">
            <div class="badge-legend-header">
              <h3 id="badgeLegendTitle">Component Badge Legend</h3>
              <button type="button" class="badge-legend-close"  aria-label="Close">&times;</button>
            </div>
            <div class="badge-legend-body">
              <div class="badge-legend-section">
                <h4>Component Types</h4>
                <div class="badge-legend-item">
                  <span class="badge badge-type" title="Component type: Input">Input</span>
                  <p>Receives data from external sources into the pipeline</p>
                </div>
                <div class="badge-legend-item">
                  <span class="badge badge-type" title="Component type: Output">Output</span>
                  <p>Sends data from the pipeline to external destinations</p>
                </div>
                <div class="badge-legend-item">
                  <span class="badge badge-type" title="Component type: Processor">Processor</span>
                  <p>Transforms or filters data as it flows through the pipeline</p>
                </div>
                <div class="badge-legend-item">
                  <span class="badge badge-type" title="Component type: Cache">Cache</span>
                  <p>Stores data temporarily for faster access</p>
                </div>
                <div class="badge-legend-item">
                  <span class="badge badge-type" title="Component type: Buffer">Buffer</span>
                  <p>Temporarily holds messages to manage throughput</p>
                </div>
                <div class="badge-legend-item">
                  <span class="badge badge-type" title="Component type: Metric">Metric</span>
                  <p>Collects and exports metrics about pipeline performance</p>
                </div>
                <div class="badge-legend-item">
                  <span class="badge badge-type" title="Component type: Scanner">Scanner</span>
                  <p>Scans and processes messages based on patterns</p>
                </div>
                <div class="badge-legend-item">
                  <span class="badge badge-type" title="Component type: Rate Limit">Rate Limit</span>
                  <p>Controls the rate of message processing</p>
                </div>
                <div class="badge-legend-item">
                  <span class="badge badge-type" title="Component type: Tracer">Tracer</span>
                  <p>Tracks and traces message flow through the pipeline</p>
                </div>
              </div>
              <div class="badge-legend-section">
                <h4>Support Levels</h4>
                <div class="badge-legend-item">
                  <span class="badge badge-support badge-support-certified">Certified</span>
                  <p>Fully supported and tested by Redpanda with guaranteed reliability</p>
                </div>
                <div class="badge-legend-item">
                  <span class="badge badge-support badge-support-community">Community</span>
                  <p>Community-supported connector with best-effort maintenance</p>
                </div>
              </div>
              ${useCaseOptions.length ? `
              <div class="badge-legend-section">
                <h4>Use cases</h4>${useCaseOptions.map(({ label, definition }) => forTemplateLiteral(`
                <div class="badge-legend-item">
                  <span class="badge badge-use-case">${escapeHtml(label)}</span>
                  <p>${escapeHtml(definition || label)}</p>
                </div>`)).join('')}
              </div>
              ` : ''}
              ${showAllInfo ? `
              <div class="badge-legend-section">
                <h4>Additional Features</h4>
                <div class="badge-legend-item">
                  <span class="badge badge-cloud">Cloud</span>
                  <p>Available in Redpanda Cloud managed service</p>
                </div>
                <div class="badge-legend-item">
                  <span class="badge badge-enterprise">Enterprise</span>
                  <p>Requires an Enterprise license to use</p>
                </div>
              </div>
              ` : ''}
            </div>
          </div>
        </div>\`;

            // Inject modal into document body when DOM is ready
            if (document.readyState === 'loading') {
              document.addEventListener('DOMContentLoaded', function() {
                const modalContainer = document.createElement('div');
                modalContainer.innerHTML = modalHTML;
                document.body.appendChild(modalContainer.firstElementChild);
              });
            } else {
              const modalContainer = document.createElement('div');
              modalContainer.innerHTML = modalHTML;
              document.body.appendChild(modalContainer.firstElementChild);
            }
            } catch (error) {
              console.error('[Component Catalog] Error loading badge legend modal:', error);
            }
          })();
        </script>

        <script>
          (function() {
            try {
              // Close modal when clicking on the backdrop
              document.addEventListener('click', function(event) {
                const modal = document.getElementById('badgeLegendModal');
                // Only handle clicks on the modal backdrop itself, nothing else
                if (modal && modal.classList.contains('show') && event.target === modal) {
                  window.closeBadgeLegend();
                }
              }, { capture: false, passive: true });

              // Close modal with Escape key and trap Tab focus inside the open modal
              document.addEventListener('keydown', function(event) {
                const modal = document.getElementById('badgeLegendModal');
                if (!modal || !modal.classList.contains('show')) return;
                if (event.key === 'Escape') {
                  window.closeBadgeLegend();
                  return;
                }
                if (event.key === 'Tab') {
                  const focusable = window.getBadgeLegendFocusableElements(modal);
                  if (focusable.length === 0) {
                    event.preventDefault();
                    return;
                  }
                  const first = focusable[0];
                  const last = focusable[focusable.length - 1];
                  // Cycle focus within the modal
                  if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
                    event.preventDefault();
                    last.focus();
                  } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
                    event.preventDefault();
                    first.focus();
                  }
                }
              }, { capture: false });

              // Define global dropdown functions (shared between macros)
              window.initializeDropdownFunctions = window.initializeDropdownFunctions || function() {
            // Component type dropdown toggle function
            window.toggleComponentTypeDropdown = function() {
              const toggle = document.getElementById('componentTypeDropdownToggle');
              const menu = document.getElementById('componentTypeDropdownMenu');
              
              if (!toggle || !menu) return;
              
              const isOpen = menu.classList.contains('show');
              
              // Close all other dropdowns first (including filter dropdowns)
              document.querySelectorAll('.dropdown-checkbox-menu.show, .dropdown-menu.show').forEach(dropdown => {
                if (dropdown !== menu) {
                  dropdown.classList.remove('show');
                  const otherToggle = dropdown.parentNode.querySelector('.dropdown-checkbox-toggle, .dropdown-toggle');
                  if (otherToggle) {
                    otherToggle.classList.remove('open');
                    otherToggle.setAttribute('aria-expanded', 'false');
                  }
                }
              });
              
              // Toggle current dropdown
              if (isOpen) {
                menu.classList.remove('show');
                toggle.classList.remove('open');
                toggle.setAttribute('aria-expanded', 'false');
              } else {
                menu.classList.add('show');
                toggle.classList.add('open');
                toggle.setAttribute('aria-expanded', 'true');
                // Focus first option
                const firstOption = menu.querySelector('.dropdown-option');
                if (firstOption) firstOption.focus();
              }
            };

          };
          
          // Initialize the functions
          try {
            window.initializeDropdownFunctions();
          } catch (e) {
            console.error('[Component Catalog] Error initializing dropdown functions:', e);
          }

          // Initialize filters from URL parameters
          function initializeFilters() {
            try {
              const params = getQueryParams();
              const search = document.getElementById('componentTableSearch');
              const typeFilterMenu = document.getElementById('typeFilterMenu');
              const supportFilterMenu = document.getElementById('supportFilterMenu');
              const cloudSupportFilterMenu = document.getElementById('cloudSupportFilterMenu');
              const enterpriseFilterMenu = document.getElementById('enterpriseFilterMenu');

              if (params.search && search) {
                search.value = params.search;
              }

              if (params.type && typeFilterMenu) {
                const types = params.type.split(',');
                // First uncheck all checkboxes
                typeFilterMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
                // Then check only the ones in the URL
                types.forEach(type => {
                  const checkbox = typeFilterMenu.querySelector('input[value="' + type + '"]');
                  if (checkbox) checkbox.checked = true;
                });
              }

              if (params.support && supportFilterMenu) {
                const supports = params.support.split(',');
                // First uncheck all checkboxes
                supportFilterMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
                // Then check only the ones in the URL
                supports.forEach(support => {
                  const checkbox = supportFilterMenu.querySelector('input[value="' + support + '"]');
                  if (checkbox) checkbox.checked = true;
                });
              }

              if (params.cloud && cloudSupportFilterMenu) {
                const cloudOptions = params.cloud.split(',');
                // First uncheck all checkboxes
                cloudSupportFilterMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
                // Then check only the ones in the URL
                cloudOptions.forEach(option => {
                  const checkbox = cloudSupportFilterMenu.querySelector('input[value="' + option + '"]');
                  if (checkbox) checkbox.checked = true;
                });
              }

              const useCaseFilterMenu = document.getElementById('useCaseFilterMenu');
              if (params.usecase && useCaseFilterMenu) {
                const useCases = params.usecase.split(',');
                useCaseFilterMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                  cb.checked = useCases.includes(cb.value);
                });
              }

              if (params.enterprise && enterpriseFilterMenu) {
                const enterpriseOptions = params.enterprise.split(',');
                // First uncheck all checkboxes
                enterpriseFilterMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
                // Then check only the ones in the URL
                enterpriseOptions.forEach(option => {
                  const checkbox = enterpriseFilterMenu.querySelector('input[value="' + option + '"]');
                  if (checkbox) checkbox.checked = true;
                });
              }

              filterComponentTable();
            } catch (e) {
              console.error('[Component Catalog] Error initializing filters:', e);
            }
          }

              // Attach event listeners programmatically (no inline handlers)
              function attachEventListeners() {
                try {
                  // Search input
                  const searchInput = document.getElementById('componentTableSearch');
                  if (searchInput) {
                    searchInput.addEventListener('keyup', window.filterComponentTable);
                  }

                  // Badge legend button
                  const badgeButton = document.querySelector('.badge-legend-button');
                  if (badgeButton) {
                    badgeButton.addEventListener('click', window.openBadgeLegend);
                  }

                  // Badge legend close button
                  const closeButton = document.querySelector('.badge-legend-close');
                  if (closeButton) {
                    closeButton.addEventListener('click', window.closeBadgeLegend);
                  }

                  // Dropdown toggles
                  const typeFilterToggle = document.getElementById('typeFilterToggle');
                  if (typeFilterToggle) {
                    typeFilterToggle.addEventListener('click', () => window.toggleDropdownCheckbox('typeFilter'));
                  }

                  const supportFilterToggle = document.getElementById('supportFilterToggle');
                  if (supportFilterToggle) {
                    supportFilterToggle.addEventListener('click', () => window.toggleDropdownCheckbox('supportFilter'));
                  }

                  const cloudSupportFilterToggle = document.getElementById('cloudSupportFilterToggle');
                  if (cloudSupportFilterToggle) {
                    cloudSupportFilterToggle.addEventListener('click', () => window.toggleDropdownCheckbox('cloudSupportFilter'));
                  }

                  const enterpriseFilterToggle = document.getElementById('enterpriseFilterToggle');
                  if (enterpriseFilterToggle) {
                    enterpriseFilterToggle.addEventListener('click', () => window.toggleDropdownCheckbox('enterpriseFilter'));
                  }

                  const useCaseFilterToggle = document.getElementById('useCaseFilterToggle');
                  if (useCaseFilterToggle) {
                    useCaseFilterToggle.addEventListener('click', () => window.toggleDropdownCheckbox('useCaseFilter'));
                  }

                  // Clear at the top of the Use case menu
                  const useCaseFilterClear = document.getElementById('useCaseFilterClear');
                  if (useCaseFilterClear) {
                    useCaseFilterClear.addEventListener('click', () => {
                      document.querySelectorAll('#useCaseFilterMenu input[type="checkbox"]').forEach(cb => { cb.checked = false; });
                      window.filterComponentTable({ type: 'clear' });
                    });
                  }

                  // Clear filters in the empty state
                  const catalogClear = document.getElementById('componentCatalogClear');
                  if (catalogClear) catalogClear.addEventListener('click', window.clearCatalogFilters);

                  const componentTypeToggle = document.getElementById('componentTypeDropdownToggle');
                  if (componentTypeToggle) {
                    componentTypeToggle.addEventListener('click', window.toggleComponentTypeDropdown);
                  }

                  // All filter checkboxes
                  document.querySelectorAll('.dropdown-checkbox-menu input[type="checkbox"]').forEach(checkbox => {
                    checkbox.addEventListener('change', window.filterComponentTable);
                  });
                } catch (error) {
                  console.error('[Component Catalog] Error attaching event listeners:', error);
                }
              }

              // Run initialization when DOM is ready
              if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', function() {
                  initializeFilters();
                  attachEventListeners();
                });
              } else {
                initializeFilters();
                attachEventListeners();
              }
            } catch (error) {
              console.error('[Component Catalog] Error loading dropdown/filter functions:', error);
            }
          })();
        </script>
      `;
      return self.createBlock(parent, 'pass', tableHtml);
    });
  });

  /**
   * Registers a block macro to display metadata about the selected component.
   *
   * This macro creates a dropdown to select different types of a connector component, such as Input, Output, or Processor.
   * It also provides links to the corresponding Cloud or Self-Managed documentation for the selected component type, and  displays information on whether the connector requires an enterprise license.
   *
   *
   * The dropdown lists all types of the connector component:
   * - Type: A dropdown with options such as Input, Output, Processor, etc.
   *
   * Information displayed includes:
   * - Availability: Displays links to Cloud and Self-Managed (Connect) documentation.
   * - License: If the component requires an enterprise license, a message is displayed with a link to upgrade.
   *
   * Data Sources:
   * - `csvData`: Parsed CSV data providing details about each connector.
   *   It filters the data to find the relevant rows for the current connector by matching the `doctitle`.
   * - `redpandaConnectUrl`: URL for the Self-Managed version of the component documentation.
   * - `redpandaCloudUrl`: URL for the Cloud version of the component documentation.
   *
   * Example usage in AsciiDoc:
   * ```
   * component_type_dropdown::[]
   * ```
   *
   * Example output:
   * ```
   * <div class="metadata-block">
   *   <div style="padding:10px;display: flex;flex-direction: column;gap: 6px;">
   *     <p style="display: flex;align-items: center;gap: 6px;"><strong>Type:</strong>
   *       <select class="type-dropdown" onchange="window.location.href=this.value">
   *         <option value="..." data-support="certified">Input</option>
   *         <option value="..." data-support="community">Output</option>
   *       </select>
   *     </p>
   *     <p><strong>Available in:</strong> <a href="...">Cloud</a>, <a href="...">Self-Managed</a></p>
   *     <p><strong>License</strong>: This component requires an <a href="https://redpanda.com/compare-platform-editions" target="_blank">Enterprise license</a>. To upgrade, contact <a href="https://redpanda.com/try-redpanda?section=enterprise-trial" target="_blank" rel="noopener">Redpanda sales</a>.</p>
   *   </div>
   * </div>
   * ```
   *
   * @param {Object} parent - The parent document where the dropdown will be inserted.
   * @param {string} target - The target element.
   * @param {Object} attrs - Attributes passed to the macro.
  */
  registry.blockMacro(function () {
    const self = this;
    self.named('component_type_dropdown');
    self.process((parent, target, attrs) => {
      const attributes = parent.getDocument().getAttributes();
      const component = attributes['page-component-title'];  // Current component (for example, 'Redpanda Cloud' or 'Redpanda Connect')
      const name = attributes['doctitle'];
      // Drafted pages no longer freeze :type:, so fall back to the page's directory.
      const type = attributes['type'] || typeFromRelative(attributes['page-relative-src-path']);
      if (!name || !type) {
        return self.createBlock(parent, 'pass', '');
      }
      const csvData = context.config?.attributes?.csvData || null;
      if (!csvData) return logger.error(`CSV data is not available for ${attributes['page-relative-src-path']}. Make sure your playbook includes the generate-rp-connect-info extension.`);
      // Filter for the specific connector by name
      const componentRows = csvData.data.filter(row => row.connector.trim().toLowerCase() === name.trim().toLowerCase());
      if (componentRows.length === 0) {
        logger.warn(`No CSV data found for connector: ${name}. The connector may have been removed or renamed.`);
        // Build link to release notes using content catalog for proper URL resolution
        const isCloud = attributes['env-cloud'] !== undefined;
        let whatsNewUrl = isCloud
          ? '/cloud-data-platform/get-started/whats-new-cloud/'
          : '/connect/get-started/whats-new/';

        // Try to resolve the page from the content catalog for accurate URLs
        if (context.contentCatalog && context.file) {
          const pageSpec = isCloud
            ? 'cloud-data-platform:get-started:whats-new-cloud.adoc'
            : 'connect:get-started:whats-new.adoc';
          const page = context.contentCatalog.resolvePage(pageSpec, context.file.src);
          if (page) {
            // For directory-style URLs like /a/b/c/, use the URL directly as the base
            whatsNewUrl = path.relative(context.file.pub.url, page.pub.url);
          }
        }

        // Return a notice for removed/unknown connectors
        return self.createBlock(parent, 'pass', `
          <div class="metadata-block">
            <div class="metadata-content">
              <p><strong>Available in:</strong> <em>This connector is no longer available. Check the <a href="${whatsNewUrl}">release notes</a> for migration guidance.</em></p>
            </div>
          </div>`);
      }
      const isCloudPage = attributes['env-cloud'] !== undefined;
      // Check if the component requires an Enterprise license (based on support level)
      let enterpriseLicenseInfo = '';
      if (component !== 'Cloud') {
        const requiresEnterprise = componentRows.some(row => row.is_licensed.toLowerCase() === 'yes');
        if (requiresEnterprise) {
          enterpriseLicenseInfo = `
            <p><strong>License</strong>: This component requires an <a href="https://docs.redpanda.com/redpanda-connect/get-started/licensing/" target="_blank">enterprise license</a>. You can either <a href="https://www.redpanda.com/upgrade" target="_blank">upgrade to an Enterprise Edition license</a>, or <a href="http://redpanda.com/try-enterprise" target="_blank" rel="noopener">generate a trial license key</a> that's valid for 30 days.</p>`;
        }
      }
      // The Type dropdown and availability info are rendered server-side in the sticky bar by the
      // UI (article.hbs) from page attributes (page-context-switcher, page-cloud-available, and
      // so on). Those attributes cannot be set from this macro: Antora extracts page attributes
      // for UI templates in a header-only parse that runs before conversion with Asciidoctor
      // extensions disabled, so anything set here never reaches the templates. The
      // generate-rp-connect-info extension sets them on page.asciidoc.attributes on the
      // documentsConverted event instead. Only the license notice belongs in the page body,
      // where it must stay visible.
      const useCasesInfo = isCloudPage ? '' : connectorUseCasesHtml(csvData, name, attributes);
      if (!enterpriseLicenseInfo && !useCasesInfo) {
        return self.createBlock(parent, 'pass', '');
      }
      return self.createBlock(parent, 'pass', `
        <div class="metadata-block">
          <div class="metadata-content">
          ${enterpriseLicenseInfo}${useCasesInfo}
          </div>
        </div>`);
    });
  });

  let tabsCounter = 1; // Counter for generating unique IDs

  // Add the category tabs for components
  registry.blockMacro(function () {
    const self = this;
    self.named('components_by_category');
    self.positionalAttributes(['type']);
    self.process((parent, target, attrs) => {
      const type = attrs.type;
      const categoriesData = context.config?.attributes?.connectCategoriesData || null
      if (!categoriesData) return logger.error(`Category data is not available for ${parent.getDocument().getAttributes()['page-relative-src-path']}. Make sure your playbook includes the generate-rp-connect-categories extension.`)
      const categories = categoriesData[type] || null;
      const currentTabsId = `tabs-${tabsCounter++}`; // Unique ID for this set of tabs
      if (!categories) return

      let tabsHtml = `
      <div id="${currentTabsId}" class="openblock tabs is-sync is-loaded" data-sync-group-id="${type}">
        <div class="content">
          <div class="ulist tablist">
            <ul role="tablist">`;

      categories.forEach((category, index) => {
        tabsHtml += `
        <li id="${currentTabsId}-${category.name}" class="tab" tabindex="${index === 0 ? '0' : '-1'}" role="tab" data-sync-id="${category.name}" aria-controls="${currentTabsId}-${category.name}--panel" aria-selected="${index === 0}">
          <p>${category.name}</p>
        </li>`;
      });

      tabsHtml += `
      </ul>
    </div>`;

      categories.forEach((category, index) => {
        tabsHtml += `
    <div id="${currentTabsId}-${category.name}--panel" class="tabpanel${index === 0 ? '' : ' is-hidden'}" aria-labelledby="${currentTabsId}-${category.name}"${index === 0 ? '' : ' hidden'} role="tabpanel">
      <div class="listingblock">
        <div class="content">
          <p>${category.description}</p>
          <div class="two-column-grid">`;
        category.items.forEach(item => {
          tabsHtml += `
          <a href="${item.url}" class="component-card"><strong>${item.name}</strong></a>`;
        });
        tabsHtml += `
          </div>
        </div>
      </div>
    </div>`;
      });

      tabsHtml += `
  </div>
</div>`;

      return self.createBlock(parent, 'pass', tabsHtml);
    });
  });
};
