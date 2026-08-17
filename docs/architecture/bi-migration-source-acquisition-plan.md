# BI Migration Studio — Source Acquisition Implementation Plan

Status: contract-correction implementation is in progress as of 2026-08-13. Validation begins only after the full source patch and regression fixtures are frozen. Every Saved API collector remains `implemented_unvalidated` for release purposes until local validation, browser coverage, live-tenant acceptance, external governance, and online advisory gates are complete.

This plan governs Saved API and Manual Files acquisition for BI Migration Studio. It preserves existing manual workflows, uses only documented vendor APIs, and separates catalog inventory from migration-grade source evidence.

## Core rule

Inventory is discovery only. Analyze can use only selected-scope evidence that is revision-bound, fingerprinted, provenance-labeled, dependency-complete, and either authoritative or explicitly dispositioned for Preview. Apply to Dev remains blocked while any required source definition, behavior, or security evidence is unproven.

## Evidence classes

- `authoritative_definition`
- `compiled_definition`
- `discovery_metadata`
- `governance_evidence`
- `manual_required`

## Phase order

1. Reconcile and preserve the current uncommitted source/provider security work.
2. Add shared source-authentication policy, inventory/evidence contracts, secure transport, revision binding, provenance, and completeness rules.
3. Add truthful platform-specific connection and evidence UI states.
4. Finish provider authentication: OpenAI and Anthropic API keys; a Snowflake Cortex OAuth access token; and one OAuth-backed Databricks Genie provider.
5. Correct Looker raw-file assumptions and add compiled API evidence plus Manual/Git reconciliation.
6. Add Sigma Data Model specification evidence and Metabase serialization/API evidence.
7. Add Domo Product plus optional Platform OAuth evidence with exact manual gaps.
8. Add Tableau PAT artifact acquisition and Power BI/Fabric OAuth definition acquisition.
9. Add Strategy session acquisition and keep WebFOCUS Manual-first until stored-session credential security is approved.
10. Record implemented collectors as `implemented_unvalidated`; update release
    capability labels only after live acceptance.

## Platform matrix

| Source | Saved authentication | API evidence | Manual boundary |
| --- | --- | --- | --- |
| Domo | Product developer token; optional Platform OAuth client credentials | Beast Modes, DataSet metadata/schema/access, Card/Page definitions, OAuth Card drill properties, PDP, and supported governance/operations when the required credential family exists | Magic ETL/DataFlow definitions, App Studio, Product-only drill/PDP gaps, and undocumented behavior |
| Looker | API client ID and secret | Compiled Explores, dashboards, and Looks/queries | Raw LookML project, includes, refinements, Liquid, PDT source, tests, permissions, and schedules via Git/Manual Files or separately reviewed exports |
| Sigma | API client ID and secret | Data Model specification plus workbook/detail evidence | Unsupported workbook interactions, input tables/writeback and layout fidelity |
| Metabase | API key | Parsed serialization YAML where licensed; version-pinned API metadata, cards and dashboards | Unknown MBQL, unsupported serialization entries, and unavailable serialization/governance evidence |
| Tableau | PAT name and secret | Workbook/data-source downloads, Metadata API, permissions and schedules | Export-restricted artifacts, virtual-connection policies and unsupported layout behavior |
| Power BI/Fabric | Entra delegated OAuth or service principal | TMDL semantic model definition, PBIR/PBIR-Legacy report definition, and bounded workspace/item governance evidence actually returned by the configured token audiences | PBIP/PBIX/TMDL when definition APIs are unavailable or incomplete; behavioral review for reconstructed report interactions |
| Strategy | Username/password session login where supported | Authoritative reports, metrics and filters; dossier filter/selector and DataSet context | Complete dossier visual/layout/document package, ACLs, schedules, unsupported login modes or versions, and inaccessible dependencies via migration-package fallback |
| WebFOCUS | Not enabled; IBFS session login requires separate stored-password approval | No Saved API evidence is currently enabled. After approval, the documented REST path can be implemented for bounded repository, schedule, and governance evidence | Change Management ZIP or curated FEX/MAS/ACX remains the supported path |

## Shared implementation contract

The server exposes separate inventory and prepared-evidence operations. Prepared evidence contains:

- source connection ID and exact `connectionUpdatedAt`;
- source/tool contract and parser versions;
- selected root identifiers;
- deterministic scope fingerprint;
- normalized artifacts and object-level provenance;
- acquisition class for every artifact;
- dependency closure and missing dependencies;
- request, page, item and byte diagnostics;
- `complete`, `partial`, `bounded`, `failed`, or `manual_required` status.

Secrets, short-lived access tokens, session cookies and unredacted raw payloads never enter browser DTOs, logs, audit evidence or migration packages.

## Security requirements

- HTTPS and SSRF validation for every endpoint.
- Exact tenant and endpoint binding for stored credentials.
- Same-origin continuation and redirect rules.
- Timeouts covering response-body consumption.
- Bounded response size, pagination, item count and total requests.
- Strict success-body decoding; malformed HTTP 200 is a failure.
- Verified empty is distinct from acquisition failure.
- Exact secret and encoded/reflected-secret redaction.
- Connection revision checks before and after every acquisition.
- Provider revision checks before validation and queued execution.
- Manual Files remain available and Apply stays blocked on incomplete write evidence.

## Implementation exit criteria

Code implementation is complete only when every source has an explicit documented acquisition boundary, no discovery endpoint is treated as authoritative logic, unsupported paths route to Manual Files, and all shared UI/server contracts are wired. Validation runs only after the full implementation is complete, per the approved execution instruction.

The source-adapter registry distinguishes implementation from acceptance. An
`apiEvidence.preparedEvidence` value of `implemented_unvalidated` records that the
collector code exists; it does not promote the connector, certify live access, or
change its Preview/synthetic-regression status. WebFOCUS remains API-disabled and
Manual-only until stored-session credential handling receives separate security
approval.

## Validation record — pending

The corrected source contracts and regression fixtures must be frozen before validation starts. Record exact local results here only after that gate runs. Local success will not certify customer-tenant permissions, vendor response fidelity, operational ownership, or production acceptance, and no capability may be promoted from Manual/Preview solely on synthetic checks.
