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
function buildBadgeHtml ({ label, size, tooltip } = {}) {
  const text = label || 'label';
  const className = `badge--${text.toLowerCase().replace(/\s+/g, '-')}`;
  const isLarge = size === 'large';
  const sizeClass = isLarge ? 'badge--large' : '';
  const tooltipAttr = tooltip ? ` data-tooltip="${tooltip}"` : '';

  // Add brackets if not large. The brackets matter beyond styling: they are
  // real text content, so the label survives an HTML-to-Markdown conversion as
  // "(beta)" rather than vanishing with the CSS class.
  const renderedLabel = isLarge ? text : `(${text})`;

  return `<span class="badge ${className} ${sizeClass}"${tooltipAttr}>${renderedLabel}</span>`;
}

module.exports.buildBadgeHtml = buildBadgeHtml;

module.exports.register = function (registry) {
  registry.inlineMacro(function () {
    const self = this;
    self.named('badge');
    self.process((parent, target, attrs) =>
      buildBadgeHtml({ label: attrs.label, size: attrs.size, tooltip: attrs.tooltip })
    );
  });
};
