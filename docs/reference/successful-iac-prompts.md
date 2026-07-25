# Successful elastic-iac Prompts

A catalog of real user prompts that produced a successfully **applied** elastic-iac merge request — concrete examples of "what to ask to get a working change." Sourced from the knowledge graph's `Prompt` -> `ConfigChange` -> `MergeRequest` chain (SIO-1202), filtered to `ConfigChange.outcome = 'applied'`.

## How this is populated

This doc is generated from the live knowledge graph, not hand-written. Call the curated MCP tool against a running elastic-iac deployment that has `KNOWLEDGE_GRAPH_ENABLED=true` and real turn history:

```text
kg_successful_prompts { "limit": 50 }
```

Reached at `http://127.0.0.1:9087/mcp` (in-process on the web app — see [knowledge-graph.md](../architecture/knowledge-graph.md#the-in-process-mcp-server-port-9087-sio-967)), or via the elastic-iac agent's tool belt directly. The tool returns rows shaped `{prompt, summary, workflow, mrUrl, createdAt}`; render each as one entry below, newest first.

**Known gap (SIO-1203): `kg_successful_prompts` misses changes with no linked Prompt.** The `Prompt` node was introduced in SIO-1038 (merged 2026-07-09); the knowledge graph itself was activated for elastic-iac earlier, in SIO-954 (merged 2026-06-19), which recorded `ConfigChange`/`MergeRequest` but never a prompt — so any change applied in that window is real and still in the graph, but has no `Prompt` to join, and `kg_successful_prompts`' strict join silently excludes it. A missing `Prompt` on a change recorded after SIO-1038 is also possible (the write is soft-failing), so an absent prompt means "not recorded", not a guaranteed date. For a complete historical count regardless of cause, call `kg_applied_changes` instead:

```text
kg_applied_changes { "limit": 50 }
```

It returns the same shape, but renders `(no prompt recorded)` in place of the prompt for rows with no linked `Prompt`, so they're still counted and dated even without the verbatim ask.

This repository's own worktrees have no local `.data/knowledge-graph` and no `lbug` install, so there is nothing to query from a dev sandbox — this catalog can only be populated from a real deployment that has actually run elastic-iac turns to completion (an MR opened, merged, and its pipeline applied).

## Entries

Populated via `kg_applied_changes { "limit": 200 }` (the 76-row full history, not just the 23 rows with a linked `Prompt`) so pre-SIO-1038 and any soft-failed-write changes are represented too, newest first:

### 2026-07-25T00:54:03.929Z — version-upgrade

**Prompt:**
> Upgrade eu-cld Elasticsearch deployment from 9.4.3 to 9.4.4.

**Result:** [eu-cld] 9.4.3 -> 9.4.4: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/352))

### 2026-07-22T21:44:11.446Z — version-upgrade

**Prompt:**
> upgrade us-cld deployment from 9.4.3 to 9.4.4

**Result:** [us-cld] 9.4.3 -> 9.4.4: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/346))

### 2026-07-22T17:15:03.353Z — version-upgrade

**Prompt:**
> Upgrade gl-cld-reporting d Elasticsearch deployment from 9.4.3 to 9.4.4.

**Result:** [gl-cld-reporting] 9.4.3 -> 9.4.4: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/333))

### 2026-07-22T15:57:10.662Z — version-upgrade

**Prompt:**
> Upgrade ap-cld Elasticsearch deployment from 9.4.3 to 9.4.4.

**Result:** [ap-cld] 9.4.3 -> 9.4.4: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/332))

### 2026-07-22T07:28:11.480Z — version-upgrade

**Prompt:**
> Upgrade ap-cld-monitor Elasticsearch deployment from 9.4.3 to 9.4.4.

**Result:** [ap-cld-monitor] 9.4.3 -> 9.4.4: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/329))

### 2026-07-21T22:25:09.701Z — version-upgrade

**Prompt:**
> Upgrade us-cld-monitor Elasticsearch deployment from 9.4.3 to 9.4.4.

**Result:** [us-cld-monitor] 9.4.3 -> 9.4.4: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/328))

### 2026-07-21T21:33:42.596Z — version-upgrade

