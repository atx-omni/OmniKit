import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageLock = JSON.parse(readFileSync(join(projectRoot, 'package-lock.json'), 'utf8'));
const manifestPath = join(projectRoot, 'data', 'migration-engine', 'manifest.json');
const outputPath = join(projectRoot, 'artifacts', 'security', 'omnikit-sbom.cdx.json');

if (!existsSync(manifestPath)) {
  throw new Error('The migration-engine manifest is missing. Run npm run setup:migration-engine:test before SBOM generation.');
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const components = [];

for (const [path, metadata] of Object.entries(packageLock.packages || {})) {
  if (!path || !metadata?.version) continue;
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  components.push({
    type: 'library',
    'bom-ref': `pkg:npm/${encodeURIComponent(name)}@${metadata.version}`,
    name,
    version: String(metadata.version),
    purl: `pkg:npm/${encodeURIComponent(name)}@${metadata.version}`,
    licenses: metadata.license ? [{ license: { name: String(metadata.license) } }] : undefined,
  });
}
for (const dependency of manifest.dependencies || []) {
  const name = String(dependency.name || 'unknown');
  const version = String(dependency.version || 'unknown');
  components.push({
    type: 'library',
    'bom-ref': `pkg:pypi/${encodeURIComponent(name)}@${version}`,
    name,
    version,
    purl: `pkg:pypi/${encodeURIComponent(name)}@${version}`,
    licenses: dependency.license ? [{ license: { name: String(dependency.license) } }] : undefined,
  });
}
components.sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']));

const serialSeed = createHash('sha256')
  .update(JSON.stringify(components.map((item) => item['bom-ref'])))
  .digest('hex');
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${serialSeed.slice(0, 8)}-${serialSeed.slice(8, 12)}-4${serialSeed.slice(13, 16)}-8${serialSeed.slice(17, 20)}-${serialSeed.slice(20, 32)}`,
  version: 1,
  metadata: {
    component: {
      type: 'application',
      name: packageLock.name || 'omnikit',
      version: packageLock.version || '0.0.0',
    },
  },
  components,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`Generated CycloneDX SBOM with ${components.length} components at ${outputPath}.`);
