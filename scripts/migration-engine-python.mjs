import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function managedPythonCandidates(projectRoot) {
  const venvRoot = join(projectRoot, 'data', 'migration-engine', 'venv');
  return [
    join(venvRoot, 'Scripts', 'python.exe'),
    join(venvRoot, 'bin', 'python'),
  ];
}

export function resolveManagedPython(projectRoot, configured = process.env.OMNIKIT_MIGRATION_ENGINE_PYTHON) {
  if (configured) return resolve(configured);
  return managedPythonCandidates(projectRoot).find((candidate) => existsSync(candidate))
    || managedPythonCandidates(projectRoot)[0];
}

export function localVenvPythonCandidates(root) {
  return [
    join(root, '.venv', 'Scripts', 'python.exe'),
    join(root, '.venv', 'bin', 'python'),
  ];
}