**Prompt:**
> Foe the eu-cld-monitor deployment, upgrade the elastic version to 9.4.4

**Result:** [eu-cld-monitor] 9.4.3 -> 9.4.4: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/327))

### 2026-07-21T17:59:11.714Z — version-upgrade

**Prompt:**
> for eu-onboarding deployment, can you upgrade the elastic version to 9.4.4

**Result:** [eu-onboarding] 9.4.3 -> 9.4.4: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/326))

### 2026-07-13T17:02:49.363Z — ilm-rollout

**Prompt:**
> Deployment: eu-b2b
> Family:     config change
> Goal (1 line): raise the rollover safety floor's resolution so real low-volume streams roll
> over on schedule, while genuinely dead (0-doc) streams stay visibly parked instead of
> respawning empty shards forever.
>
> Target: lifecycle-policies stack, four files under environments/eu-b2b/lifecycle-policies/:
>   - logs-custom.json
>   - metrics-custom.json
>   - logs-apm.app_logs-default_policy.json
>   - traces-apm.rum_traces-default_policy.json
>
> End-state (field path: before -> after, top-level under "hot", sibling to "rollover"):
>   - logs-custom.json:                      hot.min_docs  1000    -> 1
>   - metrics-custom.json:                   hot.min_docs  500000  -> 1
>   - logs-apm.app_logs-default_policy.json: hot.min_docs  1000    -> 1
>   - traces-apm.rum_traces-default_policy.json: hot.min_docs 500  -> 1
>
> Scope fence: touch nothing else in any of the four files — not hot.max_age,
> hot.max_primary_shard_size, hot.priority, hot.rollover, and not warm/cold/frozen/delete in
> any file. Do not touch metrics-apm.app_metrics-default_policy.json or any synthetics-*.json
> policy — those have no min_docs field and their stuck-index behavior is unrelated.

**Result:** [eu-b2b] 4 ILM policies: hot min_docs=1: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/310))

### 2026-07-13T10:00:03.160Z — version-upgrade

**Prompt:**
> in eu-b2b, upgrade the elastic cloud deployment to 9.4.3

**Result:** [eu-b2b] 9.4.2 -> 9.4.3: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/308))

### 2026-07-13T02:33:13.837Z — version-upgrade

**Prompt:**
> in eu-cld-monitor, upgrade the elastic cloud deployment to 9.4.3

**Result:** [eu-cld-monitor] 9.4.2 -> 9.4.3: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/307))

### 2026-07-13T01:21:32.162Z — version-upgrade

**Prompt:**
> in us-cld, upgrade the elastic cloud deployment to 9.4.3

**Result:** [us-cld] 9.4.2 -> 9.4.3: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/306))

### 2026-07-13T01:00:39.369Z — version-upgrade

**Prompt:**
> in us-cld-monitor, upgrade the elastic cloud deployment to 9.4.3

**Result:** [us-cld-monitor] 9.4.2 -> 9.4.3: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/305))

### 2026-07-12T22:16:02.553Z — version-upgrade

**Prompt:**
> in ap-cld, upgrade the elastic cloud deployment to 9.4.3

**Result:** [ap-cld] 9.4.2 -> 9.4.3: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/304))

### 2026-07-12T22:11:11.370Z — version-upgrade

**Prompt:**
> in ap-cld-monitor, upgrade the elastic cloud deployment to 9.4.3

**Result:** [ap-cld-monitor] 9.4.2 -> 9.4.3: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/303))

### 2026-07-12T20:54:08.468Z — version-upgrade

**Prompt:**
> In gl-cld-reporting, upgrade the elastic version to 9.4.3

**Result:** [gl-cld-reporting] 9.4.2 -> 9.4.3: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/302))

### 2026-07-12T15:11:43.905Z — version-upgrade

**Prompt:**
> In eu-onboarding, update the elastic cloud version to 9.4.3

**Result:** [eu-onboarding] 9.4.2 -> 9.4.3: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/301))

### 2026-07-12T13:40:14.919Z — version-upgrade

**Prompt:**
> in gl-testing, can you update the elastic cloud version to 9.4.3

**Result:** [gl-testing] 9.4.2 -> 9.4.3: version-upgrade ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/299))

