import process from 'node:process';

import { findOmniApiUsages } from './omni-api-contract-scanner';
import {
  findOmniApiContract,
  OMNI_API_CONTRACTS,
  type OmniApiContractStatus,
} from '../server/services/omniApiContracts';

function fail(message: string): never {
  console.error(`Omni API contract verification failed:\n${message}`);
  process.exit(1);
}

function validateRegistry(): void {
  const ids = new Set<string>();
  const operations = new Set<string>();

  for (const contract of OMNI_API_CONTRACTS) {
    if (ids.has(contract.id)) fail(`Duplicate contract id: ${contract.id}`);
    ids.add(contract.id);

    if (contract.status === 'unverified' && !contract.notes?.trim()) {
      fail(`Unverified contract ${contract.id} must explain the verification gap.`);
    }

    for (const method of contract.methods) {
      const operation = `${method.toUpperCase()} ${contract.path}`;
      if (operations.has(operation)) fail(`Duplicate contract operation: ${operation}`);
      operations.add(operation);
    }
  }
}

function main(): void {
  const rootArgumentIndex = process.argv.indexOf('--root');
  const root = rootArgumentIndex >= 0 && process.argv[rootArgumentIndex + 1]
    ? process.argv[rootArgumentIndex + 1]
    : process.cwd();

  validateRegistry();
  const usages = findOmniApiUsages(root);
  const unregistered = usages.filter((usage) => !findOmniApiContract(usage.method, usage.path));
  if (unregistered.length > 0) {
    fail(unregistered
      .map((usage) => `${usage.method} ${usage.path} at ${usage.file}:${usage.line}:${usage.column}`)
      .join('\n'));
  }

  const blocked = usages.filter((usage) => {
    const contract = findOmniApiContract(usage.method, usage.path);
    return contract?.status === 'retired'
      || contract?.status === 'deprecated'
      || contract?.productionPolicy === 'prohibited';
  });
  if (blocked.length > 0) {
    fail(blocked
      .map((usage) => {
        const contract = findOmniApiContract(usage.method, usage.path);
        const status = contract?.productionPolicy === 'prohibited'
          ? 'production-prohibited'
          : contract?.status || 'blocked';
        return `${status} ${usage.method} ${usage.path} at ${usage.file}:${usage.line}:${usage.column}`;
      })
      .join('\n'));
  }

  const counts = new Map<OmniApiContractStatus, number>();
  for (const usage of usages) {
    const status = findOmniApiContract(usage.method, usage.path)?.status;
    if (status) counts.set(status, (counts.get(status) || 0) + 1);
  }

  const uniqueOperations = new Set(usages.map((usage) => `${usage.method} ${usage.path}`));
  const summary = Array.from(counts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');

  console.log(
    `Omni API contract verification passed: ${usages.length} usages, `
    + `${uniqueOperations.size} operations (${summary}).`,
  );
}

main();
