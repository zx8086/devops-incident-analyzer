# eu-b2b — SLO Infrastructure-as-Code specification

**Cluster:** eu-b2b (`71bdf337bb454d7ba192142d5a9925cf`), Kibana v9.4.0, eu-central-1
**Audience:** IaC team owning Elastic platform automation
**Status:** Specification — implementation owned by IaC team
**Background:** Today's incident (`eu-b2b_Incident_Log_2026-05-08.md`) was driven by 37 stale SLOs created via UI in Aug-2024 with default-aggressive settings. Recreation via UI surfaced two further problems documented below. This spec exists so SLOs are managed declaratively and consistently from this point forward.

---

## 1. Why the Kibana Create-SLO UI must not be used for Synthetics SLOs

Two distinct problems with the v9.4 Kibana UI for `sli.synthetics.availability`:

### 1.1 UI defaults are wrong for cluster scale

The Create-SLO form in v9.4 defaults to:

- `settings.frequency: "1m"` (heaviest possible — every-minute transform checkpoint)
- `settings.syncDelay: "1m"`
- `settings.syncField: null` (no high-water-mark hint, full date-range scan each cycle)

For a cluster carrying tens to hundreds of SLOs, `1m` frequency creates continuous heap pressure on the hot tier. Today's incident is the documented evidence: 37 SLOs running 14+ continuous transforms at this schedule pinned `instance-095`'s parent circuit breaker at 71% steady-state. Required settings are documented in §3.3 below.

### 1.2 UI populates `monitorIds[].value` with the wrong identifier

Observed in v9.4: the monitor selector dropdown writes the **saved-object UUID** (the `config_id` field in the data) to `monitorIds[].value`, e.g.:

```json
"monitorIds": [{"value": "87f7af20-bfb4-4eba-8638-8a8fa3f04ecf", ...}]
```

But the `sli.synthetics.availability` indicator queries the data on the `monitor.id` field, which for monitors deployed via Synthetics Project Monitors / CLI contains a different value:

```
CCI - Application Health - prd | Boomi AS2 Atom-eu-ediservices.prd-developer-experience
```

Result: SLO transforms run, find zero matching documents, status stays `NO_DATA` indefinitely, cards show grey/N/A on the SLOs page. Reproduced today on three freshly-created SLOs; all required a follow-up `PUT /api/observability/slos/{id}` to correct.

**Conclusion: do not use the UI for these SLOs.** Manage them through the Kibana SLO API exclusively, via Terraform.

---

## 2. Recommended Terraform implementation pattern

Elastic's official `elastic/elasticstack` Terraform provider does not (as of v0.11.x) expose a first-class `slo` resource. The pragmatic options:

### Option A (recommended): `Mastercard/restapi` provider

```hcl
terraform {
  required_providers {
    restapi = {
      source  = "Mastercard/restapi"
      version = "~> 1.19"
    }
  }
}

provider "restapi" {
  uri                  = var.kibana_base_url    # e.g. https://eu-b2b.kb.eu-central-1.aws.elastic-cloud.com
  write_returns_object = true
  headers = {
    Authorization = "ApiKey ${var.kibana_api_key}"
    "kbn-xsrf"    = "true"
    Content-Type  = "application/json"
  }
  create_method = "POST"
  update_method = "PUT"
}

resource "restapi_object" "slo" {
  for_each     = local.slos
  path         = "/api/observability/slos"
  update_path  = "/api/observability/slos/{id}"
  destroy_path = "/api/observability/slos/{id}"
  id_attribute = "id"
  data         = jsonencode(each.value.payload)
}
```

The `restapi` provider gives idempotent create/update/destroy against arbitrary REST endpoints. It is widely deployed and stable.

### Option B: `null_resource` with `local-exec`

Acceptable but not idempotent without extra effort. Only use if `restapi` cannot be added to the provider set.

### Option C: Custom Kibana provider

Wait for `elastic/elasticstack` to add native SLO support. Track Elastic's provider releases. Not blocking — Option A is sufficient.

---

## 3. Canonical SLO payload — Synthetics availability

### 3.1 Module structure

