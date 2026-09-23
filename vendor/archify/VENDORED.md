# Vendored Archify (SIO-1876)

Upstream: https://github.com/tt-a1i/archify (MIT, see LICENSE)
Commit: 8809b273c278a813a47fa37698864779c0d4cf08

Only the files needed to validate and render architecture diagrams are copied.
To refresh, from the repo root with an upstream checkout at $SRC:

```bash
SRC=~/WebstormProjects/archify; D=vendor/archify
cp -R $SRC/archify/{bin,renderers,assets,schemas,LICENSE,THIRD_PARTY_NOTICES.md} $D/
cp $SRC/archify/scripts/check-render-output.mjs $D/scripts/
```

Then update the commit above and run `cd apps/web && bun run test src/lib/server/archify`.

## Local patches (re-apply after a refresh)

1. `bin/archify.mjs` `runNode`: `maxBuffer: 64 * 1024 * 1024`. The final artifact checker prints
   about 2.9 MB of JSON for a 200-node diagram. The default 1 MB `spawnSync` buffer then fails with
   ENOBUFS, which `deliver` reports as "Final artifact check failed without a classified diagnostic".
   Worth reporting upstream.
