# Browser Support Matrix

## Initial Local Release

| Browser | Status | Release evidence |
| --- | --- | --- |
| Current Chromium / Google Chrome | Supported | Required critical-path and accessibility suites run in CI. |
| Current Firefox | Compatibility target | Playwright project is available for qualification; not an initial support claim. |
| Current WebKit / Safari | Compatibility target | Playwright project is available for qualification; not an initial support claim. |

OmniKit's initial release boundary is a local, single-operator application.
Browser support does not imply hosted, multi-user, or mobile support.

The Tailwind CSS 4 styling pipeline requires Chrome 111+, Safari 16.4+, or
Firefox 128+ ([upstream browser requirements](https://tailwindcss.com/docs/upgrade-guide#browser-requirements)).
These are CSS engine minimums, not additional browser qualification claims;
current Chromium remains the supported release target above.

`npm run test:browser:release` is the required Chromium release gate. Focused
browser suites cover routing, Fleet and Administration workspaces, Dashboard
Safe Copy, Model Migrator, and accessibility-sensitive critical paths.

Any future support claim must add that browser to required CI, complete manual
keyboard and visual checks, and update this matrix in the same release.
