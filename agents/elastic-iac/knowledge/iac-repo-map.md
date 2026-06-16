# IaC repo map

## Primary repo

- **Former path (pre-migration):** `gitlab.siobytes.cloud/siobytes/elastic-iac`
- **Real path:** `gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac`
- **GitLab project ID:** `82850717`
- **Default branch:** `main`
- **Pre-check sandbox:** `gl-testing` (mandatory first target, single-node, ~$37/mo)

## Expected directory layout

Verify with `gitlab_get_repository_tree` on first bootstrap; this is a guide, not ground truth.

```
.
├── stacks/
│   ├── gl-testing/             # single-node pre-check sandbox — first target always
│   ├── eu-b2b/                 # primary EU B2B observability cluster
│   ├── eu-b2b-dev/
│   ├── eu-b2b-stg/
│   ├── eu-cld/                 # EU consumer/D2C
│   ├── us-cld/                 # US consumer/D2C
│   └── <cluster>/
│       ├── topology.tf         # hot/warm/cold/frozen/coord/ml sizing
│       ├── ilm.tf              # ILM policies
│       ├── templates.tf        # index/component templates
│       ├── pipelines.tf        # ingest pipelines (logs@custom, etc.)
│       ├── transforms.tf
│       └── terraform.tfvars
├── modules/
│   ├── elastic-cloud-deployment/
│   ├── ilm-policy/
│   └── ...
└── .gitlab-ci.yml              # plan + apply pipelines per stack
```

## Pipeline conventions

- Manual trigger for `apply` on every stack.
- gl-testing always runs first; other stacks have `needs:` pointing at gl-testing's plan job in the same MR pipeline.

## MR conventions

- Branch naming: `agent/<short>-<yyyymmdd>` for agent-opened branches
- CODEOWNERS gates per-stack approvers
- Squash on merge
- One MR per wave; do not bundle unrelated clusters

## Predecessors / forks

Reference the memory file `reference_elastic_iac_repo.md` for historical paths if needed for traceability.
