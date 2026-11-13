'use strict'

/* Block macro: a searchable, filterable catalog of every Redpanda
 * configuration property.
 *
 *   property_catalog::[]
 *
 * The data is the redpanda-properties-<tag>.json attachment the page's own
 * component version publishes, chosen exactly the way the prop: macro chooses
 * it (loadPropertiesFor in macros/prop.js): a self-managed page uses the file
 * for its own release series, and a Cloud component (env-cloud) uses the
 * newest GA streaming file. Links to each property's full entry come from the
 * same property page index prop: uses, so a card links only where a page in
 * this component version renders a heading for the property.
 *
 * Each property is one card: its signature, its badges, a plain-text summary
 * of the description, the default value, a link to the reference entry, and
 * the rpk command that sets it, with a copy button.
 *
 * Every card is rendered at build time, so the page works without JavaScript,
 * the docs UI's tooltip script finds every badge, and the Markdown export sees
 * the whole list. The page script only shows and hides cards.
 *
 * Self-managed builds list every property except the ones the extractor marks
 * exclude_from_docs. Deprecated properties are listed but hidden until the
 * reader asks for them, because the reference pages leave them out.
 *
 * Cloud builds list the cluster properties marked cloud_supported and every
 * topic property (Cloud documents topic properties and readers set them per
 * topic, which the cluster-only cloud_* fields say nothing about). Broker
 * properties are left out: Cloud readers cannot edit redpanda.yaml. Like the
 * reference pages on Cloud, cards there carry no default value and no
 * Enterprise marking.
 */

const { loadPropertiesFor, buildPageIndex, propertyAnchor } = require('./prop')
// The generator's own rule for which reference page a property lands on
const { propertyPageFor } = require('../tools/property-extractor/property-page')
const propertyValues = require('../extension-utils/property-values')
const { escapeHtml } = require('../extension-utils/html-utils')
const { posix: posixPath } = require('path')
const logger = require('@antora/logger')('property-catalog-macro')

const SUMMARY_MAX = 200
const DEFAULT_MAX = 80

// The catalog's groups are the reference pages, in the order the
// properties index lists them.
const GROUP_ORDER = ['cluster', 'object-storage', 'broker', 'topic']
const GROUP_LABELS = { cluster: 'Cluster', 'object-storage': 'Object storage', broker: 'Broker', topic: 'Topic' }
const GROUP_TOOLTIPS = {
  cluster: 'Cluster property: one value for the whole cluster.',
  'object-storage': 'Object storage property: a cluster property that configures object storage for Tiered Storage.',
  broker: 'Broker property: set on each broker in its redpanda.yaml file.',
  topic: 'Topic property: set on one topic, overriding the cluster default.',
}

// Labels for the extractor's category IDs, matching the section headings on
// the reference pages. An ID not listed here is shown title-cased.
const CATEGORY_LABELS = {
  other: 'Other',
  redpanda: 'Redpanda',
  pandaproxy: 'HTTP Proxy',
  'pandaproxy-client': 'HTTP Proxy client',
  'schema-registry': 'Schema Registry',
  'retention-compaction': 'Retention and compaction',
  'segment-message': 'Segment and message',
  'performance-cluster': 'Performance and replication',
  'tiered-storage': 'Tiered Storage',
  'iceberg-integration': 'Apache Iceberg integration',
  'remote-read-replica': 'Remote Read Replica',
}

// The redpanda.yaml section each broker category lives under, as the broker
// properties page lists them. rpk redpanda config set takes the dotted path.
const BROKER_SECTIONS = {
  redpanda: 'redpanda',
  pandaproxy: 'pandaproxy',
  'pandaproxy-client': 'pandaproxy_client',
  'schema-registry': 'schema_registry',
}

const TOOLTIPS = {
  restart: 'A change takes effect only after a restart.',
  restartBroker: 'A change takes effect only after you restart the broker.',
  enterprise: 'Requires an Enterprise Edition license.',
  deprecated: 'Deprecated: still available, but planned for removal.',
  cloudEditable: 'You can change this property on Redpanda Cloud clusters.',
  readOnly: 'Redpanda Cloud manages this property. You can read it, but not change it.',
  byoc: 'Available only on Redpanda Cloud BYOC clusters.',
}

/**
 * The shortest relative URL from one root-relative page URL to another, the
 * way Antora writes xrefs (a copy of @antora/asciidoc-loader's
 * computeRelativeUrlPath, which that package does not export).
 */
function relativeUrl (from, to, hash = '') {
  const isDir = (s) => s.charAt(s.length - 1) === '/'
  if (to.charAt(0) !== '/') return to + hash
  if (to === from) return hash || (isDir(to) ? './' : posixPath.basename(to))
  const rel = posixPath.relative(posixPath.dirname(from + '.'), to)
  return rel ? (isDir(to) ? rel + '/' : rel) + hash : (isDir(to) ? './' : '../' + posixPath.basename(to)) + hash
}

function categoryLabel (id) {
  if (Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, id)) return CATEGORY_LABELS[id]
  const words = String(id || 'other').split(/[-_]/).filter(Boolean)
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
}

function typeLabel (type) {
  const t = String(type || 'unknown')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

const asList = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])

/**
 * Which values of a property need an Enterprise license, the way the
 * reference templates mark them (tools/property-extractor/templates):
 *
 *   - an enum value whose x-enum-metadata entry says is_enterprise (the
 *     isEnterpriseEnum helper and the "(Enterprise)" suffix), for the
 *     property's enum and for its items' enum;
 *   - for an is_enterprise property with an enterprise_constructor, its
 *     enterprise_restricted_value list (the "Enterprise license required"
 *     note), and without a constructor, its enterprise_value list.
 *
 * Returns { kind, values, sanctioned }: kind is 'values' when specific values
 * need a license (or the constructor is "simple", whose note says only that
 * some values do), 'enterprise' when the whole property does, and null when
 * no license is involved.
 */