```hcl
# modules/elastic-synthetics-slo/main.tf

variable "monitor_id_string" {
  description = "The monitor.id field value as it appears in synthetics-* data, NOT the saved-object UUID. Format: '{monitor.name}-{observer.geo.name}-{project}'."
  type        = string
}

variable "monitor_display_name" {
  description = "Human-readable monitor name, used for the SLO label and Kibana display."
  type        = string
}

variable "tags" {
  description = "SLO tags. Must include domain, department, criticality, environment."
  type        = list(string)
}

variable "objective_target" {
  description = "Decimal target between 0 and 1. Default 0.99."
  type        = number
  default     = 0.99
}

locals {
  slo_payload = {
    name             = "SLO for monitor ${var.monitor_display_name}"
    description      = ""
    indicator = {
      type = "sli.synthetics.availability"
      params = {
        monitorIds = [{
          value = var.monitor_id_string
          label = var.monitor_display_name
        }]
        projects = [{ value = "*", label = "All" }]
        tags     = []
        index    = "synthetics-*"
        filter   = ""
      }
    }
    budgetingMethod = "occurrences"
    timeWindow = {
      duration = "30d"
      type     = "rolling"
    }
    objective = {
      target = var.objective_target
    }
    tags    = var.tags
    groupBy = ["monitor.name", "observer.geo.name", "monitor.id"]
    settings = {
      frequency             = "5m"
      syncDelay             = "5m"
      syncField             = "@timestamp"
      preventInitialBackfill = false
    }
  }
}

output "payload" {
  value = local.slo_payload
}
```

### 3.2 Mandatory field values — do not parameterise

These three settings exist because of today's incident root cause. They are not optional.

| Field | Required value | Reason |
|---|---|---|
| `settings.frequency` | `"5m"` | Hot-tier baseline heap protection |
| `settings.syncDelay` | `"5m"` | Match frequency, allow late-arriving data to settle |
| `settings.syncField` | `"@timestamp"` | High-water-mark hint reduces per-cycle scan cost |
| `indicator.params.monitorIds[].value` | The `monitor.id` data field value | The Kibana UI dropdown writes the wrong identifier (config_id UUID) — see §1.2 |

### 3.3 Tag schema requirement

Every SLO must carry these structured tags so cluster-wide queries and dashboards work:

- `domain:<domain>` — e.g. `domain:customer_collaboration_integration`
- `department:<department>` — e.g. `department:integration`
- `criticality:<level>` — `criticality:high`, `criticality:medium`, `criticality:low`
- `environment:<env>` — `environment:production`, `environment:staging`

Plus free-form descriptive tags (e.g. `api health`, `production`) as needed.

### 3.4 What to leave at API defaults

- `revision` — managed by Kibana
- `enabled` — defaults to `true`
- `version` — managed by Kibana
- `id` — autogenerated unless explicitly provided (we recommend letting Kibana generate)

---

## 4. The monitor.id discovery problem

Because the SLO needs the `monitor.id` *data field* string and not the saved-object UUID, the IaC pipeline needs a mechanism to resolve it.

### 4.1 Format observed (eu-b2b, today)

```
{monitor.name}-{observer.geo.name}-{project}
```

Concrete example:

```
CCI - Application Health - prd | Boomi AS2 Atom-eu-ediservices.prd-developer-experience
```

Decomposed:
- `monitor.name`: `CCI - Application Health - prd | Boomi AS2 Atom`
- `observer.geo.name`: `eu-ediservices.prd`
- project: `developer-experience`

### 4.2 Recommended discovery pattern (do not hardcode)

The format is convention, not contract — Elastic's Synthetics implementation can change it. Recommend the IaC pipeline derives the value at apply-time by querying the cluster:

```
GET synthetics-*/_search
{
  "size": 1,
  "query": {
    "bool": {
      "filter": [
        {"term": {"config_id": "<known-saved-object-uuid>"}},
        {"range": {"@timestamp": {"gte": "now-1h"}}}
      ]
    }
  },
  "_source": ["monitor.id", "monitor.name"]
}
```

Read `_source.monitor.id` from the response, write that into the SLO payload's `monitorIds[].value`. This avoids string-construction bugs if Elastic changes the format in a future version. Implementation can be a `data` source (custom provider) or an `external` data source running a small script.

### 4.3 Validation requirement

The IaC pipeline must **fail the apply** if the resolved `monitor.id` looks like a UUID (regex `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`). That's the signal the discovery query fell back to `config_id`, and the SLO will not work.

---

## 5. Worked example — Boomi AS2 Atom

