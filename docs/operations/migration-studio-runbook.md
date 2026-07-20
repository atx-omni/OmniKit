# BI Migration Studio Operations Runbook

## Scope

This runbook covers the supported local, single-operator deployment. Do not use
it as a hosted multi-tenant service runbook.

## Install

```bash
npm ci
npm run setup:migration-engine:test
npm run verify:migration-engine
npm run build
```

## Start

```bash
npm run serve
```

Confirm the server binds to `127.0.0.1`. Unlock the vault from Home and test the
saved Omni instance before beginning migration work.

## Preflight

```bash
npm run diagnose:migration-engine
npm run report:migration-engine
npm run certify:migration-studio -- --skip-full-gate
```

The diagnostic shortcut above always records `fullRepositoryGate: "skipped_by_operator"` and
can never certify a release. For a release candidate, run the full gate and require a
fail-closed result:

```bash
npm run certify:migration-studio -- --require-release-ready \
  --output artifacts/release/migration-studio-certificate.json
```

Treat Preview sources as controlled migrations. Review unsupported features,
permissions, schedules, semantic decisions, generated YAML, branch diffs, and
dashboard reconciliation.

## Backup

Before an upgrade or release:

1. stop OmniKit
2. copy `data/vault.enc` to access-controlled offline storage
3. copy redacted job history only when operational history is required
4. do not commit either file
5. record the application commit and migration-engine manifest hash

The vault passphrase is not recoverable from the repository. Test restore using
a separate local checkout and never paste the passphrase into logs.

## Upgrade

1. retain the backup
2. fetch the approved commit
3. run `npm ci`
4. run `npm run setup:migration-engine:test`
5. run `npm run verify:migration-engine`
6. run the release gate
7. start the app and verify vault unlock and a read-only source inventory

## Rollback

Application rollback:

1. stop OmniKit
2. switch to the previously approved commit
3. run `npm ci`
4. reinstall and verify the tracked migration engine
5. restore the compatible encrypted vault only if its format changed
6. start and perform read-only validation

Source rollout rollback:

```bash
npm run rollback:migration-engine -- --source <source> --by "<owner>" --reason "<reason>"
```

Do not delete native fallback paths during a source promotion.

Before promotion, exercise the same auditable state transition against an
isolated promotion ledger:

```bash
npm run drill:rollback:migration-engine -- --source <source> --by "<owner>"
```

The command writes only engine identity, operator, source, timestamp, and drill
result to ignored `data/migration-engine/rollback-drills.json`. It does not use
customer data, source credentials, Omni credentials, or the live promotion
ledger.

Promotion accepts only finalized v2 live evidence. Run scoped extraction first,
complete `config/migration-engine-acceptance-review.template.json`, and finalize
the review with `npm run finalize:migration-engine:acceptance`. Evidence expires
within 90 days; an expired review, incomplete stage, unreviewed gap, dirty
OmniKit commit, changed engine revision, or rollback drill that is absent from
the ledger keeps the source in shadow mode. The detailed evidence workflow is
documented in `docs/releases/migration-engine-live-acceptance.md`.

## Restore Verification

Restore an encrypted-vault backup only in a separate local checkout first:

1. confirm the backup checksum and file mode
2. point `OMNIKIT_VAULT_PATH` at the restored copy
3. start OmniKit on `127.0.0.1` without running a migration
4. unlock the vault and verify saved-record counts
5. run `npm run diagnose:migration-engine`
6. perform one read-only source inventory and lock the vault
7. record the commit, manifest hash, operator, and result outside source control

Never overwrite the active vault merely to test whether a backup is viable.

## Incident Handling

1. stop the affected migration
2. lock the vault
3. preserve only sanitized logs and exact commit IDs
4. rotate any credential that may have been exposed
5. report vulnerabilities privately through `SECURITY.md`
6. classify whether any Omni write, branch, dashboard, permission, or schedule
   action occurred
7. record recovery and validation evidence

## Data Retention

Raw source uploads and AI responses are transient by default. Do not add them to
issue text, source control, release artifacts, or diagnostics. Sanitized
acceptance, parity, and promotion evidence under `data/migration-engine/` is
operator-local and ignored by Git.
