# 12. Cross-session lessons learned

Source: Elastic_Optimisation_Playbook_v12 §12 (reference content).

## §12.1 Most "orphans" aren't orphans

Any index that looks unmanaged --- no policy, small, stale --- should be
checked against _enrich/policy and index template _meta before it is
deleted. Seen on eu-cld (storewatch-*), eu-b2b (risk-score), and a
close call on us-cld. §6.3.

## §12.2 Built-in ILM policies are a trap for production data

The seven shipped policies are hot-only by default and revert on
upgrade. Always copy to a custom name; point index templates at the
custom one. §3.9.

## §12.3 Low-volume streams don't need warm-phase merge

Forcemerge and shrink on shards under 5 GB cost more than they save.
Path B (§3.6) routes merge work to the frozen transition where it's done
once on mostly-cold data. Net saving of ops pain across eu-b2b was the
single biggest lesson of the programme.

## §12.4 Dead data streams infinite-roll

A stream the app stopped writing to still rolls its empty write index
every day. These compound to thousands over months. Weekly hygiene
should specifically list streams with 0 ingest in the last 7 days. §3.7.

## §12.5 Warm disk blocks plan changes

A cluster can have healthy hot and cold tiers and still be unable to
change plan because warm is at 90 %. Warm tier has no autoscaling by
default. Always check warm headroom before scheduling any plan change.
§7.1.1.

## §12.6 Rollover threshold drift is invisible until it's loud

A policy set to 2 GB when 10 GB was the standard sat quietly for months
on eu-cld. 786 indices, 5 rollovers/day. Audit max_primary_shard_size
across all policies quarterly; document deviations. §6.4.

## §12.7 APM-bundled policies need guardrails

Fleet package updates silently replace APM ILM policies. Use a
higher-priority custom index template, pin the integration version, and
diff against git weekly. §8.2.

## §12.8 Autoscaling ceilings are not disasters --- they are early warning

Hitting a ceiling means the autoscaler stopped; nothing bad has happened
yet. The right response is not always to raise the ceiling --- first
consider frozen min_age and retention reduction. And when a ceiling is
raised under incident pressure, the raise-then-downsize two-step
(§7.2.3) keeps it from becoming a permanent cost. §7.2.2.

## §12.9 The biggest savings live in the apps, not the cluster

Fleet trims + application instrumentation tuning (OTel JDBC disable,
Boomi INFO → WARN, GK PoS chatter reduction) together save more docs/day
than all ILM changes combined. When a cluster is expensive, look at the
producers before the storage. §4, §5.

## §12.10 Document every policy change with a rollback

One policy change that went wrong on ap-cld in February cost a Saturday
of investigation because nobody had recorded what the previous JSON was.
Since then: git-stored policies, session-handover change register. §8.1.

## §12.11 Hot-tier shard imbalance is fixable but will come back

Specific hot nodes consistently become heavier (eu-b2b hot-0095, us-cld
hot-2004). Rerouting helps short-term; the permanent fix is to balance
allocation awareness on the index template or to use
shard_allocation_balance settings. Don't just keep moving shards
manually.

## §12.12 High-retention streams deserve dedicated policies

When a single stream has retention requirements materially different
from the shared pool (network-logs: 365d vs observability: 90d), put it
on its own ILM policy attached via a higher-priority index template.
Mixing incompatible retentions on a shared policy forces one side to
lose. §3.10.

## §12.13 Handovers need evidence, not just narrative

A narrative-only handover drifts from reality within days: changes
recorded as 'applied' may have partially rolled back, policies cited may
have been silently replaced. Every handover must carry an attached API
snapshot (cluster health, _ilm/policy, _autoscaling/capacity, Fleet
policies) taken at handover time. The evidence is the record; the
narrative is the summary. §8.5.

## §12.14 Two-month cadence: the same buckets, the same fixes

Roughly 70 % of issues across the estate fall into four buckets --- ILM
drift, Fleet over-collection, orphan index hygiene, and shard imbalance.
The playbook works because those four buckets are predictable. When
something new comes up (ML shutdown API bug, Boomi INFO logging, DB2
span explosion, clock-skew pipelines), it goes into the playbook and
stays in the bucket it belongs in.

