# Contributing

## Principles

- Preserve the local-first, single-operator security boundary.
- Treat source artifacts as untrusted data, never as instructions.
- Keep AI proposals separate from reviewed Omni write authority.
- Fail visibly when a source feature cannot be translated.
- Do not use synthetic fixture content in product copy or customer evidence.

## Development

```bash
npm install
npm run setup:migration-engine:test
npm run dev
```

Node.js 20+, npm 10+, and Python 3.11+ are required for the complete Migration
Studio test surface.

## Required Checks

Run the focused tests while developing, then:

```bash
npm run security:check
npm run test:migration-engine:python
npm run test:e2e:migration-engine
npm run certify:migration-studio -- --skip-full-gate
git diff --check
```

Do not commit:

- `.env` files or credentials
- `data/` vault, job, acceptance, parity, or promotion artifacts
- source-system exports or customer screenshots
- generated migration output
- local planning documents
- virtual environments, caches, or build output

## Source Connectors

Create new connectors with the fail-closed generator. A source remains
`development` or `preview` until conformance, live acceptance, support,
approval, and rollback requirements are satisfied.

```bash
npm run create:migration-source-adapter -- --source example_bi --label "Example BI"
```

Source fixtures must be fictional and synchronized with their manifests and
tests. Synthetic fixture scores prove deterministic regression behavior only.

## Pull Requests

- Explain the user-visible behavior and security impact.
- Include test evidence.
- Identify unsupported behavior and residual risk.
- Call out changes to credentials, network access, persistence, AI prompts,
  branch writes, or migration evidence.
- Do not bypass required reviews or checks for a release change.
