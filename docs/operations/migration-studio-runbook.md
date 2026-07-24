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
npm run verify:release-governance
npm run build
npm run verify:bundle-budgets
npm run certify:migration-studio -- --skip-full-gate
```

The diagnostic shortcut above always records `fullRepositoryGate: "skipped_by_operator"` and
can never certify a release. For a release candidate, run the full gate and require a
fail-closed result:

```bash
npm run certify:migration-studio -- --require-clean-release \
  --require-preview-ready \
  --scope artifacts/release/migration-studio-release-scope.json \
  --output artifacts/release/migration-studio-certificate.json
```

Preview readiness requires the exact clean scope, full repository gate, source
contracts, diagnostics, benchmark, clean-room proof, SBOM, and valid governance
structure. GA uses `--require-release-ready` and additionally requires live
acceptance, source rollout/GA state, backup and operational qualification,
approved owners, support target, license, and observed repository controls.

Treat Preview sources as controlled migrations. Review unsupported features,
permissions, schedules, semantic decisions, generated YAML, branch diffs, and
dashboard reconciliation.

## Professional Domo Migration

The native Domo path is Preview. Before a controlled migration:

1. choose **Manual Files** or a vault-backed **Saved API** source
2. for Saved API, prefer OAuth client credentials for Platform API inventory and
   add a server-only Product API developer token only when Deep inventory is needed
3. for Manual Files, upload related Page, Card, dataset schema, Beast Mode,
   DataFlow, relationship, PDP/access, ownership/usage, and schedule/alert exports
   together; one bounded ZIP is supported
4. confirm every selected Page has complete Card, dataset, schema, field, and
   filter closure or an explicit deferred/excluded outcome
5. assign owners to governance, operational, non-SQL Magic ETL, Workbench,
   connector, custom-app, and embed handoffs before Build

Basic Saved API inventory remains valid without Product API access, but it is not
Deep evidence. Stop when a selected Card lacks the export-required bindings needed
for an exact dashboard plan. Do not infer undocumented Domo graph or application
behavior.

Before branch readiness or dashboard construction:

- ensure required Domo dataset, Beast Mode, DataFlow, and relationship decisions
  are approved and represented in the generated package
- validate additive YAML on one isolated development branch
- execute required bounded target queries and reconcile representative data
- account for every selected Page, Card, dependency, PDP/access outcome,
  schedule/alert, and governed handoff
- build one dashboard at a time and retry only failed dashboard work

Before any release-stage change, complete paired sanitized Manual Files and Saved
API evidence outside the repository and run
`npm run verify:domo-acceptance-campaign`. The verifier requires the same source
scope, target environment, release, and parser contract; distinct branches;
complete Page/Card/dependency accounting; zero silent omissions; parity evidence;
named approval; and current rollback proof. Domo remains Preview without it.

The full support matrix is in `docs/migrations/domo-to-omni.md`.

## Professional Looker Migration

The Looker path is Preview and defaults to shadow comparison. Before a controlled
migration:

1. choose **Manual files** or a vault-backed **Saved API** source
2. for Manual files, include the selected model, all required included views, and
   version-controlled dashboard LookML
3. for Saved API, use a read-only Looker API 4.0 credential and select project and
   dashboard IDs explicitly
4. confirm the V2 readiness card reports the intended acquisition contract and
   canonical IR V2
5. review parameters, access filters, Liquid, refinements, table calculations,
   pivots, PDTs, merged results, permissions, and schedules before planning

Both acquisition paths must produce the same semantic identities, dashboard query
intent, filter-listener bindings, and review requirements for equivalent source
evidence. If they do not, stop and retain the native fallback as authoritative.

Before any Looker promotion, verify the paired Manual Files and Saved API
campaign with `npm run verify:looker-acceptance-campaign`. Keep its detailed
inventory, YAML, dashboard-plan, validation, reconciliation, and branch evidence
in the approved external evidence system. OmniKit stores and verifies only
sanitized SHA-256 references, counts, parity scores, approval, and rollback
proof.

Before branch readiness or dashboard construction:

- validate the generated model and run Content Validator on the dev branch
- execute every required bounded target query, including hidden dependencies
- reconcile representative non-sensitive source and target samples
- account for every tile, filter-listener binding, exclusion, and unsupported item
- assign an owner and disposition to every exception
- reconcile permissions and schedules independently because they are unsupported

The full operator contract and support matrix are in
`docs/migrations/looker-to-omni.md`.

## Backup

Before an upgrade or release, create a byte-exact encrypted backup without
opening or replacing the active vault:

```bash
npm run backup:omnikit-state -- --output /path/to/offline/omnikit-vault-backup.enc
npm run verify:omnikit-backup -- \
  --backup /path/to/offline/omnikit-vault-backup.enc \
  --manifest /path/to/offline/omnikit-vault-backup.enc.manifest.json \
  --output artifacts/release/omnikit-backup-verification.json
