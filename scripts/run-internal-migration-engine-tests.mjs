import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'packages', 'omnikit-migration-engine');

function pythonCandidates() {
  return [
    process.env.OMNIKIT_MIGRATION_ENGINE_PYTHON,
    path.join(root, 'data', 'migration-engine', 'venv', 'bin', 'python'),
    path.join(root, 'data', 'migration-engine', 'venv', 'Scripts', 'python.exe'),
    'python3',
    'python',
  ].filter(Boolean);
}

function selectPython() {
  for (const candidate of pythonCandidates()) {
    if (candidate.includes(path.sep) && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-c', 'import pytest'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    if (probe.status === 0) return candidate;
  }
  throw new Error(
    'No Python runtime with pytest is available. Run npm run setup:migration-engine first.',
  );
}

const python = selectPython();
const result = spawnSync(python, ['-m', 'pytest', '-q', ...process.argv.slice(2)], {
  cwd: packageRoot,
  env: {
    ...process.env,
    PYTHONPATH: path.join(packageRoot, 'src'),
  },
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