function enterpriseInfo (entry) {
  const values = []
  const add = (value) => {
    const text = String(value)
    if (!values.includes(text)) values.push(text)
  }
  const fromMetadata = (metadata) => {
    if (!metadata || typeof metadata !== 'object') return
    for (const key of Object.keys(metadata)) {
      if (metadata[key] && metadata[key].is_enterprise === true) add(key)
    }
  }
  fromMetadata(entry['x-enum-metadata'])
  fromMetadata(entry.items && entry.items['x-enum-metadata'])
  const constructor = entry.enterprise_constructor
  if (entry.is_enterprise === true) {
    asList(constructor ? entry.enterprise_restricted_value : entry.enterprise_value).forEach(add)
  }
  const sanctioned = entry.is_enterprise === true && constructor === 'restricted_with_sanctioned'
    ? asList(entry.enterprise_sanctioned_value).map(String)
    : []
  if (values.length) return { kind: 'values', values, sanctioned }
  if (entry.is_enterprise === true && constructor === 'simple') return { kind: 'values', values: [], sanctioned }
  if (entry.is_enterprise === true) return { kind: 'enterprise', values: [], sanctioned }
  return null
}

function joinOr (items) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}

/** The tooltip for an Enterprise values badge, naming the values. */
function enterpriseValuesTooltip (info) {
  let text = !info.values.length
    ? 'Some values of this property require an Enterprise Edition license.'
    : info.values.length === 1
      ? `The value ${info.values[0]} requires an Enterprise Edition license.`
      : `The values ${joinOr(info.values)} require an Enterprise Edition license.`
  if (info.sanctioned && info.sanctioned.length) text += ` Without a license, the default is ${joinOr(info.sanctioned)}.`
  return text
}

/**
 * A property description as plain text: AsciiDoc and the Markdown-style
 * markup some descriptions carry reduced to the words a reader sees. Document
 * attribute references are resolved through `attribute` when given.
 */
