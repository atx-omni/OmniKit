import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = packageJson.scripts ?? {};
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'security.yml'), 'utf8');

const requiredFleetAdminContracts = [
  'tests/admin-collection-contract.test.ts',
  'tests/admin-readiness-frontend-contract.test.ts',
  'tests/admin-readiness.test.ts',
  'tests/content-health-contract.test.ts',
  'tests/generate-embed-url.test.ts',
  'tests/identity-read-contract.test.ts',
  'tests/omni-deep-links.test.ts',
  'tests/portfolio-overview-frontend-contract.test.ts',
  'tests/ui-progressive-disclosure.test.tsx',
];

const requiredNewBrowserSuites = [
  'tests/browser/admin-readiness.spec.ts',
  'tests/browser/admin-workspaces.spec.ts',
  'tests/browser/ui-experience-hardening.spec.ts',
];

const requiredReleaseBrowserSuites = [
  'tests/browser/portfolio-overview.spec.ts',
  'tests/browser/app-routing.spec.ts',
  ...requiredNewBrowserSuites,
  'tests/browser/bi-migration-studio.spec.ts',
  'tests/browser/bi-migration-studio-accessibility.spec.ts',
];

const expectedFleetAdminScripts = [
  'test:admin-collection-contract',
  'test:admin-readiness',
  'test:admin-readiness:frontend',
  'test:content-health-contract',
  'test:generate-embed-url',
  'test:identity-read-contract',
  'test:omni-deep-links',
  'test:portfolio-overview:frontend',
  'test:ui-progressive-disclosure',
];

const expectedReleaseBrowserScripts = [
  'test:browser:portfolio-overview',
  'test:browser:routing',
  'test:browser:admin-readiness',
  'test:browser:admin-workspaces',
  'test:browser:ui-hardening',
  'test:browser:migration-studio',
  'test:accessibility:migration-studio',
];

function packageScriptDependencies(command) {
  return [...command.matchAll(/\bnpm\s+run\s+([a-zA-Z0-9:._-]+)/g)].map((match) => match[1]);
}

function reachableScripts(entry) {
  const reachable = new Set();
  const visit = (name) => {
    if (reachable.has(name)) return;
    reachable.add(name);
    for (const dependency of packageScriptDependencies(scripts[name] ?? '')) visit(dependency);
  };
  visit(entry);
  return reachable;
}

function referencedFiles(scriptNames) {
  const files = new Set();
  const filePattern = /\b(?:tests|scripts|server|src|packages|config|contracts)\/[a-zA-Z0-9_./-]+\.(?:ts|tsx|mjs|js|py|json)\b/g;
  for (const name of scriptNames) {
    for (const match of (scripts[name] ?? '').matchAll(filePattern)) files.add(match[0]);
  }
  return files;
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolute) : [absolute];
  });
}

test('package script references resolve and the command graph has no cycles', () => {
  const missingScripts = [];
  for (const [name, command] of Object.entries(scripts)) {
    for (const dependency of packageScriptDependencies(command)) {
      if (!(dependency in scripts)) missingScripts.push(`${name} -> ${dependency}`);
    }
  }
  assert.deepEqual(missingScripts, []);

  const visiting = new Set();
  const visited = new Set();
  const visit = (name, ancestry = []) => {
    if (visiting.has(name)) {
      assert.fail(`Package script cycle: ${[...ancestry, name].join(' -> ')}`);
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of packageScriptDependencies(scripts[name])) visit(dependency, [...ancestry, name]);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of Object.keys(scripts)) visit(name);

  const missingFiles = [...referencedFiles(Object.keys(scripts))]
    .filter((file) => !existsSync(path.join(root, file)));
  assert.deepEqual(missingFiles, []);
});

test('Fleet and Administration contract gate reaches every required focused file', () => {
  assert.deepEqual(
    packageScriptDependencies(scripts['test:fleet-admin:contracts']),
    expectedFleetAdminScripts,
  );
  const files = referencedFiles(reachableScripts('test:fleet-admin:contracts'));
  assert.deepEqual(requiredFleetAdminContracts.filter((file) => !files.has(file)), []);
  assert.equal(
    scripts['test:admin-readiness:frontend'],
    'tsx --tsconfig tsconfig.app.json --test tests/admin-readiness-frontend-contract.test.ts',
    'The frontend readiness contract must use the application path mapping.',
  );
  assert.equal(
    scripts['test:portfolio-overview:frontend'],
    'tsx --tsconfig tsconfig.app.json --test tests/portfolio-overview-frontend-contract.test.ts',
    'The frontend portfolio contract must use the application path mapping.',
  );
  assert.equal(
    scripts['test:ui-progressive-disclosure'],
    'tsx --tsconfig tsconfig.app.json --test tests/ui-progressive-disclosure.test.tsx',
    'The TSX component suite must use the application JSX runtime configuration.',
  );
});

test('browser release gate is deterministic and preserves all existing and new suites', () => {
  assert.deepEqual(
    packageScriptDependencies(scripts['test:browser:release']),
    expectedReleaseBrowserScripts,
  );
  const files = referencedFiles(reachableScripts('test:browser:release'));
  assert.deepEqual(requiredReleaseBrowserSuites.filter((file) => !files.has(file)), []);
  for (const scriptName of expectedReleaseBrowserScripts) {
    assert.match(scripts[scriptName], /--project=chromium\b/);
    assert.doesNotMatch(scripts[scriptName], /--headed\b/);
  }
});

test('canonical security gate reaches every repository JavaScript and TypeScript test', () => {
  const reachable = reachableScripts('security:check');
  assert.ok(reachable.has('test:fleet-admin:contracts'));
  assert.ok(reachable.has('test:browser:release'));
  assert.ok(reachable.has('test:migration-engine:python'));
  assert.equal(
    scripts['test:migration-engine:python'],
    'node scripts/run-internal-migration-engine-tests.mjs',
    'The canonical Python gate must run the complete pytest suite without a path filter.',
  );

  const files = referencedFiles(reachable);
  const releaseGuard = path.join(root, 'tests', 'release-gate-coverage.test.mjs');
  const discoveredTests = listFiles(path.join(root, 'tests'))
    .filter((file) => /\.(?:test|spec)\.(?:ts|tsx|mjs)$/.test(file))
    .filter((file) => file !== releaseGuard)
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .sort();
  assert.deepEqual(discoveredTests.filter((file) => !files.has(file)), []);
});

test('CI invokes the structural guard and the single canonical release gate', () => {
  const runCommands = [...workflow.matchAll(/^\s*run:\s*(.+?)\s*$/gm)].map((match) => match[1]);
  assert.equal(runCommands.filter((command) => command === 'npm run test:release-gate-coverage').length, 1);
  assert.equal(runCommands.filter((command) => command === 'npm run security:check').length, 1);

  const handPickedTestCommands = runCommands.filter(
    (command) => /^npm run test:/.test(command) && command !== 'npm run test:release-gate-coverage',
  );
  assert.deepEqual(handPickedTestCommands, []);
});
