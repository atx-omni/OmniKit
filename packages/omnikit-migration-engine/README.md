# OmniKit Migration Engine

This first-party package supplies BI Migration Studio with bounded, read-only source
extraction and deterministic source-to-Omni suggestions.

The package accepts only three process operations:

- `capabilities`
- `conformance`
- `extract`

It does not contain an Omni API client, target loader, branch writer, AI provider,
run store, or migration report generator. OmniKit retains credential custody,
review, compilation, target writes, validation, and audit responsibility.

The package was consolidated from the Apache-2.0
`exploreomni/omni-migrator` source recorded in `PROVENANCE.json`. The original
Apache-2.0 license is preserved in `LICENSE`.