```hcl
module "slo_boomi_as2_atom" {
  source = "./modules/elastic-synthetics-slo"

  monitor_id_string    = "CCI - Application Health - prd | Boomi AS2 Atom-eu-ediservices.prd-developer-experience"
  monitor_display_name = "CCI - Application Health - prd | Boomi AS2 Atom"
  objective_target     = 0.99

  tags = [
    "customer collaboration integration",
    "production",
    "api health",
    "domain:customer_collaboration_integration",
    "department:integration",
    "criticality:high",
    "environment:production",
  ]
}

resource "restapi_object" "slo_boomi_as2_atom" {
  path         = "/api/observability/slos"
  update_path  = "/api/observability/slos/{id}"
  destroy_path = "/api/observability/slos/{id}"
  id_attribute = "id"
  data         = jsonencode(module.slo_boomi_as2_atom.payload)
}
```

The resulting `restapi_object.id` is the SLO's UUID. Persist it in state for future updates and destroys.

---

## 6. Post-apply validation (mandatory in CI)

After every Terraform apply, a CI step must run the following check for each managed SLO:

```
GET kbn:/api/observability/slos/{id}
```

Assert all of the following or fail the deployment:

1. `settings.frequency == "5m"`
2. `settings.syncDelay == "5m"`
3. `settings.syncField == "@timestamp"`
4. `indicator.params.monitorIds[0].value` matches `^.+-.+-.+$` and does NOT match the UUID regex from §4.3
5. `enabled == true`

A second check, run 10 minutes after apply, must verify the SLO has progressed beyond `NO_DATA`:

```
GET kbn:/api/observability/slos/{id}
```

Assert `summary.status` is one of `HEALTHY`, `VIOLATED`, `DEGRADING` — never `NO_DATA` for a freshly-applied SLO targeting an actively-running monitor. `NO_DATA` after 10 minutes means the `monitor.id` lookup is wrong and §4.3 validation should have caught it.

---

## 7. Cluster-side guard rails (already applied)

The cluster has cluster-level safety nets to bound any single query, applied today:

- `search.max_buckets`: 65536
- `search.default_search_timeout`: 60s
- `indices.breaker.request.limit`: 40%
- `indices.breaker.total.use_real_memory`: true

The IaC layer does not need to manage these. They are persistent cluster settings. Documented for awareness so the IaC team knows the runtime envelope.

---

## 8. Open questions for IaC team

1. **Provider choice**: confirm `Mastercard/restapi` is acceptable, or pick alternative (Option B/C in §2).
2. **Discovery strategy**: confirm preference between Terraform `external` data source (script) and a custom provider for the `monitor.id` lookup in §4.2.
3. **State location**: where Terraform state for SLO definitions lives (existing remote backend?).
4. **Apply gate**: which team approves SLO changes — observability platform or service owners?
5. **Bulk migration**: do we want to back-fill the three SLOs created today through Terraform (recommended), or leave as-is and start managing only new SLOs from IaC?

---

## 9. Monitor catalog — the 28 SLOs to build

Captured 2026-05-08 from live `synthetics-*` data on eu-b2b. All 28 monitors are currently active. Three prefix groups requested by the platform owner:

- `Prana - API Health - prd` — 12 monitors, runs from `eu-oit.prd`, ~60 checks/hr each
- `DS - API Health - prd` — 15 monitors, runs from `eu-shared-services.prd`, ~60 checks/hr each
- `DS - Kafka Server - prd` — 1 monitor (`KSQL Db`), runs from `eu-shared-services.prd`, ~6 checks/hr (10-min interval)

**Note for the platform owner**: the `DS - Kafka` namespace also contains a larger `DS - Kafka Connector - prd` set (approximately 30 monitors covering individual Kafka source/sink connectors). That group is **not** included here — only `DS - Kafka Server - prd` was requested. If the Connector monitors should also have SLOs, that's a separate decision (it would push the catalog to ~58 SLOs and roughly double the SLO transform load on the hot tier).

### 9.1 Naming convention observed

For monitors deployed via Synthetics Project Monitors with the `developer-experience` project, the `monitor.id` value follows:

```
{monitor.name}-{observer.geo.name}-developer-experience
```

This is **the value the IaC must put in `indicator.params.monitorIds[].value`** — not the UUID.

