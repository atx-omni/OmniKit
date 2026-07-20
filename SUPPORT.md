# Support

## Release Boundary

OmniKit is distributed as source for a trusted operator to run locally. The
initial support boundary is one operator, one local vault, and a server bound to
localhost. Shared hosted deployment, tenant isolation, centralized access
control, and service-level guarantees are outside this release.

BI Migration Studio source connectors are Preview unless the source registry
states otherwise. Preview migrations require human review of semantic,
governance, permission, schedule, and dashboard-reconciliation gaps.

## Before Requesting Help

1. Record the exact Git commit.
2. Run `npm run diagnose:migration-engine`.
3. Run the focused command that failed.
4. Remove customer content, credentials, local file paths, and source IDs.
5. Include only the sanitized diagnostic report and fictional reproduction.

## Support Channels

- Product defect: use the GitHub bug template.
- Enhancement: use the GitHub feature template.
- Vulnerability: follow `SECURITY.md`; never create a public issue.
- Omni product or API behavior: verify against current official Omni
  documentation and include the documented endpoint or capability.

## What Support Does Not Cover

- recovery of a lost vault passphrase
- public hosting of the local server
- unsupported source-platform constructs
- customer data, credentials, or raw export review in public channels
- claims of semantic or visual equivalence without reconciliation evidence

The approved support owner and response targets are recorded in
`config/release-governance.json`. Empty values are release blockers, not
implicit promises.
