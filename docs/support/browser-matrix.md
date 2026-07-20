# Browser Support Matrix

## Initial Local Release

| Browser | Status | Release evidence |
| --- | --- | --- |
| Current Chromium / Google Chrome | Supported | Required critical-path and accessibility suites run in CI. |
| Current Firefox | Compatibility target | Playwright project is available for qualification; not an initial support claim. |
| Current WebKit / Safari | Compatibility target | Playwright project is available for qualification; not an initial support claim. |

OmniKit's initial release boundary is a local, single-operator application.
Browser support does not imply hosted, multi-user, or mobile support.

`npm run test:browser:migration-studio` is the required Chromium release gate.
`npm run test:browser:migration-studio:all` runs the same critical journeys in
Chromium, Firefox, and WebKit for compatibility qualification.
`npm run test:accessibility:migration-studio` checks the critical source
workflow against WCAG 2.0/2.1 A and AA rules and fails on serious or critical
findings.

Any future support claim must add that browser to required CI, complete manual
keyboard and visual checks, and update this matrix in the same release.