### 9.2 DS — Digital Selling APIs (runs from `eu-shared-services.prd`)

| # | monitor.name | monitor.id (use this in SLO) | config_id (UUID — for reference only) |
|---|---|---|---|
| 1 | DS - API Health - prd \| Authentication | DS - API Health - prd \| Authentication-eu-shared-services.prd-developer-experience | 21dac874-a2ab-48eb-9acf-e611cc601b77 |
| 2 | DS - API Health - prd \| Brads | DS - API Health - prd \| Brads-eu-shared-services.prd-developer-experience | c77fed74-75d5-446c-901c-d7c843c697c4 |
| 3 | DS - API Health - prd \| Corrected-delivery-dates | DS - API Health - prd \| Corrected-delivery-dates-eu-shared-services.prd-developer-experience | d407b9b4-168b-4e19-bebc-9273e3b6cc1a |
| 4 | DS - API Health - prd \| Customer-assignments | DS - API Health - prd \| Customer-assignments-eu-shared-services.prd-developer-experience | dcc5d9af-17ed-4d71-ab72-23d586ce2e6b |
| 5 | DS - API Health - prd \| Distributioncurves | DS - API Health - prd \| Distributioncurves-eu-shared-services.prd-developer-experience | 2e9327b2-e0df-4a9d-84f1-971b52e004d0 |
| 6 | DS - API Health - prd \| Images | DS - API Health - prd \| Images-eu-shared-services.prd-developer-experience | adb44a70-90e7-4e8b-b9ab-24ef966ef458 |
| 7 | DS - API Health - prd \| Notifications-scheduler | DS - API Health - prd \| Notifications-scheduler-eu-shared-services.prd-developer-experience | 27542088-c229-4c2c-8b2f-4b1561ab2e73 |
| 8 | DS - API Health - prd \| Notifications-service | DS - API Health - prd \| Notifications-service-eu-shared-services.prd-developer-experience | 16c76c42-ef8b-4e51-a674-62aa2a39e687 |
| 9 | DS - API Health - prd \| Notifications-webhook | DS - API Health - prd \| Notifications-webhook-eu-shared-services.prd-developer-experience | 0c9b11af-d769-4434-b3f6-d7002280e73a |
| 10 | DS - API Health - prd \| Prepacks | DS - API Health - prd \| Prepacks-eu-shared-services.prd-developer-experience | e2bd83d2-19b6-4b7c-95e2-a96194d0917c |
| 11 | DS - API Health - prd \| Prices-api-v2 | DS - API Health - prd \| Prices-api-v2-eu-shared-services.prd-developer-experience | 30cf6dd4-af0a-4190-86e4-fe9ed15c7c03 |
| 12 | DS - API Health - prd \| Prices-producer-v2 | DS - API Health - prd \| Prices-producer-v2-eu-shared-services.prd-developer-experience | daa03b8a-9c33-43b1-9bd5-86e373b8596b |
| 13 | DS - API Health - prd \| Process-api | DS - API Health - prd \| Process-api-eu-shared-services.prd-developer-experience | 764b620b-1629-48a9-bcc1-1b795dc25d97 |
| 14 | DS - API Health - prd \| Storytelling | DS - API Health - prd \| Storytelling-eu-shared-services.prd-developer-experience | b6ed542d-4012-4a82-96fb-2b9824da3283 |
| 15 | DS - API Health - prd \| Styles-v3 | DS - API Health - prd \| Styles-v3-eu-shared-services.prd-developer-experience | 6e1ab650-8fac-44ea-b1ed-26023dfc9997 |

### 9.2.1 DS — Kafka Server (runs from `eu-shared-services.prd`)

| # | monitor.name | monitor.id (use this in SLO) | config_id (UUID — for reference only) |
|---|---|---|---|
| 1 | DS - Kafka Server - prd \| KSQL Db | DS - Kafka Server - prd \| KSQL Db-eu-shared-services.prd-developer-experience | b40a84fc-82ba-412c-bf82-faf828a946fd |

### 9.3 Prana — OIT APIs (runs from `eu-oit.prd`)

