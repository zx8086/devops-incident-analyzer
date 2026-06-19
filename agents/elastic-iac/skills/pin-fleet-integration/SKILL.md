---
name: pin-fleet-integration
description: Pin a Fleet integration PACKAGE version in IaC (read-modify-write integrations.json + open an MR). NOT a Fleet agent binary upgrade, NOT a cluster version change. Validates the alias exists and flags major bumps.
inputs:
  cluster: { type: string, required: true }
  integration: { type: string, required: true }          # alias key in integrations.json (e.g. "aws", "kafka", "system")
  integration_version: { type: string, required: true }  # target package version (e.g. "6.15.0")
  force: { type: boolean, required: false }               # force reinstall (higher risk); only if explicitly asked
---

# Pin a Fleet integration package version

Source of truth: `environments/<cluster>/fleet-integrations/integrations.json` — ONE aggregate file per deployment, keyed by integration alias:

```json
{
  "aws":   { "name": "aws",   "version": "6.14.2", "force": false },
  "kafka": { "name": "kafka", "version": "1.27.0", "force": false }
}
```

This is the integration **package** (EPM) version, distinct from:
- **Fleet agent BINARY upgrade** (`upgrade the agents to X`) — imperative, NOT Terraform, goes through the fleet-upgrade flow (SIO-913).
- **Cluster/deployment VERSION upgrade** (`upgrade eu-b2b to 9.4.2`) — the `_deployments/<cluster>.json` `version` field (version-upgrade workflow).

## The change (read-modify-write)

1. Read `environments/<cluster>/fleet-integrations/integrations.json` via `gitlab_get_file_content`.
   - A 404 means this deployment does not manage Fleet integrations — STOP and confirm the deployment, don't invent the file.
2. Confirm `<integration>` is an existing alias key. An unknown alias is a clarify ("check the alias"), never a new key — adding a bogus integration breaks the CI plan.
3. Set that alias's `version` (and `force` only if explicitly requested). Leave every other alias and field untouched. Preserve 2-space indent + trailing newline.
4. Commit to a branch + open the MR. CI computes the plan on the MR; a human merges and applies. Never apply.

## Risk

- **MINOR/PATCH bump** — MEDIUM. An EPM install can change ingest pipelines, mappings, and dashboards for that integration.
- **MAJOR bump** (leading integer increases) — HIGH. Major upgrades can introduce breaking schema/pipeline changes. Cite the integration changelog in the MR body and recommend a staging/dev deployment first.
- **`force: true`** — forces a reinstall even when already installed. Only set when the user explicitly asks; call it out in the diff and MR.
- **Stack-version compatibility** — the integration version must be compatible with the deployment's Elasticsearch/Kibana stack version. If unsure, note it as a reviewer check.

## Anti-patterns — refuse to write

- A new top-level integration key that doesn't already exist in the file (this is an ADD, not a version pin — out of scope for this skill).
- A downgrade without an explicit reason in the request (flag it; downgrades can leave indices on a newer mapping).
- Bundling multiple integration bumps in one MR — one integration per change so the plan and rollback stay clean.

## MR body

Use `knowledge/reference/mr-template.md` headings. Category: `fleet-integration`. Risk: MEDIUM (minor/patch) or HIGH (major). State the resolved version transition (`aws: 6.14.2 -> 6.15.0`), the single file touched, and the rollback (revert the MR; re-pin the prior version).
