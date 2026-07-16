# BI Migration Studio Threat Model

Status: release control

## Scope And Security Invariants

This document covers source API inventory, manual source uploads, the optional
`omni-migrator` child process, AI-assisted translation, branch staging, dashboard
construction, reconciliation, and audit.

The invariants are:

- OmniKit owns credentials, approvals, writes, retries, reconciliation, and audit.
- `omni-migrator` is a read-only extraction and deterministic proposal engine.
- AI providers receive bounded normalized evidence and never receive write authority.
- Raw source artifacts are transient and never become job history or audit content.
- Generated semantic code is untrusted until schema validation and branch review pass.

## Assets

- Source BI credentials and source artifact contents.
- Omni API credentials and target instance identifiers.
- Semantic definitions, dashboard intent, lineage, permissions, and schedules.
- Human decisions, branch review evidence, reconciliation results, and audit records.
- Local vault ciphertext, migration-engine runtime, and promotion evidence.

## Trust Boundaries

| Boundary | Untrusted input | Control |
| --- | --- | --- |
| Browser to local server | Upload names, bytes, form values, project decisions | Vault gate, body limits, type validation, filename normalization, no browser-supplied parity scores |
| Source API to local server | Remote JSON, pagination tokens, metadata, errors | HTTPS and host policy, bounded pagination, response limits, schema normalization, redacted errors |
| Local server to AI provider | Normalized prompt evidence | Provider allowlist, task/schema allowlist, final prompt sanitation, output schema validation, no direct writes |
| Local server to child engine | Artifacts, source auth, scope | Allowlisted environment, no shell, bounded queue/time/CPU/memory/output, private temp directory, exact contract |
| Child engine to local server | JSON bundle, diagnostics, suggestions | Versioned schema, identity evidence, safe relative paths, control-character rejection, credential-echo rejection |
| Local server to Omni | Approved semantic files and dashboard plans | Dev branch only, compile/validate, explicit review checkpoint, scoped retry and reconciliation |
| Durable storage | Status, audit, parity, project metadata | Encrypted vault for secrets; sanitized hashes, counts, scores, IDs, and usage elsewhere |

## Attack Classes And Controls

### Malicious XML And Archives

- Tableau DTD and entity declarations are rejected before XML parsing.
- Archive traversal, absolute paths, duplicate names, symbolic links, encryption,
  entry count, expanded bytes, and compression ratio are rejected.
- PBIX/TWBX parsing is bounded and does not extract arbitrary members to disk.

### Parser And Resource Exhaustion

- Artifact count and aggregate bytes are bounded at both OmniKit and engine boundaries.
- Individual LookML files have a parser-specific size limit.
- Child concurrency, queue depth, runtime, memory, CPU, and output bytes are bounded.
- Malformed JSON, XML, LookML, and contract output fail closed.

### Path And Output Injection

- Browser upload names are reduced to safe basenames inside a private `0700` temp root.
- Engine suggestion paths must be safe relative semantic paths ending in `.view` or
  `.topic`, or the reserved `model` and `relationships` targets.
- ANSI escapes and disallowed control characters in child output are rejected.
- Child processes run without a shell and inherit only an allowlisted environment.

### Credential And Data Leakage

- Source and provider secrets live only in the encrypted local vault.
- Child errors redact secret-shaped values, URL userinfo, and exact source auth values.
- A successful child response is rejected if it echoes a supplied source credential.
- Audit, parity, history, and reconciliation records exclude raw artifacts, prompts,
  generated YAML, full AI responses, and credentials.
- Temporary engine workspaces use restrictive permissions and are removed in `finally`;
  startup scavenging removes abandoned workspaces without touching live owners.

### Untrusted Translation Or Write Escalation

- AI and deterministic suggestions are proposals with `approvedByUser: false`.
- Connection guesses marked ambiguous or unmatched cannot be auto-applied.
- Only reviewed files are compiled and staged to a dev branch.
- Primary engine promotion requires conformance, clean provenance, parity observations,
  a named approver, and a recorded rollback drill.

## Residual Risks

- Source vendor formats and APIs can change without notice; golden fixtures do not
  replace live customer-safe acceptance runs.
- A valid but adversarial semantic expression may still be logically harmful. Human
  diff review and Omni validation remain mandatory.
- Local malware or a compromised operating-system account can observe process memory.
  OmniKit is a local control plane, not a hardened multi-tenant secret service.
- Visual and query-result equivalence cannot be proven by structural parsing alone.
  Reconciliation and operator acceptance remain required.
- A real VertiPaq model and representative Tableau exports are required before those
  source paths can be promoted as primary-fidelity migrations.

## Verification

The release gate includes engine parser/bridge tests, OmniKit security regression tests,
contract and conformance checks, real-browser migration journeys, typechecks, lint,
build, dependency audit, and clean-diff checks. Credential-gated live acceptance is kept
separate and must be recorded as passed or pending; it must never be inferred from an
offline fixture.
