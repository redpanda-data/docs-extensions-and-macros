'use strict';

/**
 * Strict parser and formatter for the `redpanda.iceberg.mode` topic property.
 *
 * This is a port of Redpanda's own parser, so a string this module accepts is
 * one the broker accepts, and a string it rejects fails with the broker's own
 * error message. The upstream code lives in streaming-enterprise (private):
 *
 * - `parse_iceberg_mode`, `parse_extended_iceberg_mode`, `parse_section_opts`,
 *   `parse_legacy_schema_latest` and `iceberg_mode::format_to` in
 *   src/v/model/model.cc
 * - `value_config::is_legacy_compatible` in src/v/model/metadata.h
 * - the accept, reject, error-message and format cases in
 *   src/v/model/tests/iceberg_mode_test.cc, which the tests replay from
 *   __tests__/fixtures/iceberg-mode/upstream-vectors.js
 *
 * Two grammars exist:
 *
 * - Legacy names, the only form before v26.2.1 and still accepted after it: `disabled`, `key_value`,
 *   `value_schema_id_prefix`, and `value_schema_latest` with optional
 *   `:subject=<s>,protobuf_name=<p>` options.
 * - The section format, first released in v26.2.1:
 *   `<section>(;<section>)*` where a section is `key:`, `value:` or `headers:`
 *   followed by comma-separated `name=value` options. Releases before 26.2
 *   reject it.
 *
 * The grammar is identical from v26.2.1 to dev. Where upstream iterates a hash
 * map (so which of several bad options it reports is unspecified), this port
 * reports the first one in source order.
 */

const SCHEMA_MODES = ['binary', 'schema_id_prefix', 'schema_latest', 'string'];
const HEADER_VALUE_TYPES = ['binary', 'string'];
const VALUE_LAYOUTS = ['flat', 'nested'];
const LEGACY_SCHEMA_LATEST = 'value_schema_latest';

// The first release series whose parser accepts the section format. The
// first release with it is v26.2.1 (v26.2.0-dev is a branch-point tag, not a
// release).
const SECTION_FORMAT_SINCE = { major: 26, minor: 2 };
const SECTION_FORMAT_FIRST_RELEASE = 'v26.2.1';

function defaultEnabled () {
  return {
    disabled: false,
    key: { mode: 'binary', subject: '', protobuf_name: '' },
    value: { mode: 'binary', subject: '', protobuf_name: '', layout: 'flat' },
    headers: { value_type: 'binary' },
  };
}

function disabledMode () {
  return { disabled: true };
}

function fail (error, reason) {
  return reason ? { ok: false, error, reason } : { ok: false, error };
}

function ok (mode, format) {
  return { ok: true, mode, format };
}

/**
 * Port of `parse_section_opts`: "opt1=val1,opt2=val2" into an ordered map.
 * Duplicate keys, empty keys and empty values are errors. An empty string is
 * an empty map (all defaults).
 * @returns {{opts: Map<string,string>}|{reason: string}}
 */
function parseOpts (str) {
  const opts = new Map();
  if (str === '') return { opts };
  for (const pair of str.split(',')) {
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? '' : pair.slice(eq + 1);
    if (opts.has(k)) return { reason: `duplicate option '${k}'` };
    opts.set(k, v);
    if (k === '') return { reason: `option '${pair}' has no name` };
    if (v === '') return { reason: `option '${k}' has no value` };
  }
  return { opts };
}