function plainText (source, attribute) {
  let s = String(source || '').replace(/\r\n?/g, '\n')
  s = s.replace(/^include::.*$/gm, '')
  // Comments, block attribute lines, block delimiters, and block titles
  s = s.replace(/^\s*(?:\/\/.*|\[[^\]\n]*\]|-{4,}|\.{4,}|={4,}|\*{4,}|_{4,}|\+{4,}|\|===)\s*$/gm, '')
  s = s.replace(/^\.(?=\S)[^\n]*$/gm, '')
  s = s.replace(/^\s*(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION):\s*/gm, '')
  // Cross references and links keep their text
  s = s.replace(/xref:([^[\s]+)\[([^\]]*)\]/g, (m, target, text) => text || target.replace(/#.*$/, '').split(/[:/]/).pop().replace(/\.adoc$/, ''))
  s = s.replace(/(?:link:)?((?:https?|mailto):[^\s[]+)\[([^\]]*)\]/g, (m, url, text) => text.replace(/\^$/, '') || url)
  s = s.replace(/<<([^,>]+)(?:,\s*([^>]*))?>>/g, (m, anchor, text) => text || anchor)
  // Inline macros (prop:, glossterm:, config_ref:, rpk:, and the rest): the
  // text= attribute, a positional display text, or the target
  s = s.replace(/\b([a-z][a-z_]*):([^\s[\]]*)\[([^\]]*)\]/g, (m, name, target, attrs) => {
    const textAttr = attrs.match(/(?:^|,)\s*text=("[^"]*"|[^,]*)/)
    if (textAttr) return textAttr[1].replace(/^"|"$/g, '')
    const first = attrs.split(',')[0].trim()
    if (first && !first.includes('=') && name === 'glossterm') return first
    return target.split(',')[0]
  })
  if (attribute) s = s.replace(/\{([\w-]+)\}/g, (m, name) => { const v = attribute(name); return v === undefined || v === null ? m : String(v) })
  // Inline formatting
  s = s.replace(/pass:[a-z,]*\[([^\]]*)\]/g, '$1')
  s = s.replace(/`+\+?([^`]*?)\+?`+/g, '$1')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=$|[\s).,;:!?])/g, '$1$2')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=$|[\s).,;:!?])/g, '$1$2')
  s = s.replace(/(^|\s)\+([^+\n]+)\+(?=$|\s|[.,;:])/g, '$1$2')
  s = s.replace(/^\s*(?:[-*]+|\d+\.)\s+/gm, '')
  s = s.replace(/ \+$/gm, '')
  return s
}

/** Collapses whitespace in plain text. */
const squash = (text) => String(text || '').replace(/\s+/g, ' ').trim()

/**
 * The card summary: the first sentence of the description's first paragraph,
 * cut at a word boundary near SUMMARY_MAX characters when it is longer.
 */
function summarize (description, attribute) {
  const text = plainText(description, attribute)
  const firstParagraph = squash(text.split(/\n\s*\n/).find((p) => p.trim()) || '')
  if (!firstParagraph) return ''
  // A sentence ends at . ! or ? followed by a space and a capital, a quote, a
  // digit, or the end. e.g. and i.e. never end one.
  const guarded = firstParagraph.replace(/\b(e\.g|i\.e|etc|vs)\./gi, (m) => m.replace(/\./g, '\u0000'))
  const end = guarded.search(/[.!?](?=\s+[A-Z0-9"'(]|$)/)
  let sentence = (end === -1 ? guarded : guarded.slice(0, end + 1)).replace(/\u0000/g, '.')
  if (sentence.length > SUMMARY_MAX) {
    const cut = sentence.slice(0, SUMMARY_MAX + 1)
    const space = cut.lastIndexOf(' ')
    sentence = `${cut.slice(0, space > SUMMARY_MAX / 2 ? space : SUMMARY_MAX).replace(/[\s,;:.]+$/, '')}…`
  }
  return sentence
}

/** The default value as the reference states it, shortened for a card. */
function defaultValue (entry) {
  const value = propertyValues.fieldValue(entry, 'default')
  if (!value.ok) return undefined
  const text = squash(value.text)
  return text.length > DEFAULT_MAX ? `${text.slice(0, DEFAULT_MAX - 1).replace(/\s+$/, '')}…` : text
}

/**
 * The rpk command that sets a property, or undefined when there is none
 * (a broker property outside the known redpanda.yaml sections, or a Cloud
 * property that Cloud manages):
 *
 *   cluster: rpk cluster config set <name> <value>
 *   broker:  rpk redpanda config set <section>.<name> <value>
 *   topic:   rpk topic alter-config <topic> --set <name>=<value>
 */
function setCommand (entry, { cloud = false } = {}) {
  const name = entry.name
  if (entry.config_scope === 'topic') return `rpk topic alter-config <topic> --set ${name}=<value>`
  if (entry.config_scope === 'broker') {
    if (cloud) return undefined
    const section = BROKER_SECTIONS[entry.category]
    return section ? `rpk redpanda config set ${section}.${name} <value>` : undefined
  }
  if (cloud && entry.cloud_editable !== true) return undefined
  return `rpk cluster config set ${name} <value>`
}

/** Whether a property is listed in this build's catalog. */
function isListed (entry, { cloud = false } = {}) {
  if (!entry || typeof entry !== 'object') return false
  if (entry.exclude_from_docs === true) return false
  if (!cloud) return true
  if (entry.config_scope === 'topic') return true
  if (entry.config_scope === 'cluster') return entry.cloud_supported === true
  return false
}

const yesNo = (value) => (value ? 'yes' : 'no')

/**
 * One card's data, from one property entry. Exported for unit testing.
 *
 * @param {object} entry - The property entry from the JSON.
 * @param {object} opts
 * @param {boolean} [opts.cloud] - A Cloud build.
 * @param {string} [opts.href] - The link to the property's reference entry.
 * @param {function} [opts.attribute] - Resolves document attributes.
 */
function cardModel (entry, { cloud = false, href, attribute } = {}) {
  const scope = ['cluster', 'broker', 'topic'].includes(entry.config_scope) ? entry.config_scope : 'cluster'
  const group = propertyPageFor({ ...entry, config_scope: scope })
  const category = String(entry.category || 'other')
  const enterprise = cloud ? null : enterpriseInfo(entry)
  const badges = [{ meaning: 'neutral', label: GROUP_LABELS[group], tooltip: GROUP_TOOLTIPS[group] }]
  if (entry.needs_restart === true) {
    badges.push({ meaning: 'neutral', label: 'Restart required', tooltip: scope === 'broker' ? TOOLTIPS.restartBroker : TOOLTIPS.restart })
  }
  if (enterprise && enterprise.kind === 'enterprise') badges.push({ meaning: 'enterprise', label: 'Enterprise', tooltip: TOOLTIPS.enterprise })
  if (enterprise && enterprise.kind === 'values') badges.push({ meaning: 'enterprise', label: 'Enterprise values', tooltip: enterpriseValuesTooltip(enterprise) })
  if (entry.is_deprecated === true) badges.push({ meaning: 'deprecated', label: 'Deprecated', tooltip: TOOLTIPS.deprecated })
  // Topic properties are set per topic on Cloud too; the cloud_* fields
  // describe cluster configuration only.
  const cloudEditable = cloud ? (scope === 'topic' || entry.cloud_editable === true) : undefined
  const byoc = cloud ? scope === 'cluster' && entry.cloud_byoc_only === true : undefined
  if (cloud && cloudEditable) badges.push({ meaning: 'cloud', label: 'Cloud editable', tooltip: TOOLTIPS.cloudEditable })
  if (cloud && !cloudEditable) badges.push({ meaning: 'neutral', label: 'Read-only', tooltip: TOOLTIPS.readOnly })
  if (cloud && byoc) badges.push({ meaning: 'cloud', label: 'BYOC only', tooltip: TOOLTIPS.byoc })
  const full = squash(plainText(entry.description, attribute))
  return {
    name: entry.name,
    type: String(entry.type || 'unknown'),
    scope,
    group,
    category,
    // The sections the topic and broker pages divide into, by the category
    // tags their includes select. Cluster and object storage pages have none.
    section: group === 'topic' || group === 'broker' ? `${group}:${category}` : '',
    restart: yesNo(entry.needs_restart === true),
    enterprise: enterprise ? (enterprise.kind === 'values' ? 'values' : 'enterprise') : 'none',
    enterpriseValues: enterprise ? enterprise.values : [],
    deprecated: yesNo(entry.is_deprecated === true),
    cloudEditable: cloud ? yesNo(cloudEditable) : undefined,
    byoc: cloud ? yesNo(byoc) : undefined,
    badges,
    summary: summarize(entry.description, attribute),
    search: `${entry.name} ${full}`.toLowerCase(),
    defaultValue: cloud ? undefined : defaultValue(entry),
    href,
    command: setCommand(entry, { cloud }),
  }
}

const COPY_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="copy-icon" aria-hidden="true" focusable="false">' +
  '<rect x="1" y="4" width="10" height="10" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"></rect>' +
  '<rect x="5" y="2" width="10" height="10" rx="1" stroke="currentColor" stroke-width="1.5" fill="var(--body-background)"></rect></svg>'

function badgeHtml (badge) {
  return `<span class="rp-badge rp-badge--sm rp-badge--${badge.meaning}" data-tooltip="${escapeHtml(badge.tooltip)}">${escapeHtml(badge.label)}</span>`
}

/** One card's HTML. Exported for unit testing. */
function cardHtml (card) {
  const data = [
    ['name', card.name], ['group', card.group], ['section', card.section], ['type', card.type],
    ['restart', card.restart], ['enterprise', card.enterprise], ['deprecated', card.deprecated],
    ['cloud-editable', card.cloudEditable], ['byoc', card.byoc],
  ].filter(([, v]) => v !== undefined).map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`).join('')
  const hidden = card.deprecated === 'yes' ? ' hidden' : ''
  const facts = []
  if (card.defaultValue !== undefined) facts.push(`<div class="prop-card-default"><span class="prop-card-fact-label">Default:</span> <code>${escapeHtml(card.defaultValue)}</code></div>`)
  const link = card.href
    ? `<a class="prop-card-link" href="${escapeHtml(card.href)}">Full reference<span class="prop-catalog-visually-hidden"> for ${escapeHtml(card.name)}</span></a>`
    : ''
  const command = card.command
    ? `<div class="prop-card-command"><code class="prop-card-command-text">${escapeHtml(card.command)}</code>` +
      `<div class="source-toolbox"><button type="button" class="copy-button" aria-label="Copy the command to set ${escapeHtml(card.name)}" data-tooltip="Copy to clipboard">${COPY_ICON}<span class="copy-toast">Copied!</span></button></div></div>`
    : ''
  return `<li class="prop-card"${data}${hidden}>` +
    `<p class="prop-card-sig"><code class="prop-card-name">${escapeHtml(card.name)}</code>: <code class="prop-card-type">${escapeHtml(card.type)}</code></p>` +
    `<div class="prop-card-badges">${card.badges.map(badgeHtml).join('')}</div>` +
    (card.summary ? `<p class="prop-card-desc">${escapeHtml(card.summary)}</p>` : '') +
    facts.join('') +
    (link || command ? `<div class="prop-card-actions">${link}${command}</div>` : '') +
    '</li>'
}

