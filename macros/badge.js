'use strict';

const { escapeHtml } = require('../extension-utils/html-utils');

// The meanings docs-ui styles as .rp-badge--NAME, keyed by the label a writer
// or template asks for (lowercased). Each gives the class, the exact label the
// site shows, and, where older UI bundles used a different class, the legacy
// .badge--* class to keep on the same element.
const MEANINGS = {
  beta: { name: 'beta', label: 'Beta' },
  preview: { name: 'preview', label: 'Preview' },
  limited: { name: 'limited', label: 'Limited availability', legacy: 'limited-availability' },
  'limited availability': { name: 'limited', label: 'Limited availability', legacy: 'limited-availability' },
  'limited-availability': { name: 'limited', label: 'Limited availability', legacy: 'limited-availability' },
  deprecated: { name: 'deprecated', label: 'Deprecated' },
  eol: { name: 'eol', label: 'End of life' },
  'end of life': { name: 'eol', label: 'End of life', legacy: 'eol' },
  'eol soon': { name: 'eol-soon', label: 'End of life soon' },
  'end of life soon': { name: 'eol-soon', label: 'End of life soon', legacy: 'eol-soon' },
  new: { name: 'new', label: 'New' },
  enterprise: { name: 'enterprise', label: 'Enterprise' },
  cloud: { name: 'cloud', label: 'Cloud' },
  byoc: { name: 'cloud', label: 'BYOC', legacy: 'byoc' },
  serverless: { name: 'cloud', label: 'Serverless', legacy: 'serverless' },
  dedicated: { name: 'cloud', label: 'Dedicated', legacy: 'dedicated' },
  'self-managed': { name: 'self-managed', label: 'Self-Managed' },
  'self managed': { name: 'self-managed', label: 'Self-Managed', legacy: 'self-managed' },
  certified: { name: 'certified', label: 'Certified' },
  community: { name: 'community', label: 'Community' },
  // Not a meaning of its own: a neutral badge, with the class older bundles
  // already give a clock icon.
  unreleased: { name: 'neutral', label: 'Unreleased', legacy: 'unreleased' },
};

// Hover text for each meaning. The badge text carries the meaning; the tooltip
// adds detail. Callers with something more specific pass their own tooltip,
// which wins.
const DEFAULT_TOOLTIPS = {
  enterprise: 'Requires an Enterprise Edition license.',
  beta: 'Beta: available to try, and may change before general availability.',
  preview: 'Preview: not covered by Enterprise Support or SLAs, and may change.',
  limited: 'Limited availability: open to selected customers.',
  deprecated: 'Deprecated: still available, but planned for removal.',
  eol: 'No longer supported.',
  'eol-soon': 'Support ends soon.',
  new: 'New in this release.',
  cloud: 'Available in Redpanda Cloud.',
  byoc: 'Available on Redpanda Cloud BYOC clusters.',
  serverless: 'Available on Redpanda Cloud Serverless clusters.',
  dedicated: 'Available on Redpanda Cloud Dedicated clusters.',
  'self-managed': 'Available in Self-Managed Redpanda.',
  certified: 'Supported and tested by Redpanda.',
  community: 'Community-supported.',
  unreleased: 'This feature is not in a released version of Redpanda yet. It is documented here for the upcoming release.',
};

// "since 25.1", "Since v25.1", "since: v25.1" all become "Since v25.1".
const SINCE_PATTERN = /^since:?\s+v?(\S.*)$/i;

/**
 * Resolve a requested label to its meaning, its exact label, and the legacy
 * class. Exported for unit testing.
 *
 * @param {string} text - The label as written.
 * @returns {{name: string, label: string, legacy: string, tooltipKey: string}}
 */
