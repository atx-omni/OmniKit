# OmniKit

OmniKit is a self-contained, local-first Omni admin workspace. The UI and local API proxy run on your own machine, with no hosted OmniKit service, no required environment variables, and no telemetry. Your Omni API key is used only for requests to the Omni instance you provide.

---

## Table of contents

1. [What you can do with it](#what-you-can-do-with-it)
2. [Requirements](#requirements)
3. [Installation](#installation)
4. [First run — setting up your vault](#first-run--setting-up-your-vault)
5. [Feature guide](#feature-guide)
6. [How it works under the hood](#how-it-works-under-the-hood)
7. [Scripts reference](#scripts-reference)
8. [Release & package information](#release--package-information)
9. [Configuration](#configuration)
10. [Troubleshooting](#troubleshooting)
11. [Security & privacy](#security--privacy)
12. [Uninstalling](#uninstalling)
13. [FAQ](#faq)

---

## What you can do with it

- Build first-pass dashboards with Blobby, then finish review and iteration in Omni chat
- Convert Excel workbooks into guarded dashboard drafts and semantic follow-up plans
- Review existing dashboards with AI-assisted readiness checks and admin-friendly recommendations
- Manage saved Omni instance profiles in a native encrypted local vault
- Review a Home workspace snapshot with active dashboard, semantic model, user, group, schedule, folder, and connection counts
- Track multi-instance connection and embed-user metrics with internal/test filters
- Migrate dashboards through one saved-instance copy/import workflow with one or many target instance/connection/model rows
- Bulk copy, move, and delete dashboards across folders
- Download dashboards and build PowerPoint decks from live Omni tiles
- Manage connections, uploads, users, groups, models, topics, labels, schedules, and embeds
- Generate reviewable AI Semantic Studio packages for topics, views, models, and permissions
- Inventory and migrate Domo, Looker, Metabase, MicroStrategy, Power BI, Sigma, Tableau, or WebFOCUS work through BI Migration Studio with a vault-backed AI option, explicit decisions, reviewed Omni deliverables, and validation evidence
- Guide non-technical users with a versioned in-app walkthrough that can be dismissed, replayed, or refreshed after a local app update
- Inspect local history and review exactly what OmniKit stores on the Data Privacy page

---

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 20 or newer | CI validates Node 20. Check with `node --version`. Download at [nodejs.org](https://nodejs.org). |
| npm | 10 or newer (bundled with current Node LTS) | Yarn or pnpm also work. |
| Browser | Any modern Chromium, Firefox, or Safari | |
| Omni instance | Reachable from your machine | You also need a personal API key. |

No Docker, no database, no backend service, no Supabase account — nothing else to install.

---

## Installation

Step-by-step from zero:

1. **Clone the repo.**
   ```bash
   git clone https://github.com/exploreomni/OmniKit.git
   cd OmniKit
   ```
2. **Install dependencies.**
   ```bash
   npm install
   ```
   This takes about a minute the first time.
3. **Start the app.**
   ```bash
   npm run dev
   ```
4. **Open it.** Your browser should open automatically at `http://localhost:5173`. If it doesn't, open that URL yourself.

That's it. You now have OmniKit running on one local port, with the API proxy mounted inside the Vite dev server.

---

## First run — setting up your vault

When you open the app, you land on **Home**. Home is the vault-first starting point for OmniKit:

1. **Create or unlock the local encrypted vault.**
2. **Add a saved Omni instance** with a label, role, base URL, and API key.
3. **Choose the saved instance** you want OmniKit workflows to use.
4. **Review the workspace snapshot** as a read-only sanity check before starting work. The model tile counts active semantic-layer models, not branches or schema foundations.

Your saved instance API keys are encrypted in the native vault and are not returned to the browser as plaintext. The browser keeps only a non-secret vault reference for the active tab session.

If the vault is locked, return to **Home** to unlock it before starting workflows. The sidebar instance switcher shows the selected saved instance and supports switching after the vault is unlocked, but passphrase entry stays on Home.

A red error usually means one of: wrong URL, expired/invalid key, VPN not connected, unsupported host, or your Omni instance blocks requests from localhost. The error message tells you which.

---

## Feature guide

The sidebar groups features by category. Each page is a single workflow with its own wizard or table view.

New users see a click-through walkthrough the first time they open OmniKit. The guide explains how to start from Home, unlock or create the vault, where each workflow lives, how review steps work, and where local data controls live. Users can dismiss it for the current app version, replay it from the sidebar **Guide** button, or reset it from **Data & Privacy**. When the walkthrough content is updated in a future local clone/pull, OmniKit can show it again for that new version.

### Dashboard AI & Delivery

- **AI Dashboard Studio** — build new dashboard drafts, convert Excel formulas/visuals into guarded dashboard drafts plus model follow-up lists, and review existing dashboards.
  - **Build New Dashboard** starts a first-pass dashboard developer chat from a selected model/topic, audience, KPI list, filters, layout, and color guidance. It routes missing or unsafe metrics back to AI Semantic Studio instead of inventing model fields.
  - **Excel to Dashboard** parses `.xlsx` workbooks in page memory, inventories sheets/formulas/charts, drafts safe dashboard tiles from existing Omni fields, and lists formula/lookup work as AI Semantic Studio follow-ups instead of updating topics or views directly.
  - **Review Existing Dashboard** inspects a live Omni dashboard and returns a review checklist for purpose, UX risks, semantic risks, and Omni UI handoff.
- **Dashboard Migrator** — unlock the native vault, choose one source instance and connection, then select dashboards across that connection with their current folder, model, topic, and query-view metadata visible. Keep the selected dashboards together or split them into dashboard groups, assign each group to one or more destination routes, then resolve dependencies before review. Step 4 surfaces missing fields, query views, relationships, topics, and model/topic/query-view YAML diffs as first-class decisions: map, create, ignore, keep target, use source, or accept/edit generated YAML with line-level diffs. OmniKit prepares resolved semantic dependencies before the dashboard move, updates same-named destination dashboards in place through Documents V2 when supported so IDs, slugs, permissions, embeds, favorites, schedules, and history stay attached, and visibly falls back to replacement when in-place updates are unavailable or explicitly selected. It preserves descriptions and labels where Omni supports it, can queue native schema refresh per route, and can move the source dashboard to Trash only after verified success. Accepted YAML decisions are checksum-checked again before run so stale target changes are sent back to Step 4 instead of becoming broken migrations.
- **Model Migrator** — migrate semantic models between saved Omni instances through a branch-only workflow. Choose source/target connections, select shared models, map target models, review fast-path versus translate-pipeline YAML changes, port workbook-only query content, and track model/workbook progress in unified job history without exposing API keys in browser payloads. Dashboard selections are carried in the same scope as explicit Dashboard Migrator handoff items.
- **Dashboard Operations** — bulk move, copy, or delete dashboards across folders with confirmation steps and operation logging.
- **Dashboard Downloads** — export one or more dashboards to local files.
- **Deck Builder** — build repeatable PowerPoint decks from live Omni dashboard tiles.

### Deck Builder

Turn any `.pptx` template into a repeatable Omni-powered deck.

1. Upload a `.pptx` template. OmniKit scans it for named placeholders.
2. Map each placeholder to an Omni dashboard tile.
3. Define filter presets (one deck per preset, or one preset across many slides).
4. Run the batch — tiles are fetched live, rendered, and dropped into place.
5. Download the generated `.pptx` files.

Templates, saved batches, dashboard metadata caches, and filter defaults live in your browser's local storage. They stay across restarts until you clear them from the **Data Privacy** page or clear site data in DevTools.

### Data & AI Readiness

- **Instance Manager** — create a native encrypted local vault, save source/destination Omni instance profiles, test saved credentials, import compatible legacy multi-instance vaults with a dry run, configure default models/folders, define tag-based internal/test filters, refresh schema models natively, and scan connection or embed-user activity metrics across saved instances.
- **Connection Health** — validate Omni connectivity and inspect core account readiness signals.
- **Upload Governance** — review uploaded datasets, ownership, freshness, and governance signals.
- **Model & Topic Health** — validate models and inspect topic coverage.
- **Content Health** — scan dashboard and workbook dependency health.
- **AI Semantic Studio** — review and generate governed Omni-native semantic-layer packages with guided Topic Builder, Model / View Builder, and Permission Builder workflows.
- **BI Migration Studio** — select dashboards from Domo, Looker, Metabase, MicroStrategy, Power BI, Sigma, Tableau, or WebFOCUS and migrate their proven dependency closure into Omni. Operators choose a vault-backed OpenAI, Anthropic, Snowflake Cortex, Databricks Genie, or Omni AI option, resolve typed source-to-target decisions, compile one versioned migration bundle, validate semantic YAML on a dev branch, explicitly confirm branch readiness, and then build each selected dashboard through a retryable Omni AI queue. Genie is limited to validation SQL, reconciliation, and exception explanation; it is not presented as an arbitrary BI-artifact generator. LLMs propose reviewed intent while OmniKit owns compilation, policy, checksums, execution gates, and validation. Model Migrator remains the separate Omni-to-Omni promotion workflow.

### BI Migration Studio workflow and security

1. **Connect** — select the previous BI platform, a saved AI option, and the destination Omni instance. Source, provider, and Omni credentials are encrypted in the native vault and hydrated only by the local server.
2. **Inventory** — load a searchable dashboard catalog with path, owner, usage, freshness, dependency coverage, and explicit collection evidence. Provider-aware bounded pagination follows Power BI OData/offset, Sigma continuation tokens, Tableau page numbers, and Domo/Looker/MicroStrategy offsets while enforcing request, page, parent, child, and item safety limits. Repeated pages and truncated scopes are reported rather than silently accepted; a truncated inventory cannot advance to planning. A six-class matrix discloses semantic-object, dashboard, filter, layout, permission, and schedule fidelity. Partial, export-required, and unsupported classes require acknowledgement. Manual Domo, Looker, MicroStrategy, and Power BI migrations use guided three-step upload wizards before AI analysis. Domo collects dataset schemas, Beast Modes, SQL DataFlows, and Cards. Looker collects a documented LookML project unit: `.model.lkml`, included `.view.lkml`, and `.dashboard.lookml` files. MicroStrategy collects project metadata, report/cube definitions, attributes, metrics, relationships, and dashboard/document definitions containing chapters, pages, visualizations, filters, and prompts. Power BI accepts direct `.pbix`, a PBIP project folder or bounded ZIP, individual project files, `model.bim`, TMDL, split PBIR, legacy report JSON, and optional Workspace Scanner JSON. Direct PBIX, LookML, Tableau packages, Metabase API snapshot JSON, and saved Metabase or Sigma API sources can use the optional managed read-only migration engine for deterministic semantic and dashboard evidence. Scanner metadata adds ownership and governance context but is not required. The vault-gated local backend normalizes this evidence while keeping PDTs, access filters, DAX, Power Query, RLS, prompts, selectors, security filters, derived elements, report limits, hidden fields, custom visuals, and unsupported behavior visible for human review. Bundled synthetic Whataburger-style examples measure deterministic source-evidence recovery against independent Omni-oriented manifests; after AI generation, a second comparison grades semantic files, dimensions, measures, relationships, topic scope, and dashboard tile plans. Neither score replaces YAML validation, branch review, query-result reconciliation, permission validation, or visual review.
3. **Scope** — select one or more dashboards. OmniKit preserves vendor dashboard IDs beside deterministic provenance identities so a selected API dashboard does not expand into a tenant-wide extraction when engine mode changes. It calculates each dashboard's project-scoped dependency closure, shows selected report paths, blocks unassigned Power BI artifacts until the operator associates them, discloses export-required evidence, and lets operators classify included assets as migrate, consolidate, redesign, defer, or retire. Distinct source connections are mapped explicitly to target Omni connections. Ambiguous mappings require confirmation, and routes that cannot share one target model must be split instead of being collapsed silently.
4. **Resolve** — review evidence-backed proposals and explicitly map, create, rewrite, ignore, or defer blocking source-to-target differences.
5. **Build** — validate untouched AI dashboard-plan output before defaults are normalized, require every selected visual exactly once, and require every planned field to trace to source visual evidence or an approved map/create decision. Compile approved decisions, semantic files, source coverage, and dashboard specifications into one deterministic `MigrationBundle` version.
6. **Validate semantic work** — merge reviewed YAML into existing files, then bind that package to a deterministic preparation fingerprint covering source scope, target model, plans, decisions, and exact YAML. OmniKit blocks branch creation when preparation is incomplete or the package is stale, writes current files with checksums to an Omni dev branch, runs structural/content validation, shows the diff, and requires explicit branch-readiness confirmation.
7. **Construct and reconcile dashboards** — run one selected dashboard at a time through Omni AI on the reviewed branch. Every dashboard keeps independent queued/running/succeeded/failed/cancelled status and retry. Export sanitized JSON or Markdown reconciliation with bundle, branch, translated/approximated/redesigned/excluded/deferred/unresolved outcomes, source-to-target lineage, validation, exceptions, waivers, engine provenance, and dashboard outcomes.

#### Power BI manual support matrix

| Source evidence | Manual support | How OmniKit treats it |
| --- | --- | --- |
| Direct `.pbix` | Supported with managed engine | Validates the ZIP-based container, enforces entry, expansion, size, checksum, and traversal limits, then normalizes model and report evidence in a temporary local workspace. Raw PBIX bytes are deleted after analysis and are never sent to the selected LLM. |
| PBIP project directory or ZIP | Supported | Preserves safe relative paths, assembles related semantic-model/report projects, and rejects traversal, duplicate paths, invalid UTF-8, corruption, excessive file counts, and compressed or expanded content beyond configured limits. |
| `model.bim` and TMDL | Structural support | Normalizes tables, columns, calculated columns, multiline measures, hierarchies, calculation groups, partitions/M, relationships, formatting, hidden state, annotations, roles, cultures, and perspectives when exposed. Unsupported or unrecoverable expressions remain warnings. |
| Split PBIR and legacy report JSON | Structural support | Reconstructs complete selected report, page, visual, title, field-role, query, formatting, filter, and layout evidence. Large selections are planned in deterministic evidence chunks and cannot pass readiness until every known visual ID is represented exactly once and every planned field has provenance. One indivisible visual above the evidence-unit limit blocks with an actionable error; OmniKit does not shorten it. Drillthrough, bookmarks, interactions, themes, custom visuals, and detailed formatting remain review evidence rather than guaranteed target behavior. |
| Workspace Scanner JSON | Optional | Adds nested workspace, dataset, report, endorsement, sensitivity, and governance context. Principal identity collections and identity-shaped values are removed from both normalized and opted-in raw AI evidence. |
| AI evidence | Selected and normalized by default | Prompts contain complete authoritative evidence for selected reports, their dependency-scoped canonical nodes, and exact visual IDs. Large mandatory evidence is chunked without a fixed node cutoff; prompt sections disclose included and omitted-unrelated counts. Optional raw snippets remain transient, bounded, identity/secret-redacted, and require explicit operator opt-in. |
| DAX, M, relationships, RLS, cultures, and custom visuals | Review required | OmniKit preserves multiline DAX, M, and TMDL RLS predicates when recoverable, creates typed blocking decisions, and requires an explicit map, create, rewrite, ignore, or defer outcome before compilation. Unrecoverable security predicates remain blocking warnings. |

Power BI support is structural migration assistance, not automatic behavioral parity. DAX/filter-context results, Power Query execution, RLS identity assignment, bookmark and interaction state, unsupported custom visuals, theme translation, and pixel-perfect formatting still require validation in the destination model and dashboard. OmniKit keeps those gaps visible and does not convert missing evidence into a pass.

Omni's dashboard import endpoint accepts Omni-native dashboard exports; it does not translate arbitrary Power BI, Tableau, Domo, Sigma, Looker, WebFOCUS, or MicroStrategy JSON. External dashboards therefore move through reviewed typed build specifications and Omni AI construction unless a future source adapter can produce a verified Omni-native document payload.

Security boundaries are deliberate:

- Raw source files and pasted content remain in page memory only while they are needed for normalization; they are not written to browser storage or the migration audit ledger. Once normalized evidence is reviewed, **Release raw source from memory** removes the original text and binary payloads while preserving content-free artifact metadata, mappings, diagnostics, canonical objects, and review decisions so planning can continue. Replacing the source, changing acquisition paths, reloading, or closing the page clears the remaining in-memory evidence. Manual Domo, Looker, MicroStrategy, and Power BI artifacts are sent only to the local vault-gated backend for bounded normalization. Optional engine extraction writes permission-restricted temporary files and deletes them after success, failure, or cancellation; startup scavenging removes abandoned stale roots. Provider prompts use normalized task-scoped evidence by default. Normalized labels, descriptions, warnings, filters, expressions, and opted-in bounded raw snippets are sanitized during prompt construction and checked again on the local server immediately before both direct and queued provider calls. Emails, identity-shaped values, credentials, and bearer tokens are redacted while allowlisted contract IDs remain available for exact dependency matching. Prompt limits are enforced after this final sanitation step.
- Source content is treated as untrusted data, not prompt instructions. Only task-scoped evidence is sent to the selected AI option.
- Provider and source requests require HTTPS, block private/local network targets, and support host allowlists, request limits, redaction, and audit metadata.
- An LLM never receives direct source or Omni write authority. OmniKit converts approved typed decisions into reviewed output.
- Durable migration metadata stores status, identifiers, fingerprints, and usage only; it excludes credentials, prompts, raw source artifacts, generated YAML, and full AI responses.
- Unsupported validation remains visible and must be completed or explicitly waived, preserving an honest audit trail.

#### Optional deterministic migration engine

OmniKit can embed the read-only extraction and deterministic translation capabilities from `exploreomni/omni-migrator`. The engine is not a second control plane: it never receives Omni credentials and contains no branch, write, dashboard-build, merge, or approval authority. OmniKit remains the sole owner of vault access, decisions, compilation, writes, validation, and reconciliation.

Install or refresh the managed local runtime after cloning both repositories:

```bash
npm run setup:migration-engine
```

The setup command requires Python 3.11 or newer, installs the exact `requirements.lock`, copies the engine into ignored `data/migration-engine/`, creates an isolated virtual environment, records the dependency-lock hash, source revision and content hash, contract checksums, installed dependency/license inventory, and verifies the engine's `write_authority: false` capability boundary. It also runs independent conformance contracts for Looker, Power BI, Tableau, Metabase, and Sigma. Production setup rejects dirty or unversioned engine source unless an intentional emergency override is set. The managed runtime and uploaded artifacts are never tracked by git.

Before release, verify the installed runtime against its source, dependency lock, contracts, live capabilities, and live conformance evidence:

```bash
npm run verify:migration-engine
```

The verifier intentionally fails for a dirty, unversioned, unmanaged, or checksum-drifted engine. Run it only after the engine changes are committed and `npm run setup:migration-engine` has installed that clean revision. Permissions and schedules are not represented by the current read-only engine contract and are reported as unsupported; OmniKit never claims they were migrated.

Run credential-gated acceptance against the real local control plane before promoting a source. Keep the native vault unlocked, save the source connection and target Omni instance there, and use only their non-secret IDs. The command accepts no API-key, password, token, or client-secret flags and refuses non-local OmniKit URLs. Looker, Metabase, and Sigma exercise the saved API connection; Power BI and Tableau exercise explicit local exports:

```bash
npm run accept:migration-engine -- --source looker --connection-id <vault-source-id> --target-instance-id <vault-target-id> --dashboard-id <dashboard-id>
npm run accept:migration-engine -- --source metabase --connection-id <vault-source-id> --target-instance-id <vault-target-id> --dashboard-id <dashboard-id>
npm run accept:migration-engine -- --source sigma --connection-id <vault-source-id> --target-instance-id <vault-target-id> --dashboard-id <workbook-or-page-id>
npm run accept:migration-engine -- --source powerbi --target-instance-id <vault-target-id> --artifact /path/report.pbix
npm run accept:migration-engine -- --source tableau --target-instance-id <vault-target-id> --artifact /path/workbook.twbx
```

Use `--url http://127.0.0.1:5176` when the app is running on another local port, repeat `--dashboard-id` to verify scoped extraction, and set `OMNIKIT_LIVE_CONNECTION_OVERRIDES_JSON` when an acceptance run must exercise explicit source-to-target connection decisions. Successful runs write a mode/count/hash/runtime summary to ignored `data/migration-engine/live-acceptance/`. The evidence excludes artifact names and paths, raw bytes, source formulas, generated YAML, credentials, dashboard IDs, connection IDs, and target instance IDs. Live evidence does not replace offline conformance, branch review, target query reconciliation, permission review, or visual acceptance.

Engine rollout is source-specific and reversible:

| Source | Authoritative path | Engine role | Immediate rollback |
| --- | --- | --- | --- |
| Domo, MicroStrategy, WebFOCUS | OmniKit guided parsers | None until a dedicated plugin reaches parity | Keep the native parser active |
| Power BI PBIP/PBIR/TMDL/scanner | OmniKit parser | Engine is authoritative only for direct `.pbix` when configured primary | Disable Power BI engine mode; use PBIP or supported exports |
| Looker | OmniKit fallback | LookML and scoped Looker API acquisition | Set Looker to `shadow` or `off` |
| Tableau | OmniKit artifact fallback | Structured workbook/data-source parsing | Set Tableau to `shadow` or `off` |
| Metabase | OmniKit API fallback | API/MBQL normalization | Set Metabase to `shadow` or `off` |
| Sigma | OmniKit API fallback | API/formula normalization; layout remains limited by source evidence | Set Sigma to `shadow` or `off` |

`off` uses the native path, `shadow` runs a developer-only sanitized parity comparison without changing inventory, decisions, files, or dashboard plans, and `primary` allows reviewed engine evidence into the normal OmniKit workflow. The default is `shadow`. Shadow runs append only counts, versions, latency, and numeric parity scores to ignored `data/migration-engine/parity-observations.json`; no source content, formulas, names, or model output is retained there. A requested `primary` mode is downgraded to `shadow` until the source has a passing same-runtime observation window, a named release owner, and a completed rollback drill.

Parity evidence names its comparison honestly. `native_differential` means OmniKit generated a comparable
native baseline on the server from the same scoped API inventory or a separately supplied project/export;
the browser cannot submit a score. `canonical_conformance` means no comparable old path was available and
the run was checked only against the reviewed source contract. Canonical conformance is useful release
evidence, but it is never described as old-versus-new parity and cannot by itself certify a source.

After reviewing the shadow evidence and completing a rollback exercise, create the ignored promotion record explicitly:

```bash
npm run promote:migration-engine -- --source looker --approved-by "Release Owner" --rollback-drill "looker-rollback-2026-07"
```

The command refuses mixed engine/parser/rulebook windows, a managed-runtime provenance mismatch, failing conformance evidence, and any observation below the source-specific threshold. There is no automatic promotion or native-parser deletion. The first published result contract is `omnikit.migration.bundle.v1`; unknown contracts fail closed, and a future contract must be added alongside the previous released schema before deprecation. Run `npm run test:e2e:migration-engine` for the deterministic Whataburger dry-run smoke test plus acceptance-harness security tests.

The contract's reviewed Draft 2020-12 schema is pinned at
`tests/fixtures/migration-engine/omnikit.migration.bundle.v1.schema.json`. The bridge test checks its
content hash, validates the shared engine fixture with Ajv, and rejects nested identity drift. For a
cross-repository release, manually dispatch `.github/workflows/migration-engine-release.yml` with the
exact engine revision. The workflow requires a read-only `OMNI_MIGRATOR_READ_TOKEN` secret because the
engine repository is private; it installs that revision, runs the bridge E2E test, verifies managed-runtime
provenance, and executes the full security gate. This proves repository compatibility, not source
certification: each source still needs its own passing live-acceptance evidence and rollback drill.

### Governance

- **Labels** — bulk apply or remove labels from selected content.
- **Schedules** — review, pause, resume, trigger, or delete scheduled deliveries.
- **User Management** — manage users and groups, including bulk user operations and user-health review for inactive users or entities without active users.
- **Embed URLs** — generate signed embed URLs for approved implementation workflows.

### History

Every batch run, migration, and bulk operation is appended here with timestamps and status. Dashboard migration jobs are merged into the same local history view with retry lineage, redacted step details, imported document IDs, semantic-prep audit details, warnings, and post-action results.

### Data Privacy

Exactly what is stored locally, where it's stored (native encrypted vault, local job history, localStorage, IndexedDB, or same-tab sessionStorage), and controls to clear each category. BI Migration Studio source files, pasted source text, AI responses, and generated YAML stay in page or encrypted transient memory by default. Saved provider credentials, source connections, and project metadata live in the encrypted native vault; sanitized AI job metadata never contains prompts, artifacts, responses, or credentials. Walkthrough progress is stored as a small localStorage flag so returning users are not interrupted repeatedly.

---

## How it works under the hood

```
Browser (UI)
   |
   |  fetch('/api/migrate', ...)
   v
Vite dev server on localhost:5173
   |
   |  mounted as middleware
   v
Local API handlers (server/handlers/*.ts)
   |
   |  HTTPS
   v
Your Omni instance
```

Key points:

- **One port, one process.** The Vite plugin at `server/vitePlugin.ts` mounts an Express-style middleware at `/api/*`. No separate backend process.
- **Same-origin.** Because the UI and local API share `localhost:5173`, there is no browser CORS setup and no cookie-based app session to manage.
- **Scoped local handlers.** Most `/api/<name>` routes forward one REST call to your selected Omni instance using either a native-vault reference token or a dedicated saved-instance server-side lookup. Native vault, saved instance, metrics, and migration-job routes run locally and keep secrets on the server side.
- **Local-only binding.** The server listens on `127.0.0.1`, so nothing else on your LAN can reach it.
- **No hosted database.** Persistent app state lives in your browser (`localStorage` + IndexedDB) plus local-only files under `./data/` for the native encrypted vault and sanitized migration job history. The active saved instance is kept in same-tab `sessionStorage` as a non-secret vault reference and is cleared by the Data Privacy wipe action.
- **Native encrypted vault.** Saved Omni instance profiles are encrypted in `./data/vault.enc` by default using Node `crypto` with scrypt and AES-256-GCM. Plaintext API keys are never returned to the browser; UI responses use masked keys only.
- **Legacy multi-instance cutover.** Instance Manager can import compatible `omni-multi-instance-tools` vault files after the native vault is unlocked. The legacy passphrase is used only for that local import request, valid profiles are re-encrypted into the native vault, duplicate base URLs are skipped, and unsupported legacy-only settings are reported in the dry-run summary.
- **Vault idle auto-lock.** The native vault auto-locks after local server idle time. Override the timeout with `OMNIKIT_VAULT_IDLE_TIMEOUT_MS`.
- **Local JSON job history.** Multi-instance migration jobs are stored in `./data/omnikit-jobs.json` by default with job metadata, status, warnings, retry lineage, and post-action results. API keys, bearer tokens, card-like numbers, emails, and phone numbers are redacted before job history is written.
- **Compatibility-first proxy guardrails.** The generic proxy only forwards HTTPS requests to Omni `/api/v1` paths. Other Omni API surfaces used by the app, such as SCIM, embeds, and dashboard import/export, go through dedicated handlers.
- **AI intake is local-first.** Uploaded Tableau, Sigma, and WebFOCUS artifacts, plus Excel workbooks used by AI Dashboard Studio, are parsed in the browser and held in memory for the active page session. Manual Domo, Looker, MicroStrategy, and Power BI artifacts are normalized by the local, vault-gated backend so their semantic and dashboard evidence share one versioned contract. BI Migration Studio can release original upload bytes after normalization without discarding the reviewable normalized inventory. OmniKit does not persist raw external BI source files or raw Excel workbooks to browser storage or the migration audit ledger by default.
- **No external app runtime services.** The app uses bundled public assets and system fonts; it does not require a hosted OmniKit backend, package registry service, database, telemetry endpoint, or external font CDN at runtime.

---

## Scripts reference

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite dev server with HMR and the embedded `/api/*` proxy. Use this for day-to-day work. |
| `npm run build` | Build the production bundle into `dist/`. |
| `npm run start` | Build, then serve `dist/` plus the API proxy on a single port. |
| `npm run serve` | Serve an existing `dist/` plus the API proxy (skips rebuild). |
| `npm run preview` | Vite's built-in static preview (UI only, no API). |
| `npm run typecheck` | Run `tsc --noEmit` across the React app source. |
| `npm run typecheck:node` | Run `tsc --noEmit` across the local Node server source. |
| `npm run lint` | Run ESLint. |
| `npm run setup:migration-engine` | Install the sibling read-only migration engine into the ignored managed runtime and run its source conformance contracts. |
| `npm run verify:migration-engine` | Prove the managed engine's clean revision, source content, lockfile, contracts, installed dependencies, live capabilities, and five-source conformance before release. |
| `npm run test:e2e:migration-engine` | Run the deterministic Whataburger bridge and queue smoke tests against the managed engine. |
| `npm run test:dashboard-migration` | Run focused Dashboard Migrator route, destination, topic, and grouping helper tests. |
| `npm run test:migration-planner` | Run focused Dashboard Migrator planner tests. |
| `npm run test:model-migrator` | Run focused Model Migrator inventory helper tests. |
| `npm run test:user-health` | Run focused User Management health tests. |
| `npm run test:workspace-snapshot` | Run focused Home workspace snapshot count tests. |
| `npm run test:security` | Run focused vault, job-history, and post-action security regression tests. |
| `npm run security:audit` | Run `npm audit --audit-level=moderate`. |
| `npm run security:check` | Run the full local security gate: audit, all focused tests, typechecks, lint, and build. |

### Live E2E gate

Before cutting a release, run the automated gate above and spot-check these vault-mode flows against a real saved instance:

1. Start OmniKit with a short idle timeout, for example `OMNIKIT_VAULT_IDLE_TIMEOUT_MS=10000 npm run dev`.
2. Unlock the native vault, connect a saved instance, wait for the idle timeout, and confirm Home shows the vault unlock prompt instead of **Connected workspace**.
3. Unlock from the sidebar instance switcher and confirm the previous saved instance resumes without re-selecting it.
4. Refresh the Home workspace snapshot and confirm model counts look like active semantic-layer models rather than raw catalog or branch rows.
5. Start a migration job, lock the vault, cancel the running job, and confirm cancel succeeds while retry still requires the vault to be unlocked.

---

## Release & package information

- Release notes live in [RELEASES.md](./RELEASES.md).
- Package and distribution guidance lives in [PACKAGES.md](./PACKAGES.md).
- OmniKit is currently distributed as a source repository. It does not publish a GitHub Package, npm package, Docker image, or hosted service in the initial release.

---

## Configuration

OmniKit is zero-config by design. There are no required environment variables.

Optional:

- `PORT` — override the port used by `npm run serve` / `npm run start`. Default is `5173`.
  ```bash
  PORT=8080 npm run start
  ```
- `OMNIKIT_VAULT_PATH` — override the native encrypted vault path. Default is `./data/vault.enc`.
- `OMNIKIT_VAULT_IDLE_TIMEOUT_MS` — override the native vault idle auto-lock timeout. Default is `1800000` (30 minutes). Use `0` only for local troubleshooting when you explicitly want to disable auto-lock.
- `OMNIKIT_JOB_HISTORY_PATH` — override the non-secret migration job history file path. Default is `./data/omnikit-jobs.json`.
- `OMNIKIT_DB_PATH` — legacy alias for `OMNIKIT_JOB_HISTORY_PATH`, kept for older local scripts.
- `OMNIKIT_JOBS_PATH` — legacy one-time import path for older `jobs.json` history. If present and the current job history file is empty, OmniKit imports it and renames it to `jobs.json.bak`.
- `OMNIKIT_ALLOW_PRIVATE_POST_ACTIONS=true` — allow post-migration action templates to call localhost or private-network URLs. By default, post-migration actions must use HTTPS and cannot target private networks.
- `OMNIKIT_POST_ACTION_ALLOWLIST` — optional comma-separated hostname allowlist for post-migration actions, such as `hooks.example.com,automation.example.com`.
- `OMNIKIT_SEMANTIC_MIGRATION_JOB_PATH` — override the sanitized Semantic Migration Studio job-metadata path. Default is `./data/semantic-migration-jobs.json`; prompts and generated content are never written there.
- `OMNIKIT_SEMANTIC_MIGRATION_AUDIT_PATH` — override the sanitized Semantic Migration Studio audit path. Default is `./data/semantic-migration-audit.json`.
- `OMNIKIT_MIGRATION_PROVIDER_ALLOWLIST` — optional comma-separated provider-kind allowlist, such as `openai,anthropic,snowflake_cortex`.
- `OMNIKIT_MIGRATION_PROVIDER_HOST_ALLOWLIST` — optional comma-separated hostname allowlist for AI provider endpoints.
- `OMNIKIT_MIGRATION_SOURCE_HOST_ALLOWLIST` — optional comma-separated hostname allowlist for Metabase, Sigma, WebFOCUS, and Databricks source connectors.
- `OMNIKIT_MIGRATION_MAX_PROMPT_CHARS` — optional combined system-plus-user character budget for Semantic Migration Studio provider requests. Default is `500000` and the hard maximum is `1000000`. Oversized requests receive `413`; OmniKit never silently truncates a migration contract.
- `OMNIKIT_MIGRATION_ENGINE_SOURCE` — source checkout used by `npm run setup:migration-engine`. The sibling `../omni-migrator-comparison` or `../omni-migrator` checkout is detected automatically when present.
- `OMNIKIT_MIGRATION_ENGINE_ENABLED=false` — disable the optional engine and use existing OmniKit parser fallbacks during rollback or troubleshooting.
- `OMNIKIT_MIGRATION_ENGINE_SOURCES` — optional comma-separated engine source allowlist (`looker,metabase,powerbi,sigma,tableau`) for source-by-source rollout and rollback.
- `OMNIKIT_MIGRATION_ENGINE_MODE` — requested default engine mode: `off`, `shadow`, or `primary`. The safe default is `shadow`; ungated primary requests remain shadow.
- `OMNIKIT_MIGRATION_ENGINE_MODE_LOOKER` (and `_POWERBI`, `_TABLEAU`, `_METABASE`, `_SIGMA`) — source-specific mode override.
- `OMNIKIT_MIGRATION_ENGINE_PROMOTION_PATH` — optional path to the sanitized source promotion ledger. Default is ignored `data/migration-engine/promotions.json`.
- `OMNIKIT_MIGRATION_ENGINE_PARITY_PATH` — optional path to the sanitized shadow-observation ledger. Default is ignored `data/migration-engine/parity-observations.json`.
- `OMNIKIT_MIGRATION_ENGINE_ALLOW_UNGATED_PRIMARY=true` — emergency-only bypass for the promotion ledger. Normal rollout should never need this.
- `OMNIKIT_MIGRATION_ENGINE_BOOTSTRAP_PYTHON` — Python 3.11+ executable used to create the managed engine virtual environment.
- `OMNIKIT_MIGRATION_ENGINE_ROOT` — optional runtime source override when the managed engine is not used.
- `OMNIKIT_MIGRATION_ENGINE_PYTHON` — optional Python executable override for the runtime bridge.
- `OMNIKIT_MIGRATION_ENGINE_TIMEOUT_MS` — per-extraction timeout from 1 second through 15 minutes. Default is 120000.
- `OMNIKIT_MIGRATION_ENGINE_MAX_CONCURRENCY` / `OMNIKIT_MIGRATION_ENGINE_MAX_QUEUE` — bounded local process concurrency and waiting capacity. Defaults are `2` and `8`.
- `OMNIKIT_MIGRATION_ENGINE_MEMORY_MB` / `OMNIKIT_MIGRATION_ENGINE_CPU_SECONDS` — best-effort child process limits. Node still enforces wall-clock, input, output, and queue limits when the OS does not support these resource limits.
- `OMNIKIT_MIGRATION_ENGINE_TEMP_MAX_AGE_MS` — age after which process-owned abandoned engine temp directories are eligible for startup scavenging.

---

## Troubleshooting

**Port 5173 is already in use.**
Another process (probably another Vite app) is using the port. Either stop it, or run `PORT=5174 npm run start`.

**Browser didn't open automatically.**
Open `http://localhost:5173` manually.

**Connection test fails.**
Check, in order: the Base URL has no trailing slash and includes the protocol; the API key is the full string with no line breaks; your VPN or SSO is active if Omni is internal-only; your machine can reach the Omni host (`curl -I https://yourcompany.omniapp.co`).

**Deck generation fails.**
Re-upload the `.pptx` template — it may have been saved with an unsupported feature. Confirm the mapped tiles still exist in the source dashboard.

**Blank page after build.**
Run `npm run build` again and watch the terminal for errors. A stale `dist/` can also cause this — delete `dist/` and rebuild.

**I want to wipe everything.**
Open **Data Privacy**. Use **Clear all local data** for browser data, and **Reset native vault** for saved instance profiles and migration job history. Browser DevTools → Application → Storage → **Clear site data** clears browser data only.

**I am moving from `omni-multi-instance-tools`.**
Open **Instance Manager**, unlock or create the native vault, then use **Import legacy multi-instance vault**. Run **Dry run import** first, review skipped duplicates and warnings, then run the import. Test each imported profile before using it in Dashboard Migrator. Keep the old tool's `data/` folder until you have verified the imported instances. Legacy SQLite job history is intentionally kept as an archive in the old repo unless you manually need it for audit reference.

---

## Security & privacy

- The local API binds to `127.0.0.1` only — not reachable from other machines on your network.
- Active saved-instance sessions keep only a non-secret vault reference in React state and same-tab `sessionStorage`. Plaintext saved-instance API keys stay server-side while the native vault is unlocked.
- Saved instance API keys live in the native encrypted vault file, not browser storage. The vault passphrase is not stored, decrypted contents are kept in server memory only while unlocked, the vault auto-locks after idle time, and API keys are returned to the UI only as masked strings.
- Legacy multi-instance vault imports are local file reads only. OmniKit validates the path, requires confirmation before reading absolute paths, skips invalid or duplicate profiles, drops unsafe post-migration action URLs, and never returns imported plaintext API keys to the browser.
- No telemetry, no analytics, no outbound calls except to the Omni Base URL you entered.
- No external font or tracking scripts are loaded by the app shell.
- OmniKit stores operational metadata locally so the UI can show history, templates, filter defaults, cached dashboard/model context, and multi-instance migration jobs. Job history is redacted before it is written to the local JSON history file. Open **Data Privacy** to inspect and clear browser entries, reset the native vault, or clear local job history.
- Post-migration actions are saved as encrypted vault templates and must be explicitly enabled per migration job. Job history stores redacted action metadata only. Actions are HTTPS-only by default, block localhost/private-network targets unless `OMNIKIT_ALLOW_PRIVATE_POST_ACTIONS=true`, and can be restricted with `OMNIKIT_POST_ACTION_ALLOWLIST`.
- BI Migration Studio provider and source credentials are encrypted in the native vault and hydrated only on the local server. Outbound endpoints are HTTPS-only, block private and local networks, and support provider/source host allowlists. The local audit ledger records resource IDs, provider/source kinds, outcomes, and timestamps only. OmniKit is a local single-operator tool; organizations needing centralized roles, SSO enforcement, or separation of duties should enforce those controls at the host, vault, provider, and Omni instance layers.
- Raw export inspection can display the full dashboard export payload in your browser for troubleshooting. Treat copied diagnostics and exported backups as customer data.
- The generic proxy is intentionally limited to Omni `/api/v1` endpoints; workflows that need other Omni API surfaces use purpose-built local handlers.
- Vite's dev server is designed for local development, not for production hosting. Don't expose this app to the public internet.

## Compliance posture

OmniKit is a local-first admin utility, not a certified compliance product.

- **PCI-aware, not PCI certified.** Do not store or process cardholder data in OmniKit unless your environment has been formally scoped for PCI DSS. OmniKit redacts card-like numbers from job history as a safety net, but that does not replace PCI DSS controls or QSA review.
- **SOC readiness support, not a SOC report.** OmniKit can support evidence gathering through local job history, branch review, and explicit migration outcomes, but SOC 1/SOC 2 require organization-level policies, approvals, monitoring, incident response, and auditor testing.
- **CIS-aligned local controls.** OmniKit binds locally, uses encrypted local storage for reusable secrets, avoids telemetry, and includes dependency/security checks. Host-level CIS Benchmark hardening remains the responsibility of the machine and organization running OmniKit.

---

## Uninstalling

1. Close any running `npm run dev` process.
2. Delete the `OmniKit/` folder (including `node_modules/` and `dist/`).
3. Optional: open DevTools on the former URL and **Clear site data** to remove local `omnikit:*` entries.

---

## FAQ

**Does this talk to Supabase or any other cloud service?**
No. OmniKit has no cloud dependencies. The only outbound calls it makes are to the Omni Base URL you provide.

**Can I share my templates or batch history with a teammate?**
Not through the app — it's intentionally single-user. You can export a deck template as a `.pptx` and share that file manually.

**Can I run this on a shared server for my team?**
Not recommended without adding proper authentication, network controls, and operational monitoring. The included API binds to localhost and assumes a single trusted local operator.

**What happens if I close the tab mid-migration?**
The in-flight HTTP request to Omni continues until it finishes or times out, but the UI that was tracking progress is gone. Re-open the tab and check **History** — then re-run anything that didn't complete.

**Do I need to restart the server after editing code?**
No. Vite's HMR picks up UI changes instantly. Changes to files under `server/` trigger a plugin reload automatically.
