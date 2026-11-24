'use strict';

// The cluster scripts pick a quickstart bundle by tag: X.Y tags of 25.1 or
// later use docker-compose/25.1, and everything else (dev, latest, --branch,
// older tags) uses docker-compose/. MinIO images are gone from Docker Hub, so
// no bundle either script can select may still pull one.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const BUNDLES = ['docker-compose', 'docker-compose/25.1'];

function load(rel) {
  return yaml.load(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

describe('quickstart bundles selected by the cluster scripts', () => {
  it.each(['cli-utils/generate-cluster-docs.sh', 'cli-utils/start-cluster.sh'])(
    '%s only selects the bundles under test',
    (script) => {
      const src = fs.readFileSync(path.join(ROOT, script), 'utf8');
      const dirs = [...src.matchAll(/\/docker-compose(\/[0-9.]+)?"/g)].map(
        (m) => `docker-compose${m[1] || ''}`
      );
      expect(dirs.length).toBeGreaterThan(0);
      for (const d of dirs) expect(BUNDLES).toContain(d);
    }
  );

  describe.each(BUNDLES)('%s', (dir) => {
    const compose = load(`${dir}/docker-compose.yml`);
    const bootstrap = load(`${dir}/bootstrap.yml`);

    it('pulls no MinIO image', () => {
      const images = Object.values(compose.services).map((s) => s.image || '');
      expect(images.filter((i) => /(^|\/)minio\//.test(i))).toEqual([]);
    });

    it('runs RustFS for Tiered Storage and creates the bucket', () => {
      expect(compose.services.rustfs.image).toMatch(/^rustfs\/rustfs:/);
      expect(compose.services.minio).toBeUndefined();
      expect(compose.services.createbucket).toBeDefined();
      expect(compose.services['redpanda-0'].depends_on.createbucket.condition).toBe(
        'service_completed_successfully'
      );
    });

    it('points Redpanda at RustFS', () => {
      expect(bootstrap.cloud_storage_api_endpoint).toBe('rustfs');
      expect(bootstrap.cloud_storage_access_key).toBe(
        compose.services.rustfs.environment.RUSTFS_ACCESS_KEY
      );
    });
  });
});
