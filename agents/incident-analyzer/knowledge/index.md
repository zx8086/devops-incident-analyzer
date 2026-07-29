---
okf_version: 0.2
---

# incident-analyzer knowledge bundle

OKF v0.2 bundle root for the incident-analyzer agent. `okf_version` above is the only
frontmatter key OKF permits on a listing file, and only at the bundle root.

This file is **not** prompt-loaded: `knowledge/` is not a registered category in
`index.yaml`, and the loader reads only the `*.md` files directly under a registered
category's `path`.

## Categories

| Directory | `type:` values | Files |
|---|---|---|
| `runbooks/` | Runbook | 10 |
| `systems-map/` | Reference | 1 |
| `slo-policies/` | Reference | 1 |

## Producer extensions

Two non-OKF keys, both permitted (OKF allows extra keys and requires consumers to preserve
them):

- **`triggers:`** — the SIO-640 lazy runbook selection contract. 8 of the 10 runbooks declare
  it; a runbook without it opts out of trigger filtering, not out of the catalog. Configured
  by `runbook_selection` in `index.yaml`.
- **`tools:`** — the read-only tool list a runbook is permitted to cite (SIO-1288). When
  present it is the source of truth for the tool-citation validator; when absent the
  validator falls back to parsing the `## All Tools Used Are Read-Only` prose tail. All 10
  runbooks here declare it; elastic-iac's 6 still use the tail section.

  Frontmatter is preferred because the tail contract is "first non-empty line is a
  comma-separated list", which cannot distinguish a tool list from a sentence containing
  commas — in SIO-1278 explanatory prose there split into bogus tool names.

## Lifecycle

`status: draft|stable|deprecated` and `stale_after: YYYY-MM-DD` are honoured (SIO-1287):
`deprecated` is **binding** and drops the runbook from selection; a past `stale_after` is
**advisory** — it warns but keeps the file. An absent `status` means `stable` per OKF, so
absence never excludes.