/** A section's label: the reference page's heading for that category. */
function sectionLabel (section, { withGroup = true } = {}) {
  const [group, category] = String(section).split(':')
  const label = categoryLabel(category)
  return withGroup ? `${GROUP_LABELS[group] || group}: ${label}` : label
}

/**
 * The filters a build offers, each a list of options with their default
 * state. A card passes a filter when its value for the filter's key is one of
 * the checked options. Every option starts checked, except Deprecated.
 *
 * An option is offered only when it matches at least one card a reader can
 * see without asking for deprecated properties, and a filter only when it
 * has two or more options left: a filter with one would match everything or
 * nothing.
 *
 * `mode: 'filter'` is the filter bar on one reference page, which offers no
 * Group or Type, and Sections only on the topic page.
 *
 * Exported for unit testing.
 */
function filterSpecs (cards, { cloud = false, mode = 'catalog' } = {}) {
  const visible = cards.filter((c) => c.deprecated !== 'yes')
  const present = (key, pool = visible) => new Set(pool.map((c) => c[key]).filter((v) => v !== undefined && v !== ''))
  const yesNoOptions = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]
  const specs = []
  if (mode === 'catalog') {
    specs.push({ key: 'group', label: 'Group', options: GROUP_ORDER.map((v) => ({ value: v, label: GROUP_LABELS[v] })) })
  }
  const onTopicPage = mode === 'filter' && cards.length && cards.every((c) => c.group === 'topic')
  if (mode === 'catalog' || onTopicPage) {
    specs.push({
      key: 'section',
      label: 'Section',
      options: [...present('section')]
        .sort((a, b) => GROUP_ORDER.indexOf(a.split(':')[0]) - GROUP_ORDER.indexOf(b.split(':')[0]) || sectionLabel(a).localeCompare(sectionLabel(b)))
        .map((v) => ({ value: v, label: sectionLabel(v, { withGroup: mode === 'catalog' }) })),
    })
  }
  if (mode === 'catalog') {
    specs.push({ key: 'type', label: 'Type', options: [...present('type')].sort().map((v) => ({ value: v, label: typeLabel(v) })) })
  }
  specs.push({ key: 'restart', label: 'Restart required', options: yesNoOptions })
  if (!cloud) {
    specs.push({
      key: 'enterprise',
      label: 'Enterprise',
      options: [
        { value: 'enterprise', label: 'Enterprise' },
        { value: 'values', label: 'Enterprise values' },
        { value: 'none', label: 'No license needed' },
      ],
    })
  }
  specs.push({
    key: 'deprecated',
    label: 'Deprecated',
    pool: cards,
    options: [{ value: 'no', label: 'Not deprecated' }, { value: 'yes', label: 'Deprecated', off: true }],
  })
  if (cloud) {
    specs.push({ key: 'cloudEditable', param: 'editable', label: 'Cloud editable', options: yesNoOptions })
    specs.push({ key: 'byoc', label: 'BYOC only', options: yesNoOptions })
  }
  return specs
    .map(({ pool, ...spec }) => {
      const have = present(spec.key, pool || visible)
      return { ...spec, param: spec.param || spec.key, options: spec.options.filter((o) => have.has(o.value)) }
    })
    .filter((spec) => spec.options.length >= 2)
}

function filterGroupHtml (spec, id) {
  const base = `${id}-${spec.param}`
  const options = spec.options.map((o) =>
    `<label class="dropdown-checkbox-option"><input type="checkbox" value="${escapeHtml(o.value)}"${o.off ? '' : ' checked'}${o.off ? ' data-default-off' : ''}><span>${escapeHtml(o.label)}</span></label>`
  ).join('')
  return `<div class="filter-group" data-filter="${escapeHtml(spec.key)}" data-param="${escapeHtml(spec.param)}">` +
    `<label for="${base}-toggle" id="${base}-label">${escapeHtml(spec.label)}:</label>` +
    '<div class="dropdown-checkbox-wrapper">' +
    `<button type="button" class="dropdown-checkbox-toggle" id="${base}-toggle" aria-expanded="false" aria-controls="${base}-menu" aria-labelledby="${base}-label ${base}-value">` +
    `<span class="dropdown-text" id="${base}-value"></span><span class="dropdown-arrow" aria-hidden="true">▼</span></button>` +
    `<div class="dropdown-checkbox-menu" id="${base}-menu" role="group" aria-labelledby="${base}-label">${options}</div>` +
    '</div></div>'
}

/**
 * What the status region announces after a change. Exported for unit
 * testing, and injected into the page script.
 *
 * @param {{shown: number, search: string, filtered: boolean, deprecatedHidden: boolean}} state
 */
