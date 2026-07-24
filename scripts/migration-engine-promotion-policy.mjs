import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const MIGRATION_ENGINE_PROMOTION_POLICY_SCHEMA_VERSION = 'omnikit.migration-engine-promotion-policy.v1';
export const MIGRATION_ENGINE_POLICY_SOURCES = ['looker', 'powerbi', 'tableau', 'metabase', 'sigma'];

function policyError(message) {
  throw new Error(`Migration-engine promotion policy is invalid: ${message}`);
}

export function validateMigrationEnginePromotionPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
    || policy.schemaVersion !== MIGRATION_ENGINE_PROMOTION_POLICY_SCHEMA_VERSION
    || !policy.sources || typeof policy.sources !== 'object' || Array.isArray(policy.sources)) {
    policyError('schemaVersion or sources is missing.');
  }
  const normalizedSources = {};
  for (const source of MIGRATION_ENGINE_POLICY_SOURCES) {
    const requirement = policy.sources[source];
    if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) {
      policyError(`${source} requirements are missing.`);
    }
    const scores = ['semantic', 'dashboards', 'stableIdentity', 'overall'];
    for (const score of scores) {
      if (!Number.isFinite(requirement[score]) || requirement[score] < 0 || requirement[score] > 100) {
        policyError(`${source}.${score} must be between 0 and 100.`);
      }
    }
    if (!Number.isInteger(requirement.observations) || requirement.observations < 1 || requirement.observations > 10_000) {
      policyError(`${source}.observations must be a positive integer.`);
    }
    if (!Array.isArray(requirement.requiredAcceptanceModes)
      || requirement.requiredAcceptanceModes.length < 1
      || requirement.requiredAcceptanceModes.some((mode) => !['manual', 'api'].includes(mode))
      || new Set(requirement.requiredAcceptanceModes).size !== requirement.requiredAcceptanceModes.length) {
      policyError(`${source}.requiredAcceptanceModes must contain unique manual or api modes.`);
    }
    normalizedSources[source] = {
      semantic: Number(requirement.semantic),
      dashboards: Number(requirement.dashboards),
      stableIdentity: Number(requirement.stableIdentity),
      overall: Number(requirement.overall),
      observations: Number(requirement.observations),
      requiredAcceptanceModes: [...requirement.requiredAcceptanceModes],
    };
  }
  const unexpectedSources = Object.keys(policy.sources).filter((source) => !MIGRATION_ENGINE_POLICY_SOURCES.includes(source));
  if (unexpectedSources.length > 0) policyError(`unexpected sources: ${unexpectedSources.join(', ')}.`);
  return { schemaVersion: MIGRATION_ENGINE_PROMOTION_POLICY_SCHEMA_VERSION, sources: normalizedSources };
}

export function loadMigrationEnginePromotionPolicy(path = process.env.OMNIKIT_MIGRATION_ENGINE_PROMOTION_POLICY_PATH
  || resolve(process.cwd(), 'config/migration-engine-promotion-policy.json')) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    policyError(`cannot read ${resolve(path)}: ${error instanceof Error ? error.message : error}`);
  }
  return validateMigrationEnginePromotionPolicy(parsed);
}