/** Port of `parse_extended_iceberg_mode`. */
function parseSections (str) {
  const sections = {};
  for (const sec of str.split(';')) {
    if (sec === '') return fail('empty section in iceberg_mode config');
    const colon = sec.indexOf(':');
    if (colon < 0) return fail(`missing ':' in section '${sec}'`);
    const name = sec.slice(0, colon);
    const parsed = parseOpts(sec.slice(colon + 1));
    if (!parsed.opts) return fail(`malformed options in section '${name}'`, parsed.reason);
    if (name === 'key' || name === 'value' || name === 'headers') {
      if (sections[name]) return fail(`duplicate section '${name}'`);
      sections[name] = parsed.opts;
    } else {
      return fail(`unknown section '${name}'`);
    }
  }

  const result = defaultEnabled();

  const schemaOpts = (opts, cfg, name) => {
    for (const [k, v] of opts) {
      if (k === 'mode') {
        if (!SCHEMA_MODES.includes(v)) return `unknown mode '${v}' in section '${name}'`;
        cfg.mode = v;
      } else if (k === 'subject') {
        cfg.subject = v;
      } else if (k === 'protobuf_name') {
        cfg.protobuf_name = v;
      } else if (k === 'layout') {
        if (!('layout' in cfg)) return `layout is only valid in the value section, not '${name}'`;
        if (!VALUE_LAYOUTS.includes(v)) return `unknown layout '${v}' in section '${name}'`;
        cfg.layout = v;
      } else {
        return `unknown option '${k}' in section '${name}'`;
      }
    }
    if (cfg.mode !== 'schema_latest' && (cfg.subject || cfg.protobuf_name)) {
      return `subject and protobuf_name require mode=schema_latest in section '${name}'`;
    }
    if ('layout' in cfg && cfg.layout === 'nested' &&
        cfg.mode !== 'schema_id_prefix' && cfg.mode !== 'schema_latest') {
      return `layout=nested requires a schema mode (schema_id_prefix or schema_latest) in section '${name}'`;
    }
    return null;
  };

  // Upstream checks key, then value, then headers, whatever the source order.
  if (sections.key) {
    const err = schemaOpts(sections.key, result.key, 'key');
    if (err) return fail(err);
  }
  if (sections.value) {
    const err = schemaOpts(sections.value, result.value, 'value');
    if (err) return fail(err);
  }
  if (sections.headers) {
    for (const [k, v] of sections.headers) {
      if (k !== 'value_type') return fail(`unknown option '${k}' in section 'headers'`);
      if (!HEADER_VALUE_TYPES.includes(v)) return fail(`unknown value_type '${v}' in section 'headers'`);
      result.headers.value_type = v;
    }
  }
  return ok(result, 'sections');
}

/** Port of `parse_legacy_schema_latest` (the text after "value_schema_latest"). */
function parseLegacySchemaLatest (suffix) {
  const result = defaultEnabled();
  result.value.mode = 'schema_latest';
  if (suffix === '') return ok(result, 'legacy');
  if (!suffix.startsWith(':')) {
    return fail(`expected ':' or end of string after '${LEGACY_SCHEMA_LATEST}'`);
  }
  const rest = suffix.slice(1);
  if (rest === '') return fail(`expected options after ':' in ${LEGACY_SCHEMA_LATEST}`);
  const parsed = parseOpts(rest);
  if (!parsed.opts) return fail(`malformed options in ${LEGACY_SCHEMA_LATEST}`, parsed.reason);
  for (const [k, v] of parsed.opts) {
    if (k === 'protobuf_name') result.value.protobuf_name = v;
    else if (k === 'subject') result.value.subject = v;
    else return fail(`unknown option '${k}' in ${LEGACY_SCHEMA_LATEST}`);
  }
  return ok(result, 'legacy');
}

/**
 * Port of `parse_iceberg_mode`, the latest grammar (v26.2.1 and later).
 * @param {string} str
 * @returns {{ok: true, mode: object, format: 'disabled'|'legacy'|'sections'}
 *   | {ok: false, error: string, reason?: string}}
 *   `error` is Redpanda's message, verbatim. `reason` narrows it where
 *   upstream's message is generic (for example, which option was malformed).
 */
function parseIcebergMode (str) {
  if (str === 'disabled') return ok(disabledMode(), 'disabled');
  if (str === 'key_value') return ok(defaultEnabled(), 'legacy');
  if (str === 'value_schema_id_prefix') {
    const m = defaultEnabled();
    m.value.mode = 'schema_id_prefix';
    return ok(m, 'legacy');
  }
  if (str.startsWith(LEGACY_SCHEMA_LATEST)) {
    return parseLegacySchemaLatest(str.slice(LEGACY_SCHEMA_LATEST.length));
  }
  return parseSections(str);
}

/** Port of `value_config::is_legacy_compatible`. */
function isLegacyCompatibleValue (value) {
  return value.layout === 'flat' && value.mode !== 'string';
}