### 2026-07-11T23:14:14.760Z — ilm-rollout

**Prompt:**
> In ap-cld deployment:-
> environments/ap-cld/lifecycle-policies/ap-network-logs.json — delete phase:
>   - change min_age from "30d" to "14d"
> Leave delete_searchable_snapshot and all other phases (hot, warm, cold, frozen) unchanged.
> Env-scoped lifecycle-policies MR; plan = 1 ILM policy update in place, 0 add, 0 destroy. Anything else: stop and report.

**Result:** [ap-cld] ap-network-logs: delete min_age=14d: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/286))

### 2026-07-11T22:27:20.894Z — tier-resize

**Prompt:**
> In ap-cld deployment:-
> environments/_deployments/ap-cld.json — elasticsearch.frozen:
>   - change max_size from "15g" to "8g"
> Leave size ("8g"), instance_configuration_id, instance_configuration_version and zone_count unchanged.
> MR plan = 1 change in place (ec_deployment ap-cld: frozen size 15g→8g, max_size 15g→8g), 0 add, 0 destroy. Anything else: stop and report.

**Result:** [ap-cld] frozen -> max 8g: tier-resize ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/284))

### 2026-07-11T22:04:06.845Z — topology-edit

**Prompt:**
> In eu-onboarding deployment:-
> environments/_deployments/eu-onboarding.json — add top-level key:
>   "observability": {
>     "deployment_id": "e0d0b78a2c5a4f67872cfe178289b070",
>     "ref_id": "main-elasticsearch",
>     "logs": true,
>     "metrics": true
>   }
> Change nothing else in the file.
> MR plan = eu-onboarding shows no diff. Expected residual diffs, not caused by this MR: ap-cld frozen max_size, and eu-cld's observability strip if its MR hasn't landed yet. If eu-onboarding itself still shows any diff: stop and report.

**Result:** [eu-onboarding] observability -> e0d0b78a2c5a4f67872cfe178289b070: topology-edit ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/283))

### 2026-07-11T21:55:12.985Z — topology-edit

**Prompt:**
> In eu-cld deployment:-
> environments/_deployments/eu-cld.json — add top-level key:
>   "observability": {
>     "deployment_id": "e0d0b78a2c5a4f67872cfe178289b070",
>     "ref_id": "main-elasticsearch",
>     "logs": true,
>     "metrics": true
>   }
> Change nothing else in the file.
> MR plan = eu-cld shows no diff (its observability removal disappears from the shared-stack plan). Expected residual diffs in that plan, not caused by this MR: ap-cld frozen max_size, and eu-onboarding's observability strip until its own MR lands. If eu-cld itself still shows any diff: stop and report.

**Result:** [eu-cld] observability -> e0d0b78a2c5a4f67872cfe178289b070: topology-edit ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/282))

### 2026-07-11T20:03:29.744Z — tier-resize

**Prompt:**
> In ap-cld deployment:-
> environments/_deployments/ap-cld.json — elasticsearch.frozen:
>   - add "size": "8g"
>   - change max_size from "8g" to "15g"
> Leave instance_configuration_id, instance_configuration_version and zone_count unchanged.
> MR plan = 1 change in place (ec_deployment ap-cld: frozen size 15g→8g; max_size 15g matches state, no diff), 0 add, 0 destroy. Anything else: stop and report.

**Result:** [ap-cld] frozen -> 8g/max 15g: tier-resize ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/281))

### 2026-07-09T10:33:00.570Z — ilm-delete

**Prompt:**
> (no prompt recorded)

**Result:** [eu-b2b] remove ILM .alerts-ilm-policy: ilm-delete ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/268))

### 2026-06-29T12:53:29.161Z — ingest-pipeline-edit

**Prompt:**
> (no prompt recorded)

**Result:** [ap-cld] edit 1 ingest pipeline: drop-cisco-meraki-ip-session: ingest-pipeline-edit ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/264))

### 2026-06-27T18:11:00.547Z — tier-resize

**Prompt:**
> (no prompt recorded)

**Result:** [eu-b2b] hot -> 8g/max 15g: tier-resize ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/262))

