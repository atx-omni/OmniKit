import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveManagedPython } from './migration-engine-python.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = resolveManagedPython(projectRoot);
const operations = JSON.parse(readFileSync(join(projectRoot, 'config', 'migration-engine-operations.json'), 'utf8'));
const thresholds = operations.benchmark;
const sources = ['looker', 'powerbi', 'tableau', 'metabase', 'sigma'];
const strict = process.argv.includes('--strict');

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

const iterations = Math.max(1, Math.min(20, Number(option('iterations', thresholds.defaultIterations))));
const outputPath = resolve(option('output', join(projectRoot, 'artifacts', 'release', 'migration-engine-benchmark.json')));
const sampleScript = [
  'import json, resource, sys, time',
  'from omni_migrator.conformance import run_conformance',
  'started=time.perf_counter()',
  'result=run_conformance(sys.argv[1])',
  'rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss',
  'rss_mb=rss/(1024*1024) if sys.platform == "darwin" else rss/1024',
  'print(json.dumps({"passed": result["passed"], "duration_ms": (time.perf_counter()-started)*1000, "peak_rss_mb": rss_mb}))',
].join('\n');

const samples = [];
let timeouts = 0;
let failures = 0;
for (const source of sources) {
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    try {
      const result = JSON.parse(execFileSync(python, ['-c', sampleScript, source], {
        cwd: join(projectRoot, 'packages', 'omnikit-migration-engine'),
        encoding: 'utf8',
        timeout: Number(thresholds.timeoutMsPerRun),
        env: {
          ...process.env,
          PYTHONPATH: join(projectRoot, 'packages', 'omnikit-migration-engine', 'src'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
      if (!result.passed) failures += 1;
      samples.push({ source, iteration, ...result });
    } catch (error) {
      const timedOut = error?.code === 'ETIMEDOUT';
      if (timedOut) timeouts += 1;
      else failures += 1;
      samples.push({ source, iteration, passed: false, timedOut, duration_ms: Number(thresholds.timeoutMsPerRun), peak_rss_mb: null });
    }
  }
}

const successful = samples.filter((sample) => sample.passed);
const durations = successful.map((sample) => Number(sample.duration_ms)).sort((left, right) => left - right);
const percentile = (values, percentileValue) => values.length
  ? values[Math.min(values.length - 1, Math.ceil(values.length * percentileValue) - 1)]
  : null;
const totalDurationMs = samples.reduce((sum, sample) => sum + Number(sample.duration_ms || 0), 0);
const summary = {
  runs: samples.length,
  successes: successful.length,
  failures,
  timeouts,
  successRate: samples.length ? successful.length / samples.length : 0,
  throughputRunsPerSecond: totalDurationMs > 0 ? samples.length / (totalDurationMs / 1000) : 0,
  p50LatencyMs: percentile(durations, 0.5),
  p95LatencyMs: percentile(durations, 0.95),
  peakRssMb: Math.max(0, ...successful.map((sample) => Number(sample.peak_rss_mb || 0))),
  configuredQueueDepth: Number(process.env.OMNIKIT_MIGRATION_ENGINE_MAX_QUEUE || 8),
};
const thresholdResults = {
  successRate: summary.successRate >= thresholds.minimumSuccessRate,
  p95Latency: summary.p95LatencyMs !== null && summary.p95LatencyMs <= thresholds.maximumP95LatencyMs,
  peakRss: summary.peakRssMb <= thresholds.maximumPeakRssMb,
  noTimeouts: summary.timeouts === 0,
};
const report = {
  schemaVersion: 'omnikit.migration-engine-benchmark.v1',
  generatedAt: new Date().toISOString(),
  fixtureClass: 'credential-free deterministic source conformance',
  iterationsPerSource: iterations,
  thresholds,
  summary,
  thresholdResults,
  passed: Object.values(thresholdResults).every(Boolean),
  samples,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (strict && !report.passed) process.exitCode = 1;
