'use strict';

const calculateEOL = require('./util/calculate-eol.js');

module.exports.register = function ({ config }) {
  this.on('contentClassified', ({ contentCatalog }) => {
    const logger = this.getLogger("compute-end-of-life-extension");

    // Extract EOL configuration from the config object
    const eolConfigs = config.data?.eol_settings || [];
    if (!Array.isArray(eolConfigs) || eolConfigs.length === 0) {
      logger.warn('No end-of-life settings found in configuration.');
      return;
    }

    eolConfigs.forEach(({ component: componentName, supported_months, warning_weeks, eol_doc, upgrade_doc }) => {
      if (!eol_doc || !upgrade_doc) {
        logger.error(
          `End-of-life configuration for component "${component}" is missing required attributes. ` +
          `Ensure both "eol_doc" and "upgrade_doc" are specified.`
        );
        return;
      }
      const resolvedEOLMonths = supported_months && supported_months > 0 ? supported_months : 12; // Default: 12 months
      const resolvedWarningWeeks = warning_weeks && warning_weeks > 0 ? warning_weeks : 6; // Default: 6 weeks

      logger.info(
        `Processing component: ${componentName} with end-of-life months: ${resolvedEOLMonths}, Warning weeks: ${resolvedWarningWeeks}`
      );

      const component = contentCatalog.getComponents().find((c) => c.name === componentName);

      if (!component) {
        logger.warn(`Component not found: ${componentName}`);
        return;
      }

      component.versions.forEach(({ asciidoc, version }) => {
        const releaseDate = asciidoc.attributes['page-release-date'];
        if (releaseDate) {
          // Pass resolved configuration to calculateEOL
          const eolInfo = calculateEOL(releaseDate, resolvedEOLMonths, resolvedWarningWeeks, logger);
          Object.assign(asciidoc.attributes, {
            'page-is-nearing-eol': eolInfo.isNearingEOL.toString(),
            'page-is-past-eol': eolInfo.isPastEOL.toString(),
            'page-eol-date': eolInfo.eolDate,
            'page-eol-doc': eol_doc,
            'page-upgrade-doc': upgrade_doc,
          });
        } else {
          logger.warn(`No release date found for component: ${componentName}. Make sure to set {page-release-date} in the antora.yml of the component version ${version}.`);
        }
      });
    });
  });
};
