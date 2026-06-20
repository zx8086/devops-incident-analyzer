# HANDOFF — SIO-977: wire modules/index-template into a dedicated stacks/index-templates stack

- **Date**: 2026-06-20
- **Ticket**: [SIO-977](https://linear.app/siobytes/issue/SIO-977) (repo Terraform wiring) — prerequisite for [SIO-978](https://linear.app/siobytes/issue/SIO-978) (agent workflow, already implemented)
- **Target repo**: gitlab.com `pvhcorp/dhco/observability/observability-elastic-iac`, project id **82850717**, default branch **main**
- **Suggested branch**: `agent/sio-977-index-templates-stack`
- **Parent work**: plan `.claude/plans/this-request-should-create-eager-mccarthy.md` (Workstream A)

## TL;DR

The agent side ([SIO-978](https://linear.app/siobytes/issue/SIO-978)) is done and green: a new `index-template-create` GitOps
workflow now lets the agent write `environments/<dep>/index-templates/*.json` files and open MRs. But those JSON
files do nothing until the elastic-iac repo has (1) the `modules/index-template` module extended to accept
`data_stream` + `ignore_missing_component_templates`, and (2) a dedicated `stacks/index-templates/` stack that
consumes them. **This handoff contains the exact, ready-to-commit content for that repo change.** It must land
before the agent's MRs will `terraform plan` cleanly.

## Why this is a handoff and not a committed MR

This session's connected `mcp-server-gitlab` exposes `gitlab_create_merge_request` and `gitlab_create_issue`
but **no branch-create or file-commit tool** — the write tools (`gitlab_create_branch`, `gitlab_commit_file`)
live inside the elastic-iac MCP server used by the agent at runtime, not in this session's toolset. There is no
local clone of the elastic-iac repo on disk, and the only git remote here is the GitHub project repo. So I could
not push these files myself. To land them: clone the repo (or use a session/tool with push + Maintainer access),
drop in the files below, push the branch, and open the MR. **The token must have Maintainer+ on protected `main`
to push a branch and open the MR** (per the drift-check permission learnings).

## Provider support (verified, elastic/elasticstack 0.16.1)

`elasticstack_elasticsearch_index_template` supports top-level `data_stream {}` (nested `hidden`,
`allow_custom_routing`), top-level `ignore_missing_component_templates`, `composed_of`, `priority`, and ILM
binding via `template.settings` → `index.lifecycle.name`. **`allow_custom_routing` is 8.x-only**; eu-b2b is 9.x,
so the agent writer omits it when false (default). The module change below mirrors that: emit `allow_custom_routing`
only when the JSON sets it true.

## Files to create / modify (table)

| File | Change |
|---|---|
| `modules/index-template/variables.tf` | add `data_stream` + `ignore_missing_component_templates` to the `index_templates` object |
| `modules/index-template/main.tf` | emit dynamic `data_stream {}` (allow_custom_routing only when true) + pass `ignore_missing_component_templates` |
| `stacks/index-templates/main.tf` | NEW — fileset → jsondecode → `module "index_templates"` |
| `stacks/index-templates/{backend,data,providers,versions,variables,outputs}.tf` | NEW — copied verbatim from `stacks/ingest-pipelines/` (deployment-agnostic) |
| `environments/eu-b2b/index-templates/terraform.tfvars` | NEW — eu-b2b config path + endpoint + SSM key |
| `.gitlab-ci.yml` (or stack-discovery list) | ensure `index-templates` is discovered; state name `eu-b2b-index-templates` |

---

## 1. `modules/index-template/variables.tf` (REPLACE the `index_templates` variable)

The `component_templates` variable above it is unchanged. Replace the `index_templates` variable block with:

```hcl
variable "index_templates" {
  description = "Map of index templates"
  type = map(object({
    name                               = string
    index_patterns                     = list(string)
    composed_of                        = optional(list(string), [])
    ignore_missing_component_templates = optional(list(string), [])
    priority                           = optional(number, 100)
    data_stream = optional(object({
      hidden               = optional(bool, false)
      allow_custom_routing = optional(bool, false)
    }), null)
    settings = optional(any, null)
    mappings = optional(any, null)
  }))
  default = {}
}
```

## 2. `modules/index-template/main.tf` (REPLACE the index_template resource)

The `elasticstack_elasticsearch_component_template "this"` resource above is unchanged. Replace the
`elasticstack_elasticsearch_index_template "this"` resource with:

```hcl
resource "elasticstack_elasticsearch_index_template" "this" {
  for_each = var.index_templates

  name                               = each.value.name
  index_patterns                     = each.value.index_patterns
  composed_of                        = each.value.composed_of
  ignore_missing_component_templates = each.value.ignore_missing_component_templates
  priority                           = each.value.priority

  dynamic "data_stream" {
    # Emit the block only when the JSON sets data_stream. allow_custom_routing is 8.x-only, so it is
    # set only when explicitly true (eu-b2b is 9.x; false is the ES default and is left unset).
    for_each = each.value.data_stream != null ? [each.value.data_stream] : []
    content {
      hidden               = data_stream.value.hidden
      allow_custom_routing = data_stream.value.allow_custom_routing == true ? true : null
    }
  }

  template {
    settings = each.value.settings != null ? jsonencode(each.value.settings) : null
    mappings = each.value.mappings != null ? jsonencode(each.value.mappings) : null
  }

  depends_on = [elasticstack_elasticsearch_component_template.this]
}
```

> NOTE: the agent writes `template.settings` as a nested JSON object (`{ index: { lifecycle: { name } } }`),
> which `jsonencode(each.value.settings)` serializes correctly. Verify on the first MR plan that the bound
> ILM policy shows up in the template settings (no drift).

## 3. NEW `stacks/index-templates/main.tf`

```hcl
locals {
  index_template_configs = {
    for f in fileset("${var.config_path}", "*.json") :
    trimsuffix(f, ".json") => jsondecode(file("${var.config_path}/${f}"))
  }
}

module "index_templates" {
  source = "../../modules/index-template"

  index_templates = local.index_template_configs
}
```

## 4. NEW `stacks/index-templates/*.tf` (copy verbatim from stacks/ingest-pipelines/)

These are deployment-agnostic — copy byte-for-byte from `stacks/ingest-pipelines/`:

`backend.tf` (the GitLab HTTP backend; STATE_NAME becomes `eu-b2b-index-templates` at init time):
```hcl
terraform {
  backend "http" {
    retry_wait_min = 5
  }
}
```

`data.tf`:
```hcl
locals {
  api_key = var.local_api_key
}
```

`providers.tf`:
```hcl
provider "elasticstack" {
  elasticsearch {
    endpoints = var.elasticsearch_endpoints
    api_key   = local.api_key
  }
}
```

`versions.tf`:
```hcl
terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    elasticstack = {
      source  = "elastic/elasticstack"
      version = "~> 0.16.0"
    }
  }
}
```

`variables.tf` — copy `stacks/ingest-pipelines/variables.tf` verbatim (declares `deployment_name`, `config_path`,
`elasticsearch_endpoints`, `aws_tooling_account_id`, `ssm_api_key_path`, `local_api_key`, `parameter_values`).

`outputs.tf`:
```hcl
output "index_template_ids" {
  description = "Created index template IDs"
  value       = module.index_templates
}
```

## 5. NEW `environments/eu-b2b/index-templates/terraform.tfvars`

(mirrors `environments/eu-b2b/lifecycle-policies/terraform.tfvars`)
```hcl
deployment_name         = "eu-b2b"
config_path             = "../../environments/eu-b2b/index-templates"
ssm_api_key_path        = "/elastic/observability/eu_b2b/es_api_key"
elasticsearch_endpoints = ["https://71bdf337bb454d7ba192142d5a9925cf.eu-central-1.aws.cloud.es.io:443"]
```

## 6. CI stack discovery

Confirm the pipeline enumerates the new `index-templates` stack (most likely automatic via a `stacks/*`
discovery in `.gitlab-ci.yml`; if stacks are listed explicitly, add `index-templates`). The per-combo state
name will be `eu-b2b-index-templates`.

## Verification

On the MR pipeline (read-only plan): confirm `terraform plan` runs for the `eu-b2b-index-templates` state and
shows **0 to add** (no config JSON yet) — the wiring alone is a no-op. Once the agent opens its config MR (or you
add the two JSON files manually), the same plan shows the two index templates as `to add`:
```
+ module.index_templates.elasticstack_elasticsearch_index_template.this["dev-staging-metrics-ilm-override"]
+ module.index_templates.elasticstack_elasticsearch_index_template.this["dev-staging-traces-ilm-override"]
Plan: 2 to add, 0 to change, 0 to destroy.
```

For reference, the two config JSON files the agent will generate (you can also add them by hand in this same MR
to make the wiring MR self-contained) — note `metrics@tsdb-settings` is deliberately ABSENT so custom metrics
stay out of time_series mode:

`environments/eu-b2b/index-templates/dev-staging-metrics-ilm-override.json`:
```json
{
  "name": "dev-staging-metrics-ilm-override",
  "index_patterns": [
    "metrics-*.dev-*",
    "metrics-*.stg-*"
  ],
  "composed_of": [
    "metrics@mappings",
    "data-streams@mappings",
    "metrics@settings",
    "metrics@custom"
  ],
  "ignore_missing_component_templates": [
    "metrics@custom"
  ],
  "priority": 350,
  "data_stream": {
    "hidden": false
  },
  "settings": {
    "index": {
      "lifecycle": {
        "name": "dev-staging-metrics"
      }
    }
  }
}
```

> NOTE: `settings` is a TOP-LEVEL key (the module reads `each.value.settings` and wraps it in the
> resource's `template{}` block itself). A `template`-nested key here is silently dropped by Terraform's
> object type conversion and the ILM binding is lost — this was caught reviewing MR !180.

`environments/eu-b2b/index-templates/dev-staging-traces-ilm-override.json`:
```json
{
  "name": "dev-staging-traces-ilm-override",
  "index_patterns": [
    "traces-*.dev-*",
    "traces-*.stg-*"
  ],
  "composed_of": [
    "traces@mappings",
    "data-streams@mappings",
    "traces@custom",
    "ecs@mappings"
  ],
  "ignore_missing_component_templates": [
    "traces@custom"
  ],
  "priority": 350,
  "data_stream": {
    "hidden": false
  },
  "settings": {
    "index": {
      "lifecycle": {
        "name": "dev-staging-traces"
      }
    }
  }
}
```

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Token lacks Maintainer+ on protected `main` → push/MR rejected | Med | Use a Maintainer PAT; see drift-check permission learnings |
| `composed_of` references a component template that doesn't exist on the cluster | Med | Those expected-missing (`*@custom`) are in `ignore_missing_component_templates`; the stock ones (`metrics@mappings`, `metrics@settings`, `data-streams@mappings`, `traces@mappings`, `ecs@mappings`) ship with the Elastic-managed templates — confirm on the plan |
| New template shadows an existing one for `metrics-*.dev-*` | Low | priority 350 is intentional; confirm no other template at ≥350 matches those patterns |
| CI doesn't auto-discover the new stack | Low | Add `index-templates` to the stack list in `.gitlab-ci.yml` if discovery is explicit |
| `allow_custom_routing` on 9.x | N/A | omitted when false (the only case here) by the dynamic block |

## Out of scope

- The agent workflow itself (done — [SIO-978](https://linear.app/siobytes/issue/SIO-978)).
- Importing the live `dev-staging-logs-ilm-override` into the repo.
- Index-template edit/delete workflows.
- Any deployment other than eu-b2b.

## Related code references / memory

- Agent change landed for [SIO-978](https://linear.app/siobytes/issue/SIO-978): `packages/agent/src/iac/nodes.ts`
  (`buildIndexTemplateConfig`, `proposeIndexTemplateCreate`, `indexTemplateTemplate`, parseIntent block,
  capability bullet, draftChange dispatch, reviewPlan descriptor/risk), `packages/agent/src/iac/state.ts`
  (`IacRequest.indexTemplates`), tests `packages/agent/src/iac/index-template-create.test.ts`.
- Memory: `reference_elasticstack_index_template_provider_schema`, `reference_iac_index_template_module_unwired`,
  `reference_elastic_iac_gitops_json_writer_pattern`, `reference_iac_index_template_unsupported_workflow`,
  `reference_driftcheck_main_pipeline_permission` (Maintainer+ on protected main),
  `reference_elastic_iac_migrated_to_gitlab_com`.
