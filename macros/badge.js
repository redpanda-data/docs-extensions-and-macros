'use strict';

/**
 * Build the HTML for a badge.
 *
 * Extracted from the macro body so other macros can render an identical badge
 * without depending on the badge macro being registered in the consuming
 * playbook. The enterprise macro uses it to render the beta badge for registry
 * entries marked `beta: true`, which keeps one definition of the markup and
 * the CSS class names.
 *
 * @param {object} opts
 * @param {string} [opts.label] - Badge text.
 * @param {string} [opts.size] - `large` renders without surrounding brackets.
 * @param {string} [opts.tooltip] - Tooltip text, rendered as `data-tooltip`.
 * @returns {string} Badge HTML.
 */
// Hover text for the labels this macro is asked for by name. The badge is
// styled with a help cursor, so a badge with nothing to say promises an
// explanation and then withholds it. Callers with something more specific pass
// their own tooltip, which wins.
const DEFAULT_TOOLTIPS = {
  beta: 'This feature is in public beta. You can enable it, but it may change before it is generally available.',
  unreleased: 'This feature is not in a released version of Redpanda yet. It is documented here for the upcoming release.',
};

function buildBadgeHtml ({ label, size, tooltip } = {}) {
  const text = label || 'label';
  const isLarge = size === 'large';
  const sizeClass = isLarge ? 'badge--large' : '';
  // Escape before interpolating: these values reach the macro from .adoc source
  // and from registry fields, and an unescaped quote terminates the attribute
  // early, turning the rest of the text into stray attributes (including event
  // handlers). The label needs it as much as the tooltip -- it lands in the
  // class attribute and in the text content, and escaping only the tooltip left
  // `badge:x[label=x" onmouseover="...]` free to break out of the class.
  const escapeAttr = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const className = `badge--${escapeAttr(text.toLowerCase().replace(/\s+/g, '-'))}`;
  // hasOwnProperty, not a bare index: `label=constructor` and `label=__proto__`
  // are already lowercase, so a bare lookup shipped
  // `function Object() { [native code] }` to readers as hover text. prop.js
  // guards its property lookups the same way.
  const labelKey = text.trim().toLowerCase();
  const defaultTooltip = Object.prototype.hasOwnProperty.call(DEFAULT_TOOLTIPS, labelKey)
    ? DEFAULT_TOOLTIPS[labelKey]
    : undefined;
  const hoverText = tooltip || defaultTooltip;
  const tooltipAttr = hoverText ? ` data-tooltip="${escapeAttr(hoverText)}"` : '';

  // Add brackets if not large. The brackets matter beyond styling: they are
  // real text content, so the label survives an HTML-to-Markdown conversion as
  // "(beta)" rather than vanishing with the CSS class.
  const renderedLabel = isLarge ? escapeAttr(text) : `(${escapeAttr(text)})`;

  return `<span class="badge ${className} ${sizeClass}"${tooltipAttr}>${renderedLabel}</span>`;
}

module.exports.buildBadgeHtml = buildBadgeHtml;
module.exports.DEFAULT_TOOLTIPS = DEFAULT_TOOLTIPS;

module.exports.register = function (registry) {
  registry.inlineMacro(function () {
    const self = this;
    self.named('badge');
    self.process((parent, target, attrs) =>
      buildBadgeHtml({ label: attrs.label, size: attrs.size, tooltip: attrs.tooltip })
    );
  });
};