| # | monitor.name | monitor.id (use this in SLO) | config_id (UUID — for reference only) |
|---|---|---|---|
| 1 | Prana - API Health - prd \| Catalog Notification Service | Prana - API Health - prd \| Catalog Notification Service-eu-oit.prd-developer-experience | 96a73af9-cd63-44ed-9245-b69105bb41fd |
| 2 | Prana - API Health - prd \| Catalog Service | Prana - API Health - prd \| Catalog Service-eu-oit.prd-developer-experience | 20bb96f7-ddc0-4020-9d3a-8e7946296efb |
| 3 | Prana - API Health - prd \| Connectors Service | Prana - API Health - prd \| Connectors Service-eu-oit.prd-developer-experience | 7b2bcbef-80d4-44c0-8977-7d3012458a82 |
| 4 | Prana - API Health - prd \| Document Management Service | Prana - API Health - prd \| Document Management Service-eu-oit.prd-developer-experience | 7d412fbd-8046-4d83-b66c-957fcfb12ad6 |
| 5 | Prana - API Health - prd \| Email Service | Prana - API Health - prd \| Email Service-eu-oit.prd-developer-experience | 3896a7b7-3df7-4631-8280-b317f90419be |
| 6 | Prana - API Health - prd \| Import-Export Service | Prana - API Health - prd \| Import-Export Service-eu-oit.prd-developer-experience | 6bddfbe3-7997-4d8c-b90d-0a7324b894a1 |
| 7 | Prana - API Health - prd \| Localcore Service | Prana - API Health - prd \| Localcore Service-eu-oit.prd-developer-experience | 912be101-ec14-4968-ba35-b22a87e68000 |
| 8 | Prana - API Health - prd \| Notifications Service | Prana - API Health - prd \| Notifications Service-eu-oit.prd-developer-experience | 6f2ef284-9282-4580-a063-c4af632dd3a4 |
| 9 | Prana - API Health - prd \| Order Service | Prana - API Health - prd \| Order Service-eu-oit.prd-developer-experience | 868fc1ad-b90c-413a-8961-0f6224526d79 |
| 10 | Prana - API Health - prd \| Orders Service | Prana - API Health - prd \| Orders Service-eu-oit.prd-developer-experience | ee73ec1a-90fe-4161-a39a-2363bae1917a |
| 11 | Prana - API Health - prd \| Reporting Service | Prana - API Health - prd \| Reporting Service-eu-oit.prd-developer-experience | 590327cd-ea94-428c-b175-1308131ab54f |
| 12 | Prana - API Health - prd \| Users Service | Prana - API Health - prd \| Users Service-eu-oit.prd-developer-experience | cf9edba7-e42b-44cd-b185-947f7c6ab84c |

### 9.4 Ready-to-paste Terraform input — `locals` block

Drop this into the Terraform module that consumes the SLO module from §3.1. Tag values are placeholders aligned to the conventions used in the previously-deleted SLO batch — confirm with each owning team before apply.

