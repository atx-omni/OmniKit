export function evaluateMigrationStudioReleaseReadiness(input) {
  const previewReady = input.fullRepositoryGate === 'passed'
    && input.releaseScope.attested === true
    && input.releaseScope.exactSha === true
    && input.sourceConformance.verified === true
    && input.hygiene.planningDocs === 0
    && input.hygiene.sensitiveFiles === 0
    && input.hygiene.durableEvidence === 0
    && input.governance.configurationValid === true
    && input.governance.requiredFilesPresent === true
    && input.operations.diagnostics?.available === true
    && input.operations.diagnostics?.passed === true
    && input.operations.benchmark?.available === true
    && input.operations.benchmark?.passed === true
    && input.operations.cleanRoom?.available === true
    && input.operations.cleanRoom?.passed === true
    && input.operations.sbom?.available === true
    && input.operations.sbom?.passed === true;
  const releaseReady = previewReady
    && input.governance.externalBlockers.length === 0
    && input.operations.backupVerification?.available === true
    && input.operations.backupVerification?.passed === true
    && input.operations.operationalQualification?.available === true
    && input.operations.operationalQualification?.passed === true
    && input.sourceContractsReleaseReady === true
    && input.engineSourcesReleaseReady === true
    && input.nativeSourcesReleaseReady === true;
  return { previewReady, releaseReady };
}
