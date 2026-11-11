const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { setRedpandaTagAttributes } = require('../../cli-utils/antora-utils');

function antora(prerelease) {
  return [
    'name: ROOT',
    'version: 26.3',
    `prerelease: ${prerelease}`,
    'asciidoc:',
    '  attributes:',
    '    full-version: 26.3.1-rc2',
    "    latest-redpanda-tag: 'v26.3.1-rc2'",
    "    redpanda-beta-version: '26.3.1-rc2'",
    "    redpanda-beta-tag: 'v26.3.1-rc2'",
    '',
  ].join('\n');
}

describe('setRedpandaTagAttributes', () => {
  let dir;
  let cwd;

  beforeEach(() => {
    cwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antora-tag-'));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const attrs = () => yaml.load(fs.readFileSync(path.join(dir, 'antora.yml'), 'utf8')).asciidoc.attributes;

  test('on a prerelease branch, an RC tag also updates the beta tag and version', () => {
    fs.writeFileSync(path.join(dir, 'antora.yml'), antora(true));
    expect(setRedpandaTagAttributes('v26.3.1-rc4')).toEqual([
      'latest-redpanda-tag', 'full-version', 'redpanda-beta-tag', 'redpanda-beta-version',
    ]);
    expect(attrs()).toEqual({
      'full-version': '26.3.1-rc4',
      'latest-redpanda-tag': 'v26.3.1-rc4',
      'redpanda-beta-version': '26.3.1-rc4',
      'redpanda-beta-tag': 'v26.3.1-rc4',
    });
  });

  test('on a non-prerelease branch, the beta attributes are left alone', () => {
    fs.writeFileSync(path.join(dir, 'antora.yml'), antora(false));
    expect(setRedpandaTagAttributes('v26.3.1-rc4')).toEqual(['latest-redpanda-tag', 'full-version']);
    expect(attrs()['redpanda-beta-tag']).toBe('v26.3.1-rc2');
  });

  test('a GA tag on a prerelease branch leaves the beta attributes alone', () => {
    fs.writeFileSync(path.join(dir, 'antora.yml'), antora(true));
    expect(setRedpandaTagAttributes('v26.3.1')).toEqual(['latest-redpanda-tag', 'full-version']);
    expect(attrs()['redpanda-beta-tag']).toBe('v26.3.1-rc2');
  });
});
