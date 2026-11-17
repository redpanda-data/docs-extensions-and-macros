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
 * Each property is one row: its signature (the name links to the reference
 * entry), its badges, a plain-text summary of the description, the default
 * value, the license values when only some values need one, and the rpk
 * command that sets it, with a copy button.
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

/** A broker property's dotted redpanda.yaml path, as rpk takes it. */
function yamlPath (entry) {
  const section = entry.config_scope === 'broker' && BROKER_SECTIONS[entry.category]
  return section ? `${section}.${entry.name}` : ''
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
 * Search text as the search compares it: lowercase, with every run of the
 * separators property names use (. _ -) read as one _, so segment.bytes,
 * segment_bytes, and segment-bytes all find the same entries. Applied to the
 * index and to the query alike. Exported for unit testing, and injected into
 * the page script.
 */
function normalizeSearch (text) {
  return String(text || '').toLowerCase().replace(/[._-]+/g, '_')
}

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
  // The generator puts an object-storage scope on the Object storage page
  const group = propertyPageFor({ ...entry, config_scope: entry.config_scope === 'object-storage' ? 'object-storage' : scope })
  const category = String(entry.category || 'other')
  const enterprise = cloud ? null : enterpriseInfo(entry)
  const badges = [{ meaning: 'neutral', label: GROUP_LABELS[group], tooltip: GROUP_TOOLTIPS[group], icon: group }]
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
  // The sections the topic and broker pages divide into, by the category
  // tags their includes select. Cluster and object storage pages have none.
  const section = group === 'topic' || group === 'broker' ? `${group}:${category}` : ''
  // The row's accent bar, one meaning per row: deprecated wins, then
  // Enterprise (either kind), then BYOC only
  const accent = entry.is_deprecated === true ? 'deprecated' : enterprise ? 'enterprise' : byoc ? 'byoc' : ''
  return {
    name: entry.name,
    type: String(entry.type || 'unknown'),
    scope,
    group,
    category,
    section,
    sectionText: section ? sectionLabel(section, { withGroup: false }) : undefined,
    accent,
    restart: yesNo(entry.needs_restart === true),
    enterprise: enterprise ? (enterprise.kind === 'values' ? 'values' : 'enterprise') : 'none',
    enterpriseValues: enterprise ? enterprise.values : [],
    deprecated: yesNo(entry.is_deprecated === true),
    cloudEditable: cloud ? yesNo(cloudEditable) : undefined,
    byoc: cloud ? yesNo(byoc) : undefined,
    badges,
    summary: summarize(entry.description, attribute),
    // The name, its redpanda.yaml path when the command uses one, the badge
    // words a reader might search for (restart, enterprise, BYOC), and the
    // full description
    search: normalizeSearch([entry.name, yamlPath(entry), ...badges.slice(1).map((b) => b.label), full].filter(Boolean).join(' ')),
    defaultValue: cloud ? undefined : defaultValue(entry),
    href,
    command: setCommand(entry, { cloud }),
  }
}

const COPY_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="copy-icon" aria-hidden="true" focusable="false">' +
  '<rect x="1" y="4" width="10" height="10" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"></rect>' +
  '<rect x="5" y="2" width="10" height="10" rx="1" stroke="currentColor" stroke-width="1.5" fill="var(--body-background)"></rect></svg>'

function badgeHtml (badge) {
  // The scope badge carries its Group chip's icon, so every row has the mark
  // its chip shows
  const extra = badge.label === 'Restart required' ? ' prop-badge--restart' : badge.icon ? ' prop-badge--scope' : ''
  const style = badge.icon ? ` style="--ico:var(--prop-icon-${escapeHtml(badge.icon)})"` : ''
  // The list keeps badges out of the tab order (data-tooltip-nofocus), so the
  // tooltip's detail rides along as visually hidden text: assistive
  // technology reads it in browse mode, and hover and tap still open the
  // tooltip
  return `<span class="rp-badge rp-badge--sm rp-badge--${badge.meaning}${extra}"${style} data-tooltip="${escapeHtml(badge.tooltip)}">` +
    `<span class="prop-badge-label">${escapeHtml(badge.label)}</span><span class="prop-catalog-visually-hidden">. ${escapeHtml(badge.tooltip)}</span></span>`
}

/** A property name with a line-break opportunity after each _ and . */
const nameHtml = (name) => escapeHtml(name).replace(/([_.])/g, '$1<wbr>')

/**
 * The rpk command, syntax-colored. Its text is exactly setCommand()'s, which
 * the copy button and the Markdown export read.
 */
function commandHtml (command) {
  const span = (cls, text) => `<span class="prop-cmd-${cls}">${escapeHtml(text)}</span>`
  // A long name breaks only after _ and . (the <wbr> adds no text to copy)
  const nameSpan = (text) => `<span class="prop-cmd-name">${nameHtml(text)}</span>`
  let m = command.match(/^(rpk topic alter-config) (<topic>) (--set) ([^=]+)=(<value>)$/)
  if (m) return `${span('bin', m[1])} ${span('ph', m[2])} ${span('bin', m[3])} ${nameSpan(m[4])}=${span('ph', m[5])}`
  m = command.match(/^(rpk (?:cluster|redpanda) config set) (\S+) (<value>)$/)
  if (m) return `${span('bin', m[1])} ${nameSpan(m[2])} ${span('ph', m[3])}`
  return escapeHtml(command)
}

/**
 * One card's HTML. Exported for unit testing.
 *
 * @param {object} card - From cardModel.
 * @param {number} [headingLevel] - The heading level of the card's signature
 *   line, one below the section the catalog sits in.
 */