function catalogStatusText (state) {
  const noun = (n) => (n === 1 ? 'property' : 'properties')
  if (!state.search && !state.filtered) {
    return `Showing ${state.shown} ${noun(state.shown)}.${state.deprecatedHidden ? ' Deprecated properties are hidden.' : ''}`
  }
  const what = state.search
    ? `"${state.search}"${state.filtered ? ' and these filters' : ''}`
    : 'these filters'
  if (state.shown === 0) return `No properties match ${what}.`
  return `${state.shown} ${state.shown === 1 ? 'property matches' : 'properties match'} ${what}.`
}

/**
 * Whether a card passes the search and filters. Exported for unit testing,
 * and injected into the page script.
 *
 * @param {object} record - The card's filter values and search text.
 * @param {string[]} terms - Lowercase search words; every one must appear.
 * @param {Array<{key: string, checked: object}>} filters - Each filter's
 *   checked values as an object of value -> true.
 */
function matchesCard (record, terms, filters) {
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i]
    if (f.all) continue
    if (!f.checked[record[f.key]]) return false
  }
  for (let i = 0; i < terms.length; i++) {
    if (record.search.indexOf(terms[i]) === -1) return false
  }
  return true
}

/**
 * The page script, shared by both modes: wires the filters, the search, the
 * URL, the status region, and the empty state for one catalog or filter bar.
 * Runs in the browser; it gets matchesCard and catalogStatusText as
 * arguments because it is injected with Function.prototype.toString.
 *
 * In catalog mode the records are the cards. In filter mode (the bar on a
 * reference page) they are the page's own property entries, found by the
 * anchors in the bar's data; a filtered-out entry gets hidden="until-found",
 * so find-in-page still reaches it, and a section whose entries are all
 * hidden is hidden with them.
 */
