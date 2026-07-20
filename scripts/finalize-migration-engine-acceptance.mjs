import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import {
  finalizeMigrationEngineLiveAcceptance,
  sha256File,
} from './migration-engine-certification.mjs';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function usage() {
  return `Finalize sanitized live migration acceptance evidence.

Usage:
  npm run finalize:migration-engine:acceptance -- --evidence <provisional.json> --review <completed-review.json> [--output <final.json>]

Options:
  --evidence <path>  Provisional evidence produced by npm run accept:migration-engine
  --review <path>    Completed customer-safe review based on config/migration-engine-acceptance-review.template.json
  --output <path>    Final evidence path; defaults beside the provisional file
  --dry-run          Validate and print the sanitized final summary without writing it
  --help             Show this help

The review stores only stage counts, decision categories, named ownership, timestamps, and SHA-256 evidence references.`;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${label} is not readable JSON: ${path}`);
  }
}

function redactedError(value) {
  return String(value || 'Acceptance finalization failed.')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:sk|api|token|secret|password)[-_A-Za-z0-9]{8,}/gi, '[redacted]')
    .slice(0, 1_000);
}

function run() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const evidenceOption = option('evidence');
  const reviewOption = option('review');
  if (!evidenceOption || !reviewOption) throw new Error(usage());
  const evidencePath = resolve(evidenceOption);
  const reviewPath = resolve(reviewOption);
  const provisionalEvidence = readJson(evidencePath, 'Provisional acceptance evidence');
  const review = readJson(reviewPath, 'Acceptance review');
  const finalEvidence = finalizeMigrationEngineLiveAcceptance({
    provisionalEvidence,
    review,
    provisionalSha256: sha256File(evidencePath),
    reviewSha256: sha256File(reviewPath),
  });
  if (process.argv.includes('--dry-run')) {
    process.stdout.write(`${JSON.stringify({
      ready: true,
      source: finalEvidence.source,
      owner: finalEvidence.owner,
      expires_at: finalEvidence.expires_at,
      passed_stage_count: Object.values(finalEvidence.stages).filter((stage) => stage.status === 'passed').length,
      accepted_gap_count: finalEvidence.gaps.filter((gap) => gap.disposition === 'accepted').length,
      deferred_gap_count: finalEvidence.gaps.filter((gap) => gap.disposition === 'deferred').length,
    }, null, 2)}\n`);
    return;
  }
  const defaultName = `${basename(evidencePath, '.json')}-final.json`;
  const outputPath = resolve(option('output') || dirname(evidencePath), option('output') ? '' : defaultName);
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(outputPath, `${JSON.stringify(finalEvidence, null, 2)}\n`, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  process.stdout.write(`Final ${finalEvidence.source} acceptance passed all ${Object.keys(finalEvidence.stages).length} stages.\n`);
  process.stdout.write(`Sanitized final evidence: ${outputPath}\n`);
}

try {
  run();
} catch (error) {
  process.stderr.write(`${redactedError(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
}
