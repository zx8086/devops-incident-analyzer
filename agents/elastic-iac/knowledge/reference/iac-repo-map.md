# IaC repo map

## Primary repo

- **Former path (pre-migration):** `gitlab.siobytes.cloud/siobytes/elastic-iac`
- **Real path:** `gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac`
- **GitLab project ID:** `82850717`
- **Default branch:** `main`
- **Sandbox:** `gl-testing` (optional single-node test cluster, ~$37/mo)

## Directory layout (verified live 2026-06-16)

Verify with `gitlab_get_repository_tree` on first bootstrap; this section is kept
current but the repo is ground truth. The repo has TWO trees that work together:

- **`environments/` — the per-cluster JSON config the agent edits.** Every `edit-*`
  / `add-*` / `resize-*` skill does a read-modify-write on a file under here. This is
  the surface the agent touches.
- **`stacks/` — the Terraform that CONSUMES `environments/`, organised by resource
  family (NOT by cluster).** This is what CI runs `terraform plan`/`apply` against.
  The agent never edits `stacks/` directly; it edits the JSON in `environments/` and
  CI re-plans.

```
.
├── environments/
│   ├── _deployments/                  # per-cluster deployment manifests (JSON)
│   │   ├── eu-b2b.json                 #   .version, elasticsearch.<tier>.size/max_size
│   │   ├── gl-testing.json            #   single-node sandbox manifest
│   │   ├── eu-cld.json   us-cld.json   ap-cld.json
│   │   ├── eu-cld-monitor.json   us-cld-monitor.json   ap-cld-monitor.json
│   │   ├── eu-onboarding.json   gl-cld-reporting.json
│   │   ├── versions.json   traffic-filters.json   terraform.tfvars
│   ├── _shared/                       # defaults each cluster inherits
│   │   ├── slo-defaults.json   dataview-defaults.json   space-defaults.json
│   │   ├── cluster-defaults-defaults.json   index-templates.json
│   │   ├── agent-integrations.json   defaults.tfvars
│   └── <cluster>/                     # per-cluster config families (the edit surface)
│       ├── lifecycle-policies/        # ILM policies — <policy>.json, phases hot/warm/cold/delete at top level
│       ├── alerting/                  # alert rules        (edit-alert-rule)
│       ├── slos/                      # SLO definitions    (edit-slo)
│       ├── dashboards/                # Kibana dashboards  (edit-dashboard, whole-file NDJSON)
│       ├── dataviews/                 # data views         (edit-dataview)
│       ├── cluster-defaults/          # total_shards_per_node etc. (edit-cluster-default)
│       ├── cluster-settings/   spaces/   security/         # (edit-space, grant-security-role)
│       ├── fleet-integrations/        # integration package pins (pin-fleet-integration)
│       ├── ingest-pipelines/          # @custom ingest pipelines
│       ├── agent-policies/   action-connectors/   ml/   siem/
│       ├── apm-service-groups/   maintenance-windows/   synthetics/
│       └── deployment.tfvars
├── stacks/                            # Terraform per RESOURCE FAMILY (CI plans this)
│   ├── deployments/                   # topology/version — consumes _deployments/*.json
│   ├── lifecycle-policies/   alerting/   slos/   dashboards/   dataviews/
│   ├── cluster-defaults/   cluster-settings/   spaces/   security/   siem/
│   ├── fleet-integrations/   ingest-pipelines/   agent-policies/   ml/
│   ├── apm-service-groups/   maintenance-windows/   synthetics/   transforms/
│   ├── watches/   osquery/   cases/   infrastructure/   action-connectors/
├── modules/                           # shared Terraform modules
├── synthetics/                        # synthetics monitor source (SYNTH_PUSH target)
├── scripts/   .tools/                 # CI helpers (tf-report.jq, drift-check, validate-changed.sh)
└── .gitlab-ci.yml                     # plan + apply + on-demand jobs (see below)
```

Live cluster set: `eu-b2b`, `eu-cld` (+`-monitor`), `ap-cld` (+`-monitor`),
`us-cld` (+`-monitor`), `gl-testing`, `eu-onboarding`, `gl-cld-reporting`.

## Pipeline conventions

- **MR plan/apply:** an MR on an `agent/*` branch runs the per-family `plan:*` jobs;
  apply is manual after merge. gl-testing is an optional single-node sandbox cluster.
- **On-demand jobs the agent triggers** (via `gitlab_trigger_*` MCP tools; pipeline
  variables in parentheses) — all present in `.gitlab-ci.yml`:
  - `drift-check-on-demand` (`DRIFT_CHECK=true`, `STACK`, `DEPLOYMENT`)
  - `drift-check-synthetics-on-demand` (`SYNTH_DRIFT_CHECK=true`, `DEPLOYMENT`)
  - `synthetics-push-on-demand` (`SYNTH_PUSH=true`, `DEPLOYMENT`)
  - `fleet-upgrade-preview-on-demand` / `fleet-upgrade-apply-on-demand`
    (`FLEET_UPGRADE_PREVIEW`/`FLEET_UPGRADE_APPLY=true`, `DEPLOYMENT`, `VERSION`)

## MR conventions

- Branch naming: `agent/<short>-<yyyymmdd>` for agent-opened branches
- CODEOWNERS gates approvers; squash on merge
- One MR per wave; do not bundle unrelated clusters

## Predecessors / forks

Reference the memory file `reference_elastic_iac_repo.md` for historical paths if needed for traceability.