function propertyCatalogScript (root, matchesCard, catalogStatusText) {
  if (!root || root.dataset.ready) return
  root.dataset.ready = 'true'
  const filterMode = root.dataset.mode === 'filter'
  const search = root.querySelector('.prop-catalog-search')
  const status = root.querySelector('.prop-catalog-status')
  const count = root.querySelector('.prop-catalog-count')
  const empty = root.querySelector('.prop-catalog-empty')
  let index = []
  try { index = JSON.parse(root.querySelector('.prop-catalog-index').textContent) } catch (e) {}
  const untilFound = filterMode && 'onbeforematch' in document.documentElement
  const hide = function (el, hidden) {
    if (!hidden) el.removeAttribute('hidden')
    else if (untilFound) el.setAttribute('hidden', 'until-found')
    else el.hidden = true
  }
  let records
  let sections = []
  if (filterMode) {
    // index: [[anchor, restart, enterprise, deprecated, section, cloudEditable, byoc], ...]
    records = []
    index.forEach(function (row) {
      const heading = document.getElementById(row[0])
      if (!heading) return
      const el = heading.parentElement && /\bsect[1-6]\b/.test(heading.parentElement.className) ? heading.parentElement : heading
      records.push({ el: el, shown: !el.hasAttribute('hidden'), search: undefined, restart: row[1], enterprise: row[2], deprecated: row[3], section: row[4], cloudEditable: row[5], byoc: row[6] })
    })
    // The sections that hold entries, so an emptied one hides too
    const bySection = new Map()
    records.forEach(function (r) {
      const parent = r.el.parentElement && r.el.parentElement.closest('.sect1, .sect2, .sect3')
      if (!parent || parent === r.el) return
      if (!bySection.has(parent)) bySection.set(parent, [])
      bySection.get(parent).push(r)
    })
    bySection.forEach(function (list, el) { sections.push({ el: el, records: list, shown: !el.hasAttribute('hidden') }) })
  } else {
    const cards = Array.prototype.slice.call(root.querySelector('.prop-catalog-list').children)
    records = cards.map(function (el, i) {
      const d = el.dataset
      return { el: el, shown: !el.hidden, search: index[i] || (d.name || '').toLowerCase(), group: d.group, section: d.section, type: d.type, restart: d.restart, enterprise: d.enterprise, deprecated: d.deprecated, cloudEditable: d.cloudEditable, byoc: d.byoc }
    })
  }
  const groups = Array.prototype.slice.call(root.querySelectorAll('.filter-group')).map(function (group) {
    return {
      el: group,
      key: group.dataset.filter,
      param: group.dataset.param,
      toggle: group.querySelector('.dropdown-checkbox-toggle'),
      menu: group.querySelector('.dropdown-checkbox-menu'),
      text: group.querySelector('.dropdown-text'),
      boxes: Array.prototype.slice.call(group.querySelectorAll('input[type="checkbox"]'))
    }
  })
  const isDefault = function (box) { return box.checked === !box.hasAttribute('data-default-off') }

  function updateToggleText (g) {
    const checked = g.boxes.filter(function (b) { return b.checked })
    g.text.textContent = checked.length === g.boxes.length
      ? 'All'
      : checked.length === 0
        ? 'None'
        : checked.length === 1
          ? checked[0].nextElementSibling.textContent
          : checked.length + ' selected'
  }

  function state () {
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const filters = groups.map(function (g) {
      const checked = {}
      let n = 0
      g.boxes.forEach(function (b) { if (b.checked) { checked[b.value] = true; n++ } })
      return { key: g.key, checked: checked, all: n === g.boxes.length }
    })
    return { terms: terms, filters: filters }
  }

  function reset () {
    search.value = ''
    groups.forEach(function (g) { g.boxes.forEach(function (b) { b.checked = !b.hasAttribute('data-default-off') }) })
  }

  function writeUrl () {
    const params = new URLSearchParams(window.location.search)
    const q = search.value.trim()
    if (q) params.set('q', q); else params.delete('q')
    groups.forEach(function (g) {
      if (g.boxes.every(isDefault)) params.delete(g.param)
      else params.set(g.param, g.boxes.filter(function (b) { return b.checked }).map(function (b) { return b.value }).join(',') || 'none')
    })
    const query = params.toString()
    window.history.replaceState(window.history.state, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash)
  }

  function readUrl () {
    const params = new URLSearchParams(window.location.search)
    if (params.has('q')) search.value = params.get('q')
    groups.forEach(function (g) {
      if (!params.has(g.param)) return
      const wanted = params.get(g.param).split(',')
      g.boxes.forEach(function (b) { b.checked = wanted.indexOf(b.value) !== -1 })
    })
  }

  // Shows the records that match. `announce` is true when a reader changed
  // something (not on page load), which is when the status region speaks.
  function apply (announce) {
    const started = window.performance ? performance.now() : 0
    const s = state()
    let shown = 0
    for (let i = 0; i < records.length; i++) {
      const r = records[i]
      // A page entry's text is read the first time a search needs it
      if (r.search === undefined && s.terms.length) r.search = r.el.textContent.toLowerCase()
      const match = matchesCard(r, s.terms, s.filters)
      if (match) shown++
      // Touch the DOM only for records that change
      if (match !== r.shown) {
        r.shown = match
        hide(r.el, !match)
      }
    }
    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i]
      const any = sec.records.some(function (r) { return r.shown })
      if (any !== sec.shown) { sec.shown = any; hide(sec.el, !any) }
    }
    root.lastFilterMs = window.performance ? performance.now() - started : 0
    groups.forEach(updateToggleText)
    empty.hidden = shown !== 0
    const filtered = !groups.every(function (g) { return g.boxes.every(isDefault) })
    const deprecated = groups.filter(function (g) { return g.key === 'deprecated' })[0]
    const deprecatedHidden = !!deprecated && deprecated.boxes.some(function (b) { return b.value === 'yes' && !b.checked })
    if (count) count.textContent = (shown === 1 ? '1 property' : shown + ' properties')
    if (announce) {
      status.textContent = catalogStatusText({ shown: shown, search: search.value.trim(), filtered: filtered, deprecatedHidden: deprecatedHidden })
      writeUrl()
    }
  }

  function close (g, focus) {
    g.menu.classList.remove('show')
    g.toggle.classList.remove('open')
    g.toggle.setAttribute('aria-expanded', 'false')
    if (focus) g.toggle.focus()
  }

  groups.forEach(function (g) {
    g.toggle.addEventListener('click', function () {
      const open = g.menu.classList.contains('show')
      groups.forEach(function (other) { if (other !== g) close(other) })
      if (open) return close(g)
      g.menu.classList.add('show')
      g.toggle.classList.add('open')
      g.toggle.setAttribute('aria-expanded', 'true')
    })
    g.boxes.forEach(function (b) { b.addEventListener('change', function () { apply(true) }) })
  })
  document.addEventListener('click', function (event) {
    if (event.target.closest && event.target.closest('.prop-catalog .dropdown-checkbox-wrapper')) return
    groups.forEach(function (g) { if (g.menu.classList.contains('show')) close(g) })
  })
  // Escape closes an open filter and returns focus to its toggle
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return
    groups.forEach(function (g) { if (g.menu.classList.contains('show')) close(g, true) })
  })
  search.addEventListener('input', function () { apply(true) })

  root.querySelector('.prop-catalog-clear').addEventListener('click', function () {
    reset()
    apply(true)
    search.focus()
  })

  if (filterMode) {
    // Find in page revealed a hidden entry: show everything again, so the
    // page and the filters agree
    records.concat(sections).forEach(function (r) {
      r.el.addEventListener('beforematch', function () {
        reset()
        apply(true)
      })
    })
  } else {
    // Copy buttons, the way the site's code blocks copy: write the text,
    // then flash the Copied! toast
    root.querySelector('.prop-catalog-list').addEventListener('click', function (event) {
      const button = event.target.closest && event.target.closest('.copy-button')
      if (!button || !navigator.clipboard) return
      const source = button.closest('.prop-card-command').querySelector('.prop-card-command-text')
      navigator.clipboard.writeText(source.textContent).then(function () {
        button.classList.add('clicked')
        void button.offsetHeight
        button.classList.remove('clicked')
      }, function () {})
    })
  }

  readUrl()
  // A deep link always shows its target: when the URL's filters would hide
  // the entry the anchor names, they are cleared
  let target = null
  if (window.location.hash.length > 1) {
    try { target = document.getElementById(decodeURIComponent(window.location.hash.slice(1))) } catch (e) {}
  }
  if (target) {
    const s = state()
    const owner = records.filter(function (r) { return r.el === target || r.el.contains(target) })[0]
    if (owner) {
      if (owner.search === undefined && s.terms.length) owner.search = owner.el.textContent.toLowerCase()
      if (!matchesCard(owner, s.terms, s.filters)) {
        reset()
        writeUrl()
        root.dataset.clearedForAnchor = 'true'
      }
    }
  }
  apply(false)
  if (target && (root.dataset.clearedForAnchor || window.location.search)) target.scrollIntoView()
  root.classList.add('prop-catalog--ready')
  root.filterProperties = function () { apply(true) }
}

/**
 * Runs the page script once the page is parsed: a filter bar sits above the
 * entries it filters.
 */
function bootScript (id) {
  return `(function(){var run=function(){(${propertyCatalogScript.toString()})(document.getElementById(${JSON.stringify(id)}), ${matchesCard.toString()}, ${catalogStatusText.toString()});};` +
    "if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',run);}else{run();}})();"
}