## §12.15 ILM rollover min\_\* conditions are a trap for sparse streams

min_primary_shard_docs / min_primary_shard_size / min_age on
rollover act as guards --- rollover is delayed until they are met. On
shared policies covering both high-volume and sparse streams, sparse
streams never satisfy the gate and never roll over, never tier down,
never get deleted. eu-cld 5 May 2026: caught this before deployment when
validating a planned min_primary_shard_docs: 1M setting on streams
ingesting 100 docs/day. Default for shared policies: max_age +
max_primary_shard_size only. §3.12.

## §12.16 Empty retention-fleet templates silently inherit prod ILM

Templates with priority 250+ matching dev/stg/test/nonprod patterns can
match the patterns yet have empty template: {} bodies. They win the
priority arbitration but do nothing --- dev/stg streams inherit whatever
the composed \<type\>\@settings component specifies (typically the prod
policy). Pattern observed on eu-cld; suspected on ap-cld and us-cld.
Audit: GET _index_template/*nonprod-retention* and inspect template.
§3.13.

## §12.17 Most metric optimisations are already done by TSDB

Fleet metric integrations on 9.x default to mode: time_series (TSDB),
which auto-enables synthetic source. Before designing standalone
synthetic source rollouts for metric datasets, confirm whether the
integration is already on TSDB. The only remaining synthetic-source
candidates are usually non-Fleet metric streams and OTEL collector data,
both of which need case-by-case validation. §6.6.

## §12.18 logsdb mode is a low-risk quick win for log storage

logsdb (9.0+) gives 30--50% storage reduction on top of
best_compression for log datasets, with negligible operational risk.
Apply via override template (§3.14) on heavy log datasets first:
kubernetes.container_logs, cisco_*, system.syslog,
windows.application. Validate one dataset, observe for 48h, then
continue. §6.5.

## §12.19 Override index templates are the right way to layer settings on Fleet integrations

Fleet integration templates ship with composed_of including a
\<dataset\>\@custom hook, but PUT access to component templates may be
unavailable in some tooling. Use a higher-priority (300) override index
template that composes the same components and adds the desired setting
via the template block. Reversible via DELETE; survives Fleet package
upgrades. §3.14.

## §12.20 Federation work needs federation-coordinated rollout

Fixes that touch shared infrastructure conventions (Fleet integration
overrides, ingest pipeline names, ILM policy names) should be applied
across all clusters in the federation in a coordinated wave, not
piecemeal. Otherwise the clusters drift in shape and runbooks no longer
transfer cleanly. eu-cld is the leader on the May 2026 round; ap-cld and
us-cld follow with the same playbook. §11.

## §12.21 Never add delete phases to ILM policies on .fleet-\* (or other system) data streams

-----------------------------------------------------------------------------------------

The delete step requires allow_restricted_indices: true on the
executing role, which neither user-superuser nor the standard ILM
internal role carries. Symptom: looping delete:delete:ERROR in
.internal.ilm-history-* against system data stream backing indices,
retrying every ILM poll (default 10 min). Fix: revert the policy to the
bundled hot-only shape; cached ERROR step state on stuck backing indices
clears on next cluster restart (e.g. version upgrade). Source incident:
eu-b2b .fleet-actions-results-ilm-policy on 2026-05-06 --- a delete
phase added on 13 Apr was generating \~144 errors/day; the delete itself
never succeeded. Don\'t reach for Elastic Support or platform-level role
edits to recover from a self-inflicted policy change; just revert.

## §12.22 Elasticsearch 9.3+ defaults logs-\* data streams to index.mode: logsdb

----------------------------------------------------------------------------

The bundled logs\@settings component template (composed by every Fleet
logs-* integration) sets index.mode: logsdb in 9.3+. The
override-template pattern (priority-300 + manually adding index.mode:
logsdb) is only needed on clusters running pre-9.3 where logsdb is
opt-in. Audit by checking GET /\<sample-index\>/_settings.index.mode
--- if it reports logsdb, you\'re already done. Example: eu-cld on 9.2.3
needed override templates on 5 May 2026 to enable logsdb on
kubernetes.container_logs / cisco_meraki / cisco_ftd / system.syslog;
eu-b2b on 9.3.3 inherited the new default and needed no overrides.
Caveat: if a custom template explicitly sets index.mode: standard, that
wins over logs\@settings.

## §12.23 Elastic Cloud Deployment API and Billing API are separate from the cluster ES API

---------------------------------------------------------------------------------------

The Elastic Cloud Deployment API
(https://api.elastic-cloud.com/api/v1/deployments/) and the Billing
Costs Analysis API (/api/v1/billing/costs/...) live on a different
endpoint family from the cluster\'s own Elasticsearch API. They are the
source of truth for plan-level fields (autoscaling_max,
autoscaling_min, instance sizes, version, AZ counts, plan-change
history) and for itemised costs (ECU per billing dimension per
deployment per period). Terraform\'s elastic/ec provider uses these
APIs. The cluster ES API does not expose them --- so an MCP server that
wraps only the cluster API cannot read or modify deployment plans or
query realised costs. Console / Terraform / direct curl with an EC API
key is currently the only path. Filed as MCP defect on eu-b2b
2026-05-06.

## §12.24 AutoOps \"Many shards are empty\" recommendation can include auto-recreated Kibana feature indices --- never run its bulk DELETE blindly

----------------------------------------------------------------------------------------------------------------------------------------------

AutoOps detects empty indices and recommends a bulk DELETE. The list
typically mixes (a) truly dead data stream backing indices that ARE safe
to delete, (b) Kibana feature lookup indices like Security Solution
*_latest-*, CSP misconfiguration_latest-*, Endpoint
metrics-endpoint.metadata_current_default, and Risk Score
current/latest indices that Kibana auto-recreates by name within
seconds, and (c) system-restricted indices (.fleet-*,
.workflows-events, .alerts-*, .ml-*, .monitoring-*, .watcher-*) that
403 on direct DELETE anyway. Always categorise the list before deleting:
Kibana feature lookups are empty by design (no data currently to
surface), deleting them produces a brief feature blip and zero saving.
The only safely-deletable bucket is dead data streams --- and those are
best deleted via DELETE /_data_stream/\<name\> rather than
per-backing-index DELETE. Source: eu-b2b 2026-05-06 --- AutoOps
suggested DELETE on 4 example indices, 1 was system-restricted (would
403) and 3 were Kibana feature lookups (would auto-recreate).

## §12.25 Cluster restart clears cached ILM ERROR step state

--------------------------------------------------------

When an index gets stuck in ILM ERROR (e.g. because the policy delete
step is rejected, or any other failed step), the cached
phase_definition on the index keeps ILM looping every poll until
manually cleared by _ilm/retry / _ilm/move_to_step / _ilm/remove.
If those operations are blocked (e.g. restricted indices on system data
streams), a cluster restart wipes the cached step state and the indices
re-evaluate against the current policy on next poll. Version upgrades
naturally restart the cluster; a manual rolling restart works the same.
Source: eu-b2b 2026-05-06 --- .fleet-actions-results-* stuck-ERROR
cleared on the 9.3.3 → 9.4.0 upgrade as a side-effect, without any role
permission changes.

## §12.26 Increase traces-apm shard count via a higher-priority override index template --- survives Fleet upgrades

---------------------------------------------------------------------------------------------------------------

Fleet ships traces-apm\@template at priority 210 with no explicit
number_of_shards (it falls through to component templates that default
to 2 shards). The 4-shard-across-3-zone arithmetic forces one zone to
carry 50% more shards than the other two, blocking hot-tier downsize.
Fix: create a priority-250 index template with index_patterns:
\[\"traces-apm-*\"\] and template.settings.index.number_of_shards: 3,
composing the same 9 components as the priority-210 Fleet template
(traces\@mappings, apm\@mappings, apm\@settings, apm-10d\@lifecycle,
traces-apm\@mappings, traces-apm-fallback\@ilm, traces\@custom,
traces-apm\@custom, ecs\@mappings) so ECS/APM mappings still apply.
Effect: 6 shards × 2 (replica) = 12 shards spread evenly across 3 zones.
Force rollover via POST /traces-apm-default/_rollover to apply
immediately rather than waiting for max_age:1d. The override template
is non-Fleet-managed and survives APM package upgrades. Source: eu-b2b
2026-05-06.

## §12.27 On Elastic Cloud datacold.d3 instances, RAM scales with disk --- halving disk halves heap

-----------------------------------------------------------------------------------------------

When you halve cold tier Current size per zone (e.g. 760 GB → 380 GB on
aws.es.datacold.d3), RAM also halves (4 GB → 2 GB) per zone. The same
data working set now squeezes into less heap, raising heap utilisation
proportionally. Watch cold heap for the first 48h post-resize and bump
RAM via plan change if heap stays \>90% sustained. Source: eu-b2b
2026-05-06 --- post-cold-resize heap rose from 43--61% pre-resize to
73--87% post-resize; within operating band but trending up over the day.

12.28 9.3 → 9.4 upgrade did NOT auto-recreate built-in ILM policies --- assumption from earlier upgrades is now soft
--------------------------------------------------------------------------------------------------------------------

Earlier upgrades (e.g. across the 9.x major.minor line) reset the
bundled ILM policies (metrics, logs, synthetics + their \@lifecycle
pairs) to hot-only on every upgrade --- the well-known §3 revalidation
requirement. The 9.3.3 → 9.4.0 upgrade on eu-b2b on 2026-05-06 did not
exhibit this behaviour: all built-in policies retained their post-Path-B
5-phase shapes. Treat the playbook §3 revalidation as still-required
(cheap to run, catches regressions) but stop assuming it will always
fire. Verify per-upgrade rather than per-version pattern.

Appendix A --- Terminology
==========================

-   Data stream: a named append-only stream with time-based backing
    indices (.ds\-\--).

-   ILM phase: hot → warm → cold → frozen → delete. Indices transition
    when min_age from rollover is reached.

-   Searchable snapshot: an index stored in a snapshot repository but
    queryable. Cold = fully cached; frozen = partial cache.

-   Rollover: ILM closes the current write index and creates a new one
    when max_age or max_primary_shard_size is hit.

-   Forcemerge: reduces segment count. Expensive. Do not run on
    actively-written indices.

-   Shrink: reduces primary shard count of a finished index. Requires
    all shards on one node.

-   Plan change: Elastic Cloud term for a topology change (add/remove
    nodes, resize, version upgrade). Expressed as a plan JSON.

-   Enrich policy: a pre-built lookup table applied in ingest pipelines.
    Source indices are snapshot at policy execution time.

-   \@custom ingest pipeline: Fleet-integration convention --- every
    managed index calls \@custom if defined. Survives package upgrades;
    the pinning point for per-integration processors.

## §12.29 Coordinating/Ingest tier sizing must scale with cluster-state size and Fleet agent count

----------------------------------------------------------------------------------------------

Coordinating/Ingest instances handle 100% of incoming requests: Kibana
saved-object reads, Fleet agent check-ins, bulk ingest from beats,
enrich coordinate lookups, cross-cluster search routing. They do not
host data; they route. Their JVM heap is dominated by request buffers,
the cluster-state working set they pull on each Kibana saved-object
call, and Fleet checkpoint synchronisation work.

Floor for clusters with ≥20 k indices and ≥10 k Fleet agents: 8 GB RAM
per zone (≈ 4 GB heap), three zones. Below this, the tier is one
young-gen miss away from an old-GC pause that exceeds the Cloud proxy\'s
TLS handshake budget. Symptoms: 429 with embedded TLS handshake timeout
on Kibana page loads (see §12.30), AutoOps event \'Some coordinating
nodes are more loaded than others\', proxy logs showing
kibana_proxy_error rotating across multiple upstream IPs.

Sizing is a single dropdown step in Cloud Console → Edit → Coordinating
and Ingest. Resize is rolling; no data movement, no plan-change
preconditions, \~15--25 min to complete.

Concrete failure case (eu-cld, 7 May 2026): coord tier was downsized 8
GB → 4 GB the prior day for cost reasons. Kibana TLS handshake timeouts
began appearing within hours; restoring 8 GB closed the incident. The 8
GB level is the empirical floor for this cluster shape; record it as a
constraint so the same downsize is not attempted again.

## §12.30 Kibana proxy 429 with embedded TLS handshake timeout --- diagnostic

-------------------------------------------------------------------------

Symptom (visible to users in Kibana):

{\"statusCode\":429,\"error\":\"Too Many
Requests\",\"message\":\"\[{\\\"ok\\\":false,\\\"message\\\":\\\"TLS
handshake timeout: Get
\\\\\\\"https://10.X.Y.Z:PORT/.kibana_\<ver\>/_doc/space%3Adefault\\\\\\\":
net/http: TLS handshake timeout\\\"}\]: undefined\"}

Decoded: 429 is synthesised by the Elastic Cloud proxy when an upstream
takes longer than the proxy\'s TLS handshake timeout to return
ServerHello. Embedded message identifies the actual upstream that
stalled. Path: Kibana → ESS proxy → coord/Kibana instance →
.kibana_\<ver\> on hot data nodes.

Likely root causes, in order:

• Coord/Ingest tier in old-GC pause --- heap pressure exceeded the proxy
budget. Diagnostic: GET _nodes/stats/jvm,thread_pool --- look for old
GC counts non-zero on coord nodes within the last 24 h, or post-GC heap
pressure \>70% in Cloud UI. Fix: see §12.29.

• Kibana instance with stalled Node.js event loop. Cloud UI marks the
instance Unhealthy. Fix: restart Kibana from Cloud Console, then bump
Kibana one tier step if the symptom recurs.

• Hot data node hosting .kibana_\<ver\> in old GC. Less likely; hot
heap is typically larger and saved-object reads are small.

Reproduction during investigation: hit the same path via MCP or the
Kibana Dev Tools (GET .kibana_\<ver\>/_doc/space:default). If the 429
reproduces against multiple upstream IPs across a few minutes, the proxy
is rotating across multiple stalled upstreams --- confirms tier-level
pressure rather than a single stuck instance.

Remediation order: (1) restart Kibana, (2) restart any Unhealthy coord
instances, (3) resize coord and Kibana tiers per §12.29 if symptoms
recur. Steps 1 and 2 are minutes; step 3 is the durable fix.

## §12.31 Force-attach existing data streams to a different ILM via PUT \_settings

------------------------------------------------------------------------------

Use case: an index template change (e.g. a retention-fleet template fix
per §3.13) starts routing new data streams to the correct ILM, but
existing data streams retain the old policy on their backing indices
because index templates only apply at data stream creation or rollover.
Without intervention, existing streams continue under the old policy
until each next rollover (up to max_age, e.g. 14 days for prod 90 d
retention).

To force-attach all existing matching data streams\' backing indices to
the new ILM in a single call, use the same patterns the index template
uses:

PUT
metrics-*-eu_*_dev,metrics-*-eu_*_stg,metrics-*-eu_*_test,metrics-*-eu_*_nonprod,metrics-*-eu_*_dev_*,metrics-*-eu_*_stg_*,metrics-*-eu_*_test_*,metrics-*-eu_*_nonprod_*,metrics-*-eu_*_backend_test,metrics-*-eu_*_backend_test_*/_settings?expand_wildcards=open,hidden,closed,none\
{ \"index.lifecycle.name\": \"\<new_policy\>\" }

Notes:

• Apply to data stream name patterns (no .ds- prefix). The API resolves
matching data streams and propagates the setting to all backing indices,
including write index, warm/cold/frozen-mounted indices, and
partial-mounted searchable snapshots.

• expand_wildcards=open,hidden is necessary; data stream backing
indices are hidden by default. The MCP tool only accepts a single value
here; pass \'all\' for the same effect.

• ILM evaluates the new policy at the next phase-step check (every \~10
min). Indices already past hot keep moving through the existing phases;
new rollovers use the new policy from then onward.

• Reversible: re-issue the PUT with the previous policy name.
Idempotent: re-applying the same value is a no-op.

• Pair with index template fix (§3.13) so that NEW data streams also
land on the new policy at creation. Without that pairing, the
force-attach only fixes existing state and new streams will go back to
the wrong policy.

Validation: GET _ilm/explain on a sample backing index per affected
stream. Policy field should show the new value within seconds of the
PUT.

## §12.32 Self-monitoring is an investigation prerequisite --- Stack Monitoring re-enablement

-----------------------------------------------------------------------------------------

Without Stack Monitoring enabled (collection of node, index, Kibana
metrics into .monitoring-* or metrics-*.stack_monitoring* indices),
an incident investigation has only the current snapshot ---
_cluster/health, _nodes/stats, _tasks. There is no time series for
\'what was master heap doing at 02:00 last night\' or \'did Kibana
event-loop delay spike before the proxy started 429-ing\'. AutoOps gives
an event view but does not expose raw metric history.

Detect: GET
_cat/indices/.monitoring-*,metrics-*.stack_monitoring*?v --- zero
matches confirms self-monitoring is OFF.

Three enablement paths on Elastic Cloud, in order of preference:

• Dedicated monitoring deployment (recommended for clusters \>5 k
indices). Cloud Console → \<deployment\> → Logs and metrics → \'Send
monitoring data to another deployment\'. Point at the existing
\<cluster\>-monitor deployment; metrics flow there and are queryable via
Kibana → Stack Monitoring.

• Self-monitoring on the same cluster. Same screen, \'Send monitoring
data to this deployment\'. Cheapest but adds load to the cluster being
monitored --- not recommended for clusters already under pressure.

• Metricbeat-based collection. Legacy; runs Metricbeat as a Fleet
integration. More complex, retain for migrations.

Effects appear within \~10 minutes of enablement. Time-series
investigations (heap drift, GC frequency, search rate per node, Fleet
checkpoint duration) become possible. Reinstate as a default before any
structural-change session, not after one.

## §12.33 ILM rollover guard semantics --- reaffirmation of §3.12

-------------------------------------------------------------

In Elasticsearch 9.x, rollover fires only when (any max_* condition is
met) AND (all min_* conditions are met). The two clauses are AND, not
OR. min_* are guards, not alternatives. A sparse stream with
min_primary_shard_size: 1gb and max_age: 14d will NOT roll over at
14 d if the primary shard is below 1 GB --- it will stay in hot phase
until either the size threshold is crossed or the policy is amended.

On any policy that is shared across multiple data streams of differing
volume, do not add min_* conditions to the rollover action. Sparse
streams will silently stop rolling and accumulate indefinitely on hot.
The fix is dedicated single-stream policies for the rare cases where
size-based throttling is required (see §3.12 for acceptable use cases).

Concrete close-call (eu-cld, 7 May 2026): Phase 2A as written in an
earlier fix plan recommended adding min_primary_shard_size: 1gb,
min_primary_shard_docs: 100000, min_age: 1d to three shared
production policies (1,100+ data streams). The change was applied based
on the assumption that max + min would behave as OR, and reverted within
7 minutes once the conflict with §3.12 was identified. Window of
exposure was inside the ILM evaluation interval (\~10 min); no rollover
decisions fired against the wrong policy. No harm. The lesson: any plan
referencing min_* on shared policies must be flagged and re-scoped
before execution; consult §3.12 / §12.15 first.

## §12.34 Warm and cold tier \'memory pressure\' is OS page cache, not real pressure

--------------------------------------------------------------------------------

Warm and cold tier nodes (i3en hardware) routinely report \'memory
pressure\' at 94--100% in AutoOps and the Cloud UI. This is
overwhelmingly OS page cache from mmap\'d Lucene segment files, not real
memory pressure. In modern Elasticsearch (7.x+), segment metadata is
mmap\'d from disk rather than held in JVM heap ---
node_stats.indices.segments.memory_in_bytes reads as 0. Real
memory-pressure indicators are JVM heap_used_percent, old-GC count and
pause time, swap usage, search thread-pool queue and rejected counters,
and search latency. As long as those are healthy, near-100% OS memory on
warm and cold is steady-state operation, not an incident.

## §12.35 Disk watermark policy is per-cluster, not estate-wide

-----------------------------------------------------------

Default disk watermarks
(cluster.routing.allocation.disk.watermark.low=85%, high=90%,
flood_stage=95%) are correct for clusters whose data tiers approach
those thresholds during real disk pressure. They are incorrect for
clusters whose frozen tier sits at high steady-state LRU cache fill. On
those clusters the defaults trigger continuous false-alarm AutoOps and
Stack Monitoring alerts on the frozen nodes, and the platform
plan-change validator refuses tier resizes while the watermark is
breached --- even though the frozen LRU is not a capacity issue (durable
data lives in S3; the local cache is meant to fill).

Detection: GET _nodes/stats fs on the frozen nodes. If total_in_bytes
minus available_in_bytes divided by total_in_bytes is \~85--95%
steady-state and the Cloud Console "Searchable object storage" line
shows the same node at \<30% S3 used, the apparent watermark trip is LRU
cache, not real disk pressure. Reference: §12 cross-session note "frozen
disk metric is LRU cache, not S3 capacity".

Remediation pattern: PUT /_cluster/settings persistent
watermark.low=92%, high=95%, flood_stage=97% (or whichever values clear
the frozen LRU steady-state with a small margin). Document this as the
steady-state config for that specific cluster in the issue register.
Re-evaluate any time the frozen tier is resized or hot/warm/cold
approach 80% used.

Anti-pattern to avoid: blanket-applying the relaxed thresholds to every
cluster in the estate. Other clusters keep platform defaults unless they
exhibit the same frozen-LRU steady-state pattern. Track each cluster's
watermark configuration as a distinct entry in the issue register so
that subsequent sessions do not assume a uniform setting.

Concrete case (us-cld, 7 May 2026): defaults blocked the frozen 30 GB →
15 GB resize at the validator step because frozen LRU was 91% full of a

## §12.36 Warm-tier RAM shrink is gated by ILM warm-phase replica policy, not just by current disk usage

----------------------------------------------------------------------------------------------------

The platform plan-change validator refuses to drain a data node that
holds the only healthy copy of any shard. On warm tier, this gate often
fires not because the cluster is genuinely undersized, but because the
cluster's ILM policies set number_of_replicas:0 in the warm allocate
action as a deliberate storage-cost optimisation. Every warm shard then
exists exactly once and the warm node cannot be drained until either
replicas are bumped or the policy is changed.

Detection: GET _ilm/policy/\<policy\> and inspect
phases.warm.actions.allocate.number_of_replicas. Cross-check against a
representative warm-tier index via GET \<index\>/_settings --- the
"index.number_of_replicas" setting will read 0 for indices that have
already moved through the warm phase under such a policy.

Two unlock paths, both with downsides. Path A: change all warm-phase ILM
policies to number_of_replicas:1. This permanently doubles warm tier
disk usage and applies to every future warm index. Existing warm indices
need an explicit PUT \<index\>/_settings call to bump replicas now (ILM
does not retroactively re-allocate). Path B: temporarily bump replicas
on the affected indices, run the shrink, revert. Race window vs the ILM
evaluation interval (\~10 min) --- the policy may set replicas back to 0
mid-shrink. Neither path is free.

Decision rule: do the cost arithmetic before unlocking. Warm tier 4 GB →
2 GB on a 3-zone cluster saves roughly \$0.30/hr ≈ \$220/month at
typical Elastic Cloud rates. If the saving is below the recurring cost
of doubled warm storage (Path A) or the ongoing risk of policy-vs-action
races (Path B), do not pursue the shrink. Park warm at the current size
and document the decision as DO-NOT-PURSUE in the issue register so the
analysis is not redone in a future session.

Concrete case (us-cld, 7 May 2026): three top ILM policies
(basic-lifecycle-metrics 6,779 indices, basic-lifecycle-logs 5,976
indices, us-default-lifecycle-logs-prod 873 indices) and 15 others all
set number_of_replicas:0 in warm. Plan-change #elasticsearch-222 was
cancelled by the sole-copy guard. Warm 4 → 2 GB shrink declined because
annual saving is below the cost of either unlock path. Warm parked at 4
GB.

