'use strict';

module.exports = (releaseDate, eolMonths, warningWeeks, logger) => {
  if (!releaseDate) {
    logger.warn(`No release date provided. Make sure to set {page-release-date} in the antora.yml of the component.`);
    return null;
  }

  const targetDate = new Date(releaseDate);
  if (isNaN(targetDate)) {
    logger.warn('Invalid release date format:', releaseDate);
    return null;
  }

  // Calculate EoL date
  const eolDate = new Date(targetDate);
  eolDate.setMonth(eolDate.getMonth() + eolMonths);

  // Calculate the threshold for warning (X weeks before EoL)
  const weeksBeforeEOL = new Date(eolDate);
  weeksBeforeEOL.setDate(weeksBeforeEOL.getDate() - warningWeeks * 7);

  // Determine if the current date falls within warning or post-EoL
  const today = new Date();
  const isNearingEOL = today >= weeksBeforeEOL && today < eolDate;
  const isPastEOL = today > eolDate;

  const humanReadableEOLDate = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(eolDate);

  return {
    isNearingEOL,
    isPastEOL,
    eolDate: humanReadableEOLDate, // For example "March 1, 2025"
  };
};