const CSS = `
.prop-catalog { margin-top: 1rem; }
.prop-catalog-visually-hidden { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.doc .table-filters.prop-catalog-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr)); gap: .75rem 1rem; align-items: end; position: relative; z-index: 2; margin: 0 0 1rem; }
.doc .table-filters.prop-catalog-filters > .table-filters-search { grid-column: 1 / -1; display: flex; flex-direction: column; gap: .35rem; min-width: 0; }
.doc .table-filters.prop-catalog-filters .prop-catalog-search { flex: none; align-self: stretch; height: auto; width: 100%; max-width: none; min-width: 0; margin: 0; box-sizing: border-box; }
.doc .table-filters.prop-catalog-filters > .filter-group { min-width: 0; max-width: none; margin: 0; display: flex; flex-direction: column; gap: .35rem; }
.doc .table-filters.prop-catalog-filters .dropdown-checkbox-wrapper { min-width: 0; }
.doc .table-filters.prop-catalog-filters .dropdown-checkbox-toggle { min-width: 0; }
.doc .table-filters.prop-catalog-filters .dropdown-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.doc .table-filters.prop-catalog-filters .dropdown-checkbox-option { align-items: flex-start; gap: .5rem; }
.doc .table-filters.prop-catalog-filters .dropdown-checkbox-option > input { flex: 0 0 auto; margin: .2em 0 0; }
.prop-catalog-count { margin: 0 0 .75rem; font-size: .875rem; color: var(--meaning-neutral-fg, #475467); }
.doc ul.prop-catalog-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 1rem; }
.doc ul.prop-catalog-list > li.prop-card { margin: 0; padding: 1rem; display: flex; flex-direction: column; gap: .6rem; min-width: 0; border: 1px solid var(--meaning-neutral-border, #d0d5dd); border-radius: 12px; background: var(--body-background, #fff); content-visibility: auto; contain-intrinsic-size: auto 240px; }
.doc ul.prop-catalog-list > li.prop-card[hidden] { display: none; }
.doc .prop-card p { margin: 0; }
.doc .prop-card .prop-card-sig { font-size: .9375rem; line-height: 1.4; overflow-wrap: anywhere; color: var(--body-font-color); }
.doc .prop-card .prop-card-sig code { font-size: inherit; overflow-wrap: anywhere; }
.doc .prop-card .prop-card-name { font-weight: 600; }
.prop-card-badges { display: flex; flex-wrap: wrap; gap: .35rem; }
.doc .prop-card .prop-card-desc { font-size: .875rem; line-height: 1.5; color: var(--body-font-color); overflow-wrap: anywhere; }
.doc .prop-card .prop-card-default { font-size: .8125rem; color: var(--meaning-neutral-fg, #475467); overflow-wrap: anywhere; }
.prop-card-fact-label { font-weight: 600; }
.prop-card-actions { margin-top: auto; display: flex; flex-direction: column; gap: .5rem; min-width: 0; }
.doc .prop-card .prop-card-link { font-size: .875rem; font-weight: 600; align-self: flex-start; }
.prop-card-command { display: flex; align-items: center; gap: .5rem; min-width: 0; padding: .35rem .35rem .35rem .6rem; border-radius: 8px; background: var(--panel-background, #f9fafb); border: 1px solid var(--meaning-neutral-border, #d0d5dd); }
.doc .prop-card .prop-card-command-text { flex: 1 1 auto; min-width: 0; font-size: .75rem; background: none; padding: 0; overflow-wrap: anywhere; white-space: normal; }
.doc .prop-card .source-toolbox { position: static; visibility: visible; box-shadow: none; background: none; padding: 0; flex: 0 0 auto; }
.doc .prop-card .source-toolbox .copy-button { position: relative; padding: 4px; }
.doc .prop-card .source-toolbox .copy-button:focus-visible { outline: 2px solid var(--link-font-color, #e14225); outline-offset: 2px; }
.prop-catalog-empty { padding: 2rem 1rem; text-align: center; border: 1px dashed var(--meaning-neutral-border, #d0d5dd); border-radius: 12px; }
.prop-catalog-empty[hidden] { display: none; }
.doc .prop-catalog-empty p { margin: 0 0 .75rem; }
.prop-catalog-clear { font: inherit; font-weight: 600; padding: .45rem 1rem; border-radius: 6px; border: 1px solid var(--meaning-neutral-border, #d0d5dd); background: var(--body-background, #fff); color: var(--body-font-color); cursor: pointer; }
.prop-catalog-clear:focus-visible { outline: 2px solid var(--link-font-color, #e14225); outline-offset: 2px; }
.doc .sect1[hidden="until-found"], .doc .sect2[hidden="until-found"], .doc .sect3[hidden="until-found"] { margin: 0; padding: 0; border: 0; }
.prop-catalog--filter { margin: 0 0 1.5rem; }
@media (prefers-reduced-motion: reduce) { .doc .prop-card .copy-toast { transition: none; } }
`

/**
 * The whole catalog's HTML for a list of cards. Exported for unit testing.
 */
function catalogHtml (cards, { cloud = false, id = 'property-catalog', dataset = '' } = {}) {
  const specs = filterSpecs(cards, { cloud })
  const index = JSON.stringify(cards.map((c) => c.search)).replace(/</g, '\\u003c')
  const shown = cards.filter((c) => c.deprecated !== 'yes').length
  const script = bootScript(id)
  return `<div class="prop-catalog" id="${id}"${cloud ? ' data-cloud="true"' : ''}${dataset ? ` data-dataset="${escapeHtml(dataset)}"` : ''}>` +
    `<style>${CSS}</style>` +
    '<div class="table-filters prop-catalog-filters">' +
    '<div class="table-filters-search">' +
    `<label for="${id}-search">Search properties:</label>` +
    `<input class="table-search prop-catalog-search" type="search" id="${id}-search" placeholder="Search by name or description" autocomplete="off" spellcheck="false">` +
    '</div>' +
    specs.map((spec) => filterGroupHtml(spec, id)).join('') +
    '</div>' +
    `<div class="prop-catalog-visually-hidden prop-catalog-status" role="status" aria-live="polite"></div>` +
    `<p class="prop-catalog-count" aria-hidden="true">${shown} properties</p>` +
    '<div class="prop-catalog-empty" hidden><p>No properties match your search and filters.</p><button type="button" class="prop-catalog-clear">Clear filters</button></div>' +
    `<ul class="prop-catalog-list" role="list">${cards.map(cardHtml).join('')}</ul>` +
    `<script type="application/json" class="prop-catalog-index">${index}</script>` +
    `<script>${script}</script>` +
    '</div>'
}

/**
 * The filter bar for one reference page: the same controls, status region,
 * and empty state as the catalog, over the entries the page already renders.
 * Its data is one row per entry, keyed by the entry's anchor. Exported for
 * unit testing.
 */