/**
 * Port of `iceberg_mode::format_to`: the canonical string Redpanda stores and
 * reports. A config expressible as a legacy name is written as one; anything
 * else is written in the section format with every section and option.
 * @param {object} mode A `mode` from parseIcebergMode.
 * @returns {string}
 */
function formatIcebergMode (mode) {
  if (mode.disabled) return 'disabled';
  const { key, value, headers } = mode;
  const keyDefault = key.mode === 'binary' && !key.subject && !key.protobuf_name;
  if (keyDefault && headers.value_type === 'binary' && isLegacyCompatibleValue(value)) {
    if (value.mode === 'binary') return 'key_value';
    if (value.mode === 'schema_id_prefix') return 'value_schema_id_prefix';
    if (value.mode === 'schema_latest') {
      const opts = [];
      if (value.protobuf_name) opts.push(`protobuf_name=${value.protobuf_name}`);
      if (value.subject) opts.push(`subject=${value.subject}`);
      return opts.length ? `${LEGACY_SCHEMA_LATEST}:${opts.join(',')}` : LEGACY_SCHEMA_LATEST;
    }
  }
  const schemaSection = (name, cfg) => {
    let s = `${name}:mode=${cfg.mode}`;
    if (cfg.subject) s += `,subject=${cfg.subject}`;
    if (cfg.protobuf_name) s += `,protobuf_name=${cfg.protobuf_name}`;
    return s;
  };
  return [
    schemaSection('key', key),
    `${schemaSection('value', value)},layout=${value.layout}`,
    `headers:value_type=${headers.value_type}`,
  ].join(';');
}

/**
 * Parse a docs component version ("26.2", "v26.1", "26.2.1") into its series.
 * Anything else (unversioned components, "master", "beta") returns null.
 * @param {string} version
 * @returns {{major: number, minor: number}|null}
 */
function releaseSeries (version) {
  const m = /^v?(\d+)\.(\d+)(?:\.\d+)?$/.exec(String(version || '').trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/**
 * Whether pages of this docs version may use the section format. A version
 * that is not a release series (unversioned, "master") documents the latest
 * release, which supports it.
 * @param {string} version
 * @returns {boolean}
 */
function supportsSectionFormat (version) {
  const s = releaseSeries(version);
  if (!s) return true;
  if (s.major !== SECTION_FORMAT_SINCE.major) return s.major > SECTION_FORMAT_SINCE.major;
  return s.minor >= SECTION_FORMAT_SINCE.minor;
}

const LEGACY_FORMS =
  'disabled, key_value, value_schema_id_prefix, or value_schema_latest with optional :subject=<name>,protobuf_name=<name>';

/**
 * Validate a `redpanda.iceberg.mode` value against the grammar of the docs
 * version the page documents.
 * @param {string} str
 * @param {{version?: string}} [options]
 * @returns {{ok: true, mode: object, format: string, canonical: string}
 *   | {ok: false, error: string, reason?: string}}
 */
function validateIcebergMode (str, { version } = {}) {
  const parsed = parseIcebergMode(String(str));
  if (supportsSectionFormat(version)) {
    return parsed.ok ? { ...parsed, canonical: formatIcebergMode(parsed.mode) } : parsed;
  }
  // Before 26.2 only the legacy names exist, with the same rules as today.
  if (parsed.ok && parsed.format !== 'sections') {
    return { ...parsed, canonical: formatIcebergMode(parsed.mode) };
  }
  if (!parsed.ok && String(str).startsWith(LEGACY_SCHEMA_LATEST)) return parsed;
  const v = String(version).trim();
  if (parsed.ok) {
    return fail(
      `the section format (key:, value:, headers:) requires Redpanda ${SECTION_FORMAT_FIRST_RELEASE} or later, ` +
      `and this page documents ${v}. Use one of: ${LEGACY_FORMS}`
    );
  }
  return fail(`not a value Redpanda ${v} accepts. Use one of: ${LEGACY_FORMS}`);
}

module.exports = {
  parseIcebergMode,
  formatIcebergMode,
  validateIcebergMode,
  supportsSectionFormat,
  releaseSeries,
  SECTION_FORMAT_SINCE,
  SECTION_FORMAT_FIRST_RELEASE,
};
