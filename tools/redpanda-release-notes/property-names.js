// Load the configuration property names that the release-notes generator links
// as `prop:` macros. The names come from the same redpanda-properties-<tag>.json
// attachment that the prop macro validates against, so a name linked here is a
// name the docs build can resolve.

const fs = require('fs');
const path = require('path');

// The attachment directory, relative to the docs repository root.
const ATTACHMENTS_DIR = 'modules/reference/attachments';
const PROPERTIES_JSON_RX = /^redpanda-properties-v(\d+)\.(\d+)\.(\d+)\.json$/;

/**
 * Returns the property names in a parsed property JSON file.
 *
 * @param {Object} json - Parsed redpanda-properties-<tag>.json content.
 * @return {Set<string>} The property names.
 * @throws {Error} If the file has no `properties` object.
 */
function propertyNamesFromJson(json) {
  if (!json || typeof json.properties !== 'object' || json.properties === null) {
    throw new Error('Property file has no "properties" object.');
  }
  return new Set(Object.keys(json.properties));
}

/**
 * Finds the newest GA property file for a tag's release series. A 26.2 tag
 * uses 26.2 data only, the same rule the prop macro applies to a page, so a
 * property from another release series is never linked.
 *
 * @param {string} dir - The directory to search.
 * @param {string} tag - The release tag (`v26.2.5` or `26.2.5`).
 * @return {string|null} The path to the newest matching file, or null if there is none.
 */
function findPropertiesFile(dir, tag) {
  const m = String(tag).match(/^v?(\d+)\.(\d+)\./);
  if (!m || !fs.existsSync(dir)) return null;
  const [, major, minor] = m;
  let best = null;
  for (const file of fs.readdirSync(dir)) {
    const f = file.match(PROPERTIES_JSON_RX);
    if (!f || f[1] !== major || f[2] !== minor) continue;
    const patch = Number(f[3]);
    if (!best || patch > best.patch) best = { patch, file };
  }
  return best ? path.join(dir, best.file) : null;
}

/**
 * Reads the property names from a property JSON file.
 *
 * @param {string} file - Path to a redpanda-properties-<tag>.json file.
 * @return {Set<string>} The property names.
 */
function loadPropertyNames(file) {
  return propertyNamesFromJson(JSON.parse(fs.readFileSync(file, 'utf8')));
}

module.exports = {
  ATTACHMENTS_DIR,
  propertyNamesFromJson,
  findPropertiesFile,
  loadPropertyNames,
};
