# BI Migration Studio Release Checklist

## Code and Security

- [ ] Exact release SHA passes required GitHub checks.
- [ ] Node and Python dependency audits pass.
- [ ] Internal engine, bridge E2E, browser, type, lint, and build gates pass.
- [ ] The entry, route, JavaScript, stylesheet, and total bundle budgets pass.
- [ ] The release-scope manifest binds every included file to the exact clean SHA.
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
- [ ] Repository-policy evidence is current and bound to the exact release SHA.

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

### Professional Looker V2

- [ ] Release truth is **Preview** and runtime truth is `shadow` unless a measured
      promotion record explicitly permits primary use.
- [ ] Manual LookML and Saved API fixtures produce equivalent canonical semantic
      identities, dashboard query intent, and filter-listener bindings.
- [ ] Separate finalized v3 Manual LookML and Saved API acceptance records exist
      for the same clean commit, installed runtime, parser, and rulebook.
- [ ] Every accepted or deferred permission/schedule gap has an owner, rationale,
      and due date inside its review window.
- [ ] Canonical IR V2 and `looker-internal-v2` rulebook conformance pass.
- [ ] Every selected dashboard tile has one recorded outcome.
- [ ] Every dynamic field and filter-listener binding, including exclusions, is
      typed and accounted for.
- [ ] Hidden calculation dependencies are retained without becoming visible fields.
- [ ] Every required target query executes successfully on the reviewed branch.
- [ ] Representative non-sensitive source/target samples reconcile within the
      approved tolerance.
- [ ] Permissions and schedules remain marked unsupported and have named manual
      reconciliation owners.
- [ ] No unsupported behavior was silently omitted or promoted from a warning.
- [ ] `docs/migrations/looker-to-omni.md` matches the shipping contract and support
      matrix.
- [ ] The source-specific Looker rollback command and native fallback were tested.

## Operations

- [ ] Clean-room install succeeds without the retired migrator repository.
- [ ] Encrypted backup checksum and mode verification pass without replacing the
      active vault.
- [ ] Isolated human restore validation is recorded outside source control.
- [ ] Source-specific rollback is tested against the installed runtime and source
      content hashes.
- [ ] Diagnostic report is clean.
- [ ] Performance qualification satisfies approved thresholds.
- [ ] Operational qualification binds all available evidence to the release scope.

## Decision

Release SHA:

Release version:

Release owner:

Decision: GO / CONDITIONAL GO / NO-GO

External gates:

Residual risks:
