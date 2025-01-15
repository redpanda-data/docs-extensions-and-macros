'use strict';

module.exports = (releaseDate, eolMonths, warningWeeks, logger) => {
  if (!releaseDate) {
    logger.warn(
      'No release date provided. Make sure to set {page-release-date} in the antora.yml of the component.'
    );
    return null;
  }

  // Parse the input date string YYYY-MM-DD in UTC
  const parseUTCDate = (dateString) => {
    const [year, month, day] = dateString.split('-').map(Number);
    // month - 1 because JS months are 0-based
    // https://www.w3schools.com/jsref/jsref_getmonth.asp
    return new Date(Date.UTC(year, month - 1, day));
  };

  const targetDate = parseUTCDate(releaseDate);

  if (isNaN(targetDate.getTime())) {
    logger.warn('Invalid release date format:', releaseDate);
    return null;
  }

  // Calculate EoL date in UTC
  const eolDate = new Date(targetDate.getTime()); // clone
  eolDate.setUTCMonth(eolDate.getUTCMonth() + eolMonths);

  // Calculate the threshold for warning (X weeks before EoL) in UTC
  const weeksBeforeEOL = new Date(eolDate.getTime());
  weeksBeforeEOL.setUTCDate(weeksBeforeEOL.getUTCDate() - warningWeeks * 7);

  // Compare times in milliseconds to avoid timezone confusion
  const nowMs = Date.now();
  const eolMs = eolDate.getTime();
  const warningMs = weeksBeforeEOL.getTime();

  const isNearingEOL = nowMs >= warningMs && nowMs < eolMs;
  const isPastEOL = nowMs > eolMs;

  // Format the EoL date in UTC
  const humanReadableEOLDate = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC', // Ensure UTC in output
  }).format(eolDate);

  return {
    isNearingEOL,
    isPastEOL,
    eolDate: humanReadableEOLDate, // For example "March 1, 2025"
  };
};
