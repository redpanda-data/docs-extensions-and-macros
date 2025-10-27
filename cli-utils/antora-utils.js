'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Attempts to locate and parse `antora.yml` in the current working directory.
 *
 * @returns {Object|undefined} The parsed YAML as a JavaScript object, or undefined if not found or on error.
 */
function loadAntoraConfig() {
  // Support both antora.yml and antora.yaml
  const cwd = process.cwd();
  const ymlPath = path.join(cwd, 'antora.yml');
  const yamlPath = path.join(cwd, 'antora.yaml');
  let antoraPath;
  if (fs.existsSync(ymlPath)) {
    antoraPath = ymlPath;
  } else if (fs.existsSync(yamlPath)) {
    antoraPath = yamlPath;
  } else {
    // No antora.yml or antora.yaml in project root
    return undefined;
  }

  try {
    const fileContents = fs.readFileSync(antoraPath, 'utf8');
    const config = yaml.load(fileContents);
    if (typeof config !== 'object' || config === null) {
      console.error(`Warning: ${path.basename(antoraPath)} parsed to a non‐object value.`);
      return undefined;
    }
    return config;
  } catch (err) {
    console.error(`Error reading/parsing ${path.basename(antoraPath)}: ${err.message}`);
    return undefined;
  }
}

/**
 * Safely retrieves a nested value from the Antora configuration, given a "dot path".
 *
 * Example usage:
 *   const latestVersion = getAntoraValue('asciidoc.attributes.latest-connect-version');
 *
 * @param {string} keyPath
 *   A dot-separated path into the Antora object (e.g. "asciidoc.attributes.foo").
 * @returns {*}
 *   The value at that path, or undefined if the file is missing or the key does not exist.
 */
function getAntoraValue(keyPath) {
  const config = loadAntoraConfig();
  if (!config) {
    return undefined;
  }

  // Split on dots, but ignore empty segments
  const segments = keyPath.split('.').filter(Boolean);
  let cursor = config;

  for (const seg of segments) {
    if (cursor && typeof cursor === 'object' && seg in cursor) {
      cursor = cursor[seg];
    } else {
      return undefined;
    }
  }
  return cursor;
}

/**
 * Safely sets a nested value in the Antora configuration, given a "dot path".
 * If the file or path does not exist, it will create intermediate objects as needed.
 * After setting the value, writes the updated YAML back to `antora.yml`.
 *
 * @param {string} keyPath
 *   A dot-separated path to set (e.g. "asciidoc.attributes.latest-connect-version").
 * @param {*} newValue
 *   The new value to assign at that path.
 * @returns {boolean}
 *   True if it succeeded, false otherwise.
 */
function setAntoraValue(keyPath, newValue) {
  // Support both antora.yml and antora.yaml
  const cwd = process.cwd();
  const ymlPath = path.join(cwd, 'antora.yml');
  const yamlPath = path.join(cwd, 'antora.yaml');
  let antoraPath;
  if (fs.existsSync(ymlPath)) {
    antoraPath = ymlPath;
  } else if (fs.existsSync(yamlPath)) {
    antoraPath = yamlPath;
  } else {
    console.error('Cannot update antora.yml or antora.yaml: file not found in project root.');
    return false;
  }

  let config;
  try {
    const fileContents = fs.readFileSync(antoraPath, 'utf8');
    config = yaml.load(fileContents) || {};
    if (typeof config !== 'object' || config === null) {
      config = {};
    }
  } catch (err) {
    console.error(`Error reading/parsing ${path.basename(antoraPath)}: ${err.message}`);
    return false;
  }

  // Traverse/construct nested objects
  const segments = keyPath.split('.').filter(Boolean);
  let cursor = config;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (i === segments.length - 1) {
      // Last segment: assign
      cursor[seg] = newValue;
    } else {
      // Intermediate: ensure object
      if (!(seg in cursor) || typeof cursor[seg] !== 'object' || cursor[seg] === null) {
        cursor[seg] = {};
      }
      cursor = cursor[seg];
    }
  }

  // Serialize back to YAML and write
  try {
    const newYaml = yaml.dump(config, { lineWidth: 120 });
    fs.writeFileSync(antoraPath, newYaml, 'utf8');
    return true;
  } catch (err) {
    console.error(`Error writing ${path.basename(antoraPath)}: ${err.message}`);
    return false;
  }
}

/**
 * Look for antora.yml in the current working directory
 * (the project's root), load it if present, and return
 * its `prerelease` value (boolean). If missing or on error,
 * returns false.
 */
function getPrereleaseFromAntora() {
  // Support both antora.yml and antora.yaml
  const cwd = process.cwd();
  const ymlPath = path.join(cwd, 'antora.yml');
  const yamlPath = path.join(cwd, 'antora.yaml');
  let antoraPath;
  if (fs.existsSync(ymlPath)) {
    antoraPath = ymlPath;
  } else if (fs.existsSync(yamlPath)) {
    antoraPath = yamlPath;
  } else {
    return false;
  }

  try {
    const fileContents = fs.readFileSync(antoraPath, 'utf8');
    const antoraConfig = yaml.load(fileContents);
    return antoraConfig.prerelease === true;
  } catch (error) {
    console.error(`Error reading ${path.basename(antoraPath)}:`, error.message);
    return false;
  }
}

module.exports = {
  loadAntoraConfig,
  getAntoraValue,
  setAntoraValue,
  getPrereleaseFromAntora
};