function filterBarHtml (cards, { cloud = false, id = 'property-filter', dataset = '' } = {}) {
  const specs = filterSpecs(cards, { cloud, mode: 'filter' })
  const rows = cards.map((c) => [c.anchor, c.restart, c.enterprise, c.deprecated, c.section, c.cloudEditable, c.byoc])
  const index = JSON.stringify(rows).replace(/</g, '\\u003c')
  const shown = cards.filter((c) => c.deprecated !== 'yes').length
  return `<div class="prop-catalog prop-catalog--filter" id="${id}" data-mode="filter"${cloud ? ' data-cloud="true"' : ''}${dataset ? ` data-dataset="${escapeHtml(dataset)}"` : ''}>` +
    `<style>${CSS}</style>` +
    `<div class="table-filters prop-catalog-filters" role="search" aria-label="Filter the properties on this page">` +
    '<div class="table-filters-search">' +
    `<label for="${id}-search">Filter this page:</label>` +
    `<input class="table-search prop-catalog-search" type="search" id="${id}-search" placeholder="Search by name or description" autocomplete="off" spellcheck="false">` +
    '</div>' +
    specs.map((spec) => filterGroupHtml(spec, id)).join('') +
    '</div>' +
    `<div class="prop-catalog-visually-hidden prop-catalog-status" role="status" aria-live="polite"></div>` +
    `<p class="prop-catalog-count" aria-hidden="true">${shown} ${shown === 1 ? 'property' : 'properties'}</p>` +
    '<div class="prop-catalog-empty" hidden><p>No properties on this page match your search and filters.</p><button type="button" class="prop-catalog-clear">Clear filters</button></div>' +
    `<script type="application/json" class="prop-catalog-index">${index}</script>` +
    `<script>${bootScript(id)}</script>` +
    '</div>'
}

/**
 * The cards for one build, from the dataset loadPropertiesFor picked and the
 * page index buildPageIndex built. Exported for unit testing.
 */
function buildCards ({ contentCatalog, component, version, fromUrl, attribute }) {
  const registry = loadPropertiesFor(contentCatalog, component, version)
  if (!registry) return undefined
  const cloud = registry.surface === 'cloud'
  const index = buildPageIndex(contentCatalog, component, registry.properties, version)
  const cards = Object.keys(registry.properties)
    .filter((name) => isListed(registry.properties[name], { cloud }))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const entry = { ...registry.properties[name], name: registry.properties[name].name || name }
      const found = index.get(name)
      let href
      if (found && found.url) {
        const hash = `#${propertyAnchor(name)}`
        href = fromUrl ? relativeUrl(fromUrl, found.url, hash) : found.url + hash
      }
      return { ...cardModel(entry, { cloud, href, attribute }), page: found && found.page, anchor: propertyAnchor(name) }
    })
  return { cards, cloud, registry }
}

function register (registry, context = {}) {
  const config = context || {}
  function blockMacro () {
    const self = this
    self.named('property_catalog')
    self.process((parent, target, attributes) => {
      const doc = parent.getDocument()
      const mode = String((attributes && attributes.mode) || 'catalog').trim().toLowerCase()
      const file = config.file
      const src = (file && file.src) || {}
      const where = src.path || doc.getAttribute('docfile') || 'this page'
      if (!config.contentCatalog) {
        logger.error(`property_catalog::[] in ${where}: no content catalog, so there is no property data to list. The macro runs only in an Antora build.`)
        return self.createBlock(parent, 'pass', '')
      }
      const result = buildCards({
        contentCatalog: config.contentCatalog,
        component: src.component || '',
        version: src.version || '',
        fromUrl: file && file.pub && file.pub.url,
        attribute: (name) => doc.getAttribute(name),
      })
      if (!result) {
        logger.error(`property_catalog::[] in ${where}: ${src.component || 'this component'}@${src.version || 'unversioned'} has no redpanda-properties-<tag>.json it may use (see the prop macro's warning for why), so the catalog is empty.`)
        return self.createBlock(parent, 'pass', '<div class="prop-catalog prop-catalog--no-data"><p>The property list is not available in this build.</p></div>')
      }
      const dataset = `redpanda-properties-${result.registry.tag}.json`
      if (mode === 'filter') {
        // The entries this page renders, from the same page index prop: links
        // through, so the bar needs no list of its own to keep in step
        const pagePath = String(src.relative || '').replace(/\.adoc$/, '')
        const own = result.cards.filter((c) => c.page === pagePath)
        if (!own.length) {
          logger.warn(`property_catalog::[mode=filter] in ${where}: this page renders no property entries the page index knows of, so it gets no filter bar. Use it on a reference page that includes a generated property partial.`)
          return self.createBlock(parent, 'pass', '')
        }
        return self.createBlock(parent, 'pass', filterBarHtml(own, { cloud: result.cloud, dataset }))
      }
      if (mode !== 'catalog') logger.warn(`property_catalog::[mode=${mode}] in ${where}: unknown mode; use mode=filter on a reference page, or no mode for the catalog. Rendering the catalog.`)
      return self.createBlock(parent, 'pass', catalogHtml(result.cards, { cloud: result.cloud, dataset }))
    })
  }
  if (typeof registry.register === 'function') {
    registry.register(function () { this.blockMacro(blockMacro) })
  } else {
    registry.blockMacro(blockMacro)
  }
  return registry
}

module.exports.register = register
module.exports.enterpriseInfo = enterpriseInfo
module.exports.enterpriseValuesTooltip = enterpriseValuesTooltip
module.exports.plainText = plainText
module.exports.summarize = summarize
module.exports.defaultValue = defaultValue
module.exports.setCommand = setCommand
module.exports.isListed = isListed
module.exports.cardModel = cardModel
module.exports.cardHtml = cardHtml
module.exports.filterSpecs = filterSpecs
module.exports.catalogStatusText = catalogStatusText
module.exports.matchesCard = matchesCard
module.exports.catalogHtml = catalogHtml
module.exports.filterBarHtml = filterBarHtml
module.exports.sectionLabel = sectionLabel
module.exports.buildCards = buildCards
module.exports.categoryLabel = categoryLabel
module.exports.relativeUrl = relativeUrl