### 2026-06-26T11:27:00.648Z — ingest-pipeline-create

**Prompt:**
> (no prompt recorded)

**Result:** [us-cld] create 2 ingest pipelines: logs-cisco_ftd.log@custom, +1 more: ingest-pipeline-create ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/260))

### 2026-06-26T11:04:57.882Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [us-cld] 4 ILM policies: delete min_age=30d: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/259))

### 2026-06-25T10:34:32.008Z — topology-edit

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld-monitor] hot zones 2: topology-edit ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/254))

### 2026-06-25T08:46:41.560Z — tier-resize

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld-monitor] hot -> 8g: tier-resize ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/252))

### 2026-06-24T05:52:14.435Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld-monitor] elastic-cloud-logs: hot max_primary_shard_size=1gb, delete min_age=2d: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/251))

### 2026-06-24T05:47:08.138Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld-monitor] metricbeat: hot max_primary_shard_size=1gb, delete min_age=2d: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/250))

### 2026-06-23T04:06:00.935Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld-monitor] 2 ILM policies: change: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/248))

### 2026-06-22T20:28:11.847Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [ap-cld] ap-default-lifecycle-traces-prod: hot max_primary_shard_size=50gb max_age=14d: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/247))

### 2026-06-22T20:25:00.001Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [ap-cld] ap-default-lifecycle-logs-prod: hot max_primary_shard_size=50gb max_age=14d: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/246))

### 2026-06-22T20:22:26.388Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [ap-cld] basic-lifecycle-logs: hot min_docs=1: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/245))

### 2026-06-22T20:14:46.428Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [ap-cld] basic-lifecycle-metrics: hot min_docs=1: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/244))

### 2026-06-22T19:58:59.089Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [ap-cld] alerts-ilm-policy: delete min_age=90d delete_searchable_snapshot=true: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/243))

### 2026-06-21T23:32:49.804Z — tier-resize

**Prompt:**
> (no prompt recorded)

**Result:** [us-cld] cold -> 4g/max 8g: tier-resize ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/242))

### 2026-06-21T23:31:00.779Z — tier-resize

**Prompt:**
> (no prompt recorded)

**Result:** [us-cld] master -> 4g: tier-resize ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/241))

### 2026-06-21T23:29:43.087Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [us-cld] alerts-ilm-policy: delete min_age=90d delete_searchable_snapshot=true: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/240))

### 2026-06-21T22:46:05.016Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [us-cld] basic-lifecycle-logs: delete min_age=60d: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/239))

### 2026-06-21T22:44:18.879Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [us-cld] us-default-lifecycle-traces-prod: delete min_age=45d: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/238))

### 2026-06-21T22:40:31.402Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [us-cld] traces-apm.rum_traces-default_policy: delete min_age=21d: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/237))

### 2026-06-21T21:23:32.912Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [us-cld] us-default-lifecycle-metrics-nonprod: hot min_docs=1: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/236))

### 2026-06-21T21:22:25.853Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [us-cld] basic-lifecycle-logs: hot min_docs=1: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/235))

### 2026-06-21T21:21:19.281Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [us-cld] basic-lifecycle-metrics: hot min_docs=1: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/234))

### 2026-06-21T20:17:33.616Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [us-cld] basic-lifecycle-metrics: hot max_age=14d: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/233))

### 2026-06-21T20:15:59.713Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [us-cld] us-default-lifecycle-logs-prod: hot max_age=14d max_primary_shard_size=50gb: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/232))

### 2026-06-21T20:14:18.896Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [us-cld] basic-lifecycle-logs: hot max_age=14d max_primary_shard_size=50gb: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/231))

### 2026-06-21T20:11:27.346Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [us-cld] us-default-lifecycle-traces-prod: hot max_primary_shard_size=50gb max_age=14d: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/230))

### 2026-06-21T19:11:36.069Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld] logs@lifecycle: hot max_age=14d max_primary_shard_size=50gb: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/224))

### 2026-06-21T17:57:13.283Z — tier-resize

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld] master -> 4g: tier-resize ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/223))

### 2026-06-21T17:51:17.477Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld] 8 ILM policies: hot min_docs=1: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/222))