function resolveMeaning (text) {
  const raw = String(text).trim();
  const key = raw.toLowerCase().replace(/\s+/g, ' ');
  // hasOwnProperty, not a bare index: `label=constructor` and `label=__proto__`
  // are already lowercase, so a bare lookup would resolve to Object internals.
  if (Object.prototype.hasOwnProperty.call(MEANINGS, key)) {
    const meaning = MEANINGS[key];
    const tooltipKey = Object.prototype.hasOwnProperty.call(DEFAULT_TOOLTIPS, meaning.legacy) ? meaning.legacy : meaning.name;
    return { name: meaning.name, label: meaning.label, legacy: meaning.legacy || meaning.name, tooltipKey };
  }
  const since = SINCE_PATTERN.exec(raw);
  if (since) {
    return { name: 'since', label: `Since v${since[1].trim()}`, legacy: 'since', tooltipKey: 'since', version: since[1].trim() };
  }
  return { name: 'neutral', label: raw, legacy: key.replace(/\s+/g, '-'), tooltipKey: key };
}

/**
 * Build the HTML for a badge.
 *
 * Extracted from the macro body so other macros can render an identical badge
 * without depending on the badge macro being registered in the consuming
 * playbook. The enterprise macro uses it to render the beta and unreleased
 * badges for registry entries, which keeps one definition of the markup.
 *
 * The markup is the docs-ui meaning badge,
 * `<span class="rp-badge rp-badge--NAME" data-tooltip="...">Label</span>`. The
 * older `badge badge--*` classes stay on the same element so pages built with
 * an older UI bundle still style the badge. Labels never carry parentheses:
 * the convert-to-markdown extension reads the rp-badge--NAME class to keep the
 * meaning in Markdown output.
 *
 * @param {object} opts
 * @param {string} [opts.label] - Badge text, matched to a meaning when it names one.
 * @param {string} [opts.size] - `sm` (or `small`) for dense contexts. `large` is
 *   accepted for older content and keeps the legacy `badge--large` class.
 * @param {string} [opts.tooltip] - Tooltip text, rendered as `data-tooltip`.
 * @param {string} [opts.product] - Product a Since badge names in its default
 *   tooltip ("Introduced in Redpanda v25.1.").
 * @returns {string} Badge HTML. Every badge has a non-empty `data-tooltip`.
 */
function buildBadgeHtml ({ label, size, tooltip, product } = {}) {
  const meaning = resolveMeaning(label || 'label');
  const classes = ['rp-badge', `rp-badge--${meaning.name}`];
  if (size === 'sm' || size === 'small') classes.push('rp-badge--sm');
  classes.push('badge');
  if (meaning.legacy) classes.push(`badge--${meaning.legacy}`);
  if (size === 'large') classes.push('badge--large');
  const defaultTooltip = Object.prototype.hasOwnProperty.call(DEFAULT_TOOLTIPS, meaning.tooltipKey)
    ? DEFAULT_TOOLTIPS[meaning.tooltipKey]
    : undefined;
  // Every badge explains itself: the help cursor promises a tooltip. A Since
  // badge names its version (and product when known), and a neutral badge
  // with no standard text falls back to its own label.
  const sinceTooltip = meaning.name === 'since'
    ? `Introduced in ${product ? `${String(product).trim()} ` : ''}v${meaning.version}.`
    : undefined;
  const hoverText = (tooltip && String(tooltip).trim()) || sinceTooltip || defaultTooltip || meaning.label;
  // Escape before interpolating: these values reach the macro from .adoc source
  // and from registry fields, and an unescaped quote would end the attribute
  // early, turning the rest of the text into stray attributes.
  const tooltipAttr = hoverText ? ` data-tooltip="${escapeHtml(hoverText)}"` : '';
  return `<span class="${escapeHtml(classes.join(' '))}"${tooltipAttr}>${escapeHtml(meaning.label)}</span>`;
}

module.exports.buildBadgeHtml = buildBadgeHtml;
module.exports.resolveMeaning = resolveMeaning;
module.exports.DEFAULT_TOOLTIPS = DEFAULT_TOOLTIPS;

module.exports.register = function (registry) {
  registry.inlineMacro(function () {
    const self = this;
    self.named('badge');
    self.process((parent, target, attrs) =>
      buildBadgeHtml({ label: attrs.label, size: attrs.size, tooltip: attrs.tooltip, product: attrs.product })
    );
  });
};