```hcl
locals {
  ds_prd_monitors = {
    "authentication" = {
      monitor_id_string    = "DS - API Health - prd | Authentication-eu-shared-services.prd-developer-experience"
      monitor_display_name = "DS - API Health - prd | Authentication"
      tags = [
        "api health", "production", "digital selling",
        "domain:digital_selling", "department:digital_selling",
        "criticality:high", "environment:production",
      ]
    }
    "brads" = {
      monitor_id_string    = "DS - API Health - prd | Brads-eu-shared-services.prd-developer-experience"
      monitor_display_name = "DS - API Health - prd | Brads"
      tags = [
        "api health", "production", "digital selling",
        "domain:digital_selling", "department:digital_selling",
        "criticality:high", "environment:production",
      ]
    }
    "corrected_delivery_dates" = {
      monitor_id_string    = "DS - API Health - prd | Corrected-delivery-dates-eu-shared-services.prd-developer-experience"
      monitor_display_name = "DS - API Health - prd | Corrected-delivery-dates"
      tags = [
        "api health", "production", "digital selling",
        "domain:digital_selling", "department:digital_selling",
        "criticality:high", "environment:production",
      ]
    }
    "customer_assignments" = {
      monitor_id_string    = "DS - API Health - prd | Customer-assignments-eu-shared-services.prd-developer-experience"
      monitor_display_name = "DS - API Health - prd | Customer-assignments"
      tags = [
        "api health", "production", "digital selling",
        "domain:digital_selling", "department:digital_selling",
        "criticality:high", "environment:production",
      ]
    }
    "distributioncurves" = {
      monitor_id_string    = "DS - API Health - prd | Distributioncurves-eu-shared-services.prd-developer-experience"
      monitor_display_name = "DS - API Health - prd | Distributioncurves"
      tags = [
        "api health", "production", "digital selling",
        "domain:digital_selling", "department:digital_selling",
        "criticality:high", "environment:production",
      ]
    }
    "images" = {
      monitor_id_string    = "DS - API Health - prd | Images-eu-shared-services.prd-developer-experience"
      monitor_display_name = "DS - API Health - prd | Images"
      tags = [
        "api health", "production", "digital selling",
        "domain:digital_selling", "department:digital_selling",
        "criticality:high", "environment:production",
      ]
    }
    "notifications_scheduler" = {
      monitor_id_string    = "DS - API Health - prd | Notifications-scheduler-eu-shared-services.prd-developer-experience"
      monitor_display_name = "DS - API Health - prd | Notifications-scheduler"
      tags = [
        "api health", "production", "digital selling",
        "domain:digital_selling", "department:digital_selling",
        "criticality:high", "environment:production",
      ]
    }
    "notifications_service" = {
      monitor_id_string    = "DS - API Health - prd | Notifications-service-eu-shared-services.prd-developer-experience"
      monitor_display_name = "DS - API Health - prd | Notifications-service"
      tags = [
        "api health", "production", "digital selling",
        "domain:digital_selling", "department:digital_selling",
        "criticality:high", "environment:production",
      ]
    }
    "notifications_webhook" = {
      monitor_id_string    = "DS - API Health - prd | Notifications-webhook-eu-shared-services.prd-developer-experience"
      monitor_display_name = "DS - API Health - prd | Notifications-webhook"
      tags = [
        "api health", "production", "digital selling",
        "domain:digital_selling", "department:digital_selling",
        "criticality:high", "environment:production",
      ]
    }
    "prepacks" = {
      monitor_id_string    = "DS - API Health - prd | Prepacks-eu-shared-services.prd-developer-experience"
      monitor_display_name = "DS - API Health - prd | Prepacks"
      tags = [
        "api health", "production", "digital selling",
        "domain:digital_selling", "department:digital_selling",
        "criticality:high", "environment:production",
      ]
    }
    "prices_api_v2" = {
      monitor_id_string    = "DS - API Health - prd | Prices-api-v2-eu-shared-services.prd-developer-experience"
      monitor_display_name = "DS - API Health - prd | Prices-api-v2"
      tags = [
        "api health", "production", "digital selling",
        "domain:digital_selling", "department:digital_selling",
        "criticality:high", "environment:production",
      ]
    }
    "prices_producer_v2" = {
      monitor_id_string    = "DS - API Health - prd | Prices-producer-v2-eu-shared-services.prd-developer-experience"
      monitor_display_name = "DS - API Health - prd | Prices-producer-v2"
      tags = [
        "api health", "production", "digital selling",
        "domain:digital_selling", "department:digital_selling",
        "criticality:high", "environment:production",
      ]
    }
    "process_api" = {
      monitor_id_string    = "DS - API Health - prd | Process-api-eu-shared-services.prd-developer-experience"
      monitor_display_name = "DS - API Health - prd | Process-api"
      tags = [
        "api health", "production", "digital selling",
        "domain:digital_selling", "department:digital_selling",
        "criticality:high", "environment:production",
      ]
    }
    "storytelling" = {
      monitor_id_string    = "DS - API Health - prd | Storytelling-eu-shared-services.prd-developer-experience"
      monitor_display_name = "DS - API Health - prd | Storytelling"
      tags = [
        "api health", "production", "digital selling",
        "domain:digital_selling", "department:digital_selling",
        "criticality:high", "environment:production",
      ]
    }
    "styles_v3" = {
      monitor_id_string    = "DS - API Health - prd | Styles-v3-eu-shared-services.prd-developer-experience"
      monitor_display_name = "DS - API Health - prd | Styles-v3"
      tags = [
        "api health", "production", "digital selling",
        "domain:digital_selling", "department:digital_selling",
        "criticality:high", "environment:production",
      ]
    }
  }

  ds_kafka_prd_monitors = {
    "kafka_server_ksql_db" = {
      monitor_id_string    = "DS - Kafka Server - prd | KSQL Db-eu-shared-services.prd-developer-experience"
      monitor_display_name = "DS - Kafka Server - prd | KSQL Db"
      tags = [
        "kafka", "production", "digital selling",
        "domain:digital_selling", "department:digital_selling",
        "criticality:high", "environment:production",
      ]
    }
  }

  prana_prd_monitors = {
    "catalog_notification_service" = {
      monitor_id_string    = "Prana - API Health - prd | Catalog Notification Service-eu-oit.prd-developer-experience"
      monitor_display_name = "Prana - API Health - prd | Catalog Notification Service"
      tags = [
        "api health", "production", "prana",
        "domain:prana", "department:oit",
        "criticality:high", "environment:production",
      ]
    }
    "catalog_service" = {
      monitor_id_string    = "Prana - API Health - prd | Catalog Service-eu-oit.prd-developer-experience"
      monitor_display_name = "Prana - API Health - prd | Catalog Service"
      tags = [
        "api health", "production", "prana",
        "domain:prana", "department:oit",
        "criticality:high", "environment:production",
      ]
    }
    "connectors_service" = {
      monitor_id_string    = "Prana - API Health - prd | Connectors Service-eu-oit.prd-developer-experience"
      monitor_display_name = "Prana - API Health - prd | Connectors Service"
      tags = [
        "api health", "production", "prana",
        "domain:prana", "department:oit",
        "criticality:high", "environment:production",
      ]
    }
    "document_management_service" = {
      monitor_id_string    = "Prana - API Health - prd | Document Management Service-eu-oit.prd-developer-experience"
      monitor_display_name = "Prana - API Health - prd | Document Management Service"
      tags = [
        "api health", "production", "prana",
        "domain:prana", "department:oit",
        "criticality:high", "environment:production",
      ]
    }
    "email_service" = {
      monitor_id_string    = "Prana - API Health - prd | Email Service-eu-oit.prd-developer-experience"
      monitor_display_name = "Prana - API Health - prd | Email Service"
      tags = [
        "api health", "production", "prana",
        "domain:prana", "department:oit",
        "criticality:high", "environment:production",
      ]
    }
    "import_export_service" = {
      monitor_id_string    = "Prana - API Health - prd | Import-Export Service-eu-oit.prd-developer-experience"
      monitor_display_name = "Prana - API Health - prd | Import-Export Service"
      tags = [
        "api health", "production", "prana",
        "domain:prana", "department:oit",
        "criticality:high", "environment:production",
      ]
    }
    "localcore_service" = {
      monitor_id_string    = "Prana - API Health - prd | Localcore Service-eu-oit.prd-developer-experience"
      monitor_display_name = "Prana - API Health - prd | Localcore Service"
      tags = [
        "api health", "production", "prana",
        "domain:prana", "department:oit",
        "criticality:high", "environment:production",
      ]
    }
    "notifications_service" = {
      monitor_id_string    = "Prana - API Health - prd | Notifications Service-eu-oit.prd-developer-experience"
      monitor_display_name = "Prana - API Health - prd | Notifications Service"
      tags = [
        "api health", "production", "prana",
        "domain:prana", "department:oit",
        "criticality:high", "environment:production",
      ]
    }
    "order_service" = {
      monitor_id_string    = "Prana - API Health - prd | Order Service-eu-oit.prd-developer-experience"
      monitor_display_name = "Prana - API Health - prd | Order Service"
      tags = [
        "api health", "production", "prana",
        "domain:prana", "department:oit",
        "criticality:high", "environment:production",
      ]
    }
    "orders_service" = {
      monitor_id_string    = "Prana - API Health - prd | Orders Service-eu-oit.prd-developer-experience"
      monitor_display_name = "Prana - API Health - prd | Orders Service"
      tags = [
        "api health", "production", "prana",
        "domain:prana", "department:oit",
        "criticality:high", "environment:production",
      ]
    }
    "reporting_service" = {
      monitor_id_string    = "Prana - API Health - prd | Reporting Service-eu-oit.prd-developer-experience"
      monitor_display_name = "Prana - API Health - prd | Reporting Service"
      tags = [
        "api health", "production", "prana",
        "domain:prana", "department:oit",
        "criticality:high", "environment:production",
      ]
    }
    "users_service" = {
      monitor_id_string    = "Prana - API Health - prd | Users Service-eu-oit.prd-developer-experience"
      monitor_display_name = "Prana - API Health - prd | Users Service"
      tags = [
        "api health", "production", "prana",
        "domain:prana", "department:oit",
        "criticality:high", "environment:production",
      ]
    }
  }
}

module "ds_prd_slos" {
  for_each = local.ds_prd_monitors
  source   = "./modules/elastic-synthetics-slo"

  monitor_id_string    = each.value.monitor_id_string
  monitor_display_name = each.value.monitor_display_name
  tags                 = each.value.tags
}

module "ds_kafka_prd_slos" {
  for_each = local.ds_kafka_prd_monitors
  source   = "./modules/elastic-synthetics-slo"

  monitor_id_string    = each.value.monitor_id_string
  monitor_display_name = each.value.monitor_display_name
  tags                 = each.value.tags
}

module "prana_prd_slos" {
  for_each = local.prana_prd_monitors
  source   = "./modules/elastic-synthetics-slo"

  monitor_id_string    = each.value.monitor_id_string
  monitor_display_name = each.value.monitor_display_name
  tags                 = each.value.tags
}

resource "restapi_object" "ds_prd_slos" {
  for_each     = module.ds_prd_slos
  path         = "/api/observability/slos"
  update_path  = "/api/observability/slos/{id}"
  destroy_path = "/api/observability/slos/{id}"
  id_attribute = "id"
  data         = jsonencode(each.value.payload)
}

resource "restapi_object" "ds_kafka_prd_slos" {
  for_each     = module.ds_kafka_prd_slos
  path         = "/api/observability/slos"
  update_path  = "/api/observability/slos/{id}"
  destroy_path = "/api/observability/slos/{id}"
  id_attribute = "id"
  data         = jsonencode(each.value.payload)
}

resource "restapi_object" "prana_prd_slos" {
  for_each     = module.prana_prd_slos
  path         = "/api/observability/slos"
  update_path  = "/api/observability/slos/{id}"
  destroy_path = "/api/observability/slos/{id}"
  id_attribute = "id"
  data         = jsonencode(each.value.payload)
}
```

