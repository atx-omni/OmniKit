import process from 'node:process';

import { probeOmniApiCapabilities } from '../server/services/omniApiCapabilities';
import {
  OMNI_API_WRITE_CANARY_CONFIRMATION,
  runOmniApiLabelCanary,
} from '../server/services/omniApiCanary';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  const baseUrl = requiredEnvironment('OMNIKIT_CANARY_BASE_URL');
  const apiKey = requiredEnvironment('OMNIKIT_CANARY_API_KEY');
  const report = await probeOmniApiCapabilities({
    baseUrl,
    apiKey,
    modelId: process.env.OMNIKIT_CANARY_MODEL_ID,
    documentId: process.env.OMNIKIT_CANARY_DOCUMENT_ID,
  });

  console.log(JSON.stringify({
    mode: 'read_only',
    checkedAt: report.checkedAt,
    host: report.host,
    overall: report.overall,
    summary: report.summary,
    probes: report.probes.map(({ id, required, contractStatus, status, httpStatus }) => ({
      id,
      required,
      contractStatus,
      status,
      httpStatus,
    })),
  }, null, 2));

  if (['authentication_failed', 'incompatible'].includes(report.overall)) process.exitCode = 1;
  if (report.overall === 'degraded') process.exitCode = 2;

  if (!process.argv.includes('--allow-writes')) return;

  const result = await runOmniApiLabelCanary({
    baseUrl,
    apiKey,
    documentId: requiredEnvironment('OMNIKIT_CANARY_DOCUMENT_ID'),
    label: requiredEnvironment('OMNIKIT_CANARY_LABEL'),
    confirmation: process.env.OMNIKIT_CANARY_CONFIRM || '',
    labelWasAbsent: process.env.OMNIKIT_CANARY_LABEL_WAS_ABSENT === 'YES',
  });
  console.log(JSON.stringify({ mode: 'controlled_write', ...result }, null, 2));
  if (!result.attached || !result.cleaned) process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Canary failed.';
  console.error(`Omni API canary failed: ${message}`);
  console.error(`Controlled writes require ${OMNI_API_WRITE_CANARY_CONFIRMATION} and a dedicated sentinel document.`);
  process.exitCode = 1;
});
