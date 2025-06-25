'use strict';

module.exports.register = function (registry) {
  registry.inlineMacro(function () {
    const self = this;
    self.named('badge');
    self.process((parent, target, attrs) => {
      const label = attrs.label || 'label';
      const className = `badge--${label.toLowerCase().replace(/\s+/g, '-')}`;
      const isLarge = attrs.size === 'large';
      const sizeClass = isLarge ? 'badge--large' : '';
      const tooltip = attrs.tooltip;
      const tooltipAttr = tooltip ? ` data-tooltip="${tooltip}"` : '';

      // Add brackets if not large
      const renderedLabel = isLarge ? label : `(${label})`;

      return `<span class="badge ${className} ${sizeClass}"${tooltipAttr}>${renderedLabel}</span>`;
    });
  });
};
