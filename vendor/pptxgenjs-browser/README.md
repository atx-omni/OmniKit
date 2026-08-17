# PptxGenJS browser runtime

This local package contains the official PptxGenJS 4.0.1 ES browser runtime and type declarations, under its MIT license.

It intentionally omits the upstream package's unused Node-only `image-size` dependency. OmniKit imports PptxGenJS only in the browser Deck Builder, and the reviewed ES runtime has no `image-size` import or parser code. This removes the unpatched `GHSA-w3rx-r6r6-pgpr` and `GHSA-5p2g-fcmc-qvqq` dependency path instead of relying on audit exceptions.

Provenance:

- Upstream: `https://github.com/gitbrent/PptxGenJS`
- Release: `4.0.1`
- Runtime SHA-256: `05844c5625e2cda3b449eb967c2246dd57ca57341886a7c28eeebca263b29bd4`
- Types SHA-256: `0726d015dbcb55ccfa75546cb2fd43fe13a0dfeb783d08572f1c62f59193bbe5`

Do not add Node image parsing to this package. A future upstream upgrade must replace the runtime and types together, update both hashes, retain the license, and pass the supply-chain and Deck Builder tests.