### 2026-06-21T15:57:49.491Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld] synthetics-synthetics.http-default_policy: create change: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/221))

### 2026-06-21T15:54:02.990Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld] synthetics-synthetics.browser-default_policy: create change: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/220))

### 2026-06-21T15:50:59.080Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld] infrastructure-observability-logs: delete min_age=21d: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/219))

### 2026-06-21T15:48:02.190Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld] alerts-ilm-policy: delete min_age=90d: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/218))

### 2026-06-21T15:05:52.823Z — cluster-default-edit

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld] logs: lifecycle name=logs-custom: cluster-default-edit ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/217))

### 2026-06-21T15:00:46.981Z — cluster-default-edit

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld] metrics: lifecycle name=metrics-custom: cluster-default-edit ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/216))

### 2026-06-21T14:27:22.516Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld] logs-custom: create change: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/215))

### 2026-06-21T14:23:04.214Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld] metrics-custom: create change: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/214))

### 2026-06-21T13:35:36.259Z — cluster-default-edit

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld] logs, metrics, traces-apm: refresh_interval=30s, refresh_interval=30s, refresh_interval=30s: cluster-default-edit ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/213))

### 2026-06-21T12:41:09.063Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld] eu-default-lifecycle-logs-prod: delete min_age=45d: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/210))

### 2026-06-21T12:19:52.632Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-cld] eu-default-lifecycle-traces-prod: delete min_age=30d: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/209))

### 2026-06-21T12:12:26.160Z — topology-edit

**Prompt:**
> (no prompt recorded)

**Result:** [eu-b2b] -1 key(s): topology-edit ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/208))

### 2026-06-21T03:09:09.478Z — topology-edit

**Prompt:**
> (no prompt recorded)

**Result:** [eu-b2b] eu-b2b: xpack.monitoring.collection.interval=60s: topology-edit ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/200))

### 2026-06-21T02:01:43.109Z — cluster-settings-edit

**Prompt:**
> (no prompt recorded)

**Result:** [eu-b2b] change: cluster-settings-edit ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/198))

### 2026-06-20T23:29:33.418Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-b2b] traces-apm.traces-default_policy: delete min_age=21d: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/194))

### 2026-06-20T22:19:53.316Z — tier-resize

**Prompt:**
> (no prompt recorded)

**Result:** [eu-b2b] cold -> 2g/max 4g: tier-resize ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/193))

### 2026-06-20T21:16:37.644Z — tier-resize

**Prompt:**
> (no prompt recorded)

**Result:** [eu-b2b] warm -> 4g/max 8g: tier-resize ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/192))

### 2026-06-20T18:37:04.323Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-b2b] 2 ILM policies: delete: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/190))

### 2026-06-20T17:53:05.047Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-b2b] metrics-apm.app_metrics-default_policy: warm, cold: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/189))

### 2026-06-20T16:59:22.856Z — cluster-default-edit

**Prompt:**
> (no prompt recorded)

**Result:** [us-cld] logs, metrics, traces-apm: refresh_interval: cluster-default-edit ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/188))

### 2026-06-20T12:53:52.986Z — cluster-default-edit

**Prompt:**
> (no prompt recorded)

**Result:** [eu-b2b] logs: lifecycle: cluster-default-edit ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/187))

### 2026-06-20T12:16:46.082Z — ilm-rollout

**Prompt:**
> (no prompt recorded)

**Result:** [eu-b2b] logs-custom: create hot, warm, cold, frozen, delete: ilm-rollout ([MR](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/186))

## Cross-check (optional)

Agent Memory's reconciliation sweep (`iac/reconcile.ts`) independently tracks the same outcomes as `kind:iac-change` facts with `lifecycle: applied`, keyed by `config_change_id`. If a `config_change_id` shows `lifecycle: applied` there but is missing from this catalog, the knowledge-graph write for that turn likely soft-failed — the change is still real and can be added here manually from the Agent Memory fact's `change_summary` annotation, without the verbatim prompt (Agent Memory does not store the raw prompt unless `LIVE_MEMORY_RAW_PROMPTS_ENABLED` was set for that turn). See [agent-memory.md](../architecture/agent-memory.md#what-we-save-and-to-which-block-type).
