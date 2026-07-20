# BI Migration Studio Release Checklist

## Code and Security

- [ ] Exact release SHA passes required GitHub checks.
- [ ] Node and Python dependency audits pass.
- [ ] Internal engine, bridge E2E, browser, type, lint, and build gates pass.
- [ ] SBOM, checksums, and sanitized certification report are attached.
- [ ] No planning documents, credentials, customer content, or local evidence
      are tracked or packaged.

## Governance

- [ ] Root repository license is approved and present.
- [ ] Release owner is named.
- [ ] Support and security owners are named.
- [ ] Support response target is approved.
- [ ] Main requires review, checks, and conversation resolution.
- [ ] Secret scanning push protection is enabled.

## Source Release

For every source promoted beyond Preview:

- [ ] current conformance passes
- [ ] provisional live-source extraction is recorded against the release SHA
- [ ] all downstream acceptance stages are finalized with current evidence
- [ ] every partial or unsupported capability has a non-blocking owner disposition
- [ ] final acceptance has a named owner and unexpired review window
- [ ] target branch deployment and Omni validation pass
- [ ] dashboard reconstruction passes
- [ ] query-result reconciliation passes
- [ ] permissions and schedules are reconciled or explicitly excepted
- [ ] visual or structural acceptance is recorded
- [ ] rollback drill is current, passing, and verified from the drill ledger
- [ ] named owner approves promotion

## Operations

- [ ] Clean-room install succeeds without the retired migrator repository.
- [ ] Backup and restore are tested.
- [ ] Rollback is tested.
- [ ] Diagnostic report is clean.
- [ ] Performance qualification satisfies approved thresholds.

## Decision

Release SHA:

Release version:

Release owner:

Decision: GO / CONDITIONAL GO / NO-GO

External gates:

Residual risks:
