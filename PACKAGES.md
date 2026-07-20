# Packages And Distribution

OmniKit is currently distributed as a source repository, not as a published package or hosted service.

## Current Distribution

- Clone from GitHub: `https://github.com/exploreomni/OmniKit.git`
- Install dependencies with `npm install`.
- Optionally install the read-only BI migration engine with `npm run setup:migration-engine` (Python 3.11+).
- Run locally with `npm run dev`.
- Build locally with `npm run build`.
- Serve a local production build with `npm run start` or `npm run serve`.

The repository includes the source code and lockfile needed to reproduce the app locally.

The source distribution includes:

- React/Vite UI source under `src/`
- Local Omni API handlers under `server/`
- Bundled public image/SVG assets under `public/`
- Documentation for setup, releases, package strategy, privacy, and security posture
- The npm lockfile for reproducible local installs

The source distribution intentionally does not include generated build output, temporary migration files, user-supplied workbooks, API keys, local browser data, or operator-specific exports.

The first-party migration engine is tracked at `packages/omnikit-migration-engine` and installed locally into ignored `data/migration-engine/`. Its isolated Python environment and installed source copy are runtime artifacts, not committed dependencies. The setup command installs exact versions from `requirements.lock`, verifies installed versions against that lock, records the lock SHA-256, frozen source provenance and content hash, contract checksums, Python package versions, and declared licenses in the ignored runtime manifest, and verifies that the embedded bridge exposes extraction capabilities only and explicitly reports no write authority. It also runs independent Looker, Power BI, Tableau, Metabase, and Sigma conformance contracts. Parser promotion is local and evidence-based: `npm run promote:migration-engine` reads only the ignored sanitized parity ledger and refuses promotion without one passing same-version observation window, a named approver, a recorded rollback drill, matching installed-runtime provenance, and passing conformance evidence.

Release operators must run `npm run verify:migration-engine` after installing a clean committed engine revision. The verifier recomputes source, lock, and contract hashes; compares live read-only capabilities and conformance with the manifest; and rejects installed dependency drift. Before source promotion, `npm run accept:migration-engine -- ...` exercises the same vault-gated local API used by BI Migration Studio and writes sanitized live evidence to ignored `data/migration-engine/live-acceptance/`. API credentials remain in the encrypted vault; manual exports remain transient and are not copied into evidence. Permissions and schedules remain explicitly unsupported by the current engine IR and cannot be represented as migrated output.

## GitHub Packages

OmniKit does not currently publish a GitHub Package.

This is intentional for the initial release because the operator workflow is clone-and-run:

- No npm package is required.
- No Docker image is required.
- No hosted backend is required.
- No package registry credentials are required.

## npm Package

OmniKit is not currently published to npm.

The `package.json` file is application metadata for local installation and scripts. It is not intended as a reusable library package.

## Build Artifacts

Build and runtime artifacts are intentionally excluded from the repository:

- `node_modules/`
- `dist/`
- `output/`
- `tmp/`
- logs
- environment files
- workspace-specific folders

Each operator should build artifacts locally from source.

AI Dashboard Studio Excel workbooks and BI Migration Studio source artifacts, migration bundles, and dashboard-build results are treated as user-provided working data. They are parsed or held in page memory for the active session and should not be committed to the repository unless a future release explicitly adds curated fixtures. Provider credentials and API source connections belong only in the encrypted native vault.

## Release Assets

No binary release assets are required for v1.0.0. The recommended package is the GitHub source repository itself.

Recommended install path:

```bash
git clone https://github.com/exploreomni/OmniKit.git
cd OmniKit
npm install
npm run setup:migration-engine # installs OmniKit's tracked first-party package; requires Python 3.11+
npm run verify:migration-engine # release gate for the installed first-party runtime
npm run accept:migration-engine -- --help # optional credential-gated source acceptance
npm run dev
```

## Future Packaging Options

If OmniKit needs a more formal distribution model later, the safest next options are:

- A signed GitHub Release source archive.
- A Docker image for controlled internal deployments.
- A desktop wrapper for single-user local operation.
- A hosted multi-user version with authentication, network controls, logging, and operational monitoring.

Do not expose the current local-first app directly to the public internet.
