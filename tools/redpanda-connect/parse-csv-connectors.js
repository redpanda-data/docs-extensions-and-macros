const fs = require('fs');
const path = require('path');
const os = require('os');
const Papa = require('papaparse');
const fetchFromGithub = require('../fetch-from-github.js');

const CSV_PATH = 'internal/plugins/info.csv';
const GITHUB = { owner: 'redpanda-data', repo: 'connect', remotePath: CSV_PATH };

async function parseCSVConnectors(localCsvPath, logger) {
  logger = logger || console;
  let csvText;

  try {
    if (localCsvPath && fs.existsSync(localCsvPath) && path.extname(localCsvPath) === '.csv') {
      logger.info(`📄 Loading CSV from local file: ${localCsvPath}`);
      csvText = fs.readFileSync(localCsvPath, 'utf8');
    } else {
      const tmpDir = path.join(os.tmpdir(), 'redpanda-connect-csv');
      await fetchFromGithub(GITHUB.owner, GITHUB.repo, GITHUB.remotePath, tmpDir);
      const downloaded = path.join(tmpDir, path.basename(GITHUB.remotePath));
      if (!fs.existsSync(downloaded)) {
        throw new Error(`Expected CSV at ${downloaded} but did not find it`);
      }
      logger.info(`📥 Loaded CSV from GitHub into: ${downloaded}`);
      csvText = fs.readFileSync(downloaded, 'utf8');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    const parsed = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: h => h.trim()
    });

    if (!parsed.meta.fields.includes('name') || !parsed.meta.fields.includes('type')) {
      throw new Error('CSV is missing required headers: name and type');
    }

    const cleaned = parsed.data
      .map(row => {
        const trimmed = Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k.trim(), (v || '').trim()])
        );

        if (!trimmed.name || !trimmed.type) return null;

        return {
          name: trimmed.name,
          type: trimmed.type,
          is_cloud_supported: (trimmed.cloud || '').toLowerCase() === 'y' ? 'y' : 'n'
        };
      })
      .filter(Boolean);

    logger.info(`✅ Parsed ${cleaned.length} connector records.`);
    return cleaned;
  } catch (err) {
    throw new Error(`CSV parsing failed: ${err.message}`);
  }
}

module.exports = parseCSVConnectors;
