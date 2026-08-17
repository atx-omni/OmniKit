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

Security reporting, support boundaries, and contribution requirements are
documented in [SECURITY.md](SECURITY.md), [SUPPORT.md](SUPPORT.md), and
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## What you can do with it

- Run governed Dashboard creation and Apps (Beta) jobs, then review and iterate in Omni
- Generate a Narrative report as governed narrative output without claiming a persistent Omni report artifact
- Manage saved Omni instance profiles in a native encrypted local vault
- Use Home as a Fleet Command Center across every saved instance, even when no active working instance is selected
- Compare operational, adoption, content, and exception evidence with exact coverage, freshness, source, and reason details
- Work from four consolidated Administration workspaces while existing Administration URLs continue to resolve with their query state
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
| Node.js | 22.22.0 or newer | CI validates Node 22.22.0. Check with `node --version`. Download at [nodejs.org](https://nodejs.org). |
| npm | 10 or newer (bundled with current Node LTS) | Yarn or pnpm also work. |
| Python | 3.11 or newer | Required for the first-party BI migration engine. `npm run setup:migration-engine` creates an ignored managed virtual environment. |
| Browser | Current Chromium | The critical Migration Studio and accessibility paths are required in Chromium. Firefox and WebKit remain compatibility targets; see [the browser matrix](docs/support/browser-matrix.md). |
| Omni instance | Reachable from your machine | You also need a personal API key. |

No Docker, database, hosted backend, or Supabase account is required. The core
admin workspace uses Node.js only; BI Migration Studio also requires the local
Python version shown above.

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
   npm run setup:migration-engine
   ```
   The second command installs the tracked first-party migration engine into an
   ignored local virtual environment. It does not clone or call an external
   migrator repository.
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
3. **Review Fleet Command Center** across all saved instances. Fleet is available whenever the vault is unlocked and contains at least one saved instance; it does not require an active working-instance selection.
4. **Choose an active saved instance only when needed** for a connection-dependent Administration, dashboard, model, migration, or delivery workflow.

Your saved instance API keys are encrypted in the native vault and are not returned to the browser as plaintext. The browser keeps only a non-secret vault reference for the active tab session.

If the vault is locked, return to **Home** to unlock it before starting workflows. The sidebar instance switcher shows the selected working instance and supports switching after the vault is unlocked, but passphrase entry stays on Home. Changing that selection does not narrow Fleet; Fleet filters are controlled independently on Home.

A red error usually means one of: wrong URL, expired/invalid key, VPN not connected, unsupported host, or your Omni instance blocks requests from localhost. The error message tells you which.

---

## Feature guide

The sidebar groups features by job. Fleet is the cross-instance operating view, Administration workspaces organize related leaves and tabs, and creation or migration pages keep their focused wizard or table workflow.

New users see a click-through walkthrough the first time they open OmniKit. The guide explains how to start from Home, unlock or create the vault, where each workflow lives, how review steps work, and where local data controls live. Users can dismiss it for the current app version, replay it from the sidebar **Guide** button, or reset it from **Data & Privacy**. When the walkthrough content is updated in a future local clone/pull, OmniKit can show it again for that new version.

### Fleet Command Center

Home is the portfolio operating view for every saved Omni instance in the unlocked vault. It remains available without an active working-instance session. Use the sidebar instance switcher only when entering a workflow that acts on one selected instance.

Fleet has five query-backed views:

1. **Overview** — portfolio KPIs, scan coverage, freshness, and prioritized exceptions.
2. **Operational** — instance reachability, authorization evidence, connection readiness, refresh progress, and failed scans. Collection completeness is not labeled operational health.
3. **Adoption** — 7-, 30-, or 90-day activity plus stale and never-login populations, kept separate from operational readiness.
4. **Content** — connections, models, topics, dashboards, Apps, and AI conversations.
5. **Exceptions** — unavailable, unauthorized, unsupported, stale, failed, and duplicate-origin findings.

Filters support saved instance, explicitly attributed connection, operational or adoption state, freshness, activity window, and text search. Environment/tag filtering is shown as unsupported until a documented governed metadata source exists. Lazy instance and connection drilldowns preserve the supported view, filter, time, and search context when moving into an Administration workflow.

Fleet evidence follows these rules:

- **Unavailable is never zero.** A zero is shown only for a successful, complete read that returned no records. Unauthorized, unsupported, unavailable, failed, partial, and stale evidence remain distinct.
- Every result retains its status, reason code and message, source, coverage, exclusions, and original evidence time. A progressive refresh may show retained stale values, but it does not make their original freshness current. Partial and stale can be true at the same time.
- A failed saved instance does not erase successful totals from other instances; the exact failed and excluded scope stays visible.
- Adoption lifecycle cards count active source records, not unique people. Cross-instance internal-person totals are estimates and can be withheld where governed deduplication is not available.
- Connection relationships are labeled **explicit**, **inferred**, or **unknown**. Only explicit attribution can drive a connection filter or connection-scoped inventory. Inferred and unknown associations are never presented as access or permission evidence.
- Complete portfolio refreshes add one compact encrypted history entry per UTC day. The same day is replaced idempotently, history is bounded to 90 days, and entries exclude raw users, emails, credentials, URLs, and upstream responses.

### AI Content & Dashboard Delivery

- **AI Content Studio** (`/content/ai-studio`) — review an existing dashboard or request new content through one bounded, controlled Omni Agent job from a selected model and optional topic.
  - **Existing-dashboard review** sends an explicitly approved full-dashboard render plus bounded structural evidence to Blobby for an enterprise-polish critique. The render supports visible hierarchy, density, color, labels, and composition findings; hidden behavior, metric correctness, performance, permissions, and responsive states remain unknown unless separately evidenced. The prompt requests zero writes, while returned actions and model snapshots are still reconciled because Omni exposes no server-enforced read-only Agent mode.
  - Agent-backed modes remain controlled writes because Omni does not expose a read-only Agent flag or documented action allowlist. OmniKit binds approval to the exact scope, submits once, retries only status/result reads, and compares model/branch fingerprints after the run.
  - **Dashboard creation** asks Omni Agent to create one persistent first-pass dashboard. A returned reference is only a candidate: OmniKit rereads Documents V2 state and its query presentations/layout containers, governed queries, filters/controls, the complete access list, and content-validator evidence before labeling a dashboard verified. Destination and ownership remain unverified until reconciliation, and optional PNG retrieval proves transport/decoding rather than visual correctness.
  - **Apps (Beta)** asks Omni Agent to start workbook-backed App creation. If Omni returns a Chat handoff, continue there to inspect any candidate reference; the API does not guarantee that the App editor opens. Omni exposes no equivalent typed App verification contract here, so App type, behavior, destination, ownership, and publication remain explicit manual checks.
  - **Narrative report** returns governed narrative output for review; it does not create or claim a persistent Omni report artifact and still uses the controlled-write Agent surface.
  - Verified test dashboards can be moved to recoverable Omni Trash only after the operator checks an exact confirmation and retypes the verified identifier.
  - Optional evidence is limited to five image or PDF attachments. Each image may be no larger than 3 MiB, and the prompt plus decoded attachments must remain approximately 15 MiB or less.
  - Existing bookmarks at `/dashboards/ai-studio` redirect to the canonical AI Content Studio route while preserving query parameters.
- **Dashboard Migrator** — use one simple, non-destructive flow: choose dashboards, choose one or more destinations, then move and track. Every selected dashboard is copied to every selected destination. OmniKit resolves compatible semantic requirements, validates any narrowly safe additive change, verifies query-backed content, and isolates failures by destination without exposing dependency mapping or YAML decisions. Source dashboards remain in place, destination folders are never emptied, direct source sharing is not copied, and same-name collisions receive a deterministic copy suffix instead of replacing or trashing unrelated content. A destination that cannot be proven safe stops with only Retry destination, Choose another model, Open Model Migrator, and collapsed technical details; successful destinations remain untouched.
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

### Administration workspaces

Administration is consolidated into four workspaces. Their landing routes redirect to the first canonical leaf while preserving supported query context.

| Workspace | Canonical routes | Existing aliases retained |
| --- | --- | --- |
| **Fleet & Readiness** | `/admin/fleet`, `/admin/fleet/instances`, `/admin/fleet/connections` | `/instances`, `/connections` |
| **Identity & Access** | `/admin/identity`, `/admin/identity/users`; user, group, bulk-import, and health views use the `tab` query parameter | `/users`, `/groups` |
| **Content Operations** | `/admin/content`, `/admin/content/health`, `/admin/content/schedules`, `/admin/content/uploads`, `/admin/content/labels` | `/content-health`, `/schedules`, `/uploads`, `/labels` |
| **Embed & Developer Tools** | `/admin/developer`, `/admin/developer/embeds` | `/embeds` |

Legacy aliases use replace navigation and preserve their existing query parameters and hash. The `/groups` alias always resolves to the Identity workspace with one `tab=groups` value. Instance Manager is available with an unlocked vault even when no active working instance is selected; connection-dependent leaves still require one.

The workspaces preserve the existing operator workflows:

- **Fleet & Readiness** — save and test encrypted instance profiles, import a compatible legacy vault with a dry run, configure instance defaults and filters, inspect connections, and review folder visibility, aggregate API-token posture, operator-confirmed organization-key posture, and current-token introspection limitations.
- **Identity & Access** — manage users and groups, run bulk import, inspect inactivity and embed-entity activity, review sanitized user-attribute definitions, and request a lazy model-role read for one opaque user or group scope. A returned role assignment is not proof of effective content, row, field, or query access.
- **Content Operations** — inspect folder/document collection evidence, schedules and latest observed delivery state, uploads, labels, and validator/job readiness. Latest delivery evidence is not run history, reliability, or an SLA.
- **Embed & Developer Tools** — review embed-user collection evidence, prepare Standard SSO requests, and follow governed developer or audit-log guidance.

Each workspace has an on-demand **Read-only readiness** panel. It uses documented GET contracts and displays evidence state (`not checked`, `available`, `partial`, `unauthorized`, `unsupported`, `unavailable`, `failed`, or `stale`) separately from readiness (`ready`, `action required`, `not configured`, or `unknown`). Coverage, exclusions, reason, source, and checked time remain visible. Settings without a documented read contract are not guessed or changed; OmniKit provides fixed Omni or documentation links and operator guidance instead.

For Standard SSO, enter the content path, external ID, name, optional email and groups, and embed secret for that request. The secret is sent through the local signing request and cleared after every attempt; OmniKit does not keep a recent signed-URL or secret ledger. Changing any identity-affecting input invalidates the displayed URL. A generated URL confirms that Omni accepted the signing request; it does not prove end-user access.

Workspace navigation, filters, drilldowns, readiness controls, and dialogs are keyboard operable. Use the skip link to move to main content; dialogs keep focus inside while open, close with Escape, and return focus to the opener. Fleet and Administration layouts are designed to remain usable at 320-pixel width without horizontal page overflow.

### Data & AI creation and migration

- **Model & Topic Health** — inspect models, refresh schema context, and review topic coverage for the active working instance.
- **AI Semantic Studio** — build or improve one governed topic solution end to end. OmniKit inventories the model, views, query views, relationships, topic, and optional access work; lets the admin reuse, update, create, or exclude each dependency; generates approved files in dependency order; shows complete pre-write diffs; validates one dev branch; and finishes with a pull-request handoff. Single-file Topic, Model / View, and Permission Builders remain under Advanced.
- **BI Migration Studio** — select dashboards from Domo, Looker, Metabase, MicroStrategy, Power BI, Sigma, Tableau, or WebFOCUS and migrate their proven dependency closure into Omni. A deterministic placement review separates warehouse or transformation logic from Omni views, topics, query views, automation, governance handoffs, and exclusions before semantic code is generated. Operators choose a vault-backed OpenAI, Anthropic, Snowflake Cortex, Databricks Genie, or Omni AI option, approve typed source-to-target decisions, export a checksummed upstream package when needed, compile one versioned migration bundle, validate semantic YAML on a dev branch, explicitly confirm readiness, and then build each selected dashboard through a retryable Omni AI queue. Genie is limited to validation SQL, reconciliation, and exception explanation; it is not presented as an arbitrary BI-artifact generator. LLMs propose reviewed intent while OmniKit owns placement policy, compilation, checksums, execution gates, and validation. Model Migrator remains the separate Omni-to-Omni promotion workflow.

### BI Migration Studio release scope

BI Migration Studio is currently released as **Preview** for every listed source
platform. Preview means the connector is available for controlled,
human-reviewed migration work, while unsupported constructs and unproven parity
remain visible. It does not mean that every source feature can be recreated
automatically.

The source registry separates two concepts:

- **Runtime lifecycle** (`unsupported`, `shadow`, `eligible`, `primary`, or
  `rolled_back`) determines which OmniKit-owned parser may contribute evidence.
- **Release stage** (`development`, `preview`, `ga_candidate`, or `ga`)
  determines the support and release claim.

A parser can therefore be the active `primary` path while the source remains
`preview`. General availability requires current live acceptance, target
reconciliation, a named owner, support readiness, and rollback evidence.

The initial release boundary is the documented local, single-operator
deployment. Hosted multi-user operation, centralized tenant isolation,
organization-wide SSO enforcement, telemetry, and service-level guarantees are
not included.

### BI Migration Studio workflow and security

1. **Source** — select the previous BI platform, source method, approved AI option, and destination Omni instance. Source, provider, and Omni credentials are encrypted in the native vault and hydrated only by the local server.
2. **Evidence** — load a searchable dashboard catalog with path, owner, usage, freshness, dependency coverage, and explicit collection evidence. Provider-aware bounded pagination follows each endpoint's documented contract—including endpoint-specific Sigma page or token styles, Tableau page numbers, Power BI continuations, and Looker search offsets—while enforcing request, page, parent, child, and item safety limits. Repeated pages and truncated scopes are reported rather than silently accepted; a truncated inventory cannot advance to planning. A six-class matrix discloses semantic-object, dashboard, filter, layout, permission, and schedule fidelity. Partial, export-required, and unsupported classes require acknowledgement. Manual Domo, Looker, MicroStrategy, and Power BI migrations use guided three-step upload wizards before AI analysis. Domo accepts related files or one bounded ZIP and normalizes Pages, Page/Card membership, Cards, dataset schemas, Beast Modes, SQL DataFlows, relationships, PDP and access evidence, ownership/usage, schedules/alerts, and explicit platform handoffs. Looker collects a documented LookML project unit: `.model.lkml`, included `.view.lkml`, and `.dashboard.lookml` files. MicroStrategy collects project metadata, report/cube definitions, attributes, metrics, relationships, and dashboard/document definitions containing chapters, pages, visualizations, filters, and prompts. Power BI accepts direct `.pbix`, a PBIP project folder or bounded ZIP, individual project files, `model.bim`, TMDL, split PBIR, legacy report JSON, and optional Workspace Scanner JSON. Direct PBIX, LookML, Tableau packages, Metabase API snapshot JSON, saved Metabase or Sigma API sources, and versioned offline Sigma snapshots use OmniKit's first-party read-only migration engine for deterministic semantic and dashboard evidence. Scanner metadata adds ownership and governance context only when supplied through the manual path; the Saved API collector does not claim Admin Scanner acquisition. The vault-gated local backend normalizes this evidence while keeping PDTs, access filters, DAX, Power Query, RLS, prompts, selectors, security filters, derived elements, report limits, hidden fields, custom visuals, non-SQL Magic ETL, Workbench, connector, custom-app, embed, and other unsupported behavior visible for human review. Bundled fictional cross-platform fixtures measure deterministic source-evidence recovery against independent Omni-oriented manifests; after AI generation, a second comparison grades semantic files, dimensions, measures, relationships, topic scope, and dashboard tile plans. Fixture content is regression data, not canonical customer-facing guidance. Neither score replaces YAML validation, branch review, query-result reconciliation, permission validation, or visual review.
3. **Destination** — choose the target Omni model, map each distinct source connection to a destination Omni connection, and split routes that cannot safely share one model. Ambiguous mappings require an explicit choice.
4. **Analyze** — select one or more dashboards and classify their project-scoped dependency closure as migrate, consolidate, redesign, defer, or retire. OmniKit preserves vendor IDs beside deterministic provenance identities, blocks incomplete source evidence, and asks the selected AI option for typed proposals without granting it write access.
5. **Place** — apply deterministic policy to every discovered artifact, then approve or override whether it belongs in an upstream transformation, Omni model view, Omni topic, Omni query view, automation handoff, governance handoff, or exclusion. Scheduled, incremental, stateful, materialized, side-effecting, scripted, or heavy logic never defaults to an Omni query view. When upstream work is required, OmniKit produces a portable, checksummed package for Generic SQL, dbt, Snowflake, Databricks, or MotherDuck. Export is the default; any direct deployment remains an explicit, capability-checked, non-production action.
6. **Resolve** — review evidence-backed semantic proposals and explicitly map, create, rewrite, ignore, or defer blocking source-to-target differences. Only approved Omni placements enter semantic YAML generation. Permission, identity, recipient, filter, time-zone, schedule, automation, and other handoffs become owner-assigned work instead of disappearing behind warnings.
7. **Validate** — validate the upstream package and the Omni semantic package independently. Upstream readiness requires target-dialect, schema, grain, and representative-result evidence. Omni readiness requires read-only target preflight, checksum-bound YAML preparation, structural/content validation on a dev branch, diff review, and explicit branch-readiness confirmation. Dashboard construction remains blocked until every required upstream and Omni proof is complete or explicitly governed.
8. **Build and reconcile** — validate untouched AI dashboard-plan output before defaults are normalized, require every selected visual exactly once, and require every planned field to trace to source visual evidence or an approved map/create decision. Compile approved placements, transformation package metadata, semantic files, dependency coverage, dashboard specifications, checksums, and validation evidence into one deterministic `MigrationBundle`. Run one selected dashboard at a time through Omni AI on the reviewed branch; each keeps independent status and retry. PR-required, protected, and git-follower models remain pull-request handoffs. Export sanitized reconciliation with artifact placement, upstream package evidence, source-to-target lineage, governance owners, visual evidence, exceptions, waivers, engine provenance, and dashboard outcomes. The target contracts follow Omni's documented [AI Jobs](https://docs.omni.co/api/ai/create-ai-job), [YAML update](https://docs.omni.co/api/models/create-or-update-yaml-files), and [branch merge](https://docs.omni.co/api/model-branches/merge-a-branch) APIs.

#### Configure an AI option securely

**Omni AI is the included default.** When an active saved Omni instance is selected, OmniKit creates an idempotent linked provider reference in the encrypted vault and uses the target model selected in the migration. No second key or provider setup is required. Choose **Use another provider** only when the migration should use external model credits, then add or select OpenAI, Anthropic, Snowflake Cortex, or Databricks Genie. External-provider forms show provider-specific prerequisites, setup steps, official documentation, authentication type, credential owner, expiration, and rotation date. OpenAI and Anthropic use their documented API-key endpoints. Snowflake Cortex and Databricks Genie accept a short-lived OAuth access token obtained outside OmniKit. Credentials are encrypted in the native vault, omitted from API responses and audit history, and hydrated only by the local server. **Save and test** or **Update and test** validates the exact saved revision before OmniKit makes an external profile selectable: generation providers receive a minimal structured-output request, Genie validates its one configured Agent, and Omni AI verifies the saved instance link before validating output on the first governed job.

| AI option | Credential to obtain | Setup summary | Supported role in OmniKit |
| --- | --- | --- | --- |
| OpenAI | Project API key | Select an API project, preferably create a project service account for shared automation, create a project-scoped key, copy it once, save it in OmniKit, select an allowed model, and test. Open the [API Keys page](https://platform.openai.com/api-keys), then follow the current [project, API-key, and service-account guide](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform) and [API quickstart](https://developers.openai.com/api/docs/quickstart). | Migration planning and typed package generation. |
| Anthropic | Workspace API key | Select a Claude Console workspace, confirm Limited Developer, Developer, or Admin key-management access and billing, open [Settings > API keys](https://platform.claude.com/settings/keys), create a named key with an expiration, save it, select an available Claude model, and test. See [Claude API authentication](https://platform.claude.com/docs/en/manage-claude/authentication), [workspaces and API keys](https://platform.claude.com/docs/en/manage-claude/workspaces), and [Console roles](https://support.claude.com/en/articles/10186004-claude-console-roles-and-permissions). | Migration planning and typed package generation. |
| Snowflake Cortex | OAuth access token | Create a dedicated identity and least-privilege role with `SNOWFLAKE.CORTEX_REST_API_USER`, obtain a short-lived OAuth access token through the approved Snowflake OAuth flow, enter the account origin and a compatible Cortex model, record expiration, and test. See [Snowflake local-application OAuth](https://docs.snowflake.com/en/user-guide/oauth-local-applications) and [Cortex REST authentication](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api). | Migration planning and typed package generation within Snowflake's Cortex boundary after the structured-output probe passes. |
| Databricks Genie | OAuth access token | Select one curated Genie Agent, copy its Agent ID (formerly Space ID), grant the OAuth identity access to the agent and backing SQL warehouse, enter the workspace origin, record token expiration, and test. OmniKit permits one saved Genie profile and binds it to that one Agent ID. See the [Genie Agents API](https://docs.databricks.com/aws/en/genie-agents/conversation-api). | Validation SQL, reconciliation, and exception explanation only. |
| Omni AI | Included through the active saved Omni instance | Default option; no separate provider setup is required. OmniKit creates a stable provider reference to the active instance and uses the target model selected in the migration. The saved instance retains its encrypted Organization API key or PAT. The profile test verifies that link; every job result is treated as untrusted until it passes OmniKit's registered migration contract. See [Omni API authentication](https://docs.omni.co/api/authentication), [Create AI job](https://docs.omni.co/api/ai/create-ai-job), and [Omni REST APIs](https://docs.omni.co/api). | Default migration proposals through the linked Omni instance, with fail-closed post-validation before any reviewed change can proceed. |

The stored value is deliberately narrower than the upstream identity configuration: Snowflake Cortex and Databricks Genie store only the generated OAuth access token, not client secrets or refresh tokens; Omni AI stores a linked saved-instance ID and reuses that instance's encrypted key or PAT without duplicating it. OAuth access tokens are short-lived bearer values, and OmniKit does not refresh them. Replace them before expiration. Never paste any provider credential into prompts, source exports, fixture files, screenshots, issue text, or Git-tracked configuration. Revoke and replace a credential at the provider if exposure is suspected.

#### Power BI manual support matrix

| Source evidence | Manual support | How OmniKit treats it |
| --- | --- | --- |
| Direct `.pbix` | Supported with the first-party engine | Validates the ZIP-based container, enforces entry, expansion, size, checksum, and traversal limits, then normalizes model and report evidence in a temporary local workspace. Raw PBIX bytes are deleted after analysis and are never sent to the selected LLM. |
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

#### First-party deterministic migration engine

OmniKit owns a tracked read-only extraction and deterministic translation package at `packages/omnikit-migration-engine`. The engine is not a second control plane: it never receives Omni credentials and contains no branch, write, dashboard-build, merge, or approval authority. OmniKit remains the sole owner of vault access, decisions, compilation, writes, validation, and reconciliation.

Install or refresh the isolated local runtime from the OmniKit checkout:

```bash
npm run setup:migration-engine
```

The setup command requires Python 3.11 or newer, installs the runtime from the generated `requirements-hashed.lock` with pip hash enforcement, copies the tracked package into ignored `data/migration-engine/`, creates an isolated cross-platform virtual environment, records both dependency-lock hashes, source revision and content hash, contract checksums, installed production dependency/license inventory, and verifies the engine's `write_authority: false` capability boundary. It also runs independent conformance contracts for Looker, Power BI, Tableau, Metabase, and Sigma. The installed runtime and uploaded artifacts are never tracked by git.

Before release, verify the installed runtime against its source, dependency lock, contracts, live capabilities, and live conformance evidence:

```bash
npm run verify:migration-engine
```

The verifier intentionally fails when the installed first-party package, dependency lock, contract, capability response, or conformance evidence drifts from its manifest. Run `npm run setup:migration-engine` after changing the tracked package, then rerun the verifier. Permissions and schedules can be preserved as source evidence and explicit migration requirements, but the read-only engine does not recreate them; OmniKit never claims they were migrated without separate target validation.

Run credential-gated extraction against the real local control plane before certifying a source. Keep the native vault unlocked, save the source connection and target Omni instance there, and use only their non-secret IDs. The command accepts no API-key, password, token, or client-secret flags and refuses non-local OmniKit URLs. The current acceptance harness covers Looker, Metabase, and Sigma Saved API paths plus explicit Power BI and Tableau local exports. Newly implemented Tableau PAT, Power BI/Fabric OAuth, and Strategy session collectors remain `implemented_unvalidated` in the source registry until the acceptance harness and live campaigns cover them:

```bash
npm run accept:migration-engine -- --source looker --connection-id <vault-source-id> --target-instance-id <vault-target-id> --dashboard-id <dashboard-id>
npm run accept:migration-engine -- --source metabase --connection-id <vault-source-id> --target-instance-id <vault-target-id> --dashboard-id <dashboard-id>
npm run accept:migration-engine -- --source sigma --connection-id <vault-source-id> --target-instance-id <vault-target-id> --dashboard-id <workbook-or-page-id>
npm run accept:migration-engine -- --source powerbi --target-instance-id <vault-target-id> --artifact /path/report.pbix
npm run accept:migration-engine -- --source tableau --target-instance-id <vault-target-id> --artifact /path/workbook.twbx
```

Use `--url http://127.0.0.1:5176` when the app is running on another local port, repeat `--dashboard-id` to verify scoped extraction, and set `OMNIKIT_LIVE_CONNECTION_OVERRIDES_JSON` when a run must exercise explicit source-to-target connection decisions. Successful runs write **provisional** mode/count/hash/runtime evidence to ignored `data/migration-engine/live-acceptance/`. Provisional evidence cannot promote a source.

Complete the customer-safe review template at `config/migration-engine-acceptance-review.template.json`. It requires evidence hashes and zero failures for semantic translation, branch deployment, Omni validation, dashboard reconstruction, query-result reconciliation, permission/schedule gap reporting, and visual/structural reconciliation. Every partial or unsupported capability listed in the provisional evidence must have an owner, rationale, due date inside the review window, and a disposition of `accepted`, `deferred`, or `blocking`; blocking, unreviewed, unowned, or overdue gaps fail closed. Finalize it with:

```bash
npm run finalize:migration-engine:acceptance -- \
  --evidence data/migration-engine/live-acceptance/looker-<timestamp>.json \
  --review /path/to/completed-acceptance-review.json
```

The finalized v3 evidence identifies a clean OmniKit commit, installed engine revision, named owner, target reference hash, review checksum, evidence expiry, all eight stages, and accountable gap dispositions. It excludes artifact names and paths, raw bytes, formulas, generated YAML, credentials, dashboard IDs, connection IDs, target instance IDs, and reviewer notes. Professional Looker promotion requires separate finalized Manual LookML and Saved API records produced from the same clean commit and installed runtime. See `docs/releases/migration-engine-live-acceptance.md` for the complete workflow.

For Looker, complete the paired campaign template outside the repository and run
`npm run verify:looker-acceptance-campaign`. The verifier binds both finalized
records to one representative project and target environment, requires distinct
development branches, checks complete dashboard/tile accounting, and compares
only evidence that overlaps between authoritative raw LookML and compiled API
responses. Manual-only source dependencies remain explicit review items; they
are not treated as API parity. The verifier also enforces the centralized
acceptance thresholds and current rollback proof. Contract tests do not
substitute for this credential-gated live campaign, and Looker remains Preview
until explicit promotion.

Engine rollout is source-specific and reversible:

| Source | Authoritative path | Engine role | Immediate rollback |
| --- | --- | --- | --- |
| Domo, Strategy, WebFOCUS | OmniKit guided parsers | Strategy has an unvalidated Saved API definition collector; Domo and WebFOCUS retain their source-specific boundaries | Keep the native/manual parser active |
| Power BI PBIP/PBIR/TMDL/scanner | OmniKit parser | Engine is authoritative only for direct `.pbix` when configured primary | Disable Power BI engine mode; use PBIP or supported exports |
| Looker | OmniKit fallback | Raw LookML via Manual Files plus compiled Explore/dashboard/query evidence via scoped Looker API | Set Looker to `shadow` or `off` |
| Tableau | OmniKit artifact fallback | Structured workbook/data-source parsing | Set Tableau to `shadow` or `off` |
| Metabase | OmniKit API fallback | API/MBQL normalization | Set Metabase to `shadow` or `off` |
| Sigma | OmniKit API fallback | API/formula normalization; layout remains limited by source evidence | Set Sigma to `shadow` or `off` |

#### Sigma migrations

The Sigma connector is **Preview**, read-only, and shadow-evaluated. Saved API uses
a Sigma API client ID and secret, exchanged server-side for a short-lived OAuth
token. Selected Data Model `/spec` responses are authoritative model definitions;
workbook endpoints provide content, query, lineage, grant, and schedule evidence but
are not labeled as a portable workbook specification. Manual Files accepts only the
versioned offline API snapshot produced by the same collector, not arbitrary workbook
JSON.

OmniKit inventories bounded data models, sources, fields, workbooks, pages, elements,
controls, generated-SQL fingerprints, lineage, grants, export schedules, and
materialization schedules. Collection is not a support claim: generated SQL is evidence,
not source-query validation; grid layout is unavailable; and input tables, writeback,
actions, permissions, schedules, materializations, and unsupported formulas remain
explicit migration decisions or governed handoffs. Planning fails when collection stops
early or warning-only access produces no accepted inventory. Representative live Sigma
tenant acceptance is required before this connector can be evaluated for primary rollout.

#### Professional Domo migrations

The native Domo path is **Preview**, not GA. Manual Files and Saved API acquisition
normalize into the same Domo v2 evidence contract before scope, decisions,
compilation, validation, dashboard construction, and reconciliation.

- **Saved API** supports two independent documented server-side credentials: a
  tenant-bound Product API developer token and optional Platform OAuth client
  credentials. The Product token supplies Product Search, DataSet definition/access,
  Page/Card membership, and Beast Mode evidence; OAuth supplements authoritative
  Chart Card definitions, Card drill properties, Page detail, and PDP policy lists. Neither secret nor the
  short-lived OAuth token reaches the browser. Any evidence class not supplied by the
  configured credential combination remains an exact-scope Preview handoff and
  continues to block Apply-to-Dev and release readiness until validated.
- **Truthful collection states** distinguish failed access, verified empty results,
  partial collection, and a genuine safety bound. An upstream permission failure is
  never relabeled as a safety-bound truncation or a ready zero inventory. A clean
  bounded discovery catalog can validate tenant access, but it is never migration
  evidence. Prepare an exact visible Page or Card, or use focused Manual Files when
  the required root is outside the catalog window.
- **Manual Files** accepts related JSON, SQL, text, or one bounded ZIP. The guided
  review recognizes Pages, Page/Card links, Cards, schemas, Beast Modes, SQL
  DataFlows, relationships, Variables, drill paths, filters/interactions,
  PDP/access, ownership/usage, schedules/alerts, and platform handoffs before
  planning.
- **Automatically prepared evidence** includes Page/Card closure, shared dataset
  dependencies, Card Analyzer fields, filters, sorts, limits, date grain,
  summary-number logic, drill references, Variables, and visual intent when the
  source provides them. Row-level Beast Modes become dimension candidates;
  aggregate and analytic Beast Modes become measure candidates; FIXED functions
  require level-of-detail review. Shared formulas are planned once while
  same-name different-formula and field collisions remain additive decisions.
- **Owner-reviewed outcomes** include DataSet-to-warehouse mapping, relationship
  cardinality, Variable controls, PDP row-filter and column-masking behavior,
  content access, ownership, usage, schedules, and alerts. OmniKit records the
  disposition and reconciliation result; it does not claim source permissions or
  deliveries were silently recreated.
- **Export-required evidence** stays blocking when configured APIs do not expose
  enough Card bindings, schema, DataFlow, governance, or operational detail.
- **Governed handoffs** cover non-SQL Magic ETL, recursive/snapshot/append data
  processing, Workbench jobs, connectors, Workflows, Forms, Code Engine, App
  Studio/custom apps, and Domo Everywhere embeds. OmniKit does not invent a
  translation for executable, undocumented, or application-specific behavior.

The detailed [Domo-to-Omni migration guide](docs/migrations/domo-to-omni.md)
documents the development flow, evidence requirements, translation matrix,
completion gates, and official Domo and Omni references used by the AI context.

Before promoting Domo beyond controlled Preview use, complete paired sanitized
Manual Files and Saved API evidence outside the repository using
`config/domo-live-acceptance-evidence.template.json`, complete the campaign based
on `config/domo-live-acceptance-campaign.template.json`, and run:

```bash
npm run verify:domo-acceptance-campaign -- \
  --campaign /path/to/domo-campaign.json \
  --manual-evidence /path/to/domo-manual-final.json \
  --api-evidence /path/to/domo-api-final.json
```

The verifier requires one clean release and parser contract, the same source
scope and target environment, distinct isolated branches, complete Page/Card and
dependency accounting, zero silent omissions, parity evidence, named approval,
and current rollback proof. Detailed evidence stays in the approved external
evidence system; only templates and validation logic belong in this repository.
See `docs/migrations/domo-to-omni.md` for the support matrix and operator flow.

#### Professional Looker migrations

The professional Looker path is **Preview**, not GA. Manual LookML projects and
vault-backed Saved API acquisition normalize into the same canonical IR V2 shape,
but they carry different authority. Saved API supplies compiled Explore,
dashboard, Look, and query evidence; it does not retrieve raw LookML. Git or Manual
Files must supply the selected `.lkml` include closure, refinements, Liquid, PDT
source, manifests, and tests before release-complete migration. The deterministic
engine remains in `shadow` until measured parity, finalized live acceptance, a
named approval, and a current rollback drill permit primary use; the native
normalized parser remains available as the immediate fallback.

Current support is deliberately explicit:

| Capability | Status |
| --- | --- |
| Views, fields, standard measures, Explores, and explicitly defined supported joins | Partial deterministic candidate with operator validation |
| Dashboard queries, fields, sorts, limits, filters, and listeners | Deterministic candidate with tile-by-tile reconciliation |
| Parameters, access filters, Liquid, refinements, table calculations, and pivots | Decision required |
| SQL PDT persistence, access grants, required grants, and user attributes | Typed blocker; map or redesign before generation |
| Field data actions, merged results, and arbitrary custom visuals | Unsupported; explicit waiver or redesign required |
| Permission assignments and schedules | Unsupported; reconcile independently |

Every generated target query must execute before completion, every dashboard tile
and filter-listener binding must have a recorded outcome, hidden computation
fields remain dependency-only, and unsupported behavior is never silently
discarded. Roll back the deterministic path without removing the native fallback:

```bash
npm run rollback:migration-engine -- --source looker --by "<owner>" --reason "<reason>"
```

See [`docs/migrations/looker-to-omni.md`](docs/migrations/looker-to-omni.md) for
the acquisition contracts, support matrix, validation sequence, reconciliation
format, promotion thresholds, and source-specific rollback procedure.

`off` uses the native path, `shadow` runs a developer-only sanitized parity comparison without changing inventory, decisions, files, or dashboard plans, and `primary` allows reviewed engine evidence into the normal OmniKit workflow. The default is `shadow`. Shadow runs append only counts, versions, latency, and numeric parity scores to ignored `data/migration-engine/parity-observations.json`; no source content, formulas, names, or model output is retained there. A requested `primary` mode is downgraded to `shadow` until the source has a passing same-runtime observation window, a named release owner, and a completed rollback drill.

Parity evidence names its comparison honestly. `native_differential` means OmniKit generated a comparable
native baseline on the server from the same scoped API inventory or a separately supplied project/export;
the browser cannot submit a score. `canonical_conformance` means no comparable old path was available and
the run was checked only against the reviewed source contract. Canonical conformance is useful release
evidence, but it is never described as old-versus-new parity and cannot by itself certify a source.

#### Add or certify a migration source

Migration source behavior is governed by `config/migration-source-adapters.json`, the functional ownership matrix in `config/migration-ownership.json`, and the versioned rulebook snapshot in `contracts/migration-source-rulebook.v1.json`. The registry records extraction ownership, API/manual acquisition support, runtime lifecycle, release stage, certification state, parser path, synthetic fixture, and whether live acceptance is required. `synthetic_regression` proves parser stability only; it never means a source is live-certified or generally available.

Create a fail-closed skeleton:

```bash
npm run create:migration-source-adapter -- --source example_bi --label "Example BI"
```

The generator creates an `unsupported` parser and synthetic fixture, disables both acquisition paths, assigns no production owner, and adds a draft rulebook entry. Before enabling it:

1. Assign a control-plane owner and reviewer in the ownership registry.
2. Implement bounded acquisition and normalization without provider credentials or target write authority.
3. Add a fictional fixture that exercises semantic, dashboard, governance, and unsupported-feature evidence.
4. Version the source rulebook and add regression evaluations for every supported artifact class.
5. Run `npm run verify:migration-source-adapters` and the focused Semantic Migration Studio suite.
6. Capture credential-gated live acceptance against a representative source and target, then collect the required shadow observations.
7. Promote only with named approval and a rehearsed rollback. New connectors cannot move from `unsupported` or `shadow` based on synthetic fixtures alone.

Run the product-level release certificate with `npm run certify:migration-studio`. It verifies source contracts, ownership, rulebooks, repository hygiene, exact-SHA release scope, documentation, engine readiness, and the full security/test/typecheck/lint/build/bundle-budget gate. Use `-- --skip-full-gate` only for local diagnostics; a skipped gate can never produce `previewReady` or `releaseReady`. Preview workflows use `--require-preview-ready` and must prove the exact clean scope, full gate, diagnostics, benchmark, clean-room runtime, SBOM, and valid governance structure. Release tags use the stricter `--require-release-ready`, which additionally fails closed unless every governance decision, operational-evidence, live-acceptance, rollout, and GA-stage requirement passes. The certificate reports credential-dependent live acceptance, representative Omni entitlement checks, provider tests, named approval, and rollback drills as external pending gates rather than manufacturing a pass.

For a release candidate, first generate the clean, exact-commit scope, prove the first-party engine works without the retired repository, verify an encrypted backup without replacing the active vault, and collect operational qualification:

```bash
npm run prepare:migration-studio:release -- --require-clean --output artifacts/release/migration-studio-release-scope.json
npm run verify:migration-studio:clean-room
npm run backup:omnikit-state -- --output /approved/offline/path/omnikit-vault-backup.enc
npm run verify:omnikit-backup -- --backup /approved/offline/path/omnikit-vault-backup.enc --manifest /approved/offline/path/omnikit-vault-backup.enc.manifest.json --output artifacts/release/omnikit-backup-verification.json
npm run qualify:migration-studio:operations -- --source looker
```

`npm run verify:release-governance` validates the owner-ready configuration and required governance files, but it does not claim remote GitHub settings were observed. Exact-commit repository protection evidence can be supplied to certification with `--governance-evidence /path/to/repository-governance-evidence.json`. Missing owners, support targets, legal approval, branch-protection proof, live credentials, or human acceptance remain explicit blockers.

Review source readiness before promotion. The report distinguishes runtime
rollout state (`shadow`, `eligible`, `primary`, or `rolled_back`) from product
release stage (`development`, `preview`, `ga_candidate`, or `ga`), includes
native-source ownership, and never reads raw source artifacts:

```bash
npm run report:migration-engine
```

After reviewing at least 20 same-runtime Looker shadow observations, finalizing both Manual LookML and Saved API acceptance, and recording a current passing rollback drill, create the ignored promotion record explicitly:

```bash
npm run promote:migration-engine -- --source looker --acceptance data/migration-engine/live-acceptance/looker-manual-<timestamp>-final.json --acceptance data/migration-engine/live-acceptance/looker-api-<timestamp>-final.json --approved-by "Release Owner" --rollback-drill "looker-rollback-2026-07"
```

The command consumes the versioned policy in `config/migration-engine-promotion-policy.json` and refuses mixed engine/parser/rulebook windows, missing acquisition modes, a managed-runtime provenance mismatch, provisional or expired acceptance, incomplete stage evidence, unreviewed capability gaps, incomplete target connection mapping, an unknown or stale runtime-bound rollback drill, failing conformance evidence, fewer than 20 same-runtime Looker observations, or any score below the centralized threshold. There is no automatic promotion or native-parser deletion. Roll back a promoted source explicitly; this appends who made the decision and why to the audit history, and the server immediately downgrades requested primary mode to shadow:

```bash
npm run rollback:migration-engine -- --source looker --by "Release Owner" --reason "Observed extraction regression"
```

The first published result contract is `omnikit.migration.bundle.v1`; unknown contracts fail closed, and a future contract must be added alongside the previous released schema before deprecation. Run `npm run test:e2e:migration-engine` for the deterministic synthetic-fixture dry-run smoke test plus acceptance-harness security tests.

The contract's reviewed Draft 2020-12 schema is pinned at
`tests/fixtures/migration-engine/omnikit.migration.bundle.v1.schema.json`. The bridge test checks its
content hash, validates the shared engine fixture with Ajv, and rejects nested identity drift. For a
first-party engine release, dispatch `.github/workflows/migration-engine-release.yml`. The workflow
installs the package tracked in the same OmniKit revision, runs its Python suite and bridge E2E test,
verifies installed-runtime provenance, and executes the full security gate. This proves package compatibility, not source
certification: each source still needs its own passing live-acceptance evidence and rollback drill.

### Administration workflow details

- **Labels** in Content Operations — bulk apply or remove labels from selected content.
- **Schedules** in Content Operations — review, pause, resume, trigger, or delete scheduled deliveries. Read-only readiness keeps latest observed delivery evidence separate from mutation controls.
- **User Management** in Identity & Access — manage users and groups, including bulk operations and user-health review for inactive source records or embed entities without active users. Unknown or failed reads do not create false zero-user findings.
- **Embed URLs** in Embed & Developer Tools — generate Standard SSO URLs for approved implementation workflows without retaining the request secret or a recent signed-URL ledger.

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
- **Encrypted Fleet history.** Complete portfolio refreshes can retain one compact summary per UTC day in the same encrypted native vault. History is same-day idempotent, bounded to 90 days, and excludes raw identity records, emails, credentials, URLs, and upstream responses. Partial or interrupted scans do not add a daily history entry.
- **Legacy multi-instance cutover.** Instance Manager can import compatible `omni-multi-instance-tools` vault files after the native vault is unlocked. The legacy passphrase is used only for that local import request, valid profiles are re-encrypted into the native vault, duplicate base URLs are skipped, and unsupported legacy-only settings are reported in the dry-run summary.
- **Vault idle auto-lock.** The native vault auto-locks after local server idle time. Override the timeout with `OMNIKIT_VAULT_IDLE_TIMEOUT_MS`.
- **Local JSON job history.** Multi-instance migration jobs are stored in `./data/omnikit-jobs.json` by default with job metadata, status, warnings, retry lineage, and post-action results. API keys, bearer tokens, card-like numbers, emails, and phone numbers are redacted before job history is written.
- **Compatibility-first proxy guardrails.** The generic proxy only forwards HTTPS requests to Omni `/api/v1` paths. Other Omni API surfaces used by the app, such as SCIM, embeds, and dashboard import/export, go through dedicated handlers.
- **AI intake is bounded.** AI Content Studio accepts no more than five image or PDF attachments, caps each image at 3 MiB, and caps the UTF-8 prompt plus decoded attachments at approximately 15 MiB. Manual BI Migration Studio artifacts remain local or vault-gated according to their source workflow, and raw migration files are not written to the migration audit ledger by default.
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
| `npm run setup:migration-engine` | Install the tracked first-party migration engine into the ignored local runtime and run its source conformance contracts. |
| `npm run generate:migration-engine:hash-lock` | Regenerate the pip hash-enforced runtime lock from `requirements.lock` and `uv.lock`. |
| `npm run verify:migration-engine` | Prove the installed first-party engine's source content, lockfile, contracts, dependencies, live capabilities, and five-source conformance before release. |
| `npm run report:migration-engine` | Report per-source shadow observations, live acceptance, promotion eligibility, primary state, and rollback state. |
| `npm run diagnose:migration-engine` | Generate sanitized local runtime, vault-permission, lock-integrity, disk, queue, governance, and source-stage diagnostics. |
| `npm run benchmark:migration-engine` | Measure credential-free conformance latency, throughput, peak RSS, failures, and timeouts against configurable release thresholds. |
| `npm run prepare:migration-studio:release` | Bind deployable file hashes, exact commit SHA, dirty state, and prohibited-content checks into a sanitized release-scope manifest. |
| `npm run verify:migration-studio:clean-room` | Prove the first-party runtime installs from OmniKit without the retired migrator repository. |
| `npm run backup:omnikit-state` | Create a mode-preserving, checksum-bound encrypted-vault backup without reading secrets. |
| `npm run verify:omnikit-backup` | Verify an encrypted backup in an isolated temporary path without overwriting the active vault. |
| `npm run qualify:migration-studio:operations` | Reconcile diagnostics, benchmarks, clean-room, backup, scope, and runtime-bound rollback evidence. |
| `npm run verify:release-governance` | Validate declared owners, support/license decisions, required files, and optional exact-commit repository-policy evidence. |
| `npm run verify:bundle-budgets` | Measure the production manifest against entry, route, chunk, stylesheet, and total JavaScript budgets. |
| `npm run accept:migration-engine` | Run scoped live-source extraction through the local control plane and write sanitized provisional acceptance evidence. |
| `npm run finalize:migration-engine:acceptance` | Bind a completed, customer-safe downstream review to provisional evidence and produce promotion-eligible final evidence. |
| `npm run verify:looker-acceptance-campaign` | Verify a sanitized paired Manual Files and Saved API Looker campaign, including selected-scope accounting, overlap reconciliation, distinct evidence authority, isolated branches, approval, and rollback evidence. |
| `npm run verify:domo-acceptance-campaign` | Verify a sanitized paired Manual Files and Saved API Domo campaign, including the exact tested API authentication mode, Page/Card/dependency accounting, parity, isolated branches, approval, and rollback evidence. |
| `npm run promote:migration-engine` | Promote one source only after same-runtime parity, live acceptance, named approval, and rollback-drill gates pass. |
| `npm run rollback:migration-engine` | Record an accountable rollback and return a promoted source to shadow mode. |
| `npm run drill:rollback:migration-engine` | Exercise the isolated promotion-ledger rollback transition and record sanitized drill evidence. |
| `npm run create:migration-source-adapter -- --source <id> --label <name>` | Generate a fail-closed source parser, fixture, registry entry, and draft rulebook in `unsupported` state. |
| `npm run verify:migration-source-adapters` | Verify source ownership, lifecycle, parser paths, fictional fixtures, and versioned rulebooks. |
| `npm run certify:migration-studio` | Run product-level migration release certification, including repository hygiene, source conformance, documentation, readiness, and the full repository gate. |
| `npm run test:e2e:migration-engine` | Run the deterministic synthetic-fixture bridge and queue smoke tests against the installed first-party engine. |
| `npm run test:migration-engine:python` | Run the complete first-party Python migration-engine test suite. |
| `npm run security:python` | Audit the exact hash-locked Python runtime dependencies for known vulnerabilities. |
| `npm run security:licenses` | Enforce the reviewed npm and Python dependency license policy. |
| `npm run security:sbom` | Generate an ignored CycloneDX release SBOM under `artifacts/security/`. |
| `npm run security:supply-chain` | Run npm and Python vulnerability audits, license policy, and SBOM generation. |
| `npm run test:dashboard-safe-copy` | Run the complete non-destructive Dashboard Migrator contract, resolver, runtime, recovery, retry, and frontend-state suite. |
| `npm run test:browser:dashboard-safe-copy` | Run the dedicated three-screen Dashboard Safe Copy Chromium workflow suite. |
| `npm run test:browser:model-migrator-ux` | Run the Model Migrator scope, handoff, cancellation, and target-reset Chromium suite. |
| `npm run test:dashboard-migration` | Run the legacy Dashboard Migrator compatibility suite retained for existing-job recovery and the internal rollback path. |
| `npm run test:migration-planner` | Run focused Dashboard Migrator planner tests. |
| `npm run test:model-migrator` | Run focused Model Migrator inventory helper tests. |
| `npm run test:user-health` | Run focused User Management health tests. |
| `npm run test:workspace-snapshot` | Run focused Home workspace snapshot count tests. |
| `npm run test:fleet-admin:contracts` | Run every focused Fleet and Administration data-truth, readiness, identity, content, SSO, deep-link, and progressive-disclosure contract suite. |
| `npm run test:browser:release` | Run the deterministic Chromium release sequence for Fleet, routing, Administration, UI hardening, Dashboard Safe Copy, Model Migrator, BI Migration Studio, and accessibility. |
| `npm run test:release-gate-coverage` | Verify recursively that the canonical package and CI gates reach every test suite without missing scripts or command cycles. |
| `npm run test:security` | Run focused vault, job-history, and post-action security regression tests. |
| `npm run security:audit` | Run `npm audit --audit-level=moderate`. |
| `npm run security:check` | Run the canonical local release gate: supply-chain controls, the full Python migration suite, all focused JavaScript/TypeScript and Chromium suites, typechecks, lint, build, and bundle budgets. |

CI first runs `npm run test:release-gate-coverage`, then invokes the same `npm run security:check` command used locally. The structural guard reads the command graph without launching product tests; it prevents a newly added suite, missing script, or command cycle from silently falling outside the canonical release gate.

### Live E2E gate

Before claiming live-tenant completion or cutting a release, run the automated gate above and spot-check these vault-mode flows against an approved non-production saved instance without destructive actions:

1. Start OmniKit with a short idle timeout, for example `OMNIKIT_VAULT_IDLE_TIMEOUT_MS=10000 npm run dev`.
2. Unlock the native vault with no active working-instance selection and confirm Fleet Command Center still renders all saved-instance evidence.
3. Exercise all five Fleet views, supported filters, and instance/connection drilldowns. Reconcile zero, unavailable, partial, stale, failure, attribution, coverage, source, and freshness labels against the returned API evidence.
4. Open each canonical Administration workspace and its preserved legacy aliases. Verify readiness using read-only controls and inspect any action-required deep links without changing tenant settings.
5. In Embed & Developer Tools, verify Standard SSO validation and confirmation behavior only with an approved non-production test identity and secret-handling procedure; do not retain or capture the secret.
6. Wait for the idle timeout and confirm Home returns to the vault unlock prompt. Unlock again and confirm the prior working-instance selection can resume without altering Fleet scope.
7. Start a migration job only when separately authorized, lock the vault, cancel the running job, and confirm cancel succeeds while retry still requires the vault to be unlocked.

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
- `OMNIKIT_MIGRATION_SOURCE_HOST_ALLOWLIST` — optional comma-separated hostname allowlist enforced for every Saved API source request. Include each source tenant host plus any documented fixed identity/API hosts used by that connector. Power BI service-principal connections require `login.microsoftonline.com`, `api.fabric.microsoft.com`, and `api.powerbi.com` in addition to the configured workspace context.
- `OMNIKIT_MIGRATION_MAX_PROMPT_CHARS` — optional combined system-plus-user character budget for Semantic Migration Studio provider requests. Default is `500000` and the hard maximum is `1000000`. Oversized requests receive `413`; OmniKit never silently truncates a migration contract.
- `OMNIKIT_MIGRATION_ENGINE_ENABLED=false` — disable the first-party engine and use existing OmniKit parser fallbacks during rollback or troubleshooting.
- `OMNIKIT_MIGRATION_ENGINE_SOURCES` — optional comma-separated engine source allowlist (`looker,metabase,powerbi,sigma,tableau`) for source-by-source rollout and rollback.
- `OMNIKIT_MIGRATION_ENGINE_MODE` — requested default engine mode: `off`, `shadow`, or `primary`. The safe default is `shadow`; ungated primary requests remain shadow.
- `OMNIKIT_MIGRATION_ENGINE_MODE_LOOKER` (and `_POWERBI`, `_TABLEAU`, `_METABASE`, `_SIGMA`) — source-specific mode override.
- `OMNIKIT_MIGRATION_ENGINE_PROMOTION_PATH` — optional path to the sanitized source promotion ledger. Default is ignored `data/migration-engine/promotions.json`.
- `OMNIKIT_MIGRATION_ENGINE_PARITY_PATH` — optional path to the sanitized shadow-observation ledger. Default is ignored `data/migration-engine/parity-observations.json`.
- `OMNIKIT_MIGRATION_ENGINE_ALLOW_UNGATED_PRIMARY=true` — emergency-only bypass for the promotion ledger. Normal rollout should never need this.
- `OMNIKIT_MIGRATION_ENGINE_BOOTSTRAP_PYTHON` — Python 3.11+ executable used to create the isolated first-party engine virtual environment.
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
- Fleet daily history is stored inside the encrypted native vault as compact, privacy-bounded summaries. It retains no raw users, emails, API credentials, tenant URLs, or upstream responses and accepts complete scans only.
- Standard SSO embed secrets are supplied for one local signing request and cleared after every attempt. OmniKit does not persist a recent signed-URL or secret ledger; treat the generated signed URL itself as sensitive and avoid logs, screenshots, issues, or shared browser history.
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
