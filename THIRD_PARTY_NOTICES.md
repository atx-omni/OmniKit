# Third-Party Notices

OmniKit includes and depends on third-party software. Dependency manifests and
lockfiles remain the authoritative package inventory for a given commit.

## OmniKit Migration Engine

The first-party package at `packages/omnikit-migration-engine` was consolidated
from:

- Repository: `https://github.com/exploreomni/omni-migrator`
- Source commit: `1e773399766dfc46e76fb84ac5f6f80bb7d1a607`
- License: Apache License 2.0

The complete Apache License 2.0 text is preserved at
`packages/omnikit-migration-engine/LICENSE`. Frozen source provenance,
checksums, included paths, excluded write paths, and the read-only security
boundary are recorded in
`packages/omnikit-migration-engine/PROVENANCE.json`.

## Dependency Notices

JavaScript dependencies are declared in `package.json` and
`package-lock.json`. Python migration-engine dependencies are declared in
`packages/omnikit-migration-engine/requirements.lock` and `uv.lock`.

The release process generates a dependency inventory and verifies the approved
license policy. This notice does not replace the license text or notice
obligations shipped by an individual dependency.
