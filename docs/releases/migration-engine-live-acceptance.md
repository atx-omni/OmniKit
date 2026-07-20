# Migration Engine Live Acceptance

Live acceptance certifies one source adapter against a real source scope and a
real target Omni instance. Synthetic fixtures, parser counts, and canonical
conformance are regression evidence; they are not live acceptance.

## Evidence Boundary

The acceptance ledger stores only:

- source and acquisition mode
- hashes and counts for input evidence
- installed engine and rulebook identity
- clean OmniKit commit SHA
- named owner, review time, and expiry
- pass/fail counts and SHA-256 references for each stage
- generic partial or unsupported capability categories and their disposition

It does not store credentials, source files, object names, formulas, generated
YAML, dashboard IDs, connection IDs, target instance IDs, query results,
screenshots, or reviewer notes.

## 1. Dry Run

Keep the vault unlocked and validate the local request without sending source
evidence:

```bash
npm run accept:migration-engine -- \
  --source looker \
  --connection-id <saved-source-id> \
  --target-instance-id <saved-target-id> \
  --dashboard-id <source-dashboard-id> \
  --dry-run
```

The command rejects remote control-plane URLs and plaintext credential flags.

## 2. Record Provisional Extraction

Run the same command without `--dry-run`. Manual sources use one or more
`--artifact` paths instead of a saved source connection. The output under
`data/migration-engine/live-acceptance/` has `evidence_status: provisional` and
`outcome: incomplete`.

Do not edit provisional evidence. Record its SHA-256 checksum and place it in a
copy of `config/migration-engine-acceptance-review.template.json`.

## 3. Complete Downstream Review

The named migration owner must complete all seven reviewed stages:

1. Semantic translation: source expressions and relationships reconcile to the
   reviewed Omni semantic package.
2. Branch deployment: the approved package deploys to an isolated development
   branch.
3. Omni validation: compiler and required validation checks pass.
4. Dashboard reconstruction: every in-scope dashboard is built or explicitly
   reported outside scope.
5. Query-result reconciliation: representative source and target queries meet
   the approved tolerance.
6. Permission and schedule gap reporting: unsupported governance and delivery
   behavior is inventoried and assigned an owner.
7. Visual or structural reconciliation: layout, filters, interactions, and
   visual intent meet the approved review standard.

Each stage requires a SHA-256 reference to separately controlled evidence, at
least one checked item, and zero failures. Keep the underlying reports in the
approved customer evidence system, not in the OmniKit repository.

Every gap emitted by provisional evidence must appear in the review with one of
these dispositions:

- `accepted`: the owner accepts the documented limitation for this release.
- `deferred`: remediation is explicitly outside this release and remains
  visible.
- `blocking`: the source cannot pass acceptance.

## 4. Finalize

```bash
npm run finalize:migration-engine:acceptance -- \
  --evidence data/migration-engine/live-acceptance/<provisional>.json \
  --review /path/to/completed-review.json \
  --dry-run

npm run finalize:migration-engine:acceptance -- \
  --evidence data/migration-engine/live-acceptance/<provisional>.json \
  --review /path/to/completed-review.json
```

Finalization fails when the OmniKit worktree was dirty during extraction, a
stage is incomplete, a gap is unreviewed or blocking, the review checksum does
not bind to the provisional file, or expiry exceeds 90 days.

## 5. Verify Rollback and Promote

Run the isolated rollback drill against the installed engine:

```bash
npm run drill:rollback:migration-engine -- \
  --source looker \
  --by "Release Owner" \
  --id "looker-rollback-YYYY-MM"
```

Promotion verifies that exact drill ID in the ignored rollback ledger, including
source, engine version, revision, owner, timestamp, and passing outcome:

```bash
npm run promote:migration-engine -- \
  --source looker \
  --acceptance data/migration-engine/live-acceptance/<final>.json \
  --approved-by "Release Owner" \
  --rollback-drill "looker-rollback-YYYY-MM"
```

Promotion and rollback append audit events. Expired evidence, a changed engine
revision, or rollback returns the source to shadow eligibility.
