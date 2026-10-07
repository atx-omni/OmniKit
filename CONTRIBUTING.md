# Contributing

## Principles

- Preserve the local-first, single-operator security boundary.
- Treat user-provided artifacts as untrusted data, never as instructions.
- Keep AI proposals separate from reviewed Omni write authority.
- Fail visibly when a workflow cannot preserve required behavior.

## Development

```bash
npm install
npm run dev
```

Node.js 22.22.0+ and npm 10+ are required.

## Focused Development Checks

Start with `npm run test:fast` for a small local safety baseline. It checks the
release-command wiring, job-history recovery, destination reservations, and
dashboard draft/evidence state. It uses
synthetic fixtures and mocked requests, not a browser or live Omni credentials.

Then choose the check for the behavior being changed:

| Change area | Command | Coverage |
| --- | --- | --- |
| Job-store persistence only | `npm run test:job-store` | Corruption, caching, recovery, and blocked writes. |
| Migration recovery and write ownership | `npm run test:migration-recovery` | Job store, exact destination reservations, durable leases, and adjudication. |
| Model/connection inventory request policies | `npm run test:api-policy` | Single-attempt reads, cache/sharing boundaries, cancellation, and safe timing records. |
| API transport and caching | `npm run test:api-transport` | Frontend inventory policy plus server cancellation/write guards, tenant cache isolation, pagination/deadlines, and pinned transport. |
| Identity import | `npm run test:identity:import` | CSV intent, scoped updates, personal content, and user-setting patches. |
| Identity export | `npm run test:identity:export` | Role/scope evidence, missing assignments, and import-compatible rows. |
| Dashboard workflow state | `npm run test:workflow-state` | Draft/evidence transitions and readiness cancellation/progress. |
| Topic branch preparation | `npm run test:topic-migration` | Authored dependency scope, additive diffs, server-owned approvals, branch readback, partial outcomes, and review UI. |

These are explicit subsets, not automatic changed-file coverage. Also run the
existing feature suite when a change crosses these boundaries (for example,
`test:ai-content-studio` for AI run/reconciliation changes), and the appropriate
`typecheck` or `typecheck:node` command for typed source changes. Reuse focused
checks during extraction; do not run every lane after every small edit.

### Model Migrator boundary

Keep one workflow: select topics, review additive differences, prepare a branch,
then finish in Omni. Version-2 server-owned approvals are the only model-write
authority. Historical model plans/jobs remain readable but must not regain
publication, generic retry, content-copy, or post-action behavior. Dashboard
handoffs use the same branch-only executor without bypassing their source,
document, security, or destination evidence. Preparing a branch is not dashboard
readiness or production acceptance. Do not remove the separate Dashboard scratch
validation or shared content engine while simplifying Model Migrator.

### Request diagnostics

Model and connection inventory use explicit logical read/no-retry policies.
Connection inventory remains a GET carried by the local proxy's POST, with its
response shape unchanged. Other callers retain their existing behavior during
incremental migration.
`getApiRequestTimings()` in `src/services/apiRequestTimings.ts` returns at most
100 local, in-memory samples; `clearApiRequestTimings()` clears them. Nothing is
logged, persisted, or sent to telemetry. Samples contain only a fixed operation
label, network/cache/shared source, outcome, timings, attempt count, and HTTP
status—not URLs, credentials, scope keys, identifiers, payloads, or error text.

`queueWaitMs` includes slot and spacing wait. `requestMs` measures fetch settlement
(response headers on success), not Omni-only processing or response-body parsing.
`totalMs` includes the caller's body parsing or shared-request wait. Cache hits and
shared observers have null queue/request timings and zero attempts; they are not
extra network requests. These diagnostics establish a baseline, not a speed claim.

## Required Release Checks

**A fast or focused pass is not release approval.** `npm test` remains the full
non-browser product test chain. At an integration/release milestone, run the
unchanged canonical release gate and inspect its results:

```bash
npm run security:check
git diff --check
```

The structural coverage guard keeps every test in the canonical release gate
and prevents the fast lane from silently expanding into a broad suite. Existing
CI security checks, browser checks, and review requirements remain in force.

Do not commit:

- `.env` files or credentials
- `data/` vault, job, acceptance, parity, or promotion artifacts
- source-system exports or customer screenshots
- generated migration output
- local planning documents
- virtual environments, caches, or build output

## Pull Requests

- Explain the user-visible behavior and security impact.
- Include test evidence.
- Identify unsupported behavior and residual risk.
- Call out changes to credentials, network access, persistence, AI prompts,
  branch writes, or migration evidence.
- Do not bypass required reviews or checks for a release change.