```

The verification command checks size, SHA-256, source mode, and manifest
binding, then copies the encrypted bytes only to a temporary isolated path. It
does not unlock the backup or overwrite `data/vault.enc`. Store the backup,
manifest, and passphrase separately in approved access-controlled systems.

Copy redacted job history only when operational history is required. Never
commit the backup, manifest, passphrase, vault, or job history.

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

For a Looker regression, use the source-specific command and keep the native
normalized parser available:

```bash
npm run rollback:migration-engine -- --source looker --by "<owner>" --reason "<reason>"
```

Use `shadow` when sanitized comparison evidence is still useful, or `off` when the
deterministic path must not run. A rollback does not reverse already reviewed Omni
branch changes or constructed dashboards; inspect or discard those artifacts
separately before retrying.

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

Promotion accepts only finalized v3 live evidence. Looker requires two separate
records from the same clean OmniKit commit and installed runtime: one for Manual
LookML and one for Saved API acquisition. Run scoped extraction for each path,
complete `config/migration-engine-acceptance-review.template.json` for each
record, and finalize both with `npm run finalize:migration-engine:acceptance`.
Every partial or unsupported gap, including permissions and schedules, requires
an owner, rationale, disposition, and due date within the review window.
Evidence expires within 90 days; an expired review, incomplete stage, unreviewed
gap, dirty OmniKit commit, changed engine revision, missing acquisition mode, or
rollback drill absent from the ledger keeps the source in shadow mode. The
detailed evidence workflow is documented in
`docs/releases/migration-engine-live-acceptance.md`.

## Restore Verification

The automated verifier never writes to the active vault. A human recovery drill
must restore an encrypted-vault backup only in a separate local checkout first:

1. confirm the backup checksum and file mode
2. point `OMNIKIT_VAULT_PATH` at the restored copy
3. start OmniKit on `127.0.0.1` without running a migration
4. unlock the vault and verify saved-record counts
5. run `npm run diagnose:migration-engine`
6. perform one read-only source inventory and lock the vault
7. record the commit, manifest hash, operator, and result outside source control

Never overwrite the active vault merely to test whether a backup is viable.

## Operational Qualification

Before a release candidate, prove first-party ownership and collect the
sanitized operational status:

```bash
npm run verify:migration-studio:clean-room
npm run qualify:migration-studio:operations -- --source looker
```

The qualification report binds diagnostics, strict benchmarks, clean-room
runtime ownership, backup verification, and a source-specific rollback drill to
the release scope. Missing operator-controlled evidence remains pending unless
`--strict` is used; it is never converted into a pass.

## Release Governance

`config/release-governance.json` is the owner-ready decision template. Populate
it only with approved names, response targets, and license decisions. Validate
its shape and required files with:

```bash
npm run verify:release-governance
```

Repository settings require separately captured, sanitized evidence for the
exact release commit. Supply that operator-controlled file only during
certification:

```bash
npm run certify:migration-studio -- \
  --governance-evidence /path/to/repository-governance-evidence.json
```

The evidence contract is `omnikit.repository-governance-evidence.v1` and must
record the GitHub repository, branch, exact commit, observed review count,
required checks, conversation resolution, secret push protection, timestamp,
and verifier. A declaration in source control is not proof of a remote setting.

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