### 9.5 Cluster impact when this rolls out

28 SLOs at the mandatory `frequency: "5m"` settings produces 56 transforms (28 SLO + 28 SLO-summary). At 5-minute checkpoints these are roughly **5× the load of the current 6 SLO transforms** but well under the 14 SLO transforms at `1m` frequency the cluster was carrying before today's incident — so this is comfortably within capacity. The hot-tier parent breaker on instance-095 should remain at or below its current 34% baseline after these are applied.

If the instance-095 parent breaker rises above 60% steady-state after rollout, that is the signal to revisit topology. Until then, no scaling change required.

### 9.6 Notes for the IaC team on the tag values

The tag values in the locals block are *placeholders* aligned with the patterns used in the deleted Aug-2024 batch. Three specific calls before apply:

1. **`domain:` and `department:` for Prana** — confirm with the OIT team. `domain:prana` and `department:oit` are reasonable guesses; the team may prefer a different taxonomy.
2. **`domain:` and `department:` for DS API Health** — confirm with the Digital Selling team. `domain:digital_selling` and `department:digital_selling` mirror the previous batch but were not in the old SLOs (the old ones used `domain:customer_collaboration_integration` for the CCI subgroup). DS as a whole probably needs its own values.
3. **`domain:` and `department:` for DS Kafka Server** — confirm whether `domain:digital_selling` is correct or whether Kafka infrastructure should sit under a separate domain (e.g. `domain:streaming_platform`). The single `KSQL Db` monitor here is the seed for what may grow into a Kafka SLO portfolio (Server, Connector groups), so set the taxonomy intentionally now.

Don't apply with placeholders — get sign-off on tag conventions from each owning team first. Tags are how Kibana/Grafana dashboards filter by team.

---

## 10. References

- Today's incident log: `eu-b2b_Incident_Log_2026-05-08.md`
- Kibana SLO Update API (v9): https://www.elastic.co/docs/api/doc/kibana/v9/operation/operation-updatesloop
- Kibana SLO Create API (v9): https://www.elastic.co/docs/api/doc/kibana/v9/operation/operation-createsloop
- Mastercard restapi Terraform provider: https://registry.terraform.io/providers/Mastercard/restapi/latest/docs
- Elastic Synthetics Project Monitors: https://www.elastic.co/docs/solutions/observability/synthetics/use-monitor-management
