---
okf_version: 0.2
---

# elastic-iac knowledge bundle

OKF v0.2 bundle root for the elastic-iac agent. `okf_version` above is the only frontmatter
key OKF permits on a listing file, and only at the bundle root.

This file is **not** prompt-loaded: `knowledge/` is not a registered category in
`index.yaml`, and the loader reads only the `*.md` files directly under a registered
category's `path`. The same reason `_INDEX.md` is not loaded — pinned by
`packages/gitagent-bridge/src/elastic-iac-load.test.ts`.

## Deviations from OKF, and why

- **No per-directory `index.md`.** OKF's own examples put one in every directory, but any
  `index.md` inside a *registered* category directory WOULD be loaded into the prompt.
  Measured cost across the six categories: 3,997 bytes / +0.82%. Affordable, but the spec
  chose `_INDEX.md` (see below) because it is a proven, test-pinned convention needing no
  loader change. OKF §11 requires consumers to tolerate a missing `index.md`, so this is
  conformant. Decision: SIO-1282 spec, §6 Q1.
- **`_INDEX.md` is the human-readable inventory**, deliberately named so the loader skips it.
  It is the file to read for a full per-category listing; it is kept, not superseded.
- **`triggers:` is a producer extension** (SIO-640 runbook selection). OKF permits extra
  keys and requires consumers to preserve them.

## Categories

Registered in `index.yaml` and prompt-loaded. Per-intent selection is configured there
(`knowledge_selection`, SIO-1285).

| Directory | `type:` values | Files |
|---|---|---|
| `reference/` | Reference | 6 |
| `issues/` | Issue Register | 8 |
| `runbooks/` | Runbook | 6 |
| `specs/` | Change Spec | 4 |
| `cost-plans/` | Cost Plan | 6 |
| `playbook/` | Playbook Section | 11 |

On disk but **not** registered, so never prompt-loaded: `health-snapshots/` (stale
point-in-time reports, dropped in SIO-1285) and `_archive/` (superseded-docx traceability).

## Lifecycle

`status: draft|stable|deprecated` and `stale_after: YYYY-MM-DD` are honoured for every
category (SIO-1287 for runbook selection, SIO-1289 for the rest): `deprecated` is **binding**
and excludes the file from the prompt; a past `stale_after` is **advisory** — it warns but
keeps the file.