function cardHtml (card, headingLevel = 2) {
  const data = [
    ['name', card.name], ['group', card.group], ['section', card.section], ['type', card.type],
    ['restart', card.restart], ['enterprise', card.enterprise], ['deprecated', card.deprecated],
    ['cloud-editable', card.cloudEditable], ['byoc', card.byoc],
  ].filter(([, v]) => v !== undefined).map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`).join('')
  const hidden = card.deprecated === 'yes' ? ' hidden' : ''
  const accent = card.accent ? ` prop-card--${card.accent}` : ''
  const name = `<code class="prop-card-name">${nameHtml(card.name)}</code>`
  // The name is the link to the full entry; deprecated properties have none.
  // The <wbr> line breaks would split the accessible name at every _, so the
  // link (or the heading, without a link) is named with the exact text.
  const linked = card.href && card.deprecated !== 'yes'
  const link = linked
    ? `<a class="prop-card-link" href="${escapeHtml(card.href)}" aria-label="${escapeHtml(card.name)}">${name}</a>`
    : name
  const h = `h${Math.min(6, Math.max(2, headingLevel))}`
  const meta = []
  if (card.sectionText) meta.push(`<span class="prop-card-section"><span class="prop-card-fact-label">Section</span> ${escapeHtml(card.sectionText)}</span>`)
  if (card.defaultValue !== undefined) meta.push(`<span class="prop-card-default"><span class="prop-card-fact-label">Default</span> <code>${escapeHtml(card.defaultValue)}</code></span>`)
  if (card.enterprise === 'values' && card.enterpriseValues && card.enterpriseValues.length) {
    meta.push('<span class="prop-card-license"><span class="prop-ico prop-card-license-icon" style="--ico:var(--icon-lock)" aria-hidden="true"></span>' +
      `<span class="prop-card-fact-label">Needs a license</span> ${card.enterpriseValues.map((v) => `<code>${escapeHtml(v)}</code>`).join(' ')}</span>`)
  }
  if (card.command) {
    meta.push(`<div class="prop-card-command"><code class="prop-card-command-text">${commandHtml(card.command)}</code>` +
      `<div class="source-toolbox"><button type="button" class="copy-button" aria-label="Copy the command to set ${escapeHtml(card.name)}" data-tooltip="Copy to clipboard">${COPY_ICON}<span class="copy-toast">Copied!</span></button></div></div>`)
  } else if (card.cloudEditable !== undefined) {
    meta.push('<span class="prop-card-managed"><span class="prop-ico prop-card-managed-icon" style="--ico:var(--icon-cloud)" aria-hidden="true"></span>Redpanda Cloud manages this property.</span>')
  }
  return `<li class="prop-card${accent}"${data}${hidden}>` +
    '<div class="prop-card-head">' +
    `<${h} class="prop-card-sig"${linked ? '' : ` aria-label="${escapeHtml(`${card.name}: ${card.type}`)}"`}>${link}<span class="prop-card-colon">: </span><code class="prop-card-type">${escapeHtml(card.type)}</code></${h}>` +
    `<div class="prop-card-badges">${card.badges.map(badgeHtml).join('')}</div>` +
    '</div>' +
    (card.summary ? `<p class="prop-card-desc">${escapeHtml(card.summary)}</p>` : '') +
    (meta.length ? `<div class="prop-card-meta">${meta.join('')}</div>` : '') +
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
        { value: 'enterprise', label: 'Whole property' },
        { value: 'values', label: 'Some values' },
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

/** A filter as a dropdown of checkboxes: the More panel's controls. */
function filterGroupHtml (spec, id) {
  const base = `${id}-${spec.param}`
  const options = spec.options.map((o) =>
    `<label class="dropdown-checkbox-option"><input type="checkbox" value="${escapeHtml(o.value)}"${o.off ? '' : ' checked'}${o.off ? ' data-default-off' : ''}><span>${escapeHtml(o.label)}</span></label>`
  ).join('')
  return `<div class="filter-group" data-filter="${escapeHtml(spec.key)}" data-param="${escapeHtml(spec.param)}" data-label="${escapeHtml(spec.label)}">` +
    // Only aria-labelledby reads the label, so it is not read twice: once as
    // text and again as part of the toggle's name
    `<span id="${base}-label" hidden>${escapeHtml(spec.label)}:</span>` +
    '<div class="dropdown-checkbox-wrapper">' +
    `<button type="button" class="dropdown-checkbox-toggle" id="${base}-toggle" aria-expanded="false" aria-controls="${base}-menu" aria-labelledby="${base}-label ${base}-value">` +
    `<span class="dropdown-label" aria-hidden="true">${escapeHtml(spec.label)}</span>` +
    `<span class="dropdown-text" id="${base}-value"></span><span class="dropdown-arrow prop-ico" style="--ico:var(--prop-icon-chevron)" aria-hidden="true"></span></button>` +
    `<div class="dropdown-checkbox-menu" id="${base}-menu" role="group" aria-labelledby="${base}-label">${options}</div>` +
    '</div></div>'
}

const GROUP_ICONS = { cluster: 'cluster', 'object-storage': 'object-storage', broker: 'broker', topic: 'topic' }

/**
 * A filter as chips with live counts: the catalog's Group filter (one chip
 * per reference page) and the topic page's Section filter. The hidden
 * checkboxes hold the state, the same as a dropdown's.
 */
function groupChipsHtml (spec, cards, id) {
  const counts = {}
  cards.forEach((c) => { if (c.deprecated !== 'yes') counts[c[spec.key]] = (counts[c[spec.key]] || 0) + 1 })
  const total = spec.options.reduce((n, o) => n + (counts[o.value] || 0), 0)
  const values = spec.options.map((o) => o.value)
  // Object storage properties are cluster properties too (their command is
  // rpk cluster config set), so the Cluster chip covers both, and Object
  // storage is a narrower chip inside it
  const covers = (value) => (spec.key === 'group' && value === 'cluster' && values.includes('object-storage') ? ['cluster', 'object-storage'] : [value])
  const chip = (value, label, icon) => {
    const n = value ? covers(value).reduce((sum, v) => sum + (counts[v] || 0), 0) : total
    const set = value ? covers(value) : []
    const sub = spec.key === 'group' && value === 'object-storage' && values.includes('cluster')
    const tooltip = set.length > 1
      ? 'Includes the object storage properties, which are cluster properties too.'
      : sub ? 'Only the cluster properties that configure object storage.' : ''
    return `<button type="button" class="prop-chip prop-chip--group${sub ? ' prop-chip--sub' : ''}" data-value="${escapeHtml(value)}"${set.length > 1 ? ` data-covers="${escapeHtml(set.join(','))}"` : ''}${tooltip ? ` data-tooltip="${escapeHtml(tooltip)}"` : ''} aria-pressed="${value ? 'false' : 'true'}">` +
      (icon ? `<span class="prop-ico prop-chip-icon" style="--ico:var(--prop-icon-${icon})" aria-hidden="true"></span>` : '') +
      `<span class="prop-chip-label">${escapeHtml(label)}</span> <span class="prop-chip-count">${n}</span><span class="prop-catalog-visually-hidden prop-chip-noun"> ${n === 1 ? 'property' : 'properties'}</span></button>`
  }
  return `<div class="filter-group prop-chip-group" data-filter="${escapeHtml(spec.key)}" data-param="${escapeHtml(spec.param)}" data-label="${escapeHtml(spec.label)}" role="group" aria-labelledby="${id}-${spec.param}-label">` +
    `<span class="prop-catalog-visually-hidden" id="${id}-${spec.param}-label">${escapeHtml(spec.label)}:</span>` +
    chip('', 'All') +
    spec.options.map((o) => chip(o.value, o.label, spec.key === 'group' && GROUP_ICONS[o.value])).join('') +
    spec.options.map((o) => `<input type="checkbox" value="${escapeHtml(o.value)}" checked hidden>`).join('') +
    '</div>'
}

// One-click shortcuts for the filters readers reach for most. Each sets its
// filter's checkboxes to `values`; the filter's dropdown stays in More. A
// chip is pressed whenever its filter is changed to a subset of `values`, so
// the chip and the dropdown never disagree. `tag` is the value the tag and
// the dropdown show when the chip's whole set is checked.
// `tooltip` is the text the matching badge carries, so a chip explains itself
// the same way its badge does.
const QUICK_CHIPS = [
  { key: 'restart', label: 'Restart required', meaning: 'neutral', icon: 'var(--prop-icon-restart)', values: ['yes'], tooltip: 'Properties whose change takes effect only after a restart.' },
  { key: 'enterprise', label: 'Enterprise', meaning: 'enterprise', icon: 'var(--icon-lock)', values: ['enterprise', 'values'], tag: 'Needs a license', tooltip: 'Properties that require an Enterprise Edition license, or some of whose values do.' },
  { key: 'cloudEditable', label: 'Cloud editable', meaning: 'cloud', icon: 'var(--icon-cloud)', values: ['yes'], tooltip: TOOLTIPS.cloudEditable },
  { key: 'byoc', label: 'BYOC only', meaning: 'cloud', icon: 'var(--icon-cloud)', values: ['yes'], tooltip: 'Properties you can set only on BYOC clusters.' },
  { key: 'deprecated', label: 'Show deprecated', meaning: 'deprecated', icon: 'var(--icon-archive)', values: ['no', 'yes'], tooltip: TOOLTIPS.deprecated },
]

/** The quick chips for the filters that survived filterSpecs. */
function quickChipsHtml (specs) {
  return QUICK_CHIPS.map((def) => {
    const spec = specs.find((s) => s.key === def.key)
    if (!spec) return ''
    const values = def.values.filter((v) => spec.options.some((o) => o.value === v))
    if (!values.length || values.length === spec.options.length && def.key !== 'deprecated') return ''
    // The tag names what the chip keeps, the same words the row's meta line uses
    const tag = def.tag ? ` data-chip-tag="${escapeHtml(def.tag)}"` : ''
    return `<button type="button" class="prop-chip prop-chip--${def.meaning}" data-chip-for="${escapeHtml(spec.param)}" data-chip-values="${escapeHtml(values.join(','))}"${tag} data-tooltip="${escapeHtml(def.tooltip)}" aria-pressed="false">` +
      `<span class="prop-ico prop-chip-icon" style="--ico:${def.icon}" aria-hidden="true"></span><span class="prop-chip-label">${escapeHtml(def.label)}</span></button>`
  }).join('')
}

function moreButtonHtml (id) {
  return `<button type="button" class="prop-chip prop-chip--more" aria-expanded="false" aria-controls="${id}-more"><span class="prop-chip-label">More filters</span>` +
    '<span class="prop-chip-badge" hidden>0</span><span class="prop-ico prop-chip-chevron" style="--ico:var(--prop-icon-chevron)" aria-hidden="true"></span></button>'
}

/** The search box both modes share. */
function searchBoxHtml (id, label, placeholder) {
  return '<div class="table-filters-search prop-catalog-searchbox">' +
    `<label class="prop-catalog-visually-hidden" for="${id}-search">${escapeHtml(label)}</label>` +
    `<span class="prop-catalog-search-icon prop-ico" style="--ico:var(--prop-icon-search)" aria-hidden="true"></span>` +
    `<input class="table-search prop-catalog-search" type="search" id="${id}-search" placeholder="${escapeHtml(placeholder)}" aria-keyshortcuts="/" autocomplete="off" spellcheck="false" enterkeyhint="search">` +
    '<kbd class="prop-catalog-kbd" aria-hidden="true">/</kbd>' +
    '</div>'
}

// Readable in browse mode: a reader who opens a filtered link learns the
// list is filtered from it. It sits outside the live region, so a change is
// announced once, by the status region.
const countHtml = (n) => `<p class="prop-catalog-count"><strong>${n}</strong> ${n === 1 ? 'property' : 'properties'}</p>`
// The reveal note: a find in page, a TOC click, or a deep link showed an
// entry the filters hide, and the note says so instead of clearing them
const RESULTS_TAIL = '<ul class="prop-catalog-active" role="list" aria-label="Active filters"></ul><button type="button" class="prop-catalog-reset" hidden>Clear all</button>' +
  '<p class="prop-catalog-reveal" hidden><span class="prop-catalog-reveal-text"></span> <button type="button" class="prop-catalog-reveal-hide">Hide it again</button> <button type="button" class="prop-catalog-reveal-clear">Clear filters</button></p>'
// Below the sticky breakpoint the bar scrolls away; this pill keeps the
// filtered count in view and leads back to the bar
const PILL_HTML = '<div class="prop-catalog-pill" hidden><button type="button" class="prop-catalog-pill-button"><span class="prop-catalog-pill-text"></span><span class="prop-catalog-pill-edit">Edit filters</span></button></div>'
const STATUS_HTML = '<div class="prop-catalog-visually-hidden prop-catalog-status" role="status" aria-live="polite"></div>'

/**
 * The empty state's title and hint for what caused it: the search, the
 * filters, or both. Exported for unit testing, and injected into the page
 * script.
 *
 * @param {{search: string, filtered: boolean, page: boolean}} state
 */
function emptyStateText (state) {
  const where = state.page ? ' on this page' : ''
  if (state.search && !state.filtered) {
    return { title: `No properties${where} match "${state.search}".`, hint: 'Check the spelling, or try part of the name.', button: 'Clear search' }
  }
  if (!state.search) return { title: `No properties${where} match these filters.`, hint: 'Remove a filter, or clear them all.', button: 'Clear filters' }
  return { title: `No properties${where} match "${state.search}" and these filters.`, hint: 'Try fewer words, or clear the search and filters.', button: 'Clear filters' }
}

function emptyHtml (title) {
  return '<div class="prop-catalog-empty" hidden>' +
    '<span class="prop-catalog-empty-icon prop-ico" style="--ico:var(--prop-icon-search)" aria-hidden="true"></span>' +
    `<p class="prop-catalog-empty-title">${escapeHtml(title)}</p>` +
    '<p class="prop-catalog-empty-hint">Try fewer words, or clear the filters.</p>' +
    '<p class="prop-catalog-empty-actions"><button type="button" class="rp-button rp-button--primary prop-catalog-clear">Clear filters</button>' +
    '<button type="button" class="rp-button prop-catalog-show-deprecated" hidden></button></p>' +
    '</div>'
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
 * The page script, shared by both modes: wires the chips, the filters, the
 * search, the URL, the status region, the active-filter tags, the sticky bar,
 * and the empty state for one catalog or filter bar. Runs in the browser; it
 * gets matchesCard and catalogStatusText as arguments because it is injected
 * with Function.prototype.toString.
 *
 * Every filter's state lives in its checkboxes (hidden ones for the Group
 * chips); chips and dropdowns only change those, so the URL, the status text,
 * and the deep-link rule have one source.
 *
 * In catalog mode the records are the cards. In filter mode (the bar on a
 * reference page) they are the page's own property entries, found by the
 * anchors in the bar's data; a filtered-out entry gets hidden="until-found",
 * so find-in-page still reaches it, and a section whose entries are all
 * hidden is hidden with them.
 */
function propertyCatalogScript (root, matchesCard, catalogStatusText, normalizeSearch, emptyStateText) {
  if (!root || root.dataset.ready) return
  root.dataset.ready = 'true'
  const filterMode = root.dataset.mode === 'filter'
  const slice = function (list) { return Array.prototype.slice.call(list) }
  const $ = function (selector) { return root.querySelector(selector) }
  const search = $('.prop-catalog-search')
  const status = $('.prop-catalog-status')
  const count = $('.prop-catalog-count')
  const empty = $('.prop-catalog-empty')
  const list = $('.prop-catalog-list')
  const bar = $('.prop-catalog-bar')
  const sentinel = $('.prop-catalog-sentinel')
  const more = $('.prop-chip--more')
  const panel = $('.prop-catalog-more')
  const moreBadge = more && more.querySelector('.prop-chip-badge')
  const results = $('.prop-catalog-results')
  const activeList = $('.prop-catalog-active')
  const resetAll = $('.prop-catalog-reset')
  const showDeprecated = $('.prop-catalog-show-deprecated')
  const emptyTitle = $('.prop-catalog-empty-title')
  const emptyHint = $('.prop-catalog-empty-hint')
  const clearButton = $('.prop-catalog-clear')
  const revealNote = $('.prop-catalog-reveal')
  const revealText = $('.prop-catalog-reveal-text')
  const pill = $('.prop-catalog-pill')
  const pillText = $('.prop-catalog-pill-text')
  // Writes that skip the DOM when nothing changed
  const setText = function (el, value) { if (el && el._propText !== value) { el._propText = value; el.textContent = value } }
  const setAttr = function (el, name, value) { if (el && el.getAttribute(name) !== value) el.setAttribute(name, value) }
  const setHidden = function (el, hidden) { if (el && el.hidden !== hidden) el.hidden = hidden }
  let index = []
  try { index = JSON.parse($('.prop-catalog-index').textContent) } catch (e) {}
  const untilFound = filterMode && 'onbeforematch' in document.documentElement
  const hide = function (el, hidden) {
    if (!hidden) el.removeAttribute('hidden')
    else if (untilFound) el.setAttribute('hidden', 'until-found')
    else el.hidden = true
  }
  let records
  const sections = []
  if (filterMode) {
    // index: [[anchor, restart, enterprise, deprecated, section, cloudEditable, byoc], ...]
    records = []
    index.forEach(function (row) {
      const heading = document.getElementById(row[0])
      if (!heading) return
      const el = heading.parentElement && /\bsect[1-6]\b/.test(heading.parentElement.className) ? heading.parentElement : heading
      records.push({ el: el, id: row[0], shown: !el.hasAttribute('hidden'), search: undefined, restart: row[1], enterprise: row[2], deprecated: row[3], section: row[4], cloudEditable: row[5], byoc: row[6] })
    })
    // The sections that hold entries, so an emptied one hides too
    const bySection = new Map()
    records.forEach(function (r) {
      const parent = r.el.parentElement && r.el.parentElement.closest('.sect1, .sect2, .sect3')
      if (!parent || parent === r.el) return
      if (!bySection.has(parent)) bySection.set(parent, [])
      bySection.get(parent).push(r)
    })
    bySection.forEach(function (list, el) {
      const h = el.querySelector(':scope > h2, :scope > h3')
      sections.push({ el: el, id: h && h.id, records: list, shown: !el.hasAttribute('hidden') })
    })
  } else {
    records = slice(list.children).map(function (el, i) {
      const d = el.dataset
      return { el: el, i: i, key: normalizeSearch(d.name), shown: !el.hidden, search: index[i] || normalizeSearch(d.name), group: d.group, section: d.section, type: d.type, restart: d.restart, enterprise: d.enterprise, deprecated: d.deprecated, cloudEditable: d.cloudEditable, byoc: d.byoc }
    })
  }
  const groups = slice(root.querySelectorAll('.filter-group')).map(function (el) {
    const chips = el.classList.contains('prop-chip-group') ? slice(el.querySelectorAll('.prop-chip')) : null
    return {
      el: el,
      key: el.dataset.filter,
      param: el.dataset.param,
      label: el.dataset.label || el.dataset.filter,
      toggle: el.querySelector('.dropdown-checkbox-toggle'),
      menu: el.querySelector('.dropdown-checkbox-menu'),
      text: el.querySelector('.dropdown-text'),
      boxes: slice(el.querySelectorAll('input[type="checkbox"]')),
      chips: chips,
      inPanel: !!panel && panel.contains(el)
    }
  })
  const byParam = {}
  const byKey = {}
  groups.forEach(function (g) { byParam[g.param] = g; byKey[g.key] = g })
  const chipGroup = groups.filter(function (g) { return g.chips })[0]
  // A chip's values: its own, or (Cluster) the set it covers
  const coversOf = function (chip) { return chip.dataset.covers ? chip.dataset.covers.split(',') : [chip.dataset.value] }
  const boxOf = function (g, value) { return g.boxes.filter(function (b) { return b.value === value })[0] }
  const covered = function (chip) { return coversOf(chip).every(function (v) { const b = boxOf(chipGroup, v); return b && b.checked }) }
  // The wider chip whose set includes this one (Cluster for Object storage)
  const parentOf = function (chip) {
    return chipGroup.chips.filter(function (c) { return c !== chip && c.dataset.value && c.dataset.covers && coversOf(c).indexOf(chip.dataset.value) !== -1 })[0]
  }
  function groupChipPressed (chip) {
    if (!chip.dataset.value) return allChecked(chipGroup)
    if (allChecked(chipGroup) || !covered(chip)) return false
    // Inside a pressed wider chip, the narrower one reads as unpressed: a
    // press narrows to it
    const parent = parentOf(chip)
    return !(parent && covered(parent))
  }
  // Keeps a wider chip's set whole: Cluster always brings Object storage
  function keepCovers () {
    if (!chipGroup) return
    chipGroup.chips.forEach(function (chip) {
      if (!chip.dataset.covers) return
      const own = boxOf(chipGroup, chip.dataset.value)
      if (own && own.checked) coversOf(chip).forEach(function (v) { const b = boxOf(chipGroup, v); if (b) b.checked = true })
    })
  }
  // On a reference page, the section chips follow the page: document order,
  // each named by its heading, with Other last
  if (filterMode && chipGroup && chipGroup.key === 'section') {
    const first = {}
    const heading = {}
    records.forEach(function (r, i) {
      if (r.section in first) return
      first[r.section] = i
      const sect = r.el.parentElement && r.el.parentElement.closest('.sect1')
      const h = sect && sect.querySelector(':scope > h2')
      if (h) heading[r.section] = h.textContent.replace(/\s+properties\s*$/i, '').trim()
    })
    const chipRank = function (chip) {
      const v = chip.dataset.value
      if (!v) return -2
      if (/:other$/.test(v)) return 1e9
      return v in first ? first[v] : 1e8
    }
    chipGroup.chips.slice().sort(function (a, b) { return chipRank(a) - chipRank(b) }).forEach(function (chip) {
      const v = chip.dataset.value
      if (v && heading[v]) chip.querySelector('.prop-chip-label').textContent = heading[v]
      chipGroup.el.insertBefore(chip, chipGroup.el.querySelector('input'))
    })
    chipGroup.chips = slice(chipGroup.el.querySelectorAll('.prop-chip'))
  }
  const quick = slice(root.querySelectorAll('.prop-chip[data-chip-for]')).map(function (el) {
    return { el: el, g: byParam[el.dataset.chipFor], values: el.dataset.chipValues.split(','), tag: el.dataset.chipTag || '' }
  }).filter(function (c) { return c.g })
  const isDefault = function (box) { return box.checked === !box.hasAttribute('data-default-off') }
  const atDefault = function (g) { return g.boxes.every(isDefault) }
  const allChecked = function (g) { return g.boxes.every(function (b) { return b.checked }) }
  const resetGroup = function (g) { g.boxes.forEach(function (b) { b.checked = !b.hasAttribute('data-default-off') }) }
  const checkedOf = function (g) { return g.boxes.filter(function (b) { return b.checked }) }
  // A chip is pressed whenever its filter is changed to some of the chip's
  // values, so a dropdown change in More shows on the chip too
  function chipPressed (c) {
    const on = checkedOf(c.g)
    return !atDefault(c.g) && on.length > 0 && on.every(function (b) { return c.values.indexOf(b.value) !== -1 })
  }
  const chipShows = function (g) { return quick.some(function (c) { return c.g === g && chipPressed(c) }) }
  // A filter in the More panel that is changed and that no pressed chip
  // already shows: what the More badge counts and what opens the panel
  const hiddenChange = function (g) { return g.inPanel && !atDefault(g) && !chipShows(g) }
  function optionLabel (g, box) {
    if (g.chips) {
      const chip = g.chips.filter(function (c) { return c.dataset.value === box.value })[0]
      return chip ? chip.querySelector('.prop-chip-label').textContent : box.value
    }
    return box.nextElementSibling ? box.nextElementSibling.textContent : box.value
  }

  // A filter's value in words, the same in its dropdown and its tag:
  // "Yes", "Cluster, Topic", "Needs a license", "Shown"
  function valueText (g, short) {
    const checked = checkedOf(g)
    if (checked.length === 0) return 'None'
    if (g.key === 'deprecated') {
      if (checked.length === g.boxes.length) return 'Shown'
      if (checked.length === 1) return checked[0].value === 'yes' ? 'Only' : 'Hidden'
    }
    if (checked.length === g.boxes.length) return 'All'
    // Chips name what is pressed: Cluster, not Cluster, Object storage
    if (g.chips) {
      const names = []
      const seen = {}
      g.chips.forEach(function (chip) {
        if (!chip.dataset.value || seen[chip.dataset.value] || !covered(chip)) return
        coversOf(chip).forEach(function (v) { seen[v] = true })
        names.push(chip.querySelector('.prop-chip-label').textContent)
      })
      return names.length > 3 ? names.length + ' selected' : names.join(', ')
    }
    // A chip that stands for a set of values (Enterprise: both license kinds) names it
    const named = quick.filter(function (c) { return c.g === g && c.tag && c.values.length === checked.length && chipPressed(c) })[0]
    if (named) return named.tag
    if (checked.length === 1) return optionLabel(g, checked[0])
    return short || checked.length > 3 ? checked.length + ' selected' : checked.map(function (b) { return optionLabel(g, b) }).join(', ')
  }

  function updateToggleText (g) {
    if (!g.text) return
    setText(g.text, valueText(g, true))
    g.toggle.classList.toggle('is-active', !atDefault(g))
  }

  // An active-filter tag's text, always "Label: value"
  function tagText (g) { return g.label + ': ' + valueText(g) }

  // The meaning a tag carries comes from what it keeps: orange only when it
  // keeps licensed properties, red only when it shows deprecated ones
  function tagMeaning (g) {
    const on = {}
    checkedOf(g).forEach(function (b) { on[b.value] = true })
    if (g.key === 'enterprise' && (on.enterprise || on.values) && !on.none) return 'enterprise'
    if (g.key === 'deprecated' && on.yes) return 'deprecated'
    if ((g.key === 'cloudEditable' || g.key === 'byoc') && on.yes && !on.no) return 'cloud'
    return ''
  }

  function state () {
    const terms = normalizeSearch(search.value.trim()).split(/\s+/).filter(Boolean)
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
    groups.forEach(resetGroup)
  }

  function writeUrl () {
    const params = new URLSearchParams(window.location.search)
    const q = search.value.trim()
    if (q) params.set('q', q); else params.delete('q')
    groups.forEach(function (g) {
      if (atDefault(g)) params.delete(g.param)
      else params.set(g.param, g.boxes.filter(function (b) { return b.checked }).map(function (b) { return b.value }).join(',') || 'none')
    })
    const query = params.toString()
    window.history.replaceState(window.history.state, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash)
  }

  // The view always follows the URL: what is not in it is at its default
  function readUrl () {
    const params = new URLSearchParams(window.location.search)
    search.value = params.get('q') || ''
    groups.forEach(function (g) {
      if (!params.has(g.param)) return resetGroup(g)
      const wanted = params.get(g.param).split(',')
      g.boxes.forEach(function (b) { b.checked = wanted.indexOf(b.value) !== -1 })
    })
    keepCovers()
  }

  // Ranks the cards while a search is on: an exact name, then a name that
  // starts with the search, then one that contains it, then the rest, each
  // tier alphabetical. Runs only when the search changes.
  let rankedFor = ''
  function rank (q) {
    if (filterMode || q === rankedFor) return
    rankedFor = q
    const tier = function (r) { return !q ? 0 : r.key === q ? 0 : r.key.indexOf(q) === 0 ? 1 : r.key.indexOf(q) !== -1 ? 2 : 3 }
    records.forEach(function (r) { r.tier = tier(r) })
    const order = records.slice().sort(function (a, b) { return a.tier - b.tier || a.i - b.i })
    let same = true
    let node = list.firstElementChild
    for (let i = 0; i < order.length && same; i++, node = node && node.nextElementSibling) same = node === order[i].el
    if (same) return
    const frag = document.createDocumentFragment()
    order.forEach(function (r) { frag.appendChild(r.el) })
    list.appendChild(frag)
  }

  // An entry shown although the filters hide it: find in page, a TOC click,
  // or a deep link reached it. One at a time; the filters stay as they are.
  let revealed = null
  const headingText = function (r) {
    const h = r.el.querySelector('h2, h3, h4')
    return h ? h.textContent.trim() : 'an entry'
  }

  // TOC entries for entries the filters hide are hidden with them, so the
  // TOC lists what the page shows. The TOC is built by the site script.
  let tocMap = null
  function markToc () {
    if (!filterMode) return
    if (!tocMap) {
      const links = document.querySelectorAll('aside.toc a[href^="#"], .toc-menu a[href^="#"]')
      if (!links.length) return
      tocMap = {}
      slice(links).forEach(function (a) {
        let id = a.getAttribute('href').slice(1)
        try { id = decodeURIComponent(id) } catch (e) {}
        ;(tocMap[id] = tocMap[id] || []).push(a.closest('li') || a)
      })
    }
    records.concat(sections).forEach(function (r) {
      const off = !r.shown
      if (!r.id || !tocMap[r.id] || r.tocOff === off) return
      r.tocOff = off
      tocMap[r.id].forEach(function (li) { li.classList.toggle('prop-toc-filtered', off) })
    })
  }

  const NO_TERMS = []
  let tagSignature = ''
  let announceTimer = 0
  // Shows the records that match. `announce` is true when a reader changed
  // something (not on page load), which is when the status region speaks.
  // A reader's change (announce) drops a revealed entry; keepReveal is for
  // the reveal itself.
  function apply (announce, keepReveal) {
    const started = window.performance ? performance.now() : 0
    if (announce && !keepReveal) revealed = null
    const s = state()
    rank(s.terms.join(' '))
    // One pass also counts what each Group chip would show, the deprecated
    // matches the empty state offers, and the count's denominator
    const chipKey = chipGroup ? chipGroup.key : ''
    const fNoGroup = s.filters.filter(function (f) { return f.key !== chipKey })
    const fNoDep = s.filters.filter(function (f) { return f.key !== 'deprecated' })
    const depOnly = s.filters.filter(function (f) { return f.key === 'deprecated' })
    const dep = byKey.deprecated
    const depHidesYes = !!dep && dep.boxes.some(function (b) { return b.value === 'yes' && !b.checked })
    const countG = {}
    let shown = 0
    let depMatches = 0
    let denom = 0
    for (let i = 0; i < records.length; i++) {
      const r = records[i]
      // A page entry's text is read the first time a search needs it
      if (r.search === undefined && s.terms.length) r.search = normalizeSearch(r.el.textContent)
      const match = matchesCard(r, s.terms, s.filters)
      if (match) shown++
      if (chipGroup && matchesCard(r, s.terms, fNoGroup)) countG[r[chipKey]] = (countG[r[chipKey]] || 0) + 1
      if (depHidesYes && r.deprecated === 'yes' && matchesCard(r, s.terms, fNoDep)) depMatches++
      if (matchesCard(r, NO_TERMS, depOnly)) denom++
      // Touch the DOM only for records that change
      const show = match || r === revealed
      if (show !== r.shown) {
        r.shown = show
        hide(r.el, !show)
      }
    }
    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i]
      const any = sec === revealed || sec.records.some(function (r) { return r.shown })
      if (any !== sec.shown) { sec.shown = any; hide(sec.el, !any) }
    }
    root.lastFilterMs = window.performance ? performance.now() - started : 0
    markToc()

    groups.forEach(updateToggleText)
    if (chipGroup) {
      const all = allChecked(chipGroup)
      let sum = 0
      chipGroup.boxes.forEach(function (b) { sum += countG[b.value] || 0 })
      chipGroup.chips.forEach(function (chip) {
        const value = chip.dataset.value
        let n = sum
        if (value) { n = 0; coversOf(chip).forEach(function (v) { n += countG[v] || 0 }) }
        const pressed = groupChipPressed(chip)
        setAttr(chip, 'aria-pressed', String(pressed))
        setText(chip.querySelector('.prop-chip-count'), String(n))
        setText(chip.querySelector('.prop-chip-noun'), n === 1 ? ' property' : ' properties')
        chip.classList.toggle('is-empty', n === 0 && !pressed)
      })
    }
    quick.forEach(function (c) { setAttr(c.el, 'aria-pressed', String(chipPressed(c))) })
    if (moreBadge) {
      const changed = groups.filter(hiddenChange).length
      setText(moreBadge, String(changed))
      setHidden(moreBadge, changed === 0)
      more.classList.toggle('is-active', changed > 0)
      if (changed) setAttr(more, 'aria-label', 'More filters, ' + changed + ' changed')
      else if (more.hasAttribute('aria-label')) more.removeAttribute('aria-label')
    }
    const q = search.value.trim()
    const noun = function (n) { return n === 1 ? 'property' : 'properties' }
    const countMarkup = !q && shown === denom
      ? '<strong>' + denom + '</strong> ' + noun(denom)
      : '<strong>' + shown + '</strong> of ' + denom + ' ' + noun(denom)
    if (count && count._propHtml !== countMarkup) { count._propHtml = countMarkup; count.innerHTML = countMarkup }
    // Active-filter tags, rebuilt only when they change
    const tags = []
    if (q) tags.push({ param: 'q', text: 'Search: "' + q + '"', meaning: '' })
    groups.forEach(function (g) {
      if (!atDefault(g)) tags.push({ param: g.param, text: tagText(g), meaning: tagMeaning(g) })
    })
    const signature = tags.map(function (t) { return t.param + '=' + t.text }).join('\n')
    if (activeList && signature !== tagSignature) {
      tagSignature = signature
      activeList.textContent = ''
      tags.forEach(function (t) {
        const li = document.createElement('li')
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'prop-active-tag' + (t.meaning ? ' prop-active-tag--' + t.meaning : '')
        button.setAttribute('data-reset', t.param)
        button.setAttribute('aria-label', 'Remove filter: ' + t.text)
        button.textContent = t.text
        const x = document.createElement('span')
        x.className = 'prop-ico prop-active-tag-x'
        x.setAttribute('aria-hidden', 'true')
        button.appendChild(x)
        li.appendChild(button)
        activeList.appendChild(li)
      })
      // Clear all follows the last tag, in the same wrapping row
      if (resetAll) {
        const li = document.createElement('li')
        li.className = 'prop-catalog-reset-item'
        li.appendChild(resetAll)
        activeList.appendChild(li)
      }
    }
    setHidden(resetAll, tags.length < 2)
    if (resetAll && resetAll.parentElement && resetAll.parentElement.classList.contains('prop-catalog-reset-item')) setHidden(resetAll.parentElement, tags.length < 2)
    if (revealNote) {
      setHidden(revealNote, !revealed)
      if (revealed) setText(revealText, 'Showing ' + headingText(revealed) + ', which your filters hide.')
    }
    if (filterMode) setHidden(results, tags.length === 0 && !revealed)
    setHidden(empty, shown !== 0 || !!revealed)
    if (shown === 0) {
      // The empty state names the cause: the search, the filters, or both
      const why = emptyStateText({ search: q, filtered: !groups.every(atDefault), page: filterMode })
      setText(emptyTitle, why.title)
      setText(emptyHint, why.hint)
      setText(clearButton, why.button)
    }
    root._propFiltered = !!q || shown !== denom
    if (pillText) setText(pillText, 'Filtered: ' + shown + ' of ' + denom)
    updatePill()
    if (list) setHidden(list, shown === 0)
    if (showDeprecated) {
      const offer = depHidesYes && shown === 0 && depMatches > 0
      setHidden(showDeprecated, !offer)
      if (offer) setText(showDeprecated, 'Show ' + depMatches + ' deprecated ' + (depMatches === 1 ? 'match' : 'matches'))
    }
    // Typing announces and writes the URL once the reader pauses
    if (announceTimer) { clearTimeout(announceTimer); announceTimer = 0 }
    const speak = function () {
      announceTimer = 0
      status.textContent = catalogStatusText({ shown: shown, search: q, filtered: !groups.every(atDefault), deprecatedHidden: depHidesYes })
      writeUrl()
    }
    if (announce === 'typing') announceTimer = setTimeout(speak, 350)
    else if (announce) speak()
  }

  function close (g, focus) {
    if (!g.menu) return
    g.menu.classList.remove('show', 'align-end')
    g.toggle.classList.remove('open')
    g.toggle.setAttribute('aria-expanded', 'false')
    if (focus) g.toggle.focus()
  }
  const openMenus = function () { return groups.filter(function (g) { return g.menu && g.menu.classList.contains('show') }) }

  function setPanel (open) {
    if (!panel) return
    panel.hidden = !open
    more.setAttribute('aria-expanded', String(open))
    if (!open) groups.forEach(function (g) { if (g.inPanel) close(g) })
    capPanel()
  }

  groups.forEach(function (g) {
    if (g.toggle) {
      g.toggle.addEventListener('click', function () {
        const open = g.menu.classList.contains('show')
        groups.forEach(function (other) { if (other !== g) close(other) })
        if (open) return close(g)
        g.menu.classList.add('show')
        g.toggle.classList.add('open')
        g.toggle.setAttribute('aria-expanded', 'true')
        // A menu near the right edge opens leftward instead
        if (g.menu.getBoundingClientRect().right > window.innerWidth - 16) g.menu.classList.add('align-end')
      })
    }
    if (!g.chips) g.boxes.forEach(function (b) { b.addEventListener('change', function () { apply(true) }) })
    // A menu closes when keyboard focus leaves it, so it never floats over
    // the control that has focus. A click inside that focuses nothing
    // (relatedTarget null, as in Safari) leaves it open.
    const wrapper = g.toggle && g.toggle.closest('.dropdown-checkbox-wrapper')
    if (wrapper) {
      wrapper.addEventListener('focusout', function (event) {
        const to = event.relatedTarget
        if (to && !wrapper.contains(to)) close(g)
      })
    }
  })
  if (chipGroup) {
    chipGroup.chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        const value = chip.dataset.value
        const boxes = chipGroup.boxes
        const set = coversOf(chip)
        const inSet = function (b) { return set.indexOf(b.value) !== -1 }
        const parent = value && parentOf(chip)
        if (!value) boxes.forEach(function (b) { b.checked = true })
        else if (allChecked(chipGroup)) boxes.forEach(function (b) { b.checked = inSet(b) })
        else if (groupChipPressed(chip)) boxes.forEach(function (b) { if (inSet(b)) b.checked = false })
        // Inside a pressed wider chip: narrow to this one
        else if (parent && covered(parent)) boxes.forEach(function (b) { if (coversOf(parent).indexOf(b.value) !== -1 && !inSet(b)) b.checked = false })
        else boxes.forEach(function (b) { if (inSet(b)) b.checked = true })
        const n = boxes.filter(function (b) { return b.checked }).length
        if (n === 0 || n === boxes.length) boxes.forEach(function (b) { b.checked = true })
        keepCovers()
        apply(true)
      })
    })
  }
  quick.forEach(function (c) {
    c.el.addEventListener('click', function () {
      if (chipPressed(c)) resetGroup(c.g)
      else c.g.boxes.forEach(function (b) { b.checked = c.values.indexOf(b.value) !== -1 })
      apply(true)
    })
  })
  if (more) more.addEventListener('click', function () { setPanel(panel.hidden) })
  if (activeList) {
    activeList.addEventListener('click', function (event) {
      const tag = event.target.closest && event.target.closest('.prop-active-tag')
      if (!tag) return
      const at = slice(activeList.querySelectorAll('.prop-active-tag')).indexOf(tag)
      const param = tag.getAttribute('data-reset')
      if (param === 'q') search.value = ''
      else if (byParam[param]) resetGroup(byParam[param])
      apply(true)
      const left = activeList.querySelectorAll('.prop-active-tag')
      const next = left[at] || left[left.length - 1]
      if (next) next.focus(); else search.focus()
    })
  }
  if (resetAll) {
    resetAll.addEventListener('click', function () {
      reset()
      apply(true)
      search.focus()
    })
  }
  document.addEventListener('click', function (event) {
    if (event.target.closest && event.target.closest('.prop-catalog .dropdown-checkbox-wrapper')) return
    openMenus().forEach(function (g) { close(g) })
  })
  // Escape: closes an open menu (focus back on its toggle only when focus was
  // in it), else clears the search, else closes the More panel. When it does
  // none of these, the event is left alone (a tooltip closes on it).
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return
    const active = document.activeElement
    const open = openMenus()
    if (open.length) {
      let within = false
      open.forEach(function (g) {
        const inside = !!active && g.el.contains(active)
        within = within || inside
        close(g, inside)
      })
      if (within) return
    }
    if (active === search && search.value) {
      event.preventDefault()
      search.value = ''
      apply(true)
      return
    }
    if (panel && !panel.hidden && panel.contains(active)) {
      setPanel(false)
      more.focus()
    }
  })
  // "/" jumps to the catalog's search, the way site search boxes do (Cmd+K
  // belongs to the chat panel). Only while focus is in a catalog or on
  // nothing: elsewhere "/" stays the browser's (Firefox Quick Find).
  if (!window.__propCatalogSlash) {
    window.__propCatalogSlash = true
    document.addEventListener('keydown', function (event) {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return
      const t = event.target
      if (t && (t.isContentEditable || (t.closest && t.closest('input, textarea, select, [contenteditable]')))) return
      const active = document.activeElement
      const owner = active && active.closest && active.closest('.prop-catalog')
      if (!owner && active && active !== document.body && active !== document.documentElement) return
      const first = (owner || document).querySelector('.prop-catalog .prop-catalog-search, .prop-catalog-search')
      if (!first) return
      event.preventDefault()
      const r = first.getBoundingClientRect()
      if (r.bottom < 0 || r.top > window.innerHeight) first.scrollIntoView({ block: 'nearest' })
      first.focus()
      first.select()
    })
  }
  search.addEventListener('input', function () { apply('typing') })

  clearButton.addEventListener('click', function () {
    reset()
    apply(true)
    search.focus()
  })
  if (showDeprecated && byKey.deprecated) {
    showDeprecated.addEventListener('click', function () {
      byKey.deprecated.boxes.forEach(function (b) { if (b.value === 'yes') b.checked = true })
      apply(true)
      // The button hides with the empty state; keep focus on the page's controls
      search.focus()
    })
  }

  // Shows the entry an element belongs to although the filters hide it, and
  // says so. Returns true when it had to.
  function reveal (el, announceIt) {
    if (!filterMode || !el) return false
    const owner = records.filter(function (r) { return r.el === el || r.el.contains(el) })[0] ||
      sections.filter(function (sec) { return sec.el === el || sec.el.contains(el) })[0]
    if (!owner) return false
    if (owner === revealed) return true
    if (!isHiddenByFilter(owner)) return false
    revealed = owner
    apply(false, true)
    if (announceIt) status.textContent = 'Showing ' + headingText(owner) + ', which your filters hide.'
    return true
  }
  // Whether the filters, not a reveal, would hide an entry
  function isHiddenByFilter (owner) {
    if (owner.records) return !owner.records.some(function (r) { return r.shown })
    const s = state()
    if (owner.search === undefined && s.terms.length) owner.search = normalizeSearch(owner.el.textContent)
    return !matchesCard(owner, s.terms, s.filters)
  }
  function revealHash (scroll) {
    if (!filterMode || window.location.hash.length < 2) return
    let el = null
    try { el = document.getElementById(decodeURIComponent(window.location.hash.slice(1))) } catch (e) {}
    if (reveal(el, true) && scroll) el.scrollIntoView()
  }

  if (filterMode) {
    // Find in page, or a TOC link, reached an entry the filters hide. The
    // browser shows it (hidden=until-found); keep it shown, leave the
    // filters alone, and say so. An entry inside a hidden section fires on
    // both, so the entry wins over its section.
    let pending = []
    records.concat(sections).forEach(function (r) {
      r.el.addEventListener('beforematch', function (event) {
        if (event.target !== r.el) return
        pending.push(r)
        if (pending.length > 1) return
        setTimeout(function () {
          const pick = pending.filter(function (p) { return !p.records })[0] || pending[0]
          pending = []
          reveal(pick.el, true)
        }, 0)
      })
    })
    const hideAgain = $('.prop-catalog-reveal-hide')
    const clearAll = $('.prop-catalog-reveal-clear')
    if (hideAgain) hideAgain.addEventListener('click', function () { revealed = null; apply(true); search.focus() })
    if (clearAll) clearAll.addEventListener('click', function () { reset(); apply(true); search.focus() })
    window.addEventListener('hashchange', function () { revealHash(true) })
  } else {
    // Copy buttons, the way the site's code blocks copy: write the text,
    // then flash the Copied! toast
    list.addEventListener('click', function (event) {
      const button = event.target.closest && event.target.closest('.copy-button')
      if (!button || !navigator.clipboard) return
      const source = button.closest('.prop-card-command').querySelector('.prop-card-command-text')
      const card = button.closest('.prop-card')
      navigator.clipboard.writeText(source.textContent).then(function () {
        button.classList.add('clicked')
        // Without motion the toast has no fade to keep it on screen, so it
        // stays a second instead
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          clearTimeout(button._propToast)
          button._propToast = setTimeout(function () { button.classList.remove('clicked') }, 1000)
        } else {
          void button.offsetHeight
          button.classList.remove('clicked')
        }
        status.textContent = 'Copied the command to set ' + (card && card.dataset.name ? card.dataset.name : 'this property') + '.'
      }, function () {})
    })
  }

  // Sticky bar. The catalog's bar sticks within the catalog. A reference
  // page's bar sticks within the article: Asciidoctor puts it in the
  // preamble, so it moves to just after the preamble when nothing follows it
  // there (so it renders in the same place), and otherwise does not stick.
  const stickyEl = filterMode ? root : bar
  if (filterMode) {
    const doc = root.closest('.doc')
    let n = root
    while (doc && n.parentElement && n.parentElement !== doc && !n.nextElementSibling) n = n.parentElement
    if (doc && n.parentElement === doc) {
      if (n !== root) n.parentNode.insertBefore(root, n.nextSibling)
      root.parentNode.insertBefore(sentinel, root)
      root.classList.add('prop-catalog--sticky')
    }
  } else {
    root.classList.add('prop-catalog--sticky')
  }
  const sticky = root.classList.contains('prop-catalog--sticky')
  // The site's own breakpoint: below it, main > .content scrolls on its own,
  // so a sticky bar would not stick
  const wide = window.matchMedia ? window.matchMedia('(min-width: 1025px)') : { matches: true }
  let barTop = 0
  // The bottom of the site's fixed and sticky headers: where the bar sticks
  function headerBottom () {
    let bottom = 0
    slice(document.querySelectorAll('.navbar, .header, .toolbar, .component-indicator-sticky')).forEach(function (el) {
      if (root.contains(el)) return
      const cs = window.getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') return
      const rect = el.getBoundingClientRect()
      if (!rect.height || rect.height > window.innerHeight / 3) return
      let b
      if (cs.position === 'fixed') b = rect.top < window.innerHeight / 3 ? rect.bottom : 0
      else if (cs.position === 'sticky') b = (parseFloat(cs.top) || 0) + rect.height
      else return
      bottom = Math.max(bottom, b)
    })
    return Math.round(bottom) + 8
  }
  // Stuck only when the bar really sits at its sticky top, not just when the
  // sentinel has scrolled past
  function updateStuck () {
    const stuck = sticky && wide.matches && !!sentinel && sentinel.getBoundingClientRect().top < barTop - 1 &&
      Math.abs(stickyEl.getBoundingClientRect().top - barTop) < 2
    bar.classList.toggle('is-stuck', stuck)
  }
  // The open More panel, on a stuck bar, scrolls within what leaves at least
  // 40% of the viewport for the results. When that leaves it less than about
  // three rows (a short window), the bar stops sticking while More is open.
  function capPanel () {
    if (!panel) return
    let max = 'min(50vh, 24rem)'
    let unstick = false
    if (sticky && wide.matches && !panel.hidden) {
      const closed = stickyEl.getBoundingClientRect().height - panel.getBoundingClientRect().height
      const room = Math.round(window.innerHeight * 0.6 - barTop - closed)
      unstick = room < 96
      max = Math.min(384, Math.max(96, room)) + 'px'
    }
    if (root._propMoreMax !== max) { root._propMoreMax = max; root.style.setProperty('--prop-more-max', max) }
    root.classList.toggle('prop-catalog--unstuck', unstick)
  }
  function updateOffset () {
    if (!sticky) return
    capPanel()
    // No scroll padding where the bar does not stick
    if (wide.matches) document.documentElement.style.setProperty('--prop-filter-offset', Math.round(barTop + stickyEl.getBoundingClientRect().height + 12) + 'px')
    else document.documentElement.style.removeProperty('--prop-filter-offset')
  }
  // Below the sticky breakpoint: once the bar has scrolled away and a filter
  // or search is on, a pill keeps "Filtered: N of M" in view
  function updatePill () {
    if (!pill) return
    const r = stickyEl.getBoundingClientRect()
    const end = (list || root).getBoundingClientRect()
    setHidden(pill, !(root._propFiltered && !wide.matches && r.bottom < 0 && (filterMode || end.bottom > window.innerHeight / 2)))
  }
  function measure () {
    barTop = headerBottom()
    root.style.setProperty('--prop-bar-top', barTop + 'px')
    updateOffset()
    updateStuck()
    updatePill()
  }
  let frame = 0
  window.addEventListener('scroll', function () {
    if (frame) return
    frame = window.requestAnimationFrame(function () { frame = 0; updateStuck(); updatePill() })
  }, { passive: true })
  window.addEventListener('resize', measure)
  if (sticky && window.ResizeObserver) new window.ResizeObserver(updateOffset).observe(stickyEl)
  if (pill) {
    pill.querySelector('button').addEventListener('click', function () {
      stickyEl.scrollIntoView({ block: 'start' })
      search.focus({ preventScroll: true })
    })
  }

  readUrl()
  // A deep link always shows its target: when the URL's filters would hide
  // the entry the anchor names, it is shown on its own, with a note, and the
  // filters stay
  let target = null
  if (window.location.hash.length > 1) {
    try { target = document.getElementById(decodeURIComponent(window.location.hash.slice(1))) } catch (e) {}
  }
  if (target && filterMode) {
    const s = state()
    const owner = records.filter(function (r) { return r.el === target || r.el.contains(target) })[0]
    if (owner) {
      if (owner.search === undefined && s.terms.length) owner.search = normalizeSearch(owner.el.textContent)
      if (!matchesCard(owner, s.terms, s.filters)) {
        revealed = owner
        root.dataset.revealedForAnchor = 'true'
      }
    }
  }
  // The More panel opens by itself when it holds a filter that is not at its
  // default and that no pressed chip already shows
  if (panel && groups.some(hiddenChange)) setPanel(true)
  apply(false)
  measure()
  // Scroll the target again now that the bar's height is known, so the
  // heading lands below the sticky bar
  if (target && (root.dataset.revealedForAnchor || window.location.search || (sticky && wide.matches))) target.scrollIntoView()
  // Back and forward: the view follows the URL again
  window.addEventListener('popstate', function () {
    readUrl()
    revealed = null
    apply(false)
    revealHash(true)
  })
  // The TOC may be built after this script; mark it once it is
  if (filterMode && !tocMap) window.addEventListener('load', markToc)
  root.classList.add('prop-catalog--ready')
  root.filterProperties = function () { apply(true) }
}

/**
 * Runs the page script once the page is parsed: a filter bar sits above the
 * entries it filters.
 */
function bootScript (id) {
  return `(function(){var run=function(){(${propertyCatalogScript.toString()})(document.getElementById(${JSON.stringify(id)}), ${matchesCard.toString()}, ${catalogStatusText.toString()}, ${normalizeSearch.toString()}, ${emptyStateText.toString()});};` +
    "if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',run);}else{run();}})();"
}

// Local icons: 24x24, filled, masked with currentColor. The restart and scope
// icons are candidates for docs-ui's vars.css (--icon-*); scope does not use
// --icon-server, which means Self-Managed.
const svgIcon = (body) => `url("data:image/svg+xml;utf8,${`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>${body}</svg>`.replace(/</g, '%3C').replace(/>/g, '%3E')}")`
const ICONS = {
  search: svgIcon("<path fill-rule='evenodd' d='M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm0 2.2a4.8 4.8 0 1 1 0 9.6 4.8 4.8 0 0 1 0-9.6z'/><path d='M14.6 16.1l1.5-1.5 5.3 5.3-1.5 1.5z'/>"),
  chevron: svgIcon("<path d='M5 9.4L6.4 8l5.6 5.6L17.6 8 19 9.4l-7 7z'/>"),
  close: svgIcon("<path d='M6.4 5L12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z'/>"),
  restart: svgIcon("<path d='M12 4a8 8 0 1 1-7.9 9.3h2.1A6 6 0 1 0 7.8 7.8L10 10H4V4l2.4 2.4A8 8 0 0 1 12 4z'/>"),
  cluster: svgIcon("<path d='M12 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM5 15a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm14 0a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM11 8h2v3.4l5.2 3-1 1.7L12 13.2l-5.2 2.9-1-1.7 5.2-3z'/>"),
  'object-storage': svgIcon("<path fill-rule='evenodd' d='M12 2c4.4 0 8 1.3 8 3v14c0 1.7-3.6 3-8 3s-8-1.3-8-3V5c0-1.7 3.6-3 8-3zm0 2C8.4 4 6 4.8 6 5.2s2.4 1.3 6 1.3 6-.9 6-1.3S15.6 4 12 4zm-6 5v3.5c.6.6 2.8 1.5 6 1.5s5.4-.9 6-1.5V9c-1.5.7-3.7 1-6 1s-4.5-.3-6-1z'/>"),
  broker: svgIcon("<path fill-rule='evenodd' d='M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm7 5.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z'/>"),
  topic: svgIcon("<path d='M3 5h18v2.5H3zm0 5.75h18v2.5H3zM3 16.5h12V19H3z'/>"),
  edit: svgIcon("<path d='M4 16.6V20h3.4l9.9-9.9-3.4-3.4zM19.7 7.7a1 1 0 0 0 0-1.4l-2-2a1 1 0 0 0-1.4 0l-1.6 1.6 3.4 3.4z'/>"),
}

const CSS = `
.prop-catalog {
  margin-top: 1rem;
  ${Object.entries(ICONS).map(([name, url]) => `--prop-icon-${name}: ${url};`).join('\n  ')}
  --prop-accent-fill: var(--component-600, #444ce7);
  --prop-accent-text: var(--component-700, #3538cd);
  --prop-accent-tint: var(--component-50, #eef4ff);
  --prop-accent-soft: var(--component-200, #c7d2fe);
  --prop-focus: var(--component-600, #444ce7);
  --prop-row-end: var(--body-background, #fff);
  /* A field's only edge: 3:1 against the bar in both themes */
  --prop-field-border: color-mix(in srgb, var(--meaning-neutral-fg) 75%, var(--body-background));
}
html[data-theme=dark] .prop-catalog {
  --prop-accent-text: var(--component-200, #c7d2fe);
  --prop-accent-tint: var(--component-bg-tint-active, rgba(79, 70, 229, .14));
  --prop-accent-soft: rgba(255, 255, 255, .18);
  --prop-focus: var(--component-200, #c7d2fe);
  --prop-row-end: rgba(255, 255, 255, .02);
}
.prop-catalog-visually-hidden { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
.prop-catalog-sentinel { height: 0; }
.prop-ico { display: inline-flex; flex: none; line-height: 1; }
.prop-ico::before { content: ""; display: block; width: 1em; height: 1em; background-color: currentColor; -webkit-mask: var(--ico) no-repeat center / contain; mask: var(--ico) no-repeat center / contain; }
.prop-catalog button { font-family: inherit; }
.prop-catalog :focus-visible { outline: 2px solid var(--prop-focus); outline-offset: 2px; }

/* The bar: search, chips, and the More panel */
html .doc .prop-catalog .prop-catalog-bar { display: grid; gap: .75rem; margin: 0; padding: .875rem; border: 1px solid var(--meaning-neutral-border); border-radius: 12px; background: linear-gradient(135deg, var(--component-bg-tint, transparent) 0%, var(--body-background) 60%), var(--body-background); box-shadow: 0 1px 2px rgba(16, 24, 40, .05); transition: box-shadow .15s ease; }
html .doc .prop-catalog .prop-catalog-bar.is-stuck { box-shadow: 0 6px 16px -8px rgba(16, 24, 40, .25); }
html .doc .prop-catalog .prop-catalog-bar.is-stuck::before { content: ""; position: absolute; left: -1px; right: -1px; bottom: 100%; height: 9px; background: var(--body-background); }
html[data-theme=dark] .doc .prop-catalog .prop-catalog-bar { background: var(--body-background); border-color: var(--meaning-neutral-border); box-shadow: none; }
html[data-theme=dark] .doc .prop-catalog .prop-catalog-bar.is-stuck { box-shadow: 0 1px 0 rgba(255, 255, 255, .08); }
html .doc .prop-catalog .prop-catalog-searchbox { position: relative; display: flex; align-items: center; min-width: 0; margin: 0; }
html .doc .prop-catalog .prop-catalog-search { flex: 1 1 auto; box-sizing: border-box; width: 100%; min-width: 0; max-width: none; height: 2.75rem; margin: 0; padding: 0 2.5rem; border: 1px solid var(--prop-field-border); border-radius: 8px; background: var(--body-background); color: var(--body-font-color); font-family: inherit; font-size: 1rem; font-weight: 400; box-shadow: none; transition: border-color .12s ease, box-shadow .12s ease; }
html .doc .prop-catalog .prop-catalog-search::placeholder { color: var(--meaning-neutral-fg); opacity: 1; }
html .doc .prop-catalog .prop-catalog-search:focus { outline: none; border-color: var(--prop-accent-fill); box-shadow: 0 0 0 3px var(--component-bg-tint-active, rgba(79, 70, 229, .14)); }
html[data-theme=dark] .doc .prop-catalog .prop-catalog-search:focus { border-color: var(--prop-accent-text); }
.prop-catalog-search-icon { position: absolute; left: .85rem; top: 50%; transform: translateY(-50%); font-size: 16px; color: var(--meaning-neutral-fg); pointer-events: none; }
html .doc .prop-catalog .prop-catalog-kbd { display: block; margin: 0; box-shadow: none; position: absolute; right: .75rem; top: 50%; transform: translateY(-50%); padding: 0 .4rem; border: 1px solid var(--meaning-neutral-border); border-radius: 4px; background: var(--meaning-neutral-bg); color: var(--meaning-neutral-fg); font-family: var(--monospace-font-family, ui-monospace, monospace); font-size: .75rem; line-height: 1.4; pointer-events: none; }
html .doc .prop-catalog .prop-catalog-search:focus ~ .prop-catalog-kbd, html .doc .prop-catalog .prop-catalog-search:not(:placeholder-shown) ~ .prop-catalog-kbd { display: none; }
@media (hover: none) { html .doc .prop-catalog .prop-catalog-kbd { display: none; } }
.prop-catalog-chips { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; min-width: 0; }
html .doc .prop-catalog .filter-group { position: relative; display: block; flex: 0 1 auto; min-width: 0; max-width: 100%; margin: 0; gap: 0; }
html .doc .prop-catalog .filter-group.prop-chip-group { display: flex; flex: 1 1 100%; flex-flow: row wrap; align-items: center; gap: .3rem; }
html .doc .prop-catalog .prop-chip--group { gap: .3rem; padding-inline: .45rem .5rem; }

/* Chips: rounded rectangles (meaning badges are pills) */
html .doc .prop-catalog .prop-chip { --chip-fg: var(--meaning-neutral-fg); --chip-bg: var(--meaning-neutral-bg); --chip-border: var(--meaning-neutral-border); --chip-icon: var(--prop-accent-text); --chip-hover: var(--prop-accent-fill); display: inline-flex; align-items: center; gap: .35rem; box-sizing: border-box; min-height: 2rem; margin: 0; padding: .25rem .6rem; border: 1px solid var(--chip-border); border-radius: 8px; background: var(--body-background); color: var(--body-font-color); font-size: .8125rem; font-weight: 600; line-height: 1.2; white-space: nowrap; cursor: pointer; transition: background-color .12s ease, border-color .12s ease, color .12s ease; }
html .doc .prop-catalog .prop-chip--enterprise { --chip-fg: var(--meaning-enterprise-fg); --chip-bg: var(--meaning-enterprise-bg); --chip-border: color-mix(in srgb, var(--meaning-enterprise-fg) 45%, transparent); --chip-icon: var(--chip-fg); --chip-hover: var(--chip-fg); }
html .doc .prop-catalog .prop-chip--deprecated { --chip-fg: var(--meaning-deprecated-fg); --chip-bg: var(--meaning-deprecated-bg); --chip-border: var(--meaning-deprecated-border); --chip-icon: var(--chip-fg); --chip-hover: var(--chip-fg); }
html .doc .prop-catalog .prop-chip--cloud { --chip-fg: var(--meaning-cloud-fg); --chip-bg: var(--meaning-cloud-bg); --chip-border: var(--meaning-cloud-border); --chip-icon: var(--chip-fg); --chip-hover: var(--chip-fg); }
html .doc .prop-catalog .prop-chip:hover { border-color: var(--chip-hover); }
.prop-chip-icon { font-size: 14px; color: var(--chip-icon); }
.prop-chip-chevron { font-size: 12px; color: var(--meaning-neutral-fg); transition: transform .15s ease; }
.prop-chip[aria-expanded=true] .prop-chip-chevron { transform: rotate(180deg); }
html .doc .prop-catalog .prop-chip[aria-pressed=true] { background: var(--chip-fg); border-color: var(--chip-fg); color: var(--body-background); --chip-icon: var(--body-background); }
html .doc .prop-catalog .prop-chip--neutral[aria-pressed=true], html .doc .prop-catalog .prop-chip--group[aria-pressed=true] { background: var(--prop-accent-fill); border-color: var(--prop-accent-fill); color: #fff; --chip-icon: #fff; }
/* Dark: a light fill, like the other meanings, so pressed stands 3:1 off the bar */
html[data-theme=dark] .doc .prop-catalog .prop-chip--neutral[aria-pressed=true], html[data-theme=dark] .doc .prop-catalog .prop-chip--group[aria-pressed=true] { background: var(--prop-accent-text); border-color: var(--prop-accent-text); color: var(--body-background); --chip-icon: var(--body-background); }
/* Object storage sits inside Cluster: a narrower chip right after it */
html .doc .prop-catalog .prop-chip--sub { margin-left: -.15rem; border-style: dashed; }
html .doc .prop-catalog .prop-chip--sub[aria-pressed=true] { border-style: solid; }
.prop-chip[aria-pressed=true]::after { content: ""; flex: none; width: .875em; height: .875em; background-color: currentColor; -webkit-mask: var(--icon-check-circle) no-repeat center / contain; mask: var(--icon-check-circle) no-repeat center / contain; }
.prop-chip-count { padding: .1rem .35rem; border-radius: 999px; background: var(--meaning-neutral-bg); color: var(--meaning-neutral-fg); font-size: .75rem; font-weight: 500; line-height: 1; font-variant-numeric: tabular-nums; }
.prop-chip[aria-pressed=true] .prop-chip-count { background: rgba(0, 0, 0, .2); color: inherit; }
html .doc .prop-catalog .prop-chip.is-empty:not([aria-pressed=true]) { color: var(--meaning-neutral-fg); }
.prop-chip.is-empty:not([aria-pressed=true]) .prop-chip-icon { opacity: .6; }
html .doc .prop-catalog .prop-chip--more.is-active { border-color: var(--prop-accent-fill); }
.prop-chip-badge { min-width: 1.25rem; box-sizing: border-box; padding: 0 .35rem; border-radius: 999px; background: var(--prop-accent-fill); color: #fff; font-size: .6875rem; font-weight: 600; line-height: 1.4; text-align: center; font-variant-numeric: tabular-nums; }
.prop-chip-badge[hidden] { display: none; }

/* More panel: compact "Label: value" dropdowns */
html .doc .prop-catalog .prop-catalog-more { display: flex; flex-wrap: wrap; gap: .5rem; padding-top: .75rem; border-top: 1px dashed var(--meaning-neutral-border); }
html .doc .prop-catalog .prop-catalog-more[hidden] { display: none; }
html .doc .prop-catalog .dropdown-checkbox-wrapper { position: relative; width: auto; min-width: 0; max-width: 100%; }
html .doc .prop-catalog .dropdown-checkbox-toggle { display: inline-flex; align-items: center; justify-content: flex-start; gap: .35rem; box-sizing: border-box; width: auto; min-width: 0; max-width: 100%; height: 2rem; min-height: 0; margin: 0; padding: 0 .6rem 0 .75rem; border: 1px solid var(--prop-field-border); border-radius: 8px; background: var(--body-background); color: var(--body-font-color); font-size: .8125rem; font-weight: 500; line-height: 1.2; text-align: left; box-shadow: none; cursor: pointer; transition: background-color .12s ease, border-color .12s ease; }
html .doc .prop-catalog .dropdown-checkbox-toggle:hover { border-color: var(--prop-accent-fill); }
html .doc .prop-catalog .dropdown-checkbox-toggle:focus { box-shadow: none; outline: none; }
html .doc .prop-catalog .dropdown-checkbox-toggle:focus-visible { outline: 2px solid var(--prop-focus); outline-offset: 2px; }
html .doc .prop-catalog .dropdown-checkbox-toggle.open { border-color: var(--prop-accent-fill); box-shadow: 0 0 0 3px var(--component-bg-tint-active, rgba(79, 70, 229, .14)); }
html .doc .prop-catalog .dropdown-checkbox-toggle.is-active { border-color: var(--prop-accent-fill); background: var(--prop-accent-tint); }
.prop-catalog .dropdown-label { font-weight: 500; color: var(--meaning-neutral-fg); white-space: nowrap; }
html .doc .prop-catalog .dropdown-text { min-width: 0; max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
html .doc .prop-catalog .dropdown-checkbox-toggle.is-active .dropdown-text { color: var(--prop-accent-text); }
html .doc .prop-catalog .dropdown-arrow { font-size: 12px; color: var(--meaning-neutral-fg); transition: transform .15s ease; }
html .doc .prop-catalog .dropdown-checkbox-toggle.open .dropdown-arrow { transform: rotate(180deg); }
html .doc .prop-catalog .dropdown-checkbox-menu { position: absolute; top: calc(100% + 4px); left: 0; right: auto; z-index: 20; box-sizing: border-box; min-width: max(100%, 13rem); max-width: min(20rem, calc(100vw - 2rem)); max-height: 20rem; overflow: auto; padding: .25rem; border: 1px solid var(--meaning-neutral-border); border-radius: 8px; background: var(--body-background); box-shadow: 0 8px 24px rgba(15, 23, 42, .12); }
html .doc .prop-catalog .dropdown-checkbox-menu.align-end { left: auto; right: 0; }
html[data-theme=dark] .doc .prop-catalog .dropdown-checkbox-menu { box-shadow: 0 8px 24px rgba(0, 0, 0, .5); }
html .doc .prop-catalog .filter-group .dropdown-checkbox-option { display: flex; align-items: flex-start; gap: .5rem; box-sizing: border-box; min-height: 2rem; margin: 0; padding: .375rem .5rem; border: 0; border-radius: 6px; color: var(--body-font-color); font-size: .875rem; font-weight: 400; cursor: pointer; }
html .doc .prop-catalog .filter-group .dropdown-checkbox-option:hover { background: var(--meaning-neutral-bg); }
html .doc .prop-catalog .dropdown-checkbox-option input[type=checkbox] { -webkit-appearance: checkbox; appearance: auto; flex: none; width: 16px; height: 16px; margin: .1rem 0 0; border: 0; background: none; accent-color: var(--prop-accent-fill); cursor: pointer; }
html .doc .prop-catalog .dropdown-checkbox-option input[type=checkbox]::after, html .doc .prop-catalog .dropdown-checkbox-option input[type=checkbox]:checked::after { content: none; }
html .doc .prop-catalog .dropdown-checkbox-option span { color: inherit; font-size: .875rem; font-weight: 400; }

/* Results: the count, the active-filter tags, Clear all */
.prop-catalog-results { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .75rem; margin: 1rem 0 .75rem; }
.prop-catalog-results[hidden] { display: none; }
html .doc .prop-catalog .prop-catalog-bar > .prop-catalog-results { margin: 0; }
html .doc .prop-catalog .prop-catalog-count { margin: 0; color: var(--meaning-neutral-fg); font-size: .875rem; white-space: nowrap; }
html .doc .prop-catalog .prop-catalog-count strong { color: var(--prop-accent-text); font-weight: 600; font-variant-numeric: tabular-nums; }
html .doc .prop-catalog ul.prop-catalog-active { display: flex; flex-wrap: wrap; gap: .35rem; margin: 0; padding: 0; list-style: none; }
html .doc .prop-catalog ul.prop-catalog-active:empty, html .doc .prop-catalog ul.prop-catalog-active:not(:has(> li:not([hidden]))) { display: none; }
html .doc .prop-catalog ul.prop-catalog-active > li { margin: 0; padding: 0; }
html .doc .prop-catalog .prop-active-tag { display: inline-flex; align-items: center; gap: .3rem; box-sizing: border-box; min-height: 1.75rem; margin: 0; padding: 0 .45rem 0 .6rem; border: 1px solid var(--prop-accent-soft); border-radius: 8px; background: var(--prop-accent-tint); color: var(--prop-accent-text); font-size: .75rem; font-weight: 600; line-height: 1.2; cursor: pointer; transition: border-color .12s ease; }
html .doc .prop-catalog .prop-active-tag:hover { border-color: currentColor; }
html .doc .prop-catalog .prop-active-tag--enterprise { border-color: var(--meaning-enterprise-border); background: var(--meaning-enterprise-bg); color: var(--meaning-enterprise-fg); }
html .doc .prop-catalog .prop-active-tag--deprecated { border-color: var(--meaning-deprecated-border); background: var(--meaning-deprecated-bg); color: var(--meaning-deprecated-fg); }
html .doc .prop-catalog .prop-active-tag--cloud { border-color: var(--meaning-cloud-border); background: var(--meaning-cloud-bg); color: var(--meaning-cloud-fg); }
/* A shown entry the filters hide, with the way back */
html .doc .prop-catalog .prop-catalog-reveal { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem .75rem; flex: 1 1 100%; margin: 0; color: var(--body-font-color); font-size: .8125rem; }
html .doc .prop-catalog .prop-catalog-reveal[hidden] { display: none; }
html .doc .prop-catalog .prop-catalog-reveal button { margin: 0; padding: .25rem 0; border: 0; background: none; color: var(--prop-accent-text); font-size: .8125rem; font-weight: 600; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
/* TOC entries for what the filters hide */
.toc li.prop-toc-filtered, .toc-menu li.prop-toc-filtered { display: none; }
/* Below the sticky breakpoint: the filtered count, once the bar scrolls away */
.prop-catalog-pill { position: fixed; left: 50%; bottom: 1rem; z-index: 30; transform: translateX(-50%); max-width: calc(100vw - 2rem); }
.prop-catalog-pill[hidden] { display: none; }
html .doc .prop-catalog .prop-catalog-pill-button { display: inline-flex; align-items: center; gap: .6rem; min-height: 2.75rem; margin: 0; padding: .5rem 1rem; border: 1px solid var(--prop-accent-fill); border-radius: 999px; background: var(--body-background); color: var(--body-font-color); font-size: .875rem; font-weight: 600; box-shadow: 0 6px 16px rgba(16, 24, 40, .2); cursor: pointer; white-space: nowrap; }
.prop-catalog-pill-edit { color: var(--prop-accent-text); text-decoration: underline; text-underline-offset: 3px; }
/* Cloud licensing, said once */
html .doc .prop-catalog .prop-catalog-note { display: flex; align-items: baseline; gap: .4rem; margin: .75rem 0; color: var(--meaning-neutral-fg); font-size: .875rem; }
.prop-catalog-note-icon { font-size: 14px; color: var(--meaning-cloud-fg); transform: translateY(2px); }
.prop-active-tag-x { --ico: var(--prop-icon-close); font-size: 12px; }
html .doc .prop-catalog .prop-catalog-reset { margin: 0 0 0 auto; padding: .25rem 0; border: 0; background: none; color: var(--prop-accent-text); font-size: .8125rem; font-weight: 600; cursor: pointer; }
html .doc .prop-catalog .prop-catalog-reset:hover { text-decoration: underline; text-underline-offset: 3px; }
.prop-catalog-reset[hidden] { display: none; }

/* Rows */
html .doc .prop-catalog ul.prop-catalog-list { display: block; margin: 0; padding: 0; list-style: none; border: 1px solid var(--meaning-neutral-border); border-radius: 12px; overflow: hidden; background: var(--body-background); }
html .doc .prop-catalog ul.prop-catalog-list[hidden] { display: none; }
html .doc .prop-catalog ul.prop-catalog-list > li.prop-card { position: relative; display: grid; gap: .35rem; min-width: 0; margin: -1px 0 0; padding: .75rem 1rem .75rem 1.25rem; border-top: 1px solid var(--meaning-neutral-border); transition: background-color .12s ease; }
html .doc .prop-catalog ul.prop-catalog-list > li.prop-card[hidden] { display: none; }
html .doc .prop-catalog ul.prop-catalog-list > li.prop-card:hover, html .doc .prop-catalog ul.prop-catalog-list > li.prop-card:focus-within { background: var(--panel-background); }
.prop-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; }
.prop-card--enterprise::before { background: var(--meaning-enterprise-fg); }
.prop-card--deprecated::before { background: var(--meaning-deprecated-fg); }
.prop-card--byoc::before { background: var(--meaning-cloud-fg); }
html .doc .prop-catalog ul.prop-catalog-list > li.prop-card--enterprise { background: linear-gradient(90deg, var(--meaning-enterprise-bg) 0, var(--prop-row-end) 35%); }
html .doc .prop-catalog ul.prop-catalog-list > li.prop-card--enterprise:hover, html .doc .prop-catalog ul.prop-catalog-list > li.prop-card--enterprise:focus-within { background: linear-gradient(90deg, var(--meaning-enterprise-bg) 0, transparent 35%), var(--panel-background); }
html .doc .prop-card p { margin: 0; }
.prop-card-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .25rem .75rem; align-items: baseline; min-width: 0; }
html .doc .prop-card .prop-card-sig { margin: 0; padding: 0; border: 0; color: var(--body-font-color); font-family: inherit; font-size: .9375rem; font-weight: 400; letter-spacing: normal; line-height: 1.35; overflow-wrap: anywhere; scroll-margin-top: 0; }
html .doc .prop-card .prop-card-sig::before, html .doc .prop-card .prop-card-sig::after { content: none; }
html .doc .prop-card .prop-card-sig code { padding: 0; border: 0; background: none; text-decoration: none; font-size: inherit; overflow-wrap: anywhere; }
html .doc .prop-card .prop-card-name { color: var(--heading-font-color, var(--body-font-color)); font-weight: 600; }
.prop-card--deprecated .prop-card-name, html .doc .prop-card--deprecated .prop-card-sig .prop-card-name { color: var(--meaning-neutral-fg); }
html .doc .prop-card a.prop-card-link { color: inherit; text-decoration: none; }
html .doc .prop-card a.prop-card-link .prop-card-name { color: var(--prop-accent-text); }
html .doc .prop-card a.prop-card-link:hover .prop-card-name, html .doc .prop-card a.prop-card-link:focus-visible .prop-card-name { color: var(--prop-accent-text); text-decoration: underline 1px; text-underline-offset: 3px; }
html .doc .prop-card a.prop-card-link:focus-visible { outline: 2px solid var(--prop-focus); outline-offset: 2px; border-radius: 4px; }
html .doc .prop-card .prop-card-colon, html .doc .prop-card .prop-card-sig .prop-card-type { color: var(--meaning-neutral-fg); font-size: .8125rem; font-weight: 400; }
.prop-card-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .3rem; }
html .doc .prop-card .rp-badge.prop-badge--scope::before { content: ""; flex: none; width: 1em; height: 1em; background-color: var(--prop-accent-text); -webkit-mask: var(--ico) no-repeat center / contain; mask: var(--ico) no-repeat center / contain; }
.prop-badge--restart::before { content: ""; flex: none; width: 1em; height: 1em; background-color: currentColor; -webkit-mask: var(--prop-icon-restart) no-repeat center / contain; mask: var(--prop-icon-restart) no-repeat center / contain; }
html .doc .prop-card .prop-card-desc { margin: 0; color: var(--body-font-color); font-size: .875rem; line-height: 1.45; overflow-wrap: anywhere; }
.prop-card-meta { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem .75rem; min-width: 0; color: var(--meaning-neutral-fg); font-size: .8125rem; }
.prop-card-meta > * { min-width: 0; overflow-wrap: anywhere; }
.prop-card-fact-label { margin-right: .3rem; font-weight: 600; }
html .doc .prop-card .prop-card-default code { padding: .05rem .4rem; border: 1px solid var(--meaning-neutral-border); border-radius: 6px; background: var(--meaning-neutral-bg); color: var(--body-font-color); font-size: .75rem; }
.prop-card-license { display: inline-flex; flex-wrap: wrap; align-items: center; gap: .25rem; }
.prop-card-license-icon { font-size: 12px; color: var(--meaning-enterprise-fg); }
.prop-card-license .prop-card-fact-label { margin-right: .05rem; }
html .doc .prop-card .prop-card-license code { padding: .05rem .35rem; border: 1px solid var(--meaning-enterprise-border); border-radius: 6px; background: var(--meaning-enterprise-bg); color: var(--meaning-enterprise-fg); font-size: .75rem; }
.prop-card-command { display: flex; flex: 1 1 100%; justify-content: space-between; align-items: center; gap: .5rem; box-sizing: border-box; min-width: 0; max-width: 100%; margin-left: 0; padding: .1rem .15rem .1rem .5rem; border: 1px solid var(--meaning-neutral-border); border-radius: 8px; background: var(--panel-background); }
html .doc .prop-card .prop-card-command-text { min-width: 0; padding: 0; border: 0; background: none; color: var(--body-font-color); font-size: .75rem; white-space: normal; overflow-wrap: anywhere; }
.prop-cmd-bin { color: var(--body-font-color); font-weight: 500; }
.prop-cmd-name { color: var(--body-font-color); font-weight: 600; }
.prop-cmd-ph { color: var(--meaning-neutral-fg); font-style: italic; }
html .doc .prop-card .source-toolbox { position: static; flex: 0 0 auto; padding: 0; visibility: visible; background: none; box-shadow: none; }
html .doc .prop-card .source-toolbox .copy-button { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--meaning-neutral-fg); cursor: pointer; }
html .doc .prop-card .source-toolbox .copy-button:hover { background: var(--meaning-neutral-bg); color: var(--prop-accent-text); }
html .doc .prop-card .source-toolbox .copy-button:hover .copy-icon rect { stroke: currentColor; }
html .doc .prop-card .source-toolbox .copy-button:focus-visible { outline: 2px solid var(--prop-focus); outline-offset: 2px; }
.prop-card-managed { display: inline-flex; flex: 1 1 100%; align-items: center; gap: .35rem; color: var(--meaning-neutral-fg); }
.prop-card-managed-icon { font-size: 14px; color: var(--meaning-cloud-fg); }

/* Empty state */
html .doc .prop-catalog .prop-catalog-empty { padding: 2rem 1rem; border: 1px dashed var(--meaning-neutral-border); border-radius: 12px; background: var(--panel-background); text-align: center; }
html .doc .prop-catalog .prop-catalog-empty[hidden] { display: none; }
.prop-catalog-empty-icon { display: inline-flex; align-items: center; justify-content: center; width: 2.5rem; height: 2.5rem; margin-bottom: .75rem; border-radius: 10px; background: var(--prop-accent-tint); color: var(--prop-accent-text); font-size: 20px; }
html .doc .prop-catalog .prop-catalog-empty-title { margin: 0; color: var(--body-font-color); font-size: .9375rem; font-weight: 600; }
html .doc .prop-catalog .prop-catalog-empty-hint { margin: .25rem 0 0; color: var(--meaning-neutral-fg); font-size: .875rem; }
html .doc .prop-catalog .prop-catalog-empty-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: .5rem; margin: 1rem 0 0; }
.prop-catalog .prop-catalog-clear.rp-button--primary { --rp-fg: var(--component-600, #444ce7); }
html[data-theme=dark] .doc .prop-catalog .prop-catalog-clear.rp-button--primary { color: #fff; }
.prop-catalog-show-deprecated[hidden] { display: none; }
.doc .sect1[hidden="until-found"], .doc .sect2[hidden="until-found"], .doc .sect3[hidden="until-found"] { margin: 0; padding: 0; border: 0; }

/* A reference page's bar: one row */
html .doc .prop-catalog--filter { margin: 1.25rem 0 1.5rem; }
html .doc .prop-catalog--filter .prop-catalog-bar { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; gap: .5rem .75rem; }
html .doc .prop-catalog--filter .prop-catalog-searchbox { flex: 1 1 15rem; }
html .doc .prop-catalog--filter .prop-catalog-search { height: 2.5rem; }
html .doc .prop-catalog--filter .prop-catalog-count { margin-left: auto; }
html .doc .prop-catalog--filter .prop-catalog-more { flex: 1 1 100%; }
html .doc .prop-catalog--filter .prop-catalog-results { margin: .75rem 0 0; }

/* Sticky from 1025px, the site's breakpoint (below it main > .content
   scrolls on its own); the offset comes from the page script */
@media (min-width: 1025px) {
  html .doc .prop-catalog--sticky:not(.prop-catalog--filter) .prop-catalog-bar, html .doc .prop-catalog--filter.prop-catalog--sticky { position: sticky; top: var(--prop-bar-top, calc(var(--body-top--desktop, 60px) + var(--toolbar-height, 0px))); z-index: 5; }
  html .doc .prop-catalog--filter.prop-catalog--sticky { background: var(--body-background); }
  html:has(.prop-catalog--sticky) { scroll-padding-top: var(--prop-filter-offset, 9rem); }
  html .doc .prop-catalog--sticky.prop-catalog--unstuck:not(.prop-catalog--filter) .prop-catalog-bar, html .doc .prop-catalog--filter.prop-catalog--sticky.prop-catalog--unstuck { position: relative; }
  html .doc .prop-catalog .prop-catalog-bar.is-stuck .prop-catalog-more, html .doc .prop-catalog--filter.prop-catalog--sticky .prop-catalog-bar.is-stuck .prop-catalog-more { max-height: var(--prop-more-max, min(50vh, 24rem)); overflow: auto; overscroll-behavior: contain; }
}

@media (max-width: 768px) {
  html .doc .prop-catalog .prop-catalog-bar { padding: .75rem; }
  html .doc .prop-catalog .prop-catalog-kbd { display: none; }
  html .doc .prop-catalog .prop-catalog-search { padding-right: .75rem; }
  html .doc .prop-catalog .prop-active-tag { min-height: 2.25rem; }
  html .doc .prop-catalog .prop-catalog-reset { min-height: 2.25rem; padding: .5rem 0; }
  html .doc .prop-catalog .prop-chip { min-height: 2.25rem; }
  html .doc .prop-catalog .dropdown-checkbox-toggle { height: 2.25rem; }
  html .doc .prop-catalog .prop-catalog-more > .filter-group { flex: 1 1 auto; min-width: calc(50% - .25rem); }
  html .doc .prop-catalog .prop-catalog-more .dropdown-checkbox-wrapper, html .doc .prop-catalog .prop-catalog-more .dropdown-checkbox-toggle { width: 100%; }
  html .doc .prop-catalog .prop-catalog-more .dropdown-text { flex: 1 1 auto; max-width: none; }
  html .doc .prop-catalog--filter .prop-catalog-searchbox { flex-basis: 100%; }
  html .doc .prop-catalog--filter .prop-catalog-search { height: 2.75rem; }
  html .doc .prop-catalog--filter .prop-catalog-count { flex-basis: 100%; margin-left: 0; }
  .prop-catalog-results .prop-catalog-count { order: 1; }
  .prop-catalog-results .prop-catalog-reset { order: 2; }
  html .doc .prop-catalog .prop-catalog-results ul.prop-catalog-active { order: 3; flex-basis: 100%; }
  .prop-card-head { grid-template-columns: minmax(0, 1fr); }
  .prop-card-badges { justify-content: flex-start; }
  html .doc .prop-catalog ul.prop-catalog-list > li.prop-card { padding: .75rem .875rem .75rem 1.125rem; }
  html .doc .prop-catalog .filter-group.prop-chip-group { gap: .35rem; }
  html .doc .prop-card .source-toolbox .copy-button { width: 36px; height: 36px; }
}

/* Touch only: one row of chips that scrolls sideways under a finger. With a
   mouse (a zoomed desktop too) the chips wrap, so every one is in view. */
@media (max-width: 768px) and (hover: none) {
  html .doc .prop-catalog .filter-group.prop-chip-group { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; margin: -3px; padding: 3px 1.5rem 3px 3px; -webkit-mask: linear-gradient(90deg, #000 calc(100% - 1.5rem), transparent); mask: linear-gradient(90deg, #000 calc(100% - 1.5rem), transparent); }
  html .doc .prop-catalog .filter-group.prop-chip-group::-webkit-scrollbar { display: none; }
}

/* Windows High Contrast and other forced colors: backgrounds and masks
   painted with background-color are reset, so pressed chips, icons, and the
   row accents get system colors */
@media (forced-colors: active) {
  html .doc .prop-catalog .prop-chip[aria-pressed=true] { forced-color-adjust: none; background: Highlight; color: HighlightText; border: 2px solid Highlight; }
  html .doc .prop-catalog .prop-chip[aria-pressed=true] .prop-chip-count { forced-color-adjust: none; background: HighlightText; color: Highlight; }
  .prop-ico::before, .prop-chip[aria-pressed=true]::after, .prop-badge--restart::before, html .doc .prop-card .rp-badge.prop-badge--scope::before { forced-color-adjust: none; background-color: CanvasText; }
  .prop-chip[aria-pressed=true] .prop-ico::before, .prop-chip[aria-pressed=true]::after { background-color: HighlightText; }
  .prop-card::before { display: none; }
  html .doc .prop-catalog ul.prop-catalog-list > li.prop-card--enterprise, html .doc .prop-catalog ul.prop-catalog-list > li.prop-card--deprecated, html .doc .prop-catalog ul.prop-catalog-list > li.prop-card--byoc { border-left: 4px solid CanvasText; }
}

@media (prefers-reduced-motion: reduce) {
  html .doc .prop-catalog ul.prop-catalog-list > li.prop-card, html .doc .prop-catalog .prop-chip, .prop-chip-chevron, html .doc .prop-catalog .dropdown-arrow, html .doc .prop-catalog .dropdown-checkbox-toggle, html .doc .prop-catalog .prop-active-tag, html .doc .prop-catalog .prop-catalog-bar, html .doc .prop-catalog .prop-catalog-search, html .doc .prop-card .copy-toast { transition: none; }
}
`

/**
 * The bar both modes share: the search box, then the chips row, then the
 * More panel.
 */
function barHtml ({ id, ariaLabel, label, placeholder, chips, tail = '', after = '', panelSpecs }) {
  return `<div class="table-filters prop-catalog-filters prop-catalog-bar" role="search" aria-label="${escapeHtml(ariaLabel)}">` +
    searchBoxHtml(id, label, placeholder) +
    (chips ? `<div class="prop-catalog-chips">${chips}</div>` : '') +
    tail +
    (panelSpecs.length ? `<div class="prop-catalog-more" id="${id}-more" hidden>${panelSpecs.map((spec) => filterGroupHtml(spec, id)).join('')}</div>` : '') +
    after +
    '</div>'
}

/**
 * The whole catalog's HTML for a list of cards. Exported for unit testing.
 */
// What licensing means on Cloud, where the cards carry no Enterprise marking.
// From the licensing overview: "Redpanda Cloud is a managed deployment of
// Redpanda Enterprise Edition."
const CLOUD_LICENSE_NOTE = 'Redpanda Cloud is a managed deployment of Redpanda Enterprise Edition.'

function catalogHtml (cards, { cloud = false, id = 'property-catalog', dataset = '', headingLevel = 2 } = {}) {
  const specs = filterSpecs(cards, { cloud })
  const index = JSON.stringify(cards.map((c) => c.search)).replace(/</g, '\\u003c')
  const shown = cards.filter((c) => c.deprecated !== 'yes').length
  const groupSpec = specs.find((s) => s.key === 'group')
  const panelSpecs = specs.filter((s) => s.key !== 'group')
  const quickChips = quickChipsHtml(specs)
  const chips = (groupSpec ? groupChipsHtml(groupSpec, cards, id) : '') +
    quickChips +
    (panelSpecs.length ? moreButtonHtml(id) : '')
  return `<div class="prop-catalog" id="${id}"${cloud ? ' data-cloud="true"' : ''}${dataset ? ` data-dataset="${escapeHtml(dataset)}"` : ''}>` +
    `<style>${CSS}</style>` +
    '<div class="prop-catalog-sentinel" aria-hidden="true"></div>' +
    // The count, the tags, and Clear all sit inside the bar, so they stick with it
    barHtml({ id, ariaLabel: 'Search and filter properties', label: 'Search properties by name or description:', placeholder: `Search ${shown} properties`, chips, panelSpecs, after: `<div class="prop-catalog-results">${countHtml(shown)}${RESULTS_TAIL}</div>` }) +
    STATUS_HTML +
    (cloud ? `<p class="prop-catalog-note"><span class="prop-ico prop-catalog-note-icon" style="--ico:var(--icon-cloud)" aria-hidden="true"></span>${escapeHtml(CLOUD_LICENSE_NOTE)}</p>` : '') +
    emptyHtml('No properties match your search and filters.') +
    // data-tooltip-nofocus keeps the badges' tooltips out of the tab order;
    // each badge carries its detail as text instead
    `<ul class="prop-catalog-list" role="list" aria-label="Properties" data-tooltip-nofocus>${cards.map((c) => cardHtml(c, headingLevel)).join('')}</ul>` +
    PILL_HTML +
    `<script type="application/json" class="prop-catalog-index">${index}</script>` +
    `<script>${bootScript(id)}</script>` +
    '</div>'
}

/**
 * The filter bar for one reference page: the same search, chips, status
 * region, and empty state as the catalog, over the entries the page already
 * renders. Its data is one row per entry, keyed by the entry's anchor.
 * Exported for unit testing.
 */
function filterBarHtml (cards, { cloud = false, id = 'property-filter', dataset = '' } = {}) {
  const specs = filterSpecs(cards, { cloud, mode: 'filter' })
  const rows = cards.map((c) => [c.anchor, c.restart, c.enterprise, c.deprecated, c.section, c.cloudEditable, c.byoc])
  const index = JSON.stringify(rows).replace(/</g, '\\u003c')
  const shown = cards.filter((c) => c.deprecated !== 'yes').length
  // The topic page's Section filter is a row of chips with counts, like the
  // catalog's Group chips; the rest go in More
  const inline = specs.filter((s) => s.key === 'section')
  const panelSpecs = specs.filter((s) => s.key !== 'section')
  const chips = inline.map((spec) => groupChipsHtml(spec, cards, id)).join('') + quickChipsHtml(specs) + (panelSpecs.length ? moreButtonHtml(id) : '')
  return `<div class="prop-catalog prop-catalog--filter" id="${id}" data-mode="filter"${cloud ? ' data-cloud="true"' : ''}${dataset ? ` data-dataset="${escapeHtml(dataset)}"` : ''}>` +
    `<style>${CSS}</style>` +
    '<div class="prop-catalog-sentinel" aria-hidden="true"></div>' +
    barHtml({ id, ariaLabel: 'Filter the properties on this page', label: 'Filter the properties on this page by name or description:', placeholder: `Filter ${shown} ${shown === 1 ? 'property' : 'properties'}`, chips, tail: countHtml(shown), panelSpecs }) +
    `<div class="prop-catalog-results" hidden>${RESULTS_TAIL}</div>` +
    STATUS_HTML +
    emptyHtml('No properties on this page match your search and filters.') +
    PILL_HTML +
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
      // Each card's name is a heading one level below the section the
      // catalog sits in (h2 at the top of a page)
      let section = parent
      while (section && section.getContext && section.getContext() !== 'section' && section.getParent) section = section.getParent()
      const level = section && section.getContext && section.getContext() === 'section' ? section.getLevel() : 0
      return self.createBlock(parent, 'pass', catalogHtml(result.cards, { cloud: result.cloud, dataset, headingLevel: level + 2 }))
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
module.exports.normalizeSearch = normalizeSearch
module.exports.emptyStateText = emptyStateText
module.exports.catalogHtml = catalogHtml
module.exports.filterBarHtml = filterBarHtml
module.exports.sectionLabel = sectionLabel
module.exports.buildCards = buildCards
module.exports.categoryLabel = categoryLabel
module.exports.relativeUrl = relativeUrl
