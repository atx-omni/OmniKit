import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MigrationScopeReservationError,
  releaseMigrationDestinationModels,
  releaseMigrationDestinationModelsByPrefix,
  reserveMigrationDestinationModels,
} from '../server/services/migrationScopeReservation';

test('destination-model reservations block only the exact competing scope', () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const instance = `destination-${suffix}`;
  const model = `model-${suffix}`;
  const primaryOwner = `safe-copy:${suffix}:primary`;
  const conflictingOwner = `model-job:${suffix}:conflict`;
  const otherInstanceOwner = `model-job:${suffix}:other-instance`;
  const otherModelOwner = `model-job:${suffix}:other-model`;
  const releasePrimary = reserveMigrationDestinationModels(primaryOwner, [{
    destinationInstanceId: instance,
    targetModelId: model,
  }]);
  const releaseOtherInstance = reserveMigrationDestinationModels(otherInstanceOwner, [{
    destinationInstanceId: `${instance}-other`,
    targetModelId: model,
  }]);
  const releaseOtherModel = reserveMigrationDestinationModels(otherModelOwner, [{
    destinationInstanceId: instance,
    targetModelId: `${model}-other`,
  }]);

  try {
    assert.throws(
      () => reserveMigrationDestinationModels(conflictingOwner, [{
        destinationInstanceId: instance,
        targetModelId: model,
      }]),
      (error: unknown) => (
        error instanceof MigrationScopeReservationError
        && error.code === 'MIGRATION_DESTINATION_MODEL_BUSY'
        && error.statusCode === 409
      ),
    );

    releaseMigrationDestinationModels('unrelated-owner');
    assert.throws(
      () => reserveMigrationDestinationModels(conflictingOwner, [{
        destinationInstanceId: instance,
        targetModelId: model,
      }]),
      MigrationScopeReservationError,
    );

    releasePrimary();
    const releaseAfterPrimary = reserveMigrationDestinationModels(conflictingOwner, [{
      destinationInstanceId: instance,
      targetModelId: model,
    }]);
    releaseAfterPrimary();
  } finally {
    releasePrimary();
    releaseOtherInstance();
    releaseOtherModel();
    releaseMigrationDestinationModels(conflictingOwner);
  }
});

test('prefix release clears only matching safe-copy owners', () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const prefix = `safe-copy:${suffix}:`;
  const firstScope = {
    destinationInstanceId: `destination-${suffix}-one`,
    targetModelId: `model-${suffix}`,
  };
  const secondScope = {
    destinationInstanceId: `destination-${suffix}-two`,
    targetModelId: `model-${suffix}`,
  };
  const unrelatedScope = {
    destinationInstanceId: `destination-${suffix}-three`,
    targetModelId: `model-${suffix}`,
  };
  const releaseFirst = reserveMigrationDestinationModels(`${prefix}attempt-one`, [firstScope]);
  const releaseSecond = reserveMigrationDestinationModels(`${prefix}attempt-two`, [secondScope]);
  const releaseUnrelated = reserveMigrationDestinationModels(`model-job:${suffix}`, [unrelatedScope]);

  try {
    releaseMigrationDestinationModelsByPrefix(prefix);
    const releaseFirstReplacement = reserveMigrationDestinationModels(`replacement:${suffix}:one`, [firstScope]);
    const releaseSecondReplacement = reserveMigrationDestinationModels(`replacement:${suffix}:two`, [secondScope]);
    assert.throws(
      () => reserveMigrationDestinationModels(`replacement:${suffix}:three`, [unrelatedScope]),
      MigrationScopeReservationError,
    );
    releaseFirstReplacement();
    releaseSecondReplacement();
  } finally {
    releaseFirst();
    releaseSecond();
    releaseUnrelated();
    releaseMigrationDestinationModelsByPrefix(`replacement:${suffix}:`);
  }
});
